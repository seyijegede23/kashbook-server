// Fincra client — virtual accounts (NGN instant + USD/FCY async), balances,
// and webhook signature verification. Candidate replacement for Anchor as the
// BaaS provider (pre-production swap). Sandbox-first.
//
// Env (server/.env):
//   FINCRA_BASE_URL       https://sandboxapi.fincra.com (sandbox) | https://api.fincra.com (live)
//   FINCRA_SECRET_KEY     api-key header (server-side secret)
//   FINCRA_PUBLIC_KEY     x-pub-key header
//   FINCRA_WEBHOOK_SECRET webhook signing secret (HMAC-SHA512)
//   FINCRA_BUSINESS_ID    the merchant/business id Fincra issued (for scoped calls)
const crypto = require("crypto");

const BASE = () => process.env.FINCRA_BASE_URL || "https://sandboxapi.fincra.com";
const SECRET = () => process.env.FINCRA_SECRET_KEY;
const PUBLIC = () => process.env.FINCRA_PUBLIC_KEY;
const WEBHOOK_SECRET = () => process.env.FINCRA_WEBHOOK_SECRET;

function isConfigured() {
  return !!(SECRET() && PUBLIC());
}

async function fincraFetch(path, { method = "GET", body } = {}) {
  if (!isConfigured()) throw new Error("Fincra not configured (FINCRA_SECRET_KEY / FINCRA_PUBLIC_KEY)");
  const res = await fetch(`${BASE()}${path}`, {
    method,
    headers: {
      "api-key": SECRET(),
      "x-pub-key": PUBLIC(),
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    const msg = data?.message || data?.error || `Fincra ${method} ${path} failed (${res.status})`;
    const err = new Error(msg);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

// ── Virtual accounts ────────────────────────────────────────────────────────

// Create a virtual account request. NGN is issued INSTANTLY (response carries
// status:"approved" + accountNumber + accountInformation). USD/EUR/GBP (FCY) are
// ASYNC: response is status:"pending" / accountNumber:null and the real details
// arrive via the virtualaccount.issued webhook.
//   currency     "NGN" | "USD" | ...
//   accountType  "individual" | "corporate"
//   KYCInformation  currency/type-specific KYC block (see docs/FINCRA_USD_ACCOUNT_SPEC.md)
//   channel        optional NGN partner-bank id ("wema" | "globus" | ...)
//   merchantReference  our idempotency ref
async function createVirtualAccount({ currency, accountType = "individual", KYCInformation, documents, channel, merchantReference }) {
  // NOTE: no `business` field — the virtual-accounts endpoint identifies the
  // merchant via the api-key and rejects a `business` in the body ("business is
  // not allowed"). Only the payout/wallets endpoints take a businessID.
  const payload = {
    currency,
    accountType,
    KYCInformation,
    ...(documents ? { documents } : {}),
    ...(channel ? { channel } : {}),
    ...(merchantReference ? { merchantReference } : {}),
  };
  return fincraFetch("/profile/virtual-accounts/requests", { method: "POST", body: payload });
}

// Convenience: instant NGN permanent account (BVN-based individual).
function createNgnAccount({ firstName, lastName, bvn, email, channel, merchantReference }) {
  return createVirtualAccount({
    currency: "NGN",
    accountType: "individual",
    channel,
    merchantReference,
    KYCInformation: { firstName, lastName, bvn, ...(email ? { email } : {}) },
  });
}

function getVirtualAccount(id) {
  return fincraFetch(`/profile/virtual-accounts/${encodeURIComponent(id)}`);
}

function listVirtualAccounts({ currency } = {}) {
  const q = currency ? `?currency=${encodeURIComponent(currency)}` : "";
  return fincraFetch(`/profile/virtual-accounts/${q}`);
}

// ── Balances / banks / payouts ──────────────────────────────────────────────
// Wallet balances for a business. GET /wallets?businessID= → data[] of
// { currency, availableBalance, ledgerBalance, walletNumber, ... }. (Confirmed.)
function getWallets(businessId = process.env.FINCRA_BUSINESS_ID) {
  return fincraFetch(`/wallets?businessID=${encodeURIComponent(businessId || "")}`);
}

// Bank list for a currency. GET /core/banks?currency=NGN → data[] of
// { code, nibssCode, name, id }. Use `code` as the payout bankCode. (Confirmed.)
function getBanks(currency = "NGN") {
  return fincraFetch(`/core/banks?currency=${encodeURIComponent(currency)}`);
}

// Name enquiry / account resolution. POST /core/accounts/resolve → data.accountName.
// (Confirmed — returns success + data:null for an unresolved account.)
function resolveAccount({ accountNumber, bankCode, currency = "NGN" }) {
  return fincraFetch("/core/accounts/resolve", {
    method: "POST",
    body: { accountNumber, bankCode, type: "nuban", currency },
  });
}

// List collections (inbound credits) for the merchant. GET /collections?business=
// → data:{ results:[...], total }. Used by the reconcile backstop to backfill any
// credit whose webhook never arrived. Fincra requires `business`; accepts
// `perPage` + `page` (NOT currency/limit/status — filter those client-side). One
// call returns collections across all currencies, each item carrying its own.
function listCollections({ business = process.env.FINCRA_BUSINESS_ID, perPage = 50, page } = {}) {
  const q = new URLSearchParams({ business: business || "" });
  if (perPage) q.set("perPage", String(perPage));
  if (page) q.set("page", String(page));
  return fincraFetch(`/collections?${q.toString()}`);
}

// List disbursements/payouts for the merchant. GET /disbursements/payouts?business=
// → data:{ results:[...], total, nextCursor }. Items carry customerReference (our
// ref), status, amountSent, beneficiaryName, fee. Used by the payout reconcile to
// resolve sends whose settlement we lost to a timeout. Cursor-paginated.
function listPayouts({ business = process.env.FINCRA_BUSINESS_ID, perPage = 100, cursor } = {}) {
  const q = new URLSearchParams({ business: business || "" });
  if (perPage) q.set("perPage", String(perPage));
  if (cursor) q.set("cursor", String(cursor));
  return fincraFetch(`/disbursements/payouts?${q.toString()}`);
}

// Create a bank-account payout. Endpoint CONFIRMED: POST /disbursements/payouts
// (sandbox 422 "amount is required" on a partial body confirms the route).
// Body: { business, sourceCurrency, destinationCurrency, amount, description,
//   paymentDestination:"bank_account", customerReference,
//   beneficiary:{ firstName, lastName, accountHolderName, type, accountNumber,
//                 bankCode, country? } }.
// ⚠️ A fully-successful payout still needs a funded sandbox wallet to verify.
function createPayout(payload) {
  return fincraFetch("/disbursements/payouts", { method: "POST", body: payload });
}

// ── Webhook verification (fail-closed) ──────────────────────────────────────
// Fincra signs webhooks with HMAC-SHA512 over the raw request body using the
// webhook secret, delivered in the `signature` header. Timing-safe compare.
// ⚠️ VERIFY against the live dashboard: exact header name + whether the signed
// string is the raw body or JSON.stringify({event,data}) — the docs were
// inconsistent. This implements raw-body HMAC-SHA512.
function verifyWebhookSignature(rawBody, signatureHeader) {
  const secret = WEBHOOK_SECRET();
  if (!secret || !signatureHeader) return false;
  const expected = crypto
    .createHmac("sha512", secret)
    .update(typeof rawBody === "string" ? rawBody : JSON.stringify(rawBody))
    .digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signatureHeader));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = {
  isConfigured,
  fincraFetch,
  createVirtualAccount,
  createNgnAccount,
  getVirtualAccount,
  listVirtualAccounts,
  getWallets,
  getBanks,
  resolveAccount,
  createPayout,
  listCollections,
  listPayouts,
  verifyWebhookSignature,
  BASE,
};
