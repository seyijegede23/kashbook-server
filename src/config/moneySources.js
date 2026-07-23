// The payment providers whose money actually sits in a payable pool/account.
// These are the ONLY Transaction `source` values that count as real, spendable
// bank money (computeLedgerBalance) and toward AML velocity limits (amlChecks).
//
// A bank Transaction row with any OTHER or null source — a legacy provider
// ("monnify"), a manually created row, or anything a client could post — is NOT
// backed by the pooled wallet, so it must never inflate a spendable balance or gate
// a real payout. This single list keeps the ledger math and the AML windowing in
// lockstep (they were separate before and could disagree).
const PROVIDER_SOURCES = ["anchor", "fincra", "korapay"];

// A "bank-ledger row" is real, provider-owned money that feeds the spendable
// balance — it must be append-only and never user-editable/deletable. True when
// the row carries a provider source, OR looks like a bank money-movement
// (paymentMethod "bank" + category "transfer") even absent a source. Used to guard
// the client-reachable write surfaces (routes/sync, routes/transactions).
function isBankLedgerRow(tx) {
  if (!tx) return false;
  if (tx.source && PROVIDER_SOURCES.includes(tx.source)) return true;
  return tx.paymentMethod === "bank" && tx.category === "transfer";
}

module.exports = { PROVIDER_SOURCES, isBankLedgerRow };
