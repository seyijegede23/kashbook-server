// Cash-at-bank from OUR own ledger — the source of truth for pooled-wallet
// providers (Fincra), where every virtual account collects into a single shared
// merchant wallet per currency and the provider has no per-business balance.
//
// Balance = money that flowed through the business's virtual account, IN ITS
// LOCAL CURRENCY:
//   Σ inbound credits (income, paymentMethod:"bank")
// − Σ outbound payouts (expense, paymentMethod:"bank", category:"transfer")
//
// The currency filter is critical: FCY (USD/EUR/GBP) ForeignAccount credits are
// booked as bank income on the SAME business, so without it a $500 inflow would
// be added 1:1 to the naira balance. Legacy rows with a null currency are treated
// as the queried (base) currency. Matches the shapes written by the Fincra webhook
// (recordInboundCredit) and payout path (executeFincraPayout). Floored at 0. Also
// the local-math fallback for Anchor when its balance API is unreachable.
const prisma = require("./db");

async function computeLedgerBalance(businessId, currency = "NGN") {
  // Base-currency rows only (null currency = legacy local rows → count as base).
  const cur = { OR: [{ currency }, { currency: null }] };
  const [inAgg, outAgg] = await Promise.all([
    prisma.transaction.aggregate({
      where: { businessId, type: "income", paymentMethod: "bank", ...cur },
      _sum: { amount: true },
    }),
    prisma.transaction.aggregate({
      where: {
        businessId,
        type: "expense",
        paymentMethod: "bank",
        category: "transfer",
        ...cur,
      },
      _sum: { amount: true },
    }),
  ]);
  return Math.max(
    0,
    Number(inAgg._sum.amount || 0) - Number(outAgg._sum.amount || 0),
  );
}

module.exports = { computeLedgerBalance };
