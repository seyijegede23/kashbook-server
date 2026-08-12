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

// Only `api-key` is mandated for API requests; `x-pub-key` is not required on
// the endpoints we use. Requiring both made an account provisioned without a
// public key report itself as unconfigured.
function isConfigured() {
  return !!SECRET();
}

// Is this failure worth another attempt?
//
// undici intermittently throws a bare, code-less "fetch failed" against
// Cloudflare-fronted hosts (the same class of failure that forced the native
// https + family:4 workaround in sms/sendchamp.js). It cost a merchant their
// account during a Tanzania provisioning test: the first call died with "fetch
// failed" and left the business with no account, while an identical retry
// seconds later succeeded.
//
// Only TRANSPORT and SERVER-SIDE failures qualify. A 4xx is a bad request and
// will fail identically forever, so retrying it just delays the error.
function isTransient(err) {
  if (err?.status) return err.status >= 500 || err.status === 429;
  const s = `${err?.code || ""} ${err?.message || ""} ${err?.cause?.code || ""}`.toLowerCase();
  return /fetch failed|etimedout|econnreset|econnrefused|enotfound|eai_again|socket hang up|network/.test(s);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fincraFetch(path, { method = "GET", body, attempts = 3 } = {}) {
  if (!isConfigured()) throw new Error("Fincra not configured (FINCRA_SECRET_KEY / FINCRA_PUBLIC_KEY)");
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fincraFetchOnce(path, { method, body });
    } catch (err) {
      lastErr = err;
      if (attempt === attempts || !isTransient(err)) throw err;
      // Retrying a create is safe because merchantReference is deterministic
      // (`kb_<businessId>`): if the first attempt did reach Fincra, the retry
      // returns 409 duplicate, which provisioning already recovers from by
      // re-fetching the existing account. Without that, a retry could double-issue.
      const waitMs = 400 * attempt;
      console.warn(`[fincra] ${method} ${path} transient failure (${err.code || err.status || err.message}) — retry ${attempt}/${attempts - 1} in ${waitMs}ms`);
      await sleep(waitMs);
    }
  }
  throw lastErr;
}

async function fincraFetchOnce(path, { method = "GET", body } = {}) {
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
    // errorType distinguishes cases that must be handled differently:
    //   NO_ENOUGH_MONEY_IN_WALLET → user-actionable
    //   SERVICE_UNAVAILABLE       → requery, never fail the user (money may move)
    //   ACCESS_DENIED             → 403, request never reached the engine, no money moved
    err.errorType = data?.errorType || null;
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
// NGN partner banks Fincra currently issues on. `bold` and `providus` are
// disabled and `opay` is "coming soon"; note `habari` IS Guaranty Trust Bank,
// the value is not the bank's name. Forwarding an unvalidated channel produces
// an opaque provider error, so pin it here.
const NGN_CHANNELS = ["globus", "wema", "habari", "sterling", "moniepoint", "uba"];

async function createVirtualAccount({
  currency, accountType = "individual", KYCInformation, channel, merchantReference,
  // FCY document URLs are TOP-LEVEL keys. There is no `documents` field in the
  // Fincra API; the previous code spread one, which the API would reject.
  meansOfId, utilityBill, bankStatement,
  monthlyTransactionCount, monthlyTransactionVolume,
}) {
  if (channel && !NGN_CHANNELS.includes(channel)) {
    throw new Error(`Unsupported Fincra channel "${channel}" (allowed: ${NGN_CHANNELS.join(", ")})`);
  }
  // NOTE: no `business` field — the virtual-accounts endpoint identifies the
  // merchant via the api-key and rejects a `business` in the body ("business is
  // not allowed"). Only the payout/wallets endpoints take a businessID.
  const payload = {
    currency,
    accountType,
    KYCInformation,
    ...(meansOfId ? { meansOfId } : {}),
    ...(utilityBill ? { utilityBill } : {}),
    ...(bankStatement ? { bankStatement } : {}),
    ...(monthlyTransactionCount != null ? { monthlyTransactionCount: String(monthlyTransactionCount) } : {}),
    ...(monthlyTransactionVolume != null ? { monthlyTransactionVolume: String(monthlyTransactionVolume) } : {}),
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
// credit whose webhook never arrived.
//
// Filtering IS supported, contrary to the previous comment here: the documented
// parameters are `virtualAccount` and `destinationCurrency`. The likely reason an
// earlier attempt failed is that the currency parameter is NOT called `currency`.
//
// ⚠️ Two doc pages disagree on what `virtualAccount` takes: one calls it the
// "virtual account number", another "the ID of the multicurrency account".
// Passing the wrong one most likely returns an EMPTY result rather than an
// error, which a reconcile would read as "no deposits". Prefer the unfiltered
// merchant-wide sweep until that is confirmed against a real response.
function listCollections({
  business = process.env.FINCRA_BUSINESS_ID, perPage = 50, page,
  virtualAccount, destinationCurrency,
} = {}) {
  const q = new URLSearchParams({ business: business || "" });
  if (perPage) q.set("perPage", String(perPage));
  if (page) q.set("page", String(page));
  if (virtualAccount) q.set("virtualAccount", String(virtualAccount));
  if (destinationCurrency) q.set("destinationCurrency", String(destinationCurrency));
  return fincraFetch(`/collections?${q.toString()}`);
}

// Requests for additional information (RFI) on a collection. Fincra's guidance:
// the webhook's additionalInfo array may be incomplete, so always re-read this.
// Unanswered RFIs cause the money to be returned to the sender with a fee.
function getCollectionRfis(collectionId) {
  return fincraFetch(`/collections/${encodeURIComponent(collectionId)}/additional-information`);
}

// Respond to an RFI. `body` carries the answers/document URLs Fincra asked for.
function respondToCollectionRfi(collectionId, body) {
  return fincraFetch(`/collections/${encodeURIComponent(collectionId)}/additional-information`, {
    method: "PATCH",
    body,
  });
}

// Chargebacks are NOT delivered by webhook anywhere in Fincra's docs, yet they
// debit the merchant wallet directly (plus 15 EUR / 35 USD in fees). Polling is
// the only way to detect one, so the reconcile loop must check this.
function listChargebacks({ business = process.env.FINCRA_BUSINESS_ID } = {}) {
  return fincraFetch(`/collections/chargebacks?business=${encodeURIComponent(business || "")}`);
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
  getCollectionRfis,
  respondToCollectionRfi,
  listChargebacks,
  listPayouts,
  verifyWebhookSignature,
  BASE,
};
