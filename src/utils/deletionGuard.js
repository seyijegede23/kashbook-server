// The bank-balance guard both deletion routes share, so the two can never
// drift apart: POST /auth/delete-account (scope "account") and DELETE
// /businesses/:id (scope "business"). Nothing is deleted around money in a
// business's bank account: refuse while any of the businesses holds a
// balance, and fail closed when a balance cannot be read. Fincra pools every
// virtual account into one merchant wallet, so a Fincra business's cash at
// the bank is its ledger (providerAccountId + pooledWallet), while Anchor
// reports a balance per account; both are covered. A business with no bank
// account has nothing to check. Savings pots are checked first, by
// utils/savings.js savingsBlockingDeletion, so a refusal names the pot before
// the bank balance.
//
// Each business needs id, name, country, anchorAccountId, providerAccountId
// and baseCurrency. Returns null when deletion may go ahead, else
// { status, body } for the route to send.
const anchor = require("./anchor");
const { getProvider } = require("../providers");
const { computeLedgerBalance } = require("./ledgerBalance");

async function bankBalanceBlockingDeletion(businesses, scope = "account") {
  const then = scope === "business" ? "delete this business" : "delete your account";
  for (const biz of (businesses || []).filter((b) => b && (b.providerAccountId || b.anchorAccountId))) {
    try {
      const provider = getProvider(biz);
      const balance = provider.pooledWallet
        ? await computeLedgerBalance(biz.id, biz.baseCurrency || "NGN")
        : (await anchor.getAccountBalance(biz.anchorAccountId)).balance;
      if (balance > 0) {
        return {
          status: 400,
          body: {
            code: "BALANCE_REMAINING",
            error: `${biz.name} still has money in its bank account. Transfer it out first, then ${then}.`,
          },
        };
      }
    } catch (err) {
      if (err.code === "ANCHOR_NOT_CONFIGURED") continue; // no live banking in this environment
      return {
        status: 503,
        body: { code: "BALANCE_UNAVAILABLE", error: "We couldn't verify your bank balance right now. Try again in a few minutes." },
      };
    }
  }
  return null;
}

module.exports = { bankBalanceBlockingDeletion };
