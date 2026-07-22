// Korapay provider — go-forward for non-Nigeria + USD. Pooled merchant balance
// (per-business balance = OUR ledger, like Fincra). Implements the semantic
// interface against services/korapay.js. Provisioning (USD virtual accounts) and
// the executeTransfer payout wiring are added in later batches; this is the
// money-movement + webhook foundation.
const PaymentProvider = require("./PaymentProvider");
const korapay = require("../services/korapay");

// Korapay account-holder KYC payload for a USD account. Field shape is
// reverse-engineered from the sandbox VALIDATOR, not the public docs (the docs
// list employment_status/employer_name/job_description, which the API rejects):
//   • type must be "individual"
//   • source_of_inflow must be an enum like "bank_statement"
//   • address uses `address` (NOT `street`)
//   • bank_id_number = the BVN (NG); use_case, occupation, nationality required
// Document file_references (passport/selfie/proof-of-address) upload via
// generateUploadUrl — how they attach is unverified until the USD beta is live.
function buildAccountHolderPayload({ user, kyc = {} }) {
  const addr = kyc.address || {};
  const dob = kyc.dateOfBirth || user.dateOfBirth;
  return {
    type: "individual",
    first_name: user.firstName,
    last_name: user.lastName || user.firstName,
    email: user.email,
    phone: user.phone,
    date_of_birth: dob ? new Date(dob).toISOString().slice(0, 10) : undefined,
    nationality: kyc.nationality || user.country || "NG",
    occupation: kyc.occupation,
    use_case: kyc.useCase || "personal",
    bank_id_number: kyc.bvn || kyc.bankIdNumber,
    source_of_inflow: kyc.sourceOfInflow || "bank_statement",
    address: {
      country: addr.country || user.country || "NG",
      state: addr.state,
      city: addr.city,
      zip: addr.zip || addr.postalCode,
      address: addr.address || addr.street,
    },
    ...(kyc.documents ? { documents: kyc.documents } : {}),
  };
}

class KorapayProvider extends PaymentProvider {
  get key() { return "korapay"; }
  get supportsBanking() { return true; }
  get supportsForeignAccounts() { return true; } // USD virtual accounts
  get pooledWallet() { return true; }             // one merchant wallet per currency
  get unifiedProvisioning() { return true; }      // one-call NGN provisioning (provisionViaUnifiedProvider)

  // Bank list → [{ name, code }]. `arg` may be a currency string or {countryCode,currency}.
  async getBanks(arg) {
    const opts = typeof arg === "string" ? { currency: arg } : (arg || {});
    const res = await korapay.getBanks(opts);
    return (res?.data || []).map((b) => ({ name: b.name, code: b.code || b.slug, nibssCode: b.nibss_bank_code, id: b.slug }));
  }

  // Name enquiry → { accountName }.
  async verifyRecipient({ accountNumber, bankCode, currency = "NGN" }) {
    const res = await korapay.resolveAccount({ bank: bankCode, account: accountNumber, currency });
    return { accountName: res?.data?.account_name || null, raw: res?.data };
  }

  // Merchant pool balance for a currency (major units). Per-business "cash at bank"
  // uses computeLedgerBalance (pooled) — this is the pool total, for reconciliation.
  async getAccountBalance(_id, currency = "NGN") {
    const res = await korapay.getBalances();
    const w = res?.data?.[String(currency).toUpperCase()];
    return Number(w?.available_balance || 0);
  }

  // External payout. `args` is a normalized request; we build Korapay's disburse
  // body here (the provider owns its API shape). The businessId rides in `metadata`
  // (Korapay caps the reference length, so we don't encode it in the ref) — the
  // payout reconcile attributes an orphaned success via metadata.business_id.
  async payout({ reference, amount, currency = "NGN", accountNumber, bankCode, accountName, narration, email, businessId }) {
    const payload = {
      reference,
      destination: {
        type: "bank_account",
        amount: Number(amount).toFixed(2),
        currency,
        narration: narration || `Transfer from KashBook`,
        bank_account: { bank: bankCode, account: accountNumber },
        customer: { email: email || "payouts@kashbook.app", name: accountName || "Recipient" },
      },
      ...(businessId ? { metadata: { business_id: businessId } } : {}),
    };
    const res = await korapay.createPayout(payload);
    const d = res?.data || {};
    return { status: d.status, reference: d.reference || reference, fee: Number(d.fee || 0), raw: d };
  }

  // ── NGN local virtual account (one-call, admin-gated provisioning) ─────────
  // Called by provisionViaUnifiedProvider (services/virtualAccountProvisioning.js)
  // after an admin approves the parked KycSubmission. Korapay issues a permanent
  // NGN account synchronously → { status:"issued", accountNumber, ... }. Any
  // non-NGN currency is unsupported today (Korapay 403s GHS, 500s KES/USD until the
  // FCY beta is enabled) — throw a clear error rather than emit a malformed request.
  async provisionLocalAccount({ currency = "NGN", accountType = "individual", kyc = {}, merchantReference, businessName } = {}) {
    if (String(currency).toUpperCase() !== "NGN") {
      const e = new Error(`Korapay cannot issue a ${currency} account (only NGN is available; GHS/KES/USD need the FCY beta enabled).`);
      e.code = "KORAPAY_CURRENCY_UNSUPPORTED";
      throw e;
    }
    const first = kyc.firstName || "";
    const last = kyc.lastName || first;
    const accountName = businessName || `${first} ${last}`.trim();
    // Korapay requires customer.email; the caller may not have one → deterministic
    // synthetic keyed on the (unique, per-business) merchantReference.
    const email = kyc.email || `${merchantReference || "kb"}@kashbook.app`;
    const bankCode = process.env.KORAPAY_VBA_BANK_CODE || "000"; // "000" = sandbox test bank
    const res = await korapay.createNairaVirtualAccount({
      accountName,
      accountReference: merchantReference,
      bankCode,
      customerName: `${first} ${last}`.trim() || accountName,
      customerEmail: email,
      bvn: kyc.bvn,
    });
    const d = res?.data || {};
    return {
      status: d.account_number ? "issued" : "pending",
      accountNumber: d.account_number || null,
      bankName: d.bank_name || null,
      accountName: d.account_name || accountName,
      bankCode: d.bank_code || bankCode,
      providerRef: d.unique_id || d.account_reference || merchantReference,
    };
  }

  // Recovery for a duplicate-reference (409): a prior attempt created the account
  // at Korapay but failed to persist locally. getVirtualBankAccount looks up by OUR
  // account_reference (== merchantReference), so re-fetch + return it in the
  // provisionLocalAccount shape instead of orphaning it (inbound credits to an
  // orphaned account would never match). Sandbox-verified: GET by account_reference
  // returns the account; a wrong ref 404s (→ null).
  async recoverLocalAccount({ merchantReference }) {
    let res;
    try {
      res = await korapay.getVirtualBankAccount(merchantReference);
    } catch {
      return null;
    }
    const d = res?.data || {};
    if (!d.account_number) return null;
    return {
      status: "issued",
      accountNumber: d.account_number,
      bankName: d.bank_name || null,
      accountName: d.account_name || null,
      bankCode: d.bank_code || null,
      providerRef: d.unique_id || d.account_reference || merchantReference,
    };
  }

  // ── USD (FCY) receive accounts ────────────────────────────────────────────
  // Two-step, KYC-heavy, BETA-gated. The account-holder payload shape below was
  // reverse-engineered from the sandbox validator (the public docs list fields
  // the API rejects). A well-formed payload currently 500s because the USD beta
  // isn't enabled — so persist/wire it, but re-confirm the response shapes +
  // document attachment the moment Korapay turns the beta on.

  // Step 1: create the account holder (async approval). → { status, holderRef }.
  async provisionForeignAccount({ user, kyc = {}, currency = "USD", accountReference } = {}) {
    const res = await korapay.createAccountHolder(buildAccountHolderPayload({ user, kyc }));
    const h = res?.data || {};
    return {
      status: h.status || "pending",
      holderRef: h.reference || h.account_holder_reference || null,
      currency,
      accountReference,
      raw: h,
    };
  }

  // Step 2: create the USD virtual account once the holder is approved.
  // → { status, accountNumber, accountName, bankName, swift, routing, providerRef }.
  async createForeignVirtualAccount({ holderRef, accountReference, currency = "USD", accountName } = {}) {
    const res = await korapay.createVirtualBankAccount({ currency, accountHolderReference: holderRef, accountReference, accountName });
    const a = res?.data || {};
    const ach = a.ach || {};
    const swift = a.swift || {};
    const fedwire = a.fedwire || {};
    return {
      status: a.account_status || a.status || "pending",
      accountNumber: ach.account_number || swift.account_number || a.account_number || null,
      accountName: ach.account_holder_name || a.account_name || null,
      bankName: ach.bank_name || swift.bank_name || null,
      swift: swift.swift_code || swift.swift || null,
      routing: ach.routing_code || ach.routing_number || fedwire.routing_code || null,
      providerRef: a.reference || accountReference || null,
      raw: a,
    };
  }

  verifyWebhook(rawBody, headers) {
    const sig = headers?.["x-korapay-signature"] || headers?.["X-Korapay-Signature"];
    let body;
    try { body = typeof rawBody === "string" ? JSON.parse(rawBody) : rawBody; }
    catch { return false; }
    return korapay.verifyWebhookSignature(body?.data, sig);
  }

  // Normalize a verified Korapay webhook → { kind, event, data, dedupId }.
  parseWebhookEvent(rawBody) {
    let body;
    try { body = typeof rawBody === "string" ? JSON.parse(rawBody) : rawBody; }
    catch { return { kind: "unknown", raw: rawBody }; }
    const event = body?.event;
    const data = body?.data || {};
    const KIND = {
      "charge.success": "inbound_credit",
      "charge.failed": "inbound_failed",
      "transfer.success": "payout_success",
      "transfer.failed": "payout_failed",
    };
    return { kind: KIND[event] || "unhandled", event, data, dedupId: data.reference || data.id };
  }
}

module.exports = KorapayProvider;
