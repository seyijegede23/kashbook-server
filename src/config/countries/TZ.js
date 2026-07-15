// Tanzania — Fincra TZS instant virtual account (Ecobank Tanzania). Create-KYC
// is name-only (Fincra rejects email/national-ID for TZS at create). NIDA number
// is collected for our records but not sent to Fincra at issuance.
module.exports = {
  code: "TZ",
  name: "Tanzania",
  flag: "🇹🇿",
  enabled: true,

  callingCode: "255",
  currency: { code: "TZS", symbol: "TSh", locale: "sw-TZ", subunit: 100 },
  vat: { rate: 18, label: "VAT" },
  language: "sw",
  timezone: "Africa/Dar_es_Salaam",

  kyc: {
    primaryIdType: "TZ_NID",
    primaryIdLabel: "National ID (NIDA)",
    primaryIdHelper: "20-digit NIDA National Identification Number",
    primaryIdRegex: "^\\d{20}$",
    primaryIdHint: "The NIN is printed on your NIDA National ID card.",
  },

  businessTypes: [
    { code: "sole_proprietorship", label: "Sole Proprietorship", regCode: "Business_Name" },
    { code: "limited_company",     label: "Limited Company",      regCode: "Private_Incorporated" },
  ],

  paymentProvider: "fincra",

  regionLabel: "Region",
  regions: require("./regions/TZ"),
  banks:   require("./banks/TZ"),

  // Provisional TZS AML thresholds (~PPP parity with the NG/KE tiers; TZS ≈ 2,600/USD
  // mid-2026). Retune in B9 against Tanzania FIU guidance.
  amlLimits: {
    soleProp: { daily: 1_500_000,  weekly: 7_500_000,   monthly: 15_000_000,  singleMax: 6_000_000 },
    limited:  { daily: 15_000_000, weekly: 75_000_000,  monthly: 150_000_000, singleMax: 6_000_000 },
    stepUpOtpAbove:          3_000_000,
    singleFlagAbove:         15_000_000,
    structuringSubThreshold: 13_500_000,
    offHoursMinAmount:        1_500_000,
  },

  regulators: ["BOT", "FIU"],
  primaryAct: "Anti-Money Laundering Act, 2006",

  smsProvider: "africas_talking",
};
