// The app builds the books rule's input the way the server's loader does
// (chart of accounts, 2026-10-12): each account's class from the chart, a
// transfer's fee, and rows in another currency left out of the naira books.
// Both sides run the same books.js, so the totals agree only if the inputs do.
// Release 2 (2026-10-13): bills, as AppContext maps the sync bundle's rows
// (mapBill) and useBooks hands them over, against the server's loader
// (booksData.billInput), and debits that paid a bill (matchedBillId).
// Loads src/hooks/useBooks.js through Babel with React and AppContext stubbed,
// and AppContext's own pure mappers from its source.
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
const { accountClasses, billInput } = require("../src/utils/booksData");
const { booksOnlyBill } = require("../src/utils/billView");

// AppContext.js needs React Native to load, so its pure mappers are taken from
// its source: lagosDay, mapTransaction, the bill mappers (mapBillPayment to
// mapBill, with the helpers between them) and mapJournal. Each top-level declaration runs
// to its closing "};" or "});" at the start of a line. A mapper this cannot
// find fails the test: the app's real mapping is what is under test.
const ctxSrc = fs.readFileSync(path.join(APP, "src/context/AppContext.js"), "utf8").replace(/\r\n/g, "\n");
function declarations(first, last = first) {
  const start = ctxSrc.indexOf(`\nconst ${first} = `);
  const lastAt = ctxSrc.indexOf(`\nconst ${last} = `, start);
  if (start < 0 || lastAt < 0) throw new Error(`src/context/AppContext.js has no top-level ${start < 0 ? first : last}`);
  const end = /\n\}\)?;\n/g;
  end.lastIndex = lastAt + 1;
  const m = end.exec(ctxSrc);
  if (!m) throw new Error(`the end of ${last} in src/context/AppContext.js`);
  return ctxSrc.slice(start + 1, m.index + m[0].length);
}
let appMap = null;
let appMapError = null;
try {
  appMap = new Function(
    `${declarations("lagosDay")}\n${declarations("mapTransaction")}\n${declarations("mapBillPayment", "mapBill")}\n` +
      `${declarations("mapJournal")}\n` +
      "return { lagosDay, mapTransaction, mapBill, mapJournal };",
  )();
} catch (e) {
  appMapError = e;
}

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

// ── Bills (release 2) ────────────────────────────────────────────────────────
// The same records on both sides: as Prisma reads them on the server (dates
// are Date objects), and as the app gets them, the JSON of the sync bundle
// mapped by AppContext (dates become Lagos days there).
const billChart = [
  ...accounts,
  { id: "a_cogs", type: "cost_of_goods_sold", systemKey: "cogs", categorySlug: "supplies" },
  { id: "a_cash", type: "cash", systemKey: "cash" },
];
const at = (iso) => new Date(iso);
const billRows = [
  // Rent, paid in two parts; the second at 23:30 UTC, the 1st of November in Lagos.
  {
    id: "b1", businessId: "biz", name: "Landlord", billNumber: "R-10", note: null, type: "other", accountId: "a_rent",
    receivedViaAccountId: null, billDate: at("2026-10-01T09:00:00Z"), dueDate: at("2026-10-15T09:00:00Z"),
    originalAmount: 50000, remainingAmount: 20000, status: "partial", estimated: false, createdAt: at("2026-10-01T09:00:00Z"),
    payments: [
      { id: "p1", amount: 20000, date: at("2026-10-05T10:00:00Z"), method: "cash", paidThroughAccountId: null, transactionId: null, estimated: false, outsideBooks: false, note: null },
      { id: "p2", amount: 10000, date: at("2026-10-31T23:30:00Z"), method: "transfer", paidThroughAccountId: null, transactionId: null, estimated: false, outsideBooks: false, note: null },
    ],
  },
  // A loan received in cash, a repayment from the KashBook account.
  {
    id: "b2", businessId: "biz", name: "First Bank", billNumber: null, note: "Loan", type: "loan", accountId: "a_loans",
    receivedViaAccountId: "a_cash", billDate: at("2026-09-15T08:00:00Z"), dueDate: null,
    originalAmount: 300000, remainingAmount: 275000, status: "partial", estimated: false, createdAt: at("2026-09-15T08:00:00Z"),
    payments: [
      { id: "p3", amount: 25000, date: at("2026-10-10T12:00:00Z"), method: "bank", paidThroughAccountId: null, transactionId: "t8", estimated: false, outsideBooks: false, note: null },
    ],
  },
  // A payable from before bills, dated 23:30 UTC on 30 September (1 October
  // in Lagos): its paid part outside the books, then a payment from KashBook.
  {
    id: "b3", businessId: "biz", name: "Ada Supplies", billNumber: null, note: null, type: "supplier", accountId: "a_cogs",
    receivedViaAccountId: null, billDate: at("2026-09-30T23:30:00Z"), dueDate: null,
    originalAmount: 80000, remainingAmount: 35000, status: "partial", estimated: true, createdAt: at("2026-09-30T23:30:00Z"),
    payments: [
      { id: "p4", amount: 30000, date: at("2026-10-02T07:00:00Z"), method: "cash", paidThroughAccountId: null, transactionId: null, estimated: true, outsideBooks: true, note: null },
      { id: "p5", amount: 15000, date: at("2026-10-12T15:00:00Z"), method: "bank", paidThroughAccountId: null, transactionId: "t9", estimated: false, outsideBooks: false, note: null },
    ],
  },
  // No account (the books count it as spending), unpaid.
  {
    id: "b4", businessId: "biz", name: "Generator man", billNumber: null, note: null, type: "other", accountId: null,
    receivedViaAccountId: null, billDate: at("2026-10-20T11:00:00Z"), dueDate: null,
    originalAmount: 700, remainingAmount: 700, status: "unpaid", estimated: false, createdAt: at("2026-10-20T11:00:00Z"),
    payments: [],
  },
];
// The KashBook debits that paid b2 and b3 (the second with a fee and 100 the
// payment did not take), as the server loads them.
const debitRows = [
  { id: "t8", type: "expense", amount: 25000, fee: 0, date: at("2026-10-10T12:00:00Z"), purpose: null, matchedBillId: "b2", matchedAmount: 25000, currency: "NGN", source: "anchor" },
  { id: "t9", type: "expense", amount: 15100, fee: 26.88, date: at("2026-10-12T15:00:00Z"), purpose: null, matchedBillId: "b3", matchedAmount: 15000, currency: "NGN", source: "anchor" },
];
const wire = (rows) => JSON.parse(JSON.stringify(rows));
const serverBills = () => ({ bankRows: debitRows, bills: billRows.map(billInput), accounts: accountClasses(billChart) });
const appBills = () => {
  if (!appMap) throw appMapError;
  const state = wire(billRows).map((b) => appMap.mapBill(b, "biz"));
  const txs = wire(debitRows).map((t) => appMap.mapTransaction(t, "biz"));
  return { state, txs, input: booksInputFrom({ transactions: txs, invoices: [], customers: [], accounts: billChart, baseCurrency: "NGN", bills: state }) };
};
const PERIODS = [{}, { from: "2026-09-01", to: "2026-09-30" }, { from: "2026-10-01", to: "2026-10-31" }, { from: "2026-11-01", to: "2026-11-30" }];

check("bills: what the rule reads of each bill is the same on the phone as on the server", () => {
  const { input } = appBills();
  const s = serverBills();
  const read = (b) => ({
    id: b.id, accountId: b.accountId || null, billDate: serverBooks.dayKey(b.billDate), amount: b.amount, estimated: !!b.estimated,
    payments: (b.payments || []).map((p) => ({
      id: p.id, amount: p.amount, date: serverBooks.dayKey(p.date), method: p.method, transactionId: p.transactionId || null, outsideBooks: !!p.outsideBooks,
    })),
  });
  assert.deepStrictEqual(input.bills.map(read), s.bills.map(read));
  assert.deepStrictEqual(input.bankRows.map((t) => [t.id, t.matchedBillId, t.matchedAmount]), [["t8", "b2", 25000], ["t9", "b3", 15000]]);
});

for (const basis of ["paid", "sold"]) {
  check(`bills: the app's totals and rows equal the server's, "when ${basis}", in every period`, () => {
    const a = appBills().input;
    const s = serverBills();
    for (const period of PERIODS) {
      const opts = { ...period, basis };
      const x = appBooks.computeBooks(a, opts);
      const y = serverBooks.computeBooks(s, opts);
      assert.deepStrictEqual(
        [x.expenses.total, x.expenses.lines.bills.gross, x.expenses.lines.bank.gross, x.profit],
        [y.expenses.total, y.expenses.lines.bills.gross, y.expenses.lines.bank.gross, y.profit],
        JSON.stringify(period),
      );
    }
    const rows = (input, books) => books.bookRows(input, basis).map((r) => [r.id, r.type, r.amount, r.date, r.accountId || null]);
    assert.deepStrictEqual(rows(a, appBooks), rows(s, serverBooks));
  });
}

check("bills: what the rule makes of them (a loan never, the part outside the books never, a paid debit once)", () => {
  const a = appBills().input;
  const paid = (period) => appBooks.computeBooks(a, { ...period, basis: "paid" }).expenses.total;
  const sold = (period) => appBooks.computeBooks(a, { ...period, basis: "sold" }).expenses.total;
  // October, when paid: rent 20,000 + the supplier 15,000 (from KashBook) +
  // what t9 left (100) and its fee; the loan repayment is not spending.
  assert.strictEqual(paid(PERIODS[2]), 20000 + 15000 + 100 + 26.88);
  assert.strictEqual(paid(PERIODS[3]), 10000, "November: the rent payment made at 00:30 Lagos time");
  // When sold: the rent bill and the supplier's open part on 1 October in
  // Lagos, the generator man's bill; t9's rest and fee as before.
  assert.strictEqual(sold(PERIODS[1]), 0, "September: nothing (the supplier's bill is 1 October in Lagos)");
  assert.strictEqual(sold(PERIODS[2]), 50000 + 50000 + 700 + 100 + 26.88);
});

check("bills: the VAT estimate is the same on the phone", () => {
  const vat = { enabled: true, rate: 7.5, inclusive: true };
  const a = appBooks.vatReturn(appBills().input, "2026-10", vat);
  const s = serverBooks.vatReturn(serverBills(), "2026-10", vat);
  assert.strictEqual(a.inputEstimate, s.inputEstimate);
  assert.ok(a.inputEstimate > 0);
});

check("bills: the state's bills are handed over as they are, never changed", () => {
  const { state, input } = appBills();
  const before = JSON.stringify(state);
  appBooks.computeBooks(input, { basis: "sold" });
  appBooks.bookRows(input, "paid");
  assert.strictEqual(JSON.stringify(state), before);
});

check("bills: a phone that has none counts none (an older caller passes no bills)", () => {
  const none = booksInputFrom({ transactions: wire(debitRows).map((t) => (appMap ? appMap.mapTransaction(t, "biz") : t)), invoices: [], customers: [], accounts: billChart });
  assert.deepStrictEqual(none.bills || [], []);
  // Its debits still say they paid a bill, so only what the payments did not
  // take counts: the bills' own share waits for the bills.
  assert.strictEqual(appBooks.computeBooks(none, { basis: "paid" }).expenses.total, 100 + 26.88);
});

check("bills sent for the books alone (staff without the bills permission) count exactly as the whole bills", () => {
  if (!appMap) throw appMapError;
  const whole = appBills().input;
  const state = wire(billRows.map(booksOnlyBill)).map((b) => appMap.mapBill(b, "biz"));
  assert.ok(state.every((b) => b.vendorName === "" && b.billNumber === "" && b.note === ""), "no supplier, number or note");
  const a = booksInputFrom({ transactions: appBills().txs, invoices: [], customers: [], accounts: billChart, baseCurrency: "NGN", bills: state });
  for (const basis of ["paid", "sold"]) {
    for (const period of PERIODS) {
      const opts = { ...period, basis };
      assert.deepStrictEqual(appBooks.computeBooks(a, opts), appBooks.computeBooks(whole, opts), JSON.stringify(opts));
    }
  }
});

// Published adjustments as booksData loads them and GET /sync sends them (the
// same columns): a journal's date is the start of its day in UTC.
const journalRows = [
  {
    id: "j1", businessId: "biz", number: "MJ-00001", date: at("2026-10-10T00:00:00Z"), note: null, status: "published",
    lines: [
      { id: "l1", accountId: "a_rent", debit: 4000, credit: 0, description: null },
      { id: "l2", accountId: "a_cash", debit: 0, credit: 4000, description: null },
    ],
  },
  {
    id: "j2", businessId: "biz", number: "MJ-00002", date: at("2026-10-31T00:00:00Z"), note: "Interest", status: "published",
    lines: [
      { id: "l3", accountId: "a_owner", debit: 1500, credit: 0, description: null },
      { id: "l4", accountId: "a_interest", debit: 0, credit: 1500, description: "Bank interest" },
    ],
  },
];

check("journals: the phone's published adjustments count exactly as the server's, in both views and every period", () => {
  if (!appMap) throw appMapError;
  const phone = wire(journalRows).map((j) => appMap.mapJournal(j, "biz"));
  assert.deepStrictEqual(phone.map((j) => j.date), ["2026-10-10", "2026-10-31"]);
  const { state, txs } = appBills();
  const a = booksInputFrom({ transactions: txs, invoices: [], customers: [], accounts: billChart, baseCurrency: "NGN", bills: state, journals: phone });
  const s = { ...serverBills(), journals: journalRows };
  for (const basis of ["paid", "sold"]) {
    for (const period of PERIODS) {
      const opts = { ...period, basis };
      const x = appBooks.computeBooks(a, opts);
      const y = serverBooks.computeBooks(s, opts);
      assert.deepStrictEqual(
        [x.sales.total, x.expenses.total, x.profit, x.sales.lines.journals.gross, x.expenses.lines.journals.gross],
        [y.sales.total, y.expenses.total, y.profit, y.sales.lines.journals.gross, y.expenses.lines.journals.gross],
        JSON.stringify(opts),
      );
    }
    const rows = (input, books) => books.bookRows(input, basis).map((r) => [r.id, r.type, r.amount, r.date, r.accountId || null]);
    assert.deepStrictEqual(rows(a, appBooks), rows(s, serverBooks));
    // They do count: 4,000 more spending on rent, 1,500 more sales (interest).
    const oct = appBooks.computeBooks(a, { ...PERIODS[2], basis });
    assert.deepStrictEqual([oct.expenses.lines.journals.gross, oct.sales.lines.journals.gross], [4000, 1500], basis);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
