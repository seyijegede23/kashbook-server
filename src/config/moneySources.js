// The payment providers whose money actually sits in a payable pool/account.
// These are the ONLY Transaction `source` values that count as real, spendable
// bank money (computeLedgerBalance) and toward AML velocity limits (amlChecks).
//
// A bank Transaction row with any OTHER or null source — a legacy provider
// ("monnify", "korapay", "fincra"), a manually created row, or anything a client could post — is NOT
// backed by the pooled wallet, so it must never inflate a spendable balance or gate
// a real payout. This single list keeps the ledger math and the AML windowing in
// lockstep (they were separate before and could disagree).
//
// "fincra" was removed on 2026-08-27 with the foreign-currency feature. It is
// safe to drop from this list ONLY because the ledger held zero fincra-sourced
// rows at the time (verified: all 52 rows were "anchor"). Removing a source
// that HAD money against it would silently make that money unspendable, so
// re-verify before ever pruning this list again.
const PROVIDER_SOURCES = ["anchor"];

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
