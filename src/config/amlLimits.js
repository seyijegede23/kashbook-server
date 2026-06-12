// AML thresholds and helpers — now sourced per-country from the country
// config files. Risk classification (industry → high/elevated/standard)
// stays global because Anchor's industry enum is universal.
//
// The exported names (TIER_LIMITS, STEP_UP_OTP_ABOVE, SINGLE_FLAG_ABOVE,
// VELOCITY_RULES) remain for backwards compatibility — they expose the
// Nigeria limits as the default. New code should call
// `getThresholds(business)` or `resolveBusinessLimits(business)` to get
// the country-correct values.

const { getCountryConfig } = require("./countries");

// Per-industry risk classification (universal — Anchor's industry enum is
// used across all countries today). Canonical values carry Anchor's category
// prefix ("Gaming_Betting"); the bare legacy spellings stay listed because
// businesses onboarded before June 2026 stored them un-prefixed.
const HIGH_RISK_INDUSTRIES = new Set([
  "Gaming_Betting", "Gaming_Lotteries", "Gaming_PredictionServices",
  "FinancialServices_Lending", "FinancialServices_Investments",
  "FinancialServices_AgriculturalInvestments", "FinancialServices_Remittances",
  "FinancialServices_MobileWallets", "FinancialServices_BillPayments",
  // legacy un-prefixed values (pre-June-2026 rows)
  "Betting", "Lotteries", "PredictionServices",
  "Lending", "Investments", "AgriculturalInvestments",
  "Remittances", "MobileWallets", "BillPayments",
]);

const ELEVATED_RISK_INDUSTRIES = new Set([
  "RealEstate", "Commerce_RealEstate", "Construction",
  "Commerce_Automobiles",
  // legacy un-prefixed value (pre-June-2026 rows)
  "Automobiles",
]);

const RISK_MULTIPLIER = {
  standard: 1.0,
  elevated: 0.75,
  high:     0.5,
};

// OTP type tag used so transfer step-up OTPs can't be confused with the
// signup / email-change / phone-change codes.
const TRANSFER_OTP_TYPE = "TRANSFER_STEP_UP";

// Backwards-compat exports (Nigeria values) — DO NOT use in new code.
const NG = getCountryConfig("NG");
const TIER_LIMITS = {
  unverified:      { daily: 0,                            weekly: 0,                            monthly: 0,                             singleMax: 0 },
  sole_proprietor: NG.amlLimits.soleProp,
  limited_company: NG.amlLimits.limited,
};
const STEP_UP_OTP_ABOVE = NG.amlLimits.stepUpOtpAbove;
const SINGLE_FLAG_ABOVE = NG.amlLimits.singleFlagAbove;
const VELOCITY_RULES = {
  rapidFireCount:    5,
  rapidFireWindowMs: 10 * 60 * 1000,
  spikeMultiplier:   5,
  spikeMinHistoryDays: 7,
  structuringCount:        4,
  structuringSubThreshold: NG.amlLimits.structuringSubThreshold,
  structuringWindowMs:     24 * 60 * 60 * 1000,
  offHoursStartHour: 1,
  offHoursEndHour:   5,
  offHoursMinAmount: NG.amlLimits.offHoursMinAmount,
  timezone:          NG.timezone,
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

// Country-aware thresholds object. Pull this from `business.country`.
function getThresholds(business) {
  const cfg = getCountryConfig(business?.country);
  const aml = cfg.amlLimits;
  return {
    countryCode:             cfg.code,
    currencyCode:            cfg.currency.code,
    currencySymbol:          cfg.currency.symbol,
    currencyLocale:          cfg.currency.locale,
    timezone:                cfg.timezone,
    stepUpOtpAbove:          aml.stepUpOtpAbove,
    singleFlagAbove:         aml.singleFlagAbove,
    structuringSubThreshold: aml.structuringSubThreshold,
    offHoursMinAmount:       aml.offHoursMinAmount,
    velocity: {
      rapidFireCount:    5,
      rapidFireWindowMs: 10 * 60 * 1000,
      spikeMultiplier:   5,
      spikeMinHistoryDays: 7,
      structuringCount:        4,
      structuringWindowMs:     24 * 60 * 60 * 1000,
      offHoursStartHour: 1,
      offHoursEndHour:   5,
    },
  };
}

function resolveBusinessLimits(business) {
  const cfg = getCountryConfig(business?.country);
  const tierKey = resolveTierKey(business);
  const tier =
    tierKey === "limited_company"
      ? cfg.amlLimits.limited
      : tierKey === "sole_proprietor"
      ? cfg.amlLimits.soleProp
      : { daily: 0, weekly: 0, monthly: 0, singleMax: 0 };
  const mult = RISK_MULTIPLIER[business?.riskCategory || "standard"] || 1.0;

  // Env overrides — for emergency tuning without redeploy. Apply to NG only
  // by default; non-NG override would need its own env var per market.
  const dailyOverride     = Number(process.env.AML_DAILY_LIMIT_OVERRIDE     || 0);
  const singleMaxOverride = Number(process.env.AML_SINGLE_MAX_OVERRIDE      || 0);

  return {
    daily:     dailyOverride > 0     ? dailyOverride     : Math.floor(tier.daily * mult),
    weekly:    Math.floor(tier.weekly * mult),
    monthly:   Math.floor(tier.monthly * mult),
    singleMax: singleMaxOverride > 0 ? singleMaxOverride : Math.floor(tier.singleMax * mult),
    tierKey,
    riskCategory: business?.riskCategory || "standard",
    countryCode: cfg.code,
    currencyCode: cfg.currency.code,
    currencySymbol: cfg.currency.symbol,
    currencyLocale: cfg.currency.locale,
  };
}

// Format an amount using the business's country locale + currency.
function formatAmountForBusiness(business, amount) {
  const cfg = getCountryConfig(business?.country);
  const { symbol, locale } = cfg.currency;
  return `${symbol}${Number(amount || 0).toLocaleString(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
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
  getThresholds,
  formatAmountForBusiness,
};
