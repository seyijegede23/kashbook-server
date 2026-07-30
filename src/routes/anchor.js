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
const { openIndividualBankAccount } = require("../utils/anchorBank");
const { audit } = require("../utils/audit");
const { pushTo } = require("../utils/pushNotification");
const {
  resolveInboundSender,
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

  // Envelope resolution — Anchor has shipped more than one payload shape:
  //   Sandbox/classic: { data: { type: "payment.settled", attributes, relationships }, included }
  //   LIVE (verified 2026-07-30 via the keys-only probe): NO data wrapper — the
  //   event resource sits at the TOP level: { id, type: "payment.settled",
  //   attributes: { payment: {...} }, relationships: {...} }.
  // Normalize to one `root` node and read type/attributes/relationships off it,
  // so every handler below works for both shapes.
  const root =
    event.data && typeof event.data === "object" && !Array.isArray(event.data)
      ? event.data
      : event;
  let eventType = root.type;
  if (!eventType || eventType === "event" || eventType === "Event") {
    eventType = root.attributes?.eventType || event.event || event.eventType || null;
  }
  const attrs = root.attributes || {};
  const rels = root.relationships || {};
  const included = Array.isArray(event.included) ? event.included : [];
  // Helper: find a related resource in `included` by JSON:API type + id
  const findIncluded = (type, id) =>
    included.find((r) => r.type === type && r.id === id);
  console.log(`[Anchor webhook] event=${eventType}`);
  if (!eventType) {
    console.warn(
      "[Anchor webhook] UNPARSED payload — topKeys:",
      Object.keys(event || {}).join(","),
      "dataKeys:",
      Object.keys(event?.data || {}).join(","),
      "snippet:",
      rawBody.toString("utf8").slice(0, 400),
    );
  }
  // TEMP shape probe (live-payload adapter work): log a keys-only skeleton —
  // structure without values, so no PII/amounts hit the logs. Remove once the
  // live adapter is settled.
  const skeleton = (o, depth = 0) => {
    if (depth > 3 || o == null || typeof o !== "object") return typeof o;
    if (Array.isArray(o)) return o.length ? [skeleton(o[0], depth + 1)] : [];
    return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, skeleton(v, depth + 1)]));
  };
  console.log(`[Anchor webhook] shape ${eventType}:`, JSON.stringify(skeleton(event)));

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
      root.id ||
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
      const customerId =
        rels.customer?.data?.id ||
        rels.resource?.data?.id ||
        attrs.failureEventData?.resource?.id ||
        event.data?.id;
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
      // Customer type is encoded in the Anchor ID suffix:
      //   -anc_ind_cst → individual (cheap KYC + business-named virtual NUBAN)
      //   -anc_bus_cst → legacy business (CURRENT account; NUBAN via webhook)
      const isIndividual = /-anc_ind_cst$/.test(customerId);
      console.log(
        `[Anchor webhook] approved ${customerId} (${isIndividual ? "individual" : "business"}) → opening ${pending.length} account(s)`,
      );
      for (const biz of pending) {
        try {
          if (isIndividual) {
            // Individual-KYC path: open a SAVINGS settlement account + a
            // business-named virtual NUBAN (BVN decrypted from Business.kycBvn).
            // openIndividualBankAccount persists the NUBAN, so the account is
            // immediately payable — no accountNumber.created wait needed.
            const r = await openIndividualBankAccount({ biz, customerId });
            if (!r.skipped) {
              await pushTo(
                biz.userId,
                "Bank account ready 🎉",
                `${biz.name}'s bank account is active.`,
              );
            }
            console.log(
              `[Anchor webhook] virtual NUBAN ${r.accountNumber} opened for ${biz.name}`,
            );
          } else {
            // Legacy BusinessCustomer only supports CURRENT — the real virtual
            // NUBAN + bank land via accountNumber.created.
            const acc = await anchor.createDepositAccount({
              customerId,
              customerType: "BusinessCustomer",
              productName: "CURRENT",
            });
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
          }
        } catch (err) {
          console.error(
            `[Anchor webhook] open account failed for biz ${biz.id} (${biz.name}):`,
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
      const customerId =
        rels.customer?.data?.id ||
        rels.resource?.data?.id ||
        attrs.failureEventData?.resource?.id ||
        event.data?.id;
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
      // Live rejections carry the specifics in failureEventData (message +
      // validationResult array) — surface them; sandbox used flat reason/message.
      const fed = attrs.failureEventData || {};
      const vr = Array.isArray(fed.validationResult)
        ? fed.validationResult
            .map((v) => (typeof v === "string" ? v : JSON.stringify(v)))
            .join("; ")
        : "";
      const reason =
        [fed.message || attrs.reason || attrs.message, vr].filter(Boolean).join(" — ") ||
        "Identity verification failed.";
      console.warn(`[Anchor webhook] KYC rejected for ${customerId}: ${reason}`);
      // Flip the newest account-request submission for this user's unbanked
      // business(es) to DECLINED so the app's kyc-status poll shows the reason
      // and offers resubmission (the admin approve had already marked it
      // APPROVED before Anchor's async verdict landed).
      try {
        const bizIds = (
          await prisma.business.findMany({
            where: { userId: user.id, anchorAccountId: null },
            select: { id: true },
          })
        ).map((b) => b.id);
        const sub = bizIds.length
          ? await prisma.kycSubmission.findFirst({
              where: { businessId: { in: bizIds }, status: { in: ["APPROVED", "PENDING"] } },
              orderBy: { createdAt: "desc" },
            })
          : null;
        if (sub) {
          await prisma.kycSubmission.update({
            where: { id: sub.id },
            data: { status: "DECLINED", declineReason: reason },
          });
        }
      } catch (e) {
        console.warn("[Anchor webhook] submission decline update failed:", e.message);
      }
      await pushTo(user.id, "Verification failed", reason);
      return;
    }

    // ── Customer KYC in manual review ───────────────────────────────────────
    if (eventType === "customer.identification.manualReview") {
      const customerId =
        rels.customer?.data?.id ||
        rels.resource?.data?.id ||
        attrs.failureEventData?.resource?.id ||
        event.data?.id;
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

      // The individual-KYC flow writes a BUSINESS-named virtual NUBAN explicitly
      // (openIndividualBankAccount). The SAVINGS settlement account's OWN
      // accountNumber.created — named after the PERSON — must not clobber it.
      // Once a NUBAN is set, only an identical redelivery is allowed through.
      if (biz.virtualAccountNumber && biz.virtualAccountNumber !== accountNumber) {
        console.log(
          `[Anchor webhook] accountNumber.created ignored — ${biz.name} already has NUBAN ${biz.virtualAccountNumber} (incoming ${accountNumber})`,
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
      const customerId =
        rels.customer?.data?.id ||
        rels.resource?.data?.id ||
        attrs.failureEventData?.resource?.id ||
        event.data?.id;
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
      eventType === "nip.inbound.received" ||
      eventType === "nip.inbound.settled" ||
      eventType === "transaction.created" ||
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
      // Don't clobber an already-set (business-named) NUBAN with a different one.
      if (biz.virtualAccountNumber && biz.virtualAccountNumber !== virtualNuban) {
        return;
      }
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
      // LIVE payload shape (verified 2026-07-30 via the keys-only probe): the
      // whole payment — amount, narration, counterParty (sender!), and
      // virtualNuban (our receiving account number) — nests under
      // attributes.payment. Sandbox/classic shapes keep flat attrs. Read the
      // nested shape first, fall through to every flat variant.
      const pay = attrs.payment || {};
      const accountNumber =
        pay.virtualNuban?.accountNumber ||
        attrs.destinationAccountNumber ||
        attrs.creditAccount?.accountNumber ||
        attrs.accountNumber;
      const amountRaw = Number(pay.amount ?? attrs.amount ?? 0);
      // Anchor amounts are in kobo — always divide by 100. (The old
      // `> 100000 ? /100 : raw` guard mis-recorded any transfer ≤ ₦1,000 at
      // 100× its value, e.g. a ₦10 credit = 1000 kobo became ₦1,000.)
      const amount = amountRaw / 100;
      if (!accountNumber || amount <= 0) return;

      const biz = await prisma.business.findFirst({
        where: { virtualAccountNumber: accountNumber },
        include: { user: true },
      });
      if (!biz) {
        console.warn(`[Anchor webhook] no business for account ${accountNumber}`);
        return;
      }

      // One NIP credit fires several events (payment.received AND
      // payment.settled), and the 5-min reconcile poller books the same money
      // from /transactions. All paths converge on ONE row via the UNIQUE
      // Transaction.reference keyed on Anchor's paymentId — whoever books
      // first wins, every other writer hits P2002 and skips.
      const paymentKey =
        pay.paymentId || pay.paymentReference || rels.payment?.data?.id || attrs.paymentId || "";
      const reference = paymentKey ? `anc_pay_${paymentKey}` : null;

      // Sender: live payloads carry counterParty inline on the payment object
      // (extractSender reads it); older shapes resolve via the linked Payment.
      const { sender, narration } = await resolveInboundSender({ ...attrs, ...pay }, paymentKey);
      const sessionId = pay.paymentReference || attrs.sessionId || attrs.reference || "";
      const description = buildInboundDescription({ sender, narration, reference: sessionId });
      const paidAt = pay.paidAt ? new Date(pay.paidAt) : null;

      // Cross-path repair: the reconcile poller books credits it can't link to
      // a Payment as "Anonymous sender" with an anc_txn_ (or legacy null)
      // reference — a key the unique check below can't collide with. If this
      // payment event matches such a row (same business + amount, booked within
      // ±30 min of the payment's own paidAt), it IS that money: BACKFILL the
      // real sender into the description and lock the row onto the anc_pay_
      // key instead of booking a duplicate.
      if (paidAt) {
        const reconTwin = await prisma.transaction.findFirst({
          where: {
            businessId: biz.id,
            source: "anchor",
            type: "income",
            amount,
            OR: [{ reference: null }, { reference: { startsWith: "anc_txn_" } }],
            date: {
              gte: new Date(paidAt.getTime() - 30 * 60 * 1000),
              lte: new Date(paidAt.getTime() + 30 * 60 * 1000),
            },
          },
          orderBy: { date: "asc" },
          select: { id: true, reference: true },
        });
        if (reconTwin) {
          await prisma.transaction.update({
            where: { id: reconTwin.id },
            data: { description, ...(reference ? { reference } : {}) },
          });
          console.log(
            `[Anchor webhook] credit ₦${amount} was reconcile-booked (${reconTwin.reference || "no ref"}) — backfilled sender + locked onto ${reference || "same ref"}`,
          );
          return;
        }
      }

      try {
        await prisma.transaction.create({
          data: {
            businessId: biz.id,
            userId: biz.userId,
            type: "income",
            amount,
            description,
            category: "transfer",
            paymentMethod: "bank",
            date: pay.paidAt
              ? new Date(pay.paidAt)
              : attrs.transactionDate
              ? new Date(attrs.transactionDate)
              : new Date(),
            source: "anchor",
            ...(reference ? { reference } : {}),
          },
        });
      } catch (createErr) {
        if (createErr.code === "P2002") {
          console.log(
            `[Anchor webhook] credit ${reference} already booked (another event or reconcile) — skipping`,
          );
          return;
        }
        throw createErr;
      }

      const { title, body } = buildInboundNotification({
        business: biz,
        amount,
        sender,
        narration,
      });
      await pushTo(biz.userId, title, body);

      // Auto-confirm a matching Instagram/WhatsApp payment request (fire-and-forget).
      require("../utils/igPaymentMatch").tryMatchIgPayment(biz, amount).catch(() => {});
      require("../utils/waPaymentMatch").tryMatchWaPayment(biz, amount).catch(() => {});

      // Reflect the inbound credit in cash-at-bank immediately (display cache).
      try { require("../utils/balanceCache").adjustBalance(biz.id, Number(amount) || 0); } catch { /* noop */ }

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
      const amount = amountRaw / 100; // kobo → naira (always)
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

      // Auto-confirm a matching Instagram/WhatsApp payment request (fire-and-forget).
      require("../utils/igPaymentMatch").tryMatchIgPayment(destBiz, amount).catch(() => {});
      require("../utils/waPaymentMatch").tryMatchWaPayment(destBiz, amount).catch(() => {});

      // Reflect the inbound credit in cash-at-bank immediately (display cache).
      try { require("../utils/balanceCache").adjustBalance(destBiz.id, Number(amount) || 0); } catch { /* noop */ }

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

    console.log(`[Anchor webhook] unhandled event type: ${eventType}`);
  } catch (err) {
    console.error("[Anchor webhook] processing error:", err);
  }
});

module.exports = router;
