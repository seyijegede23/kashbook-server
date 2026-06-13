// Outbound-transfer fee schedule. Pass-through of Anchor's costs + ₦1
// KashBook margin (user decision, June 2026; Anchor BaaS Standard pricing):
//
//   Anchor NIP payout            ₦50   every external transfer
//   CBN stamp duty               ₦50   only on transfers strictly over ₦10,000
//   KashBook platform margin     ₦1    every external transfer
//
//   → ₦51 per transfer ≤ ₦10,000, ₦101 above.
//
// Internal KashBook→KashBook book transfers cost Anchor ₦0 and are free to
// the user (product perk — keep it that way).
//
// Collection: the fee is book-transferred (free) from the user's deposit
// account into KashBook's revenue account (ANCHOR_FEE_ACCOUNT_ID) right
// after the NIP transfer succeeds. No ANCHOR_FEE_ACCOUNT_ID → fees are
// disabled: quotes return ₦0 and nothing is collected.

const NIP_FEE = 50;
const STAMP_DUTY = 50;
const STAMP_DUTY_THRESHOLD = 10000; // strictly over — ₦10,000.00 exactly pays no duty
const PLATFORM_MARGIN = 1;

function feesEnabled() {
  return !!process.env.ANCHOR_FEE_ACCOUNT_ID;
}

// route: "nip" (external) | "book" (KashBook→KashBook internal)
function computeTransferFee(amount, route) {
  if (!feesEnabled() || route === "book") {
    return { total: 0, breakdown: null };
  }
  const stampDuty = Number(amount) > STAMP_DUTY_THRESHOLD ? STAMP_DUTY : 0;
  return {
    total: NIP_FEE + stampDuty + PLATFORM_MARGIN,
    breakdown: { nip: NIP_FEE, stampDuty, platform: PLATFORM_MARGIN },
  };
}

// ─── Bill-payment fees ──────────────────────────────────────────────────────
// Airtime/data are sold at face value (₦0 user fee) — KashBook earns Anchor's
// biller commission, and a zero markup is what keeps it competitive. A small
// convenience fee on electricity/cable is OPT-IN (off by default): flip
// BILL_CONVENIENCE_FEE > 0 to enable. Same { total, breakdown } shape, and
// still gated on ANCHOR_FEE_ACCOUNT_ID so nothing is collected without a
// revenue account configured.
const BILL_CONVENIENCE_FEE = 0; // ₦ added to electricity/cable; 0 = no user fee
const BILL_CONVENIENCE_CATEGORIES = new Set(["electricity", "cabletv"]);

function computeBillFee(_amount, category) {
  if (!feesEnabled() || BILL_CONVENIENCE_FEE <= 0) {
    return { total: 0, breakdown: null };
  }
  if (!BILL_CONVENIENCE_CATEGORIES.has(String(category).toLowerCase())) {
    return { total: 0, breakdown: null };
  }
  return { total: BILL_CONVENIENCE_FEE, breakdown: { convenience: BILL_CONVENIENCE_FEE } };
}

module.exports = {
  NIP_FEE,
  STAMP_DUTY,
  STAMP_DUTY_THRESHOLD,
  PLATFORM_MARGIN,
  feesEnabled,
  computeTransferFee,
  computeBillFee,
};
