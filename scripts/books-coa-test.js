// The books rule's chart-of-accounts additions (2026-10-11), with expected
// numbers: transfer fees as bank charges in both views, expenses booked to a
// balance-sheet account (equipment, prepaid rent) counted nowhere, bank rows
// explained with an account (income, other income, expense, balance sheet),
// and no longer waiting to be matched once explained so (2026-10-12), rows in
// another currency left out, itemized expenses (2026-10-12) counted line by
// line, and bookRows still adding up to the totals with all of it present.
// Release 2 (2026-10-13): bills (payments when paid, the bill on its date when
// sold, a loan never, a payment outside the books never, a debit that paid a
// bill no longer counting itself), manual journals (their lines on income and
// spending, both views), and the VAT estimate with bills. Release 3
// (2026-10-13): what the goods sold cost (on the document's date when sold,
// with the money when paid, a credit note's goods back as a negative cost),
// services costing nothing, unknown costs, stock adjustments and new values,
// restocks (never spending, in the VAT estimate), with exact numbers.
//
//   node scripts/books-coa-test.js
const assert = require("assert");
const books = require("../src/utils/books");

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${name}\n        ${String(e.message).split("\n")[0]}`);
  }
}
const eq = (a, b, what = "") => assert.strictEqual(a, b, `${what} ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);

// The chart as the loaders pass it: { id: { cls, type } }.
const accounts = {
  furniture: { cls: "asset", type: "fixed_asset" },
  prepaid: { cls: "asset", type: "other_current_asset" },
  rent: { cls: "expense", type: "expense" },
  sales: { cls: "income", type: "income" },
  interest: { cls: "income", type: "other_income" },
  equity: { cls: "equity", type: "equity" },
  drawings: { cls: "equity", type: "equity" },
  cogs: { cls: "expense", type: "cost_of_goods_sold" },
};
const VAT = { enabled: true, rate: 7.5, inclusive: true };
const both = (fn) => ["paid", "sold"].forEach(fn);

console.log("\nBOOKS RULE — CHART OF ACCOUNTS ADDITIONS");

console.log("\n── Transfer fees");
test("a debit's fee is a bank charge in both views, on top of the debit", () => {
  const input = { bankRows: [{ id: "t1", type: "expense", amount: 10000, fee: 53.75, date: "2026-10-01" }] };
  both((basis) => {
    const b = books.computeBooks(input, { basis });
    eq(b.expenses.lines.bank.gross, 10000, basis);
    eq(b.expenses.lines.bankCharges.gross, 53.75, basis);
    eq(b.expenses.total, 10053.75, basis);
  });
});
test("the fee counts even when the debit itself counts nothing (matched, refund, explained)", () => {
  const input = {
    bankRows: [
      { id: "t1", type: "expense", amount: 5000, fee: 26.88, matchedExpenseId: "e1", date: "2026-10-01" },
      { id: "t2", type: "expense", amount: 3000, fee: 10.75, purpose: "customer_refund", date: "2026-10-01" },
      { id: "t3", type: "expense", amount: 2000, fee: 10.75, accountId: "drawings", purpose: "account", date: "2026-10-01" },
    ],
    accounts,
  };
  const b = books.computeBooks(input, { basis: "paid" });
  eq(b.expenses.lines.bank.gross, 0, "debits");
  eq(b.expenses.lines.bankCharges.gross, 48.38, "fees");
  eq(b.expenses.total, 48.38);
});
test("a credit's fee field is ignored (a Fincra credit's amount is already net)", () => {
  const b = books.computeBooks({ bankRows: [{ id: "t1", type: "income", amount: 1000, fee: 20, date: "2026-10-01" }] }, { basis: "paid" });
  eq(b.expenses.lines.bankCharges.gross, 0);
});
test("a savings break fee is a bank charge", () => {
  const b = books.computeBooks({ bankRows: [{ id: "t1", type: "expense", amount: 200, purpose: "savings_fee", date: "2026-10-01" }] }, { basis: "paid" });
  eq(b.expenses.lines.bankCharges.gross, 200);
  eq(b.expenses.total, 200);
});

console.log("\n── Expenses booked to an account");
test("an expense booked to equipment or a prepayment is not spending", () => {
  const input = {
    expenses: [
      { id: "e1", amount: 50000, accountId: "furniture", date: "2026-10-01" },
      { id: "e2", amount: 120000, accountId: "prepaid", date: "2026-10-01" },
      { id: "e3", amount: 8000, accountId: "rent", date: "2026-10-01" },
      { id: "e4", amount: 1500, date: "2026-10-01" },
      { id: "e5", amount: 700, accountId: "not-in-this-chart", date: "2026-10-01" },
    ],
    accounts,
  };
  both((basis) => eq(books.computeBooks(input, { basis }).expenses.total, 10200, basis));
});

console.log("\n── Bank credits explained with an account");
// Since 2026-10-12 "when paid" also puts a credit called income on its own line
// (bankIncome, as "when sold" does). Before, it was merged into "bank", which
// the Reports card calls "Transfers not linked to a record". The totals are the
// same either way.
test("a credit called income counts in both views, on its own line; unexplained counts only when paid", () => {
  const input = {
    bankRows: [
      { id: "t1", type: "income", amount: 10750, accountId: "sales", date: "2026-10-01" },
      { id: "t2", type: "income", amount: 5000, date: "2026-10-01" },
    ],
    accounts,
  };
  const paid = books.computeBooks(input, { basis: "paid", vat: VAT });
  eq(paid.sales.lines.bankIncome.gross, 10750, "paid: the explained one, on its own line");
  eq(paid.sales.lines.bankIncome.vat, 750, "paid VAT inside the explained one");
  eq(paid.sales.lines.bank.gross, 5000, "paid: only the other is a transfer not linked to a record");
  eq(paid.sales.lines.bank.vat, 348.84, "paid VAT inside the other");
  eq(paid.sales.gross, 15750, "paid: both count, as before");
  eq(paid.sales.total, 14651.16, "paid total, net of VAT, as before");
  const sold = books.computeBooks(input, { basis: "sold", vat: VAT });
  eq(sold.sales.lines.bankIncome.gross, 10750, "sold: the explained one");
  eq(sold.sales.lines.bankIncome.vat, 750, "sold VAT");
  eq(sold.sales.lines.unexplained.gross, 5000, "sold: the other stays outside sales");
  eq(sold.sales.total, 10000, "sold total, net of VAT");
});
test("what a match leaves of a credit called income stays on the income line in both views", () => {
  const input = {
    bankRows: [{ id: "t1", type: "income", amount: 10000, accountId: "sales", matchedSaleId: "s1", matchedAmount: 6000, date: "2026-10-01" }],
    accounts,
  };
  both((basis) => {
    const b = books.computeBooks(input, { basis });
    eq(b.sales.lines.bankIncome.gross, 4000, basis);
    eq(b.sales.lines.bank.gross, 0, basis);
    eq(b.sales.lines.unexplained.gross, 0, basis);
    eq(b.sales.total, 4000, basis);
  });
});
test("interest income carries no VAT", () => {
  const input = { bankRows: [{ id: "t1", type: "income", amount: 1000, accountId: "interest", date: "2026-10-01" }], accounts };
  both((basis) => {
    const b = books.computeBooks(input, { basis, vat: VAT });
    eq(b.sales.total, 1000, basis);
  });
});
test("a credit called an expense lowers that spending, like a supplier refund", () => {
  const input = { bankRows: [{ id: "t1", type: "income", amount: 2000, accountId: "rent", date: "2026-10-01" }], accounts };
  both((basis) => {
    const b = books.computeBooks(input, { basis });
    eq(b.expenses.lines.supplierRefunds.gross, -2000, basis);
    eq(b.expenses.total, -2000, basis);
    eq(b.sales.total, 0, basis);
  });
});
test("a credit or debit called a balance-sheet account counts nowhere", () => {
  const input = {
    bankRows: [
      { id: "t1", type: "income", amount: 300000, accountId: "equity", purpose: "owner_money", date: "2026-10-01" },
      { id: "t2", type: "expense", amount: 40000, accountId: "drawings", purpose: "account", date: "2026-10-01" },
      { id: "t3", type: "expense", amount: 9000, accountId: "furniture", date: "2026-10-01" },
    ],
    accounts,
  };
  both((basis) => {
    const b = books.computeBooks(input, { basis });
    eq(b.sales.total, 0, basis);
    eq(b.expenses.total, 0, basis);
  });
});

console.log("\n── Credits nobody has explained");
// Explaining a credit with an income account sets the account and leaves the
// purpose empty (POST /transactions/:id/categorize), so the account alone must
// take it off the "to match" list.
const credit = (over) => ({ type: "income", amount: 1000, date: "2026-10-01", purpose: null, ...over });
test("a credit explained by its account alone is explained; one linked to nothing is not", () => {
  eq(books.isUnexplainedCredit(credit({ id: "t1" })), true, "linked to nothing");
  eq(books.isUnexplainedCredit(credit({ id: "t2", accountId: "sales" })), false, "an income account, no purpose");
  eq(books.isUnexplainedCredit(credit({ id: "t3", accountId: "interest" })), false, "other income, no purpose");
  eq(books.isUnexplainedCredit(credit({ id: "t4", accountId: "rent", purpose: "supplier_refund" })), false, "an expense account");
  eq(books.isUnexplainedCredit(credit({ id: "t5", accountId: "equity", purpose: "owner_money" })), false, "a balance-sheet account");
  eq(books.isUnexplainedCredit(credit({ id: "t6", purpose: "loan" })), false, "a purpose");
  eq(books.isUnexplainedCredit(credit({ id: "t7", matchedSaleId: "s1", matchedAmount: 1000 })), false, "matched");
  eq(books.isUnexplainedCredit(credit({ id: "t8", type: "expense" })), false, "money out");
});
test("what it calls unexplained is exactly what 'when sold' leaves outside sales and 'when paid' calls not linked", () => {
  const input = {
    bankRows: [
      credit({ id: "t1", amount: 5000 }),
      credit({ id: "t2", amount: 2400, date: "2026-10-02" }),
      credit({ id: "t3", amount: 3000, accountId: "sales" }),
      credit({ id: "t4", amount: 1200, accountId: "interest" }),
      credit({ id: "t5", amount: 2000, accountId: "rent", purpose: "supplier_refund" }),
      credit({ id: "t6", amount: 300000, accountId: "equity", purpose: "owner_money" }),
      credit({ id: "t7", amount: 700, purpose: "loan" }),
      credit({ id: "t8", amount: 900, matchedSaleId: "s1", matchedAmount: 900 }),
    ],
    accounts,
  };
  const waiting = input.bankRows.filter(books.isUnexplainedCredit);
  assert.deepStrictEqual(waiting.map((t) => t.id), ["t1", "t2"]);
  const sold = books.computeBooks(input, { basis: "sold" });
  eq(sold.sales.lines.unexplained.gross, 7400, "sold: outside sales");
  eq(sold.sales.lines.unexplained.gross, waiting.reduce((s, t) => s + t.amount, 0), "the same credits");
  eq(sold.sales.lines.bankIncome.gross, 4200, "sold: the two explained by an income account are sales");
  // "When paid" counts the same unexplained credits as sales, under
  // "Transfers not linked to a record", and the explained ones on their own line.
  const paid = books.computeBooks(input, { basis: "paid" });
  eq(paid.sales.lines.bank.gross, waiting.reduce((s, t) => s + t.amount, 0), "paid: the same credits are not linked");
  eq(paid.sales.lines.bankIncome.gross, 4200, "paid: the two explained by an income account");
});

console.log("\n── Other currencies");
test("rows flagged foreign are left out of the naira books", () => {
  const input = {
    sales: [{ id: "s1", amount: 100, foreignCurrency: true, date: "2026-10-01" }, { id: "s2", amount: 5000, date: "2026-10-01" }],
    expenses: [{ id: "e1", amount: 80, foreignCurrency: true, date: "2026-10-01" }],
    bankRows: [
      { id: "t1", type: "income", amount: 500, foreignCurrency: true, date: "2026-10-01" },
      { id: "t2", type: "expense", amount: 400, fee: 2, foreignCurrency: true, date: "2026-10-01" },
    ],
  };
  both((basis) => {
    const b = books.computeBooks(input, { basis });
    eq(b.sales.total, 5000, basis);
    eq(b.expenses.total, 0, basis);
  });
});

console.log("\n── Rows add up to the totals");
test("bookRows: income rows = gross sales, expense rows = expenses, with every new kind present", () => {
  const input = {
    sales: [{ id: "s1", amount: 5000, date: "2026-10-01" }],
    expenses: [{ id: "e1", amount: 900, date: "2026-10-01" }, { id: "e2", amount: 7000, accountId: "furniture", date: "2026-10-01" }],
    bankRows: [
      { id: "t1", type: "expense", amount: 10000, fee: 53.75, date: "2026-10-02", description: "To Ada" },
      { id: "t2", type: "income", amount: 3000, accountId: "sales", date: "2026-10-02" },
      { id: "t3", type: "income", amount: 1000, accountId: "rent", date: "2026-10-02" },
      { id: "t4", type: "expense", amount: 150, purpose: "savings_fee", date: "2026-10-02" },
      { id: "t5", type: "income", amount: 2500, date: "2026-10-03" },
    ],
    accounts,
  };
  both((basis) => {
    const rows = books.bookRows(input, basis);
    const b = books.computeBooks(input, { basis });
    const inc = rows.filter((r) => r.type === "income").reduce((s, r) => s + r.amount, 0);
    const exp = rows.filter((r) => r.type === "expense").reduce((s, r) => s + r.amount, 0);
    eq(Math.round(inc * 100) / 100, b.sales.gross, `${basis} income`);
    eq(Math.round(exp * 100) / 100, b.expenses.total, `${basis} expenses`);
    const fee = rows.find((r) => r.id === "fee_t1");
    assert.ok(fee && fee.amount === 53.75 && fee.category === "bank_charges" && fee.description === "To Ada", `${basis} fee row`);
    eq(rows.filter((r) => r.id === "t2" && r.amount === 3000).length, 1, `${basis}: the credit called income is one row`);
  });
});

console.log("\n── Itemized expenses");
// One expense, five lines: rent and stock (spending), furniture and rent paid
// ahead (the balance sheet), and a line on an account this chart doesn't know.
const itemized = (over = {}) => ({
  id: "x1", amount: 72200, date: "2026-10-05", category: "rent", accountId: null, notes: "Shop fit-out",
  items: [
    { id: "l1", accountId: "rent", category: "rent", amount: 8000 },
    { id: "l2", accountId: "furniture", category: "other", amount: 50000 },
    { id: "l3", accountId: "prepaid", category: "other", amount: 12000 },
    { id: "l4", accountId: "cogs", category: "supplies", amount: 1500 },
    { id: "l5", accountId: "not-in-this-chart", category: "transport", amount: 700 },
  ],
  ...over,
});
const sumOf = (rows) => Math.round(rows.reduce((s, r) => s + r.amount, 0) * 100) / 100;

test("an itemized expense counts its spending lines only, in both views", () => {
  const input = { expenses: [itemized()], accounts };
  both((basis) => {
    const b = books.computeBooks(input, { basis });
    eq(b.expenses.lines.recorded.gross, 10200, `${basis}: rent + stock + the unknown line`);
    eq(b.expenses.lines.recorded.count, 3, `${basis}: one amount per counted line`);
    eq(b.expenses.total, 10200, basis);
    eq(b.profit, -10200, basis);
  });
});
test("a line on an account this chart doesn't know counts, as a whole expense would", () => {
  const input = {
    expenses: [itemized({ amount: 50700, items: [itemized().items[1], itemized().items[4]] })],
    accounts,
  };
  both((basis) => eq(books.computeBooks(input, { basis }).expenses.total, 700, basis));
});
test("a line with no account counts (by its category)", () => {
  const input = { expenses: [itemized({ amount: 300, items: [{ id: "l1", category: "fuel", amount: 300 }] })], accounts };
  both((basis) => eq(books.computeBooks(input, { basis }).expenses.total, 300, basis));
});
test("every line counts on the expense's own date", () => {
  const input = { expenses: [itemized()], accounts };
  eq(books.computeBooks(input, { basis: "paid", from: "2026-10-05", to: "2026-10-05" }).expenses.total, 10200, "that day");
  eq(books.computeBooks(input, { basis: "sold", from: "2026-10-06", to: "2026-10-31" }).expenses.total, 0, "after it");
  eq(books.computeBooks(input, { basis: "paid", from: "2026-10-01", to: "2026-10-04" }).expenses.total, 0, "before it");
});
test("an empty list of lines is a whole expense; the expense's own account decides", () => {
  const input = {
    expenses: [
      { id: "x2", amount: 900, date: "2026-10-05", category: "rent", accountId: "rent", items: [] },
      { id: "x3", amount: 5000, date: "2026-10-05", category: "other", accountId: "furniture", items: [] },
    ],
    accounts,
  };
  both((basis) => eq(books.computeBooks(input, { basis }).expenses.total, 900, basis));
});
test("lines decide, not the expense's own account (an itemized expense keeps none)", () => {
  // Were an account left on it, the lines still count by their own accounts.
  const input = { expenses: [itemized({ accountId: "furniture" })], accounts };
  both((basis) => eq(books.computeBooks(input, { basis }).expenses.total, 10200, basis));
});
test("an itemized expense in another currency counts nothing", () => {
  const input = { expenses: [itemized({ foreignCurrency: true })], accounts };
  both((basis) => eq(books.computeBooks(input, { basis }).expenses.total, 0, basis));
});
test("bookRows: a row per counted line with the line's account and category, adding up in both views", () => {
  const input = {
    sales: [{ id: "s1", amount: 5000, date: "2026-10-01" }],
    expenses: [itemized(), { id: "e9", amount: 900, date: "2026-10-05", category: "fuel" }],
    bankRows: [{ id: "t1", type: "expense", amount: 2000, fee: 10.75, date: "2026-10-06" }],
    accounts,
  };
  both((basis) => {
    const rows = books.bookRows(input, basis);
    const b = books.computeBooks(input, { basis });
    const exp = rows.filter((r) => r.type === "expense");
    eq(sumOf(exp), b.expenses.total, `${basis} expenses`);
    eq(sumOf(rows.filter((r) => r.type === "income")), b.sales.gross, `${basis} income`);
    const lines = exp.filter((r) => r.expenseId === "x1");
    assert.deepStrictEqual(
      lines.map((r) => [r.id, r.itemId, r.accountId, r.category, r.amount, r.date]),
      [
        ["x1:l1", "l1", "rent", "rent", 8000, "2026-10-05"],
        ["x1:l4", "l4", "cogs", "supplies", 1500, "2026-10-05"],
        ["x1:l5", "l5", "not-in-this-chart", "transport", 700, "2026-10-05"],
      ],
      basis,
    );
    eq(lines[0].notes, "Shop fit-out", `${basis}: the expense's own fields come with each line`);
    assert.ok(!exp.some((r) => r.id === "x1"), `${basis}: no row for the expense as a whole`);
    const whole = exp.find((r) => r.id === "e9");
    assert.ok(whole && whole.amount === 900 && whole.expenseId === undefined, `${basis}: a whole expense's row is as before`);
  });
});
test("a line with no category of its own takes the expense's", () => {
  const input = { expenses: [itemized({ items: [{ id: "l1", accountId: "rent", amount: 100 }] })], accounts };
  const [row] = books.bookRows(input, "paid");
  eq(row.category, "rent");
  eq(row.amount, 100);
});

console.log("\n── What the reports count: records, not lines");
// Pure pieces of the reports (they open no database connection when loaded).
const { entriesOf } = require("../src/utils/dailyReport");
const { spendingRecordOf } = require("../src/utils/insightsEngine");
const { twoDecimals } = require("../src/utils/money");
test("the 8pm push counts each record once: a split expense, a transfer with its fee, an expense on equipment", () => {
  const day = "2026-10-05";
  const opts = { from: day, to: day, basis: "paid" };
  const input = {
    // Three counted lines and two on the balance sheet: one record.
    expenses: [itemized(), { id: "e2", amount: 85000, date: day, category: "other", accountId: "furniture" }],
    bankRows: [{ id: "t1", type: "expense", amount: 2000, fee: 10.75, date: day }],
    // A credit sale with no debt: counted, and noted beside the sale.
    sales: [{ id: "s1", amount: 5000, date: day, isCredit: true }],
    accounts,
  };
  eq(entriesOf(input, opts), 4, "the split expense, the equipment, the transfer, the sale");
  eq(entriesOf({ expenses: [{ id: "e2", amount: 85000, date: day, accountId: "furniture" }], accounts }, opts), 1,
    "a day of equipment only is not 'no entries'");
});
test("Insights counts a transfer's fee with its transfer, and a split expense once", () => {
  const input = {
    expenses: [itemized()],
    bankRows: [{ id: "t1", type: "expense", amount: 10000, fee: 53.75, date: "2026-10-05" }],
    accounts,
  };
  const records = new Set(books.bookRows(input, "paid").filter((r) => r.type === "expense").map(spendingRecordOf));
  assert.deepStrictEqual([...records].sort(), ["t1", "x1"]);
  // A refund's fee is the only row its transfer has: still that one record.
  const refund = { bankRows: [{ id: "t2", type: "expense", amount: 900, fee: 10.75, purpose: "customer_refund", date: "2026-10-05" }] };
  assert.deepStrictEqual(books.bookRows(refund, "paid").map(spendingRecordOf), ["t2"]);
});
test("money in naira and kobo: every kobo amount is two decimals, a third decimal is not", () => {
  for (const n of [1234567.89, 2500.55, 19.99, 1.1, 0.29, 0.1 + 0.2, 99999999.99]) eq(twoDecimals(n), true, String(n));
  for (const n of [10.005, 0.001, 123.456, NaN, Infinity]) eq(twoDecimals(n), false, String(n));
  let refused = 0;
  for (let k = 1; k <= 200000; k++) if (!twoDecimals(Number((k / 100).toFixed(2)))) refused++;
  eq(refused, 0, "kobo amounts up to ₦2,000 refused");
});

// ── Release 2: bills and manual journals ─────────────────────────────────────
// The chart above, with a loan, a payroll liability and cash, as a business's
// chart would have them.
const chart2 = {
  ...accounts,
  loans: { cls: "liability", type: "long_term_liability" },
  paye: { cls: "liability", type: "other_current_liability" },
  cash: { cls: "asset", type: "cash" },
};
const pay = (id, amount, date, over = {}) => ({ id, amount, date, method: "cash", transactionId: null, outsideBooks: false, ...over });
const rentBill = (over = {}) => ({
  id: "b1", accountId: "rent", billDate: "2026-10-02", amount: 50000, estimated: false, vendorName: "Landlord",
  payments: [pay("p1", 20000, "2026-10-05"), pay("p2", 10000, "2026-11-03", { method: "transfer" })],
  ...over,
});
const month = (m) => ({ from: `2026-${m}-01`, to: `2026-${m}-31` });

console.log("\n── Bills");
test("a bill on spending: when paid each payment on its own date, when sold the whole bill on its bill date", () => {
  const input = { bills: [rentBill()], accounts: chart2 };
  const paid = (r) => books.computeBooks(input, { basis: "paid", ...r });
  const sold = (r) => books.computeBooks(input, { basis: "sold", ...r });
  eq(paid(month("10")).expenses.lines.bills.gross, 20000, "paid, October: the first payment");
  eq(paid(month("10")).expenses.lines.bills.count, 1, "paid, October: one payment");
  eq(paid(month("11")).expenses.total, 10000, "paid, November: the second");
  eq(paid({}).expenses.total, 30000, "paid, all time: what was paid, not the bill");
  eq(paid({}).profit, -30000, "paid profit");
  eq(sold(month("10")).expenses.lines.bills.gross, 50000, "sold, October: the whole bill");
  eq(sold(month("11")).expenses.total, 0, "sold, November: payments are not spending again");
  eq(sold({}).expenses.total, 50000, "sold, all time");
});
test("a bill for a loan or another liability never counts, in either view, nor its payments", () => {
  const input = {
    bills: [
      rentBill({ id: "b2", accountId: "loans", amount: 500000, payments: [pay("p3", 50000, "2026-10-09")] }),
      rentBill({ id: "b3", accountId: "paye", amount: 42000, payments: [pay("p4", 42000, "2026-10-09")] }),
    ],
    accounts: chart2,
  };
  both((basis) => {
    const b = books.computeBooks(input, { basis });
    eq(b.expenses.total, 0, basis);
    eq(b.expenses.lines.bills.count, 0, basis);
    eq(books.bookRows(input, basis).length, 0, `${basis}: no rows`);
  });
});
test("a bill with no account, or one this chart doesn't know, counts as spending (as a record with no account always has)", () => {
  const input = {
    bills: [
      rentBill({ id: "b4", accountId: null, amount: 700, payments: [pay("p5", 700, "2026-10-06")] }),
      rentBill({ id: "b5", accountId: "gone", amount: 300, payments: [pay("p6", 100, "2026-10-06")] }),
    ],
    accounts: chart2,
  };
  eq(books.computeBooks(input, { basis: "paid" }).expenses.total, 800, "paid: both payments");
  eq(books.computeBooks(input, { basis: "sold" }).expenses.total, 1000, "sold: both bills");
  eq(books.billIsSpending({ accountId: "loans" }, chart2), false, "a loan");
  eq(books.billIsSpending({ accountId: "cogs" }, chart2), true, "cost of goods sold");
  eq(books.billIsSpending({ accountId: "x" }, chart2), true, "an account this chart doesn't know");
  eq(books.billIsSpending({ accountId: "rent" }, undefined), true, "no chart at all");
});
test("a payable from before bills: what was paid outside the books counts nowhere; when sold only the open part, on the bill date", () => {
  const legacy = {
    id: "b6", accountId: "cogs", billDate: "2026-09-10", amount: 80000, estimated: true, vendorName: "Ada Supplies",
    payments: [
      pay("p7", 30000, "2026-09-20", { outsideBooks: true, estimated: true }),
      pay("p8", 15000, "2026-10-04"),
    ],
  };
  const input = { bills: [legacy], accounts: chart2 };
  eq(books.billBooksAmount(legacy), 50000, "what the books carry");
  eq(books.computeBooks(input, { basis: "paid", ...month("09") }).expenses.total, 0, "paid, September: the payment outside the books");
  eq(books.computeBooks(input, { basis: "paid", ...month("10") }).expenses.total, 15000, "paid, October: a real payment");
  eq(books.computeBooks(input, { basis: "sold", ...month("09") }).expenses.total, 50000, "sold, September: the open part");
  eq(books.computeBooks(input, { basis: "sold", ...month("10") }).expenses.total, 0, "sold, October: nothing more");
  // Paid in full outside the books: nothing left to count, no row.
  const settled = { ...legacy, payments: [pay("p9", 80000, "2026-09-20", { outsideBooks: true })] };
  both((basis) => {
    eq(books.computeBooks({ bills: [settled], accounts: chart2 }, { basis }).expenses.total, 0, basis);
    eq(books.bookRows({ bills: [settled], accounts: chart2 }, basis).length, 0, `${basis} rows`);
  });
});
test("a debit that paid a bill stops counting itself: the payment counts, the rest of the debit and its fee still do", () => {
  const debit = { id: "t1", type: "expense", amount: 12000, fee: 26.88, matchedBillId: "b7", matchedAmount: 10000, date: "2026-10-06" };
  const bill = rentBill({
    id: "b7", billDate: "2026-10-01", amount: 10000,
    payments: [pay("p10", 10000, "2026-10-06", { method: "bank", transactionId: "t1" })],
  });
  eq(books.isDebitMatched(debit), true, "matched");
  eq(books.isMatchedBankRow(debit), true, "a matched row");
  eq(books.bankCountedAmount(debit), 2000, "what is left of it");
  const input = { bankRows: [debit], bills: [bill], accounts: chart2 };
  both((basis) => {
    const b = books.computeBooks(input, { basis });
    eq(b.expenses.lines.bills.gross, 10000, `${basis}: the bill`);
    eq(b.expenses.lines.bank.gross, 2000, `${basis}: the rest of the debit`);
    eq(b.expenses.lines.bankCharges.gross, 26.88, `${basis}: its fee`);
    eq(b.expenses.total, 12026.88, `${basis}: the money that left, once`);
  });
  // An older match with no matchedAmount: the whole debit is the payment's.
  const whole = { ...debit, amount: 10000, matchedAmount: null };
  eq(books.computeBooks({ bankRows: [whole], bills: [bill], accounts: chart2 }, { basis: "paid" }).expenses.total, 10026.88);
  // Unlinked again (the payment deleted), the debit counts as before.
  const freed = { ...debit, matchedBillId: null, matchedAmount: null };
  eq(books.computeBooks({ bankRows: [freed], accounts: chart2 }, { basis: "paid" }).expenses.lines.bank.gross, 12000);
});
test("a bill payment's day is its Lagos day", () => {
  const input = { bills: [rentBill({ payments: [pay("p11", 900, new Date("2026-10-31T23:30:00Z"))] })], accounts: chart2 };
  eq(books.computeBooks(input, { basis: "paid", ...month("10") }).expenses.total, 0, "not October");
  eq(books.computeBooks(input, { basis: "paid", ...month("11") }).expenses.total, 900, "the 1st of November in Lagos");
  const late = { bills: [rentBill({ billDate: new Date("2026-10-31T23:30:00Z"), payments: [] })], accounts: chart2 };
  eq(books.computeBooks(late, { basis: "sold", ...month("11") }).expenses.total, 50000, "a bill dated that late is November's");
});
test("bookRows: a row per payment (when paid) and per bill (when sold) with its account, adding up to the totals", () => {
  const input = {
    bills: [
      rentBill(),
      rentBill({ id: "b8", accountId: "loans", amount: 9000, payments: [pay("p12", 9000, "2026-10-07")] }),
      rentBill({ id: "b9", accountId: null, vendorName: "", billNumber: "INV-77", amount: 400, payments: [pay("p13", 400, "2026-10-08")] }),
      { id: "b10", accountId: "cogs", billDate: "2026-09-10", amount: 1000, estimated: true, name: "Old payable",
        payments: [pay("p14", 600, "2026-09-11", { outsideBooks: true })] },
    ],
    bankRows: [{ id: "t9", type: "expense", amount: 500, date: "2026-10-09" }],
    sales: [{ id: "s1", amount: 7000, date: "2026-10-09" }],
    accounts: chart2,
  };
  both((basis) => {
    const rows = books.bookRows(input, basis);
    const b = books.computeBooks(input, { basis });
    eq(sumOf(rows.filter((r) => r.type === "expense")), b.expenses.total, `${basis} expenses`);
    eq(sumOf(rows.filter((r) => r.type === "income")), b.sales.gross, `${basis} income`);
    eq(new Set(rows.map((r) => r.id)).size, rows.length, `${basis}: ids are unique`);
  });
  const paidRows = books.bookRows(input, "paid").filter((r) => r.source === "bill_payment");
  assert.deepStrictEqual(
    paidRows.map((r) => [r.id, r.amount, r.date, r.accountId, r.billId, r.paymentId, r.paymentMethod, r.description]),
    [
      ["bp_p1", 20000, "2026-10-05", "rent", "b1", "p1", "cash", "Landlord"],
      ["bp_p2", 10000, "2026-11-03", "rent", "b1", "p2", "transfer", "Landlord"],
      ["bp_p13", 400, "2026-10-08", null, "b9", "p13", "cash", "INV-77"],
    ],
  );
  const soldRows = books.bookRows(input, "sold").filter((r) => r.source === "bill");
  assert.deepStrictEqual(
    soldRows.map((r) => [r.id, r.amount, r.date, r.accountId, r.billId, r.description]),
    [
      ["bill_b1", 50000, "2026-10-02", "rent", "b1", "Landlord"],
      ["bill_b9", 400, "2026-10-02", null, "b9", "INV-77"],
      ["bill_b10", 400, "2026-09-10", "cogs", "b10", "Old payable"],
    ],
  );
});
test("the VAT estimate takes in bills on spending on their bill date (the part the books carry), never a loan", () => {
  const input = {
    bills: [
      rentBill({ id: "v1", billDate: "2026-10-02", amount: 10750, payments: [] }),
      { id: "v2", accountId: "cogs", billDate: "2026-10-03", amount: 32250, estimated: true,
        payments: [pay("vp1", 21500, "2026-10-03", { outsideBooks: true })] },
      rentBill({ id: "v3", accountId: "loans", billDate: "2026-10-04", amount: 107500, payments: [] }),
      rentBill({ id: "v4", accountId: null, billDate: "2026-10-05", amount: 1075, payments: [] }),
      rentBill({ id: "v5", billDate: "2026-09-30", amount: 10750, payments: [pay("vp2", 10750, "2026-10-06")] }),
      rentBill({ id: "v6", billDate: new Date("2026-10-31T23:30:00Z"), amount: 2150, payments: [] }),
    ],
    expenses: [{ id: "e1", amount: 2150, date: "2026-10-07", accountId: "rent" }],
    accounts: chart2,
  };
  const r = books.vatReturn(input, "2026-10", VAT);
  // 750 + 750 (the open part of v2) + 75 (no account) + 150 (the expense); v3
  // is a loan, v5 is September's (its October payment is not a purchase), v6
  // is November's in Lagos.
  eq(r.inputEstimate, 1725);
  eq(r.payable, -1725);
  eq(books.vatReturn({ bills: input.bills, accounts: chart2 }, "2026-09", VAT).inputEstimate, 750, "September: v5");
  eq(books.vatReturn(input, "2026-10", { enabled: false }).inputEstimate, 0, "no VAT, no estimate");
});

console.log("\n── Manual journals");
const journal = (id, date, lines, over = {}) => ({
  id, number: `MJ-${id}`, date, status: "published", note: `note ${id}`,
  lines: lines.map(([accountId, debit, credit], i) => ({ id: `${id}l${i}`, accountId, debit, credit })),
  ...over,
});
const journals = [
  // Rent paid ahead, now used: into spending, out of the prepayment.
  journal("j1", "2026-10-10", [["rent", 30000, 0], ["prepaid", 0, 30000]]),
  // Interest the owner put in as capital: other income.
  journal("j2", "2026-10-12", [["equity", 5000, 0], ["interest", 0, 5000]]),
  // A correction: sales and their cost both down, the difference from cash.
  journal("j3", "2026-10-15", [["sales", 2000, 0], ["cogs", 0, 500], ["cash", 0, 1500]]),
  // Balance sheet only: cash banked.
  journal("j4", "2026-10-16", [["furniture", 9000, 0], ["cash", 0, 9000]]),
];
test("published journal lines on income count as sales, on spending as expenses, in both views; the balance sheet nowhere", () => {
  both((basis) => {
    const b = books.computeBooks({ journals, accounts: chart2 }, { basis });
    eq(b.sales.lines.journals.gross, 3000, `${basis}: 5,000 of interest less 2,000 of sales`);
    eq(b.sales.lines.journals.count, 2, `${basis}: two income lines`);
    eq(b.expenses.lines.journals.gross, 29500, `${basis}: 30,000 of rent less 500 of cost`);
    eq(b.sales.total, 3000, basis);
    eq(b.expenses.total, 29500, basis);
    eq(b.profit, -26500, basis);
  });
});
test("a journal carries no VAT: with VAT on, all of it is sales", () => {
  both((basis) => {
    const b = books.computeBooks({ journals, accounts: chart2 }, { basis, vat: VAT });
    eq(b.sales.lines.journals.vat, 0, basis);
    eq(b.sales.total, 3000, basis);
  });
});
test("a draft, an unbalanced journal, or one naming an account the chart doesn't know counts nowhere", () => {
  const bad = [
    journal("d1", "2026-10-10", [["rent", 100, 0], ["cash", 0, 100]], { status: "draft" }),
    journal("d2", "2026-10-10", [["rent", 100, 0], ["cash", 0, 99.99]]),
    journal("d3", "2026-10-10", [["rent", 100, 0], ["gone", 0, 100]]),
    journal("d4", "2026-10-10", []),
  ];
  for (const j of bad) eq(books.journalInBooks(j, chart2), false, j.id);
  both((basis) => {
    eq(books.computeBooks({ journals: bad, accounts: chart2 }, { basis }).expenses.total, 0, basis);
    eq(books.bookRows({ journals: bad, accounts: chart2 }, basis).length, 0, `${basis} rows`);
  });
  // Without the chart nothing can be told apart, so nothing counts.
  eq(books.computeBooks({ journals }, { basis: "paid" }).expenses.total, 0, "no chart");
});
test("debits equal credits to the kobo, not to the float", () => {
  const j = journal("k1", "2026-10-10", [["rent", 0.1, 0], ["rent", 0.2, 0], ["cash", 0, 0.3]]);
  eq(books.journalInBooks(j, chart2), true, "0.1 + 0.2 = 0.3 in kobo");
  eq(books.computeBooks({ journals: [j], accounts: chart2 }, { basis: "paid" }).expenses.total, 0.3);
});
test("a journal counts on its own (Lagos) day", () => {
  const late = [journal("n1", new Date("2026-10-31T23:30:00Z"), [["rent", 700, 0], ["cash", 0, 700]])];
  eq(books.computeBooks({ journals: late, accounts: chart2 }, { basis: "sold", ...month("10") }).expenses.total, 0, "not October");
  eq(books.computeBooks({ journals: late, accounts: chart2 }, { basis: "paid", ...month("11") }).expenses.total, 700, "November");
  eq(books.computeBooks({ journals, accounts: chart2 }, { basis: "paid", from: "2026-10-11", to: "2026-10-31" }).expenses.total, -500, "after j1");
});
test("bookRows: a row per counted journal line with its account and journal, adding up; none for the balance sheet", () => {
  const input = { journals, bankRows: [{ id: "t1", type: "expense", amount: 300, date: "2026-10-10" }], accounts: chart2 };
  both((basis) => {
    const rows = books.bookRows(input, basis);
    const b = books.computeBooks(input, { basis });
    eq(sumOf(rows.filter((r) => r.type === "expense")), b.expenses.total, `${basis} expenses`);
    eq(sumOf(rows.filter((r) => r.type === "income")), b.sales.gross, `${basis} income`);
    assert.deepStrictEqual(
      rows.filter((r) => r.source === "journal").map((r) => [r.id, r.type, r.amount, r.accountId, r.journalId, r.date]),
      [
        ["mj_j1l0", "expense", 30000, "rent", "j1", "2026-10-10"],
        ["mj_j2l1", "income", 5000, "interest", "j2", "2026-10-12"],
        ["mj_j3l0", "income", -2000, "sales", "j3", "2026-10-15"],
        ["mj_j3l1", "expense", -500, "cogs", "j3", "2026-10-15"],
      ],
      basis,
    );
  });
});

console.log("\n── Bills and journals beside everything else");
test("every view's rows still add up with bills, journals, fees, itemized expenses and links together", () => {
  const input = {
    sales: [{ id: "s1", amount: 5000, date: "2026-10-01" }],
    expenses: [itemized()],
    bankRows: [
      { id: "t1", type: "expense", amount: 10000, fee: 53.75, matchedBillId: "b1", matchedAmount: 8000, date: "2026-10-05" },
      { id: "t2", type: "income", amount: 3000, date: "2026-10-06" },
    ],
    bills: [rentBill({ payments: [pay("p1", 8000, "2026-10-05", { method: "bank", transactionId: "t1" })] })],
    journals,
    accounts: chart2,
  };
  both((basis) => {
    const rows = books.bookRows(input, basis);
    const b = books.computeBooks(input, { basis });
    eq(sumOf(rows.filter((r) => r.type === "expense")), b.expenses.total, `${basis} expenses`);
    eq(sumOf(rows.filter((r) => r.type === "income")), b.sales.gross, `${basis} income`);
    eq(new Set(rows.map((r) => r.id)).size, rows.length, `${basis}: ids are unique`);
  });
  // The debit: 8,000 is the bill's payment (paid view) or inside the bill
  // (sold view), 2,000 still counts as a debit, the fee as a bank charge.
  eq(books.computeBooks(input, { basis: "paid" }).expenses.total, 10200 + 8000 + 2000 + 53.75 + 29500);
  eq(books.computeBooks(input, { basis: "sold" }).expenses.total, 10200 + 50000 + 2000 + 53.75 + 29500);
});

// ── Release 3: stock cost ────────────────────────────────────────────────────
// The chart above with Inventory Asset, as the loaders pass it.
const chart3 = { ...chart2, stock: { cls: "asset", type: "stock" }, services: { cls: "income", type: "income" } };
const goods = (id, amount, costAmount, over = {}) => ({ id, itemType: "goods", quantity: 1, amount, accountId: "sales", costAmount, ...over });
const service = (id, amount, over = {}) => ({ id, itemType: "service", quantity: 1, amount, accountId: "services", costAmount: 0, ...over });
const cogsOf = (input, opts) => books.computeBooks(input, opts).expenses.lines.cogs;
const rowsOf = (input, basis, source) => books.bookRows(input, basis).filter((r) => r.source === source)
  .map((r) => [r.id, r.amount, r.date]);

console.log("\n── Stock cost: sales");
test("a cash sale with goods: their cost on the sale date in both views, services and typed lines cost nothing", () => {
  const input = {
    sales: [{
      id: "s1", amount: 15000, date: "2026-10-01", paymentMethod: "cash",
      items: [goods("l1", 6000, 4000), goods("l2", 4000, 2500.5), service("l3", 4000), { id: "l4", itemType: "other", amount: 1000, costAmount: 0 }],
    }],
    accounts: chart3,
  };
  both((basis) => {
    const b = books.computeBooks(input, { basis });
    eq(b.sales.total, 15000, `${basis}: the sale, as one amount`);
    eq(b.expenses.lines.cogs.gross, 6500.5, `${basis}: the goods' cost`);
    eq(b.expenses.lines.cogs.count, 1, `${basis}: one amount for the sale`);
    eq(b.expenses.total, 6500.5, basis);
    eq(b.profit, 8499.5, basis);
    assert.deepStrictEqual(rowsOf(input, basis, "cogs"), [["cogs_sale_s1", 6500.5, "2026-10-01"]], basis);
  });
  // Another month counts none of it.
  both((basis) => eq(cogsOf(input, { basis, ...month("11") }).gross, 0, basis));
});
test("a sale of services only, or of goods whose cost is not known, has no cost", () => {
  const input = {
    sales: [
      { id: "s1", amount: 5000, date: "2026-10-01", items: [service("l1", 3000), service("l2", 2000)] },
      { id: "s2", amount: 800, date: "2026-10-01", items: [goods("l3", 800, 0, { unitCost: null })] },
      { id: "s3", amount: 700, date: "2026-10-01" },
    ],
    accounts: chart3,
  };
  both((basis) => {
    const b = books.computeBooks(input, { basis });
    eq(b.expenses.lines.cogs.count, 0, basis);
    eq(b.expenses.total, 0, basis);
    eq(b.sales.total, 6500, basis);
    eq(books.bookRows(input, basis).filter((r) => r.type === "expense").length, 0, `${basis}: no cost rows`);
  });
});
test("a credit sale paid in two parts: when sold its cost on the sale date; when paid with each payment, exactly", () => {
  const input = {
    sales: [{ id: "s1", amount: 12000, date: "2026-10-01", isCredit: true, customerId: "c1", items: [goods("l1", 12000, 7000.01)] }],
    debts: [{
      id: "d1", amount: 12000, paidAmount: 12000, paid: true, date: "2026-10-01", saleId: "s1", customerId: "c1", note: "",
      payments: [{ id: "p2", amount: 7000, date: "2026-11-02" }, { id: "p1", amount: 5000, date: "2026-10-05" }],
    }],
    accounts: chart3,
  };
  eq(cogsOf(input, { basis: "sold", ...month("10") }).gross, 7000.01, "sold, October: all of it");
  eq(cogsOf(input, { basis: "sold", ...month("11") }).gross, 0, "sold, November: nothing");
  // 7,000.01 × 5,000 / 12,000 = 2,916.6708 → 2,916.67; the rest with the last naira.
  eq(cogsOf(input, { basis: "paid", ...month("10") }).gross, 2916.67, "paid, October: the first payment's share");
  eq(cogsOf(input, { basis: "paid", ...month("11") }).gross, 4083.34, "paid, November: the rest, to the kobo");
  eq(cogsOf(input, { basis: "paid" }).gross, 7000.01, "paid, all time: exactly its cost");
  assert.deepStrictEqual(rowsOf(input, "paid", "cogs"), [["cogs_dp_p2", 4083.34, "2026-11-02"], ["cogs_dp_p1", 2916.67, "2026-10-05"]]);
  const row = books.bookRows(input, "paid").find((r) => r.id === "cogs_dp_p1");
  assert.deepStrictEqual([row.saleId, row.debtId, row.paymentId, row.customerId, row.category], ["s1", "d1", "p1", "c1", "supplies"]);
  // Not paid yet: nothing when paid, all of it when sold.
  const unpaid = { ...input, debts: [{ ...input.debts[0], paidAmount: 0, paid: false, payments: [] }] };
  eq(cogsOf(unpaid, { basis: "paid" }).gross, 0, "paid: an unpaid sale shows no cost (and no loss)");
  eq(books.computeBooks(unpaid, { basis: "paid" }).profit, 0, "paid profit");
  eq(cogsOf(unpaid, { basis: "sold" }).gross, 7000.01, "sold");
});
test("a credit sale no debt tracks counts its cost on its date, like its money", () => {
  const input = { sales: [{ id: "s1", amount: 3000, date: "2026-10-01", isCredit: true, items: [goods("l1", 3000, 1800)] }], accounts: chart3 };
  both((basis) => eq(cogsOf(input, { basis, ...month("10") }).gross, 1800, basis));
});
test("a repayment in the period releases the cost of a credit sale from before it (the debt carries the sale)", () => {
  // As booksData loads October alone: the September sale is not among the
  // sales, so its debt carries it.
  const sale = { id: "s9", amount: 10000, date: "2026-09-20", isCredit: true, items: [{ id: "x", costAmount: 6000 }] };
  const input = {
    sales: [],
    debts: [{ id: "d1", amount: 10000, saleId: "s9", sale, customerId: "c1", payments: [{ id: "p1", amount: 2500, date: "2026-10-04" }] }],
    accounts: chart3,
  };
  const b = books.computeBooks(input, { basis: "paid", ...month("10") });
  eq(b.sales.total, 2500, "the repayment");
  eq(b.expenses.lines.cogs.gross, 1500, "a quarter of the sale's cost");
  eq(books.computeBooks(input, { basis: "sold", ...month("10") }).expenses.total, 0, "sold: the sale was September's");
  // The whole books (the sale among the sales) count the same in October.
  const whole = { ...input, sales: [sale], debts: [{ ...input.debts[0], sale: undefined }] };
  eq(books.computeBooks(whole, { basis: "paid", ...month("10") }).expenses.lines.cogs.gross, 1500, "the same with the sale loaded");
});
test("a sale in another currency counts no money, but its goods' cost on its date in both views", () => {
  const input = { sales: [{ id: "s1", amount: 100, currency: "EUR", foreignCurrency: true, date: "2026-10-01", items: [goods("l1", 100, 45000)] }], accounts: chart3 };
  both((basis) => {
    const b = books.computeBooks(input, { basis });
    eq(b.sales.total, 0, basis);
    eq(b.expenses.lines.cogs.gross, 45000, basis);
  });
});

console.log("\n── Stock cost: invoices and credit notes");
const inv = (over = {}) => ({
  id: "i1", type: "invoice", status: "partial", issueDate: "2026-10-01", invoiceNumber: "INV-1", customerId: "c1",
  total: 10750, taxAmount: 750, amountPaid: 4300, subtotal: 10000, discountAmount: 0,
  items: [{ id: "a", amount: 6000, itemType: "goods", costAmount: 3600 }, { id: "b", amount: 4000, itemType: "goods", costAmount: 2400 }],
  payments: [{ id: "ip1", amount: 4300, method: "cash", date: "2026-10-10" }],
  ...over,
});
test("an invoice paid in part: when sold its goods' cost on the issue date; when paid the share the money brings", () => {
  const input = { invoices: [inv()], accounts: chart3 };
  eq(cogsOf(input, { basis: "sold" }).gross, 6000, "sold: all of it");
  // 6,000 × 4,300 / 10,750 = 2,400.
  eq(cogsOf(input, { basis: "paid" }).gross, 2400, "paid: the share of the money in");
  assert.deepStrictEqual(rowsOf(input, "sold", "cogs"), [["cogs_doc_i1", 6000, "2026-10-01"]]);
  assert.deepStrictEqual(rowsOf(input, "paid", "cogs"), [["cogs_ip_ip1", 2400, "2026-10-10"]]);
  // Credit from a credit note applied releases its share as money would (it
  // is no money: no sales); an unlinked bank payment releases nothing until
  // it is linked. 6,000 × 7,300 / 10,750 = 4,074.4186 → 4,074.42, less the
  // 2,400 before it.
  const settled = { invoices: [inv({ payments: [...inv().payments, { id: "ip2", amount: 3000, method: "credit_note", date: "2026-10-11" }, { id: "ip3", amount: 3450, method: "bank", date: "2026-10-12" }] })], accounts: chart3 };
  eq(cogsOf(settled, { basis: "paid" }).gross, 4074.42, "paid: the money and the credit applied");
  eq(books.computeBooks(settled, { basis: "paid" }).sales.total, 4300, "paid: sales only from the money");
  assert.deepStrictEqual(rowsOf(settled, "paid", "cogs"), [["cogs_ip_ip1", 2400, "2026-10-10"], ["cogs_ip_ip2", 1674.42, "2026-10-11"]]);
});
test("paid in full in three parts, the cost comes out exactly; overpaid, never more than the cost", () => {
  const thirds = [1, 2, 3].map((n) => ({ id: `t${n}`, amount: 3583.33 + (n === 3 ? 0.01 : 0), method: "transfer", date: `2026-10-0${n + 1}` }));
  const input = { invoices: [inv({ payments: thirds, amountPaid: 10750 })], accounts: chart3 };
  const rows = rowsOf(input, "paid", "cogs");
  eq(Math.round(rows.reduce((s, r) => s + r[1] * 100, 0)), 600000, "the three shares add up to the cost");
  for (const r of rows) assert.ok(Math.abs(r[1] - 2000) <= 0.01, `${r[0]} ${r[1]} is a third, within a kobo`);
  const over = { invoices: [inv({ payments: [{ id: "o1", amount: 10750, method: "cash", date: "2026-10-02" }, { id: "o2", amount: 500, method: "cash", date: "2026-10-03" }] })], accounts: chart3 };
  eq(cogsOf(over, { basis: "paid" }).gross, 6000, "overpaid: the cost, once");
});
test("a draft, void or quote with costs on its lines moves no stock and costs nothing", () => {
  for (const status of ["draft", "void"]) {
    both((basis) => eq(cogsOf({ invoices: [inv({ status })], accounts: chart3 }, { basis }).gross, 0, `${status} ${basis}`));
  }
  both((basis) => eq(cogsOf({ invoices: [inv({ type: "quote", status: "sent" })], accounts: chart3 }, { basis }).gross, 0, `quote ${basis}`));
  eq(books.documentCostKobo(inv({ status: "draft" })), 0, "documentCostKobo");
  eq(books.documentCostKobo(inv({ status: "paid" })), 600000, "documentCostKobo, issued");
});
test("a credit note that puts goods back, refunded: a negative cost when issued (sold) or as the refund goes out (paid)", () => {
  const sold = inv({ status: "paid", amountPaid: 10750, payments: [{ id: "ip1", amount: 10750, method: "cash", date: "2026-10-03" }] });
  const cn = {
    id: "cn1", type: "credit_note", status: "paid", issueDate: "2026-10-10", invoiceNumber: "CN-1", customerId: "c1",
    total: 5375, taxAmount: 375, amountPaid: 5375, subtotal: 5000, discountAmount: 0,
    items: [
      { id: "r1", amount: 3000, itemType: "goods", restock: true, costAmount: 1800 },
      { id: "r2", amount: 2000, itemType: "goods", restock: false, costAmount: 1200 }, // kept by the customer (damaged): no goods back
    ],
    payments: [{ id: "rf1", amount: 2687.5, method: "refund_cash", date: "2026-10-12" }, { id: "rf2", amount: 2687.5, method: "refund_transfer", date: "2026-11-01" }],
  };
  const input = { invoices: [sold, cn], accounts: chart3 };
  eq(books.documentCostKobo(cn), -180000, "only the restocked line comes back");
  const s = (r) => cogsOf(input, { basis: "sold", ...r }).gross;
  eq(s(month("10")), 6000 - 1800, "sold, October: the invoice less the goods back");
  const p = (r) => cogsOf(input, { basis: "paid", ...r }).gross;
  eq(p(month("10")), 6000 - 900, "paid, October: the invoice, less half the goods back with the first refund");
  eq(p(month("11")), -900, "paid, November: the rest with the second refund");
  assert.deepStrictEqual(rowsOf(input, "paid", "cogs"), [["cogs_ip_ip1", 6000, "2026-10-03"], ["cogs_ip_rf1", -900, "2026-10-12"], ["cogs_ip_rf2", -900, "2026-11-01"]]);
  // Applied to another invoice instead of refunded: the goods back count with
  // the credit, on the day it was applied.
  const applied = { invoices: [sold, { ...cn, payments: [{ id: "ca1", amount: 5375, method: "credit_applied", date: "2026-10-12" }] }], accounts: chart3 };
  eq(cogsOf(applied, { basis: "paid" }).gross, 4200, "paid: the goods back with the credit applied");
  assert.deepStrictEqual(rowsOf(applied, "paid", "cogs"), [["cogs_ip_ip1", 6000, "2026-10-03"], ["cogs_ip_ca1", -1800, "2026-10-12"]]);
  eq(cogsOf(applied, { basis: "sold" }).gross, 4200, "sold: the goods back on the credit note's date");
});
test("credit from a credit note applied to an invoice releases both documents' costs as money would; settled in full, both views agree", () => {
  const invoice = inv({
    id: "i2", invoiceNumber: "INV-2", status: "paid", total: 10000, taxAmount: 0, amountPaid: 10000, subtotal: 10000,
    items: [{ id: "a", amount: 10000, itemType: "goods", costAmount: 6000.01 }],
    payments: [
      { id: "c1", amount: 5000, method: "cash", date: "2026-10-15" },
      { id: "c2", amount: 5000, method: "credit_note", date: "2026-10-16" },
    ],
  });
  const note = {
    id: "cn2", type: "credit_note", status: "paid", issueDate: "2026-10-14", invoiceNumber: "CN-2", customerId: "c1",
    total: 5000, taxAmount: 0, amountPaid: 5000, subtotal: 5000, discountAmount: 0,
    items: [{ id: "r1", amount: 5000, itemType: "goods", restock: true, costAmount: 3000 }],
    payments: [{ id: "a1", amount: 5000, method: "credit_applied", date: "2026-10-16" }],
  };
  const input = { invoices: [invoice, note], accounts: chart3 };
  // Half of 6,000.01 (3,000.005 → 3,000.01) with the cash, the rest with the
  // credit; the goods back all with the credit applied.
  assert.deepStrictEqual(rowsOf(input, "paid", "cogs"), [["cogs_ip_c1", 3000.01, "2026-10-15"], ["cogs_ip_c2", 3000, "2026-10-16"], ["cogs_ip_a1", -3000, "2026-10-16"]]);
  const paid = books.computeBooks(input, { basis: "paid" });
  eq(paid.expenses.lines.cogs.gross, 3000.01, "paid: 6,000.01 out, 3,000 back");
  eq(paid.sales.total, 5000, "paid: only the cash is sales");
  eq(cogsOf(input, { basis: "sold" }).gross, 3000.01, "sold: the same cost, once everything is settled");
  eq(cogsOf(input, { basis: "paid", from: "2026-10-15", to: "2026-10-15" }).gross, 3000.01, "paid: the cash's day");
  eq(cogsOf(input, { basis: "paid", from: "2026-10-16", to: "2026-10-16" }).gross, 0, "paid: the credit's day, out and back");
});
test("an invoice written off: when paid all its goods' cost still waiting is cost of goods sold on the write-off date (never bad debt)", () => {
  const written = inv({ writtenOffAt: "2026-10-20", writtenOffAmount: 6450 });
  const input = { invoices: [written], accounts: chart3 };
  // 2,400 with the money on the 10th, the other 3,600 on the 20th.
  assert.deepStrictEqual(rowsOf(input, "paid", "cogs"), [["cogs_ip_ip1", 2400, "2026-10-10"], ["cogs_wo_i1", 3600, "2026-10-20"]]);
  const paid = books.computeBooks(input, { basis: "paid", ...month("10") });
  eq(paid.expenses.lines.cogs.gross, 6000, "paid: all of it in October");
  eq(paid.expenses.lines.badDebts.gross, 0, "paid: no bad debt");
  eq(paid.expenses.total, 6000, "paid");
  const row = books.bookRows(input, "paid").find((r) => r.id === "cogs_wo_i1");
  assert.deepStrictEqual([row.invoiceId, row.customerId, row.description, row.source, row.category], ["i1", "c1", "INV-1", "cogs", "supplies"]);
  // "When sold" as before: the cost on the issue date, the unpaid balance as bad debt.
  const sold = books.computeBooks(input, { basis: "sold", ...month("10") });
  eq(sold.expenses.lines.cogs.gross, 6000, "sold: on the issue date");
  eq(sold.expenses.lines.badDebts.gross, 6450, "sold: bad debt");
  eq(sold.expenses.total, 12450, "sold");
  // Written off before any money: all of it then, and a later payment releases nothing more.
  const early = { invoices: [inv({ writtenOffAt: "2026-10-05", writtenOffAmount: 10750 })], accounts: chart3 };
  assert.deepStrictEqual(rowsOf(early, "paid", "cogs"), [["cogs_wo_i1", 6000, "2026-10-05"]]);
  // Paid and written off the same day: the payment's share first, whatever the order.
  const sameDay = { invoices: [inv({ writtenOffAt: "2026-10-10", writtenOffAmount: 6450 })], accounts: chart3 };
  assert.deepStrictEqual(rowsOf(sameDay, "paid", "cogs"), [["cogs_ip_ip1", 2400, "2026-10-10"], ["cogs_wo_i1", 3600, "2026-10-10"]]);
  // Outside an exact span the write-off counts nowhere (the loader marks it).
  eq(cogsOf({ invoices: [inv({ writtenOffAt: "2026-10-20", writtenOffOutsideSpan: true })], accounts: chart3 }, { basis: "paid" }).gross, 2400, "outside the span");
  // A credit note is never written off: its waiting cost stays with its refunds.
  eq(books.stockCosts({ invoices: [{ ...written, type: "credit_note", items: [{ id: "r", amount: 1, restock: true, costAmount: 5 }] }] }).values().next().value.releases.size, 1, "only its payment releases");
});
test("a document with nothing to collect counts its goods' cost on its date in both views", () => {
  const free = inv({ total: 0, taxAmount: 0, amountPaid: 0, subtotal: 0, items: [{ id: "a", amount: 0, itemType: "goods", costAmount: 950 }], payments: [] });
  both((basis) => eq(cogsOf({ invoices: [free], accounts: chart3 }, { basis }).gross, 950, basis));
});
test("a document issued outside an exact span counts nothing on its issue date (the loader marks it)", () => {
  // As booksForInstants loads today's span: an invoice of 2 units at nothing
  // (cost 80) and a restocked credit note at nothing (-40), both issued on
  // the 9th, are read with no period at all.
  const free = inv({ id: "z1", issueDate: "2026-10-09", total: 0, taxAmount: 0, amountPaid: 0, subtotal: 0, items: [{ id: "a", amount: 0, itemType: "goods", costAmount: 80 }], payments: [] });
  const back = {
    id: "z2", type: "credit_note", status: "sent", issueDate: "2026-10-09", invoiceNumber: "CN-9", customerId: "c1",
    total: 0, taxAmount: 0, amountPaid: 0, subtotal: 0, discountAmount: 0,
    items: [{ id: "r", amount: 0, itemType: "goods", restock: true, costAmount: 40 }], payments: [],
  };
  const inside = { invoices: [free, back], accounts: chart3 };
  both((basis) => eq(cogsOf(inside, { basis }).gross, 40, `${basis}: issued in the span`));
  const outside = { invoices: [{ ...free, issuedOutsideSpan: true }, { ...back, issuedOutsideSpan: true }], accounts: chart3 };
  both((basis) => {
    eq(cogsOf(outside, { basis }).gross, 0, `${basis}: issued outside it`);
    eq(books.bookRows(outside, basis).length, 0, `${basis}: no rows`);
  });
  // "When sold", the document's own amount waits for its issue date too.
  const sent = { invoices: [inv({ status: "sent", issuedOutsideSpan: true })], accounts: chart3 };
  const s = books.computeBooks(sent, { basis: "sold" });
  eq(s.sales.total, 0, "sold: not invoiced in the span");
  eq(s.expenses.lines.cogs.gross, 0, "sold: nor its cost");
  // Its payments in the span still count, and release their share.
  eq(cogsOf(sent, { basis: "paid" }).gross, 2400, "paid: the payment's share");
});

console.log("\n── Stock adjustments, new values, restocks");
const moves = [
  { id: "m1", kind: "adjustment", reason: "damaged", date: "2026-10-02", value: -2000, itemId: "g1" },
  { id: "m2", kind: "adjustment", reason: "counted", date: "2026-10-03", value: 500, itemId: "g1" },
  { id: "m3", kind: "revalue", date: "2026-10-04", value: -1000, itemId: "g2" },
  { id: "m4", kind: "revalue", date: "2026-11-04", value: 300.25, itemId: "g2" },
  { id: "m5", kind: "opening", date: "2026-10-01", value: 50000, itemId: "g1" },
  { id: "m6", kind: "opening_value", date: "2026-10-01", value: 7000, itemId: "g3" },
  { id: "m7", kind: "adjustment", reason: "lost", date: "2026-10-05", value: 0, itemId: "g4" },
];
test("stock lost or valued lower is spending, found or valued higher lowers it; starting stock counts nowhere", () => {
  both((basis) => {
    const b = books.computeBooks({ stockMoves: moves, accounts: chart3 }, { basis, ...month("10") });
    eq(b.expenses.lines.stockAdjustments.gross, 2000 - 500 + 1000, basis);
    eq(b.expenses.lines.stockAdjustments.count, 3, `${basis}: an amount per movement with a value`);
    eq(b.expenses.total, 2500, basis);
    eq(books.computeBooks({ stockMoves: moves, accounts: chart3 }, { basis, ...month("11") }).expenses.total, -300.25, `${basis} November`);
  });
  const rows = books.bookRows({ stockMoves: moves, accounts: chart3 }, "paid");
  assert.deepStrictEqual(
    rows.map((r) => [r.id, r.amount, r.date, r.source, r.category, r.moveKind, r.reason, r.itemId]),
    [
      ["sadj_m1", 2000, "2026-10-02", "stock_adjustment", "stock_adjustments", "adjustment", "damaged", "g1"],
      ["sadj_m2", -500, "2026-10-03", "stock_adjustment", "stock_adjustments", "adjustment", "counted", "g1"],
      ["sadj_m3", 1000, "2026-10-04", "stock_adjustment", "stock_adjustments", "revalue", null, "g2"],
      ["sadj_m4", -300.25, "2026-11-04", "stock_adjustment", "stock_adjustments", "revalue", null, "g2"],
    ],
  );
});
const restock = (over = {}) => ({
  id: "rb1", accountId: "stock", billDate: "2026-10-02", amount: 21500, estimated: false, vendorName: "Ada Wholesale",
  items: [{ id: "bi1", itemId: "g1", quantity: 10, unitCost: 1500, amount: 15000 }, { id: "bi2", itemId: "g2", quantity: 2.5, unitCost: 2600, amount: 6500 }],
  payments: [pay("rp1", 21500, "2026-10-02")],
  ...over,
});
test("a restock (a bill on Inventory Asset) is never spending, paid now or later; its VAT is in the estimate", () => {
  const input = { bills: [restock(), restock({ id: "rb2", payments: [pay("rp2", 1000, "2026-10-20")] })], accounts: chart3 };
  eq(books.billIsSpending(input.bills[0], chart3), false, "not spending");
  both((basis) => {
    eq(books.computeBooks(input, { basis }).expenses.total, 0, basis);
    eq(books.bookRows(input, basis).length, 0, `${basis}: no rows`);
  });
  // Two restocks of 21,500 in October: 7.5/107.5 of each.
  eq(books.vatReturn(input, "2026-10", VAT).inputEstimate, 3000, "VAT inside 43,000");
});

console.log("\n── Stock cost: the period, the span, and the rows");
test("a payment outside the span counts nowhere, but still decides the share a later one releases", () => {
  const payments = [{ id: "p1", amount: 5000, date: "2026-10-05", outsideSpan: true }, { id: "p2", amount: 7000, date: "2026-11-02" }];
  const input = {
    sales: [{ id: "s1", amount: 12000, date: "2026-10-01", isCredit: true, items: [goods("l1", 12000, 7000.01)] }],
    debts: [{ id: "d1", amount: 12000, saleId: "s1", customerId: "c1", payments }],
    accounts: chart3,
  };
  const b = books.computeBooks(input, { basis: "paid" });
  eq(b.sales.total, 7000, "only the payment in the span");
  eq(b.expenses.lines.cogs.gross, 4083.34, "the second share, as with every payment read");
});
test("every view's rows add up to the totals with sales, invoices, credit notes, restocks and adjustments together", () => {
  const input = {
    sales: [
      { id: "s1", amount: 15000, date: "2026-10-01", items: [goods("l1", 10000, 6500.5), service("l2", 5000)] },
      { id: "s2", amount: 12000, date: "2026-10-01", isCredit: true, items: [goods("l3", 12000, 7000.01)] },
    ],
    debts: [{ id: "d1", amount: 12000, saleId: "s2", customerId: "c1", payments: [{ id: "p1", amount: 5000, date: "2026-10-05" }] }],
    invoices: [inv()],
    bills: [restock()],
    stockMoves: moves,
    accounts: chart3,
  };
  both((basis) => {
    const rows = books.bookRows(input, basis);
    const b = books.computeBooks(input, { basis });
    eq(sumOf(rows.filter((r) => r.type === "expense")), b.expenses.total, `${basis} expenses`);
    eq(sumOf(rows.filter((r) => r.type === "income")), b.sales.gross, `${basis} income`);
    eq(new Set(rows.map((r) => r.id)).size, rows.length, `${basis}: ids are unique`);
  });
  eq(cogsOf(input, { basis: "sold" }).gross, 19500.51, "sold: 6,500.50 + 7,000.01 + 6,000");
  eq(cogsOf(input, { basis: "paid" }).gross, 11817.17, "paid: 6,500.50 + 2,916.67 + 2,400");
  // The sale's own row keeps its lines.
  eq(books.bookRows(input, "sold").find((r) => r.id === "s1").items.length, 2, "items on the sale's row");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
