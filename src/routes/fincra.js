// Fincra webhook — fail-closed HMAC-SHA512 verify (header `signature`), dedup via
// ProcessedWebhook, then handle account lifecycle + inbound credits.
//
// Mounted at POST /webhooks/fincra with express.raw BEFORE express.json so we can
// hash the EXACT bytes Fincra signed (they sign JSON.stringify(payload) and send
// that as the body, so raw-byte verification is robust to re-stringify drift).
//
// ⚠️ The account_issued / collection.successful DATA field paths below are the
// documented/expected shapes; confirm them against a REAL Fincra event once FCY
// + webhook delivery are enabled (FCY is currently disabled on the sandbox
// account). Signature + dedup + routing are verified.
const express = require("express");
const router = express.Router();
const prisma = require("../utils/db");
const FincraProvider = require("../providers/fincra");
const { pushTo } = require("../utils/pushNotification");
const { buildInboundNotification, buildInboundDescription } = require("../utils/inboundCreditNotification");
const balanceCache = require("../utils/balanceCache");

const fincra = new FincraProvider();

router.post("/", async (req, res) => {
  const raw = Buffer.isBuffer(req.body)
    ? req.body.toString("utf8")
    : typeof req.body === "string"
      ? req.body
      : JSON.stringify(req.body || {});

  const bypass = process.env.FINCRA_VERIFY_WEBHOOK === "false" && process.env.NODE_ENV !== "production";
  if (!bypass && !fincra.verifyWebhook(raw, req.headers)) {
    return res.status(401).json({ error: "invalid signature" });
  }

  const evt = fincra.parseWebhookEvent(raw);
  // Ack fast; process after responding.
  res.status(200).json({ received: true });

  try {
    // Dedup keyed on event:resourceId. We record the marker only AFTER processing
    // succeeds, so a transient failure (DB blip, timeout) leaves NO marker and
    // Fincra's redelivery can retry — otherwise a marker-before-processing write
    // would permanently drop an inbound credit. Re-processing is safe: the
    // Transaction @@unique([businessId,reference]) collapses double-credits and
    // the account-lifecycle updates are idempotent.
    const dedupId = evt.dedupId || evt.event || "";
    const dedupKey = dedupId ? `fincra:${evt.event}:${dedupId}` : null;
    if (dedupKey) {
      const seen = await prisma.processedWebhook.findFirst({ where: { eventId: dedupKey } });
      if (seen) return; // already fully processed
    }
    await handleEvent(evt);
    if (dedupKey) {
      await prisma.processedWebhook
        .create({ data: { eventId: dedupKey, type: evt.event } })
        .catch((e) => { if (e.code !== "P2002") throw e; });
    }
  } catch (e) {
    console.error("[Fincra webhook]", evt?.event, e.message);
  }
});

async function findForeignAccount(d) {
  const requestId = d._id || d.id || d.virtualAccount?._id || d.reference;
  const accountNumber = d.accountNumber || d.accountInformation?.accountNumber;
  return prisma.foreignAccount.findFirst({
    where: {
      OR: [
        requestId ? { fincraRequestId: String(requestId) } : undefined,
        requestId ? { fincraAccountId: String(requestId) } : undefined,
        accountNumber ? { accountNumber: String(accountNumber) } : undefined,
      ].filter(Boolean),
    },
  });
}

async function handleEvent(evt) {
  const d = evt.data || {};
  switch (evt.kind) {
    case "account_approved": {
      const fa = await findForeignAccount(d);
      if (fa) await prisma.foreignAccount.update({ where: { id: fa.id }, data: { status: "approved" } });
      break;
    }
    case "account_issued": {
      const info = d.accountInformation || {};
      const other = info.otherInfo || {};
      const fa = await findForeignAccount(d);
      if (fa) {
        await prisma.foreignAccount.update({
          where: { id: fa.id },
          data: {
            status: "issued",
            fincraAccountId: String(d._id || d.id || fa.fincraAccountId || ""),
            accountNumber: d.accountNumber || info.accountNumber || fa.accountNumber,
            accountName: info.accountName || fa.accountName,
            bankName: info.bankName || fa.bankName,
            swift: other.swift || other.swiftCode || null,
            routing: other.routing || other.routingNumber || null,
            iban: other.iban || null,
          },
        });
        const biz = await prisma.business.findUnique({ where: { id: fa.businessId }, select: { userId: true } });
        if (biz) pushTo(biz.userId, "Account ready 🎉", `Your ${fa.currency} account is now active.`).catch(() => {});
      }
      break;
    }
    case "inbound_credit":
      await recordInboundCredit(d);
      break;
    default:
      break;
  }
}

// collection.successful → record an income Transaction for the credited account.
async function recordInboundCredit(d) {
  const accountNumber = String(
    d.virtualAccount?.accountNumber || d.destinationAccountNumber || d.accountNumber || "",
  );
  const amount = Number(d.amount || d.amountReceived || 0); // ⚠️ confirm unit (major vs minor) on a real event
  const currency = d.currency || "USD";
  const reference = d.reference || d.id || d._id;
  if (!accountNumber || amount <= 0 || !reference) return;

  // Match the receiving account: FCY (ForeignAccount) first, then a local NUBAN.
  const fa = await prisma.foreignAccount.findFirst({ where: { accountNumber } });
  const biz = fa
    ? await prisma.business.findUnique({ where: { id: fa.businessId } })
    : await prisma.business.findFirst({ where: { virtualAccountNumber: accountNumber } });
  if (!biz) {
    console.warn(`[Fincra webhook] inbound credit — no business for account ${accountNumber}`);
    return;
  }

  // Idempotency: the @@unique([businessId, reference]) blocks a double credit.
  const sender = {
    name: d.senderName || d.payerName || "",
    bank: d.senderBank || "",
    accountNumber: d.senderAccountNumber || "",
    label: d.senderName || d.payerName || "a transfer",
    hasName: !!(d.senderName || d.payerName),
  };
  const narration = d.narration || d.description || "";
  try {
    await prisma.transaction.create({
      data: {
        businessId: biz.id,
        userId: biz.userId,
        type: "income",
        amount,
        currency,
        description: buildInboundDescription({ sender, narration, reference }),
        category: "transfer",
        paymentMethod: "bank",
        date: new Date(),
        source: "fincra",
        reference,
      },
    });
  } catch (e) {
    if (e.code === "P2002") return; // duplicate reference — already recorded
    throw e;
  }

  // FCY 10k/month inflow guardrail (tracked on the ForeignAccount).
  if (fa) {
    const month = new Date().toISOString().slice(0, 7);
    const carry = fa.inflowMonth === month ? Number(fa.inflowThisMonth || 0) : 0;
    const total = carry + amount;
    await prisma.foreignAccount.update({
      where: { id: fa.id },
      data: { inflowThisMonth: total, inflowMonth: month },
    });
    if (total > 10000) {
      await prisma.complianceFlag.create({
        data: {
          userId: biz.userId,
          businessId: biz.id,
          ruleCode: "FCY_MONTHLY_CAP",
          severity: "medium",
          description: `${currency} inflow this month (${total.toLocaleString()}) exceeds the 10,000/month cap.`,
          metadata: { currency, total },
        },
      }).catch(() => {});
    }
  }

  const { title, body } = buildInboundNotification({ business: biz, amount, sender, narration });
  pushTo(biz.userId, title, body).catch(() => {});
  try { balanceCache.adjustBalance(biz.id, amount); } catch { /* noop */ }
  require("../utils/igPaymentMatch").tryMatchIgPayment(biz, amount).catch(() => {});
  require("../utils/waPaymentMatch").tryMatchWaPayment(biz, amount).catch(() => {});
}

module.exports = router;
