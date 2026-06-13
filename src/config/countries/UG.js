// Uganda — bookkeeping-only in Stage 1.
module.exports = {
  code: "UG",
  name: "Uganda",
  flag: "🇺🇬",
  enabled: true,

  callingCode: "256",
  currency: { code: "UGX", symbol: "USh", locale: "en-UG", subunit: 100 },
  vat: { rate: 18, label: "VAT" },
  language: "en",
  timezone: "Africa/Kampala",

  kyc: {
    primaryIdType: "UG_NIN",
    primaryIdLabel: "NIN",
    primaryIdHelper: "14-character National Identification Number",
    primaryIdRegex: "^[A-Z0-9]{14}$",
    primaryIdHint: "The NIN is printed on your Ugandan National ID card.",
  },

  businessTypes: [
    { code: "sole_proprietorship", label: "Sole Proprietorship", regCode: "Business_Name" },
    { code: "limited_company",     label: "Limited Company",      regCode: "Private_Incorporated" },
  ],

  paymentProvider: null,

  regionLabel: "Region",
  regions: require("./regions/UG"),
  banks:   require("./banks/UG"),

  amlLimits: {
    soleProp: { daily: 1_500_000,  weekly: 7_500_000,   monthly: 15_000_000,   singleMax: 6_000_000 },
    limited:  { daily: 15_000_000, weekly: 75_000_000,  monthly: 150_000_000,  singleMax: 6_000_000 },
    stepUpOtpAbove:          3_000_000,
    singleFlagAbove:         15_000_000,
    structuringSubThreshold: 13_500_000,
    offHoursMinAmount:        1_500_000,
  },

  regulators: ["BoU", "FIA"],
  primaryAct: "Anti-Money Laundering Act, 2013",

  smsProvider: "africas_talking",
};
