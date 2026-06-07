// Abstract banking provider interface. Implementations live in this folder
// and are selected per-business via `index.js → getProvider(business)`.
//
// The interface is intentionally narrow — only the operations route handlers
// actually call today. Adding a new provider (Korba, M-Pesa Daraja, Stitch)
// = subclass + register in `index.js`. Adding a new operation = add a method
// here + adapt every provider + the routes that call it.

class PaymentProvider {
  // True when the provider can actually issue accounts and move money.
  // False for the null provider (bookkeeping-only countries).
  get supportsBanking() {
    return false;
  }

  // KYB / customer creation
  async createBusinessCustomer(_args) {
    throw notImplemented(this, "createBusinessCustomer");
  }

  async triggerKYB(_customerId) {
    throw notImplemented(this, "triggerKYB");
  }

  async createDepositAccount(_args) {
    throw notImplemented(this, "createDepositAccount");
  }

  async getAccountBalance(_accountId) {
    throw notImplemented(this, "getAccountBalance");
  }

  async getBanks() {
    throw notImplemented(this, "getBanks");
  }

  async verifyCounterparty(_args) {
    throw notImplemented(this, "verifyCounterparty");
  }

  async createCounterparty(_args) {
    throw notImplemented(this, "createCounterparty");
  }

  async createTransfer(_args) {
    throw notImplemented(this, "createTransfer");
  }

  async createBookTransfer(_args) {
    throw notImplemented(this, "createBookTransfer");
  }

  verifyWebhook(_req) {
    throw notImplemented(this, "verifyWebhook");
  }

  async listCustomerDocuments(_customerId) {
    throw notImplemented(this, "listCustomerDocuments");
  }

  async uploadDocument(_args) {
    throw notImplemented(this, "uploadDocument");
  }
}

function notImplemented(self, method) {
  const err = new Error(`Provider ${self.constructor.name} does not implement ${method}`);
  err.code = "NOT_IMPLEMENTED";
  err.httpStatus = 501;
  return err;
}

module.exports = PaymentProvider;
