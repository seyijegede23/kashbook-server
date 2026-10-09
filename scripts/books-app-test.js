// The app's side of the books rule, run in Node: the Reports rows must add up
// to computeBooks' totals in both views, the activity list's extra rows must
// not repeat money a bank row already shows, the review queue must find an
// invoice whose balance arrived, and the export must keep the links.
// Loads the app's ES modules through Babel (needs the app's node_modules).
//   node scripts/books-app-test.js
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const APP = path.resolve(__dirname, "../..");
const babel = require(require.resolve("@babel/core", { paths: [APP] }));
const cjs = require.resolve("@babel/plugin-transform-modules-commonjs", { paths: [APP] });

const cache = new Map();
function load(rel) {
  const file = path.resolve(APP, "src/utils", rel.endsWith(".js") ? rel : `${rel}.js`);
  if (cache.has(file)) return cache.get(file).exports;
  const { code } = babel.transformSync(fs.readFileSync(file, "utf8"), { filename: file, plugins: [cjs], babelrc: false, configFile: false });
  const mod = { exports: {} };
  cache.set(file, mod);
  const localRequire = (p) => (p.startsWith("./") ? load(p.slice(2)) : require(p));
  new Function("exports", "require", "module", code)(mod.exports, localRequire, mod);
  return mod.exports;
}

const books = load("books");
const { reportRows } = load("reportRows");
const { moneyRowsFrom } = load("moneyRows");
const { reviewQueue, rankInvoicesForCredit } = load("review");
const { booksCsv } = load("booksExport");

let passed = 0;
let failed = 0;
const check = (name, fn) => {
  try {
    fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${name}  →  ${e.message}`);
  }
};
const r2 = (n) => Math.round(n * 100) / 100;
const sum = (rows, type) => r2(rows.filter((r) => r.type === type).reduce((s, r) => s + r.amount, 0));

// A month with everything in it.
const input = {
  sales: [
    { id: "s1", amount: 12000, date: "2026-10-01", isCredit: false, source: "sale" },
    { id: "s2", amount: 20000, date: "2026-10-02", isCredit: true, source: "sale" },
    { id: "s3", amount: 5000, date: "2026-10-03", isCredit: true, source: "sale" },
  ],
  expenses: [{ id: "e1", amount: 3000, date: "2026-10-04", source: "expense", category: "rent" }],
  bankRows: [
    { id: "c1", type: "income", amount: 50000, date: "2026-10-05", source: "transaction", matchedInvoiceId: "i1", matchedAmount: 30000 },
    { id: "c2", type: "income", amount: 7000, date: "2026-10-06", source: "transaction" },
    { id: "c3", type: "income", amount: 9000, date: "2026-10-07", source: "transaction", purpose: "cash_deposit" },
    { id: "c4", type: "income", amount: 1500, date: "2026-10-08", source: "transaction", purpose: "supplier_refund" },
    { id: "d1", type: "expense", amount: 4000, date: "2026-10-09", source: "transaction" },
    { id: "d2", type: "expense", amount: 2500, date: "2026-10-10", source: "transaction", purpose: "customer_refund" },
    { id: "d3", type: "expense", amount: 3000, date: "2026-10-04", source: "transaction", matchedExpenseId: "e1", matchedAmount: 3000 },
  ],
  invoices: [
    { id: "i1", type: "invoice", status: "paid", issueDate: "2026-10-01", total: 30000, taxAmount: 0, amountPaid: 30000, invoiceNumber: "INV-001", customerId: "k1", customerName: "Bola",
      payments: [{ id: "p1", amount: 30000, method: "bank", transactionId: "c1", date: "2026-10-05" }] },
    { id: "i2", type: "invoice", status: "partial", issueDate: "2026-10-02", total: 10000, taxAmount: 0, amountPaid: 6000, invoiceNumber: "INV-002", customerId: "k2", customerName: "Chika Obi",
      payments: [{ id: "p2", amount: 4000, method: "cash", date: "2026-10-03" }, { id: "p3", amount: 2000, method: "credit_note", date: "2026-10-04" }] },
    { id: "i3", type: "invoice", status: "sent", issueDate: "2026-10-03", total: 7000, taxAmount: 0, amountPaid: 0, invoiceNumber: "INV-003", customerId: "k3", customerName: "Ada",
      payments: [] },
    { id: "n1", type: "credit_note", status: "paid", issueDate: "2026-10-04", total: 4500, taxAmount: 0, amountPaid: 4500, invoiceNumber: "CN-001", customerId: "k2", customerName: "Chika Obi",
      payments: [{ id: "p4", amount: 2000, method: "credit_applied", date: "2026-10-04" }, { id: "p5", amount: 2500, method: "refund_bank", transactionId: "d2", date: "2026-10-10" }] },
    { id: "q1", type: "quote", status: "sent", issueDate: "2026-10-01", total: 999, payments: [] },
  ],
  debts: [
    { id: "b1", saleId: "s2", amount: 20000, paidAmount: 8000, date: "2026-10-02", payments: [{ id: "dp1", amount: 8000, date: "2026-10-09" }] },
    { id: "b2", amount: 6000, paidAmount: 1000, date: "2026-10-03", payments: [{ id: "dp2", amount: 1000, date: "2026-10-06", transactionId: null }] },
  ],
};
const M = { from: "2026-10-01", to: "2026-10-31" };

console.log("\nReports rows agree with the rule");
for (const basis of ["paid", "sold"]) {
  check(`${basis}: income rows = gross sales, expense rows = expenses`, () => {
    const b = books.computeBooks(input, { ...M, basis });
    const rows = reportRows(input, basis);
    assert.strictEqual(sum(rows, "income"), b.sales.gross, `income ${sum(rows, "income")} vs ${b.sales.gross}`);
    assert.strictEqual(sum(rows, "expense"), b.expenses.total, `expense ${sum(rows, "expense")} vs ${b.expenses.total}`);
  });
}
check("paid: the expected figures", () => {
  const b = books.computeBooks(input, M);
  // 12000 + 5000 (s3: credit, no debt) + 30000 (bank inv) + 4000 cash + 8000 + 1000 debt payments
  // + 20000 (c1 remainder) + 7000 (c2) − 2500 refund
  assert.strictEqual(b.sales.total, 84500);
  // 3000 recorded + 4000 unmatched debit − 1500 supplier refund
  assert.strictEqual(b.expenses.total, 5500);
});
check("sold: the expected figures", () => {
  const b = books.computeBooks(input, { ...M, basis: "sold" });
  // 37000 sales + 47000 invoiced − 4500 credit note + 6000 screen credit
  assert.strictEqual(b.sales.total, 85500);
  assert.strictEqual(b.sales.lines.unexplained.gross, 27000);
});

console.log("\nActivity list rows");
check("cash payments, refunds by cash and hand-recorded repayments only", () => {
  const rows = moneyRowsFrom({ invoices: input.invoices, customers: [{ id: "k9", name: "X", transactions: input.debts }] });
  const ids = rows.map((r) => r.id).sort();
  assert.deepStrictEqual(ids, ["dp_dp1", "dp_dp2", "ip_p2"]);
});

console.log("\nReview queue");
check("finds the invoice whose balance arrived, and only unexplained credits", () => {
  const tx = [...input.bankRows, { id: "c5", type: "income", amount: 7000, date: "2026-10-12", source: "transaction" }];
  const q = reviewQueue({ transactions: tx, invoices: input.invoices });
  assert.deepStrictEqual(q.credits.map((c) => c.id).sort(), ["c2", "c5"]);
  assert.strictEqual(q.looksPaid.length, 1);
  assert.strictEqual(q.looksPaid[0].invoice.id, "i3");
  assert.deepStrictEqual(q.looksPaid[0].credits.map((c) => c.id).sort(), ["c2", "c5"]);
});
check("recorded twice: a hand payment and a credit of the same amount within 3 days", () => {
  const tx = [
    ...input.bankRows,
    { id: "c6", type: "income", amount: 4000, date: "2026-10-05", source: "transaction" }, // p2 (cash, 10-03)
    { id: "c7", type: "income", amount: 4000, date: "2026-10-10", source: "transaction" }, // 7 days: no
    { id: "c8", type: "income", amount: 1000, date: "2026-10-07", source: "transaction" }, // dp2 (10-06)
  ];
  const voided = { id: "i9", type: "invoice", status: "void", total: 4000, payments: [{ id: "p9", amount: 4000, method: "cash", date: "2026-10-05" }] };
  const q = reviewQueue({
    transactions: tx,
    invoices: [...input.invoices, voided],
    customers: [{ id: "k9", name: "X", transactions: input.debts }],
  });
  assert.deepStrictEqual(q.recordedTwice.map((x) => `${x.payment.id}:${x.credits.map((c) => c.id).join("+")}`), ["p2:c6"]);
  assert.deepStrictEqual(q.repaidTwice.map((x) => `${x.payment.id}:${x.credits.map((c) => c.id).join("+")}`), ["dp2:c8"]);
  assert.strictEqual(q.repaidTwice[0].customer.id, "k9");
});
check("ranking: exact amount and the payer's name first", () => {
  const credit = { amount: 4000, date: "2026-10-05", senderName: "OBI CHIKA" };
  const ranked = rankInvoicesForCredit(credit, input.invoices);
  assert.strictEqual(ranked[0].invoice.id, "i2");
  assert.ok(ranked[0].reasons.includes("amount") && ranked[0].reasons.includes("name"), ranked[0].reasons.join());
});

console.log("\nExport");
check("payments keep their bank link and say how they counted", () => {
  const csv = booksCsv({ businessName: "Test", invoices: input.invoices.filter((i) => i.type !== "quote"), transactions: input.bankRows });
  assert.ok(csv.includes('"INV-001"') && csv.includes('"c1"'), "linked credit id missing");
  assert.ok(csv.includes("Lowers sales, on the refund date"), "refund rule missing");
  assert.ok(csv.includes("Not money: credit from a credit note"), "settlement rule missing");
  assert.ok(!csv.includes("QTE"), "quotes must not be exported");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
