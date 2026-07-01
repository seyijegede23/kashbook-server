/**
 * Instagram DM integration — Graph client (Path A: "Instagram API with
 * Instagram Login", host graph.instagram.com, API v25.0). No Facebook Page.
 *
 * Mirrors utils/whatsapp.js: configured-or-graceful, AbortSignal timeouts, and
 * a single source for the Meta contracts. Every endpoint here is web-verified
 * against Meta docs — see docs/INSTAGRAM_API_SPEC.md (the authoritative spec).
 *
 * This module is a PURE Graph client: it takes a decrypted access token + ids
 * and returns parsed results. It does NOT touch the DB — the routes/webhook own
 * persistence, encryption, and ownership checks.
 *
 * Required env (set on Render + locally):
 *   INSTAGRAM_APP_ID       Instagram App ID (Instagram product settings, NOT the FB App ID)
 *   INSTAGRAM_APP_SECRET   Instagram App Secret (token exchange + webhook HMAC)
 *   IG_VERIFY_TOKEN        our chosen webhook verify token (GET handshake)
 * Optional:
 *   IG_REDIRECT_URI        defaults to ${PUBLIC_BASE_URL}/instagram/callback
 *   IG_API_VERSION         default "v25.0"
 *   IG_SCOPES              default "instagram_business_basic,instagram_business_manage_messages"
 */

const crypto = require("crypto");

const TIMEOUT_MS = 12_000;

// Hosts. Token-mint endpoints are VERSIONLESS; graph reads/sends are versioned.
const AUTHORIZE_URL = "https://www.instagram.com/oauth/authorize";
const SHORT_TOKEN_URL = "https://api.instagram.com/oauth/access_token";
const GRAPH = "https://graph.instagram.com";
const DEFAULT_VERSION = "v25.0";
const DEFAULT_SCOPES = "instagram_business_basic,instagram_business_manage_messages";

// Long-lived token lifetime per Meta (60 days). Used as a fallback when a token
// response omits expires_in.
const SIXTY_DAYS_SEC = 60 * 24 * 60 * 60;

function getConfig() {
  const appId = process.env.INSTAGRAM_APP_ID;
  const appSecret = process.env.INSTAGRAM_APP_SECRET;
  if (!appId || !appSecret) return null;
  const base = process.env.PUBLIC_BASE_URL || "";
  return {
    appId,
    appSecret,
    version: process.env.IG_API_VERSION || DEFAULT_VERSION,
    scopes: process.env.IG_SCOPES || DEFAULT_SCOPES,
    redirectUri:
      process.env.IG_REDIRECT_URI ||
      (base ? `${base.replace(/\/$/, "")}/instagram/callback` : ""),
    verifyToken: process.env.IG_VERIFY_TOKEN || "",
  };
}

function isConfigured() {
  const cfg = getConfig();
  return !!(cfg && cfg.redirectUri);
}

function graphBase() {
  const cfg = getConfig();
  if (!cfg) throw new Error("Instagram is not configured on the server.");
  return `${GRAPH}/${cfg.version}`;
}

// ── Low-level HTTP ───────────────────────────────────────────────────────────
// Throws Error(message) on non-2xx, with err.status + err.igError (Meta's error
// object) attached so callers can branch (e.g. window-closed on send).
async function httpJson(url, { method = "GET", headers = {}, body, form } = {}) {
  const opts = { method, headers: { ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS) };
  if (form) {
    opts.headers["Content-Type"] = "application/x-www-form-urlencoded";
    opts.body = new URLSearchParams(form).toString();
  } else if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(url, opts);
  } catch (err) {
    const e = new Error(
      err.name === "TimeoutError" ? "Instagram request timed out" : "Could not reach Instagram",
    );
    e.code = "NETWORK";
    throw e;
  }

  let data;
  try { data = await res.json(); } catch { data = null; }

  if (!res.ok) {
    const igError = data?.error || null;
    const msg = igError?.message || `Instagram API error (${res.status})`;
    const e = new Error(msg);
    e.status = res.status;
    e.igError = igError;
    throw e;
  }
  return data;
}

// ── OAuth: CSRF state (signed, short-TTL) ────────────────────────────────────
// Encodes { businessId, userId } so the stateless callback knows which business
// is connecting and can re-check ownership. HMAC-signed with the app secret;
// 15-minute TTL. base64url(payload).hex(hmac).
const STATE_TTL_MS = 15 * 60 * 1000;

function signState({ businessId, userId }) {
  const cfg = getConfig();
  const payload = Buffer.from(
    JSON.stringify({ b: businessId, u: userId, n: crypto.randomBytes(8).toString("hex"), t: Date.now() }),
  ).toString("base64url");
  const sig = crypto.createHmac("sha256", cfg.appSecret).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

// Returns { businessId, userId } or null if tampered / expired / malformed.
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

// ── OAuth: dialog + token exchange ───────────────────────────────────────────
function buildConnectUrl(state) {
  const cfg = getConfig();
  const params = new URLSearchParams({
    client_id: cfg.appId,
    redirect_uri: cfg.redirectUri,
    response_type: "code",
    scope: cfg.scopes,
    state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

// code -> short-lived token (1h). Returns { accessToken, userId, permissions }.
async function exchangeCodeForToken(code) {
  const cfg = getConfig();
  const data = await httpJson(SHORT_TOKEN_URL, {
    method: "POST",
    form: {
      client_id: cfg.appId,
      client_secret: cfg.appSecret,
      grant_type: "authorization_code",
      redirect_uri: cfg.redirectUri,
      code,
    },
  });
  return {
    accessToken: data?.access_token,
    userId: data?.user_id != null ? String(data.user_id) : null,
    permissions: data?.permissions, // string or array — handle defensively downstream
  };
}

// short-lived -> long-lived (60d). Returns { accessToken, expiresIn }.
async function getLongLivedToken(shortToken) {
  const cfg = getConfig();
  const url = `${GRAPH}/access_token?${new URLSearchParams({
    grant_type: "ig_exchange_token",
    client_secret: cfg.appSecret,
    access_token: shortToken,
  })}`;
  const data = await httpJson(url);
  return { accessToken: data?.access_token, expiresIn: data?.expires_in || SIXTY_DAYS_SEC };
}

// refresh long-lived (token must be >=24h old and unexpired). Returns { accessToken, expiresIn }.
async function refreshLongLivedToken(longToken) {
  const url = `${GRAPH}/refresh_access_token?${new URLSearchParams({
    grant_type: "ig_refresh_token",
    access_token: longToken,
  })}`;
  const data = await httpJson(url);
  return { accessToken: data?.access_token, expiresIn: data?.expires_in || SIXTY_DAYS_SEC };
}

// GET /me?fields=user_id,username. Envelope is UNVERIFIED (flat vs data[0]) — read both.
async function getAccountInfo(token) {
  const url = `${graphBase()}/me?${new URLSearchParams({ fields: "user_id,username", access_token: token })}`;
  const data = await httpJson(url);
  const me = (Array.isArray(data?.data) ? data.data[0] : null) || data || {};
  return {
    userId: me.user_id != null ? String(me.user_id) : (me.id != null ? String(me.id) : null),
    username: me.username || null,
  };
}

// Subscribe this merchant's account to the `messages` webhook field. CRITICAL:
// without this, OAuth succeeds but no inbound DMs ever arrive (#1 silent bug).
async function subscribeWebhooks(token) {
  const url = `${graphBase()}/me/subscribed_apps?${new URLSearchParams({
    subscribed_fields: "messages",
    access_token: token,
  })}`;
  const data = await httpJson(url, { method: "POST" });
  return !!data?.success;
}

// ── Reading conversations + messages ─────────────────────────────────────────
// Returns [{ id, updatedTime, participants:[{id,username}] }].
async function listConversations(token) {
  const url = `${graphBase()}/me/conversations?${new URLSearchParams({
    platform: "instagram",
    fields: "id,updated_time,participants",
    access_token: token,
  })}`;
  const data = await httpJson(url);
  return (data?.data || []).map((c) => ({
    id: c.id,
    updatedTime: c.updated_time || null,
    participants: (c.participants?.data || []).map((p) => ({
      id: p.id != null ? String(p.id) : null,
      username: p.username || null,
    })),
  }));
}

// Step A: list message ids (newest first). Only the 20 most recent are
// fetchable in detail (Meta cap) — webhooks are the source of truth for history.
async function listMessageIds(token, conversationId) {
  const url = `${graphBase()}/${encodeURIComponent(conversationId)}?${new URLSearchParams({
    fields: "messages",
    access_token: token,
  })}`;
  const data = await httpJson(url);
  return (data?.messages?.data || []).map((m) => ({ id: m.id, createdTime: m.created_time || null }));
}

// Step B: one message's detail. Returns { id, createdTime, text, from:{id,username}, to:[{id,username}] }.
async function getMessage(token, messageId) {
  const url = `${graphBase()}/${encodeURIComponent(messageId)}?${new URLSearchParams({
    fields: "id,created_time,from,to,message",
    access_token: token,
  })}`;
  const data = await httpJson(url);
  return {
    id: data?.id,
    createdTime: data?.created_time || null,
    text: data?.message || "",
    from: data?.from ? { id: String(data.from.id), username: data.from.username || null } : null,
    to: (data?.to?.data || []).map((t) => ({ id: String(t.id), username: t.username || null })),
  };
}

// ── Sending a DM ─────────────────────────────────────────────────────────────
// Token passed via Authorization: Bearer (Path A). messaging_type omitted for
// normal in-window replies; HUMAN_AGENT tag for 24h–7d. Text < 1000 chars.
// Returns { messageId, recipientId }. Throws on failure (err.status/err.igError).
const MAX_TEXT = 990;

async function sendMessage(token, igId, recipientIgsid, text, { humanAgent = false } = {}) {
  const body = {
    recipient: { id: String(recipientIgsid) },
    message: { text: String(text).slice(0, MAX_TEXT) },
  };
  if (humanAgent) {
    body.messaging_type = "MESSAGE_TAG";
    body.tag = "HUMAN_AGENT";
  }
  const url = `${graphBase()}/${encodeURIComponent(igId)}/messages`;
  const data = await httpJson(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body,
  });
  return { messageId: data?.message_id || null, recipientId: data?.recipient_id || null };
}

// Format a money amount for a DM. NGN → "₦5,000"; else "5,000 USD".
function formatAmount(amount, currency) {
  const n = Number(amount) || 0;
  const cur = currency || "NGN";
  const num = n.toLocaleString("en-NG", { maximumFractionDigits: 2 });
  return cur === "NGN" ? `₦${num}` : `${num} ${cur}`;
}

// Compose the merchant's bank-transfer payment message from their NUBAN. When an
// `amount` is given it becomes a "Please pay ₦X" request (used by auto-confirm).
function buildPaymentText(business, { amount, note } = {}) {
  if (!business?.virtualAccountNumber) return null;
  const amt = amount > 0 ? formatAmount(amount, business.baseCurrency) : null;
  const lines = [
    amt ? `Please pay ${amt} to the account below 👇` : "Here are our payment details 👇",
    "",
    `Bank: ${business.virtualAccountBank || ""}`.trim(),
    `Account Number: ${business.virtualAccountNumber}`,
    `Account Name: ${business.virtualAccountName || business.name || ""}`.trim(),
  ];
  if (note) lines.push("", String(note));
  lines.push("", "Kindly send your proof of payment after the transfer. Thank you!");
  return lines.join("\n");
}

// ── Webhooks ─────────────────────────────────────────────────────────────────
// GET handshake — echo hub.challenge (raw) when mode+verify_token match.
// Returns the challenge string to echo, or null to reject (403).
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

// POST signature — X-Hub-Signature-256: sha256=<hex> = HMAC-SHA256(appSecret, rawBody).
// rawBody MUST be the exact bytes Meta sent (Buffer). timingSafeEqual.
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
  // oauth
  signState,
  verifyState,
  buildConnectUrl,
  exchangeCodeForToken,
  getLongLivedToken,
  refreshLongLivedToken,
  getAccountInfo,
  subscribeWebhooks,
  // messaging
  listConversations,
  listMessageIds,
  getMessage,
  sendMessage,
  buildPaymentText,
  formatAmount,
  // webhooks
  verifyHandshake,
  verifyWebhookSignature,
  // constants (for callers/tests)
  SIXTY_DAYS_SEC,
};
