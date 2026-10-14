// Loads one business's records for a period and runs the books rule over them
// (utils/books.js). Every server total of sales, expenses or profit goes
// through booksFor, so the emails, Insights and the app agree.
const prisma = require("./db");
const { computeBooks, receivables, vatReturn, bookRows, dayKey } = require("./books");
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

// Records the rule needs. Invoices, debts and bills are loaded whole (with
// their payments) because a payment in the period can belong to an older
// document; they are few per business.
//
// Either Lagos days ({ from, to }, inclusive "YYYY-MM-DD") or exact instants
// ({ start, end } Dates, end exclusive). With instants the dated rows AND the
// payments are cut to [start, end), so a partial day ("the same point last
// week") is exact; pass the result to computeBooks without from/to. (A bill's
// payments kept outside the books stay: they count on no day, they only say
// how much of the bill the books carry. An invoice's or a debt's payments
// outside the span stay too, marked outsideSpan, and so does an invoice's
// write-off, marked writtenOffOutsideSpan: they count nowhere, but they say
// how much of the document was settled before the span, which decides the
// share of its goods' cost a payment inside it releases. A document issued
// on a day outside the span's Lagos days is marked issuedOutsideSpan: nothing
// counts on its issue date, such as the cost of goods on a document with
// nothing to collect.)
//
// Release 3 (stock cost): sales come with their lines, invoices' lines with
// what their goods cost, bills with their restock lines, and the stock
// movements the books and the ledger read (stockMoves: adjustments and new
// values, which count, and starting stock, which only the ledger posts).
async function loadBooksInput(businessId, { from, to, start, end } = {}, db = prisma) {
  const byInstant = start instanceof Date && end instanceof Date;
  const date = byInstant ? { gte: start, lt: end } : dateWhere(from, to);
  const biz = await db.business.findUnique({
    where: { id: businessId },
    select: { id: true, baseCurrency: true, vatEnabled: true, vatRate: true, vatInclusive: true },
  });
  if (!biz) return null;
  const [sales, expenses, bankRows, invoices, debts, accounts, bills, journals, stockMoves] = await Promise.all([
    db.sales.findMany({
      where: { businessId, ...(date ? { date } : {}) },
      // channel and customerId: Insights breaks sales down by them (bookRows
      // carries every field selected here). The rest is for the ledger.
      select: {
        id: true, amount: true, date: true, isCredit: true, channel: true, customerId: true,
        currency: true, paymentMethod: true, matchedTransactionId: true, accountId: true, depositAccountId: true,
        // notes: the memo its ledger entry shows on account statements.
        notes: true,
        // What was sold, line by line: the sale's income is shared over the
        // lines' accounts, and their goods' cost is its cost of goods sold.
        items: { select: SALE_LINE, orderBy: [{ position: "asc" }, { id: "asc" }] },
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
        matchedInvoiceId: true, matchedBillId: true, matchedAmount: true,
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
        // costAmount: what an issued invoice's goods cost (a restocked credit
        // note line's: what came back into stock).
        items: {
          select: { id: true, amount: true, accountId: true, itemId: true, itemType: true, costAmount: true, restock: true },
        },
        payments: {
          select: { id: true, amount: true, method: true, date: true, transactionId: true, depositAccountId: true },
        },
      },
    }),
    // This business's customers' debts. Every customer belongs to one business
    // (release 2): one that had none was given one (scripts/backfill-r2.js)
    // and the routes no longer make another, so a debt counts in its
    // customer's business only, as the app (which syncs one business's
    // customers) counts it.
    db.debt.findMany({
      where: { customer: { businessId } },
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
    // With aliasSlugs, so the chart read from this list (chart.indexChart)
    // finds a merged category's account as the ledger does.
    db.ledgerAccount.findMany({
      where: { businessId },
      select: { id: true, type: true, systemKey: true, categorySlug: true, aliasSlugs: true },
    }),
    // Bills (release 2), loaded whole like invoices: a payment in the period
    // can be towards an older bill. Every field the ledger reads (where the
    // money went or came from, the memo its entries show).
    db.businessDebt.findMany({
      where: { businessId },
      select: {
        id: true, name: true, billNumber: true, note: true, accountId: true, receivedViaAccountId: true,
        billDate: true, originalAmount: true, estimated: true,
        payments: {
          select: {
            id: true, amount: true, date: true, method: true, transactionId: true, outsideBooks: true,
            paidThroughAccountId: true, note: true,
          },
          orderBy: [{ date: "asc" }, { id: "asc" }],
        },
        // A restock's lines (a bill on Inventory Asset): the goods it brought
        // into stock, each at its amount.
        items: {
          select: { id: true, itemId: true, quantity: true, unitCost: true, amount: true },
          orderBy: [{ position: "asc" }, { id: "asc" }],
        },
      },
      orderBy: [{ billDate: "asc" }, { id: "asc" }],
    }),
    // Published manual journals dated in the period, with their lines (a
    // draft counts nowhere).
    db.manualJournal.findMany({
      where: { businessId, status: "published", ...(date ? { date } : {}) },
      select: {
        id: true, number: true, date: true, note: true, status: true,
        lines: {
          select: { id: true, accountId: true, debit: true, credit: true, description: true },
          orderBy: [{ position: "asc" }, { id: "asc" }],
        },
      },
      orderBy: [{ date: "asc" }, { id: "asc" }],
    }),
    // Stock movements dated in the period (release 3): adjustments and new
    // values count as stock adjustments; starting stock only the ledger
    // posts. A sale's, an invoice's or a restock's own movements are read
    // from those records' lines instead.
    db.stockMovement.findMany({
      where: { businessId, kind: { in: STOCK_MOVE_KINDS }, ...(date ? { date } : {}) },
      select: { id: true, kind: true, reason: true, date: true, quantity: true, value: true, itemId: true, note: true },
      orderBy: [{ date: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    }),
  ]);
  if (byInstant) {
    const within = (d) => d >= start && d < end;
    // A document's issue date is a day ("YYYY-MM-DD" text), not an instant:
    // it is in the span when it is one of the span's Lagos days.
    const firstDay = dayKey(start);
    const lastDay = dayKey(new Date(end.getTime() - 1));
    const dayWithin = (d) => {
      const k = dayKey(d);
      return !!k && k >= firstDay && k <= lastDay;
    };
    for (const inv of invoices) {
      for (const p of inv.payments) if (!within(p.date)) p.outsideSpan = true;
      if (!dayWithin(inv.issueDate)) inv.issuedOutsideSpan = true;
      if (inv.writtenOffAt && !within(inv.writtenOffAt)) inv.writtenOffOutsideSpan = true;
    }
    for (const d of debts) for (const p of d.payments) if (!within(p.date)) p.outsideSpan = true;
    for (const b of bills) b.payments = b.payments.filter((p) => p.outsideBooks || within(p.date));
  }
  // The naira books count naira: rows in another currency are flagged and the
  // books rule leaves them out (a €100 credit is not ₦100).
  const base = biz.baseCurrency || "NGN";
  for (const list of [sales, expenses, bankRows]) {
    for (const r of list) if (r.currency && r.currency !== base) r.foreignCurrency = true;
  }
  // A repayment can be for a credit sale from before the period, whose goods'
  // cost it releases "when paid" (books.stockCosts): such a debt carries that
  // sale (only what the rule reads of it) when the period's sales do not.
  const loaded = new Set(sales.map((s) => s.id));
  const older = [...new Set(debts.map((d) => d.saleId).filter((id) => id && !loaded.has(id)))];
  if (older.length) {
    const found = await db.sales.findMany({
      where: { id: { in: older }, businessId, items: { some: {} } },
      select: { id: true, date: true, isCredit: true, currency: true, items: { select: { id: true, costAmount: true } } },
    });
    const byId = new Map(found.map((s) => [s.id, s]));
    for (const s of found) if (s.currency && s.currency !== base) s.foreignCurrency = true;
    for (const d of debts) if (d.saleId && byId.has(d.saleId)) d.sale = byId.get(d.saleId);
  }
  return {
    vat: { enabled: biz.vatEnabled, rate: biz.vatRate, inclusive: biz.vatInclusive },
    baseCurrency: base,
    chart: accounts,
    input: {
      sales, expenses, bankRows, invoices, debts, accounts: accountClasses(accounts),
      bills: bills.map(billInput), journals, stockMoves,
    },
  };
}

// What the books read of a sale's line (release 3): its income account, its
// type, and what its goods cost; the item and name for anything that lists
// what was sold.
const SALE_LINE = {
  id: true, itemId: true, name: true, itemType: true, quantity: true, amount: true, accountId: true, costAmount: true,
};

// The stock movements the books input carries (books.stockMoves).
const STOCK_MOVE_KINDS = ["adjustment", "revalue", "opening", "opening_value"];

// A bill as the books rule reads it (books.js): the table keeps the payable's
// own names (name is the supplier, originalAmount the bill's amount). A
// restock's lines (release 3) come with it.
function billInput(b) {
  return {
    id: b.id, vendorName: b.name, billNumber: b.billNumber, note: b.note,
    accountId: b.accountId, receivedViaAccountId: b.receivedViaAccountId,
    billDate: b.billDate, amount: b.originalAmount, estimated: b.estimated, payments: b.payments,
    items: b.items || [],
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
// A debt is owed in its customer's business only (as loadBooksInput reads it).
async function receivablesFor(businessId, db = prisma) {
  const biz = await db.business.findUnique({ where: { id: businessId }, select: { id: true } });
  if (!biz) return null;
  const [invoices, debts] = await Promise.all([
    db.invoice.findMany({
      where: { businessId, type: { in: ["invoice", "credit_note"] } },
      select: { type: true, status: true, total: true, amountPaid: true, writtenOffAt: true },
    }),
    db.debt.findMany({
      where: { customer: { businessId }, paid: false },
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
  loadBooksInput, accountClasses, billInput, booksFor, booksForInstants, receivablesFor, vatReturnFor, lagosStart, lagosEnd,
  monthEnd,
};
