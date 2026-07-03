/**
 * WhatsApp Business (Cloud API) — per-merchant Graph client.
 *
 * Mirrors utils/instagram.js but on graph.facebook.com with the FB app
 * credentials. Merchants onboard via Embedded Signup (a KashBook-hosted page);
 * the resulting business-scoped token DOES NOT EXPIRE (no refresh cron).
 * Contracts verified in docs/WHATSAPP_API_SPEC.md.
 *
 * NOTE: distinct from utils/whatsapp.js, which sends KashBook's own OTPs from a
 * global env-configured number. This module is the per-BUSINESS integration.
 *
 * Required env:
 *   META_APP_ID       Facebook app id (the "Bookkeeping" app — NOT the Instagram app id)
 *   META_APP_SECRET   FB app secret (code exchange + webhook X-Hub-Signature-256)
 *   WA_CONFIG_ID      Embedded Signup configuration id
 *   WA_VERIFY_TOKEN   webhook GET handshake token
 * Optional:
 *   WA_API_VERSION    default "v25.0"
 */

const crypto = require("crypto");

const TIMEOUT_MS = 12_000;
const GRAPH = "https://graph.facebook.com";
const DEFAULT_VERSION = "v25.0";

function getConfig() {
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  if (!appId || !appSecret) return null;
  return {
    appId,
    appSecret,
    // Only the Embedded Signup connect flow needs configId — webhooks, sends and
    // the payment matcher work without it (e.g. a manually-wired test number).
    configId: process.env.WA_CONFIG_ID || "",
    version: process.env.WA_API_VERSION || DEFAULT_VERSION,
    verifyToken: process.env.WA_VERIFY_TOKEN || "",
  };
}

function isConfigured() {
  return getConfig() !== null;
}

function graphBase() {
  // The version string isn't a credential — token-authenticated Graph calls
  // (subscribe, send, media) must work even when the app id/secret env isn't
  // present (e.g. the local test-number wiring script).
  return `${GRAPH}/${process.env.WA_API_VERSION || DEFAULT_VERSION}`;
}

// ── Low-level HTTP (same contract as instagram.js httpJson) ──────────────────
async function httpJson(url, { method = "GET", headers = {}, body } = {}) {
  const opts = { method, headers: { ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS) };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, opts);
  } catch (err) {
    const e = new Error(
      err.name === "TimeoutError" ? "WhatsApp request timed out" : "Could not reach WhatsApp",
    );
    e.code = "NETWORK";
    throw e;
  }
  let data;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) {
    const waError = data?.error || null;
    const e = new Error(waError?.message || `WhatsApp API error (${res.status})`);
    e.status = res.status;
    e.waError = waError;
    throw e;
  }
  return data;
}

// ── Signed connect state (CSRF) — same scheme as instagram.js ────────────────
const STATE_TTL_MS = 15 * 60 * 1000;

function signState({ businessId, userId }) {
  const cfg = getConfig();
  const payload = Buffer.from(
    JSON.stringify({ b: businessId, u: userId, n: crypto.randomBytes(8).toString("hex"), t: Date.now() }),
  ).toString("base64url");
  const sig = crypto.createHmac("sha256", cfg.appSecret).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

function verifyState(state) {
  if (!state || typeof state !== "string" || !state.includes(".")) return null;
  const cfg = getConfig();
  if (!cfg) return null;
  const [payload, sig] = state.split(".");
  const expected = crypto.createHmac("sha256", cfg.appSecret).update(payload).digest("hex");
  const a = Buffer.from(sig || "", "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let obj;
  try { obj = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { return null; }
  if (!obj || typeof obj.t !== "number" || Date.now() - obj.t > STATE_TTL_MS) return null;
  return { businessId: obj.b, userId: obj.u };
}

// ── Embedded Signup: code → business token (no expiry) ───────────────────────
async function exchangeCodeForToken(code) {
  const cfg = getConfig();
  const url = `${GRAPH}/${cfg.version}/oauth/access_token?${new URLSearchParams({
    client_id: cfg.appId,
    client_secret: cfg.appSecret,
    code,
  })}`;
  const data = await httpJson(url);
  return { accessToken: data?.access_token || null };
}

// Subscribe our app to the merchant's WABA (inbound webhooks won't flow without it).
async function subscribeWaba(token, wabaId) {
  const data = await httpJson(`${graphBase()}/${encodeURIComponent(wabaId)}/subscribed_apps`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  return !!data?.success;
}

// Deterministic 6-digit two-step pin per business (needed by /register). Derived
// from the encryption key so it's stable across restarts without storing it.
function derivePin(businessId) {
  const key = process.env.ENCRYPTION_KEY || getConfig()?.appSecret || "kashbook";
  const h = crypto.createHmac("sha256", key).update(`wa-pin:${businessId}`).digest();
  return String(h.readUInt32BE(0) % 1000000).padStart(6, "0");
}

// Register the phone number for Cloud API use. "Already registered" counts as ok.
async function registerPhone(token, phoneNumberId, pin) {
  try {
    const data = await httpJson(`${graphBase()}/${encodeURIComponent(phoneNumberId)}/register`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: { messaging_product: "whatsapp", pin },
    });
    return !!data?.success;
  } catch (e) {
    if (/already/i.test(e.message || "")) return true;
    throw e;
  }
}

// Fetch the display number for a phone-number-id (post-signup enrichment).
async function getPhoneInfo(token, phoneNumberId) {
  const data = await httpJson(
    `${graphBase()}/${encodeURIComponent(phoneNumberId)}?${new URLSearchParams({ fields: "display_phone_number,verified_name" })}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  return {
    displayPhoneNumber: data?.display_phone_number || null,
    verifiedName: data?.verified_name || null,
  };
}

// ── Send a free-form text (inside the 24h customer window) ───────────────────
const MAX_TEXT = 4000; // WhatsApp text body cap is 4096

async function sendText(token, phoneNumberId, to, text) {
  const data = await httpJson(`${graphBase()}/${encodeURIComponent(phoneNumberId)}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: String(to),
      type: "text",
      text: { preview_url: true, body: String(text).slice(0, MAX_TEXT) },
    },
  });
  return { messageId: data?.messages?.[0]?.id || null };
}

// Short-lived authenticated media URL for an inbound media id (download needs
// the Bearer too — re-hosting handled by a later batch).
async function getMediaUrl(token, mediaId) {
  const data = await httpJson(`${graphBase()}/${encodeURIComponent(mediaId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return data?.url || null;
}

// ── Webhooks (same handshake/signature scheme as IG, but keyed on the FB app secret) ──
function verifyHandshake(query) {
  const cfg = getConfig();
  const mode = query["hub.mode"];
  const token = query["hub.verify_token"];
  const challenge = query["hub.challenge"];
  if (mode === "subscribe" && cfg && cfg.verifyToken && token === cfg.verifyToken) {
    return challenge != null ? String(challenge) : "";
  }
  return null;
}

function verifyWebhookSignature(rawBody, headers) {
  const cfg = getConfig();
  if (!cfg) return false;
  const header = headers["x-hub-signature-256"] || headers["X-Hub-Signature-256"] || "";
  if (!header.startsWith("sha256=")) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", cfg.appSecret).update(rawBody).digest("hex");
  const a = Buffer.from(header, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = {
  isConfigured,
  getConfig,
  signState,
  verifyState,
  exchangeCodeForToken,
  subscribeWaba,
  derivePin,
  registerPhone,
  getPhoneInfo,
  sendText,
  getMediaUrl,
  verifyHandshake,
  verifyWebhookSignature,
};
