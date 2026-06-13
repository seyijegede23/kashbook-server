// Egypt — bookkeeping-only in Stage 1. Arabic-default; RTL.
module.exports = {
  code: "EG",
  name: "Egypt",
  flag: "🇪🇬",
  enabled: true,

  callingCode: "20",
  currency: { code: "EGP", symbol: "ج.م", locale: "ar-EG", subunit: 100 },
  vat: { rate: 14, label: "VAT" },
  language: "ar",
  timezone: "Africa/Cairo",

  kyc: {
    primaryIdType: "EG_NID",
    primaryIdLabel: "National ID",
    primaryIdHelper: "14-digit Egyptian National ID number",
    primaryIdRegex: "^\\d{14}$",
    primaryIdHint: "Enter the 14-digit National ID number from your national card.",
  },

  businessTypes: [
    { code: "sole_proprietorship", label: "Sole Proprietorship", regCode: "Business_Name" },
    { code: "limited_company",     label: "Limited Liability Company", regCode: "Private_Incorporated" },
  ],

  paymentProvider: null,

  regionLabel: "Governorate",
  regions: require("./regions/EG"),
  banks:   require("./banks/EG"),

  amlLimits: {
    soleProp: { daily: 20_000,  weekly: 100_000,   monthly: 200_000,   singleMax: 80_000 },
    limited:  { daily: 200_000, weekly: 1_000_000, monthly: 2_000_000, singleMax: 80_000 },
    stepUpOtpAbove:          40_000,
    singleFlagAbove:         200_000,
    structuringSubThreshold: 180_000,
    offHoursMinAmount:        20_000,
  },

  regulators: ["CBE", "EMLCU"],
  primaryAct: "Anti-Money Laundering Law No. 80 of 2002 (as amended)",

  smsProvider: "aws_sns",
};
