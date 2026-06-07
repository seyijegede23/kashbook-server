// Kenya — bookkeeping-only in Stage 1.
module.exports = {
  code: "KE",
  name: "Kenya",
  flag: "🇰🇪",
  enabled: true,

  callingCode: "254",
  currency: { code: "KES", symbol: "KSh", locale: "en-KE", subunit: 100 },
  language: "sw",
  timezone: "Africa/Nairobi",

  kyc: {
    primaryIdType: "KE_NID",
    primaryIdLabel: "National ID",
    primaryIdHelper: "8-digit Huduma Number / National ID",
    primaryIdRegex: "^\\d{8}$",
    primaryIdHint: "Enter the number printed on your Kenyan National ID card.",
  },

  businessTypes: [
    { code: "sole_proprietorship", label: "Sole Proprietorship", regCode: "Business_Name" },
    { code: "limited_company",     label: "Limited Company",      regCode: "Private_Incorporated" },
  ],

  paymentProvider: null,

  regionLabel: "County",
  regions: require("./regions/KE"),
  banks:   require("./banks/KE"),

  amlLimits: {
    soleProp: { daily: 60_000,   weekly: 300_000,    monthly: 600_000,    singleMax: 250_000 },
    limited:  { daily: 600_000,  weekly: 3_000_000,  monthly: 6_000_000,  singleMax: 250_000 },
    stepUpOtpAbove:          120_000,
    singleFlagAbove:         600_000,
    structuringSubThreshold: 540_000,
    offHoursMinAmount:        60_000,
  },

  regulators: ["CBK", "FRC"],
  primaryAct: "Proceeds of Crime and Anti-Money Laundering Act, 2009",

  smsProvider: "africas_talking",
};
