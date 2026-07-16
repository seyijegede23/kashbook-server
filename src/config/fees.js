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

// ─── Fincra pay-out fees ────────────────────────────────────────────────────
// Fincra charges KashBook 1% on every external pay-out (local + international).
// We charge the customer FINCRA_FEE_PERCENT = 1.5% (1% pass-through + 0.5%
// KashBook margin), optionally capped. On the POOLED model there's no separate
// fee account: the margin simply stays in the merchant wallet unallocated to any
// business ledger, i.e. it IS KashBook's revenue. Internal KashBook→KashBook book
// transfers cost Fincra nothing and stay free. Applies to NGN/GHS/TZS pay-outs.
const FINCRA_FEE_PERCENT = 1.5;   // total % charged to the customer
const FINCRA_FEE_CAP = null;      // max fee per transfer in the local currency (null = uncapped)

function computeFincraTransferFee(amount, { internal = false } = {}) {
  if (internal) return { total: 0, breakdown: null };
  const a = Number(amount) || 0;
  let fee = Math.round(a * (FINCRA_FEE_PERCENT / 100) * 100) / 100; // 2 dp
  if (FINCRA_FEE_CAP != null && fee > FINCRA_FEE_CAP) fee = FINCRA_FEE_CAP;
  return { total: fee, breakdown: { percent: FINCRA_FEE_PERCENT, cap: FINCRA_FEE_CAP } };
}

module.exports = {
  NIP_FEE,
  STAMP_DUTY,
  STAMP_DUTY_THRESHOLD,
  PLATFORM_MARGIN,
  feesEnabled,
  computeTransferFee,
  FINCRA_FEE_PERCENT,
  FINCRA_FEE_CAP,
  computeFincraTransferFee,
};
