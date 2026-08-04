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

  paymentProvider: "anchor", // Nigeria runs on Anchor.

  regionLabel: "State",
  regions: require("./regions/NG"),
  banks:   require("./banks/NG"),

  // KashBook's OWN policy caps. These are the AML/CFT control and deliberately
  // sit UNDER Anchor's hard rail limits, which are per deposit account and
  // verified live (2026-08-03) as:
  //     NIP  — single ₦5,000,000 · daily ₦10,000,000
  //     Book — single ₦5,000,000 · daily ₦100,000,000
  // Anchor is the ceiling we can never exceed; these are the tighter business
  // rules we enforce first, so a breach is refused by us (with a ComplianceFlag)
  // rather than bouncing off the rail with no monitoring record.
  //
  // Raised 2026-08-03 (owner decision): the previous sole-prop caps
  // (₦500k daily / ₦2m single) were far below both Anchor's rail and real
  // merchant volume — a trader doing ₦600k of payouts in a day was blocked.
  // Now: sole-prop ₦2m daily / ₦1m single, which still leaves 5× daily headroom
  // under Anchor and keeps every transfer inside the monitored path.
  amlLimits: {
    soleProp: { daily: 2_000_000,  weekly: 10_000_000, monthly: 30_000_000,  singleMax: 1_000_000 },
    limited:  { daily: 8_000_000,  weekly: 40_000_000, monthly: 120_000_000, singleMax: 4_000_000 },
    stepUpOtpAbove:          500_000,   // OTP step-up on larger transfers
    singleFlagAbove:         5_000_000, // CTR-style review flag
    structuringSubThreshold: 4_500_000,
    offHoursMinAmount:         500_000,
  },

  regulators: ["CBN", "NFIU"],
  primaryAct: "Money Laundering (Prevention and Prohibition) Act, 2022",

  smsProvider: "sendchamp", // Nigerian SMS/OTP provider; Termii + Africa's Talking adapters remain available
};
