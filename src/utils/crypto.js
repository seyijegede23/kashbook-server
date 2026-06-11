/**
 * AES-256-GCM encryption helpers for at-rest PII (BVN, CAC, etc.).
 *
 * Env:
 *   ENCRYPTION_KEY — 64 hex chars (32 random bytes). Generate with:
 *                    openssl rand -hex 32   (bash)
 *                    [Convert]::ToHexString([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32))   (PowerShell)
 *
 * Format of stored ciphertext:
 *   enc:v1:<iv-base64>:<tag-base64>:<ciphertext-base64>
 *
 * Legacy plaintext values are passed through `decrypt()` unchanged — useful when
 * migrating an existing column. Rotate by re-encrypting old values once.
 */

const crypto = require("crypto");

const ALGO = "aes-256-gcm";
const IV_LENGTH = 12;     // GCM standard nonce length
const TAG_LENGTH = 16;
const PREFIX = "enc:v1:";

let cachedKey = null;
function getKey() {
  if (cachedKey) return cachedKey;
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex) {
    throw new Error("ENCRYPTION_KEY env var is required (64 hex chars / 32 bytes)");
  }
  const key = Buffer.from(hex, "hex");
  if (key.length !== 32) {
    throw new Error(`ENCRYPTION_KEY must be 32 bytes (64 hex chars). Got ${key.length} bytes.`);
  }
  cachedKey = key;
  return key;
}

function encrypt(plaintext) {
  if (plaintext == null || plaintext === "") return plaintext;
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv);
  const ct = Buffer.concat([
    cipher.update(String(plaintext), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
}

function decrypt(value) {
  if (!value) return value;
  if (typeof value !== "string" || !value.startsWith(PREFIX)) {
    // Not encrypted (legacy plaintext from before encryption was added)
    return value;
  }
  const parts = value.slice(PREFIX.length).split(":");
  if (parts.length !== 3) return value;
  const [ivB64, tagB64, ctB64] = parts;
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const ct = Buffer.from(ctB64, "base64");
  const decipher = crypto.createDecipheriv(ALGO, getKey(), iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString("utf8");
}

// Masks a sensitive value for display/logs: keep first + last char, mask the rest.
// "22222222200" → "2*********0"
function mask(value) {
  if (!value || typeof value !== "string") return value;
  if (value.length <= 2) return value;
  return value[0] + "*".repeat(value.length - 2) + value[value.length - 1];
}

// Deterministic HMAC-SHA-256 of a sensitive value, keyed by ENCRYPTION_KEY.
// Used for searchable dedup indexes — e.g. Business.kycBvnHash — and as the
// cache key for KYC check responses. Irreversible (one-way), so storing the
// hash is safe even if our DB is exfiltrated.
//
// Returns a 64-character lowercase hex string. Pass the raw value (BVN, CAC
// RC number, etc.) without any masking; whitespace is trimmed.
function hmacValue(value) {
  if (value == null || value === "") return null;
  const normalised = String(value).trim();
  if (!normalised) return null;
  return crypto
    .createHmac("sha256", getKey())
    .update(normalised, "utf8")
    .digest("hex");
}

module.exports = { encrypt, decrypt, mask, hmacValue };
