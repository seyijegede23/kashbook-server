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

function listEnabledCountries() {
  return Object.values(COUNTRIES).filter((c) => c.enabled);
}

function isSupported(code) {
  if (!code) return false;
  const c = COUNTRIES[String(code).toUpperCase()];
  return !!(c && c.enabled);
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
  getBaseCurrency,
  getCallingCode,
};
