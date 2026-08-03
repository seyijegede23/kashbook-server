#!/usr/bin/env node
/**
 * ENCRYPTION_KEY rotation — re-encrypt every AES-256-GCM value and recompute
 * every HMAC index under a new key.
 *
 * WHY THIS IS NOT JUST AN ENV SWAP
 *   1. Every `enc:v1:` value is decryptable only with the key that wrote it.
 *   2. utils/crypto.js `hmacValue()` is keyed with the SAME ENCRYPTION_KEY, so
 *      rotating it silently invalidates kycBvnHash / kycCacHash / bvnHash — the
 *      BVN-reuse dedup gate in virtualAccountProvisioning would stop matching
 *      and the same BVN could open accounts on multiple businesses.
 *   3. `decrypt()` PASSES THROUGH anything not prefixed `enc:v1:` (legacy
 *      plaintext support). A half-finished rotation therefore fails SILENTLY —
 *      ciphertext is handed back as if it were plaintext. This script fails loud
 *      instead: every decrypt is verified before anything is written.
 *
 * USAGE (from server/):
 *   1. DRY RUN — reads only, writes nothing, proves every value decrypts:
 *        ENCRYPTION_KEY_OLD=<current> ENCRYPTION_KEY_NEW=<new> node scripts/reencrypt-key-rotation.js
 *   2. APPLY — same command plus --apply. Runs in ONE transaction; any failure
 *      rolls the whole thing back:
 *        ENCRYPTION_KEY_OLD=<current> ENCRYPTION_KEY_NEW=<new> node scripts/reencrypt-key-rotation.js --apply
 *   3. Only after a clean apply, set ENCRYPTION_KEY=<new> on Render and redeploy.
 *
 * Generate a new key with:  openssl rand -hex 32
 *
 * NOTE: this script deliberately does NOT read ENCRYPTION_KEY — it takes both
 * keys explicitly so it can never be run "half configured" against live data.
 */

const crypto = require("crypto");
const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");

const APPLY = process.argv.includes("--apply");
const ALGO = "aes-256-gcm";
const IV_LENGTH = 12;
const PREFIX = "enc:v1:";

// ── key handling ────────────────────────────────────────────────────────────
function loadKey(name) {
  const hex = process.env[name];
  if (!hex) throw new Error(`${name} is required (64 hex chars)`);
  const key = Buffer.from(hex, "hex");
  if (key.length !== 32) throw new Error(`${name} must be 32 bytes (64 hex chars); got ${key.length}`);
  return key;
}
const OLD_KEY = loadKey("ENCRYPTION_KEY_OLD");
const NEW_KEY = loadKey("ENCRYPTION_KEY_NEW");
if (OLD_KEY.equals(NEW_KEY)) throw new Error("OLD and NEW keys are identical — nothing to rotate");

function decryptWith(key, value) {
  if (!value) return value;
  if (typeof value !== "string" || !value.startsWith(PREFIX)) return value; // legacy plaintext
  const parts = value.slice(PREFIX.length).split(":");
  if (parts.length !== 3) throw new Error("malformed ciphertext (expected 3 parts)");
  const [ivB64, tagB64, ctB64] = parts;
  const d = crypto.createDecipheriv(ALGO, key, Buffer.from(ivB64, "base64"));
  d.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([d.update(Buffer.from(ctB64, "base64")), d.final()]).toString("utf8");
}
function encryptWith(key, plaintext) {
  if (plaintext == null || plaintext === "") return plaintext;
  const iv = crypto.randomBytes(IV_LENGTH);
  const c = crypto.createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([c.update(String(plaintext), "utf8"), c.final()]);
  return `${PREFIX}${iv.toString("base64")}:${c.getAuthTag().toString("base64")}:${ct.toString("base64")}`;
}
const hmacWith = (key, value) => {
  if (value == null || value === "") return null;
  const n = String(value).trim();
  return n ? crypto.createHmac("sha256", key).update(n, "utf8").digest("hex") : null;
};

// ── what gets rotated ───────────────────────────────────────────────────────
// enc:  ciphertext columns (decrypt with OLD → encrypt with NEW)
// hmac: { column, from } — recompute HMAC over the DECRYPTED source column
const TARGETS = [
  {
    model: "business",
    label: "Business",
    enc: ["kycBvn", "kycId", "kycCacNumber", "instagramAccessToken", "waAccessToken"],
    hmac: [
      { column: "kycBvnHash", from: "kycBvn" },
      { column: "kycCacHash", from: "kycCacNumber" },
    ],
  },
  { model: "businessOfficer", label: "BusinessOfficer", enc: ["bvn"], hmac: [{ column: "bvnHash", from: "bvn" }] },
  { model: "kycSubmission", label: "KycSubmission", enc: ["payload"], hmac: [] },
];

// KycCheckAttempt.valueHash / KycCheckCache.valueHash are HMACs of values we do
// NOT store (BVN/CAC lookups). They cannot be recomputed — they are a 24h cache
// and an attempt-counter, so they are DELETED instead (see below).

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

async function main() {
  console.log(`\n=== ENCRYPTION_KEY rotation — ${APPLY ? "APPLY" : "DRY RUN"} ===\n`);
  const plan = [];
  let totalValues = 0;

  for (const t of TARGETS) {
    const cols = [...t.enc, ...t.hmac.map((h) => h.column)];
    const rows = await prisma[t.model].findMany({
      select: Object.fromEntries([["id", true], ...cols.map((c) => [c, true])]),
    });
    let touched = 0;
    for (const row of rows) {
      const patch = {};
      for (const col of t.enc) {
        const cur = row[col];
        if (!cur) continue;
        if (!String(cur).startsWith(PREFIX)) {
          // Legacy plaintext: encrypt it under the NEW key (it was never protected).
          patch[col] = encryptWith(NEW_KEY, cur);
          console.log(`  ! ${t.label}.${col} on ${row.id} was PLAINTEXT — will be encrypted`);
          totalValues++;
          continue;
        }
        let plain;
        try {
          plain = decryptWith(OLD_KEY, cur);
        } catch (e) {
          throw new Error(
            `FATAL: ${t.label}.${col} on row ${row.id} does not decrypt with ENCRYPTION_KEY_OLD (${e.message}). ` +
              `Rotation aborted — no rows were modified. Confirm the OLD key is the one currently live.`,
          );
        }
        const reenc = encryptWith(NEW_KEY, plain);
        // Prove the round-trip BEFORE we agree to write it.
        if (decryptWith(NEW_KEY, reenc) !== plain) {
          throw new Error(`FATAL: re-encryption round-trip failed for ${t.label}.${col} on ${row.id}`);
        }
        patch[col] = reenc;
        totalValues++;
      }
      // HMAC indexes are keyed with ENCRYPTION_KEY → must be recomputed from plaintext.
      for (const h of t.hmac) {
        const src = row[h.from];
        if (!src) continue;
        const plain = String(src).startsWith(PREFIX) ? decryptWith(OLD_KEY, src) : src;
        const next = hmacWith(NEW_KEY, plain);
        if (next && next !== row[h.column]) {
          patch[h.column] = next;
          totalValues++;
        }
      }
      if (Object.keys(patch).length) {
        plan.push({ model: t.model, label: t.label, id: row.id, patch });
        touched++;
      }
    }
    console.log(`${t.label.padEnd(18)} rows=${String(rows.length).padStart(4)}  to-update=${touched}`);
  }

  const staleCache = await prisma.kycCheckCache.count();
  const staleAttempts = await prisma.kycCheckAttempt.count();
  console.log(
    `\nKycCheckCache / KycCheckAttempt hold HMACs of values we don't store (unrecomputable).\n` +
      `  cache rows=${staleCache} (24h TTL) · attempt rows=${staleAttempts} (rate-limit counters)\n` +
      `  → these will be DELETED; effect is a cold cache and reset counters.\n`,
  );
  console.log(`TOTAL values to rewrite: ${totalValues} across ${plan.length} rows\n`);

  if (!APPLY) {
    console.log("DRY RUN complete — every ciphertext decrypted cleanly with the OLD key.");
    console.log("Re-run with --apply to write. Nothing was modified.\n");
    return;
  }

  // Single transaction: partial rotation would leave undecryptable rows.
  await prisma.$transaction(async (tx) => {
    for (const p of plan) await tx[p.model].update({ where: { id: p.id }, data: p.patch });
    await tx.kycCheckCache.deleteMany({});
    await tx.kycCheckAttempt.deleteMany({});
  }, { timeout: 120000 });
  console.log(`APPLIED: ${plan.length} rows rewritten.`);

  // Post-write verification: read back and decrypt with the NEW key.
  let verified = 0;
  for (const t of TARGETS) {
    const rows = await prisma[t.model].findMany({
      select: Object.fromEntries([["id", true], ...t.enc.map((c) => [c, true])]),
    });
    for (const row of rows) {
      for (const col of t.enc) {
        if (!row[col]) continue;
        try {
          decryptWith(NEW_KEY, row[col]);
          verified++;
        } catch (e) {
          throw new Error(`POST-CHECK FAILED: ${t.label}.${col} on ${row.id} won't decrypt with the NEW key — ${e.message}`);
        }
      }
    }
  }
  console.log(`POST-CHECK OK: ${verified} values decrypt with ENCRYPTION_KEY_NEW.`);
  console.log(`\nNEXT: set ENCRYPTION_KEY=<new> on Render, redeploy, then confirm a BVN-gated`);
  console.log(`action still works (e.g. open the KYC screen for an existing business).\n`);
}

main()
  .catch((e) => {
    console.error(`\n${e.message}\n`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
