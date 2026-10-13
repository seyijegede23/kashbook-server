// The restructured books rule must give exactly what the frozen copy gives
// (scripts/books-oracle.js): computeBooks, bookRows, receivables and vatReturn
// on seeded random inputs that mix every shape the rule handles (credit sales
// with and without debts, matched and partly matched bank rows, purposes,
// invoice payments of every kind, credit notes, write-offs, voids, quotes, VAT
// on and off, inclusive and exclusive), for random periods and both views.
//
//   node scripts/books-oracle-test.js [iterations] [seed]
const oracle = require("./books-oracle");
const books = require("../src/utils/books");

const ITER = Number(process.argv[2]) || 3000;
const SEED = Number(process.argv[3]) || 20261011;

// mulberry32: small, seeded, reproducible.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeGen(r) {
  const int = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
  const pick = (arr) => arr[int(0, arr.length - 1)];
  const chance = (p) => r() < p;
  // Naira with kobo now and then, up to ₦500,000.
  const money = () => (int(1, 50000) * 100 + (chance(0.3) ? int(0, 99) : 0)) / 100;
  const day = () => `2026-${String(int(1, 12)).padStart(2, "0")}-${String(int(1, 28)).padStart(2, "0")}`;
  // Dates arrive as day strings (the app) or Date objects (the server).
  const when = () => (chance(0.5) ? day() : new Date(`${day()}T${String(int(0, 23)).padStart(2, "0")}:${String(int(0, 59)).padStart(2, "0")}:00Z`));
  let n = 0;
  const id = (p) => `${p}${++n}`;
  return { int, pick, chance, money, day, when, id };
}

function randomInput(g) {
  const sales = [];
  const debts = [];
  for (let i = 0, k = g.int(0, 8); i < k; i++) {
    const s = { id: g.id("s"), amount: g.money(), date: g.when(), isCredit: g.chance(0.3), channel: g.pick([null, "walk-in", "instagram"]), customerId: g.chance(0.5) ? "c1" : null };
    sales.push(s);
    if (s.isCredit && g.chance(0.7)) {
      const paid = g.chance(0.5) ? Math.min(s.amount, g.money()) : 0;
      debts.push({
        id: g.id("d"), amount: s.amount, paidAmount: paid, paid: paid >= s.amount, date: s.date, saleId: s.id, customerId: "c1",
        payments: paid ? [{ id: g.id("dp"), amount: paid, date: g.when() }] : [],
      });
    }
  }
  for (let i = 0, k = g.int(0, 4); i < k; i++) {
    const amount = g.money();
    const pays = [];
    let left = amount;
    for (let j = 0, m = g.int(0, 3); j < m && left > 0; j++) {
      const a = Math.min(left, g.money());
      left -= a;
      pays.push({ id: g.id("dp"), amount: a, date: g.when(), note: "" });
    }
    debts.push({ id: g.id("d"), amount, paidAmount: amount - left, paid: left <= 0, date: g.when(), saleId: null, customerId: "c2", note: "credit", payments: pays });
  }
  const expenses = [];
  for (let i = 0, k = g.int(0, 8); i < k; i++) expenses.push({ id: g.id("e"), amount: g.money(), date: g.when(), category: g.pick(["rent", "supplies", "other"]) });
  const bankRows = [];
  for (let i = 0, k = g.int(0, 10); i < k; i++) {
    const income = g.chance(0.6);
    const amount = g.money();
    const tx = { id: g.id("t"), type: income ? "income" : "expense", amount, date: g.when(), purpose: null };
    if (g.chance(0.25)) tx.purpose = g.pick(["cash_deposit", "own_transfer", "owner_money", "loan", "supplier_refund", "customer_refund", "savings_fee"]);
    if (income && g.chance(0.3)) tx[g.pick(["matchedSaleId", "matchedCustomerId", "matchedInvoiceId"])] = "x";
    if (!income && g.chance(0.3)) tx.matchedExpenseId = "x";
    if ((tx.matchedSaleId || tx.matchedCustomerId || tx.matchedInvoiceId || tx.matchedExpenseId) && g.chance(0.7)) {
      tx.matchedAmount = Math.round(amount * g.int(10, 100)) / 100;
    }
    if (!income && g.chance(0.4)) tx.fee = g.pick([0, 10.75, 26.88, 53.75]);
    bankRows.push(tx);
  }
  const invoices = [];
  for (let i = 0, k = g.int(0, 5); i < k; i++) {
    const type = g.pick(["invoice", "invoice", "invoice", "credit_note", "quote"]);
    const total = g.money();
    const taxAmount = g.chance(0.5) ? Math.round((total * 7.5) / 107.5 * 100) / 100 : 0;
    const status = g.pick(["draft", "sent", "partial", "paid", "overdue", "void"]);
    const payments = [];
    for (let j = 0, m = g.int(0, 3); j < m; j++) {
      const method = type === "credit_note"
        ? g.pick(["credit_applied", "refund_cash", "refund_bank", "refund_transfer"])
        : g.pick(["cash", "card", "cheque", "transfer", "pos", "other", "bank", "credit_note"]);
      payments.push({ id: g.id("ip"), amount: Math.min(total, g.money()), method, date: g.when(), transactionId: method.endsWith("bank") && g.chance(0.6) ? "t-link" : null });
    }
    const amountPaid = payments.reduce((s, p) => s + p.amount, 0);
    const inv = { id: g.id("i"), type, status, issueDate: g.day(), total, taxAmount, amountPaid, payments, invoiceNumber: `INV-${i}`, customerId: "c1" };
    if (type === "invoice" && g.chance(0.15)) {
      inv.writtenOffAt = g.when();
      inv.writtenOffAmount = Math.max(0, Math.round((total - amountPaid) * 100) / 100);
    }
    invoices.push(inv);
  }
  return { sales, expenses, bankRows, invoices, debts };
}

function randomOpts(g) {
  const from = g.chance(0.2) ? "" : g.day();
  let to = g.chance(0.2) ? "" : g.day();
  if (from && to && to < from) to = from;
  const vat = g.chance(0.4)
    ? { enabled: true, rate: g.pick([7.5, 7.5, 5, null]), inclusive: g.chance(0.7) }
    : { enabled: false };
  return { from, to, basis: g.pick(["paid", "sold"]), vat };
}

// Exact values, keys sorted so the order an object was built in doesn't matter.
function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === "object" && !(v instanceof Date)) {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = canon(v[k]);
    return out;
  }
  return v;
}
const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

// The chart of accounts added rules for fields the old rule never read
// (fees, accounts, currency); those have their own tests in books-test.js.
// Here the inputs carry none of them, so the two must agree exactly.
function legacyOnly(input) {
  const strip = (r) => {
    const { fee, accountId, foreignCurrency, ...rest } = r;
    return rest;
  };
  return {
    ...input,
    sales: input.sales.map(strip),
    expenses: input.expenses.map(strip),
    // A savings break fee now counts as a bank charge: a new rule, tested apart.
    bankRows: input.bankRows.filter((tx) => tx.purpose !== "savings_fee").map(strip),
    accounts: undefined,
  };
}

// The lines the chart of accounts added must stay empty on legacy inputs; once
// checked, they are dropped so the rest compares with the old shape. Release 2
// added bills and manual journals.
function withoutNewLines(res) {
  const out = JSON.parse(JSON.stringify(res));
  const added = [["sales", "bankIncome"], ["expenses", "bankCharges"], ["sales", "journals"], ["expenses", "bills"], ["expenses", "journals"]];
  for (const [side, line] of added) {
    const l = out[side] && out[side].lines && out[side].lines[line];
    if (l && l.count === 0 && l.gross === 0 && l.vat === 0) delete out[side].lines[line];
  }
  return out;
}

let failed = 0;
const seen = {};
const r = rng(SEED);
const g = makeGen(r);
for (let i = 0; i < ITER; i++) {
  const input = legacyOnly(randomInput(g));
  const opts = randomOpts(g);
  for (const ev of books.bookEvents(input, opts).events) {
    const k = `${opts.basis}:${ev.side}:${ev.line}`;
    seen[k] = (seen[k] || 0) + 1;
  }
  const checks = [
    ["computeBooks", () => oracle.computeBooks(input, opts), () => withoutNewLines(books.computeBooks(input, opts))],
    ["bookRows", () => oracle.bookRows(input, opts.basis), () => books.bookRows(input, opts.basis)],
    ["receivables", () => oracle.receivables(input), () => books.receivables(input)],
    ["vatReturn", () => oracle.vatReturn(input, "2026-06", opts.vat), () => books.vatReturn(input, "2026-06", opts.vat)],
  ];
  for (const [name, a, b] of checks) {
    const x = a();
    const y = b();
    if (!same(x, y)) {
      failed++;
      if (failed <= 3) {
        console.log(`  FAIL  ${name} at iteration ${i} (seed ${SEED})`);
        console.log("        oracle:", JSON.stringify(x).slice(0, 400));
        console.log("        new:   ", JSON.stringify(y).slice(0, 400));
      }
    }
  }
}
// The generator must reach every line of both views, or "identical" proves little.
const EXPECTED = [
  "paid:sales:recorded", "paid:sales:invoicePayments", "paid:sales:debtPayments", "paid:sales:bank",
  "paid:sales:refunds", "paid:sales:awaitingPayment", "paid:sales:creditUnlinked",
  "paid:expenses:recorded", "paid:expenses:bank", "paid:expenses:supplierRefunds",
  "sold:sales:recorded", "sold:sales:invoiced", "sold:sales:creditNotes", "sold:sales:creditGiven",
  "sold:sales:unexplained", "sold:expenses:recorded", "sold:expenses:bank",
  "sold:expenses:supplierRefunds", "sold:expenses:badDebts",
];
const missing = EXPECTED.filter((k) => !(seen[k] >= 20));
if (missing.length) {
  failed++;
  console.log("  FAIL  lines reached fewer than 20 times:", missing.join(", "));
}
console.log(`\nBOOKS ORACLE: ${ITER} random inputs × 4 functions, seed ${SEED}: ${failed ? `${failed} FAILED` : "identical"}`);
process.exit(failed ? 1 : 0);
