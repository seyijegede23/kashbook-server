// The books rule without a database: every event in the research report's
// table, both views, VAT, receivables, and that the app's copy is identical.
//   node scripts/books-test.js
const assert = require("assert");
const B = require("../src/utils/books");
const { build, APP } = require("./sync-books-mirror");
const fs = require("fs");

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${name}  →  ${e.message}`);
  }
}
const eq = (a, b) => assert.strictEqual(a, b, `${a} !== ${b}`);
const M = { from: "2026-10-01", to: "2026-10-31" };
const paid = (input, extra) => B.computeBooks(input, { ...M, ...extra });
const sold = (input, extra) => B.computeBooks(input, { ...M, basis: "sold", ...extra });

console.log("\nPayment kinds");
check("cash/card/cheque/transfer/other count", () => {
  for (const m of ["cash", "card", "cheque", "transfer", "other", "CASH"]) eq(B.paymentSalesAmount({ method: m, amount: 10 }), 10);
});
check("bank with a link counts, without a link counts nothing", () => {
  eq(B.paymentSalesAmount({ method: "bank", amount: 10, transactionId: "t" }), 10);
  eq(B.paymentSalesAmount({ method: "bank", amount: 10 }), 0);
});
check("credit settlements are not money", () => {
  eq(B.paymentSalesAmount({ method: "credit_note", amount: 10 }), 0);
  eq(B.paymentSalesAmount({ method: "credit_applied", amount: 10 }), 0);
});
check("refunds are negative, whatever the method", () => {
  eq(B.paymentSalesAmount({ method: "refund_cash", amount: 10 }), -10);
  eq(B.paymentSalesAmount({ method: "refund_bank", amount: 10, transactionId: "d" }), -10);
});

console.log("\nBank rows");
check("unmatched credit counts in full", () => eq(B.bankCountedAmount({ type: "income", amount: 500 }), 500));
check("matched credit counts its remainder only", () =>
  eq(B.bankCountedAmount({ type: "income", amount: 500, matchedInvoiceId: "i", matchedAmount: 300 }), 200));
check("old full match (null matchedAmount) counts nothing", () =>
  eq(B.bankCountedAmount({ type: "income", amount: 500, matchedSaleId: "s", matchedAmount: null }), 0));
check("any purpose counts nothing", () => {
  for (const p of ["cash_deposit", "own_transfer", "owner_money", "loan", "supplier_refund", "customer_refund", "savings_fee"]) {
    eq(B.bankCountedAmount({ type: "income", amount: 500, purpose: p }), 0);
  }
});

console.log("\nThe research example: ₦50,000 invoice paid in cash, ₦10,000 refunded in cash, ₦40,000 banked");
const example = {
  invoices: [
    { id: "i1", type: "invoice", status: "PAID", issueDate: "2026-10-02", total: 50000, taxAmount: 0, amountPaid: 50000,
      payments: [{ amount: 50000, method: "cash", date: "2026-10-02" }] },
    { id: "c1", type: "credit_note", status: "PAID", issueDate: "2026-10-05", total: 10000, taxAmount: 0, amountPaid: 10000,
      payments: [{ amount: 10000, method: "refund_cash", date: "2026-10-05" }] },
  ],
};
check("banked cash marked as already recorded: sales ₦40,000", () => {
  const r = paid({ ...example, bankRows: [{ type: "income", amount: 40000, date: "2026-10-06", purpose: "cash_deposit" }] });
  eq(r.sales.total, 40000);
  eq(r.sales.lines.refunds.gross, -10000);
});
check("deposit left unexplained: sales ₦80,000 (why both ship together)", () => {
  const r = paid({ ...example, bankRows: [{ type: "income", amount: 40000, date: "2026-10-06" }] });
  eq(r.sales.total, 80000);
});
check("refund by transfer from the account: no expense, sales net zero", () => {
  const r = paid({
    invoices: [
      { type: "invoice", status: "PAID", issueDate: "2026-10-02", total: 30000, payments: [{ amount: 30000, method: "bank", transactionId: "cr", date: "2026-10-02" }] },
      { type: "credit_note", status: "PAID", issueDate: "2026-10-03", total: 30000, payments: [{ amount: 30000, method: "refund_bank", transactionId: "db", date: "2026-10-03" }] },
    ],
    bankRows: [
      { id: "cr", type: "income", amount: 30000, date: "2026-10-02", matchedInvoiceId: "x", matchedAmount: 30000 },
      { id: "db", type: "expense", amount: 30000, date: "2026-10-03", purpose: "customer_refund" },
    ],
  });
  eq(r.sales.total, 0);
  eq(r.expenses.total, 0);
});

console.log("\nEvent table, when paid");
check("draft and issued invoices change nothing", () => {
  const r = paid({ invoices: [{ type: "invoice", status: "SENT", issueDate: "2026-10-02", total: 9000, payments: [] }] });
  eq(r.sales.total, 0);
});
check("credit applied to an invoice changes nothing", () => {
  const r = paid({
    invoices: [
      { type: "invoice", status: "PAID", total: 5000, payments: [{ amount: 5000, method: "credit_note", date: "2026-10-04" }] },
      { type: "credit_note", status: "PAID", total: 5000, payments: [{ amount: 5000, method: "credit_applied", date: "2026-10-04" }] },
    ],
  });
  eq(r.sales.total, 0);
});
check("payment outside the period is not counted", () => {
  const r = paid({ invoices: [{ type: "invoice", status: "PAID", total: 100, payments: [{ amount: 100, method: "cash", date: "2026-09-30" }] }] });
  eq(r.sales.total, 0);
});
check("quotes never count", () => {
  const r = paid({ invoices: [{ type: "quote", status: "SENT", total: 100, payments: [{ amount: 100, method: "cash", date: "2026-10-03" }] }] });
  eq(r.sales.total, 0);
});
check("credit sale with a debt counts when the customer pays", () => {
  const input = {
    sales: [{ id: "s1", amount: 20000, date: "2026-10-01", isCredit: true }],
    debts: [{ saleId: "s1", amount: 20000, paidAmount: 5000, date: "2026-10-01", payments: [{ amount: 5000, date: "2026-10-09" }] }],
  };
  const r = paid(input);
  eq(r.sales.total, 5000);
  eq(r.sales.lines.awaitingPayment.gross, 20000);
});
check("credit sale with no debt (legacy) still counts on its date", () => {
  eq(paid({ sales: [{ id: "s2", amount: 7000, date: "2026-10-01", isCredit: true }] }).sales.total, 7000);
});
check("credit given on the customer screen counts when repaid", () => {
  const r = paid({ debts: [{ amount: 9000, paidAmount: 9000, paid: true, date: "2026-09-01", payments: [{ amount: 9000, date: "2026-10-02" }] }] });
  eq(r.sales.total, 9000);
});
check("supplier refund lowers expenses, is not a sale", () => {
  const r = paid({
    expenses: [{ amount: 12000, date: "2026-10-01" }],
    bankRows: [{ type: "income", amount: 2000, date: "2026-10-03", purpose: "supplier_refund" }],
  });
  eq(r.sales.total, 0);
  eq(r.expenses.total, 10000);
});
check("bank debit recorded as an expense counts once", () => {
  const r = paid({
    expenses: [{ amount: 3000, date: "2026-10-01" }],
    bankRows: [{ type: "expense", amount: 3000, date: "2026-10-01", matchedExpenseId: "e", matchedAmount: 3000 }],
  });
  eq(r.expenses.total, 3000);
});

console.log("\nEvent table, when sold");
const docs = {
  invoices: [
    { type: "invoice", status: "PARTIAL", issueDate: "2026-10-02", total: 10750, taxAmount: 750, amountPaid: 5000,
      payments: [{ amount: 5000, method: "bank", transactionId: "t", date: "2026-10-04" }] },
    { type: "invoice", status: "DRAFT", issueDate: "2026-10-02", total: 999, payments: [] },
    { type: "invoice", status: "VOID", issueDate: "2026-10-02", total: 888, payments: [] },
    { type: "credit_note", status: "SENT", issueDate: "2026-10-07", total: 1075, taxAmount: 75, payments: [] },
    { type: "invoice", status: "SENT", issueDate: "2026-09-02", total: 4000, amountPaid: 1000, writtenOffAt: "2026-10-20", writtenOffAmount: 3000, payments: [] },
  ],
  bankRows: [
    { type: "income", amount: 5000, date: "2026-10-04", matchedInvoiceId: "x", matchedAmount: 5000 },
    { type: "income", amount: 2500, date: "2026-10-05" },
  ],
};
check("issued invoices minus credit notes; drafts and voids out", () => {
  const r = sold(docs);
  eq(r.sales.lines.invoiced.gross, 10750);
  eq(r.sales.lines.creditNotes.gross, -1075);
  eq(r.sales.total, 9675);
});
check("an unlinked credit is 'not yet explained', outside sales", () => eq(sold(docs).sales.lines.unexplained.gross, 2500));
check("a write-off is bad debt in the when-sold view only", () => {
  eq(sold(docs).expenses.lines.badDebts.gross, 3000);
  eq(paid(docs).expenses.total, 0);
});
check("credit sales count on their date; screen debts on theirs", () => {
  const r = sold({
    sales: [{ id: "s1", amount: 20000, date: "2026-10-01", isCredit: true }],
    debts: [
      { saleId: "s1", amount: 20000, date: "2026-10-01", payments: [{ amount: 5000, date: "2026-10-09" }] },
      { amount: 3000, date: "2026-10-03", payments: [] },
    ],
  });
  eq(r.sales.total, 23000);
});

console.log("\nVAT");
check("VAT off: sales are gross, no VAT", () => {
  const r = paid({ sales: [{ amount: 10750, date: "2026-10-01" }] });
  eq(r.sales.total, 10750);
  eq(r.sales.vat, 0);
});
check("VAT on, inclusive: a ₦10,750 sale is ₦10,000 net", () => {
  const r = paid({ sales: [{ amount: 10750, date: "2026-10-01" }] }, { vat: { enabled: true, rate: 7.5 } });
  eq(r.sales.vat, 750);
  eq(r.sales.total, 10000);
});
check("invoice payment carries the invoice's own VAT share", () => {
  const r = paid(docs, { vat: { enabled: true, rate: 7.5 } });
  eq(r.sales.lines.invoicePayments.vat, Math.round(5000 * 750 / 10750 * 100) / 100);
});
check("VAT return: invoice date, credit note month, deadline the 21st", () => {
  const v = B.vatReturn({ ...docs, sales: [{ amount: 1075, date: "2026-10-10" }] }, "2026-10", { enabled: true, rate: 7.5 });
  eq(v.invoices.vat, 750);
  eq(v.creditNotes.vat, -75);
  eq(v.sales.vat, 75);
  eq(v.output, 750);
  eq(v.deadline, "2026-11-21");
  eq(B.vatDeadline("2026-12"), "2027-01-21");
});

check("an unexplained credit carries VAT even when sales are recorded net (exclusive)", () => {
  const vat = { enabled: true, rate: 7.5, inclusive: false };
  const r = paid({
    sales: [{ amount: 10000, date: "2026-10-01" }],
    bankRows: [{ type: "income", amount: 10750, date: "2026-10-02" }],
    debts: [{ amount: 2150, date: "2026-09-01", payments: [{ amount: 2150, date: "2026-10-03" }] }],
  }, { vat });
  eq(r.sales.lines.recorded.vat, 0);
  eq(r.sales.lines.bank.vat, 750);
  eq(r.sales.lines.debtPayments.vat, 0); // the debt was recorded net, like the sale
  eq(paid({ debts: [{ amount: 2150, date: "2026-09-01", payments: [{ amount: 2150, date: "2026-10-03" }] }] }, { vat: { enabled: true, rate: 7.5 } }).sales.lines.debtPayments.vat, 150);
  eq(B.vatInsideReceived(10750, B.vatSettings({ enabled: false })), 0);
});
check("a write-off is bad debt at the full unpaid amount, VAT included", () => {
  const r = sold({
    invoices: [{ type: "invoice", status: "SENT", issueDate: "2026-09-02", total: 10750, taxAmount: 750, amountPaid: 0,
      writtenOffAt: "2026-10-20", writtenOffAmount: 10750, payments: [] }],
  }, { vat: { enabled: true, rate: 7.5 } });
  eq(r.expenses.lines.badDebts.gross, 10750);
  eq(r.expenses.total, 10750);
});
check("VAT return: money received before the invoice date is taxed in its own month", () => {
  const inv = {
    type: "invoice", status: "PARTIAL", issueDate: "2026-11-05", total: 10750, taxAmount: 750, amountPaid: 5375,
    payments: [
      { amount: 5375, method: "cash", date: "2026-10-20" },
      { amount: 100, method: "credit_note", date: "2026-10-21" }, // settlement: not money
    ],
  };
  const vat = { enabled: true, rate: 7.5 };
  const oct = B.vatReturn({ invoices: [inv] }, "2026-10", vat);
  eq(oct.advance.vat, 375);
  eq(oct.advance.count, 1);
  eq(oct.invoices.vat, 375);
  eq(oct.output, 375);
  const nov = B.vatReturn({ invoices: [inv] }, "2026-11", vat);
  eq(nov.invoices.vat, 375);
  eq(nov.advance.vat, 0);
  const sameDay = B.vatReturn({ invoices: [{ ...inv, payments: [{ amount: 5375, method: "cash", date: "2026-11-05" }] }] }, "2026-11", vat);
  eq(sameDay.invoices.vat, 750);
  eq(sameDay.advance.vat, 0);
});

console.log("\nVoid documents and older credit sales");
check("a void invoice's payments do not count when paid", () => {
  const r = paid({ invoices: [{ type: "invoice", status: "VOID", total: 900, payments: [{ amount: 900, method: "cash", date: "2026-10-03" }] }] });
  eq(r.sales.total, 0);
});
check("a credit sale with no debt is named on its own info line", () => {
  const r = paid({ sales: [{ id: "s2", amount: 7000, date: "2026-10-01", isCredit: true }, { id: "s3", amount: 500, date: "2026-10-01" }] });
  eq(r.sales.lines.creditUnlinked.gross, 7000);
  eq(r.sales.lines.recorded.gross, 7500);
  eq(r.sales.total, 7500);
});

console.log("\nRows agree with totals");
const mixed = {
  sales: [
    { id: "s1", amount: 1000, date: "2026-10-01" },
    { id: "s2", amount: 2000, date: "2026-10-02", isCredit: true },
    { id: "s3", amount: 400, date: "2026-10-03", isCredit: true },
    { id: "s4", amount: 999, date: "2026-11-01" },
  ],
  expenses: [{ id: "e1", amount: 300, date: "2026-10-04" }],
  bankRows: [
    { id: "b1", type: "income", amount: 5000, date: "2026-10-05" },
    { id: "b2", type: "income", amount: 6000, date: "2026-10-05", matchedInvoiceId: "i1", matchedAmount: 4000 },
    { id: "b3", type: "income", amount: 700, date: "2026-10-06", purpose: "supplier_refund" },
    { id: "b4", type: "income", amount: 800, date: "2026-10-06", purpose: "owner_money" },
    { id: "b5", type: "expense", amount: 250, date: "2026-10-07" },
  ],
  invoices: [
    { id: "i1", type: "invoice", status: "PAID", issueDate: "2026-10-02", total: 4300, taxAmount: 300, customerId: "c1",
      payments: [{ id: "p1", amount: 4000, method: "bank", transactionId: "b2", date: "2026-10-05" }, { id: "p2", amount: 300, method: "cash", date: "2026-10-06" }] },
    { id: "i2", type: "invoice", status: "SENT", issueDate: "2026-10-08", total: 2000, taxAmount: 0, customerId: "c2",
      writtenOffAt: "2026-10-30", writtenOffAmount: 2000, payments: [] },
    { id: "i3", type: "invoice", status: "VOID", issueDate: "2026-10-08", total: 50, payments: [{ id: "p3", amount: 50, method: "cash", date: "2026-10-08" }] },
    { id: "n1", type: "credit_note", status: "PAID", issueDate: "2026-10-09", total: 500, taxAmount: 0, customerId: "c1",
      payments: [{ id: "p4", amount: 500, method: "refund_cash", date: "2026-10-09" }] },
  ],
  debts: [
    { id: "d1", saleId: "s2", customerId: "c3", amount: 2000, date: "2026-10-02", payments: [{ id: "q1", amount: 1500, date: "2026-10-10" }] },
    { id: "d2", customerId: "c4", amount: 600, date: "2026-10-11", payments: [{ id: "q2", amount: 600, date: "2026-10-12" }] },
  ],
};
for (const basis of ["paid", "sold"]) {
  check(`${basis}: income rows sum to gross sales, expense rows to expenses`, () => {
    const r = B.computeBooks(mixed, { ...M, basis });
    const rows = B.bookRows(mixed, basis).filter((x) => B.inRange(x.date, M.from, M.to));
    const sum = (type) => B.round2(rows.filter((x) => x.type === type).reduce((s, x) => s + x.amount, 0));
    eq(sum("income"), r.sales.gross);
    eq(sum("expense"), r.expenses.total);
  });
}
check("invoice and debt payment rows name the customer and the channel", () => {
  const rows = B.bookRows(mixed, "paid");
  const ip = rows.find((x) => x.id === "ip_p2");
  eq(ip.customerId, "c1");
  eq(ip.channel, "invoice");
  const dp = rows.find((x) => x.id === "dp_q1");
  eq(dp.customerId, "c3");
  eq(dp.channel, "credit_repaid");
  eq(rows.some((x) => x.id === "ip_p3"), false); // void
});

console.log("\nReceivables");
check("owed to you: open invoices (not written off) + unpaid debts", () => {
  const r = B.receivables({
    invoices: [
      { type: "invoice", status: "PARTIAL", total: 10000, amountPaid: 4000 },
      { type: "invoice", status: "SENT", total: 500, amountPaid: 0, writtenOffAt: "2026-10-01" },
      { type: "invoice", status: "DRAFT", total: 700, amountPaid: 0 },
      { type: "credit_note", status: "PARTIAL", total: 3000, amountPaid: 1000 },
    ],
    debts: [{ amount: 2000, paidAmount: 500 }, { amount: 100, paidAmount: 100, paid: true }],
  });
  eq(r.owedToYou, 7500);
  eq(r.youOweCustomers, 2000);
});

console.log("\nDates");
check("Date objects are read in Lagos time", () => {
  eq(B.dayKey(new Date("2026-10-31T23:30:00Z")), "2026-11-01");
  eq(B.dayKey("2026-10-31T23:30:00Z"), "2026-10-31");
});

console.log("\nMirror");
check("the app's src/utils/books.js is the server file, ES-module exports", () => {
  const have = fs.readFileSync(APP, "utf8").replace(/\r\n/g, "\n");
  assert.ok(have === build(), "out of date: run node scripts/sync-books-mirror.js");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
