// Outbound-transfer fee schedule (repriced Aug 2026 against Anchor's real,
// live-verified cost):
//
//   Anchor NIP payout            ₦20   every external transfer (our cost)
//   KashBook platform margin     ₦30   every external transfer (our revenue)
//   → OUR FEE: ₦50 flat, any amount.
//
//   Government stamp duty        ₦50   only on transfers strictly over ₦10,000.
//                                      NOT ours — Anchor debits and remits it.
//                                      We only account for it so the ledger and
//                                      the balance gate match reality.
//
// Internal KashBook→KashBook book transfers cost Anchor ₦0 and are free to
// the user (product perk — keep it that way).
//
// Collection: the fee is book-transferred (free) from the user's deposit
// account into KashBook's revenue account (ANCHOR_FEE_ACCOUNT_ID) right
// after the NIP transfer succeeds. No ANCHOR_FEE_ACCOUNT_ID → fees are
// disabled: quotes return ₦0 and nothing is collected.

// Float money tolerance (½ kobo). Bridges IEEE-754 drift on balance-gate
// comparisons and the pool-vs-ledger invariant until Phase C moves money to an
// exact type — a shortfall smaller than this is treated as zero so a legitimate
// send isn't blocked for a sub-kobo rounding artifact.
const MONEY_EPS = 0.005;

// Live-verified 2026-07-31: Anchor's actual NIP charge is ₦20/transfer.
// Owner-set price 2026-08-02: OUR fee is ₦50 FLAT for every external transfer
// (₦20 Anchor cost + ₦30 margin) — swept to the revenue account.
//
// STAMP_DUTY is NOT ours: under the Nigeria Tax Act 2025 (from Jan 2026) a ₦50
// sender-side stamp duty applies to transfers ABOVE ₦10,000, and ANCHOR debits
// it from the sending account and remits it (live-verified: "Stamp Duty Fee for
// NIP Transfer" debit rows). We never charge, keep, or remit it — we only
// ACCOUNT for it: the balance gate and the booked Transaction.fee include it so
// the ledger matches the real account movement, and quotes disclose it.
const NIP_FEE = 20;
const STAMP_DUTY = 50;
const STAMP_DUTY_THRESHOLD = 10000; // strictly over — ₦10,000.00 exactly pays no duty
const PLATFORM_MARGIN = 30;

function feesEnabled() {
  return !!process.env.ANCHOR_FEE_ACCOUNT_ID;
}

// route: "nip" (external) | "book" (KashBook→KashBook internal)
// Returns:
//   total          — OUR fee (what we sweep): ₦50 flat
//   statutoryStamp — the government's ₦50 (>₦10k), debited by the BANK, not us
//   totalCost      — total + statutoryStamp = everything that leaves the account
//                    beyond the amount (use for balance gates + booked fee)
function computeTransferFee(amount, route) {
  if (!feesEnabled() || route === "book") {
    return { total: 0, statutoryStamp: 0, totalCost: 0, breakdown: null };
  }
  const statutoryStamp = Number(amount) > STAMP_DUTY_THRESHOLD ? STAMP_DUTY : 0;
  const total = NIP_FEE + PLATFORM_MARGIN;
  return {
    total,
    statutoryStamp,
    totalCost: total + statutoryStamp,
    breakdown: { nip: NIP_FEE, platform: PLATFORM_MARGIN, stampDuty: statutoryStamp },
  };
}
// ── Savings: breaking a flexible lock ───────────────────────────────────────
// Taking money out of a flexible-locked pot before its date costs a share of
// the amount, floored at a minimum and never more than the amount itself.
// Owner's numbers (2026-09-29): 2% (200 bps), minimum ₦100. Both live in env
// so they can change without a deploy: SAVINGS_BREAK_FEE_BPS,
// SAVINGS_BREAK_FEE_MIN. Off when there is no fee account to sweep into,
// because a fee nothing can collect must not be charged.
const BREAK_FEE_BPS_DEFAULT = 200;
const BREAK_FEE_MIN_DEFAULT = 100;
function breakFeeConfig() {
  const bps = Number(process.env.SAVINGS_BREAK_FEE_BPS);
  const min = Number(process.env.SAVINGS_BREAK_FEE_MIN);
  return {
    bps: Number.isFinite(bps) && bps >= 0 && bps <= 1000 ? Math.round(bps) : BREAK_FEE_BPS_DEFAULT,
    min: Number.isFinite(min) && min >= 0 ? Math.round(min * 100) / 100 : BREAK_FEE_MIN_DEFAULT,
    enabled: feesEnabled(),
  };
}
function computeBreakFee(amount) {
  const { bps, min, enabled } = breakFeeConfig();
  const amt = Number(amount) || 0;
  if (!enabled || bps === 0 || amt <= 0) return { fee: 0, bps, min, enabled: enabled && bps > 0 };
  let fee = Math.round((amt * bps) / 100) / 100; // bps of the amount, to the kobo
  fee = Math.max(fee, min);
  fee = Math.min(fee, amt);
  return { fee: Math.round(fee * 100) / 100, bps, min, enabled: true };
}

module.exports = {
  MONEY_EPS,
  NIP_FEE,
  STAMP_DUTY,
  STAMP_DUTY_THRESHOLD,
  PLATFORM_MARGIN,
  feesEnabled,
  computeTransferFee,
  breakFeeConfig,
  computeBreakFee,
};
