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
      // Fincra marks KYCInformation.email REQUIRED for GHS (individual and
      // corporate). Sending the request without it cannot succeed, so fail here
      // with a clear message instead of at the provider.
      if (!email) {
        const err = new Error("An email address is required to open a Ghanaian account.");
        err.code = "FINCRA_GHS_EMAIL_REQUIRED";
        throw err;
      }
      return { ...base, email };
    case "KES":
    case "TZS":
      return base; // email is rejected by Fincra for these
    default:
      return email ? { ...base, email } : base;
  }
}

// Pull the account details out of a Fincra virtual-account response.
//
// Two incompatible shapes exist and both must be handled:
//   • individual — details nested under accountInformation.otherInfo
//   • corporate  — FLAT accountInformation { accountNumber, bankName,
//                  bankAddress, accountName, swiftCode }, no otherInfo at all
// Reading only otherInfo loses SWIFT/IBAN/sort code entirely for corporates.
function readAccount(res) {
  const d = res?.data || res || {};
  const info = d.accountInformation || {};
  const other = info.otherInfo || {};
  return {
    status: d.status, // "approved" (instant) | "pending" (async FCY)
    providerRef: d._id || d.id,
    accountNumber: d.accountNumber || info.accountNumber || null,
    accountName: info.accountName || null,
    bankName: info.bankName || d.bankName || null,
    bankCode: info.bankCode || null,
    // Wire details. `bankSwiftCode` is the documented key (individual, under
    // otherInfo); corporate uses a flat `swiftCode`. There is NO "routing" key:
    // the ACH routing number is the top-level bankCode, and the rail it belongs
    // to is named by otherInfo.addressableIn.
    iban: other.iban || null,
    sortCode: other.sortCode || null,
    swift: other.bankSwiftCode || info.swiftCode || null,
    bankAddress: other.bankAddress || info.bankAddress || null,
    addressableIn: other.addressableIn || null,
    memo: other.memo || null,
    // Per-rail records (FEDWIRE/SWIFT/ACH), each with its OWN memo and swift.
    // Kept whole: flattening lets one rail's memo be shown beside another
    // rail's SWIFT code, which gets the wire rejected or misrouted.
    alternateAccountDetails: Array.isArray(info.alternateAccountDetails)
      ? info.alternateAccountDetails
      : null,
    reference: info.reference || null,
    // Corporate FCY returns consentLink (+ consentExpiresAt); individual has no
    // consent step at all.
    consentUrl: d.consentLink || d.consentUrl || d.consent?.url || null,
    consentId: d.consentId || null,
    consentExpiresAt: d.consentExpiresAt || null,
    business: d.business || null,
  };
}

class FincraProvider extends PaymentProvider {
  get key() { return "fincra"; }
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
  // `body` is the fully-assembled Fincra request from utils/fcyKyc.js. It is
  // passed through WHOLE rather than destructured: the FCY contract has
  // top-level utilityBill / meansOfId / monthlyTransactionCount /
  // monthlyTransactionVolume alongside KYCInformation, and an earlier version
  // that named only a few fields silently dropped the rest.
  async provisionForeignAccount(body = {}) {
    const res = await fincra.createVirtualAccount({
      accountType: "individual",
      currency: "USD",
      ...body,
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
      // Lifecycle events that were previously dropped. Without these an account
      // sits at "pending" forever after a rejection, and we keep advertising an
      // account number that Fincra has closed or replaced.
      "virtualaccount.declined": "account_declined",
      "virtualaccount.changed": "account_changed",
      "virtualaccount.closed": "account_closed",
      "collection.successful": "inbound_credit",
      "collection.failed": "inbound_failed",
      // Fincra is asking for more information about an inbound payment. If
      // nobody answers in time the funds are RETURNED TO THE SENDER with a fee.
      "collection.additional-info-requested": "collection_rfi",
      // Outbound payout settlement (async; booked optimistically at send time).
      "payout.successful": "payout_success",
      "payout.completed": "payout_success",
      "disbursement.successful": "payout_success",
      "payout.failed": "payout_failed",
      "payout.reversed": "payout_failed",
      "payout.declined": "payout_failed",
      "disbursement.failed": "payout_failed",
    };
    // `reference` first: it is the stable, documented unique identifier.
    // `id` is a small INTEGER on payouts (14380) and on RFI collections
    // (16376096), so preferring it risks collisions between different records.
    // Collections carry no id/_id at all, so they already fell through to
    // reference by accident; this makes that deliberate and uniform.
    return {
      kind: KIND[event] || "unhandled",
      event,
      data,
      dedupId: data.reference || data._id || data.id || data.sessionId,
    };
  }
}

module.exports = FincraProvider;
