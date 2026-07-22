// Provider selector. Reads business.country, looks up the country config,
// instantiates the right provider. Cheap to call repeatedly — providers
// hold no per-request state.
const { getCountryConfig } = require("../config/countries");
const AnchorProvider = require("./anchor");
const FincraProvider = require("./fincra");
const KorapayProvider = require("./korapay");
const NullProvider = require("./null");

const PROVIDERS = {
  anchor:  new AnchorProvider(),
  fincra:  new FincraProvider(),
  korapay: new KorapayProvider(),
  null:    new NullProvider(),
};

function getProvider(businessOrCountry) {
  // Sticky provisioning: a business that already has an Anchor account (and no
  // unified-provider account) stays on Anchor even after its country config flips
  // to Fincra — its funds + NUBAN live at Anchor until explicitly migrated. New
  // businesses (providerAccountId set, or none yet) follow the country config.
  if (businessOrCountry && typeof businessOrCountry === "object") {
    const b = businessOrCountry;
    if (b.anchorAccountId && !b.providerAccountId) return PROVIDERS.anchor;
    // Symmetric stickiness for POOLED providers: a business that already holds a
    // pooled account (providerAccountId set, no Anchor account) stays on the
    // provider that ISSUED it, regardless of the country config. Without this a
    // config rollback (e.g. NG korapay→anchor) would misroute a live Korapay
    // account's money path to Anchor. Korapay account refs are "KPY-*"; Fincra refs
    // are Mongo ids. (Add a persisted provider key on Business if a 3rd pooled
    // provider is ever introduced — ref-shape disambiguation won't scale past two.)
    if (b.providerAccountId && !b.anchorAccountId) {
      return /^KPY/i.test(b.providerAccountId) ? PROVIDERS.korapay : PROVIDERS.fincra;
    }
  }
  const country =
    typeof businessOrCountry === "string"
      ? businessOrCountry
      : businessOrCountry?.country || "NG";
  const cfg = getCountryConfig(country);
  const key = cfg.paymentProvider || "null";
  return PROVIDERS[key] || PROVIDERS.null;
}

module.exports = { getProvider };
