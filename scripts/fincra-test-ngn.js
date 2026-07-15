// Prove Fincra NGN virtual-account issuance is INSTANT.
//
// Setup (server/.env): FINCRA_BASE_URL=https://sandboxapi.fincra.com,
//   FINCRA_SECRET_KEY=..., FINCRA_PUBLIC_KEY=... (sandbox keys), and optionally
//   FINCRA_BUSINESS_ID=... if your account requires a business id.
//
// Run:  node -r dotenv/config scripts/fincra-test-ngn.js [BVN]
//   BVN: a Fincra SANDBOX test BVN (see docs.fincra.com/docs/test-accounts-and-mobile-wallets)
//   or set FINCRA_TEST_BVN in .env. Falls back to a placeholder.
const fincra = require("../src/services/fincra");

const bvn = process.argv[2] || process.env.FINCRA_TEST_BVN || "22222222222";

(async () => {
  if (!fincra.isConfigured()) {
    console.error("✗ Fincra not configured — set FINCRA_SECRET_KEY + FINCRA_PUBLIC_KEY (sandbox) in server/.env");
    process.exit(1);
  }
  console.log("base:", fincra.BASE(), "| bvn:", bvn.slice(0, 3) + "****" + bvn.slice(-2));
  const t0 = Date.now();
  try {
    const res = await fincra.createNgnAccount({
      firstName: "Test",
      lastName: "Merchant",
      bvn,
      email: "test.merchant@example.com",
      merchantReference: `kashbook_test_${bvn.slice(-4)}`,
    });
    const ms = Date.now() - t0;
    const acct = res?.accountNumber || res?.data?.accountNumber || res?.accountInformation?.accountNumber || res?.data?.accountInformation?.accountNumber;
    const status = res?.status || res?.data?.status;
    const bank = res?.accountInformation?.bankName || res?.data?.accountInformation?.bankName;
    console.log(`\nround-trip: ${ms}ms | status: ${status}`);
    if (acct) {
      console.log(`✅ INSTANT — account number returned synchronously: ${acct} (${bank || "bank ?"})`);
    } else {
      console.log("⚠️ No accountNumber in the create response — NGN may be async on this account, or the field path differs. Full response below.");
    }
    console.log("\nfull response:\n", JSON.stringify(res, null, 2).slice(0, 3000));
  } catch (e) {
    console.error(`\n✗ create failed (${e.status || "?"}): ${e.message}`);
    if (e.body) console.error(JSON.stringify(e.body, null, 2).slice(0, 1500));
    process.exit(1);
  }
  process.exit(0);
})();
