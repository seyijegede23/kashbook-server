// Anchor provider — wraps utils/anchor.js verbatim. Goal: *zero behavioural
// change* for Nigerian users. Implements the semantic ops that map cleanly to
// existing Anchor helpers; the granular ops remain for the current provisioning/
// transfer paths until they are migrated per-batch. Anchor is going dormant
// (no country selects it after the Fincra swap), so provisionLocalAccount /
// provisionForeignAccount / payout / parseWebhookEvent are intentionally left
// unimplemented — Anchor's live code paths do not route through them.

const PaymentProvider = require("./PaymentProvider");
const anchor = require("../utils/anchor");

class AnchorProvider extends PaymentProvider {
  get supportsBanking() { return true; }
  get supportsForeignAccounts() { return false; }

  // Semantic ops that map 1:1 to existing helpers
  getAccountBalance(id)         { return anchor.getAccountBalance(id); }
  getBanks()                    { return anchor.getBanks(); }
  verifyRecipient(args)         { return anchor.verifyCounterparty(args); }
  verifyWebhook(...args)        { return anchor.verifyWebhook(...args); }

  // Anchor-granular (existing NG provisioning + transfer paths)
  createBusinessCustomer(args)  { return anchor.createBusinessCustomer(args); }
  triggerKYB(id)                { return anchor.triggerKYB(id); }
  createDepositAccount(args)    { return anchor.createDepositAccount(args); }
  verifyCounterparty(args)      { return anchor.verifyCounterparty(args); }
  createCounterparty(args)      { return anchor.createCounterparty(args); }
  createTransfer(args)          { return anchor.createTransfer(args); }
  createBookTransfer(args)      { return anchor.createBookTransfer(args); }
  listCustomerDocuments(id)     { return anchor.listCustomerDocuments(id); }
  uploadDocument(args)          { return anchor.uploadDocument(args); }
}

module.exports = AnchorProvider;
