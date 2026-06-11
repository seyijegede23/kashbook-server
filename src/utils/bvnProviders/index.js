// BVN provider registry. Add a new provider by writing an adapter that
// exports `verifyBvn(bvn, { userId }) → Promise<{ ok, details } | { ok: false, error }>`
// and adding it to PROVIDERS below.

const dojah = require("./dojah");

const PROVIDERS = {
  dojah,
  // verifyme: require("./verifyme"),
  // prembly:  require("./prembly"),
};

function getBvnProvider(name) {
  const key = (name || process.env.KYC_PROVIDER || "dojah").toLowerCase();
  const provider = PROVIDERS[key];
  if (!provider) {
    throw new Error(`Unknown BVN provider: ${name}. Available: ${Object.keys(PROVIDERS).join(", ")}`);
  }
  return { name: key, ...provider };
}

module.exports = { getBvnProvider };
