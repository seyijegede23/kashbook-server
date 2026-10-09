// Loads one business's records for a period and runs the books rule over them
// (utils/books.js). Every server total of sales, expenses or profit goes
// through booksFor, so the emails, Insights and the app agree.
const prisma = require("./db");
const { computeBooks, receivables, vatReturn, bookRows } = require("./books");

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
    select: { id: true, userId: true, vatEnabled: true, vatRate: true, vatInclusive: true },
  });
  if (!biz) return null;
  const [sales, expenses, bankRows, invoices, debts] = await Promise.all([
    db.sales.findMany({
      where: { businessId, ...(date ? { date } : {}) },
      // channel and customerId: Insights breaks sales down by them (bookRows
      // carries every field selected here).
      select: { id: true, amount: true, date: true, isCredit: true, channel: true, customerId: true },
    }),
    db.expense.findMany({
      where: { businessId, ...(date ? { date } : {}) },
      select: { id: true, amount: true, date: true, category: true },
    }),
    db.transaction.findMany({
      where: { businessId, ...(date ? { date } : {}) },
      select: {
        id: true, type: true, amount: true, date: true, purpose: true, channel: true, customerId: true,
        matchedSaleId: true, matchedCustomerId: true, matchedExpenseId: true,
        matchedInvoiceId: true, matchedAmount: true,
      },
    }),
    db.invoice.findMany({
      where: { businessId },
      select: {
        id: true, type: true, status: true, issueDate: true, total: true, customerId: true,
        invoiceNumber: true, taxAmount: true, amountPaid: true, writtenOffAt: true, writtenOffAmount: true,
        payments: { select: { id: true, amount: true, method: true, date: true, transactionId: true } },
      },
    }),
    // This business's customers, and the owner's customers with no business
    // yet: the app shows those in every business, so the books do too.
    db.debt.findMany({
      where: { customer: { OR: [{ businessId }, { businessId: null, userId: biz.userId }] } },
      select: {
        id: true, customerId: true, amount: true, paidAmount: true, paid: true, date: true, saleId: true, note: true,
        payments: { select: { id: true, amount: true, date: true, transactionId: true } },
      },
    }),
  ]);
  if (byInstant) {
    const within = (d) => d >= start && d < end;
    for (const inv of invoices) inv.payments = inv.payments.filter((p) => within(p.date));
    for (const d of debts) d.payments = d.payments.filter((p) => within(p.date));
  }
  return {
    vat: { enabled: biz.vatEnabled, rate: biz.vatRate, inclusive: biz.vatInclusive },
    input: { sales, expenses, bankRows, invoices, debts },
  };
}

// The "when paid" books and rows for an exact [start, end) span (Insights).
async function booksForInstants(businessId, start, end, db = prisma) {
  const loaded = await loadBooksInput(businessId, { start, end }, db);
  if (!loaded) return null;
  return {
    books: computeBooks(loaded.input, { basis: "paid", vat: loaded.vat }),
    rows: bookRows(loaded.input, "paid"),
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

module.exports = { loadBooksInput, booksFor, booksForInstants, receivablesFor, vatReturnFor, lagosStart, lagosEnd, monthEnd };
