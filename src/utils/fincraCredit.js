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

async function recordFincraInboundCredit(d, source = "fincra") {
  // `collection.successful` identifies the receiving account as `virtualAccount`,
  // which is a STRING id, not an object. The previous code read
  // `d.virtualAccount?.accountNumber` and four other keys that do not exist on
  // this payload at all, so the account resolved to "" and every inbound credit
  // returned { recorded:false, reason:"invalid" } — silently, for both the
  // webhook and the reconcile backstop that share this function.
  const vaId = typeof d.virtualAccount === "string"
    ? d.virtualAccount
    : (d.virtualAccount?._id || d.virtualAccount?.id || "");
  // Legacy/alternate shapes still carry a plain account number; keep as fallback.
  const accountNumber = String(
    d.virtualAccount?.accountNumber || d.destinationAccountNumber || d.accountNumber
      || d.virtual_bank_account?.account_number || d.account_number || "",
  );

  // `d.amount` does not exist. `amountReceived` is the settled, fee-net figure
  // and is what the merchant actually got — do NOT subtract `fee` from it again.
  const amount = Number(d.amountReceived ?? d.destinationAmount ?? d.amount ?? d.amount_paid ?? 0);
  const fee = Number(d.fee ?? 0);
  const reference = d.reference || d.sessionId || d.id || d._id;

  // Resolve the account BEFORE deciding the currency, so an FCY account can
  // supply it if the payload somehow omits it.
  let fa = null;
  if (vaId) {
    fa = await prisma.foreignAccount.findFirst({
      where: { OR: [{ fincraAccountId: vaId }, { fincraRequestId: vaId }] },
    });
  }
  if (!fa && accountNumber) {
    fa = await prisma.foreignAccount.findFirst({ where: { accountNumber } });
  }
  let biz = null;
  if (fa) {
    biz = await prisma.business.findUnique({ where: { id: fa.businessId } });
  } else if (vaId) {
    // Local (pooled) accounts store Fincra's virtual-account id on the business.
    biz = await prisma.business.findFirst({ where: { providerAccountId: vaId } });
  }
  if (!biz && accountNumber) {
    biz = await prisma.business.findFirst({ where: { virtualAccountNumber: accountNumber } });
  }

  // `d.currency` does not exist either; the payload carries source/destination
  // currencies. Pair the currency with the amount we took above
  // (`amountReceived`/`destinationAmount` are DESTINATION-side figures).
  const currency = d.destinationCurrency || fa?.currency || biz?.baseCurrency || d.sourceCurrency || d.currency;

  // Fail LOUDLY. A silent "invalid" on money-in is exactly what hid this bug.
  if (!biz) {
    console.error(
      `[fincraCredit] UNRESOLVED inbound credit — virtualAccount=${vaId || "?"} ` +
      `accountNumber=${accountNumber || "?"} ref=${reference || "?"} amount=${amount} ${currency || "?"}`,
    );
    return { recorded: false, reason: "no_business", virtualAccount: vaId, accountNumber };
  }
  if (!(amount > 0) || !reference || !currency) {
    console.error(
      `[fincraCredit] MALFORMED inbound credit for business ${biz.id} — ` +
      `amount=${amount} ref=${reference || "?"} currency=${currency || "?"}`,
    );
    return { recorded: false, reason: "invalid", businessId: biz.id };
  }

  // Documented sender fields are senderAccountName / senderBankName /
  // senderAccountNumber / customerName. The previous senderName/payerName/
  // senderBank keys do not exist, so every credit showed "a transfer".
  // senderAccountNumber is null on the successful sample, so treat it as optional.
  const senderName = d.senderAccountName || d.customerName || "";
  const sender = {
    name: senderName,
    bank: d.senderBankName || "",
    accountNumber: d.senderAccountNumber || "",
    label: senderName || "a transfer",
    hasName: !!senderName,
  };
  const narration = d.description || d.narration || "";
  try {
    await prisma.transaction.create({
      data: {
        businessId: biz.id,
        userId: biz.userId,
        type: "income",
        amount,
        fee,
        currency,
        description: buildInboundDescription({ sender, narration, reference }),
        category: "transfer",
        paymentMethod: "bank",
        date: new Date(),
        source,
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
  // The cached balance is single-currency (the business's own base currency).
  // Adjusting it with an FCY amount would add dollars onto a naira balance, so
  // only apply it when the credit is in the base currency; FCY balances are
  // derived from the ledger instead.
  const baseCurrency = biz.baseCurrency || "NGN";
  if (String(currency).toUpperCase() === String(baseCurrency).toUpperCase()) {
    try { balanceCache.adjustBalance(biz.id, amount); } catch { /* noop */ }
  } else {
    try { balanceCache.bustBalance(biz.id); } catch { /* noop */ }
  }
  require("./igPaymentMatch").tryMatchIgPayment(biz, amount).catch(() => {});
  require("./waPaymentMatch").tryMatchWaPayment(biz, amount).catch(() => {});
  return { recorded: true, businessId: biz.id, amount, currency };
}

module.exports = { recordFincraInboundCredit };
