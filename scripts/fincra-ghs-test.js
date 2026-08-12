// Open a GHANA (GHS) local virtual account against Fincra SANDBOX.
//
// Local accounts are instant and NOT consent-gated, unlike the FCY (USD/EUR/GBP)
// flow: the account number comes back on the create response itself.
//
// Safety: refuses to run against the live host. Nothing is written to our DB —
// this exercises the provider path only, so it can be run repeatedly.
//
//   node -r dotenv/config scripts/fincra-ghs-test.js
//   node -r dotenv/config scripts/fincra-ghs-test.js --currency KES

require("dotenv").config();

const args = process.argv.slice(2);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const currency = String(val("--currency", "GHS")).toUpperCase();

const base = process.env.FINCRA_BASE_URL || "";
if (!/sandbox/i.test(base)) {
  console.error(`\n✖ Refusing to run: FINCRA_BASE_URL is not a sandbox host (${base || "unset"}).\n`);
  process.exit(1);
}

const fincra = require("../src/services/fincra");
const FincraProvider = require("../src/providers/fincra");

// A distinct reference per run so repeat runs never collide on Fincra's side.
const stamp = `${Date.now().toString(36)}`;

const PROFILE = {
  GHS: { firstName: "Kwame", lastName: "Mensah", email: `kwame.${stamp}@example.com`, phone: "+233201234567" },
  KES: { firstName: "Amani", lastName: "Otieno", email: `amani.${stamp}@example.com`, phone: "+254700000000" },
  TZS: { firstName: "Neema", lastName: "Juma", email: `neema.${stamp}@example.com`, phone: "+255780000000" },
  NGN: { firstName: "Chidi", lastName: "Okafor", email: `chidi.${stamp}@example.com`, phone: "+2348130000000", bvn: "22222222222" },
}[currency];

if (!PROFILE) {
  console.error(`✖ No test profile for ${currency}. Local accounts exist for NGN, GHS, KES, TZS.`);
  process.exit(1);
}

(async () => {
  console.log(`environment : ${base}`);
  console.log(`currency    : ${currency}`);
  console.log(`customer    : ${PROFILE.firstName} ${PROFILE.lastName} <${PROFILE.email}>`);
  console.log(`reference   : kb_test_${stamp}\n`);

  const provider = new FincraProvider();

  // 1. Does the provider consider itself configured?
  console.log(`configured  : ${fincra.isConfigured()}`);

  // 2. Create the account through the SAME provider method the app uses, so this
  //    tests our real code path rather than a hand-rolled request.
  let result;
  try {
    // NOTE the shape: identity goes in a nested `kyc` object, not flat args.
    // Passing them flat leaves kyc undefined, and the GHS guard then correctly
    // reports a missing email for a request that did supply one.
    result = await provider.provisionLocalAccount({
      currency,
      accountType: "individual",
      kyc: {
        firstName: PROFILE.firstName,
        lastName: PROFILE.lastName,
        email: PROFILE.email,
        bvn: PROFILE.bvn,
      },
      merchantReference: `kb_test_${stamp}`,
    });
  } catch (err) {
    console.error(`\n✖ provisionLocalAccount failed: ${err.message}`);
    if (err.code) console.error(`   code: ${err.code}`);
    if (err.body) console.error(`   body: ${JSON.stringify(err.body).slice(0, 600)}`);
    process.exit(1);
  }

  console.log("\n─── result ─────────────────────────────────────");
  console.log(JSON.stringify(result, null, 2));

  const ok = !!(result.accountNumber && result.bankName);
  console.log("\n" + (ok
    ? `✔ ACCOUNT ISSUED — ${result.accountNumber} at ${result.bankName}`
    : `⚠ no account number on the response (status ${result.status || "?"}) — local accounts should be instant`));

  // 3. Read it back, proving the account really exists on Fincra's side rather
  //    than just that the create call returned 200.
  if (result.providerRef) {
    try {
      const fetched = await fincra.getVirtualAccount(result.providerRef);
      const d = fetched?.data || {};
      console.log(`\nread-back   : status=${d.status || "?"} accountNumber=${d.accountNumber || "?"} currency=${d.currency || "?"}`);
    } catch (e) {
      console.log(`\nread-back   : failed (${e.message})`);
    }
  }
  process.exit(ok ? 0 : 2);
})().catch((e) => { console.error("\n✖", e.message); process.exit(1); });
