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

async function anchorFetch(path, { method = "GET", body, idempotencyKey } = {}) {
  ensureConfigured();
  const headers = {
    "x-anchor-key": API_KEY(),
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  // Anchor de-dupes Transfers / VirtualNubans for 24h when this key is present,
  // so a retried/concurrent POST with the same key returns the original result
  // instead of moving money twice. (Bills do NOT support it — see payBill.)
  if (idempotencyKey) headers["x-anchor-idempotent-key"] = idempotencyKey;
  const res = await fetch(`${BASE()}${path}`, {
    method,
    headers,
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

// Anchor wants exactly 11 numeric digits in local format (0XXXXXXXXXX) — it
// rejects "+" prefixes and any other length with "phoneNumber size must be
// between 11 and 11". Normalize the common shapes; anything else passes
// through unchanged so the Phase A validator can reject it with a clear
// error instead of Anchor's.
function normalizePhoneForAnchor(phone) {
  if (!phone) return "";
  const digits = String(phone).replace(/\D/g, "");
  if (digits.startsWith("234") && digits.length === 13) return "0" + digits.slice(3);
  // "+2340801…" — user kept the leading 0 after the country code.
  if (digits.startsWith("2340") && digits.length === 14) return digits.slice(3);
  if (digits.length === 10) return "0" + digits;
  return digits;
}

// True when a phone normalizes to a valid NG mobile (11 digits, 0 + 10).
function isValidAnchorPhone(phone) {
  return /^0\d{10}$/.test(normalizePhoneForAnchor(phone));
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
  businessBvn,            // BVN of the primary owner — sandbox reuses signing-user BVN
  dateOfRegistration,     // YYYY-MM-DD
  description,            // free-text business description
  industry,               // any Anchor industry enum value
  registrationType,       // "Business_Name" | "Private_Incorporated"
  website,
  // Business address
  businessAddress,        // { state, addressLine_1, addressLine_2?, city, postalCode? }
  // The app user (always a DIRECTOR/CEO)
  user,                   // { firstName, lastName, email, phone, dateOfBirth, bvn }
  // Optional director residential address (defaults to businessAddress)
  directorAddress,
  // Optional owners array — used for LTD and multi-partner BN.
  // If empty/missing → fall back to the sole-prop pattern (user is the 100% owner).
  // Each: { firstName, lastName, bvn, dateOfBirth, gender?, percentageOwned,
  //         email?, phoneNumber?, title?, address? }
  owners,
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

  function ownerAddress(o) {
    if (!o?.addressLine_1 && !o?.addressLine1) return bizAddr;
    return {
      country: "NG",
      state: o.state || o.addressState || bizAddr.state,
      addressLine_1: o.addressLine_1 || o.addressLine1,
      addressLine_2: o.addressLine_2 || o.addressLine2 || "",
      city: o.city || o.addressCity || bizAddr.city,
      postalCode: o.postalCode || o.addressPostalCode || bizAddr.postalCode,
    };
  }

  // Build officers array.
  const officers = [
    // Signing user is always the DIRECTOR (CEO, 0%).
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
  ];

  if (Array.isArray(owners) && owners.length > 0) {
    // Validate sum + per-owner minimum before serializing.
    const sum = owners.reduce((s, o) => s + Number(o.percentageOwned || 0), 0);
    if (Math.abs(sum - 100) > 0.01) {
      throw new Error(`Owner percentages must sum to 100 (got ${sum.toFixed(2)})`);
    }
    for (const o of owners) {
      const pct = Number(o.percentageOwned || 0);
      if (pct < 5) {
        throw new Error(`Each owner must hold at least 5% (got ${pct})`);
      }
      if (!/^\d{11}$/.test(String(o.bvn || ""))) {
        throw new Error(`Owner BVN must be 11 digits`);
      }
    }
    for (const o of owners) {
      const dob =
        o.dateOfBirth instanceof Date
          ? o.dateOfBirth.toISOString().slice(0, 10)
          : o.dateOfBirth;
      officers.push({
        role: "OWNER",
        fullName: {
          firstName: o.firstName,
          lastName: o.lastName || o.firstName,
          ...(o.middleName ? { middleName: o.middleName } : {}),
        },
        nationality: "NG",
        address: ownerAddress(o),
        dateOfBirth: dob,
        email: o.email || user.email,
        phoneNumber: normalizePhoneForAnchor(o.phoneNumber || user.phone || "07000000000"),
        bvn: o.bvn,
        title: o.title || "President",
        percentageOwned: Number(o.percentageOwned),
      });
    }
  } else {
    // Sole-prop fallback: signing user is the 100% owner. Preserves prior behaviour.
    officers.push({
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
    });
  }

  const body = {
    data: {
      type: "BusinessCustomer",
      attributes: {
        address: { country: "NG", state: bizAddr.state },
        basicDetail: {
          industry: industry || "Retail",
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
        officers,
      },
    },
  };

  const res = await anchorFetch("/customers", { method: "POST", body });
  return {
    customerId: res.data?.id,
    status: res.data?.attributes?.verification?.status || "pending",
  };
}

// Map our app-level businessType to Anchor's registrationType enum.
function mapBusinessTypeToRegistration(businessType) {
  if (businessType === "limited_company") return "Private_Incorporated";
  return "Business_Name"; // sole_proprietorship + safe default
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

// ─── Individual customer (cheap KYC path) ────────────────────────────────────
// For the "individual KYC + business-named virtual account" flow: onboard the
// owner as an IndividualCustomer (Tier-2 BVN KYC ≈ ₦50, vs ₦1,000 business KYB),
// open a SAVINGS settlement account, then mint a VirtualNuban LABELLED with the
// business name (see createVirtualNuban). Customers pay the business-named NUBAN;
// money settles into the owner's individual deposit account.
//
// Tier 0 creation only needs name/email/phone/address; the BVN goes in the
// separate verification call (triggerIndividualKyc).
async function createIndividualCustomer({ user, address }) {
  const phone = normalizePhoneForAnchor(user.phone || "07000000000");
  const a = address || {};
  const addr = {
    country: "NG",
    state: a.state || "Lagos",
    addressLine_1: a.addressLine_1 || a.addressLine1 || "1 Marina Street",
    addressLine_2: a.addressLine_2 || a.addressLine2 || "",
    city: a.city || "Lagos Island",
    postalCode: a.postalCode || "100001",
  };
  const body = {
    data: {
      type: "IndividualCustomer",
      attributes: {
        fullName: {
          firstName: user.firstName,
          lastName: user.lastName || user.firstName,
        },
        email: user.email,
        phoneNumber: phone,
        address: addr,
      },
    },
  };
  const res = await anchorFetch("/customers", { method: "POST", body });
  return {
    customerId: res.data?.id,
    status: res.data?.attributes?.verification?.status || "pending",
  };
}

// Anchor's gender enum is Title-case ("Male"/"Female").
function normalizeGenderForAnchor(g) {
  return String(g || "").trim().toLowerCase().startsWith("f") ? "Female" : "Male";
}

// Trigger Tier-2 (BVN) KYC on an IndividualCustomer. Async → webhook
// customer.identification.approved/.rejected follows (sandbox approves in
// seconds). The "level: TIER_2 + level2.bvn" shape is what Anchor accepts.
async function triggerIndividualKyc(customerId, { bvn, dateOfBirth, gender }) {
  const dob =
    dateOfBirth instanceof Date ? dateOfBirth.toISOString().slice(0, 10) : dateOfBirth;
  return anchorFetch(`/customers/${customerId}/verification/individual`, {
    method: "POST",
    body: {
      data: {
        type: "Verification",
        attributes: {
          level: "TIER_2",
          level2: { bvn, dateOfBirth: dob, gender: normalizeGenderForAnchor(gender) },
        },
      },
    },
  });
}

// Read a customer's current verification status — used to poll for approval in
// the synchronous onboarding fast-path (KYC is usually instant for a BVN match).
async function getCustomerStatus(customerId) {
  const res = await anchorFetch(`/customers/${encodeURIComponent(customerId)}`);
  const a = res.data?.attributes || {};
  return {
    status: a.verification?.status || a.status || "unknown",
    type: res.data?.type,
    raw: res.data,
  };
}

// ─── Virtual NUBAN (business-named collection account) ───────────────────────
// Creates a Providus virtual account whose displayed name is ARBITRARY (proven:
// it honoured a custom name), settling into the given DepositAccount. NIBSS
// requires a BVN on the account — pass the owner's. `permanent: true` = a fixed
// account the merchant can reuse. The returned accountNumber/accountName/bank is
// what customers pay into and see.
async function createVirtualNuban({ settlementAccountId, name, bvn, reference, permanent = true, provider = "providus" }) {
  const body = {
    data: {
      type: "VirtualNuban",
      attributes: {
        provider,
        virtualAccountDetail: {
          name,
          reference: reference || "kb-" + Date.now(),
          permanent,
          ...(bvn ? { bvn } : {}),
        },
      },
      relationships: {
        settlementAccount: { data: { type: "DepositAccount", id: settlementAccountId } },
      },
    },
  };
  const res = await anchorFetch("/virtual-nubans", { method: "POST", body, idempotencyKey: reference || undefined });
  const a = res.data?.attributes || {};
  return {
    virtualNubanId: res.data?.id,
    accountNumber: a.accountNumber,
    accountName: a.accountName || a.virtualAccountDetail?.name || name,
    bankName: a.bank?.name || "Providus Bank",
    raw: res.data,
  };
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
  // Response shape (non-JSON:API): { data: { availableBalance, ledgerBalance, hold, pending } }
  // Values are returned in KOBO — divide by 100 to expose naira to callers.
  const res = await anchorFetch(`/accounts/balance/${accountId}`);
  const d = res.data ?? {};
  const koboBalance = Number(d.availableBalance ?? d.balance ?? 0);
  return {
    balance: koboBalance / 100,
    ledgerBalance: Number(d.ledgerBalance ?? 0) / 100,
    hold: Number(d.hold ?? 0) / 100,
    pending: Number(d.pending ?? 0) / 100,
    accountNumber: d.accountNumber,
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

// ─── Book Transfer (internal: between two DepositAccounts on this org) ──────
// Cheaper + instant compared to NIP. Use when destination is another KashBook
// business whose DepositAccount lives on the same Anchor organization.
//
// POST /transfers  data.type=BookTransfer
// Amount is in KOBO per Anchor convention.
async function createBookTransfer({
  fromAccountId,
  toAccountId,
  amount, // in naira (we convert to kobo here)
  reason = "Transfer",
  reference,
}) {
  const body = {
    data: {
      type: "BookTransfer",
      attributes: {
        currency: "NGN",
        amount: Math.round(Number(amount) * 100),
        reason,
        reference,
      },
      relationships: {
        account: { data: { type: "DepositAccount", id: fromAccountId } },
        destinationAccount: { data: { type: "DepositAccount", id: toAccountId } },
      },
    },
  };
  const res = await anchorFetch("/transfers", { method: "POST", body, idempotencyKey: reference || undefined });
  return { transferId: res.data?.id, raw: res.data };
}

// ─── Transfer (NIP — external, to any Nigerian bank) ────────────────────────
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
  const res = await anchorFetch("/transfers", { method: "POST", body, idempotencyKey: reference || undefined });
  return { transferId: res.data?.id, raw: res.data };
}

// ─── Webhook signature verification ──────────────────────────────────────────
// Recipe (per Anchor official Node.js example in docs):
//   Buffer.from(HMAC_SHA1(body, secret).hex()).toString("base64")
// Header: x-anchor-signature
//
// We compute THREE plausible recipes and accept whichever matches — useful for
// diagnosing format mismatches between Anchor's actual implementation and docs.
// Constant-time compare so a signature can't be brute-forced byte-by-byte via
// response-timing. Length mismatch short-circuits (lengths aren't secret).
function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ""), "utf8");
  const bb = Buffer.from(String(b || ""), "utf8");
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function verifyWebhook(rawBody, headers) {
  // Emergency bypass — set ANCHOR_VERIFY_WEBHOOK=false in env to skip
  // signature verification entirely. Use sparingly; only safe in sandbox
  // where the webhook URL isn't carrying real money.
  if (process.env.ANCHOR_VERIFY_WEBHOOK === "false") {
    console.warn("[Anchor verifyWebhook] BYPASSED (ANCHOR_VERIFY_WEBHOOK=false)");
    return true;
  }
  const secret = WEBHOOK_SECRET();
  if (!secret) {
    // Fail CLOSED in production — an unsigned webhook could fake inbound credits.
    // In dev/staging, allow + warn so local testing without a secret still works.
    if (process.env.NODE_ENV === "production") {
      console.error("[Anchor verifyWebhook] ANCHOR_WEBHOOK_SECRET not set — rejecting");
      return false;
    }
    console.warn("[Anchor verifyWebhook] no secret configured (dev) — skipping verification");
    return true;
  }
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

  // Constant-time compare against each candidate recipe.
  const candidates = [recipeA, recipeB, recipeC, recipeD, recipeE].filter(Boolean);
  if (candidates.some((c) => safeEqual(provided, c))) {
    return true;
  }

  // Never log the secret or the request body. Recipe values are HMAC outputs
  // (not the secret) and only printed in non-production for diagnosis.
  console.warn(`[Anchor verifyWebhook] signature mismatch (bodyLen=${body.length})`);
  if (process.env.NODE_ENV !== "production") {
    console.warn(
      `  provided=${provided}\n  A=${recipeA}\n  B=${recipeB}\n  C=${recipeC}\n  D=${recipeD}\n  E=${recipeE}`,
    );
  }
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

// ─── Bill payments (airtime / data / electricity / cable TV) ────────────────
// Funded from the customer's DepositAccount balance. Verified against the
// Anchor sandbox + docs.getanchor.co/docs/{airtime,data-bill,electricity,
// cable-tv}-purchase. Amounts are in KOBO (₦100 = 10000).
//   GET  /bills/billers?category=<airtime|data|electricity|cabletv>
//   GET  /bills/billers/{billerId}/products
//   GET  /bills/customer-validation/{providerSlug}/{customerNumber}
//   POST /bills   data.type = Airtime | Data | Electricity | Television

// Our lowercase UI category → Anchor's data.type. Note "cabletv" → "Television".
const BILL_TYPE = { airtime: "Airtime", data: "Data", electricity: "Electricity", cabletv: "Television" };

// Anchor returns JSON:API: { id, attributes: { name, slug, category, price } }.
// Flatten to plain objects so the client doesn't deal with the envelope.
function flattenBiller(b) {
  return { id: b.id, name: b.attributes?.name, slug: b.attributes?.slug, category: b.attributes?.category };
}
function flattenProduct(p) {
  const a = p.attributes || {};
  const min = a.price?.minimumAmount ?? null; // kobo
  const max = a.price?.maximumAmount ?? null;
  return {
    id: p.id,
    name: a.name,
    slug: a.slug,
    amount: min != null ? min / 100 : null,   // naira; null/range → user enters
    amountMin: min != null ? min / 100 : null,
    amountMax: max != null ? max / 100 : null,
    fixed: min != null && min === max,
  };
}

async function listBillers(category) {
  const res = await anchorFetch(`/bills/billers?category=${encodeURIComponent(category)}`);
  return (res.data || []).map(flattenBiller);
}

async function getBillerProducts(billerId) {
  const res = await anchorFetch(`/bills/billers/${encodeURIComponent(billerId)}/products`);
  return (res.data || []).map(flattenProduct);
}

// Validate a meter / smartcard before paying (electricity + cable). Returns the
// resolved customer name so the user can confirm before money moves.
async function validateBillCustomer(providerSlug, customerNumber) {
  const res = await anchorFetch(
    `/bills/customer-validation/${encodeURIComponent(providerSlug)}/${encodeURIComponent(customerNumber)}`,
  );
  const a = res.data?.attributes || {};
  return { name: a.name || a.customerName || null, raw: res.data };
}

// Pay a bill. The attribute shape differs per category (Anchor's spec):
//   airtime     → { provider, phoneNumber, amount, reference }
//   data        → { phoneNumber, amount, productSlug, reference }
//   electricity → { meterAccountNumber, phoneNumber, amount, productSlug, reference }
//   television  → { smartCardNumber, phoneNumber, amount, productSlug, reference }
async function payBill({ accountId, category, provider, customerId, phoneNumber, amount, productSlug, reference }) {
  const type = BILL_TYPE[category];
  if (!type) throw new Error(`Unknown bill category: ${category}`);
  const kobo = Math.round(Number(amount) * 100);
  const contact = phoneNumber || customerId;

  let attributes;
  if (category === "airtime") {
    attributes = { provider, phoneNumber: customerId, amount: kobo, reference };
  } else if (category === "data") {
    attributes = { phoneNumber: customerId, amount: kobo, productSlug, reference };
  } else if (category === "electricity") {
    attributes = { meterAccountNumber: customerId, phoneNumber: contact, amount: kobo, productSlug, reference };
  } else {
    attributes = { smartCardNumber: customerId, phoneNumber: contact, amount: kobo, productSlug, reference };
  }

  const body = {
    data: {
      type,
      attributes,
      relationships: { account: { data: { type: "DepositAccount", id: accountId } } },
    },
  };
  const res = await anchorFetch("/bills", { method: "POST", body });
  const a = res.data?.attributes || {};
  return { billId: res.data?.id, status: a.status, token: a.detail?.token || a.token || null, raw: res.data };
}

module.exports = {
  createBusinessCustomer,
  mapBusinessTypeToRegistration,
  isValidAnchorPhone,
  searchCustomer,
  triggerKYB,
  createIndividualCustomer,
  triggerIndividualKyc,
  getCustomerStatus,
  createVirtualNuban,
  createDepositAccount,
  getAccountBalance,
  getAccount,
  listCustomerAccounts,
  getBanks,
  verifyCounterparty,
  createCounterparty,
  createTransfer,
  createBookTransfer,
  verifyWebhook,
  listCustomerDocuments,
  uploadDocument,
  listBillers,
  getBillerProducts,
  validateBillCustomer,
  payBill,
};
