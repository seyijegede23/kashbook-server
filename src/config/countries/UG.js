// Uganda — bookkeeping-only in Stage 1.
module.exports = {
  code: "UG",
  name: "Uganda",
  flag: "🇺🇬",
  // OFF at signup: Uganda has no local rail (Fincra issues local virtual
  // accounts for NGN/GHS/KES/TZS only) AND sits on Fincra's FCY
  // restricted-country list, so there is no account of any kind we can open for
  // a Ugandan merchant. Bookkeeping alone is not enough to offer.
  // The config stays so an existing account would still resolve its currency,
  // banks and regions; flip back to true if a UGX provider is ever added.
  enabled: false,

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

  // Deliberately OFF, not an oversight. Fincra issues local virtual accounts for
  // NGN, GHS, KES and TZS only. UGX is a PAYOUT and cross-currency collection
  // currency, so a Ugandan merchant cannot be given an account to receive into.
  // Uganda is also on Fincra's FCY restricted-country list, so no USD/EUR/GBP
  // account either. Do not flip this on without a provider that issues UGX.
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
