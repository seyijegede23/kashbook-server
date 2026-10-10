// Invoice payment-terms codes. The app derives the due date from them
// (CreateInvoiceScreen dueFromTerms); "custom" means a due date picked by hand.
const PAYMENT_TERMS = [
  "due_on_receipt", "net_15", "net_30", "net_45", "net_60",
  "due_end_of_month", "due_end_of_next_month", "custom",
];

// A customer's default terms: any of the above except "custom", which has no
// day count to apply to a new invoice.
const CUSTOMER_TERMS = PAYMENT_TERMS.filter((t) => t !== "custom");

module.exports = { PAYMENT_TERMS, CUSTOMER_TERMS };
