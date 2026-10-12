// The app builds the books rule's input the way the server's loader does
// (chart of accounts, 2026-10-12): each account's class from the chart, a
// transfer's fee, and rows in another currency left out of the naira books.
// Both sides run the same books.js, so the totals agree only if the inputs do.
// Loads src/hooks/useBooks.js through Babel with React and AppContext stubbed.
//   node scripts/books-app-input-test.js
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const APP = path.resolve(__dirname, "../..");
const babel = require(require.resolve("@babel/core", { paths: [APP] }));
const cjs = require.resolve("@babel/plugin-transform-modules-commonjs", { paths: [APP] });

const cache = new Map();
function load(file, stubs = {}) {
  if (cache.has(file)) return cache.get(file).exports;
  const { code } = babel.transformSync(fs.readFileSync(file, "utf8"), { filename: file, plugins: [cjs], babelrc: false, configFile: false });
  const mod = { exports: {} };
  cache.set(file, mod);
  const localRequire = (p) => {
    if (stubs[p]) return stubs[p];
    if (p.startsWith(".")) return load(path.resolve(path.dirname(file), p.endsWith(".js") ? p : `${p}.js`), stubs);
    return require(p);
  };
  new Function("exports", "require", "module", code)(mod.exports, localRequire, mod);
  return mod.exports;
}

const stubs = {
  react: { useMemo: (fn) => fn(), useCallback: (fn) => fn },
  "../context/AppContext": { useApp: () => ({}) },
};
const appBooks = load(path.join(APP, "src/utils/books.js"), stubs);
const { booksInputFrom } = load(path.join(APP, "src/hooks/useBooks.js"), stubs);
const serverBooks = require("../src/utils/books");
const { accountClasses } = require("../src/utils/booksData");

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

// A small chart: what each record below names.
const accounts = [
  { id: "a_sales", type: "income", systemKey: "sales" },
  { id: "a_rent", type: "expense", categorySlug: "rent" },
  { id: "a_equip", type: "fixed_asset" },
  { id: "a_interest", type: "other_income" },
  { id: "a_owner", type: "equity", systemKey: "owner_equity" },
  { id: "a_drawings", type: "equity", systemKey: "drawings" },
  { id: "a_loans", type: "long_term_liability", systemKey: "loans" },
];

// AppContext's rows: sales, expenses and bank rows in one list, told apart by
// `source` ("transaction" = a bank row; its provider is `providerSource`).
const transactions = [
  { id: "s1", source: "sale", type: "income", amount: 10000, date: "2026-10-01", currency: "NGN", accountId: "a_sales" },
  { id: "s2", source: "sale", type: "income", amount: 300, date: "2026-10-02", currency: "EUR" },
  { id: "s3", source: "sale", type: "income", amount: 4000, date: "2026-10-03", currency: null },
  { id: "e1", source: "expense", type: "expense", amount: 2500, date: "2026-10-03", category: "rent", accountId: "a_rent" },
  { id: "e2", source: "expense", type: "expense", amount: 90000, date: "2026-10-04", category: "other", accountId: "a_equip" },
  { id: "e3", source: "expense", type: "expense", amount: 50, date: "2026-10-04", category: "other", currency: "EUR" },
  { id: "e4", source: "expense", type: "expense", amount: 700, date: "2026-10-05", category: "transport" },
  { id: "t1", source: "transaction", type: "expense", amount: 20000, fee: 50, date: "2026-10-05", currency: "NGN" },
  { id: "t2", source: "transaction", type: "expense", amount: 5000, fee: 25, date: "2026-10-06", accountId: "a_drawings", purpose: "account" },
  { id: "t3", source: "transaction", type: "income", amount: 1200, date: "2026-10-06", accountId: "a_interest", purpose: null },
  { id: "t4", source: "transaction", type: "income", amount: 30000, date: "2026-10-07", accountId: "a_owner", purpose: "owner_money" },
  { id: "t5", source: "transaction", type: "income", amount: 800, date: "2026-10-07", currency: "EUR" },
  { id: "t6", source: "transaction", type: "income", amount: 6000, date: "2026-10-08" },
  { id: "t7", source: "transaction", type: "expense", amount: 15000, fee: 0, date: "2026-10-08", accountId: "a_loans", purpose: "account" },
];

// The server's loader on the same records (booksData.loadBooksInput).
function serverInput(base = "NGN") {
  const flag = (rows) => rows.map((r) => (r.currency && r.currency !== base ? { ...r, foreignCurrency: true } : r));
  return {
    sales: flag(transactions.filter((t) => t.source === "sale")),
    expenses: flag(transactions.filter((t) => t.source === "expense")),
    bankRows: flag(transactions.filter((t) => t.source === "transaction")),
    invoices: [],
    debts: [],
    accounts: accountClasses(accounts),
  };
}

const appInput = booksInputFrom({ transactions, invoices: [], customers: [], accounts, baseCurrency: "NGN" });

check("the app's input carries each account's class and type", () => {
  assert.deepStrictEqual(appInput.accounts, accountClasses(accounts));
});

check("rows in another currency are flagged; naira rows are passed as they are", () => {
  const flagged = [...appInput.sales, ...appInput.expenses, ...appInput.bankRows].filter((r) => r.foreignCurrency).map((r) => r.id).sort();
  assert.deepStrictEqual(flagged, ["e3", "s2", "t5"]);
  assert.ok(!appInput.sales.find((r) => r.id === "s1").foreignCurrency);
});

check("the state rows are never changed", () => {
  assert.ok(!transactions.some((r) => r.foreignCurrency));
});

for (const basis of ["paid", "sold"]) {
  check(`the app's totals equal the server's, "when ${basis}"`, () => {
    const opts = { from: "2026-10-01", to: "2026-10-31", basis };
    const a = appBooks.computeBooks(appInput, opts);
    const s = serverBooks.computeBooks(serverInput(), opts);
    assert.strictEqual(a.sales.total, s.sales.total);
    assert.strictEqual(a.expenses.total, s.expenses.total);
    assert.strictEqual(a.profit, s.profit);
  });
}

check("what the rule does with them: fees, equipment, drawings, a loan, interest, euros", () => {
  const b = appBooks.computeBooks(appInput, { from: "2026-10-01", to: "2026-10-31", basis: "paid" });
  // Sales: s1 + s3 + the unexplained credit t6 + interest t3 (owner's money and euros left out).
  assert.strictEqual(b.sales.total, 10000 + 4000 + 6000 + 1200);
  // Expenses: rent + transport + the unexplained debit t1 + both fees (equipment,
  // drawings, the loan repayment and the euro expense count nowhere).
  assert.strictEqual(b.expenses.total, 2500 + 700 + 20000 + 50 + 25);
});

check("a business whose base currency is not naira flags its naira rows instead", () => {
  const eur = booksInputFrom({ transactions, invoices: [], customers: [], accounts, baseCurrency: "EUR" });
  assert.ok(eur.sales.find((r) => r.id === "s1").foreignCurrency);
  assert.ok(!eur.sales.find((r) => r.id === "s2").foreignCurrency);
  // No currency on a row means the business's own.
  assert.ok(!eur.sales.find((r) => r.id === "s3").foreignCurrency);
});

check("older callers that pass no accounts still work", () => {
  const old = booksInputFrom({ transactions, invoices: [], customers: [] });
  const b = appBooks.computeBooks(old, { from: "2026-10-01", to: "2026-10-31", basis: "paid" });
  assert.ok(Number.isFinite(b.profit));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
