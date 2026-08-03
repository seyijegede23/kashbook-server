#!/usr/bin/env node
/**
 * Is any LIVE secret still readable from git history?
 *
 * server/.env was tracked in ~25 commits. Removing a file from HEAD does not
 * remove it from history — every clone still carries the old blobs. This script
 * compares the CURRENT server/.env against every historical version of that file
 * and reports which values are unchanged (i.e. still exposed).
 *
 * It compares SHA-256 hashes only and NEVER prints a secret value.
 *
 * Usage (from server/):   node scripts/check-secret-exposure.js
 * Exit code 1 if any live secret is still present in history.
 */

const { execSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const REPO_PATH = "server/.env";
const sha = (s) => crypto.createHash("sha256").update(String(s).trim()).digest("hex");

function parseEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i > 0) out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}

const localPath = path.resolve(__dirname, "..", ".env");
if (!fs.existsSync(localPath)) {
  console.error(`No ${localPath} — run this from the server/ directory of a checkout that has one.`);
  process.exit(2);
}
const current = parseEnv(fs.readFileSync(localPath, "utf8"));

let commits = [];
try {
  commits = execSync(`git log --all --format=%H -- ${REPO_PATH}`, {
    encoding: "utf8",
    cwd: path.resolve(__dirname, "..", ".."),
  })
    .trim()
    .split("\n")
    .filter(Boolean);
} catch {
  console.log("git history unavailable — cannot assess exposure.");
  process.exit(2);
}

// Collect every historical value ever committed, per variable.
const historical = {};
let readable = 0;
for (const c of commits) {
  let text;
  try {
    text = execSync(`git show ${c}:${REPO_PATH}`, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      cwd: path.resolve(__dirname, "..", ".."),
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch {
    continue; // e.g. the commit that deleted the file
  }
  readable++;
  for (const [k, v] of Object.entries(parseEnv(text))) {
    if (!v) continue;
    (historical[k] = historical[k] || new Set()).add(sha(v));
  }
}

console.log(`\nHistorical ${REPO_PATH} blobs readable: ${readable} (of ${commits.length} commits touching it)\n`);

// Only credentials matter. Config values (base URLs, TTLs, public ids, sender
// names) are not secrets — flagging them buries the signal that matters.
const SECRET_PATTERN = /(SECRET|PASSWORD|_PASS$|_KEY$|TOKEN|DATABASE_URL|_AUTH$|PRIVATE)/i;
const NOT_SECRET = new Set([
  "CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "ANCHOR_BASE_URL", "DOJAH_BASE_URL",
  "KORAPAY_BASE_URL", "EMAIL_FROM", "SMTP_HOST", "SMTP_PORT", "SMTP_USER",
  "TXN_SMTP_HOST", "TXN_SMTP_PORT", "TXN_SMTP_USER", "PUBLIC_BASE_URL",
  "KYC_PROVIDER", "KYC_CACHE_TTL_HOURS", "KYC_USER_MAX_ATTEMPTS_PER_DAY",
  "KYC_VALUE_MAX_ATTEMPTS_PER_DAY", "SENTRY_ENV", "SENTRY_TRACES_SAMPLE_RATE",
  "NODE_ENV", "PORT", "ANCHOR_FEE_ACCOUNT_ID", "KORAPAY_VBA_BANK_CODE",
  "IG_API_VERSION", "WA_API_VERSION", "IG_SCOPES", "SENDCHAMP_SENDER_ID",
  "SENDCHAMP_ROUTE", "TERMII_SENDER_ID", "AFRICAS_TALKING_USER", "EMAIL_LOGO_URL",
  "ALLOWED_ORIGIN", "AML_ENABLED", "ANCHOR_INDIVIDUAL_PRODUCT", "SENTRY_DSN",
  "MONO_APP_ID", "DOJAH_APP_ID", "INSTAGRAM_APP_ID", "META_APP_ID", "WA_CONFIG_ID",
  "FLW_PUBLIC_KEY", "KORAPAY_PUBLIC_KEY", "APPLE_CLIENT_ID", "GOOGLE_CLIENT_ID",
]);
const isSecret = (name) => !NOT_SECRET.has(name) && SECRET_PATTERN.test(name);

const secrets = [];
const config = [];
for (const [name, liveVal] of Object.entries(current)) {
  if (!liveVal) continue;
  const past = historical[name];
  const exposed = !!past && past.has(sha(liveVal));
  (isSecret(name) ? secrets : config).push({ name, exposed, everCommitted: !!past });
}

const width = Math.max(...[...secrets, ...config].map((r) => r.name.length), 12);
console.log("CREDENTIALS");
secrets.sort((a, b) => Number(b.exposed) - Number(a.exposed) || a.name.localeCompare(b.name));
for (const r of secrets) {
  console.log(
    `  ${r.name.padEnd(width)}  ${
      r.exposed ? "*** STILL EXPOSED — ROTATE ***" : r.everCommitted ? "rotated ✅" : "never committed ✅"
    }`,
  );
}

const cfgExposed = config.filter((c) => c.exposed);
if (cfgExposed.length) {
  console.log(`\nCONFIG (non-secret, in history — informational only): ${cfgExposed.map((c) => c.name).join(", ")}`);
}

const exposedCount = secrets.filter((r) => r.exposed).length;
console.log(
  exposedCount
    ? `\n⚠️  ${exposedCount} live CREDENTIAL(s) still readable from git history. See scripts/rotate-secrets.md\n`
    : `\n✅ No live credential matches any historical value.\n`,
);
process.exit(exposedCount ? 1 : 0);
