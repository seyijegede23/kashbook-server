// Loads one business's records for a period and runs the books rule over them
// (utils/books.js). Every server total of sales, expenses or profit goes
// through booksFor, so the emails, Insights and the app agree.
const prisma = require("./db");
const { computeBooks, receivables, vatReturn, bookRows } = require("./books");
const { classOf } = require("./chart");

// "YYYY-MM-DD" (Lagos) → the instant that day starts / ends.
function lagosStart(day) {
  return new Date(`${day}T00:00:00.000+01:00`);
}
function lagosEnd(day) {
  return new Date(`${day}T23:59:59.999+01:00`);
}

function dateWhere(from, to) {
  if (!from && !to) return undefined;
  const w = {};
  if (from) w.gte = lagosStart(from);
  if (to) w.lte = lagosEnd(to);
  return w;
}

// Records the rule needs. Invoices and debts are loaded whole (with their
// payments) because a payment in the period can belong to an older document;
// they are few per business.
//
// Either Lagos days ({ from, to }, inclusive "YYYY-MM-DD") or exact instants
// ({ start, end } Dates, end exclusive). With instants the dated rows AND the
// payments are cut to [start, end), so a partial day ("the same point last
// week") is exact; pass the result to computeBooks without from/to.
async function loadBooksInput(businessId, { from, to, start, end } = {}, db = prisma) {
  const byInstant = start instanceof Date && end instanceof Date;
  const date = byInstant ? { gte: start, lt: end } : dateWhere(from, to);
  const biz = await db.business.findUnique({
    where: { id: businessId },
    select: { id: true, userId: true, baseCurrency: true, vatEnabled: true, vatRate: true, vatInclusive: true },
  });
  if (!biz) return null;
  const [sales, expenses, bankRows, invoices, debts, accounts] = await Promise.all([
    db.sales.findMany({
      where: { businessId, ...(date ? { date } : {}) },
      // channel and customerId: Insights breaks sales down by them (bookRows
      // carries every field selected here). The rest is for the ledger.
      select: {
        id: true, amount: true, date: true, isCredit: true, channel: true, customerId: true,
        currency: true, paymentMethod: true, matchedTransactionId: true, accountId: true, depositAccountId: true,
        // notes: the memo its ledger entry shows on account statements.
        notes: true,
      },
    }),
    db.expense.findMany({
      where: { businessId, ...(date ? { date } : {}) },
      select: {
        id: true, amount: true, date: true, category: true,
        currency: true, paymentMethod: true, matchedTransactionId: true, accountId: true, paidThroughAccountId: true,
        // notes: the memo its ledger entries show on account statements (every
        // line's, when it is itemized).
        notes: true,
        // An itemized expense counts line by line, each by its own account.
        items: { select: { id: true, accountId: true, category: true, amount: true }, orderBy: { position: "asc" } },
      },
    }),
    db.transaction.findMany({
      where: { businessId, ...(date ? { date } : {}) },
      select: {
        id: true, type: true, amount: true, date: true, purpose: true, channel: true, customerId: true,
        matchedSaleId: true, matchedCustomerId: true, matchedExpenseId: true,
        matchedInvoiceId: true, matchedAmount: true,
        fee: true, accountId: true, currency: true, source: true, paymentMethod: true,
        category: true, reference: true, description: true,
      },
    }),
    db.invoice.findMany({
      where: { businessId },
      select: {
        id: true, type: true, status: true, issueDate: true, total: true, customerId: true,
        invoiceNumber: true, taxAmount: true, amountPaid: true, writtenOffAt: true, writtenOffAmount: true,
        subtotal: true, discountAmount: true,
        items: { select: { id: true, amount: true, accountId: true } },
        payments: {
          select: { id: true, amount: true, method: true, date: true, transactionId: true, depositAccountId: true },
        },
      },
    }),
    // This business's customers, and the owner's customers with no business
    // yet: the app shows those in every business, so the books do too.
    db.debt.findMany({
      where: { customer: { OR: [{ businessId }, { businessId: null, userId: biz.userId }] } },
      select: {
        id: true, customerId: true, amount: true, paidAmount: true, paid: true, date: true, saleId: true, note: true,
        payments: {
          // note: the repayment's memo on account statements (the debt's when it has none).
          select: {
            id: true, amount: true, date: true, transactionId: true, method: true, depositAccountId: true, note: true,
          },
        },
      },
    }),
    db.ledgerAccount.findMany({
      where: { businessId },
      select: { id: true, type: true, systemKey: true, categorySlug: true },
    }),
  ]);
  if (byInstant) {
    const within = (d) => d >= start && d < end;
    for (const inv of invoices) inv.payments = inv.payments.filter((p) => within(p.date));
    for (const d of debts) d.payments = d.payments.filter((p) => within(p.date));
  }
  // The naira books count naira: rows in another currency are flagged and the
  // books rule leaves them out (a €100 credit is not ₦100).
  const base = biz.baseCurrency || "NGN";
  for (const list of [sales, expenses, bankRows]) {
    for (const r of list) if (r.currency && r.currency !== base) r.foreignCurrency = true;
  }
  return {
    vat: { enabled: biz.vatEnabled, rate: biz.vatRate, inclusive: biz.vatInclusive },
    baseCurrency: base,
    chart: accounts,
    input: { sales, expenses, bankRows, invoices, debts, accounts: accountClasses(accounts) },
  };
}

// The chart as the books rule reads it: { [accountId]: { cls, type } }.
function accountClasses(accounts) {
  const out = {};
  for (const a of accounts || []) out[a.id] = { cls: classOf(a.type), type: a.type };
  return out;
}

// The "when paid" books and rows for an exact [start, end) span (Insights),
// with the input they came from (a breakdown tells bank rows apart by it).
async function booksForInstants(businessId, start, end, db = prisma) {
  const loaded = await loadBooksInput(businessId, { start, end }, db);
  if (!loaded) return null;
  return {
    books: computeBooks(loaded.input, { basis: "paid", vat: loaded.vat }),
    rows: bookRows(loaded.input, "paid"),
    input: loaded.input,
  };
}

async function booksFor(businessId, { from, to, basis = "paid" } = {}, db = prisma) {
  const loaded = await loadBooksInput(businessId, { from, to }, db);
  if (!loaded) return null;
  return computeBooks(loaded.input, { from, to, basis, vat: loaded.vat });
}

// Open balances right now: what customers owe and what is owed to them.
async function receivablesFor(businessId, db = prisma) {
  const biz = await db.business.findUnique({ where: { id: businessId }, select: { userId: true } });
  if (!biz) return null;
  const [invoices, debts] = await Promise.all([
    db.invoice.findMany({
      where: { businessId, type: { in: ["invoice", "credit_note"] } },
      select: { type: true, status: true, total: true, amountPaid: true, writtenOffAt: true },
    }),
    db.debt.findMany({
      where: { customer: { OR: [{ businessId }, { businessId: null, userId: biz.userId }] }, paid: false },
      select: { amount: true, paidAmount: true, paid: true },
    }),
  ]);
  return receivables({ invoices, debts });
}

function monthEnd(month) {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${month}-${String(last).padStart(2, "0")}`;
}

async function vatReturnFor(businessId, month, db = prisma) {
  const from = `${month}-01`;
  const to = monthEnd(month);
  const loaded = await loadBooksInput(businessId, { from, to }, db);
  if (!loaded) return null;
  return vatReturn(loaded.input, month, loaded.vat);
}

module.exports = {
  loadBooksInput, accountClasses, booksFor, booksForInstants, receivablesFor, vatReturnFor, lagosStart, lagosEnd, monthEnd,
};
