// The books rule's chart-of-accounts additions (2026-10-11), with expected
// numbers: transfer fees as bank charges in both views, expenses booked to a
// balance-sheet account (equipment, prepaid rent) counted nowhere, bank rows
// explained with an account (income, other income, expense, balance sheet),
// and no longer waiting to be matched once explained so (2026-10-12), rows in
// another currency left out, itemized expenses (2026-10-12) counted line by
// line, and bookRows still adding up to the totals with all of it present.
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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
