// Probe: does Anchor honour a CUSTOM name on a virtual NUBAN?
//
// This is the make-or-break test for "individual KYC + business-named virtual
// account": it creates a VirtualNuban with a custom name against an existing
// deposit account and prints the accountName Anchor returns. If the returned
// name == the custom name we sent, the approach works.
//
// Run where ANCHOR creds are VALID (e.g. Render Shell, on sandbox):
//   node -r dotenv/config scripts/vnuban-probe.js <settlementDepositAccountId> ["Custom Name"]
//
// Find a settlement deposit account id in the DB (Business.anchorAccountId).

(async () => {
  const BASE = process.env.ANCHOR_BASE_URL;
  const KEY = process.env.ANCHOR_API_KEY;
  const acctId = process.argv[2];
  const name = process.argv[3] || "KASHBOOK CUSTOM BIZ NAME";

  if (!BASE || !KEY) { console.error("ANCHOR_BASE_URL / ANCHOR_API_KEY not set"); process.exit(1); }
  if (!acctId) { console.error("usage: node scripts/vnuban-probe.js <settlementDepositAccountId> [customName]"); process.exit(1); }

  const body = {
    data: {
      type: "VirtualNuban",
      attributes: {
        provider: "providus", // Anchor's virtual-NUBAN provider; try "anchor" if this is rejected
        virtualAccountDetail: { name, reference: "kbprobe-" + Date.now(), permanent: true },
      },
      relationships: {
        settlementAccount: { data: { type: "DepositAccount", id: acctId } },
      },
    },
  };

  console.log(`POST ${BASE}/virtual-nubans  (requested name: "${name}")`);
  const r = await fetch(`${BASE}/virtual-nubans`, {
    method: "POST",
    headers: { "x-anchor-key": KEY, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch { j = { raw: text }; }
  console.log("HTTP", r.status);
  console.log(JSON.stringify(j, null, 2).slice(0, 2500));

  if (r.ok) {
    const a = j?.data?.attributes || {};
    const returned = a.accountName || a.virtualAccountDetail?.name || a.bankAccountName;
    console.log(`\n→ Anchor returned accountName: ${JSON.stringify(returned)}`);
    console.log(returned === name ? "✅ CUSTOM NAME HONOURED — the approach works." : "⚠️ Name differs — Anchor overrode/ignored the custom name.");
  } else {
    console.log("\n→ If the error names a missing/invalid field (e.g. bvn, email, provider), tell me and I'll adjust the body.");
  }
  process.exit(0);
})();
