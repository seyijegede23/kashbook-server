// Provider selector. Reads business.country, looks up the country config,
// instantiates the right provider. Cheap to call repeatedly — providers
// hold no per-request state.
//
// Fincra was removed on 2026-08-27 along with the whole foreign-currency
// feature. It had zero accounts and zero ledger entries, so nothing had to be
// migrated. Ghana, Kenya and Tanzania consequently have no payment provider and
// resolve to NullProvider — they keep bookkeeping and lose account issuance,
// which is what `paymentProvider: null` already meant for Uganda, South Africa
// and Egypt. Anchor (Nigeria) is untouched and remains the only live rail.
// History is on branch backup/fincra-2026-08-27.
const { getCountryConfig } = require("../config/countries");
const AnchorProvider = require("./anchor");
const NullProvider = require("./null");

const PROVIDERS = {
  anchor: new AnchorProvider(),
  null:   new NullProvider(),
};

function getProvider(businessOrCountry) {
  // Sticky provisioning: a business that already has an Anchor account stays on
  // Anchor even if its country config changes — its funds and NUBAN live there
  // until explicitly migrated.
  if (businessOrCountry && typeof businessOrCountry === "object") {
    const b = businessOrCountry;
    if (b.anchorAccountId) return PROVIDERS.anchor;
    // `providerAccountId` without an Anchor account used to mean a pooled
    // provider. No such business exists (verified zero before removal), so the
    // branch is gone rather than left pointing at nothing. If a pooled provider
    // is ever reintroduced, persist an explicit provider key on Business rather
    // than inferring one from the shape of a reference.
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
