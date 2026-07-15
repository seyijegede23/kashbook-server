// Abstract banking provider interface. Implementations live in this folder
// and are selected per-business via `index.js → getProvider(business)`.
//
// Two generations of methods live here during the Anchor→Fincra swap:
//   • SEMANTIC ops (provisionLocalAccount, provisionForeignAccount, getBanks,
//     verifyRecipient, payout, parseWebhookEvent, capability getters) — the
//     provider-neutral surface new code + FincraProvider use.
//   • Anchor-GRANULAR ops (createBusinessCustomer/triggerKYB/createDepositAccount/
//     createTransfer/…) — kept so Anchor's existing NG paths keep working
//     UNCHANGED; deprecated for new work, migrated per-path.

class PaymentProvider {
  // ── Capabilities ──────────────────────────────────────────────────────────
  // Can issue accounts + move money (false for the null / bookkeeping-only provider).
  get supportsBanking() { return false; }
  // Can issue foreign-currency (USD/EUR/GBP) receive accounts (Fincra yes).
  get supportsForeignAccounts() { return false; }
  // True when a local account is provisioned in ONE call (Fincra) rather than
  // the customer→kyc→account chain (Anchor). Drives the provisioning branch.
  get unifiedProvisioning() { return false; }
  // True when every virtual account collects into ONE shared merchant wallet
  // per currency (Fincra) instead of a per-business deposit account (Anchor).
  // When true, a business's "cash at bank" must be derived from OUR ledger, not
  // from the provider's wallet balance (which is the pooled total). Drives the
  // balance branch in the transfers/businesses routes.
  get pooledWallet() { return false; }

  // ── Semantic provisioning ─────────────────────────────────────────────────
  // Issue a LOCAL virtual account for the business's currency. Fincra: one call
  // (NGN/GHS/KES/TZS instant → {status:"issued", accountNumber, bankName,
  // accountName, providerRef}). Anchor: orchestrates its customer→kyc→account
  // chain elsewhere and does not implement this (dormant).
  async provisionLocalAccount(_args) { throw notImplemented(this, "provisionLocalAccount"); }
  // Request a FOREIGN-currency (USD…) receive account. Async: returns
  // {status:"pending", providerRef, consentUrl?}; details arrive by webhook.
  async provisionForeignAccount(_args) { throw notImplemented(this, "provisionForeignAccount"); }

  // ── Money + lookups ───────────────────────────────────────────────────────
  async getAccountBalance(_accountId, _currency) { throw notImplemented(this, "getAccountBalance"); }
  async getBanks(_country) { throw notImplemented(this, "getBanks"); }
  // Name-enquiry on a destination account → { accountName }.
  async verifyRecipient(_args) { throw notImplemented(this, "verifyRecipient"); }
  // Send money out. Shape is provider-specific; the executor adapts.
  async payout(_args) { throw notImplemented(this, "payout"); }

  // ── Webhooks ──────────────────────────────────────────────────────────────
  // Verify signature over the raw body. Returns boolean (fail-closed at caller).
  verifyWebhook(_rawBody, _headers) { throw notImplemented(this, "verifyWebhook"); }
  // Normalize a verified webhook into { kind, ...data } (kind:
  // "account_issued" | "inbound_credit" | "kyc_approved" | …).
  parseWebhookEvent(_rawBody, _headers) { throw notImplemented(this, "parseWebhookEvent"); }

  // ── Anchor-granular (deprecated; kept for existing NG paths) ───────────────
  async createBusinessCustomer(_args) { throw notImplemented(this, "createBusinessCustomer"); }
  async triggerKYB(_customerId) { throw notImplemented(this, "triggerKYB"); }
  async createDepositAccount(_args) { throw notImplemented(this, "createDepositAccount"); }
  async verifyCounterparty(_args) { throw notImplemented(this, "verifyCounterparty"); }
  async createCounterparty(_args) { throw notImplemented(this, "createCounterparty"); }
  async createTransfer(_args) { throw notImplemented(this, "createTransfer"); }
  async createBookTransfer(_args) { throw notImplemented(this, "createBookTransfer"); }
  async listCustomerDocuments(_customerId) { throw notImplemented(this, "listCustomerDocuments"); }
  async uploadDocument(_args) { throw notImplemented(this, "uploadDocument"); }
}

function notImplemented(self, method) {
  const err = new Error(`Provider ${self.constructor.name} does not implement ${method}`);
  err.code = "NOT_IMPLEMENTED";
  err.httpStatus = 501;
  return err;
}

module.exports = PaymentProvider;
