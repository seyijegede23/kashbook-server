// Provider selector. Reads business.country, looks up the country config,
// instantiates the right provider. Cheap to call repeatedly — providers
// hold no per-request state.
const { getCountryConfig } = require("../config/countries");
const AnchorProvider = require("./anchor");
const NullProvider = require("./null");

const PROVIDERS = {
  anchor: new AnchorProvider(),
  null:   new NullProvider(),
};

function getProvider(businessOrCountry) {
  const country =
    typeof businessOrCountry === "string"
      ? businessOrCountry
      : businessOrCountry?.country || "NG";
  const cfg = getCountryConfig(country);
  const key = cfg.paymentProvider || "null";
  return PROVIDERS[key] || PROVIDERS.null;
}

module.exports = { getProvider };
