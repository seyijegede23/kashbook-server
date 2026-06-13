// Nigeria — the full-banking country. This is the reference config; all
// other countries mirror its shape with locally-correct values.
module.exports = {
  code: "NG",
  name: "Nigeria",
  flag: "🇳🇬",
  enabled: true,

  callingCode: "234",
  currency: { code: "NGN", symbol: "₦", locale: "en-NG", subunit: 100 },
  vat: { rate: 7.5, label: "VAT" },
  language: "en",
  timezone: "Africa/Lagos",

  kyc: {
    primaryIdType: "BVN",
    primaryIdLabel: "BVN",
    primaryIdHelper: "11-digit Bank Verification Number",
    primaryIdRegex: "^\\d{11}$",
    primaryIdHint: "Dial *565*0# on your registered phone to get your BVN.",
  },

  businessTypes: [
    { code: "sole_proprietorship", label: "Sole Proprietorship", regCode: "Business_Name" },
    { code: "limited_company",     label: "Limited Company",      regCode: "Private_Incorporated" },
  ],

  paymentProvider: "anchor",

  regionLabel: "State",
  regions: require("./regions/NG"),
  banks:   require("./banks/NG"),

  amlLimits: {
    soleProp: { daily: 500_000,   weekly: 2_500_000,  monthly: 5_000_000,  singleMax: 2_000_000 },
    limited:  { daily: 5_000_000, weekly: 25_000_000, monthly: 50_000_000, singleMax: 2_000_000 },
    stepUpOtpAbove:          1_000_000,
    singleFlagAbove:         5_000_000,
    structuringSubThreshold: 4_500_000,
    offHoursMinAmount:         500_000,
  },

  regulators: ["CBN", "NFIU"],
  primaryAct: "Money Laundering (Prevention and Prohibition) Act, 2022",

  smsProvider: "termii",
};
