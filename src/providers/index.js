// Provider selector. Reads business.country, looks up the country config,
// instantiates the right provider. Cheap to call repeatedly — providers
// hold no per-request state.
const { getCountryConfig } = require("../config/countries");
const AnchorProvider = require("./anchor");
const FincraProvider = require("./fincra");
const NullProvider = require("./null");

const PROVIDERS = {
  anchor: new AnchorProvider(),
  fincra: new FincraProvider(),
  null:   new NullProvider(),
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
    // provider that issued it, regardless of the country config — its funds and
    // NUBAN live there until explicitly migrated. Fincra is now the only pooled
    // provider (Korapay was removed Aug 2026 with zero accounts and zero
    // transactions). If a second pooled provider is ever added, persist an
    // explicit provider key on Business rather than inferring from ref shape.
    if (b.providerAccountId && !b.anchorAccountId) return PROVIDERS.fincra;
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
