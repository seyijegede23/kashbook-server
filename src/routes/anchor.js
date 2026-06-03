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
const prisma = require("../utils/db");
const anchor = require("../utils/anchor");

async function pushTo(userId, title, body) {
  if (!userId) return;
  await prisma.appNotification.create({ data: { userId, title, body } });
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { expoPushToken: true, notificationsEnabled: true },
  });
  if (user?.expoPushToken && user?.notificationsEnabled) {
    fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to: user.expoPushToken,
        title,
        body,
        sound: "default",
      }),
    }).catch(() => {});
  }
}

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
      if (!customerId) return;

      const user = await prisma.user.update({
        where: { anchorCustomerId: customerId },
        data: { kycStatus: "verified" },
      }).catch(() => null);
      if (!user) return;

      // Open deposit accounts for any business that requested one but doesn't have one yet
      const pending = await prisma.business.findMany({
        where: {
          userId: user.id,
          anchorAccountId: null,
          virtualAccountNumber: null,
        },
      });
      for (const biz of pending) {
        try {
          const acc = await anchor.createDepositAccount({
            customerId,
            productName: biz.bankAccountType || "SAVINGS",
          });
          await prisma.business.update({
            where: { id: biz.id },
            data: {
              anchorAccountId: acc.accountId,
              virtualAccountId: acc.accountId,
              virtualAccountRef: acc.accountId,
              virtualAccountNumber: acc.accountNumber || null,
              virtualAccountBank: acc.bankName || "Anchor",
              virtualAccountName: acc.accountName || biz.name,
            },
          });
          if (acc.accountNumber) {
            await pushTo(
              user.id,
              "Bank account ready 🎉",
              `${biz.name}'s bank account is active.`,
            );
          }
        } catch (err) {
          console.error(
            `[Anchor webhook] createDepositAccount failed for ${biz.id}:`,
            err.message,
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
      const user = await prisma.user
        .update({
          where: { anchorCustomerId: customerId },
          data: { kycStatus: "rejected" },
        })
        .catch(() => null);
      if (!user) return;
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

      await prisma.business.update({
        where: { id: biz.id },
        data: {
          virtualAccountNumber: accountNumber,
          virtualAccountBank: bankName || biz.virtualAccountBank || "Anchor",
          virtualAccountName: accountName || biz.name,
        },
      });

      await pushTo(
        biz.userId,
        "Bank account ready 🎉",
        `${biz.name}'s bank account is active.`,
      );
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
      eventType === "virtualNuban.opened"
    ) {
      // account.initiated  — fires when a DepositAccount creation starts
      // customer.created   — fires after a customer is created (we already have the ID)
      // virtualNuban.opened — fires alongside accountNumber.created; same NUBAN info
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

      await prisma.business.update({
        where: { id: biz.id },
        data: { virtualAccountNumber: virtualNuban },
      });
      await pushTo(
        biz.userId,
        "Bank account ready 🎉",
        `${biz.name}'s bank account is active.`,
      );
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

      const senderName = attrs.senderName || attrs.sourceAccountName || "customer";
      const senderBank = attrs.sourceBank || attrs.senderBank || "";
      const senderAccount =
        attrs.sourceAccountNumber || attrs.senderAccountNumber || "";
      const narration = attrs.narration || attrs.reason || "";
      const sessionId = attrs.sessionId || attrs.reference || "";

      let description = `Transfer received from ${senderName}`;
      if (senderBank) description += ` (${senderBank})`;
      if (senderAccount) description += ` · Acct: ${senderAccount}`;
      if (narration) description += ` · "${narration}"`;
      if (sessionId) description += ` · Ref: ${sessionId}`;

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

      const notifBody = `₦${amount.toLocaleString("en-NG", {
        minimumFractionDigits: 2,
      })} received in ${biz.name}`;
      await pushTo(biz.userId, "Payment Received 🎉", notifBody);
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
