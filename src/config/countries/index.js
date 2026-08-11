// Country registry. Adding a country = adding a file + one line below.
// `getCountryConfig` always returns NG as a safe fallback so existing code
// never sees `undefined` — but `enabled` should be checked at the route
// level to decide whether to surface the country in pickers.

const COUNTRIES = {
  NG: require("./NG"),
  GH: require("./GH"),
  KE: require("./KE"),
  TZ: require("./TZ"),
  ZA: require("./ZA"),
  EG: require("./EG"),
  UG: require("./UG"),
};

const DEFAULT_COUNTRY = "NG";

function getCountryConfig(code) {
  if (!code) return COUNTRIES[DEFAULT_COUNTRY];
  return COUNTRIES[String(code).toUpperCase()] || COUNTRIES[DEFAULT_COUNTRY];
}

// THREE DIFFERENT QUESTIONS, deliberately not collapsed into one flag:
//
//   1. isSupported            — can they use KashBook at all? (sign up, keep books)
//   2. supportsLocalAccount   — can we issue a LOCAL-currency receiving account?
//                               NG via Anchor; GH/KE/TZ via Fincra. Fincra issues
//                               local virtual accounts for NGN/GHS/KES/TZS only,
//                               so ZA/EG/UG have no local rail.
//   3. FCY (USD/EUR/GBP)      — provider-agnostic, gated instead by Fincra's
//                               restricted-country list (see config/fcyRestrictedCountries.js).
//
// Collapsing 1 and 2 is what previously locked South Africa and Egypt out of
// signup entirely, when in fact they can keep books and receive foreign currency
// perfectly well; they simply have no local account.
const isEnabled = (c) => !!c && c.enabled !== false;

function listEnabledCountries() {
  return Object.values(COUNTRIES).filter(isEnabled);
}

function isSupported(code) {
  if (!code) return false;
  return isEnabled(COUNTRIES[String(code).toUpperCase()]);
}

// Can we provision a local-currency receiving account for this country?
function supportsLocalAccount(code) {
  const c = COUNTRIES[String(code || "").toUpperCase()];
  return !!(isEnabled(c) && c.paymentProvider);
}

// Countries where we can issue a local account. Useful for admin/reporting.
function listLocalAccountCountries() {
  return Object.values(COUNTRIES).filter((c) => isEnabled(c) && c.paymentProvider);
}

function getBaseCurrency(code) {
  return getCountryConfig(code).currency.code;
}

function getCallingCode(code) {
  return getCountryConfig(code).callingCode;
}

module.exports = {
  COUNTRIES,
  DEFAULT_COUNTRY,
  getCountryConfig,
  listEnabledCountries,
  isSupported,
  supportsLocalAccount,
  listLocalAccountCountries,
  getBaseCurrency,
  getCallingCode,
};
