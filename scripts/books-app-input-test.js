// The app builds the books rule's input the way the server's loader does
// (chart of accounts, 2026-10-12): each account's class from the chart, a
// transfer's fee, and rows in another currency left out of the naira books.
// Both sides run the same books.js, so the totals agree only if the inputs do.
// Release 2 (2026-10-13): bills, as AppContext maps the sync bundle's rows
// (mapBill) and useBooks hands them over, against the server's loader
// (booksData.billInput), and debits that paid a bill (matchedBillId).
// Release 3 (stock cost): sales' lines, invoice lines' costs and restocks,
// stock movements and restock bills, as AppContext maps the sync bundle
// (mapSale, mapInvoice, mapStockMove, mapBill, mapDebtRecord) against the
// server's loader; and the app's accounts for report rows
// (src/utils/accountRows.js: salesByAccount, byAccount) against the server's
// ledger on random books with stock.
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

// ── Stock cost (release 3) ───────────────────────────────────────────────────
// AppContext's release 3 mappers, cut from its source like the ones above.
let appMap3 = null;
let appMap3Error = null;
try {
  appMap3 = new Function(
    `${declarations("lagosDay")}\n${declarations("mapSale", "byPosition")}\n${declarations("mapTransaction")}\n` +
      `${declarations("mapDebtRecord")}\n${declarations("numberOrNull", "mapStockMove")}\n` +
      `${declarations("mapBillPayment", "mapBillItem")}\n${declarations("mapInvoice")}\n` +
      "return { mapSale, mapTransaction, mapDebtRecord, mapStockMove, mapBill, mapInvoice };",
  )();
} catch (e) {
  appMap3Error = e;
}

const stockChart = [
  ...billChart,
  { id: "a_stock", type: "stock", systemKey: "stock" },
  { id: "a_service", type: "income", systemKey: "service_income" },
  { id: "a_adj", type: "cost_of_goods_sold", systemKey: "stock_adjustments" },
];
// The records as booksData selects them (dates are Date objects there).
const saleLine = (id, itemType, amount, accountId, costAmount, extra = {}) => ({
  id, itemId: itemType === "other" ? null : `${itemType}-${id}`, name: id, itemType, quantity: 1, amount, accountId, costAmount, ...extra,
});
const stockSales = [
  {
    id: "s1", amount: 21500, date: at("2026-10-01T09:00:00Z"), isCredit: false, channel: null, customerId: null, currency: "NGN",
    paymentMethod: "cash", matchedTransactionId: null, accountId: null, depositAccountId: null, notes: "Saturday",
    items: [saleLine("l1", "goods", 15000, "a_sales", 9000.5), saleLine("l2", "service", 5000, "a_service", 0), saleLine("l3", "other", 1500, "a_sales", 0)],
  },
  {
    id: "s2", amount: 12000, date: at("2026-10-02T10:00:00Z"), isCredit: true, channel: null, customerId: "c1", currency: "NGN",
    paymentMethod: "credit", matchedTransactionId: null, accountId: null, depositAccountId: null, notes: null,
    items: [saleLine("l4", "goods", 12000, "a_sales", 7000.01)],
  },
  // Sold at 23:30 UTC on 30 September: 1 October in Lagos.
  {
    id: "s3", amount: 3000, date: at("2026-09-30T23:30:00Z"), isCredit: false, channel: null, customerId: null, currency: "NGN",
    paymentMethod: "cash", matchedTransactionId: null, accountId: null, depositAccountId: null, notes: null,
    items: [saleLine("l5", "goods", 3000, null, 1999.99)],
  },
];
const stockDebts = [{
  id: "d1", customerId: "c1", amount: 12000, paidAmount: 12000, paid: true, date: at("2026-10-02T10:00:00Z"), saleId: "s2", note: "",
  payments: [
    { id: "dp1", amount: 5000, date: at("2026-10-05T10:00:00Z"), transactionId: null, method: "cash", depositAccountId: null, note: "" },
    // 23:30 UTC on 31 October: 1 November in Lagos.
    { id: "dp2", amount: 7000, date: at("2026-10-31T23:30:00Z"), transactionId: null, method: "transfer", depositAccountId: null, note: "" },
  ],
}];
const stockInvoices = [
  {
    id: "i1", type: "invoice", status: "partial", issueDate: at("2026-10-03T12:00:00Z"), total: 10750, customerId: "c1", invoiceNumber: "INV-1",
    taxAmount: 750, amountPaid: 4300, writtenOffAt: null, writtenOffAmount: null, subtotal: 10000, discountAmount: 0,
    items: [
      { id: "ii1", amount: 6000, accountId: null, itemId: "g1", itemType: "goods", costAmount: 3600, restock: false },
      { id: "ii2", amount: 4000, accountId: "a_service", itemId: "v1", itemType: "service", costAmount: 0, restock: false },
    ],
    payments: [
      { id: "ip1", amount: 4300, method: "cash", date: at("2026-10-10T12:00:00Z"), transactionId: null, depositAccountId: null },
      // Credit from cn2 applied (no money).
      { id: "cr1", amount: 1000, method: "credit_note", date: at("2026-10-25T12:00:00Z"), transactionId: null, depositAccountId: null },
    ],
  },
  {
    id: "cn2", type: "credit_note", status: "paid", issueDate: at("2026-10-24T12:00:00Z"), total: 1000, customerId: "c1", invoiceNumber: "CN-2",
    taxAmount: 0, amountPaid: 1000, writtenOffAt: null, writtenOffAmount: null, subtotal: 1000, discountAmount: 0,
    items: [{ id: "ci2", amount: 1000, accountId: null, itemId: "g1", itemType: "goods", costAmount: 600, restock: true }],
    payments: [{ id: "ca1", amount: 1000, method: "credit_applied", date: at("2026-10-25T12:00:00Z"), transactionId: null, depositAccountId: null }],
  },
  // Written off at 23:30 UTC on 31 October: 1 November in Lagos.
  {
    id: "i2", type: "invoice", status: "partial", issueDate: at("2026-10-15T12:00:00Z"), total: 2000, customerId: "c1", invoiceNumber: "INV-3",
    taxAmount: 0, amountPaid: 500, writtenOffAt: at("2026-10-31T23:30:00Z"), writtenOffAmount: 1500, subtotal: 2000, discountAmount: 0,
    items: [{ id: "ii3", amount: 2000, accountId: null, itemId: "g1", itemType: "goods", costAmount: 1200, restock: false }],
    payments: [{ id: "ip2", amount: 500, method: "cash", date: at("2026-10-20T12:00:00Z"), transactionId: null, depositAccountId: null }],
  },
  {
    id: "cn1", type: "credit_note", status: "paid", issueDate: at("2026-10-12T12:00:00Z"), total: 5000, customerId: "c1", invoiceNumber: "CN-1",
    taxAmount: 0, amountPaid: 5000, writtenOffAt: null, writtenOffAmount: null, subtotal: 5000, discountAmount: 0,
    items: [{ id: "ci1", amount: 5000, accountId: null, itemId: "g1", itemType: "goods", costAmount: 3000, restock: true }],
    payments: [{ id: "rf1", amount: 5000, method: "refund_cash", date: at("2026-10-31T23:45:00Z"), transactionId: null, depositAccountId: null }],
  },
  {
    id: "dr1", type: "invoice", status: "draft", issueDate: at("2026-10-04T12:00:00Z"), total: 900, customerId: "c1", invoiceNumber: "INV-2",
    taxAmount: 0, amountPaid: 0, writtenOffAt: null, writtenOffAmount: null, subtotal: 900, discountAmount: 0,
    items: [{ id: "di1", amount: 900, accountId: null, itemId: "g1", itemType: "goods", costAmount: 500, restock: false }],
    payments: [],
  },
];
const stockMoveRows = [
  { id: "m1", kind: "opening", reason: null, date: at("2026-09-01T08:00:00Z"), quantity: 40, value: 60000, itemId: "g1", note: null },
  { id: "m2", kind: "adjustment", reason: "damaged", date: at("2026-10-06T08:00:00Z"), quantity: -1, value: -1500, itemId: "g1", note: "Rain" },
  { id: "m3", kind: "revalue", reason: null, date: at("2026-10-31T23:30:00Z"), quantity: 0, value: 250.5, itemId: "g1", note: null },
  { id: "m4", kind: "opening_value", reason: null, date: at("2026-09-01T08:00:00Z"), quantity: 0, value: 4000, itemId: "g2", note: null },
];
const restockRow = {
  id: "rb1", businessId: "biz", name: "Ada Wholesale", billNumber: null, note: null, type: "other", accountId: "a_stock",
  receivedViaAccountId: null, billDate: at("2026-10-01T08:00:00Z"), dueDate: null,
  originalAmount: 21500, remainingAmount: 0, status: "paid", estimated: false, createdAt: at("2026-10-01T08:00:00Z"),
  payments: [{ id: "rp1", amount: 21500, date: at("2026-10-01T08:00:00Z"), method: "cash", paidThroughAccountId: null, transactionId: null, estimated: false, outsideBooks: false, note: null }],
  items: [
    { id: "bi1", itemId: "g1", quantity: 10, unitCost: 1500, amount: 15000, position: 0 },
    { id: "bi2", itemId: "g2", quantity: 2.5, unitCost: 2600, amount: 6500, position: 1 },
  ],
};
const serverStock = () => ({
  sales: stockSales, debts: stockDebts, invoices: stockInvoices, stockMoves: stockMoveRows,
  bills: [billInput(restockRow)], bankRows: [], expenses: [], accounts: accountClasses(stockChart),
});
const appStock = () => {
  if (!appMap3) throw appMap3Error;
  const m = appMap3;
  const transactions = wire(stockSales).map((s) => m.mapSale(s, "biz"));
  const customers = [{ id: "c1", transactions: wire(stockDebts).map((d) => m.mapDebtRecord(d)) }];
  const invoices = wire(stockInvoices).map((i) => m.mapInvoice(i, "biz"));
  const stockMoves = wire(stockMoveRows).map((x) => m.mapStockMove(x, "biz"));
  const bills = [m.mapBill(wire(restockRow), "biz")];
  return booksInputFrom({ transactions, invoices, customers, accounts: stockChart, baseCurrency: "NGN", bills, stockMoves });
};
const STOCK_PERIODS = [{}, { from: "2026-09-01", to: "2026-09-30" }, { from: "2026-10-01", to: "2026-10-31" }, { from: "2026-11-01", to: "2026-11-30" }];

for (const basis of ["paid", "sold"]) {
  check(`stock: the phone's sales lines, invoice costs, credit-note restocks, movements and restocks count as the server's, "when ${basis}"`, () => {
    const a = appStock();
    const s = serverStock();
    for (const period of STOCK_PERIODS) {
      const opts = { ...period, basis };
      const x = appBooks.computeBooks(a, opts);
      const y = serverBooks.computeBooks(s, opts);
      const pick = (b) => [b.sales.total, b.expenses.total, b.expenses.lines.cogs.gross, b.expenses.lines.stockAdjustments.gross, b.profit];
      assert.deepStrictEqual(pick(x), pick(y), JSON.stringify(opts));
    }
    const rows = (input, books) => books.bookRows(input, basis).map((r) => [r.id, r.type, r.amount, r.date, r.accountId || null]);
    assert.deepStrictEqual(rows(a, appBooks), rows(s, serverBooks));
  });
}

check("stock: what the rule makes of it (each cost on its Lagos day; when paid, with the money)", () => {
  const a = appStock();
  const cogs = (basis, period) => appBooks.computeBooks(a, { ...period, basis }).expenses.lines.cogs.gross;
  // Sold, October: s1 9,000.50, s2 7,000.01, s3 1,999.99 (1 October in
  // Lagos), the invoices 3,600 and 1,200, the credit notes' goods back
  // -3,000 and -600; the draft nothing.
  assert.strictEqual(cogs("sold", STOCK_PERIODS[2]), 19200.5);
  assert.strictEqual(cogs("sold", STOCK_PERIODS[1]), 0, "September: none (s3 is October's in Lagos)");
  // Paid, October: s1 and s3 on their day, 5/12 of s2 (2,916.67), 4,300 of
  // 10,750 of i1 (1,440) and the 1,000 of credit applied to it (334.88),
  // 500 of 2,000 of i2 (300), cn2's goods back with its credit applied
  // (-600); cn1's refund and i2's write-off are November's in Lagos.
  assert.strictEqual(cogs("paid", STOCK_PERIODS[2]), 15392.04, "9,000.50 + 1,999.99 + 2,916.67 + 1,440 + 334.88 + 300 - 600");
  assert.strictEqual(cogs("paid", STOCK_PERIODS[3]), 1983.34, "November: the rest of s2, cn1's goods back, i2's write-off (900)");
  assert.deepStrictEqual(
    appBooks.bookRows(a, "paid").filter((r) => ["cogs_ip_cr1", "cogs_ip_ca1", "cogs_wo_i2"].includes(r.id)).map((r) => [r.id, r.amount, r.date]),
    [["cogs_ip_cr1", 334.88, "2026-10-25"], ["cogs_ip_ca1", -600, "2026-10-25"], ["cogs_wo_i2", 900, "2026-11-01"]],
  );
  const adj = (period) => appBooks.computeBooks(a, { ...period, basis: "paid" }).expenses.lines.stockAdjustments.gross;
  assert.deepStrictEqual([adj(STOCK_PERIODS[1]), adj(STOCK_PERIODS[2]), adj(STOCK_PERIODS[3])], [0, 1500, -250.5]);
  assert.strictEqual(appBooks.computeBooks(a, { basis: "sold" }).expenses.lines.bills.gross, 0, "a restock is never spending");
});

check("stock: the VAT estimate takes the restock in, the same on the phone", () => {
  const vat = { enabled: true, rate: 7.5, inclusive: true };
  const x = appBooks.vatReturn(appStock(), "2026-10", vat);
  const y = serverBooks.vatReturn(serverStock(), "2026-10", vat);
  assert.strictEqual(x.inputEstimate, y.inputEstimate);
  assert.strictEqual(x.inputEstimate, 1500);
});

// The app's accounts for report rows, on random books with stock, against
// the server's ledger: salesByAccount gives the ledger's income by account,
// and byAccount over the expense rows its spending by account, in both views
// and random periods (to the kobo, as the ledger posts them).
const appChart = load(path.join(APP, "src/utils/chart.js"), stubs);
const appRows = load(path.join(APP, "src/utils/accountRows.js"), stubs);
const serverChart = require("../src/utils/chart");
const ledger = require("../src/utils/ledger");
const gen = require("./lib/booksGen");
const GEN_CHART = gen.seededChart();
const IDX = appChart.indexChart(GEN_CHART);
const SC = serverChart.indexChart(GEN_CHART);
const genId = (key) => serverChart.sysAccount(SC, key).id;
const RULES = new Map([
  ["r1", { category: "rent" }],
  ["r2", { category: "rent", accountId: genId(serverChart.SYS.LOANS) }],
  ["r3", { category: "other", accountId: GEN_CHART.find((a) => a.name === "Advertising and Marketing").id }],
]);
const byId = (groups) => {
  const out = new Map();
  for (const g of groups) if (g.k) out.set(g.id, (out.get(g.id) || 0) + g.k);
  return out;
};
const sameMap = (got, want, what) => {
  for (const id of new Set([...got.keys(), ...want.keys()])) {
    if ((got.get(id) || 0) !== (want.get(id) || 0)) {
      throw new Error(`${what}: ${(SC.byId.get(id) || { name: id }).name} phone ${(got.get(id) || 0) / 100}, ledger ${(want.get(id) || 0) / 100}`);
    }
  }
};

check("stock: the phone's sales and spending by account are the ledger's, on random books (both views, random periods)", () => {
  const g = gen.makeGen(gen.rng(20261013));
  let saleSplits = 0;
  let costRows = 0;
  for (let i = 0; i < 400; i++) {
    const input = gen.randomInput(g, { chart: true, accounts: GEN_CHART, stock: true, links: g.chance(0.5) });
    const opts = gen.randomOpts(g);
    // The same records as AppContext keeps them: each says what it is
    // (source), a bank row's provider moving to providerSource.
    const phone = {
      ...input,
      sales: input.sales.map((s) => ({ ...s, source: "sale" })),
      expenses: input.expenses.map((e) => ({ ...e, source: "expense" })),
      bankRows: input.bankRows.map((t) => ({ ...t, source: "transaction", providerSource: t.source })),
    };
    for (const basis of ["paid", "sold"]) {
      const L = ledger.buildLedger(input, { chart: SC, basis, vat: opts.vat, baseCurrency: "NGN", recurring: RULES });
      const pl = ledger.profitAndLoss(L.entries, SC, { from: opts.from, to: opts.to });
      const what = `iteration ${i} (${basis})`;
      const sales = appRows.salesByAccount(phone, IDX, { basis, vat: opts.vat, from: opts.from, to: opts.to, recurring: RULES });
      sameMap(
        byId(sales.map((x) => ({ id: x.account && x.account.id, k: Math.round(x.amount * 100) }))),
        byId(pl.income.map((r) => ({ id: r.account.id, k: Math.round(r.amount * 100) }))),
        `${what} income`,
      );
      const inPeriod = (r) => (!opts.from || r.date >= opts.from) && (!opts.to || r.date <= opts.to);
      const rows = appBooks.bookRows(phone, basis).filter(inPeriod);
      costRows += rows.filter((r) => r.source === "cogs" || r.source === "stock_adjustment").length;
      saleSplits += rows.filter((r) => r.source === "sale" && (r.items || []).length > 1).length;
      sameMap(
        byId(appRows.byAccount(rows, IDX, basis, "expense", RULES).map((x) => ({ id: x.account && x.account.id, k: Math.round(x.amount * 100) }))),
        byId(pl.expenses.map((r) => ({ id: r.account.id, k: Math.round(r.amount * 100) }))),
        `${what} spending`,
      );
    }
  }
  assert.ok(saleSplits >= 100 && costRows >= 400, `only ${saleSplits} split sales and ${costRows} cost rows`);
});

check("stock: a sale's row counts as a whole in the account taking most of it; cost rows in Cost of Goods Sold and Stock Adjustments", () => {
  const svc = genId(serverChart.SYS.SERVICE_INCOME);
  const sale = { id: "s1", source: "sale", type: "income", amount: 10000, items: [{ id: "a", itemType: "goods", amount: 3000, accountId: null }, { id: "b", itemType: "service", amount: 7000, accountId: null }] };
  assert.strictEqual(appRows.rowAccount(sale, IDX, "paid").id, svc, "the service line takes most");
  assert.strictEqual(appRows.rowAccount({ ...sale, items: [] }, IDX, "paid").id, genId(serverChart.SYS.SALES), "no lines: its own account, else Sales");
  assert.strictEqual(appRows.rowAccount({ source: "cogs", type: "expense", amount: 5 }, IDX, "sold").id, genId(serverChart.SYS.COGS));
  assert.strictEqual(appRows.rowAccount({ source: "stock_adjustment", type: "expense", amount: 5 }, IDX, "paid").id, genId(serverChart.SYS.STOCK_ADJ));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
