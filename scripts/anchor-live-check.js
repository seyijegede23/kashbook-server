// READ-ONLY Anchor live-API verifier. Moves NO money, creates NO KYC/accounts.
// It confirms your live key authenticates against the live base URL using
// harmless GET calls (list banks, optional name-enquiry).
//
// Run inside the env that holds the LIVE Anchor key (NEVER paste the key in chat):
//   Local:        set ANCHOR_BASE_URL + ANCHOR_API_KEY in server/.env, then:
//                   cd server && node -r dotenv/config scripts/anchor-live-check.js
//   Render Shell: node -r dotenv/config scripts/anchor-live-check.js
//
// Optional read-only name enquiry (still no money):
//   node -r dotenv/config scripts/anchor-live-check.js <10-digit-acct> <bankCode>

const anchor = require("../src/utils/anchor");

function mask(v) { return v ? v.slice(0, 4) + "…" + v.slice(-3) + ` (len ${v.length})` : "(unset)"; }

(async () => {
  const base = process.env.ANCHOR_BASE_URL || "(unset)";
  const isLive = /\/\/api\.getanchor\.co\b/.test(base);
  const isSandbox = /sandbox\.getanchor\.co/.test(base);

  console.log("── Anchor config ─────────────────────────────");
  console.log("  ANCHOR_BASE_URL      :", base, isLive ? "→ LIVE ✅" : isSandbox ? "→ SANDBOX ⚠️" : "→ UNKNOWN ⚠️");
  console.log("  ANCHOR_API_KEY       :", mask(process.env.ANCHOR_API_KEY));
  console.log("  ANCHOR_WEBHOOK_SECRET:", process.env.ANCHOR_WEBHOOK_SECRET ? "set ✅" : "MISSING ❌");
  console.log("  ANCHOR_VERIFY_WEBHOOK:", process.env.ANCHOR_VERIFY_WEBHOOK === "false" ? "false ❌ (must verify in live!)" : "verify ✅");
  if (!isLive) console.warn("\n  ⚠️  Not pointed at live. Set ANCHOR_BASE_URL=https://api.getanchor.co/api/v1 to test the live key.");

  console.log("\n── Read-only connectivity + auth ─────────────");
  try {
    const banks = await anchor.getBanks();
    const n = Array.isArray(banks) ? banks.length : (banks?.data?.length ?? "?");
    console.log(`  ✅ getBanks OK — ${n} banks. Your key authenticates against ${isLive ? "LIVE" : "this"} Anchor.`);
  } catch (e) {
    console.error(`  ❌ getBanks failed: ${e.message}${e.code ? " [" + e.code + "]" : ""}`);
    console.error("     → 401/403 = bad/sandbox key on live URL; ANCHOR_NOT_CONFIGURED = base/key unset.");
    process.exit(1);
  }

  const [acct, bankCode] = process.argv.slice(2);
  if (acct && bankCode) {
    console.log("\n── Read-only name enquiry (no money) ─────────");
    try {
      const r = await anchor.verifyCounterparty({ accountNumber: acct, bankCode });
      console.log(`  ✅ ${acct} @ ${bankCode} → ${r.accountName}`);
    } catch (e) {
      console.error(`  ❌ name enquiry failed: ${e.message}`);
    }
  }

  console.log("\n✅ Read-only checks complete. No money moved, no KYC/accounts created.");
  process.exit(0);
})();
