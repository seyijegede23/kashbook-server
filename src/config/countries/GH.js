// Ghana — bookkeeping-only in Stage 1. AML thresholds in GHS, rough purchasing-power
// parity with NG's NGN limits (1 NGN ≈ 0.0125 GHS as of mid-2026; rounded).
module.exports = {
  code: "GH",
  name: "Ghana",
  flag: "🇬🇭",
  enabled: true,

  callingCode: "233",
  currency: { code: "GHS", symbol: "₵", locale: "en-GH", subunit: 100 },
  vat: { rate: 15, label: "VAT" },
  language: "en",
  timezone: "Africa/Accra",

  kyc: {
    primaryIdType: "GhanaCard",
    primaryIdLabel: "Ghana Card",
    primaryIdHelper: "13-character Ghana Card PIN (GHA-XXXXXXXXX-X)",
    primaryIdRegex: "^GHA-\\d{9}-\\d$",
    primaryIdHint: "Find your Ghana Card PIN on the back of the card.",
  },

  businessTypes: [
    { code: "sole_proprietorship", label: "Sole Proprietorship", regCode: "Business_Name" },
    { code: "limited_company",     label: "Limited Liability Company", regCode: "Private_Incorporated" },
  ],

  paymentProvider: "fincra", // Fincra GHS instant VA (First Bank Ghana). Create-KYC: name + email.

  regionLabel: "Region",
  regions: require("./regions/GH"),
  banks:   require("./banks/GH"),

  amlLimits: {
    soleProp: { daily: 6_000,   weekly: 30_000,  monthly: 60_000,  singleMax: 25_000 },
    limited:  { daily: 60_000,  weekly: 300_000, monthly: 600_000, singleMax: 25_000 },
    stepUpOtpAbove:          12_000,
    singleFlagAbove:         60_000,
    structuringSubThreshold: 55_000,
    offHoursMinAmount:        6_000,
  },

  regulators: ["BoG", "FIC"],
  primaryAct: "Anti-Money Laundering Act, 2020 (Act 1044)",

  smsProvider: "africas_talking",
};
