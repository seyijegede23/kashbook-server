/**
 * Anchor (getanchor.co) BaaS HTTP client.
 *
 * Env:
 *   ANCHOR_BASE_URL        Sandbox: https://api.sandbox.getanchor.co/api/v1
 *                          Live:    https://api.getanchor.co/api/v1
 *   ANCHOR_API_KEY         Bearer-style API key (header: x-anchor-key)
 *   ANCHOR_WEBHOOK_SECRET  Shared signing secret set on the Anchor dashboard
 *
 * KEY FLOW (per Anchor support + docs):
 *   1. POST /customers  → Tier 0 IndividualCustomer (name/email/phone/address)
 *   2. POST /customers/{id}/verification/individual → ASYNC Tier 1 KYC
 *      Body: { data: { type: "Verification", attributes: { level: "TIER_2",
 *                                                          level2: { bvn, dateOfBirth, gender } } } }
 *      ⚠ "level: TIER_2" with "level2.bvn" is counterintuitive but that IS
 *      what Anchor accepts — confirmed by their support team.
 *   3. Wait for webhook customer.identification.approved
 *   4. POST /accounts → DepositAccount (productName: SAVINGS or CURRENT)
 *   5. Wait for webhook account.opened (returns accountNumber)
 *
 * IMPORTANT: For Tier 1 KYC to PASS, the customer's name + phone at creation
 * must match what NIBSS has on file for that BVN. Mismatches → rejected event.
 */

const crypto = require("crypto");

const BASE = () => process.env.ANCHOR_BASE_URL;
const API_KEY = () => process.env.ANCHOR_API_KEY;
const WEBHOOK_SECRET = () => process.env.ANCHOR_WEBHOOK_SECRET;

function ensureConfigured() {
  if (!BASE() || !API_KEY()) {
    const err = new Error("Anchor is not configured on this server.");
    err.code = "ANCHOR_NOT_CONFIGURED";
    throw err;
  }
}

async function anchorFetch(path, { method = "GET", body } = {}) {
  ensureConfigured();
  const res = await fetch(`${BASE()}${path}`, {
    method,
    headers: {
      "x-anchor-key": API_KEY(),
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Anchor returned non-JSON (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    const errMsg =
      data.errors?.[0]?.detail ||
      data.errors?.[0]?.title ||
      data.message ||
      `Anchor request failed (${res.status})`;
    const err = new Error(errMsg);
    err.httpStatus = res.status;
    err.anchorErrors = data.errors;
    throw err;
  }
  return data;
}

// Anchor rejects phone numbers with "+" prefix — accept 234XXXXXXXXXX or
// 0XXXXXXXXXX. Normalize to local 0XXXXXXXXXX.
function normalizePhoneForAnchor(phone) {
  if (!phone) return "";
  const digits = String(phone).replace(/\D/g, "");
  if (digits.startsWith("234") && digits.length === 13) return "0" + digits.slice(3);
  if (digits.length === 10) return "0" + digits;
  return digits;
}

// ─── Business Customer creation ──────────────────────────────────────────────
// Each Business gets a BusinessCustomer on Anchor. The user is registered as
// the sole DIRECTOR/OWNER. The resulting deposit account's `accountName` is
// the business name (what we actually want shown to senders).
//
// All collected KYB fields are forwarded verbatim. Callers are expected to
// pass real, user-supplied values — there are no silent NG/Lagos defaults
// since live KYB review will reject placeholder data.
async function createBusinessCustomer({
  // Business
  businessName,
  businessBvn,            // BVN of the primary owner — sandbox reuses user BVN
  dateOfRegistration,     // YYYY-MM-DD
  description,            // free-text business description
  industry,               // e.g. "Retail-GeneralRetailers"
  registrationType,       // "Private_Incorporated" | "Business_Name" | "Sole_Proprietor"…
  website,
  // Business address
  businessAddress,        // { state, addressLine_1, addressLine_2?, city, postalCode? }
  // Director / Owner (the app user)
  user,                   // { firstName, lastName, email, phone, dateOfBirth, bvn }
  // Optional separate director residential address (defaults to businessAddress)
  directorAddress,
}) {
  const officerDob =
    user.dateOfBirth instanceof Date
      ? user.dateOfBirth.toISOString().slice(0, 10)
      : user.dateOfBirth;
  const regDate =
    dateOfRegistration instanceof Date
      ? dateOfRegistration.toISOString().slice(0, 10)
      : dateOfRegistration;
  const phone = normalizePhoneForAnchor(user.phone || "07000000000");

  const defaultAddress = {
    country: "NG",
    state: "Lagos",
    addressLine_1: "1 Marina Street",
    addressLine_2: "",
    city: "Lagos Island",
    postalCode: "100001",
  };
  const bizAddr = businessAddress
    ? {
        country: "NG",
        state: businessAddress.state,
        addressLine_1: businessAddress.addressLine_1,
        addressLine_2: businessAddress.addressLine_2 || "",
        city: businessAddress.city,
        postalCode: businessAddress.postalCode || "100001",
      }
    : defaultAddress;
  const dirAddr = directorAddress
    ? {
        country: "NG",
        state: directorAddress.state,
        addressLine_1: directorAddress.addressLine_1,
        addressLine_2: directorAddress.addressLine_2 || "",
        city: directorAddress.city,
        postalCode: directorAddress.postalCode || bizAddr.postalCode,
      }
    : bizAddr;

  const body = {
    data: {
      type: "BusinessCustomer",
      attributes: {
        address: { country: "NG", state: bizAddr.state },
        basicDetail: {
          industry: industry || "Retail",
          // Default to "Business_Name" — sandbox-friendly (single CAC BN cert)
          // vs "Private_Incorporated" which needs TIN + Cert of Inc + RC + MEMART.
          registrationType: registrationType || "Business_Name",
          country: "NG",
          businessName,
          businessBvn: businessBvn || user.bvn,
          dateOfRegistration: regDate || new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10),
          description: description || `${businessName} — small business using KashBook for bookkeeping and payments.`,
          website: website || "https://kashbook.app",
        },
        contact: {
          email: {
            general: user.email,
            support: user.email,
            dispute: user.email,
          },
          address: {
            main: bizAddr,
            registered: bizAddr,
          },
          phoneNumber: phone,
        },
        // Anchor requires BOTH a DIRECTOR (percentageOwned: 0) AND an OWNER
        // (percentageOwned >= 5) entry. The sole proprietor pattern duplicates
        // the same person as both. KYB rejects if total owner % is missing.
        officers: [
          {
            role: "DIRECTOR", 
            fullName: {
              firstName: user.firstName,
              lastName: user.lastName || user.firstName,
            },
            nationality: "NG",
            address: dirAddr,
            dateOfBirth: officerDob,
            email: user.email,
            phoneNumber: phone,
            bvn: user.bvn,
            title: "CEO",
            percentageOwned: 0,
          },
          {
            role: "OWNER",
            fullName: {
              firstName: user.firstName,
              lastName: user.lastName || user.firstName,
            },
            nationality: "NG",
            address: dirAddr,
            dateOfBirth: officerDob,
            email: user.email,
            phoneNumber: phone,
            bvn: user.bvn,
            title: "President",
            percentageOwned: 100,
          },
        ],
      },
    },
  };

  const res = await anchorFetch("/customers", { method: "POST", body });
  return {
    customerId: res.data?.id,
    status: res.data?.attributes?.verification?.status || "pending",
  };
}

// Search for an existing customer by phone, email, or BVN.
// Used to recover after a local DB wipe — Anchor still has the records.
async function searchCustomer({ searchValue, customerType = "IndividualCustomer" }) {
  if (!searchValue) return null;
  try {
    const res = await anchorFetch(
      `/customers/search?customerType=${encodeURIComponent(customerType)}&searchValue=${encodeURIComponent(searchValue)}`,
    );
    const list = Array.isArray(res.data) ? res.data : res.data ? [res.data] : [];
    if (!list.length) return null;
    return { customerId: list[0].id, raw: list[0] };
  } catch (e) {
    if (e.httpStatus === 404) return null;
    throw e;
  }
}

// ─── Manual KYC trigger (Tier 1 verification) ────────────────────────────────
// Per Anchor support: "After creating an individual customer, you are to
// trigger KYC Verification manually using this endpoint." Async — webhook
// `customer.identification.approved` / `.rejected` / `.error` follows.
async function triggerKYB(customerId) {
  return anchorFetch(`/customers/${customerId}/verification/business`, {
    method: "POST",
    body: { data: { type: "Verification", attributes: {} } },
  });
}

// ─── Deposit account ─────────────────────────────────────────────────────────
// Must be called AFTER customer.identification.approved fires.
// productName: "SAVINGS" (IndividualCustomer only) or "CURRENT" (both types).
// customerType: "BusinessCustomer" (default) or "IndividualCustomer"
// Anchor rejects SAVINGS on BusinessCustomer with "The product SAVINGS is not
// allowed for the selected customer type", so default by customer type.
async function createDepositAccount({ customerId, productName, customerType = "BusinessCustomer" }) {
  const product =
    productName ||
    (customerType === "BusinessCustomer" ? "CURRENT" : "SAVINGS");
  const body = {
    data: {
      type: "DepositAccount",
      attributes: { productName: product },
      relationships: {
        customer: { data: { type: customerType, id: customerId } },
      },
    },
  };
  const res = await anchorFetch("/accounts", { method: "POST", body });
  const attrs = res.data?.attributes ?? {};
  return {
    accountId: res.data?.id,
    accountNumber: attrs.accountNumber,
    accountName: attrs.accountName,
    bankName: attrs.bank?.name || "Anchor",
    raw: res.data,
  };
}

async function getAccountBalance(accountId) {
  const res = await anchorFetch(`/accounts/balance/${accountId}`);
  const attrs = res.data?.attributes ?? {};
  return {
    balance: Number(attrs.availableBalance ?? attrs.balance ?? 0),
    accountNumber: attrs.accountNumber,
  };
}

// List a customer's deposit accounts. Used by the sync-anchor-account endpoint
// to reconcile our DB after a missed webhook.
// Path: GET /accounts?customerId=... (per Anchor docs/reference/fetchaccounts)
async function listCustomerAccounts(customerId) {
  const res = await anchorFetch(
    `/accounts?customerId=${encodeURIComponent(customerId)}&size=20`,
  );
  return Array.isArray(res.data) ? res.data : res.data ? [res.data] : [];
}

// Fetch full account details — used by webhook handler when the event payload
// doesn't include the NUBAN.
async function getAccount(accountId) {
  const res = await anchorFetch(`/accounts/${accountId}`);
  const attrs = res.data?.attributes ?? {};
  return {
    accountNumber: attrs.accountNumber,
    accountName: attrs.accountName,
    bankName: attrs.bank?.name || "Anchor",
    raw: res.data,
  };
}

// ─── Banks ───────────────────────────────────────────────────────────────────
let banksCache = { value: null, expires: 0 };
async function getBanks() {
  if (banksCache.value && banksCache.expires > Date.now()) return banksCache.value;
  const res = await anchorFetch("/banks");
  const list = (res.data || []).map((b) => ({
    id: b.id,
    name: b.attributes?.name,
    code: b.attributes?.cbnCode || b.attributes?.code,
  }));
  banksCache = { value: list, expires: Date.now() + 24 * 60 * 60 * 1000 };
  return list;
}

// ─── Name enquiry ────────────────────────────────────────────────────────────
// Anchor uses path params: /payments/verify-account/{bankCode}/{accountNumber}
async function verifyCounterparty({ accountNumber, bankCode }) {
  const res = await anchorFetch(
    `/payments/verify-account/${encodeURIComponent(bankCode)}/${encodeURIComponent(accountNumber)}`,
  );
  const attrs = res.data?.attributes ?? {};
  return { accountName: attrs.accountName || attrs.name || "" };
}

// ─── Counterparty (recipient) ────────────────────────────────────────────────
// `bankId` here is Anchor's INTERNAL bank UUID (not the CBN code).
async function createCounterparty({ accountNumber, bankId, accountName }) {
  const body = {
    data: {
      type: "CounterParty",
      attributes: { accountName, accountNumber, verifyName: false },
      relationships: { bank: { data: { type: "Bank", id: bankId } } },
    },
  };
  const res = await anchorFetch("/counterparties", { method: "POST", body });
  return { counterpartyId: res.data?.id };
}

// ─── Transfer (NIP) ──────────────────────────────────────────────────────────
async function createTransfer({
  fromAccountId,
  counterpartyId,
  amount, // in naira
  reason = "Transfer",
  reference,
}) {
  const body = {
    data: {
      type: "NIPTransfer",
      attributes: {
        amount: Math.round(Number(amount) * 100), // Anchor expects kobo
        currency: "NGN",
        reason,
        reference,
      },
      relationships: {
        account: { data: { type: "DepositAccount", id: fromAccountId } },
        counterParty: { data: { type: "CounterParty", id: counterpartyId } },
      },
    },
  };
  const res = await anchorFetch("/transfers", { method: "POST", body });
  return { transferId: res.data?.id, raw: res.data };
}

// ─── Webhook signature verification ──────────────────────────────────────────
// Recipe (per Anchor official Node.js example in docs):
//   Buffer.from(HMAC_SHA1(body, secret).hex()).toString("base64")
// Header: x-anchor-signature
//
// We compute THREE plausible recipes and accept whichever matches — useful for
// diagnosing format mismatches between Anchor's actual implementation and docs.
function verifyWebhook(rawBody, headers) {
  // Emergency bypass — set ANCHOR_VERIFY_WEBHOOK=false in env to skip
  // signature verification entirely. Use sparingly; only safe in sandbox
  // where the webhook URL isn't carrying real money.
  if (process.env.ANCHOR_VERIFY_WEBHOOK === "false") {
    console.warn("[Anchor verifyWebhook] BYPASSED (ANCHOR_VERIFY_WEBHOOK=false)");
    return true;
  }
  const secret = WEBHOOK_SECRET();
  if (!secret) return true; // not configured — fail-open (dev only)
  const provided =
    headers["x-anchor-signature"] || headers["anchor-signature"] || "";
  if (!provided) return false;

  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody);

  // Recipe A: Base64(hex(HMAC-SHA1)) — what Anchor's docs Node.js sample shows
  const hexDigest = crypto.createHmac("sha1", secret).update(body).digest("hex");
  const recipeA = Buffer.from(hexDigest, "utf8").toString("base64");

  // Recipe B: Base64(HMAC-SHA1 raw bytes) — simpler standard recipe
  const recipeB = crypto.createHmac("sha1", secret).update(body).digest("base64");

  // Recipe C: hex(HMAC-SHA1) — plain hex
  const recipeC = hexDigest;

  // Recipe D: Base64(hex_upper(HMAC-SHA1))
  const recipeD = Buffer.from(hexDigest.toUpperCase(), "utf8").toString("base64");
  // Recipe E: secret interpreted as hex bytes (in case Anchor stores hex)
  let recipeE = "";
  if (/^[0-9a-fA-F]+$/.test(secret) && secret.length % 2 === 0) {
    try {
      const keyBytes = Buffer.from(secret, "hex");
      const altHex = crypto.createHmac("sha1", keyBytes).update(body).digest("hex");
      recipeE = Buffer.from(altHex, "utf8").toString("base64");
    } catch {}
  }

  if (
    provided === recipeA ||
    provided === recipeB ||
    provided === recipeC ||
    provided === recipeD ||
    (recipeE && provided === recipeE)
  ) {
    return true;
  }

  console.warn(
    `[Anchor verifyWebhook] mismatch.\n` +
      `  provided=${provided}\n` +
      `  recipeA(b64-of-hex)    =${recipeA}\n` +
      `  recipeB(b64-of-bytes)  =${recipeB}\n` +
      `  recipeC(hex)           =${recipeC}\n` +
      `  recipeD(b64-of-HEX)    =${recipeD}\n` +
      `  recipeE(secret-as-hex) =${recipeE}\n` +
      `  bodyLen=${body.length} secretLen=${secret.length} secretFirst3=${secret.slice(0, 3)} secretLast3=${secret.slice(-3)}\n` +
      `  body=${body.toString("utf8").slice(0, 500)}`,
  );
  return false;
}

// ─── List a customer's document slots ────────────────────────────────────────
// Returns the pre-created Document resources Anchor expects to be filled before
// KYB can complete. Each Document has:
//   id           — slot id used in the upload URL
//   documentType — e.g. "CERTIFICATE_OF_BUSINESS_NAME"
//   description, submitted, verified, format
async function listCustomerDocuments(customerId) {
  const res = await anchorFetch(
    `/customers/${encodeURIComponent(customerId)}?include=Document`,
  );
  const docRels = res.data?.relationships?.documents?.data || [];
  const included = Array.isArray(res.included) ? res.included : [];
  return docRels.map((ref) => {
    const full = included.find((r) => r.type === "Document" && r.id === ref.id);
    const a = full?.attributes || {};
    return {
      documentId: ref.id,
      documentType: a.documentType,
      description: a.description,
      submitted: !!a.submitted,
      verified: !!a.verified,
      format: a.format || "FILE",
    };
  });
}

// ─── Document upload (CAC certificate, ID, etc.) ────────────────────────────
// Anchor's KYB review requires document submissions. Endpoint:
//   POST /api/v1/documents/upload-document/{customerId}/{documentId}
// where {documentId} comes from `listCustomerDocuments`.
//
// Two upload formats per document slot (the format is on the Document resource):
//   FILE → multipart/form-data with field name "fileData"
//   TEXT → no body; the value goes as ?textData=... in the query string
//
// Accepts either a Buffer, base64 string, OR a textData string. Trying to
// upload a file to a TEXT slot returns 400 "Missing text data" (and vice versa).
async function uploadDocument({ customerId, documentId, fileBuffer, fileBase64, textData, filename, contentType }) {
  ensureConfigured();

  // TEXT slot: Anchor's endpoint only accepts multipart/form-data — sending
  // application/json returns "Content-Type 'application/json' is not supported".
  // We send the value both as a multipart "textData" field AND as a query
  // string to cover both interpretations of the spec.
  if (textData != null && String(textData).length > 0) {
    const url = `${BASE()}/documents/upload-document/${encodeURIComponent(customerId)}/${encodeURIComponent(documentId)}?textData=${encodeURIComponent(textData)}`;
    const form = new FormData();
    form.append("textData", String(textData));
    const res = await fetch(url, {
      method: "POST",
      headers: { "x-anchor-key": API_KEY(), Accept: "application/json" },
      body: form,
    });
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!res.ok) {
      const err = new Error(
        data.errors?.[0]?.detail || data.message || `Anchor document upload failed (${res.status})`,
      );
      err.httpStatus = res.status;
      err.anchorErrors = data.errors;
      throw err;
    }
    return data;
  }

  // FILE slot: multipart/form-data with "fileData" field.
  let buf = fileBuffer;
  let ctype = contentType;
  if (!buf && fileBase64) {
    let b64 = fileBase64;
    const m = /^data:([^;]+);base64,(.*)$/.exec(b64);
    if (m) {
      ctype = ctype || m[1];
      b64 = m[2];
    }
    buf = Buffer.from(b64, "base64");
  }
  if (!buf) throw new Error("uploadDocument: fileBuffer, fileBase64, or textData required");

  const form = new FormData();
  const blob = new Blob([buf], { type: ctype || "application/octet-stream" });
  form.append("fileData", blob, filename || "document");

  const res = await fetch(
    `${BASE()}/documents/upload-document/${encodeURIComponent(customerId)}/${encodeURIComponent(documentId)}`,
    {
      method: "POST",
      headers: { "x-anchor-key": API_KEY(), Accept: "application/json" },
      body: form,
    },
  );
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    const err = new Error(
      data.errors?.[0]?.detail || data.message || `Anchor document upload failed (${res.status})`,
    );
    err.httpStatus = res.status;
    err.anchorErrors = data.errors;
    throw err;
  }
  return data;
}

module.exports = {
  createBusinessCustomer,
  searchCustomer,
  triggerKYB,
  createDepositAccount,
  getAccountBalance,
  getAccount,
  listCustomerAccounts,
  getBanks,
  verifyCounterparty,
  createCounterparty,
  createTransfer,
  verifyWebhook,
  listCustomerDocuments,
  uploadDocument,
};
