// Fincra provider — implements the semantic PaymentProvider interface against
// services/fincra.js. Handles instant local accounts (NGN/GHS/KES/TZS) and async
// foreign-currency accounts (USD/EUR/GBP). Selected per-country via index.js.
//
// Verified in sandbox (2026-07-14): NGN/GHS/TZS issue INSTANTLY (response carries
// status:"approved" + accountNumber). Per-country create KYC (individual):
//   NGN {firstName,lastName,bvn} · GHS {firstName,lastName,email}
//   KES/TZS {firstName,lastName}  (email is REJECTED for KES/TZS)
// merchantReference is Fincra's idempotency key (reuse → 409 DUPLICATE_REFERENCE).

const PaymentProvider = require("./PaymentProvider");
const fincra = require("../services/fincra");

// Build the per-currency individual KYCInformation block from a normalized input.
function buildLocalKyc(currency, kyc = {}) {
  const { firstName, lastName, email, bvn } = kyc;
  const base = { firstName, lastName };
  switch (currency) {
    case "NGN":
      return { ...base, bvn };
    case "GHS":
      return email ? { ...base, email } : base;
    case "KES":
    case "TZS":
      return base; // email is rejected by Fincra for these
    default:
      return email ? { ...base, email } : base;
  }
}

// Pull the account details out of a Fincra virtual-account response.
function readAccount(res) {
  const d = res?.data || res || {};
  const info = d.accountInformation || {};
  return {
    status: d.status, // "approved" (instant) | "pending" (async FCY)
    providerRef: d._id || d.id,
    accountNumber: d.accountNumber || info.accountNumber || null,
    accountName: info.accountName || null,
    bankName: info.bankName || d.bankName || null,
    bankCode: info.bankCode || null,
    consentUrl: d.consentUrl || d.consent?.url || null,
    consentId: d.consentId || null,
    business: d.business || null,
  };
}

class FincraProvider extends PaymentProvider {
  get supportsBanking() { return true; }
  get supportsForeignAccounts() { return true; }
  get unifiedProvisioning() { return true; }    // one-call local provisioning
  get pooledWallet() { return true; }           // all VAs collect into one merchant wallet/currency

  // Instant local virtual account (NGN/GHS/KES/TZS). `currency` from the
  // business's country. Returns { status:"issued", accountNumber, bankName,
  // accountName, providerRef, bankCode } synchronously.
  async provisionLocalAccount({ currency, accountType = "individual", kyc, channel, merchantReference }) {
    const res = await fincra.createVirtualAccount({
      currency,
      accountType,
      KYCInformation: buildLocalKyc(currency, kyc),
      channel,
      merchantReference,
    });
    const a = readAccount(res);
    return {
      status: a.accountNumber ? "issued" : (a.status === "pending" ? "pending" : "issued"),
      accountNumber: a.accountNumber,
      bankName: a.bankName,
      accountName: a.accountName,
      bankCode: a.bankCode,
      providerRef: a.providerRef,
    };
  }

  // Recovery for a duplicate-merchantReference (409): a prior attempt already
  // created the account at Fincra but failed to persist it locally. Re-fetch the
  // existing account by our deterministic merchantReference and return it in the
  // same shape as provisionLocalAccount, so provisioning can back-fill instead of
  // orphaning the account (inbound credits to it would otherwise never match).
  async recoverLocalAccount({ currency, merchantReference }) {
    let list = [];
    try {
      const res = await fincra.listVirtualAccounts({ currency });
      // Shape: { data: { results: [...], total } } — fall back defensively.
      list = res?.data?.results || (Array.isArray(res?.data) ? res.data : []);
    } catch {
      return null;
    }
    if (!Array.isArray(list)) return null;
    const match = list.find(
      (x) => x?.merchantReference === merchantReference || x?.reference === merchantReference,
    );
    if (!match) return null;
    const a = readAccount(match);
    if (!a.accountNumber) return null;
    return {
      status: "issued",
      accountNumber: a.accountNumber,
      bankName: a.bankName,
      accountName: a.accountName,
      bankCode: a.bankCode,
      providerRef: a.providerRef,
    };
  }

  // Async foreign-currency receive account (USD…). Returns { status:"pending",
  // providerRef, consentUrl }; the real details arrive via the
  // virtualaccount.issued webhook. (Requires FCY enabled on the Fincra account.)
  async provisionForeignAccount({ currency = "USD", accountType = "individual", KYCInformation, documents, merchantReference }) {
    const res = await fincra.createVirtualAccount({
      currency,
      accountType,
      KYCInformation,
      documents,
      merchantReference,
    });
    const a = readAccount(res);
    return {
      status: a.status || "pending",
      providerRef: a.providerRef,
      consentUrl: a.consentUrl,
      consentId: a.consentId,
      accountNumber: a.accountNumber, // usually null until issued
    };
  }

  // Available balance for a currency (naira/major units) — matches Anchor's
  // getAccountBalance(id) → Number contract.
  async getAccountBalance(_id, currency = "NGN") {
    const res = await fincra.getWallets();
    const w = (res?.data || []).find(
      (x) => String(x.currency || "").toUpperCase() === String(currency).toUpperCase(),
    );
    return Number(w?.availableBalance || 0);
  }

  // Bank list → [{ name, code, nibssCode, id }]. `code` is the payout bankCode.
  async getBanks(currency = "NGN") {
    const res = await fincra.getBanks(currency);
    return (res?.data || []).map((b) => ({ name: b.name, code: b.code, nibssCode: b.nibssCode, id: b.id }));
  }

  // Name enquiry → { accountName }.
  async verifyRecipient({ accountNumber, bankCode, currency = "NGN" }) {
    const res = await fincra.resolveAccount({ accountNumber, bankCode, currency });
    const d = res?.data || {};
    return { accountName: d.accountName || null, raw: d };
  }

  // Bank-account payout via POST /disbursements/payouts (path confirmed). `args`
  // is Fincra's payout body. A fully-successful send still needs a funded wallet.
  async payout(args) {
    return fincra.createPayout(args);
  }

  verifyWebhook(rawBody, headers) {
    const sig = headers?.signature || headers?.["signature"] || headers?.["x-fincra-signature"];
    return fincra.verifyWebhookSignature(rawBody, sig);
  }

  // Normalize a verified Fincra webhook into { kind, ...data }.
  parseWebhookEvent(rawBody) {
    let body;
    try { body = typeof rawBody === "string" ? JSON.parse(rawBody) : rawBody; }
    catch { return { kind: "unknown", raw: rawBody }; }
    const event = body?.event || body?.type;
    const data = body?.data || {};
    const KIND = {
      "virtualaccount.approved": "account_approved",
      "virtualaccount.issued": "account_issued",
      "collection.successful": "inbound_credit",
      "collection.failed": "inbound_failed",
    };
    return { kind: KIND[event] || "unhandled", event, data, dedupId: data.id || data._id || data.reference };
  }
}

module.exports = FincraProvider;
