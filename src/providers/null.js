// Null provider — bookkeeping-only countries get this. Every banking call
// throws a uniform error so the route layer can convert to a 400 with code
// BANKING_NOT_AVAILABLE and a friendly user message.

const PaymentProvider = require("./PaymentProvider");

function notAvailable(method) {
  const err = new Error(
    "Banking isn't available in your country yet. You can still use KashBook for invoicing, customers, expenses, and reports.",
  );
  err.code = "BANKING_NOT_AVAILABLE";
  err.httpStatus = 400;
  err.method = method;
  throw err;
}

class NullProvider extends PaymentProvider {
  get supportsBanking() { return false; }
  get supportsForeignAccounts() { return false; }

  provisionLocalAccount()   { notAvailable("provisionLocalAccount"); }
  provisionForeignAccount() { notAvailable("provisionForeignAccount"); }
  getAccountBalance()       { notAvailable("getAccountBalance"); }
  getBanks()                { notAvailable("getBanks"); }
  verifyRecipient()         { notAvailable("verifyRecipient"); }
  payout()                  { notAvailable("payout"); }
  verifyWebhook()           { return false; }
  parseWebhookEvent()       { notAvailable("parseWebhookEvent"); }

  // granular (deprecated)
  createBusinessCustomer()  { notAvailable("createBusinessCustomer"); }
  triggerKYB()              { notAvailable("triggerKYB"); }
  createDepositAccount()    { notAvailable("createDepositAccount"); }
  verifyCounterparty()      { notAvailable("verifyCounterparty"); }
  createCounterparty()      { notAvailable("createCounterparty"); }
  createTransfer()          { notAvailable("createTransfer"); }
  createBookTransfer()      { notAvailable("createBookTransfer"); }
  listCustomerDocuments()   { notAvailable("listCustomerDocuments"); }
  uploadDocument()          { notAvailable("uploadDocument"); }
}

module.exports = NullProvider;
