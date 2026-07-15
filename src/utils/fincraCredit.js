// Shared inbound-credit recorder for Fincra collections. Called by BOTH:
//   • the webhook (routes/fincra.js) on collection.successful, and
//   • the reconcile backstop (utils/fincraReconcile.js) when it finds a
//     collection Fincra reported that we never webhook-recorded.
// One idempotent path (Transaction @@unique([businessId, reference])) so the two
// can never double-credit. `d` is a Fincra collection object (webhook data or a
// /collections list item) — the field extraction is multi-path to tolerate both.
const prisma = require("./db");
const { pushTo } = require("./pushNotification");
const { buildInboundNotification, buildInboundDescription } = require("./inboundCreditNotification");
const balanceCache = require("./balanceCache");

async function recordFincraInboundCredit(d) {
  const accountNumber = String(
    d.virtualAccount?.accountNumber || d.destinationAccountNumber || d.accountNumber || "",
  );
  const amount = Number(d.amount || d.amountReceived || 0);
  const currency = d.currency || "NGN";
  const reference = d.reference || d.id || d._id;
  if (!accountNumber || amount <= 0 || !reference) return { recorded: false, reason: "invalid" };

  // Match the receiving account: FCY (ForeignAccount) first, then a local NUBAN.
  const fa = await prisma.foreignAccount.findFirst({ where: { accountNumber } });
  const biz = fa
    ? await prisma.business.findUnique({ where: { id: fa.businessId } })
    : await prisma.business.findFirst({ where: { virtualAccountNumber: accountNumber } });
  if (!biz) return { recorded: false, reason: "no_business", accountNumber };

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
    if (e.code === "P2002") return { recorded: false, reason: "duplicate", businessId: biz.id };
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
  require("./igPaymentMatch").tryMatchIgPayment(biz, amount).catch(() => {});
  require("./waPaymentMatch").tryMatchWaPayment(biz, amount).catch(() => {});
  return { recorded: true, businessId: biz.id, amount, currency };
}

module.exports = { recordFincraInboundCredit };
