// CAC provider registry. Mirrors bvnProviders/index.js.

const dojah = require("./dojah");

const PROVIDERS = {
  dojah,
};

function getCacProvider(name) {
  const key = (name || process.env.KYC_PROVIDER || "dojah").toLowerCase();
  const provider = PROVIDERS[key];
  if (!provider) {
    throw new Error(`Unknown CAC provider: ${name}. Available: ${Object.keys(PROVIDERS).join(", ")}`);
  }
  return { name: key, ...provider };
}

module.exports = { getCacProvider };
