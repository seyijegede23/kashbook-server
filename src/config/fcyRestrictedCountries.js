// Countries Fincra will not open a foreign-currency (USD/EUR/GBP) account for.
//
// Transcribed verbatim from Fincra's "FCY prohibited activities and countries"
// page (docs.fincra.com, read 2026-08-09) and recorded in
// docs/FINCRA_INTEGRATION_REFERENCE.md §1.8.
//
// WHY THIS EXISTS: without it we would let a merchant complete a full KYC form,
// upload a passport and a utility bill, consume a provider request slot, and
// only then be declined for something we could have told them up front.
//
// NOTE the inconsistency inside Fincra's own product: Uganda, Senegal and
// Burkina Faso are restricted for FCY while Fincra's payouts product happily
// supports UGX and XOF to those same countries. So "Fincra supports Uganda" is
// true for sending and false for foreign-currency receiving.
const FCY_RESTRICTED = new Set([
  "AF", // Afghanistan
  "AL", // Albania
  "AS", // American Samoa
  "AI", // Anguilla
  "AG", // Antigua and Barbuda
  "AW", // Aruba
  "BS", // Bahamas
  "BB", // Barbados
  "BY", // Belarus
  "BM", // Bermuda
  "BF", // Burkina Faso
  "BI", // Burundi
  "KH", // Cambodia
  "KY", // Cayman Islands
  "CF", // Central African Republic
  "CG", // Congo
  "CK", // Cook Islands
  "CU", // Cuba
  "CW", // Curacao
  "CD", // Democratic Republic of the Congo
  "DM", // Dominica
  "FJ", // Fiji
  "GU", // Guam
  "GN", // Guinea
  "GW", // Guinea-Bissau
  "HT", // Haiti
  "IR", // Iran
  "IQ", // Iraq
  "JM", // Jamaica
  "JO", // Jordan
  "KP", // North Korea
  "LY", // Libya
  "ML", // Mali
  "MH", // Marshall Islands
  "MA", // Morocco
  "MM", // Myanmar
  "NI", // Nicaragua
  "PK", // Pakistan
  "PW", // Palau
  "PS", // Palestine
  "PA", // Panama
  "PH", // Philippines
  "RU", // Russian Federation
  "KN", // Saint Kitts and Nevis
  "LC", // Saint Lucia
  "VC", // Saint Vincent and the Grenadines
  "WS", // Samoa
  "SN", // Senegal
  "SC", // Seychelles
  "SO", // Somalia
  "SS", // South Sudan
  "SD", // Sudan
  "SY", // Syrian Arab Republic
  "TT", // Trinidad and Tobago
  "TC", // Turks and Caicos Islands
  "UG", // Uganda  ← in OUR country list, so this one actually bites
  "VU", // Vanuatu
  "VE", // Venezuela
  "VG", // Virgin Islands (British)
  "VI", // Virgin Islands (U.S.)
  "YE", // Yemen
]);

// Business categories Fincra refuses outright for FCY. Kept alongside the
// country list because a merchant is blocked by either one.
const FCY_PROHIBITED_ACTIVITIES = [
  "Payment services or crypto exchange",
  "Charities and NGOs",
  "Trusts and similar arrangements",
  "Multi-level marketing",
  "Forex",
  "Cannabis or CBD",
  "Unlicensed casinos or gambling",
  "Shell companies",
  "Crowdfunding, ICOs, IEOs, STOs",
  "Anonymous accounts",
  "Cash-based businesses",
  "Companies registered in offshore business centres or tax havens",
  "Pharmacy or food supplements",
  "Arms trade",
];

function isFcyRestricted(country) {
  return FCY_RESTRICTED.has(String(country || "").trim().toUpperCase().slice(0, 2));
}

module.exports = { FCY_RESTRICTED, FCY_PROHIBITED_ACTIVITIES, isFcyRestricted };
