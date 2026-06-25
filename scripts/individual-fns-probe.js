// Exercises the REAL anchor.js wrapper functions (createIndividualCustomer →
// triggerIndividualKyc → getCustomerStatus → createDepositAccount → createVirtualNuban)
// end-to-end on sandbox, so we know the SHIPPED code — not just raw API shapes —
// works before the individual-KYC flow goes live on the money path.
//
// Run in the env with valid SANDBOX Anchor creds (Render Shell):
//   node scripts/individual-fns-probe.js
//
// No DB, no money. Creates throwaway sandbox records.

const anchor = require("../src/utils/anchor");

(async () => {
  const base = process.env.ANCHOR_BASE_URL || "";
  if (!/sandbox/.test(base)) { console.error(`Refusing: not sandbox (${base})`); process.exit(1); }
  const stamp = Date.now();
  const bizName = "KASHBOOK FN PROBE BIZ";

  console.log("1) createIndividualCustomer()…");
  const c = await anchor.createIndividualCustomer({
    user: { firstName: "Test", lastName: "Owner", email: `kbfn+${stamp}@kashbook.app`, phone: "08000000000" },
    address: { state: "Lagos", addressLine_1: "1 Marina Street", city: "Lagos Island", postalCode: "100001" },
  });
  console.log("   ✓ customerId:", c.customerId, "(suffix-detect:", /-anc_ind_cst$/.test(c.customerId) ? "individual ✓)" : "NOT individual ✗)");

  console.log("2) triggerIndividualKyc()  (gender passed lowercase 'male' to test normalization)…");
  await anchor.triggerIndividualKyc(c.customerId, { bvn: "22222222222", dateOfBirth: "1990-01-01", gender: "male" });
  console.log("   ✓ KYC triggered");

  console.log("3) getCustomerStatus()  polling…");
  let approved = false;
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 4000));
    const s = await anchor.getCustomerStatus(c.customerId);
    console.log(`   [${i + 1}] status=${s.status} type=${s.type}`);
    if (/approved|verified/i.test(s.status)) { approved = true; break; }
    if (/reject|error|declined/i.test(s.status)) break;
  }
  if (!approved) { console.error("   ✗ KYC not approved in time"); process.exit(1); }

  console.log("4) createDepositAccount(SAVINGS, IndividualCustomer)…");
  const acc = await anchor.createDepositAccount({ customerId: c.customerId, customerType: "IndividualCustomer", productName: "SAVINGS" });
  console.log("   ✓ depositAccountId:", acc.accountId, "name:", acc.accountName);

  console.log(`5) createVirtualNuban(name="${bizName}")…`);
  const nuban = await anchor.createVirtualNuban({ settlementAccountId: acc.accountId, name: bizName, bvn: "22222222222", reference: "kbfn-" + stamp });
  console.log("   ✓ NUBAN:", nuban.accountNumber, "@", nuban.bankName, "name:", JSON.stringify(nuban.accountName));

  console.log("\n────────── VERDICT ──────────");
  console.log(nuban.accountName === bizName
    ? "✅ Shipped wrapper functions work end-to-end. Business name on the NUBAN, gender normalized, suffix detection correct."
    : `⚠️ accountName came back ${JSON.stringify(nuban.accountName)} (expected "${bizName}")`);
  process.exit(0);
})().catch((e) => {
  console.error("\n✗ ERROR:", e.message, e.anchorErrors ? JSON.stringify(e.anchorErrors) : "");
  process.exit(1);
});
