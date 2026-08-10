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

// Provider for FOREIGN-CURRENCY (USD/EUR/GBP) receive accounts.
//
// Deliberately NOT getProvider(). That one picks by country, and a Nigerian
// business resolves to Anchor, which does not issue foreign accounts at all —
// so routing FCY through it would tell every Nigerian merchant "not supported"
// when the capability exists.
//
// FCY is orthogonal to the local account: a merchant keeps their NGN NUBAN at
// Anchor and holds USD/EUR/GBP at Fincra at the same time. Fincra is an
// additional provider for a different currency, not a replacement.
//
// Returns null when no configured provider can issue foreign accounts, so
// callers can answer "not available" without guessing.
function getForeignAccountProvider() {
  const p = PROVIDERS.fincra;
  return p && p.supportsForeignAccounts ? p : null;
}

module.exports = { getProvider, getForeignAccountProvider };
