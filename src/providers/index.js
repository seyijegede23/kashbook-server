// Provider selector. Reads business.country, looks up the country config,
// instantiates the right provider. Cheap to call repeatedly — providers
// hold no per-request state.
//
// Fincra came back on 2026-09-09, but ONLY as a foreign-currency provider:
// Fincra approved us to issue EUR virtual accounts to individual end users, and
// nothing else. The distinction is load-bearing, so it is enforced structurally
// rather than by convention:
//
//   - Fincra is registered here so getForeignAccountProvider() can find it.
//   - No country config names "fincra" as its paymentProvider (Nigeria/Anchor is
//     the only rail), so getProvider() CANNOT return it.
//   - The pooled-wallet sticky branch below was NOT restored, so a business can
//     never be routed to Fincra for its local account.
//   - executeTransfer's Fincra payout branch stays deleted, so there is no
//     caller that can push money out through Fincra.
//
// Net effect: EUR can be received, nothing can be sent. Re-adding a send path
// means deliberately restoring executeFincraPayout from the history below, not
// flipping a flag. History: branch backup/fincra-2026-08-27.
const { getCountryConfig } = require("../config/countries");
const AnchorProvider = require("./anchor");
const FincraProvider = require("./fincra");
const NullProvider = require("./null");

const PROVIDERS = {
  anchor: new AnchorProvider(),
  // FCY-only. Reachable via getForeignAccountProvider(), never via getProvider().
  fincra: new FincraProvider(),
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

// Provider for FOREIGN-CURRENCY (EUR) receive accounts.
//
// Deliberately NOT getProvider(). That one picks by country, and a Nigerian
// business resolves to Anchor, which does not issue foreign accounts at all —
// so routing FCY through it would tell every Nigerian merchant "not supported"
// when the capability exists.
//
// FCY is orthogonal to the local account: a merchant keeps their NGN NUBAN at
// Anchor and holds EUR at Fincra at the same time. Fincra is an additional
// provider for a different currency, not a replacement.
//
// Returns null when no configured provider can issue foreign accounts, so
// callers can answer "not available" without guessing.
function getForeignAccountProvider() {
  const p = PROVIDERS.fincra;
  return p && p.supportsForeignAccounts ? p : null;
}

module.exports = { getProvider, getForeignAccountProvider };
