// Probe Fincra virtual-account creation across currencies. Prints, per currency,
// whether issuance is instant (accountNumber synchronously) or async (pending +
// consent link) and the required-field errors USD surfaces.
//   node -r dotenv/config scripts/fincra-test-currency.js            (all)
//   node -r dotenv/config scripts/fincra-test-currency.js GHS        (one)
const fincra = require("../src/services/fincra");

const CASES = [
  { currency: "GHS", accountType: "individual", KYCInformation: { firstName: "Kwame", lastName: "Mensah", email: "t.gh@example.com" } },
  { currency: "KES", accountType: "individual", KYCInformation: { firstName: "John", lastName: "Otieno", email: "t.ke@example.com" } },
  { currency: "TZS", accountType: "individual", KYCInformation: { firstName: "Juma", lastName: "Ali", email: "t.tz@example.com" } },
  { currency: "USD", accountType: "individual", KYCInformation: { firstName: "Test", lastName: "Merchant", email: "t.usd@example.com" } },
];

const only = (process.argv[2] || "").toUpperCase();
const runList = only ? CASES.filter((c) => c.currency === only) : CASES;

(async () => {
  if (!fincra.isConfigured()) { console.error("Fincra not configured"); process.exit(1); }
  for (const c of runList) {
    const merchantReference = `kb_${c.currency}_${Date.now().toString().slice(-8)}`;
    const t0 = Date.now();
    try {
      const res = await fincra.createVirtualAccount({ ...c, merchantReference });
      const d = res?.data || res;
      const ms = Date.now() - t0;
      const acct = d?.accountNumber || d?.accountInformation?.accountNumber;
      const bank = d?.accountInformation?.bankName || d?.bankName;
      const consent = d?.consentUrl || d?.consentId || d?.consent?.url;
      console.log(`\n=== ${c.currency} (${ms}ms) — status: ${d?.status} ===`);
      if (acct) console.log(`  ✅ INSTANT — ${acct} (${bank})`);
      else console.log(`  ⏳ ASYNC/pending — accountNumber not yet present${consent ? ` — consent: ${consent}` : ""}`);
      console.log("  keys:", Object.keys(d || {}).join(", "));
    } catch (e) {
      console.log(`\n=== ${c.currency} — FAILED (${e.status || "?"}) ===`);
      console.log("  ", e.message);
      if (e.body) console.log("  body:", JSON.stringify(e.body).slice(0, 500));
    }
  }
  process.exit(0);
})();
