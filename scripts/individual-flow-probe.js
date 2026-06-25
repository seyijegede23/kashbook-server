// END-TO-END sandbox probe for "individual KYC + business-named virtual account".
//
// Runs the WHOLE cheap-onboarding flow against Anchor sandbox so we can:
//   1. confirm individual (Tier-2 BVN) KYC + SAVINGS deposit + a business-named
//      virtual NUBAN actually works start-to-finish, and
//   2. answer the key design question: does the virtual-NUBAN call still need a
//      BVN re-supplied when the settlement account is an INDIVIDUAL already
//      BVN-verified? (We try WITHOUT bvn first; only retry WITH bvn if Anchor
//      complains.) The answer decides whether we must store the raw BVN.
//
// Run in the env with valid SANDBOX Anchor creds (Render Shell):
//   node scripts/individual-flow-probe.js [bvn] [bizName]
//
// Creates throwaway sandbox records only. Moves no money.

const BASE = process.env.ANCHOR_BASE_URL;
const KEY = process.env.ANCHOR_API_KEY;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(path, { method = "GET", body } = {}) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { "x-anchor-key": KEY, "Content-Type": "application/json", Accept: "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let j; try { j = text ? JSON.parse(text) : {}; } catch { j = { raw: text }; }
  return { status: r.status, ok: r.ok, j };
}
function detail(j) { return j?.errors?.[0]?.detail || j?.errors?.[0]?.title || JSON.stringify(j).slice(0, 300); }

(async () => {
  if (!BASE || !KEY) { console.error("ANCHOR_BASE_URL / ANCHOR_API_KEY not set"); process.exit(1); }
  if (!/sandbox/.test(BASE)) { console.error(`Refusing to run: BASE is not sandbox (${BASE})`); process.exit(1); }

  const bvn = process.argv[2] || "22222222222";          // Anchor sandbox test BVN
  const bizName = process.argv[3] || "KASHBOOK TEST BIZ"; // the name we want on the NUBAN
  const stamp = Date.now();
  const addr = { country: "NG", state: "Lagos", addressLine_1: "1 Marina Street", city: "Lagos Island", postalCode: "100001" };

  console.log(`BASE ${BASE}`);
  console.log(`bvn=${bvn}  bizName="${bizName}"\n`);

  // ── 1. Create IndividualCustomer (Tier 0: name/email/phone/address) ──────────
  console.log("1) POST /customers (IndividualCustomer)…");
  let r = await call("/customers", { method: "POST", body: {
    data: { type: "IndividualCustomer", attributes: {
      fullName: { firstName: "Test", lastName: "Owner" },
      email: `kbprobe+${stamp}@kashbook.app`,
      phoneNumber: "08000000000",
      address: addr,
    } },
  }});
  if (!r.ok) { console.error("   ✗", r.status, detail(r.j)); process.exit(1); }
  const customerId = r.j.data?.id;
  console.log("   ✓ customerId:", customerId);

  // ── 2. Trigger Tier-2 (BVN) KYC ──────────────────────────────────────────────
  console.log("2) POST /customers/{id}/verification/individual (TIER_2 / BVN)…");
  r = await call(`/customers/${customerId}/verification/individual`, { method: "POST", body: {
    data: { type: "Verification", attributes: { level: "TIER_2", level2: { bvn, dateOfBirth: "1990-01-01", gender: "Male" } } },
  }});
  console.log(`   ${r.ok ? "✓" : "✗"} ${r.status} ${r.ok ? JSON.stringify(r.j.data?.attributes?.status || r.j.data?.attributes || {}).slice(0,200) : detail(r.j)}`);

  // ── 3. Poll for approval (sandbox BVN KYC is usually quick) ──────────────────
  console.log("3) polling customer verification status…");
  let approved = false;
  for (let i = 0; i < 10; i++) {
    await sleep(4000);
    const c = await call(`/customers/${customerId}`);
    const st = c.j.data?.attributes?.verification?.status || c.j.data?.attributes?.status || "?";
    console.log(`   [${i + 1}] status=${st}`);
    if (/approved|verified/i.test(st)) { approved = true; break; }
    if (/rejected|error|declined/i.test(st)) { console.error("   ✗ KYC not approved:", st); break; }
  }
  if (!approved) { console.error("\n   ⚠ KYC didn't reach approved in time — try a different sandbox BVN, or check the dashboard."); process.exit(1); }

  // ── 4. Open a SAVINGS deposit account (the settlement account) ───────────────
  console.log("4) POST /accounts (SAVINGS, IndividualCustomer)…");
  r = await call("/accounts", { method: "POST", body: {
    data: { type: "DepositAccount", attributes: { productName: "SAVINGS" },
      relationships: { customer: { data: { type: "IndividualCustomer", id: customerId } } } },
  }});
  if (!r.ok) { console.error("   ✗", r.status, detail(r.j)); process.exit(1); }
  const acctId = r.j.data?.id;
  console.log("   ✓ depositAccountId:", acctId, "name:", r.j.data?.attributes?.accountName);

  // ── 5. Create the business-named virtual NUBAN — TRY WITHOUT BVN FIRST ────────
  const makeBody = (withBvn) => ({
    data: { type: "VirtualNuban", attributes: {
      provider: "providus",
      virtualAccountDetail: { name: bizName, reference: "kbprobe-" + stamp, permanent: true, ...(withBvn ? { bvn } : {}) },
    }, relationships: { settlementAccount: { data: { type: "DepositAccount", id: acctId } } } },
  });

  console.log(`5) POST /virtual-nubans  name="${bizName}"  (attempt WITHOUT bvn)…`);
  r = await call("/virtual-nubans", { method: "POST", body: makeBody(false) });
  let neededBvn = false;
  if (!r.ok && /bvn/i.test(detail(r.j))) {
    neededBvn = true;
    console.log(`   ↳ ${r.status} ${detail(r.j)} — retrying WITH bvn…`);
    r = await call("/virtual-nubans", { method: "POST", body: makeBody(true) });
  }
  if (!r.ok) { console.error("   ✗", r.status, detail(r.j)); process.exit(1); }

  const a = r.j.data?.attributes || {};
  const returnedName = a.accountName || a.virtualAccountDetail?.name;
  console.log("   ✓ virtual NUBAN:", a.accountNumber, "@", a.bank?.name);
  console.log("   ✓ accountName:", JSON.stringify(returnedName));

  // ── Verdict ──────────────────────────────────────────────────────────────────
  console.log("\n────────── VERDICT ──────────");
  console.log(returnedName === bizName
    ? `✅ Business name "${bizName}" shows on the NUBAN.`
    : `⚠️ Name came back as ${JSON.stringify(returnedName)} (not the business name).`);
  console.log(neededBvn
    ? "🔑 BVN WAS REQUIRED at virtual-NUBAN time → we must store the raw BVN transiently to create it in the approval webhook."
    : "🎉 BVN NOT required (settlement account's individual BVN was used) → NO raw-BVN storage needed. Cleanest path.");
  process.exit(0);
})();
