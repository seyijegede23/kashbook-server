// Address provider registry. Today Google is the only backing provider.

const google = require("./google");

const PROVIDERS = {
  google,
};

function getAddressProvider(name) {
  const key = (name || process.env.KYC_ADDRESS_PROVIDER || "google").toLowerCase();
  const provider = PROVIDERS[key];
  if (!provider) {
    throw new Error(`Unknown address provider: ${name}. Available: ${Object.keys(PROVIDERS).join(", ")}`);
  }
  return { name: key, ...provider };
}

module.exports = { getAddressProvider };
