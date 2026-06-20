// South Africa — bookkeeping-only in Stage 1.
module.exports = {
  code: "ZA",
  name: "South Africa",
  flag: "🇿🇦",
  enabled: true,

  callingCode: "27",
  currency: { code: "ZAR", symbol: "R", locale: "en-ZA", subunit: 100 },
  vat: { rate: 15, label: "VAT" },
  language: "en",
  timezone: "Africa/Johannesburg",

  kyc: {
    primaryIdType: "SA_ID",
    primaryIdLabel: "SA ID",
    primaryIdHelper: "13-digit South African ID number",
    primaryIdRegex: "^\\d{13}$",
    primaryIdHint: "Enter the 13-digit ID printed in your green ID book or smart card.",
  },

  businessTypes: [
    { code: "sole_proprietorship", label: "Sole Proprietorship", regCode: "Business_Name" },
    { code: "limited_company",     label: "Private Company (Pty Ltd)", regCode: "Private_Incorporated" },
  ],

  paymentProvider: null,

  regionLabel: "Province",
  regions: require("./regions/ZA"),
  banks:   require("./banks/ZA"),

  amlLimits: {
    soleProp: { daily: 8_000,   weekly: 40_000,  monthly: 80_000,  singleMax: 32_000 },
    limited:  { daily: 80_000,  weekly: 400_000, monthly: 800_000, singleMax: 32_000 },
    stepUpOtpAbove:          16_000,
    singleFlagAbove:         80_000,
    structuringSubThreshold: 72_000,
    offHoursMinAmount:        8_000,
  },

  regulators: ["SARB", "FIC"],
  primaryAct: "Financial Intelligence Centre Act, 2001 (FICA)",

  smsProvider: "africas_talking",
};
