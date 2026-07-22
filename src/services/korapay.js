// Korapay client — the go-forward provider for non-Nigeria + USD (Nigeria runs on
// Anchor). Pooled merchant balance per currency (like Fincra): per-business
// "cash at bank" is OUR ledger, not the wallet. Sandbox-verified endpoints:
//
//   Auth        Authorization: Bearer <secret>
//   Balances    GET  /merchant/api/v1/balances        → data[CUR]{available_balance,pending_balance,issuing_balance?}
//   Name enq.   POST /merchant/api/v1/misc/banks/resolve {bank,account,currency} → data.account_name
//   Payout      POST /merchant/api/v1/transactions/disburse
//   Banks       GET  /api/v1/misc/banks?countryCode=  (note the /api/v1 prefix, not /merchant)
//   Webhook     HMAC-SHA256 over the `data` object, header x-korapay-signature
//
// Env (server/.env): KORAPAY_BASE_URL, KORAPAY_SECRET_KEY, KORAPAY_PUBLIC_KEY,
// KORAPAY_ENCRYPTION_KEY. Amounts are MAJOR units (naira/cedi), 2 decimals.
const crypto = require("crypto");

const BASE = () => process.env.KORAPAY_BASE_URL || "https://api.korapay.com";
const SECRET = () => process.env.KORAPAY_SECRET_KEY;
const PUBLIC = () => process.env.KORAPAY_PUBLIC_KEY;

function isConfigured() {
  return !!SECRET();
}

// `path` includes its own prefix (/merchant/api/v1/…). `auth` selects the key:
// most endpoints use the SECRET key; a few public utilities (bank list) use the
// PUBLIC key and 401 on the secret.
async function korapayFetch(path, { method = "GET", body, auth = "secret" } = {}) {
  const token = auth === "public" ? PUBLIC() : SECRET();
  if (!token) throw new Error(`Korapay not configured (KORAPAY_${auth === "public" ? "PUBLIC" : "SECRET"}_KEY)`);
  const res = await fetch(`${BASE()}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  // Korapay wraps: { status: boolean, message, data }. Treat status:false as an error.
  if (!res.ok || data?.status === false) {
    const err = new Error(data?.message || `Korapay ${method} ${path} failed (${res.status})`);
    err.status = res.status;
    err.code = data?.code;
    err.body = data;
    throw err;
  }
  return data;
}

// Per-currency merchant balances (pooled). data[CUR] = { available_balance, pending_balance, issuing_balance? }.
function getBalances() {
  return korapayFetch("/merchant/api/v1/balances");
}

// Bank list for a country/currency (payout destinations). PUBLIC-key endpoint —
// it 401s on the secret key. → data:[{ name, slug, code, country, nibss_bank_code }]
// (253 NG banks). `code` is the payout bank code used by resolveAccount + disburse.
function getBanks({ countryCode = "NG", currency } = {}) {
  const q = new URLSearchParams();
  if (countryCode) q.set("countryCode", countryCode);
  if (currency) q.set("currency", currency);
  return korapayFetch(`/merchant/api/v1/misc/banks?${q.toString()}`, { auth: "public" });
}

// Name enquiry → data.account_name (or status:false / code AA027 for an invalid account).
function resolveAccount({ bank, account, currency = "NGN" }) {
  return korapayFetch("/merchant/api/v1/misc/banks/resolve", {
    method: "POST",
    body: { bank, account, currency },
  });
}

// Bank-account (or mobile-money) payout. `payload` is Korapay's disburse body:
//   { reference, destination:{ type:"bank_account", amount:"100.00", currency, narration,
//     bank_account:{ bank, account }, customer:{ email, name } } }
// Response data: { amount, fee, currency, status:"processing"|"success"|"failed", reference }.
function createPayout(payload) {
  return korapayFetch("/merchant/api/v1/transactions/disburse", { method: "POST", body: payload });
}

// Query a payout's authoritative status (use after a timeout — Korapay explicitly
// says do NOT treat 502/504 as failed; requery instead). → data{ reference, status,
// amount, fee, currency, narration, completion_date, message, customer, metadata }.
function getPayout(reference) {
  return korapayFetch(`/merchant/api/v1/transactions/${encodeURIComponent(reference)}`);
}

// ── Reconcile feeds (sandbox-verified shapes) ────────────────────────────────
// Money-IN list. → data{ has_more, payins:[{ reference:"KPY-PAY-…", status:"success",
// amount, amount_paid, fee, currency, payment_method:"virtual_bank_account",
// pointer, description, date_created }] }. The list has NO account_number — fetch
// getCharge(reference) for that (attribution).
function listPayins({ page = 1, limit = 50 } = {}) {
  return korapayFetch(`/merchant/api/v1/pay-ins?page=${page}&limit=${limit}`);
}

// Full pay-in detail incl. the receiving account. → data{ reference, status,
// amount, amount_paid, currency, description, transaction_date, customer{name,email},
// virtual_bank_account{ account_number, account_name, account_reference },
// payer_bank_account }. This is the same shape the charge.success webhook delivers.
function getCharge(reference) {
  return korapayFetch(`/merchant/api/v1/charges/${encodeURIComponent(reference)}`);
}

// Money-OUT list. → data{ has_more, payouts:[{ reference, status, amount, fee,
// currency, narration, payment_destination, customer_name, trace_id, message }] }.
function listPayouts({ page = 1, limit = 50 } = {}) {
  return korapayFetch(`/merchant/api/v1/payouts?page=${page}&limit=${limit}`);
}

// ── NGN local virtual account (one-call, sandbox-verified) ───────────────────
// The classic Korapay pay-in VBA: a SINGLE call issues a permanent NGN account
// (no account-holder 2-step — that's USD/FCY only). Sandbox requires bank_code
// "000" (the test bank); a live account uses its assigned sponsor-bank code
// (KORAPAY_VBA_BANK_CODE). `account_reference` is OUR idempotency key and is what
// getVirtualBankAccount(reference) looks the account up by (recovery path).
//   body: { account_name, account_reference, permanent:true, bank_code,
//           customer:{ name, email }, kyc:{ bvn } }
//   data: { account_number, bank_name, bank_code, account_name, account_reference,
//           unique_id, account_status:"active", currency:"NGN" }
function createNairaVirtualAccount({ accountName, accountReference, bankCode, customerName, customerEmail, bvn } = {}) {
  return korapayFetch("/merchant/api/v1/virtual-bank-account", {
    method: "POST",
    body: {
      account_name: accountName,
      account_reference: accountReference,
      permanent: true,
      bank_code: bankCode,
      customer: { name: customerName, email: customerEmail },
      kyc: { bvn },
    },
  });
}

// ── USD (FCY) virtual accounts ──────────────────────────────────────────────
// KYC-heavy, 2-step, BETA-gated. All under /merchant/api/v1 (the docs' /api/v1
// prefix returns a landing page). Endpoints confirmed to exist by probe; the
// REQUEST/RESPONSE field shapes are from the docs and MUST be re-confirmed against
// a real response once Korapay enables the USD account beta on the account.

// Pre-signed upload URL for a KYC document. → data{ url, file_reference }.
function generateUploadUrl({ fileName, contentType } = {}) {
  return korapayFetch("/merchant/api/v1/files/generate-upload-url", {
    method: "POST",
    body: { file_name: fileName, content_type: contentType },
  });
}

// Create the account holder (the individual the USD account belongs to). Heavy
// KYC + uploaded document file_references. → data.reference + data.status
// ("pending" | "approval" | "suspended" | "deactivated").
function createAccountHolder(payload) {
  return korapayFetch("/merchant/api/v1/virtual-bank-account/account-holders", { method: "POST", body: payload });
}
function getAccountHolder(reference) {
  return korapayFetch(`/merchant/api/v1/virtual-bank-account/account-holders/${encodeURIComponent(reference)}`);
}

// Create the virtual account (once the holder is approved). `permanent` is
// REQUIRED true (per endpoint probe). USD returns ACH/SWIFT/FedWire details as
// account_status goes pending → active (delivered via webhook).
function createVirtualBankAccount({ currency, accountHolderReference, accountReference, accountName } = {}) {
  return korapayFetch("/merchant/api/v1/virtual-bank-account", {
    method: "POST",
    body: {
      currency,
      permanent: true,
      account_holder_reference: accountHolderReference,
      account_reference: accountReference,
      ...(accountName ? { account_name: accountName } : {}),
    },
  });
}
function getVirtualBankAccount(reference) {
  return korapayFetch(`/merchant/api/v1/virtual-bank-account/${encodeURIComponent(reference)}`);
}

// Webhook auth: HMAC-SHA256 over the `data` object ONLY, header x-korapay-signature.
// `data` is the parsed payload.data. Timing-safe compare.
function verifyWebhookSignature(dataObject, signatureHeader) {
  const secret = SECRET();
  if (!secret || !signatureHeader || dataObject == null) return false;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(typeof dataObject === "string" ? dataObject : JSON.stringify(dataObject))
    .digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signatureHeader));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = {
  isConfigured,
  korapayFetch,
  getBalances,
  getBanks,
  resolveAccount,
  createPayout,
  getPayout,
  listPayins,
  getCharge,
  listPayouts,
  createNairaVirtualAccount,
  generateUploadUrl,
  createAccountHolder,
  getAccountHolder,
  createVirtualBankAccount,
  getVirtualBankAccount,
  verifyWebhookSignature,
  BASE,
  PUBLIC,
};
