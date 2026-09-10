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
// "fincra" was removed on 2026-08-27 and RESTORED on 2026-09-09 when Fincra
// approved EUR virtual accounts. It must be here: a EUR credit is real provider
// money, and a source missing from this list is money the ledger cannot see —
// it would be unspendable AND unprotected, because isBankLedgerRow below is what
// makes a bank row append-only against the client-reachable write surfaces.
//
// This does NOT let euros inflate a naira balance. This list answers "is the row
// real money"; the CURRENCY filter answers "whose balance". computeRawLedger
// (utils/ledgerBalance.js) queries `{ source: { in: PROVIDER_SOURCES }, currency }`
// — both conditions, so a EUR row only ever sums into a EUR balance. The two
// guards are independent and both are required; dropping the currency filter
// would add €1 to the naira balance as ₦1.
//
// Fincra is receive-only (see providers/index.js), so no outbound EUR row can
// exist. If a EUR payout path is ever added, re-check the AML money-out windows
// in amlChecks.js — they read this same list via MONEY_OUT_SOURCES and are
// NOT currency-scoped, so a EUR payout would be summed against naira thresholds.
const PROVIDER_SOURCES = ["anchor", "fincra"];

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
