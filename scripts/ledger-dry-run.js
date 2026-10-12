// Read-only dry run of the chart of accounts' ledger over every real business
// (2026-10-11), BEFORE the release that adds it. For each business it builds the
// ledger in both views from the records (pre-release columns only, the default
// chart in memory) and checks:
//
//   - every entry balances;
//   - the profit and loss by account equals computeBooks, all time and month by
//     month for the last twelve months;
//   - the balance sheet balances today;
//   - the KashBook Account equals the bank ledger (computeRawLedger's rows);
//   - Bank Matching nets to zero (a residue means a record and its bank row
//     disagree), counted, not fixed;
//
// and reports what the release changes: transfer fees that will count as bank
// charges, rows in another currency that leave the naira books, and debits still
// marked as recorded by an expense that no longer exists.
//
// It cannot write: its own client over a pool whose every transaction is
// read-only, two connections, a statement timeout, one business at a time.
// Output: JSON lines with ids and numbers only (no names, no account numbers),
// then a summary.
//
//   node scripts/ledger-dry-run.js <ENV_KEY in server/.env, or a postgres URL> [--limit N]
const fs = require("fs");
const path = require("path");
const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");
const { Pool } = require("pg");
const { pgConnectionConfig } = require("../src/utils/pgSsl");
const books = require("../src/utils/books");
const chart = require("../src/utils/chart");
const ledger = require("../src/utils/ledger");
const { isLedgerBankRow } = require("../src/config/moneySources");

const arg = process.argv[2];
if (!arg) {
  console.error("usage: node scripts/ledger-dry-run.js <ENV_KEY|postgres URL> [--limit N]");
  process.exit(1);
}
const limitAt = process.argv.indexOf("--limit");
const LIMIT = limitAt > 0 ? Number(process.argv[limitAt + 1]) || 0 : 0;

let url = arg;
if (!/^postgres(ql)?:\/\//.test(arg)) {
  const env = require("dotenv").parse(fs.readFileSync(path.join(__dirname, "..", ".env")));
  url = env[arg];
  if (!url) {
    console.error(`no ${arg} in server/.env`);
    process.exit(1);
  }
}
url = url.replace(/sslmode=verify-full/, "sslmode=require");

const pool = new Pool({
  ...pgConnectionConfig(url),
  max: 2,
  options: "-c default_transaction_read_only=on -c statement_timeout=30000",
});
const db = new PrismaClient({ adapter: new PrismaPg(pool) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const K = ledger.K;

// The records the rule reads, with only the columns that exist before the
// release (so this runs against today's database).
async function loadLegacy(biz) {
  const businessId = biz.id;
  const [sales, expenses, bankRows, invoices, debts] = await Promise.all([
    db.sales.findMany({
      where: { businessId },
      select: { id: true, amount: true, date: true, isCredit: true, channel: true, customerId: true, currency: true, paymentMethod: true, matchedTransactionId: true },
    }),
    db.expense.findMany({
      where: { businessId },
      select: { id: true, amount: true, date: true, category: true, currency: true, paymentMethod: true, matchedTransactionId: true },
    }),
    db.transaction.findMany({
      where: { businessId },
      select: {
        id: true, type: true, amount: true, date: true, purpose: true, matchedSaleId: true, matchedCustomerId: true,
        matchedExpenseId: true, matchedInvoiceId: true, matchedAmount: true, fee: true, currency: true, source: true,
        paymentMethod: true, category: true, reference: true,
      },
    }),
    db.invoice.findMany({
      where: { businessId },
      select: {
        id: true, type: true, status: true, issueDate: true, total: true, customerId: true, invoiceNumber: true,
        taxAmount: true, amountPaid: true, writtenOffAt: true, writtenOffAmount: true, subtotal: true, discountAmount: true,
        items: { select: { id: true, amount: true } },
        payments: { select: { id: true, amount: true, method: true, date: true, transactionId: true } },
      },
    }),
    db.debt.findMany({
      where: { customer: { OR: [{ businessId }, { businessId: null, userId: biz.userId }] } },
      select: {
        id: true, customerId: true, amount: true, paidAmount: true, paid: true, date: true, saleId: true, note: true,
        payments: { select: { id: true, amount: true, date: true, transactionId: true } },
      },
    }),
  ]);
  const base = biz.baseCurrency || "NGN";
  for (const list of [sales, expenses, bankRows]) for (const r of list) if (r.currency && r.currency !== base) r.foreignCurrency = true;
  return { sales, expenses, bankRows, invoices, debts };
}

// The default chart, plus an account per category the business uses, as
// ensureChart will make it.
function chartFor(input) {
  const accounts = chart.DEFAULT_CHART.map((a, i) => ({
    id: `a${i}`, type: a.type, name: a.name, systemKey: a.sys || null, categorySlug: a.cat || null,
  }));
  const slugs = new Set(accounts.map((a) => a.categorySlug).filter(Boolean));
  for (const e of input.expenses) {
    const s = chart.canonicalSlug(e.category);
    if (s && !slugs.has(s)) {
      slugs.add(s);
      accounts.push({ id: `c${accounts.length}`, type: "expense", name: chart.nameFromSlug(s), systemKey: null, categorySlug: s });
    }
  }
  return chart.indexChart(accounts);
}

function months(n) {
  const out = [];
  const now = new Date(Date.now() + 3600000);
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth() + 1;
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    out.push({ from: `${y}-${String(m).padStart(2, "0")}-01`, to: `${y}-${String(m).padStart(2, "0")}-${last}` });
  }
  return out;
}

(async () => {
  const today = books.dayKey(new Date());
  const businesses = await db.business.findMany({
    select: { id: true, userId: true, baseCurrency: true, vatEnabled: true, vatRate: true, vatInclusive: true },
    orderBy: { createdAt: "asc" },
    ...(LIMIT ? { take: LIMIT } : {}),
  });
  const sum = {
    businesses: businesses.length, balancedFail: 0, parityFail: 0, sheetFail: 0, bankFail: 0, matchResidue: 0,
    feesAllTime: 0, feesBusinesses: 0, foreignRows: 0, orphanDebits: 0, slowest: 0, errors: 0,
  };
  for (const biz of businesses) {
    const t0 = Date.now();
    const out = { b: biz.id };
    try {
      const input = await loadLegacy(biz);
      const C = chartFor(input);
      input.accounts = {};
      for (const a of C.accounts) input.accounts[a.id] = { cls: chart.classOf(a.type), type: a.type };
      const vat = { enabled: biz.vatEnabled, rate: biz.vatRate, inclusive: biz.vatInclusive };
      out.rows = { sales: input.sales.length, expenses: input.expenses.length, bank: input.bankRows.length, invoices: input.invoices.length, debts: input.debts.length };

      const views = {};
      for (const basis of ["paid", "sold"]) {
        const L = ledger.buildLedger(input, { chart: C, basis, vat, baseCurrency: biz.baseCurrency || "NGN", recurring: new Map() });
        views[basis] = L;
        const unbalanced = ledger.unbalanced(L.entries).length;
        if (unbalanced) out[`${basis}Unbalanced`] = unbalanced;
        let parity = 0;
        for (const p of [{ from: "", to: "" }, ...months(12)]) {
          const pl = ledger.profitAndLoss(L.entries, C, p);
          const b = books.computeBooks(input, { ...p, basis, vat });
          if (K(pl.totalIncome) !== K(b.sales.total) || K(pl.totalExpenses) !== K(b.expenses.total)) parity++;
        }
        if (parity) out[`${basis}ParityOff`] = parity;
        if (!ledger.balanceSheet(L.entries, C, today).balanced) out[`${basis}SheetOff`] = true;
      }
      const sold = views.sold;
      const sums = ledger.sumByAccount(sold.entries, { to: today });
      const kb = sums.get(chart.sysAccount(C, chart.SYS.KASHBOOK).id) || 0;
      let raw = 0;
      for (const tx of input.bankRows) {
        if (!isLedgerBankRow(tx, biz.baseCurrency || "NGN")) continue;
        if (books.dayKey(tx.date) > today) continue;
        raw += tx.type === "income" ? K(tx.amount) : -(K(tx.amount) + K(tx.fee));
      }
      if (kb !== raw) out.bankOff = (kb - raw) / 100;
      const residue = sums.get(chart.sysAccount(C, chart.SYS.BANK_MATCH).id) || 0;
      if (residue) out.bankMatchingResidue = residue / 100;

      // What the release changes.
      const fees = input.bankRows.filter((t) => t.type === "expense" && !t.foreignCurrency).reduce((s, t) => s + K(t.fee), 0);
      if (fees) out.feesToCount = fees / 100;
      const foreign = [...input.sales, ...input.expenses, ...input.bankRows].filter((r) => r.foreignCurrency).length;
      if (foreign) out.foreignRows = foreign;
      const expenseIds = new Set(input.expenses.map((e) => e.id));
      const orphan = input.bankRows.filter((t) => t.matchedExpenseId && !expenseIds.has(t.matchedExpenseId));
      if (orphan.length) out.orphanDebits = { count: orphan.length, amount: orphan.reduce((s, t) => s + K(t.matchedAmount == null ? t.amount : t.matchedAmount), 0) / 100 };

      out.ms = Date.now() - t0;
      sum.balancedFail += out.paidUnbalanced || out.soldUnbalanced ? 1 : 0;
      sum.parityFail += out.paidParityOff || out.soldParityOff ? 1 : 0;
      sum.sheetFail += out.paidSheetOff || out.soldSheetOff ? 1 : 0;
      sum.bankFail += out.bankOff ? 1 : 0;
      sum.matchResidue += out.bankMatchingResidue ? 1 : 0;
      sum.feesAllTime += fees / 100;
      sum.feesBusinesses += fees ? 1 : 0;
      sum.foreignRows += foreign;
      sum.orphanDebits += orphan.length;
      sum.slowest = Math.max(sum.slowest, out.ms);
    } catch (e) {
      out.error = String(e.message || e).split("\n")[0].slice(0, 200);
      sum.errors++;
    }
    console.log(JSON.stringify(out));
    await sleep(150);
  }
  sum.feesAllTime = Math.round(sum.feesAllTime * 100) / 100;
  console.log("\nSUMMARY " + JSON.stringify(sum));
  await db.$disconnect();
  await pool.end();
  const bad = sum.balancedFail + sum.parityFail + sum.sheetFail + sum.bankFail + sum.errors;
  process.exit(bad ? 1 : 0);
})().catch(async (e) => {
  console.error(e);
  await pool.end().catch(() => {});
  process.exit(1);
});
