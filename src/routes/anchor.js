/**
 * Anchor webhook handler.
 *
 * Mounted with `express.raw` BEFORE `express.json` in server.js so HMAC-SHA1
 * signature verifies against the exact bytes Anchor sent.
 *
 * Event names verified against https://docs.getanchor.co/docs/event-types-1
 * Critical flow:
 *   1. customer.identification.approved → create DepositAccount for the user's pending business
 *   2. account.opened OR virtualNuban.created → write NUBAN onto the Business + push
 *   3. nip.inbound.completed / payin.received / payment.settled → record income Transaction
 *   4. nip.transfer.successful/failed/reversed → notify on outbound state
 */

const router = require("express").Router();
const crypto = require("crypto");
const prisma = require("../utils/db");
const anchor = require("../utils/anchor");
const { audit } = require("../utils/audit");
const { pushTo } = require("../utils/pushNotification");
const {
  extractSender,
  buildInboundNotification,
  buildInboundDescription,
} = require("../utils/inboundCreditNotification");

router.post("/", async (req, res) => {
  const isBuffer = Buffer.isBuffer(req.body);
  const rawBody = isBuffer ? req.body : Buffer.from(JSON.stringify(req.body));

  if (!anchor.verifyWebhook(rawBody, req.headers)) {
    console.warn("[Anchor webhook] signature mismatch — rejecting");
    return res.sendStatus(401);
  }

  let event;
  try {
    event = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return res.sendStatus(400);
  }

  // Ack fast so Anchor doesn't retry while we work
  res.sendStatus(200);

  const eventType = event.data?.type;
  const attrs = event.data?.attributes || {};
  const rels = event.data?.relationships || {};
  const included = Array.isArray(event.included) ? event.included : [];
  // Helper: find a related resource in `included` by JSON:API type + id
  const findIncluded = (type, id) =>
    included.find((r) => r.type === type && r.id === id);
  console.log(`[Anchor webhook] event=${eventType}`);

  try {
    // ── Idempotency: process each delivered event at most once ───────────────
    // Anchor delivers at-least-once, so a re-delivered credit would otherwise be
    // recorded twice (the inbound path below has no per-row dedup). Claim the
    // event by inserting its id; a duplicate hits the @unique and we skip. Keyed
    // on (eventType + resource id) so distinct event types on the same resource
    // (e.g. account.opened then accountNumber.created) are NOT collapsed.
    // Body-hash fallback so an id-less (or replayed id-less) event still dedups
    // instead of falling through unprotected.
    const dedupId =
      event.data?.id ||
      attrs.reference ||
      attrs.sessionId ||
      crypto.createHash("sha256").update(rawBody).digest("hex");
    try {
      await prisma.processedWebhook.create({
        data: { eventId: `${eventType}:${dedupId}`, type: eventType },
      });
    } catch (dupErr) {
      if (dupErr.code === "P2002") {
        // Duplicate delivery (or replay) — record it so spikes are detectable.
        console.warn(`[Anchor webhook] duplicate ${eventType}:${dedupId} — skipping`);
        await audit({
          action: "ANCHOR_WEBHOOK_DUPLICATE",
          resourceType: "webhook",
          resourceId: String(dedupId).slice(0, 120),
          severity: "info",
          metadata: { eventType },
        });
        return;
      }
      // A dedup-ledger error must never drop a real event — log and continue.
      console.error("[Anchor webhook] dedup insert error:", dupErr.message);
    }

    // ── Customer KYC / KYB approved ──────────────────────────────────────────
    // Anchor emits `customer.identification.approved` for IndividualCustomer
    // and may emit `customer.verification.approved` / `business.verification.approved`
    // for BusinessCustomer KYB — we treat all as equivalent.
    if (
      eventType === "customer.identification.approved" ||
      eventType === "customer.verification.approved" ||
      eventType === "business.identification.approved" ||
      eventType === "business.verification.approved"
    ) {
      const customerId = rels.customer?.data?.id || event.data?.id;
      if (!customerId) {
        console.warn(`[Anchor webhook] approved event with no customerId`);
        return;
      }

      // Look up first, then update — so we can distinguish "no matching user"
      // (which used to fail silently via .catch) from "DB write error".
      const user = await prisma.user.findFirst({
        where: { anchorCustomerId: customerId },
      });
      if (!user) {
        console.warn(
          `[Anchor webhook] approved for unknown anchorCustomerId=${customerId} — no local user. Possible race with /virtual-account POST persistence.`,
        );
        return;
      }

      try {
        await prisma.user.update({
          where: { id: user.id },
          data: { kycStatus: "verified" },
        });
      } catch (err) {
        console.error(
          `[Anchor webhook] failed to set kycStatus=verified for user ${user.id}:`,
          err.message,
        );
      }

      // Open deposit accounts for any business that's missing one.
      const pending = await prisma.business.findMany({
        where: {
          userId: user.id,
          anchorAccountId: null,
          virtualAccountNumber: null,
        },
      });
      console.log(
        `[Anchor webhook] approved ${customerId} → opening ${pending.length} deposit account(s)`,
      );
      for (const biz of pending) {
        try {
          // BusinessCustomer only supports CURRENT — ignore the user's saved
          // bankAccountType preference. (SAVINGS is for IndividualCustomer.)
          const acc = await anchor.createDepositAccount({
            customerId,
            customerType: "BusinessCustomer",
            productName: "CURRENT",
          });
          // Only the deposit-account ID is reliable from the sync create.
          // The real virtual NUBAN + bank land via accountNumber.created.
          await prisma.business.update({
            where: { id: biz.id },
            data: {
              anchorAccountId: acc.accountId,
              virtualAccountId: acc.accountId,
              virtualAccountRef: acc.accountId,
            },
          });
          console.log(
            `[Anchor webhook] DepositAccount ${acc.accountId} opened for ${biz.name}`,
          );
        } catch (err) {
          console.error(
            `[Anchor webhook] createDepositAccount failed for biz ${biz.id} (${biz.name}):`,
            err.message,
            err.anchorErrors ? JSON.stringify(err.anchorErrors) : "",
          );
        }
      }
      return;
    }

    // ── Customer KYC rejected / error / needs corrections ───────────────────
    if (
      eventType === "customer.identification.rejected" ||
      eventType === "customer.identification.error" ||
      eventType === "customer.identification.reenter_information" ||
      eventType === "customer.verification.rejected" ||
      eventType === "business.verification.rejected" ||
      eventType === "business.identification.rejected"
    ) {
      const customerId = rels.customer?.data?.id || event.data?.id;
      if (!customerId) return;
      const user = await prisma.user.findFirst({
        where: { anchorCustomerId: customerId },
      });
      if (!user) {
        console.warn(
          `[Anchor webhook] rejected for unknown anchorCustomerId=${customerId}`,
        );
        return;
      }
      try {
        await prisma.user.update({
          where: { id: user.id },
          data: { kycStatus: "rejected" },
        });
      } catch (err) {
        console.error(
          `[Anchor webhook] kycStatus=rejected update failed for ${user.id}:`,
          err.message,
        );
      }
      const reason =
        attrs.reason || attrs.message || "Identity verification failed.";
      await pushTo(user.id, "Verification failed", reason);
      return;
    }

    // ── Customer KYC in manual review ───────────────────────────────────────
    if (eventType === "customer.identification.manualReview") {
      const customerId = rels.customer?.data?.id || event.data?.id;
      if (!customerId) return;
      const user = await prisma.user.findFirst({
        where: { anchorCustomerId: customerId },
      });
      if (!user) return;
      await pushTo(
        user.id,
        "Verification under review",
        "Our banking partner is manually reviewing your details. This can take a few hours.",
      );
      return;
    }

    // ── Deposit account opened ──────────────────────────────────────────────
    // NOTE: account.opened's payload carries the DepositAccount's own (masked)
    // accountNumber + underlying bank (e.g. CORESTEP MFB shell). We do NOT
    // write those — the real virtual NUBAN comes via accountNumber.created.
    // Just verify the business exists and log; the NUBAN handler will do the
    // actual update + push notification.
    if (eventType === "account.opened") {
      const accountId = rels.account?.data?.id || event.data?.id;
      if (!accountId) return;
      const biz = await prisma.business.findFirst({
        where: { anchorAccountId: accountId },
      });
      if (!biz) {
        console.warn(
          `[Anchor webhook] account.opened — no business for ${accountId}`,
        );
      }
      // Don't update virtualAccountNumber/Bank/Name here. accountNumber.created
      // will land within ~1s and write the real PROVIDUS NUBAN.
      return;
    }

    // ── accountNumber.created — the REAL event Anchor fires when a NUBAN is
    //    attached to a deposit account. The NUBAN + bank live in the JSON:API
    //    `included` array, NOT on data.attributes — the event's own attributes
    //    only carry the createdAt timestamp.
    if (eventType === "accountNumber.created") {
      const accountNumberId =
        rels.accountNumber?.data?.id || rels.virtualNuban?.data?.id;
      const depositAccountId =
        rels.depositAccount?.data?.id ||
        rels.account?.data?.id ||
        attrs.accountId;
      if (!depositAccountId) return;

      // Pull the AccountNumber/VirtualNuban resource out of `included`
      let acctRes = null;
      if (accountNumberId) {
        acctRes =
          findIncluded("AccountNumber", accountNumberId) ||
          findIncluded("VirtualNuban", accountNumberId);
      }
      const acctAttrs = acctRes?.attributes || {};
      let accountNumber =
        acctAttrs.accountNumber ||
        acctAttrs.virtualNuban ||
        attrs.accountNumber ||
        attrs.virtualNuban;
      let bankName =
        acctAttrs.bank?.name || attrs.bank?.name || null;
      let accountName =
        acctAttrs.accountName || acctAttrs.name || attrs.accountName || null;

      const biz = await prisma.business.findFirst({
        where: { anchorAccountId: depositAccountId },
      });
      if (!biz) {
        console.warn(
          `[Anchor webhook] accountNumber.created — no business for depositAccount ${depositAccountId}`,
        );
        return;
      }

      // Last-resort fallback: fetch the deposit account directly if the
      // included resource was missing or malformed.
      if (!accountNumber) {
        try {
          const fresh = await anchor.getAccount(depositAccountId);
          accountNumber = fresh.accountNumber || accountNumber;
          bankName = bankName || fresh.bankName;
          accountName = accountName || fresh.accountName;
        } catch (e) {
          console.warn("[Anchor webhook] getAccount fallback failed:", e.message);
        }
      }
      if (!accountNumber) {
        console.warn(
          `[Anchor webhook] accountNumber.created — couldn't resolve NUBAN for ${depositAccountId}`,
        );
        return;
      }

      // Dedup the "Bank account ready" push: only fire if the NUBAN was
      // previously unset on the business row. Anchor often re-delivers this
      // event and we don't want to spam the user with notifications.
      const wasReady = !!biz.virtualAccountNumber;

      await prisma.business.update({
        where: { id: biz.id },
        data: {
          virtualAccountNumber: accountNumber,
          virtualAccountBank: bankName || biz.virtualAccountBank || "Anchor",
          virtualAccountName: accountName || biz.name,
        },
      });

      if (!wasReady) {
        await pushTo(
          biz.userId,
          "Bank account ready 🎉",
          `${biz.name}'s bank account is active.`,
        );
      }
      return;
    }

    // ── KYB waiting on document upload — surface to the user ───────────────
    if (eventType === "customer.identification.awaitingDocument") {
      const customerId = rels.customer?.data?.id || event.data?.id;
      if (!customerId) return;
      const user = await prisma.user.findFirst({
        where: { anchorCustomerId: customerId },
      });
      if (!user) return;
      const reqDocs = (attrs.requiredDocuments || [])
        .map((d) => d.type || d.name || "")
        .filter(Boolean)
        .join(", ");
      await pushTo(
        user.id,
        "Documents needed",
        reqDocs
          ? `KYB is waiting on: ${reqDocs}.`
          : "Your business verification is waiting on additional documents.",
      );
      return;
    }

    // ── Informational lifecycle events (no DB action needed) ───────────────
    if (
      eventType === "account.initiated" ||
      eventType === "customer.created" ||
      eventType === "virtualNuban.opened" ||
      eventType === "document.approved" ||
      eventType === "document.submitted" ||
      eventType === "document.rejected"
    ) {
      // account.initiated  — fires when a DepositAccount creation starts
      // customer.created   — fires after a customer is created (we already have the ID)
      // virtualNuban.opened — fires alongside accountNumber.created; same NUBAN info
      // document.*         — per-document KYB review outcomes; the aggregate
      //                      customer.identification.{approved,rejected} already
      //                      handles the state transition we care about.
      return;
    }

    // ── Virtual Nuban created (legacy / alternative event name) ─────────────
    if (eventType === "virtualNuban.created") {
      const virtualNuban = attrs.accountNumber || attrs.virtualNuban;
      const linkedAccountId =
        rels.depositAccount?.data?.id ||
        rels.account?.data?.id ||
        attrs.accountId;
      if (!virtualNuban || !linkedAccountId) return;

      const biz = await prisma.business.findFirst({
        where: { anchorAccountId: linkedAccountId },
      });
      if (!biz) return;
      const wasReady = !!biz.virtualAccountNumber;

      await prisma.business.update({
        where: { id: biz.id },
        data: { virtualAccountNumber: virtualNuban },
      });
      if (!wasReady) {
        await pushTo(
          biz.userId,
          "Bank account ready 🎉",
          `${biz.name}'s bank account is active.`,
        );
      }
      return;
    }

    // ── Account creation FAILED ─────────────────────────────────────────────
    if (
      eventType === "account.creation.failed" ||
      eventType === "virtualNuban.creation.failed"
    ) {
      // Map back to the user via the linked account or customer relationship
      const accountId = rels.account?.data?.id || event.data?.id;
      const customerId = rels.customer?.data?.id;

      let biz = null;
      if (accountId) {
        biz = await prisma.business.findFirst({
          where: { anchorAccountId: accountId },
        });
      }
      let userId = biz?.userId;
      if (!userId && customerId) {
        const user = await prisma.user.findFirst({
          where: { anchorCustomerId: customerId },
        });
        userId = user?.id;
      }
      const reason = attrs.reason || attrs.message || "Account creation failed.";
      if (userId) await pushTo(userId, "Account creation failed", reason);
      // Clear the failed reference so the user can retry
      if (biz) {
        await prisma.business.update({
          where: { id: biz.id },
          data: { anchorAccountId: null },
        });
      }
      return;
    }

    // ── Incoming bank transfer ──────────────────────────────────────────────
    if (
      eventType === "nip.inbound.completed" ||
      eventType === "payin.received" ||
      eventType === "payment.settled" ||
      eventType === "payment.received"
    ) {
      const accountNumber =
        attrs.destinationAccountNumber ||
        attrs.creditAccount?.accountNumber ||
        attrs.accountNumber;
      const amountRaw = Number(attrs.amount || 0);
      // Anchor's incoming events are sometimes in naira, sometimes in kobo
      // depending on event source. >100000 implies kobo. Adjust defensively.
      const amount = amountRaw > 100000 ? amountRaw / 100 : amountRaw;
      if (!accountNumber || amount <= 0) return;

      const biz = await prisma.business.findFirst({
        where: { virtualAccountNumber: accountNumber },
        include: { user: true },
      });
      if (!biz) {
        console.warn(`[Anchor webhook] no business for account ${accountNumber}`);
        return;
      }

      const sender = extractSender(attrs);
      const narration = attrs.narration || attrs.reason || "";
      const sessionId = attrs.sessionId || attrs.reference || "";
      const description = buildInboundDescription({ sender, narration, reference: sessionId });

      await prisma.transaction.create({
        data: {
          businessId: biz.id,
          userId: biz.userId,
          type: "income",
          amount,
          description,
          category: "transfer",
          paymentMethod: "bank",
          date: attrs.transactionDate ? new Date(attrs.transactionDate) : new Date(),
          source: "anchor",
        },
      });

      const { title, body } = buildInboundNotification({
        business: biz,
        amount,
        sender,
        narration,
      });
      await pushTo(biz.userId, title, body);

      // Detailed credit alert (fire-and-forget).
      if (biz.user?.email) {
        require("../utils/transactionEmail").sendTransactionEmail({
          to: biz.user.email,
          direction: "credit",
          amount,
          currency: biz.currency || "NGN",
          counterparty: sender?.label || sender?.name || "a bank transfer",
          narration,
          reference: sessionId,
          businessName: biz.name,
          dateLabel: new Date().toLocaleString("en-NG", { dateStyle: "medium", timeStyle: "short" }),
        });
      }

      // Auto-mark a matching storefront order PAID (+ decrement stock + notify).
      await require("../utils/orderReconcile")
        .tryMatchOrder({ business: biz, amount, narration, reference: sessionId })
        .catch((e) => console.error("[order match]", e.message));
      return;
    }

    // ── BookTransfer successful — credit the receiving business ────────────
    // Source-side expense was already recorded synchronously in /transfers/send.
    // We only need to insert the income row on the destination side and notify.
    if (eventType === "book.transfer.successful") {
      const destAccountId =
        rels.destinationAccount?.data?.id ||
        rels.destination?.data?.id ||
        attrs.destinationAccountId;
      const srcAccountId =
        rels.account?.data?.id || rels.sourceAccount?.data?.id;
      const amountRaw = Number(attrs.amount || 0);
      const amount = amountRaw > 100000 ? amountRaw / 100 : amountRaw;
      const reference = attrs.reference || event.data?.id || "";

      if (!destAccountId || amount <= 0) return;

      const destBiz = await prisma.business.findFirst({
        where: { anchorAccountId: destAccountId },
        include: { user: true },
      });
      if (!destBiz) {
        console.warn(
          `[Anchor webhook] book.transfer.successful — no business for dest account ${destAccountId}`,
        );
        return;
      }

      // Dedup: if we've already recorded this reference for this business, skip.
      if (reference) {
        const existing = await prisma.transaction.findFirst({
          where: {
            businessId: destBiz.id,
            source: "anchor",
            description: { contains: reference },
          },
        });
        if (existing) return;
      }

      // Look up the sender (source DepositAccount) to give a friendly description.
      // BookTransfer is KashBook→KashBook, so we have full sender details locally.
      let senderName = "";
      if (srcAccountId) {
        const srcBiz = await prisma.business.findFirst({
          where: { anchorAccountId: srcAccountId },
          select: { name: true, virtualAccountName: true },
        });
        if (srcBiz) senderName = srcBiz.virtualAccountName || srcBiz.name;
      }
      const sender = {
        name: senderName,
        bank: "KashBook",
        accountNumber: "",
        label: senderName || "another KashBook user",
        hasName: !!senderName,
      };
      const narration = attrs.reason || "";
      const description = buildInboundDescription({ sender, narration, reference });

      await prisma.transaction.create({
        data: {
          businessId: destBiz.id,
          userId: destBiz.userId,
          type: "income",
          amount,
          description,
          category: "transfer",
          paymentMethod: "bank",
          date: new Date(),
          source: "anchor",
        },
      });

      const { title, body } = buildInboundNotification({
        business: destBiz,
        amount,
        sender,
        narration,
      });
      await pushTo(destBiz.userId, title, body);

      // Detailed credit alert (fire-and-forget).
      if (destBiz.user?.email) {
        require("../utils/transactionEmail").sendTransactionEmail({
          to: destBiz.user.email,
          direction: "credit",
          amount,
          currency: destBiz.currency || "NGN",
          counterparty: sender?.label || sender?.name || "another KashBook user",
          narration,
          reference,
          businessName: destBiz.name,
          dateLabel: new Date().toLocaleString("en-NG", { dateStyle: "medium", timeStyle: "short" }),
        });
      }

      // Auto-mark a matching storefront order PAID (+ decrement stock + notify).
      await require("../utils/orderReconcile")
        .tryMatchOrder({ business: destBiz, amount, narration, reference })
        .catch((e) => console.error("[order match]", e.message));
      return;
    }

    if (eventType === "book.transfer.initiated") {
      // informational — no DB action; source-side expense already recorded
      return;
    }

    // ── Outbound transfer outcomes ──────────────────────────────────────────
    if (
      eventType === "nip.transfer.successful" ||
      eventType === "nip.transfer.failed" ||
      eventType === "nip.transfer.reversed"
    ) {
      // Local Transaction was already written when /transfers/send ran.
      if (eventType !== "nip.transfer.successful") {
        const accountId = rels.account?.data?.id;
        if (accountId) {
          const biz = await prisma.business.findFirst({
            where: { anchorAccountId: accountId },
          });
          if (biz) {
            await pushTo(
              biz.userId,
              "Transfer Failed",
              attrs.reason || "An outbound transfer failed or was reversed.",
            );
          }
        }
      }
      return;
    }

    // ── Bill payment outcomes ───────────────────────────────────────────────
    // The expense Transaction was written optimistically when /bills/pay ran.
    // On success: nothing to do. On failure: flag the row + tell the user the
    // money wasn't taken (Anchor reverses the debit on a failed bill).
    if (
      eventType === "bills.successful" ||
      eventType === "bills.failed" ||
      eventType === "bills.initiated"
    ) {
      if (eventType === "bills.failed") {
        const ref = attrs.reference || attrs.transactionReference;
        const accountId = rels.account?.data?.id;
        const biz = accountId
          ? await prisma.business.findFirst({ where: { anchorAccountId: accountId } })
          : null;
        if (ref) {
          await prisma.transaction.updateMany({
            where: { description: { contains: ref }, category: "bill" },
            data: { complianceStatus: "flagged", flagSeverity: "low" },
          }).catch(() => {});
        }
        if (biz) {
          await pushTo(
            biz.userId,
            "Bill payment failed",
            attrs.reason || "Your bill payment didn't go through — you weren't charged.",
          );
        }
      }
      return;
    }

    console.log(`[Anchor webhook] unhandled event type: ${eventType}`);
  } catch (err) {
    console.error("[Anchor webhook] processing error:", err);
  }
});

module.exports = router;
