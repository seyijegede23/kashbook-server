// Single source of truth for AML limits, risk classification, and step-up
// thresholds. Tuning these is a code-review event by design — DB-driven
// limits would let an admin loosen them without trail. If you need
// emergency tuning without a redeploy, use the env-var overrides at the
// bottom of this file.

const NAIRA = (n) => n; // self-doc: limits below are in naira

// ── Tiered limits by business KYB type ────────────────────────────────────
const TIER_LIMITS = {
  unverified: {
    daily:     NAIRA(0),
    weekly:    NAIRA(0),
    monthly:   NAIRA(0),
    singleMax: NAIRA(0),
  },
  sole_proprietor: {
    daily:     NAIRA(500_000),
    weekly:    NAIRA(2_500_000),
    monthly:   NAIRA(5_000_000),
    singleMax: NAIRA(2_000_000),
  },
  limited_company: {
    daily:     NAIRA(5_000_000),
    weekly:    NAIRA(25_000_000),
    monthly:   NAIRA(50_000_000),
    singleMax: NAIRA(2_000_000),
  },
};

// Per-industry risk classification (matched against Business.industry verbatim
// from Anchor's enum). Risk multiplier reduces the tier limits.
const HIGH_RISK_INDUSTRIES = new Set([
  "Betting",
  "Lotteries",
  "PredictionServices",
  "Lending",
  "Investments",
  "AgriculturalInvestments",
  "Remittances",
  "MobileWallets",
  "BillPayments",
]);

const ELEVATED_RISK_INDUSTRIES = new Set([
  "RealEstate",
  "Construction",
  "Automobiles",
]);

const RISK_MULTIPLIER = {
  standard: 1.0,
  elevated: 0.75,
  high:     0.5,
};

// ── Step-up and flagging thresholds ───────────────────────────────────────

// Above this amount we require a one-time code sent to the user's email or
// phone IN ADDITION to the transaction PIN. Bigger transfer = bigger proof.
const STEP_UP_OTP_ABOVE = NAIRA(1_000_000);

// OTP type tag used so transfer step-up OTPs can't be confused with the
// signup / email-change / phone-change codes.
const TRANSFER_OTP_TYPE = "TRANSFER_STEP_UP";

// Any single transfer ≥ this amount auto-creates a CTR-style ComplianceFlag.
// Mirrors NFIU's ₦5M individual cash threshold for awareness; ours is
// digital so technically not CTR-subject, but it's a defensible signal.
const SINGLE_FLAG_ABOVE = NAIRA(5_000_000);

// ── Velocity / pattern rules thresholds ───────────────────────────────────
const VELOCITY_RULES = {
  // RAPID_FIRE: N transfers within window → medium flag
  rapidFireCount:    5,
  rapidFireWindowMs: 10 * 60 * 1000,

  // VELOCITY_SPIKE: today's volume > N × 30-day rolling daily avg → high flag (hold)
  spikeMultiplier:   5,
  spikeMinHistoryDays: 7, // don't flag spike if account is younger than this

  // STRUCTURING: N transfers within window, each ≥ subThreshold and < SINGLE_FLAG_ABOVE
  structuringCount:        4,
  structuringSubThreshold: NAIRA(4_500_000),
  structuringWindowMs:     24 * 60 * 60 * 1000,

  // OFF_HOURS: transfer between these local hours + amount > minAmount → low flag
  offHoursStartHour: 1,  // 01:00
  offHoursEndHour:   5,  // 05:00 (exclusive)
  offHoursMinAmount: NAIRA(500_000),
  timezone:          "Africa/Lagos",
};

// ── Helpers ───────────────────────────────────────────────────────────────

function getRiskCategory(industry) {
  if (!industry) return "standard";
  if (HIGH_RISK_INDUSTRIES.has(industry)) return "high";
  if (ELEVATED_RISK_INDUSTRIES.has(industry)) return "elevated";
  return "standard";
}

function resolveTierKey(business) {
  if (!business?.virtualAccountNumber) return "unverified";
  if ((business.kycBusinessType || "").toLowerCase() === "limited_company") {
    return "limited_company";
  }
  return "sole_proprietor";
}

function resolveBusinessLimits(business) {
  const tier = TIER_LIMITS[resolveTierKey(business)] || TIER_LIMITS.unverified;
  const mult = RISK_MULTIPLIER[business?.riskCategory || "standard"] || 1.0;

  // Env overrides — for emergency tuning without redeploy.
  const dailyOverride     = Number(process.env.AML_DAILY_LIMIT_OVERRIDE     || 0);
  const singleMaxOverride = Number(process.env.AML_SINGLE_MAX_OVERRIDE      || 0);

  return {
    daily:     dailyOverride > 0     ? dailyOverride     : Math.floor(tier.daily * mult),
    weekly:    Math.floor(tier.weekly * mult),
    monthly:   Math.floor(tier.monthly * mult),
    singleMax: singleMaxOverride > 0 ? singleMaxOverride : Math.floor(tier.singleMax * mult),
    tierKey:   resolveTierKey(business),
    riskCategory: business?.riskCategory || "standard",
  };
}

module.exports = {
  TIER_LIMITS,
  HIGH_RISK_INDUSTRIES,
  ELEVATED_RISK_INDUSTRIES,
  RISK_MULTIPLIER,
  STEP_UP_OTP_ABOVE,
  TRANSFER_OTP_TYPE,
  SINGLE_FLAG_ABOVE,
  VELOCITY_RULES,
  getRiskCategory,
  resolveTierKey,
  resolveBusinessLimits,
};
