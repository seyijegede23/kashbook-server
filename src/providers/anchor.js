// Anchor provider — wraps the existing helpers in utils/anchor.js verbatim.
// Adding a method here is just `(...args) => anchor.method(...args)`. The
// goal is *zero behavioural change* for Nigerian users.

const PaymentProvider = require("./PaymentProvider");
const anchor = require("../utils/anchor");

class AnchorProvider extends PaymentProvider {
  get supportsBanking() {
    return true;
  }

  // KYB / customer
  createBusinessCustomer(args)  { return anchor.createBusinessCustomer(args); }
  triggerKYB(id)                { return anchor.triggerKYB(id); }
  createDepositAccount(args)    { return anchor.createDepositAccount(args); }
  getAccountBalance(id)         { return anchor.getAccountBalance(id); }
  getBanks()                    { return anchor.getBanks(); }
  verifyCounterparty(args)      { return anchor.verifyCounterparty(args); }
  createCounterparty(args)      { return anchor.createCounterparty(args); }
  createTransfer(args)          { return anchor.createTransfer(args); }
  createBookTransfer(args)      { return anchor.createBookTransfer(args); }
  verifyWebhook(req)            { return anchor.verifyWebhook(req); }
  listCustomerDocuments(id)     { return anchor.listCustomerDocuments(id); }
  uploadDocument(args)          { return anchor.uploadDocument(args); }
}

module.exports = AnchorProvider;
