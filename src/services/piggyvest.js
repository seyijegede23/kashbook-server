// PiggyVest Business client — the savings partner behind `piggyvest` pots.
//
// One PiggyVest customer per KashBook business, one PiggyVest wallet per pot.
// A pot is funded by a bank transfer from the merchant's own Anchor account to
// the wallet's reserved account number, earns interest daily, and is withdrawn
// by a bank transfer from the wallet back to the merchant's NUBAN. KashBook
// never holds the money: it goes Anchor → PiggyVest → Anchor.
//
// Env (server/.env):
//   PVB_SECRET_KEY     Bearer secret from the PiggyVest Business dashboard. Also
//                      the HMAC key for webhook signatures (their design).
//   PVB_BASE_URL       https://api.piggyvest.business (default). Test and live
//                      keys are told apart by the key, not the host.
//   PVB_WEBHOOK_DEBUG  "true" logs each webhook's raw payload for the first
//                      weeks, because their eventData shapes are undocumented.
//
// API facts this file relies on (docs.piggyvest.business, read 2026-09-29):
//   • JSON, `Authorization: Bearer <secret>`, money in KOBO integers,
//     errors `{ status: false, message }`, async operations answer 202.
//   • POST /api/v1/customers { bvn, name, email, phone,
//       third_party_identifier } ?returnIfExist=true
//       → { customer_id, wallet_id, new_customer }
//   • POST /api/v1/wallet/sub-account { subaccount_name,
//       reserve_virtual_account: true, customer_id, enable_interest_accrual }
//       → { id }; finished by create-wallet.success then
//       reserve_virtual_account.success webhooks.
//   • GET /api/v1/wallet/:id → balance, withdrawal_count,
//       current_interest_rate, status
//   • GET /api/v1/wallet/:id/accounts → reserved funding account numbers
//   • POST /api/v1/transfer/bank { amount, source, currency, reference,
//       accountNumber, bankCode, narration } → 202, `reference` echoed in
//       webhooks; final state by bank-transfer.outflow.success|failed or
//       GET /api/v1/transaction/verify?reference=
//   • GET /api/v1/wallet/interests/accrued/:id → daily accrual rows
//   • Webhook header x-pvb-signature = HMAC-SHA512 hex of
//       JSON.stringify(body) keyed with the secret key
//   • Test mode: POST /api/v1/transfer/test/funding { wallet_id, amount }
//
// Undocumented, confirmed only by running against their sandbox: fees and who
// bears them, what a duplicate `reference` on /transfer/bank does, the exact
// eventData shapes. Everything that decides money in this codebase therefore
// GETs the wallet or the transaction with our own key rather than trusting a
// payload; the webhook only says which row to re-check.
const crypto = require("crypto");

const BASE = () => (process.env.PVB_BASE_URL || "https://api.piggyvest.business").replace(/\/+$/, "");
const SECRET = () => process.env.PVB_SECRET_KEY;

function isConfigured() {
  return !!SECRET();
}

// PiggyVest has one host; test and live are separated by the KEY. There is no
// sandbox hostname to check, so "live" here means "pointed at their real API",
// which validateEnv uses to refuse an unexpected host in production.
function isLive() {
  try {
    return new URL(BASE()).hostname.toLowerCase() === "api.piggyvest.business";
  } catch {
    return false;
  }
}

// Only transport and server-side failures are worth another attempt: a 4xx will
// fail identically forever. Same rule as services/fincra.js.
function isTransient(err) {
  if (err?.status) return err.status >= 500 || err.status === 429;
  const s = `${err?.code || ""} ${err?.message || ""} ${err?.cause?.code || ""}`.toLowerCase();
  return /fetch failed|etimedout|econnreset|econnrefused|enotfound|eai_again|socket hang up|network/.test(s);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// `attempts` defaults to 1. Only reads and the idempotent customer create pass
// more, because a retried wallet create or bank transfer could double-act:
// PiggyVest documents no duplicate-reference semantics for /transfer/bank.
async function pvbFetch(path, { method = "GET", body, attempts = 1, timeoutMs = 20000 } = {}) {
  if (!isConfigured()) {
    const err = new Error("PiggyVest not configured (PVB_SECRET_KEY)");
    err.code = "PVB_NOT_CONFIGURED";
    throw err;
  }
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await pvbFetchOnce(path, { method, body, timeoutMs });
    } catch (err) {
      lastErr = err;
      if (attempt === attempts || !isTransient(err)) throw err;
      const waitMs = 400 * attempt;
      console.warn(`[piggyvest] ${method} ${path} transient failure (${err.code || err.status || err.message}) — retry ${attempt}/${attempts - 1} in ${waitMs}ms`);
      await sleep(waitMs);
    }
  }
  throw lastErr;
}

async function pvbFetchOnce(path, { method, body, timeoutMs }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`${BASE()}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${SECRET()}`,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: ctrl.signal,
    });
  } catch (e) {
    // An abort is a timeout: the request MAY have reached PiggyVest. Callers on
    // money paths treat this as "unknown", never as "did not happen".
    if (e?.name === "AbortError") {
      const err = new Error(`PiggyVest ${method} ${path} timed out after ${timeoutMs}ms`);
      err.code = "ETIMEDOUT";
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  // Their envelope carries its own boolean; a 200 with status:false is still a
  // failure and must not read as success.
  if (!res.ok || data?.status === false) {
    const msg = data?.message || data?.error || `PiggyVest ${method} ${path} failed (${res.status})`;
    const err = new Error(msg);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

const toKoboInt = (naira) => Math.round((Number(naira) || 0) * 100);
const fromKobo = (kobo) => Math.round(Number(kobo) || 0) / 100;

// ── Customers ────────────────────────────────────────────────────────────────

// Idempotent by `returnIfExist`: a retry after a transient failure returns the
// existing customer instead of creating a second one. `thirdPartyId` is our
// user id, so the customer can be found again from our side.
async function createCustomer({ bvn, name, email, phone, thirdPartyId }) {
  const res = await pvbFetch("/api/v1/customers?returnIfExist=true", {
    method: "POST",
    body: { bvn, name, email, phone, third_party_identifier: thirdPartyId },
    attempts: 3,
  });
  const d = res?.data || res || {};
  return {
    customerId: d.customer_id || d.customerId || d.id || null,
    walletId: d.wallet_id || d.walletId || null,
    newCustomer: d.new_customer ?? null,
    raw: d,
  };
}

// ── Wallets ──────────────────────────────────────────────────────────────────

// SINGLE ATTEMPT. Wallet creation is asynchronous (202) and completes by
// webhook; a retried create would open a second wallet for the same pot.
async function createSubAccount({ name, customerId, enableInterest = true }) {
  const res = await pvbFetch("/api/v1/wallet/sub-account", {
    method: "POST",
    body: {
      subaccount_name: name,
      reserve_virtual_account: true,
      customer_id: customerId,
      enable_interest_accrual: enableInterest,
    },
    attempts: 1,
  });
  const d = res?.data || res || {};
  return { walletId: d.id || d.wallet_id || d.walletId || null, raw: d };
}

async function getWallet(walletId) {
  const res = await pvbFetch(`/api/v1/wallet/${encodeURIComponent(walletId)}`, { attempts: 3 });
  const d = res?.data || res || {};
  return {
    walletId: d.id || walletId,
    balance: fromKobo(d.balance ?? d.available_balance ?? 0),
    withdrawalCount: Number(d.withdrawal_count ?? d.withdrawalCount ?? 0),
    interestRate: d.current_interest_rate != null ? Number(d.current_interest_rate) : null,
    status: d.status ?? null,
    raw: d,
  };
}

// Reserved funding accounts for a wallet. Their bank name is the rail's bank
// (VFD MFB / Paystack-Titan; "FAAS (SANDBOX)" in test) and the caller resolves
// it to an Anchor bank code before the pot can be funded.
async function getWalletAccounts(walletId) {
  const res = await pvbFetch(`/api/v1/wallet/${encodeURIComponent(walletId)}/accounts`, { attempts: 3 });
  const list = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : res?.data ? [res.data] : [];
  return list
    .map((a) => ({
      accountNumber: String(a.account_number || a.accountNumber || "").trim(),
      accountName: a.account_name || a.accountName || null,
      bankName: a.bank_name || a.bankName || a.bank || null,
      bankCode: a.bank_code || a.bankCode || null,
      raw: a,
    }))
    .filter((a) => /^\d{10}$/.test(a.accountNumber));
}

// ── Transfers ────────────────────────────────────────────────────────────────

// SINGLE ATTEMPT, and the caller must have claimed its movement row BEFORE
// calling. A 202 means "accepted", not "paid": the outcome comes from
// verifyTransaction. A thrown timeout means "unknown", never "not sent".
async function transferToBank({ walletId, amount, accountNumber, bankCode, reference, narration }) {
  const res = await pvbFetch("/api/v1/transfer/bank", {
    method: "POST",
    body: {
      amount: toKoboInt(amount),
      source: walletId,
      currency: "NGN",
      reference,
      accountNumber,
      bankCode,
      narration: (narration || "KashBook savings withdrawal").slice(0, 100),
    },
    attempts: 1,
    timeoutMs: 30000,
  });
  const d = res?.data || res || {};
  return { reference: d.reference || reference, pvReference: d.transaction_reference || d.id || null, raw: d };
}

// PiggyVest's own bank list (the codes /transfer/bank accepts). Cached for a
// day in process memory, like Anchor's list.
let banksCache = { value: null, expires: 0 };
async function getBanks() {
  if (banksCache.value && banksCache.expires > Date.now()) return banksCache.value;
  const res = await pvbFetch("/api/v1/transfer/banks", { attempts: 3 });
  const items = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : [];
  const list = items
    .map((b) => ({ code: String(b.code || b.bank_code || b.id || ""), name: b.name || b.bank_name || "" }))
    .filter((b) => b.code && b.name);
  if (list.length) banksCache = { value: list, expires: Date.now() + 24 * 60 * 60 * 1000 };
  return list;
}

// Name enquiry on a destination, as PiggyVest's rail sees it. Used before a
// withdrawal so a wrong bank-code mapping is caught by the NAME, not by money
// arriving at a stranger's account.
async function nameEnquiry({ bankCode, accountNumber }) {
  const res = await pvbFetch(
    `/api/v1/transfer/name-enquiry?bank_code=${encodeURIComponent(bankCode)}&account_number=${encodeURIComponent(accountNumber)}`,
    { attempts: 3 },
  );
  const d = res?.data || res || {};
  return { accountName: d.account_name || d.accountName || d.name || null, raw: d };
}

// Normalise their status words into four outcomes the state machine
// understands. Anything unrecognised is `pending`, never `success`.
function normaliseTransferStatus(s) {
  const v = String(s || "").toLowerCase();
  if (["success", "successful", "completed", "paid", "settled"].includes(v)) return "success";
  if (["failed", "failure", "reversed", "declined", "rejected", "cancelled", "canceled"].includes(v)) return "failed";
  return "pending";
}

// { status: success|pending|failed|not_found, amount, fee, txnId, raw }
async function verifyTransaction(reference) {
  let res;
  try {
    res = await pvbFetch(`/api/v1/transaction/verify?reference=${encodeURIComponent(reference)}`, { attempts: 3 });
  } catch (e) {
    if (e.status === 404) return { status: "not_found", raw: e.body || null };
    throw e;
  }
  const d = res?.data || res || {};
  if (!d || (typeof d === "object" && Object.keys(d).length === 0)) return { status: "not_found", raw: d };
  return {
    status: normaliseTransferStatus(d.status || d.transaction_status || d.state),
    amount: fromKobo(d.amount ?? 0),
    fee: fromKobo(d.fee ?? d.charge ?? 0),
    txnId: d.id || d.transaction_id || d.reference || null,
    raw: d,
  };
}

// Credits into a wallet (funding inflows, interest payouts). Path per their
// transactions docs; the reconcile loop tolerates either a `data` array or a
// paginated `data.items` shape and reads only the fields it needs.
async function listCreditTransactions(walletId, { limit = 50 } = {}) {
  const res = await pvbFetch(
    `/api/v1/wallet/${encodeURIComponent(walletId)}/transactions?type=credit&limit=${limit}`,
    { attempts: 3 },
  );
  const items = Array.isArray(res?.data) ? res.data
    : Array.isArray(res?.data?.items) ? res.data.items
    : Array.isArray(res?.data?.data) ? res.data.data
    : [];
  return items.map((t) => ({
    id: String(t.id || t.transaction_id || t.reference || ""),
    amount: fromKobo(t.amount ?? 0),
    reference: t.reference || t.transaction_reference || null,
    narration: t.narration || t.description || t.remark || "",
    category: String(t.category || t.type || t.transaction_type || "").toLowerCase(),
    senderAccount: t.sender_account_number || t.source_account_number || t.originator_account_number || null,
    createdAt: t.created_at || t.createdAt || t.date || null,
    raw: t,
  })).filter((t) => t.id);
}

// Daily accrual rows for a wallet, optionally within a date range.
async function getAccruedInterest(walletId, { from, to } = {}) {
  const qs = new URLSearchParams();
  if (from) qs.set("from", from);
  if (to) qs.set("to", to);
  const q = qs.toString();
  const res = await pvbFetch(
    `/api/v1/wallet/interests/accrued/${encodeURIComponent(walletId)}${q ? `?${q}` : ""}`,
    { attempts: 3 },
  );
  const items = Array.isArray(res?.data) ? res.data
    : Array.isArray(res?.data?.items) ? res.data.items
    : Array.isArray(res?.data?.data) ? res.data.data
    : [];
  return items.map((r) => ({
    amount: fromKobo(r.amount ?? r.interest ?? 0),
    balance: fromKobo(r.balance ?? 0),
    rate: r.interest_percentage != null ? Number(r.interest_percentage) : r.rate != null ? Number(r.rate) : null,
    date: r.accrual_date || r.date || r.created_at || null,
    raw: r,
  }));
}

// Test-mode funding. Refuses when pointed at live, because there is no
// sandbox host to protect us: only the key says which mode we are in.
async function testFunding({ walletId, amount }) {
  if (process.env.NODE_ENV === "production") {
    const err = new Error("testFunding is refused in production");
    err.code = "PVB_TEST_ONLY";
    throw err;
  }
  return pvbFetch("/api/v1/transfer/test/funding", {
    method: "POST",
    body: { wallet_id: walletId, amount: toKoboInt(amount) },
    attempts: 1,
  });
}

// ── Webhooks ─────────────────────────────────────────────────────────────────

// HMAC-SHA512 hex over the raw bytes we received; on mismatch, over the
// compact re-serialisation of the parsed body (their docs say they sign
// JSON.stringify(body), so a proxy that re-indents the JSON would otherwise
// break verification). Constant-time compare; any failure is false.
function verifyWebhookSignature(rawBody, header) {
  const secret = SECRET();
  if (!secret || !header) return false;
  const provided = String(header).trim().toLowerCase();
  if (!/^[0-9a-f]{128}$/.test(provided)) return false;
  const raw = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody ?? ""), "utf8");
  const candidates = [raw];
  try {
    candidates.push(Buffer.from(JSON.stringify(JSON.parse(raw.toString("utf8"))), "utf8"));
  } catch { /* not JSON: raw only */ }
  const want = Buffer.from(provided, "hex");
  for (const c of candidates) {
    const got = crypto.createHmac("sha512", secret).update(c).digest();
    if (got.length === want.length && crypto.timingSafeEqual(got, want)) return true;
  }
  return false;
}

module.exports = {
  isConfigured,
  isLive,
  isTransient,
  pvbFetch,
  createCustomer,
  createSubAccount,
  getWallet,
  getWalletAccounts,
  getBanks,
  nameEnquiry,
  transferToBank,
  verifyTransaction,
  normaliseTransferStatus,
  listCreditTransactions,
  getAccruedInterest,
  testFunding,
  verifyWebhookSignature,
  toKoboInt,
  fromKobo,
};
