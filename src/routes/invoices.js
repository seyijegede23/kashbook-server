const router = require("express").Router();
const prisma = require("../utils/db");
const authMiddleware = require("../middleware/auth");
const {
  allocateInvoiceNumber,
  formatInvoiceNumber,
  prefixOf,
  seriesOf,
  normalizePrefix,
  normalizeNextNumber,
  normalizeManualNumber,
  numberTaken,
} = require("../utils/invoiceNumber");
const { vatDeadline, round2 } = require("../utils/books");
const { sameMoney } = require("../utils/money");
const { isLedgerBankRow } = require("../config/moneySources");
const { audit } = require("../utils/audit");
const { recordLink } = require("../utils/paymentLinks");
const { PAYMENT_TERMS: PAYMENT_TERM_CODES } = require("../utils/paymentTerms");
const { snapshotFor } = require("../utils/customerFields");
const { assertAccountUsable, accountsFor } = require("../utils/ledgerData");
const { assertUnlocked, assertUnlockedIn } = require("../utils/booksLock");
const { assertNotDeposit } = require("../utils/cashDeposits");
const chart = require("../utils/chart");
const stock = require("../utils/stock");
const { publicItem } = require("../utils/items");

// The lock date (chart of accounts release 2, utils/booksLock.js): nothing
// dated on or before it is added, changed or removed. An invoice or a credit
// note is dated by its issueDate, drafts included, as Zoho Books locks every
// transaction; a payment, a refund, a write-off and an applied credit by
// their own day, and a payment linked to a bank transfer by the transfer's
// day too. A quote is in no books and takes no payments, so it is never
// locked; converting one makes an invoice dated its issueDate, which is. Each
// route asks under the business lock, which the lock date is set under.
const inBooks = (doc) => (doc && doc.type) !== "quote";

// Credit applied from a credit note settles both documents and counts
// nowhere in the books (utils/books.js), so its day is not one an edit of
// either document changes.
const SETTLEMENT_METHODS = ["credit_note", "credit_applied"];

// A document's issueDate is a calendar day kept as text, "YYYY-MM-DD" (the
// phone's own day: CreateInvoiceScreen sends nothing else). The books read
// that text by its first ten characters (books.dayKey), and so does the lock
// date (utils/booksLock.js), so only such a day is checked against the lock
// and stored: " 2026-10-13" or "+002026-10-13" would sit before every real
// day in the books, and "2026-13-01" in no year at all. Spaces around the day
// are dropped, as for a journal's date and the lock date itself
// (routes/journals.js readDay). A quote's date is read the same way, since
// converting it makes an invoice of that day. Returns the day, or null when
// the value is not a real day from 1900 to 2999.
const DAY = /^\d{4}-\d{2}-\d{2}$/;
function readIssueDay(v) {
  const day = typeof v === "string" ? v.trim() : "";
  const d = new Date(`${day}T00:00:00.000Z`);
  if (
    !DAY.test(day) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== day ||
    day < "1900-01-01" || day > "2999-12-31"
  ) {
    return null;
  }
  return day;
}
const BAD_ISSUE_DATE = { error: "That date isn't valid. Choose a day.", code: "BAD_DATE", field: "issueDate" };

// The chart of accounts (2026-10-11): each line may name the income account it
// counts as (null = Sales; Sales Returns on a credit note). Checked once per
// distinct account before the document is written. `kept` holds the accounts
// the document's lines name already (an edit): those are taken as they are,
// even one the owner has since made inactive, so the document still saves and
// the line keeps counting where it did. Only an account new to the document
// is checked.
async function checkLineAccounts(businessId, items, isStaff, kept = new Set()) {
  const ids = [...new Set((items || []).map((it) => it && it.accountId).filter(Boolean).map(String))];
  for (const id of ids) {
    if (kept.has(id)) continue;
    await assertAccountUsable(businessId, id, "income", { isStaff });
  }
}

// ── Release 3: lines for an item, and the goods they move ─────────────────────
// A line may name an item of this business (itemId), goods or a service; it
// keeps the item's type (itemType; a typed line is "other"). An issued
// invoice (any status but draft and void) takes each goods line's goods out
// of stock (utils/stock.js takeOut, one movement "inv:<lineId>") and the line
// keeps what they cost (unitCost, costAmount). An issued credit note puts back
// the goods of each goods line marked restock, at the item's average cost
// then (putIn; costAmount is the value that came back). Voiding, deleting or
// redrafting a document undoes its movements (removeBySource), and an edit of
// an issued one moves its lines again, in the one transaction that saves it,
// so a refusal (409 NOT_ENOUGH_STOCK, 409 STOCK_ALREADY_SOLD) leaves the
// document and the stock as they were. A quote moves nothing; converting one
// makes a draft. Every write runs under the business lock, which the stock
// writes of the sale and bill routes take too.
//
// A line with an item and no account of its own counts as the item's income
// account (chart.incomeForItem: the item's own, else Service Income for a
// service, else Sales, kept as null). A credit note's line with no account is
// Sales Returns, as before.
//
// Items like Zoho (2026-10-14): goods whose stock is not counted
// (trackInventory off) move no stock on any document and carry no cost; their
// line says so (tracked false, the item's own, fixed once a line names it).
// A credit note's line may put goods back (restock) only for counted goods
// (else 400 NOT_STOCKED) that are returnable (else 400 NOT_RETURNABLE).
const TX = { timeout: 20000 };

function lineError(status, code, message, extra) {
  return Object.assign(new Error(message), { status, code, extra });
}

// Whether a document's lines move stock in this status: an issued invoice
// (goods out) or an issued credit note (restocked goods back in).
function movesStock(doc) {
  const type = (doc && doc.type) || "invoice";
  return !!doc && doc.status !== "DRAFT" && doc.status !== "VOID" && (type === "invoice" || type === "credit_note");
}

// Putting goods back into stock from a credit note (a line marked restock)
// adds stock and lowers the cost of goods sold, so it is the owner's, or a
// member's the owner trusts with bills and stock bought (canManagePayables;
// owner's call, 2026-10-14). Anyone else may still issue the credit note,
// without restock.
//
// Whether a saved line moves stock in a document that moves stock: counted
// goods (an invoice's go out, a credit note's restocked ones come back).
const movingLine = (l, type) => !!l.itemId && l.itemType === "goods" && l.tracked !== false && (type !== "credit_note" || l.restock);
const canRestock = (req) => req.user.accountType !== "staff" || req.user.permissions?.canManagePayables === true;

// The quantity of a line in thousandths, as the stock engine counts it.
const milliOf = (q) => Math.round((Number(q) || 0) * 1000);

// The lines a create or an edit saves, read under the business lock. items:
// the lines as sent. An item must be this business's (404 ITEM_NOT_FOUND
// { itemId, line }); a goods line's quantity is one the stock engine takes,
// more than 0 with at most three decimals (400 BAD_QUANTITY { line }).
// A credit note's line marked restock must name counted goods (400
// NOT_STOCKED { itemId, field: "items", line }) that are returnable (400
// NOT_RETURNABLE, likewise). mayRestock: whether the caller may mark such a
// line restock (canRestock); without it the line is refused (403
// PERMISSION_DENIED { permission: "canManagePayables", field: "items",
// line }). Neither the returnable rule nor the permission refuses a restock
// line the document has already (the same item and quantity, as saved:
// `saved`), which an edit of other fields sends back as it was. A typed line
// marked restock puts nothing back.
async function readDocLines(businessId, items, docType, { mayRestock = true, saved = [] } = {}) {
  const isCredit = docType === "credit_note";
  const keptRestock = saved.filter((l) => l.restock && l.itemId).map((l) => ({ ...l, taken: false }));
  const ids = [...new Set(items.map((it) => it && it.itemId).filter(Boolean).map(String))];
  const found = ids.length
    ? await prisma.inventoryItem.findMany({
        where: { id: { in: ids }, businessId },
        select: { id: true, itemType: true, incomeAccountId: true, trackInventory: true, returnable: true },
      })
    : [];
  const byId = new Map(found.map((i) => [i.id, i]));
  let C = null;
  const out = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i] || {};
    const itemId = it.itemId ? String(it.itemId) : null;
    const item = itemId ? byId.get(itemId) : null;
    if (itemId && !item) throw lineError(404, "ITEM_NOT_FOUND", "That item isn't in this business.", { itemId, line: i });
    const quantity = Number(it.quantity) || 1;
    const rate = Number(it.rate) || 0;
    const goods = !!item && item.itemType === "goods";
    if (goods && !stock.validQuantity(quantity)) {
      throw lineError(400, "BAD_QUANTITY", "Enter a quantity more than 0, with at most three decimals.", { line: i, field: "quantity" });
    }
    let accountId = it.accountId ? String(it.accountId) : null;
    if (!accountId && item && !isCredit) {
      C = C || chart.indexChart(await prisma.ledgerAccount.findMany({ where: { businessId } }));
      const acc = chart.incomeForItem(C, item);
      accountId = acc && acc.systemKey !== chart.SYS.SALES ? acc.id : null;
    }
    const tracked = !goods || item.trackInventory !== false;
    const restock = isCredit && !!item && it.restock === true;
    if (restock) {
      if (!goods || !tracked) {
        throw lineError(400, "NOT_STOCKED", "This item's stock isn't counted, so it can't go back into stock.", { itemId: item.id, field: "items", line: i });
      }
      const same = keptRestock.find((l) => !l.taken && l.itemId === item.id && milliOf(l.quantity) === milliOf(quantity));
      if (same) same.taken = true;
      else if (!item.returnable) {
        throw lineError(400, "NOT_RETURNABLE", "This item isn't returnable, so it can't go back into stock.", { itemId: item.id, field: "items", line: i });
      } else if (!mayRestock) {
        throw lineError(403, "PERMISSION_DENIED", "Only the owner, or staff who manage bills, can put goods back into stock.", {
          permission: "canManagePayables", field: "items", line: i,
        });
      }
    }
    out.push({
      name: it.name,
      description: it.description || null,
      quantity,
      rate,
      amount: quantity * rate,
      accountId,
      itemId: item ? item.id : null,
      itemType: item ? item.itemType : "other",
      restock,
      tracked,
    });
  }
  return out;
}

// The day a document's goods move on: its issue day, kept at midnight UTC
// (the same day in Lagos), as a payment typed in for a day is kept.
function stockDay(doc) {
  const day = readIssueDay(doc.issueDate);
  if (!day) {
    throw lineError(400, "BAD_DATE", "This document's date isn't valid. Change it first.", { field: "issueDate" });
  }
  return new Date(`${day}T00:00:00.000Z`);
}

// Moves the goods of a document's saved lines (with their ids) and writes
// each line's cost. Returns the ids of the items it moved.
async function moveDocStock(px, doc, lines, createdById) {
  const type = doc.type || "invoice";
  const touched = new Set();
  const moving = lines.filter((l) => movingLine(l, type));
  if (!moving.length) return touched;
  const date = stockDay(doc);
  for (const line of moving) {
    const base = {
      businessId: doc.businessId, itemId: line.itemId, quantity: line.quantity, date,
      sourceKey: `inv:${line.id}`, createdById,
    };
    let moved;
    if (type === "invoice") {
      moved = await stock.takeOut(px, { ...base, kind: "invoice" });
    } else {
      // Back at the item's average cost, read under its row lock.
      await px.$queryRaw`SELECT "id" FROM "InventoryItem" WHERE "id" = ${line.itemId} FOR UPDATE`;
      const item = await px.inventoryItem.findUnique({ where: { id: line.itemId }, select: { avgCost: true } });
      moved = await stock.putIn(px, { ...base, kind: "credit_note", unitCost: item ? item.avgCost : null });
    }
    await px.invoiceItem.update({ where: { id: line.id }, data: { unitCost: moved.unitCost, costAmount: moved.costAmount } });
    touched.add(line.itemId);
  }
  return touched;
}

// Undoes what a document's lines moved (nothing found, nothing done) and
// clears their costs. Returns the ids of the items it moved.
async function releaseDocStock(px, doc) {
  const lines = await px.invoiceItem.findMany({ where: { invoiceId: doc.id }, select: { id: true } });
  if (!lines.length) return new Set();
  const { items } = await stock.removeBySource(px, doc.businessId, lines.map((l) => `inv:${l.id}`));
  await px.invoiceItem.updateMany({
    where: { invoiceId: doc.id, OR: [{ costAmount: { not: 0 } }, { unitCost: { not: null } }] },
    data: { unitCost: null, costAmount: 0 },
  });
  return new Set(items.map((i) => i.id));
}

// The items a write moved, as they are now.
async function itemRows(px, ids) {
  const list = [...ids];
  return list.length ? px.inventoryItem.findMany({ where: { id: { in: list } } }) : [];
}

// Whether the caller may see what goods cost: the owner, or staff with the
// reports (canViewReports), as wherever costs are shown.
const seesCosts = (req) => !!req && (req.user.accountType !== "staff" || req.user.permissions?.canViewReports === true);

// An item a write moved, as its reply carries it (the app replaces its copy),
// as routes/inventory.js shows it (utils/items.js publicItem): the row
// without the old cost column, and what the stock cost and the purchase
// information only for those who may see costs.
const stockRow = (req, item) => publicItem(item, seesCosts(req));
const stockRows = (req, items) => (items || []).map((i) => stockRow(req, i));

// A document's lines as they are saved now (an edit), with the account each
// one counts as. Those accounts are the `kept` of checkLineAccounts.
// Release 3: with what each line moved (its item, quantity, restock and cost),
// so an edit can keep the stock movements of the lines it leaves as they were.
async function savedLinesOf(invoiceId) {
  return prisma.invoiceItem.findMany({
    where: { invoiceId },
    select: {
      id: true, name: true, accountId: true, itemId: true, itemType: true, quantity: true, restock: true,
      unitCost: true, costAmount: true, tracked: true,
    },
  });
}

// An older app version (from before the chart of accounts) sends its lines
// with no `accountId` key at all, while the app now sends one on every line,
// null for Sales (AppContext withLineAccounts). Written as sent, that older
// edit would put every line back on Sales (Sales Returns on a credit note).
// So an edit whose lines carry no key leaves each line counting where it did:
// a line takes the account of the saved line with the same name, the first
// one not taken yet, so lines that share a name keep theirs in order. Lines
// are matched by name only, since that app can remove a line (the rest move
// up) or change a price. A line it added or renamed counts as Sales, the only
// choice that app had. Only an `accountId` sent as null moves a line back.
function keepLineAccounts(items, saved) {
  const hasKey = (it) => it && typeof it === "object" && "accountId" in it;
  if (!Array.isArray(items) || items.some(hasKey)) return items;
  const key = (name) => String(name ?? "").trim().toLowerCase();
  const pool = saved.map((l) => ({ key: key(l.name), accountId: l.accountId, taken: false }));
  return items.map((it) => {
    const same = it && pool.find((l) => !l.taken && l.key === key(it.name));
    if (!same) return it;
    same.taken = true;
    return { ...it, accountId: same.accountId };
  });
}

// Money that enters or leaves the books through an invoice leaves a trail:
// who recorded, undid or wrote off what. Fire and forget, like the bank routes.
function logMoney(req, action, invoiceId, metadata) {
  audit({ req, action, resourceType: "invoice", resourceId: invoiceId, metadata }).catch(() => {});
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const PAYMENT_TERMS = new Set(PAYMENT_TERM_CODES);

function cleanText(v, max) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}

// The invoice's customer. A customerId must belong to this owner. With no id,
// or an id the server has not seen yet (a customer the app created a moment
// ago, still in flight), a typed name finds that owner's customer of the same
// name in this business or creates one. Invoice has no name column of its own,
// so before this a hand-typed customer vanished from the invoice on next sync.
async function resolveCustomerId(body, businessId, ownerUserId) {
  const id = body.customerId ? String(body.customerId) : null;
  if (id) {
    const own = await prisma.customer.findFirst({ where: { id, userId: ownerUserId }, select: { id: true } });
    if (own) return own.id;
  }
  const name = typeof body.customerName === "string" ? body.customerName.trim().slice(0, 100) : "";
  if (!name) return null;
  const same = await prisma.customer.findFirst({
    where: { userId: ownerUserId, businessId, name: { equals: name, mode: "insensitive" } },
    select: { id: true },
  });
  if (same) return same.id;
  const created = await prisma.customer.create({
    data: { userId: ownerUserId, businessId, name },
    select: { id: true },
  });
  return created.id;
}

// Numbering responses use the invoice field names for either run of numbers,
// so the app reads one shape; `kind` says which run it was.
function numberingOut(row, series) {
  return {
    invoicePrefix: row[series.prefix] ?? null,
    invoiceCounter: row[series.counter],
    invoiceNumberMode: row[series.mode] === "manual" ? "manual" : "auto",
  };
}

// The optional detail fields from the Add Invoice screen. Only keys present in
// the body come back, so an update that leaves them out does not wipe them.
async function readDetailFields(body, targetUserId) {
  const out = {};
  if ("paymentTerms" in body) {
    out.paymentTerms = PAYMENT_TERMS.has(body.paymentTerms) ? body.paymentTerms : null;
  }
  if ("orderNumber" in body) out.orderNumber = cleanText(body.orderNumber, 50);
  if ("subject" in body) out.subject = cleanText(body.subject, 250);
  // The tax authority's reference for this invoice (NRS e-invoicing IRN).
  if ("irn" in body) out.irn = cleanText(body.irn, 80);
  if ("salespersonId" in body) {
    out.salespersonId = null;
    out.salespersonName = null;
    const id = body.salespersonId ? String(body.salespersonId) : null;
    if (id) {
      // The owner or one of the owner's staff, nobody else. An unknown id is
      // dropped rather than refused: the app saves invoices optimistically, and
      // failing the whole invoice over a stale staff pick would lose it.
      const person = await prisma.user.findFirst({
        where: { id, OR: [{ id: targetUserId }, { employerId: targetUserId }] },
        select: { id: true, firstName: true, lastName: true },
      });
      if (person) {
        out.salespersonId = person.id;
        out.salespersonName = `${person.firstName || ""} ${person.lastName || ""}`.trim() || null;
      }
    }
  }
  return out;
}

// Document totals. The discount comes off before tax: VAT is charged on what
// the customer actually pays (mirrored in CreateInvoiceScreen).
function invoiceTotals({ items = [], taxRate = 0, discountType, discountValue = 0 }) {
  const subtotal = items.reduce((sum, it) => sum + (Number(it.quantity) || 1) * (Number(it.rate) || 0), 0);
  let discountAmount = 0;
  if (discountType === "percent") {
    discountAmount = subtotal * ((Number(discountValue) || 0) / 100);
  } else if (discountType === "fixed") {
    discountAmount = Number(discountValue) || 0;
  }
  discountAmount = Math.min(Math.max(0, discountAmount), subtotal);
  const taxAmount = round2((subtotal - discountAmount) * ((Number(taxRate) || 0) / 100));
  const total = round2(Math.max(0, subtotal - discountAmount + taxAmount));
  return { subtotal: round2(subtotal), discountAmount: round2(discountAmount), taxAmount, total };
}

const VAT_AUTO_NUMBERING = {
  error: "VAT invoices are numbered in sequence automatically.",
  code: "VAT_AUTO_NUMBERING",
};

// Bank rows are behind the canViewBalance capability for staff (owners always
// have it). Linking or freeing a bank row from an invoice is reading and
// changing the bank ledger, so it needs the same capability.
function canUseBank(req) {
  return req.user.accountType !== "staff" || req.user.permissions?.canViewBalance === true;
}
const BANK_DENIED = {
  error: "You don't have access to the bank account. Ask the business owner to link this transfer.",
  code: "PERMISSION_DENIED",
  permission: "canViewBalance",
};
// Taking a counted payment or refund back out of the books, and giving up on
// what a customer owes, are the owner's calls (staff cannot delete sales).
const OWNER_ONLY = { error: "Only the business owner can do this.", code: "OWNER_ONLY" };

function getTargetUserId(req) {
  return req.user.accountType === "staff" ? req.user.employerId : req.user.id;
}

async function ownsBusiness(req, businessId) {
  const userId = getTargetUserId(req);
  return prisma.business.findFirst({ where: { id: businessId, userId } });
}

// VAT-registered businesses may void an issued document only until that
// month's return is due (the 21st of the next month); after that the
// correction is a credit note, which reduces VAT in its own month.
function vatPeriodOpen(issueDate) {
  const month = String(issueDate || "").slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(month)) return true;
  const today = new Date(Date.now() + 60 * 60 * 1000).toISOString().slice(0, 10);
  return today < vatDeadline(month);
}

function calcStatus(invoice) {
  const { amountPaid, total, dueDate, status } = invoice;
  if (status === "VOID") return "VOID";
  if (amountPaid >= total && total > 0) return "PAID";
  if (amountPaid > 0) {
    if (dueDate && new Date(dueDate) < new Date()) return "OVERDUE";
    return "PARTIAL";
  }
  if (dueDate && new Date(dueDate) < new Date() && status !== "DRAFT") return "OVERDUE";
  return status;
}

// req: the caller, for what goods cost (a line's unitCost and costAmount go
// only to those who may see costs; anyone else gets null and 0).
function formatInvoice(inv, req) {
  const costs = seesCosts(req);
  return {
    ...inv,
    status: inv.status,
    items: (inv.items || []).map((it) => (costs ? it : { ...it, unitCost: null, costAmount: 0 })),
    payments: inv.payments || [],
    customer: inv.customer
      ? { id: inv.customer.id, name: inv.customer.name, phone: inv.customer.phone }
      : null,
  };
}

const INCLUDE = {
  items: true,
  payments: { orderBy: { date: "asc" } },
  customer: { select: { id: true, name: true, phone: true } },
};

// ── GET /invoices ─────────────────────────────────────────────────────────────
router.get("/", authMiddleware, async (req, res) => {
  try {
    const { businessId, status, type, dateFrom, dateTo, since } = req.query;
    if (!businessId) return res.status(400).json({ error: "businessId required" });
    if (!(await ownsBusiness(req, businessId)))
      return res.status(403).json({ error: "Access denied" });

    // Coerce + validate any date input before it reaches Prisma.
    const toDate = (v, label) => {
      const d = new Date(v);
      if (isNaN(d.getTime())) {
        const e = new Error(`Invalid ${label}`);
        e.status = 400;
        throw e;
      }
      return d;
    };
    // issueDate is a "YYYY-MM-DD" text column, compared as text: its bounds
    // must be plain days (a Date there was a 500).
    const toDay = (v, label) => {
      if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
        const e = new Error(`Invalid ${label}`);
        e.status = 400;
        throw e;
      }
      return v;
    };

    const where = { businessId };
    if (since) {
      where.updatedAt = { gt: toDate(since, "since") };
    } else {
      if (status) where.status = status.toUpperCase();
      if (type) where.type = type; // "invoice" | "quote"
      if (dateFrom || dateTo) {
        where.issueDate = {};
        if (dateFrom) where.issueDate.gte = toDay(dateFrom, "dateFrom");
        if (dateTo) where.issueDate.lte = toDay(dateTo, "dateTo");
      }
    }

    const invoices = await prisma.invoice.findMany({
      where,
      include: INCLUDE,
      orderBy: since ? { updatedAt: "asc" } : { createdAt: "desc" },
    });

    // Recalculate overdue status on the fly. dueDate is a Lagos wall-calendar
    // "YYYY-MM-DD" string — compare against the Lagos date, not UTC (they
    // differ between 00:00 and 01:00 WAT).
    const now = new Date(Date.now() + 60 * 60 * 1000).toISOString().slice(0, 10);
    const result = invoices.map((inv) => {
      if (
        inv.status !== "PAID" &&
        inv.status !== "VOID" &&
        inv.dueDate &&
        inv.dueDate < now
      ) {
        return { ...formatInvoice(inv, req), status: "OVERDUE" };
      }
      return formatInvoice(inv, req);
    });

    res.json(result);
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Failed to fetch invoices" });
  }
});

// ── POST /invoices ────────────────────────────────────────────────────────────
router.post("/", authMiddleware, async (req, res) => {
  try {
    const userId = getTargetUserId(req);
    const {
      businessId,
      customerId,
      issueDate,
      dueDate,
      items = [],
      taxRate = 0,
      discountType,
      discountValue = 0,
      notes,
      terms,
      template = "classic",
      status = "DRAFT",
      type = "invoice",
    } = req.body;

    if (!businessId) return res.status(400).json({ error: "businessId required" });
    if (!issueDate) return res.status(400).json({ error: "issueDate required" });
    // The day as the books and the lock date will read it (readIssueDay):
    // checked against the lock and stored as this, never as sent.
    const issueDay = readIssueDay(issueDate);
    if (!issueDay) return res.status(400).json(BAD_ISSUE_DATE);
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: "At least one line item required" });

    const biz = await ownsBusiness(req, businessId);
    if (!biz) return res.status(403).json({ error: "Access denied" });

    // A number the owner typed ("manually each time" or "only for this
    // invoice"). Nothing typed means the server numbers it, whatever the
    // business's mode: an older app that never sends one must still work.
    const manualNumber = normalizeManualNumber(req.body.invoiceNumber);
    if (manualNumber === null) {
      return res.status(400).json({
        error: "Use up to 30 letters, numbers, spaces or - _ / . # for the invoice number.",
        code: "BAD_INVOICE_NUMBER",
      });
    }

    // invoice | quote | credit_note. A credit note is a credit TO the customer:
    // no payment terms and no due date.
    const docType = type === "quote" || type === "credit_note" ? type : "invoice";
    const isCredit = docType === "credit_note";
    if (manualNumber && biz.vatEnabled && docType !== "quote") {
      return res.status(409).json(VAT_AUTO_NUMBERING);
    }

    const details = await readDetailFields(req.body, userId);
    const resolvedCustomerId = await resolveCustomerId(req.body, businessId, userId);
    if (isCredit) details.paymentTerms = null;
    // The customer's addresses and TIN as they are now, kept on the document.
    const snapshot = await snapshotFor(prisma, resolvedCustomerId);

    const { subtotal, taxAmount, discountAmount, total } = invoiceTotals({ items, taxRate, discountType, discountValue });

    // Choosing the number and writing the invoice happen under the business
    // lock, the same one the recurring runner and Instagram orders hold while
    // they number theirs, so a typed number and an automatic one can never land
    // on the same value. An account merge or delete takes it too
    // (routes/ledger.js), so every account a line names is checked under it and
    // is still there when the invoice is written. The number, the document and
    // the goods it takes out of stock are written in one transaction: a
    // refusal (NOT_ENOUGH_STOCK) leaves no document and uses no number.
    // A chart missing an account a later release added (Service Income) gets
    // it first, outside the lock, as accountsFor takes a lock of its own.
    if (!isCredit && items.some((it) => it && it.itemId)) await accountsFor(businessId);
    const result = await prisma.withBusinessLock(businessId, async () => {
      if (docType !== "quote") await assertUnlocked(businessId, issueDay);
      await checkLineAccounts(businessId, items, req.user.accountType === "staff");
      const lines = await readDocLines(businessId, items, docType, { mayRestock: canRestock(req) });
      if (manualNumber && (await numberTaken(prisma, businessId, manualNumber))) {
        throw Object.assign(new Error(`${manualNumber} is already used.`), {
          status: 409, code: "NUMBER_IN_USE", number: manualNumber,
        });
      }
      return prisma.$transaction(async (px) => {
        const invoiceNumber = manualNumber || (await allocateInvoiceNumber(px, businessId, docType));
        const created = await px.invoice.create({
          data: {
            businessId,
            customerId: resolvedCustomerId,
            userId,
            invoiceNumber,
            type: docType,
            // A new document is a draft or sent. PAID and the rest come from
            // payments, never from the create body.
            status: String(status).toUpperCase() === "SENT" ? "SENT" : "DRAFT",
            issueDate: issueDay,
            dueDate: isCredit ? null : dueDate || null,
            subtotal,
            taxRate: Number(taxRate) || 0,
            taxAmount,
            discountType: discountType || null,
            discountValue: Number(discountValue) || 0,
            discountAmount,
            total,
            notes: notes || null,
            terms: terms || null,
            template,
            ...details,
            ...snapshot,
            items: { create: lines },
          },
          include: { items: true },
        });
        const touched = movesStock(created) ? await moveDocStock(px, created, created.items, req.user.id) : new Set();
        return {
          invoice: await px.invoice.findUnique({ where: { id: created.id }, include: INCLUDE }),
          inventory: await itemRows(px, touched),
        };
      }, TX);
    });

    res.status(201).json({ ...formatInvoice(result.invoice, req), inventory: stockRows(req, result.inventory) });
  } catch (err) {
    if (err.status && err.code) {
      return res.status(err.status).json({ error: err.message, code: err.code, number: err.number, ...(err.extra || {}) });
    }
    console.error(err);
    res.status(500).json({ error: "Failed to create invoice" });
  }
});

// ── PATCH /invoices/numbering ─────────────────────────────────────────────────
// The gear beside Invoice# on the Add Invoice screen. Owner only: the prefix
// and the next number apply to every invoice the business issues from now on.
router.patch("/numbering", authMiddleware, async (req, res) => {
  try {
    if (req.user.accountType === "staff") {
      return res.status(403).json({ error: "Only the owner can change invoice numbering.", code: "OWNER_ONLY" });
    }
    const body = req.body || {};
    if (!body.businessId) return res.status(400).json({ error: "businessId required" });
    const biz = await ownsBusiness(req, body.businessId);
    if (!biz) return res.status(403).json({ error: "Access denied" });

    // Which run of numbers: invoices (shared with quotes) or credit notes.
    const kind = body.kind === "credit_note" ? "credit_note" : "invoice";
    const series = seriesOf(kind);

    // auto: the server issues the next number (prefix + counter).
    // manual: the app asks for a number on every new document. The prefix and
    // counter are kept so switching back to auto carries on where it was.
    const mode = body.mode === undefined ? (biz[series.mode] === "manual" ? "manual" : "auto") : body.mode;
    if (mode !== "auto" && mode !== "manual") {
      return res.status(400).json({ error: "Numbering is auto or manual.", code: "BAD_MODE" });
    }
    if (mode === "manual") {
      if (biz.vatEnabled) return res.status(409).json(VAT_AUTO_NUMBERING);
      const updated = await prisma.business.update({
        where: { id: biz.id },
        data: { [series.mode]: "manual" },
        select: { [series.prefix]: true, [series.counter]: true, [series.mode]: true },
      });
      return res.json({ ...numberingOut(updated, series), kind, next: null });
    }

    const prefix = body.prefix === undefined ? prefixOf(biz, kind) : normalizePrefix(body.prefix, kind);
    if (prefix === null) {
      return res.status(400).json({
        error: "Use up to 10 letters, numbers or - _ / . # for the prefix.",
        code: "BAD_PREFIX",
      });
    }
    const next = body.nextNumber === undefined ? biz[series.counter] + 1 : normalizeNextNumber(body.nextNumber);
    if (next === null) {
      return res.status(400).json({ error: "The next number must be a whole number from 1.", code: "BAD_NUMBER" });
    }

    // Refuse a starting point that is already taken, so the owner hears about
    // it now instead of the allocator silently skipping ahead later. Under the
    // business lock, like every other read-then-write of the counter.
    const number = formatInvoiceNumber(prefix, next);
    const result = await prisma.withBusinessLock(biz.id, async () => {
      if (await numberTaken(prisma, biz.id, number)) return null;
      return prisma.business.update({
        where: { id: biz.id },
        data: { [series.prefix]: prefix, [series.counter]: next - 1, [series.mode]: "auto" },
        select: { [series.prefix]: true, [series.counter]: true, [series.mode]: true },
      });
    });
    if (!result) {
      return res.status(409).json({ error: `${number} is already used.`, code: "NUMBER_IN_USE", number });
    }
    res.json({ ...numberingOut(result, series), kind, next: number });
  } catch (err) {
    console.error("invoice numbering error:", err);
    res.status(500).json({ error: "Failed to update invoice numbering" });
  }
});

// ── GET /invoices/:id ─────────────────────────────────────────────────────────
router.get("/:id", authMiddleware, async (req, res) => {
  try {
    const invoice = await prisma.invoice.findUnique({
      where: { id: req.params.id },
      include: INCLUDE,
    });
    if (!invoice) return res.status(404).json({ error: "Invoice not found" });
    if (!(await ownsBusiness(req, invoice.businessId)))
      return res.status(403).json({ error: "Access denied" });
    res.json(formatInvoice(invoice, req));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch invoice" });
  }
});

// ── PUT /invoices/:id ─────────────────────────────────────────────────────────
router.put("/:id", authMiddleware, async (req, res) => {
  try {
    const existing = await prisma.invoice.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: "Invoice not found" });
    if (!(await ownsBusiness(req, existing.businessId)))
      return res.status(403).json({ error: "Access denied" });
    if (existing.status === "VOID" || existing.status === "PAID")
      return res.status(400).json({ error: "Cannot edit a PAID or VOID invoice" });
    if (existing.writtenOffAt) {
      return res.status(409).json({ error: "This invoice was written off. Undo the write-off first.", code: "WRITTEN_OFF" });
    }
    if (existing.type !== "quote" && existing.status !== "DRAFT") {
      const owner = await prisma.business.findUnique({ where: { id: existing.businessId }, select: { vatEnabled: true } });
      // An issued VAT document is in a return: it is corrected with a credit
      // note, never edited (its date or amounts would move VAT between months).
      if (owner?.vatEnabled) {
        return res.status(409).json({ error: "Correct an issued VAT invoice with a credit note.", code: "VAT_ISSUED_LOCKED" });
      }
    }

    const {
      customerId,
      issueDate,
      dueDate,
      items = [],
      taxRate = 0,
      discountType,
      discountValue = 0,
      notes,
      terms,
      template,
    } = req.body;

    // A new issue date must be a real day (readIssueDay); none (or null, or
    // "") keeps the saved one. The lock is asked about, and the document
    // saved with, exactly this day.
    const newIssueDay = issueDate ? readIssueDay(issueDate) : null;
    if (issueDate && !newIssueDay) return res.status(400).json(BAD_ISSUE_DATE);
    if (!Array.isArray(items)) return res.status(400).json({ error: "items must be a list" });

    const { subtotal, taxAmount, discountAmount, total } = invoiceTotals({ items, taxRate, discountType, discountValue });

    // A credit note cannot shrink below the credit already used from it, nor
    // an invoice below what has been paid on it.
    const isCredit = existing.type === "credit_note";
    if (isCredit && total + 0.005 < (existing.amountPaid || 0)) {
      return res.status(400).json({
        error: "This credit note has credit in use; its total cannot go below that.",
        code: "CREDIT_BELOW_USED",
        used: existing.amountPaid,
      });
    }
    if (!isCredit && total + 0.005 < (existing.amountPaid || 0)) {
      return res.status(400).json({
        error: "Payments on this invoice are more than that total.",
        code: "TOTAL_BELOW_PAID",
        paid: existing.amountPaid,
      });
    }

    const details = await readDetailFields(req.body, getTargetUserId(req));
    if (isCredit && "paymentTerms" in details) details.paymentTerms = null;
    const resolvedCustomerId = await resolveCustomerId(req.body, existing.businessId, getTargetUserId(req));
    // Saving the document again takes the customer's addresses and TIN as they
    // are now (an issued VAT document never gets here: it is locked above).
    const snapshot = await snapshotFor(prisma, resolvedCustomerId);

    // "Save and send" from the editor moves a draft to SENT (decided under the
    // lock, on the status read there). Nothing else can change status here:
    // payments and voiding have their own routes.
    const sendNow = typeof req.body.status === "string" && req.body.status.toUpperCase() === "SENT";

    // A draft's number can be corrected (a typed number with a typo). Once
    // the invoice has gone out, its number is fixed.
    let newNumber = null;
    if ("invoiceNumber" in req.body) {
      const n = normalizeManualNumber(req.body.invoiceNumber);
      if (n === null) {
        return res.status(400).json({
          error: "Use up to 30 letters, numbers, spaces or - _ / . # for the invoice number.",
          code: "BAD_INVOICE_NUMBER",
        });
      }
      if (n && n !== existing.invoiceNumber) {
        if (existing.status !== "DRAFT") {
          return res.status(400).json({ error: "Only a draft's number can be changed.", code: "NUMBER_LOCKED" });
        }
        const owner = await prisma.business.findUnique({ where: { id: existing.businessId }, select: { vatEnabled: true } });
        if (owner?.vatEnabled && existing.type !== "quote") return res.status(409).json(VAT_AUTO_NUMBERING);
        newNumber = n;
      }
    }

    // Checked and written under the business lock. A create numbers under it,
    // and an account merge or delete takes it too (routes/ledger.js), so a new
    // number is still free and every account a line names is still there when
    // the lines are written. The saved lines are read under it as well: they
    // say which accounts the document has already, and what stock each moved.
    // The lines are replaced after every check, in one transaction, so a
    // refusal or a failed write leaves the old ones.
    //
    // That transaction keeps the stock in step (release 3). A goods line the
    // edit leaves as it was (the same item and quantity, and on a credit note
    // still marked restock) keeps the movement it has and its cost: the
    // movement moves to the new line, and to the document's new day when the
    // day changed. The phone sends every line back on any edit, so an edit of
    // the notes never costs the goods again at today's average. Only lines
    // that changed move stock again: an invoice's leftover goods go back
    // first, so a new line can take them again; a credit note's leftover
    // returns come out last, after its new lines put theirs back, so goods
    // sold since do not stop an edit that returns as many. An edit that sends
    // a draft moves every line.
    const savedType = existing.type === "quote" || existing.type === "credit_note" ? existing.type : "invoice";
    if (savedType !== "credit_note" && items.some((it) => it && it.itemId)) await accountsFor(existing.businessId);
    const result = await prisma.withBusinessLock(existing.businessId, async () => {
      const cur = await prisma.invoice.findUnique({
        where: { id: existing.id },
        select: { id: true, businessId: true, type: true, status: true, issueDate: true },
      });
      if (!cur) throw Object.assign(new Error("Invoice not found"), { status: 404, code: "INVOICE_NOT_FOUND" });
      if (cur.status === "VOID" || cur.status === "PAID") {
        throw lineError(400, "INVOICE_CLOSED", "Cannot edit a PAID or VOID invoice");
      }
      const credit = (cur.type || "invoice") === "credit_note";
      // Lines whose goods move stock on this document.
      const moving = (l) => movingLine(l, credit ? "credit_note" : "invoice");
      const saved = await savedLinesOf(existing.id);
      // The lock date: the document's day before and after the edit, and
      // every payment's or refund's day, whose VAT share and accounts follow
      // the document's lines and totals. Credit applied counts nowhere in the
      // money, but on a document with goods it releases their cost ("when
      // paid"), so its days count too when the document has goods lines before
      // or after the edit. Read again under the lock.
      if (inBooks(cur)) {
        const withGoods = saved.some(moving) || items.some((it) => it && it.itemId);
        const paid = await prisma.invoicePayment.findMany({
          where: { invoiceId: existing.id, ...(withGoods ? {} : { method: { notIn: SETTLEMENT_METHODS } }) },
          select: { date: true },
        });
        await assertUnlocked(existing.businessId, cur.issueDate, newIssueDay, paid.map((p) => p.date));
      }
      const sent = keepLineAccounts(items, saved);
      const kept = new Set(saved.map((l) => l.accountId).filter(Boolean));
      await checkLineAccounts(existing.businessId, sent, req.user.accountType === "staff", kept);
      const lines = await readDocLines(existing.businessId, sent, cur.type || "invoice", { mayRestock: canRestock(req), saved });
      if (newNumber && (await numberTaken(prisma, existing.businessId, newNumber, existing.id))) {
        throw Object.assign(new Error(`${newNumber} is already used.`), {
          status: 409, code: "NUMBER_IN_USE", number: newNumber,
        });
      }
      // "Save and send" moves only a draft, as it is now.
      const statusPatch = sendNow && cur.status === "DRAFT" ? { status: "SENT" } : {};

      return prisma.$transaction(async (px) => {
        const before = movesStock(cur);
        const after = movesStock({ ...cur, ...statusPatch });
        // The new day, or else the one read under the lock above, which the
        // lock date was checked against (the copy read before the lock may
        // be stale).
        const day = newIssueDay || cur.issueDate;
        const touched = new Set();
        const add = (ids) => ids.forEach((id) => touched.add(id));

        // The saved line each new line keeps the movement of, if any.
        const pool = before ? saved.filter(moving).map((l) => ({ ...l, taken: false })) : [];
        const keeps = lines.map((l) => {
          if (!after || !moving(l)) return null;
          const same = pool.find((o) => !o.taken && o.itemId === l.itemId && milliOf(o.quantity) === milliOf(l.quantity));
          if (same) same.taken = true;
          return same || null;
        });
        const leftover = pool.filter((o) => !o.taken).map((o) => `inv:${o.id}`);
        if (leftover.length && !credit) add((await stock.removeBySource(px, cur.businessId, leftover)).items.map((i) => i.id));

        // Replace all items, one at a time, so each new line's id is known.
        await px.invoiceItem.deleteMany({ where: { invoiceId: cur.id } });
        await px.invoice.update({
          where: { id: cur.id },
          data: {
            ...details,
            ...statusPatch,
            ...(newNumber ? { invoiceNumber: newNumber } : {}),
            customerId: resolvedCustomerId,
            ...snapshot,
            issueDate: day,
            dueDate: isCredit ? null : dueDate || null,
            subtotal,
            taxRate: Number(taxRate) || 0,
            taxAmount,
            discountType: discountType || null,
            discountValue: Number(discountValue) || 0,
            discountAmount,
            total,
            notes: notes || null,
            terms: terms || null,
            template: template || existing.template,
          },
        });
        const rows = [];
        for (const l of lines) rows.push(await px.invoiceItem.create({ data: { ...l, invoiceId: cur.id } }));

        // A kept movement follows its new line (and the document's day), and
        // the line keeps the cost it had; the other moving lines move now.
        const fresh = [];
        let date = null;
        for (let i = 0; i < rows.length; i++) {
          const old = keeps[i];
          if (!old) {
            if (after && moving(rows[i])) fresh.push(rows[i]);
            continue;
          }
          date = date || stockDay({ issueDate: day });
          const m = await px.stockMovement.findUnique({
            where: { businessId_sourceKey: { businessId: cur.businessId, sourceKey: `inv:${old.id}` } },
          });
          if (!m || m.itemId !== rows[i].itemId) {
            fresh.push(rows[i]);
            continue;
          }
          await px.stockMovement.update({ where: { id: m.id }, data: { sourceKey: `inv:${rows[i].id}`, date } });
          await px.invoiceItem.update({
            where: { id: rows[i].id },
            data: { unitCost: old.unitCost, costAmount: Math.abs(Math.round(m.value * 100)) / 100 },
          });
        }
        if (fresh.length) add(await moveDocStock(px, { ...cur, issueDate: day }, fresh, req.user.id));
        if (leftover.length && credit) add((await stock.removeBySource(px, cur.businessId, leftover)).items.map((i) => i.id));
        return {
          invoice: await px.invoice.findUnique({ where: { id: cur.id }, include: INCLUDE }),
          inventory: await itemRows(px, touched),
        };
      }, TX);
    });

    res.json({ ...formatInvoice(result.invoice, req), inventory: stockRows(req, result.inventory) });
  } catch (err) {
    if (err.status && err.code) {
      return res.status(err.status).json({ error: err.message, code: err.code, number: err.number, ...(err.extra || {}) });
    }
    console.error(err);
    res.status(500).json({ error: "Failed to update invoice" });
  }
});

// ── PATCH /invoices/:id/status ────────────────────────────────────────────────
router.patch("/:id/status", authMiddleware, async (req, res) => {
  try {
    const { status } = req.body;
    if (!status) return res.status(400).json({ error: "status required" });

    const existing = await prisma.invoice.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: "Invoice not found" });
    if (!(await ownsBusiness(req, existing.businessId)))
      return res.status(403).json({ error: "Access denied" });

    const newStatus = status.toUpperCase();
    const allowed = ["SENT", "VOID", "DRAFT"];
    if (!allowed.includes(newStatus))
      return res.status(400).json({ error: `Status must be one of: ${allowed.join(", ")}` });

    // SENT is how a draft goes out (or a credit note opens). On anything past
    // draft it would wipe PARTIAL or PAID, so it changes nothing there.
    if (newStatus === "SENT" && existing.status !== "DRAFT") {
      const same = await prisma.invoice.findUnique({ where: { id: existing.id }, include: INCLUDE });
      return res.json({ ...formatInvoice(same, req), inventory: [] });
    }
    // Money or credit already on a document pins it: a credit note that has
    // given credit cannot be voided or redrafted, an invoice that received
    // credit cannot be voided, and nothing with payments goes back to draft.
    // Otherwise the credit would vanish from one side of the link. Checked
    // under the business lock on a fresh read: the auto-matcher (same lock)
    // could otherwise record a payment between the check and the write.
    // Sending takes the goods out of stock (or puts a credit note's restocked
    // goods back); voiding or redrafting an issued document undoes that, in
    // the transaction that changes the status.
    const biz = await prisma.business.findUnique({ where: { id: existing.businessId }, select: { vatEnabled: true } });
    const result = await prisma.withBusinessLock(existing.businessId, async () => {
      const cur = await prisma.invoice.findUnique({ where: { id: existing.id } });
      if (!cur) throw creditError(404, "INVOICE_NOT_FOUND", "Invoice not found.");
      // Sent meanwhile: nothing changes, as above.
      if (newStatus === "SENT" && cur.status !== "DRAFT") {
        return { invoice: await prisma.invoice.findUnique({ where: { id: cur.id }, include: INCLUDE }), inventory: [] };
      }
      if (cur.type === "credit_note" && (cur.amountPaid || 0) > 0 && newStatus !== "SENT") {
        throw creditError(409, "CREDIT_IN_USE", "This credit note has been used.");
      }
      if (cur.type !== "credit_note" && newStatus === "VOID") {
        const applied = await prisma.creditApplication.count({ where: { invoiceId: cur.id } });
        if (applied) throw creditError(409, "CREDITS_APPLIED", "Credit has been applied to this invoice.");
      }
      if ((newStatus === "DRAFT" || newStatus === "VOID") && (cur.amountPaid || 0) > 0) {
        // Books rule: an invoice is voided only before any payment. Money that
        // came in stays counted; correct the sale with a credit note instead.
        throw creditError(409, "PAYMENTS_RECORDED", "Payments are recorded on this document.");
      }
      if (biz?.vatEnabled && cur.type !== "quote" && cur.status !== "DRAFT") {
        // An issued VAT document is in a return: it never goes back to draft
        // (from where it could be deleted), and is voided only until that
        // month's return is due.
        if (newStatus === "DRAFT") {
          throw creditError(409, "VAT_ISSUED_LOCKED", "An issued VAT invoice can't go back to draft.");
        }
        if (newStatus === "VOID" && !vatPeriodOpen(cur.issueDate)) {
          throw creditError(409, "VAT_PERIOD_CLOSED", "That month's VAT return is due or filed. Issue a credit note instead.");
        }
      }
      // Sending, voiding or redrafting a document moves it in or out of the
      // books on its issue day.
      if (inBooks(cur)) await assertUnlocked(cur.businessId, cur.issueDate);
      return prisma.$transaction(async (px) => {
        const before = movesStock(cur);
        const after = movesStock({ ...cur, status: newStatus });
        let touched = new Set();
        if (before && !after) {
          touched = await releaseDocStock(px, cur);
        } else if (!before && after) {
          touched = await moveDocStock(px, cur, await px.invoiceItem.findMany({ where: { invoiceId: cur.id } }), req.user.id);
        }
        return {
          invoice: await px.invoice.update({ where: { id: cur.id }, data: { status: newStatus }, include: INCLUDE }),
          inventory: await itemRows(px, touched),
        };
      }, TX);
    });
    res.json({ ...formatInvoice(result.invoice, req), inventory: stockRows(req, result.inventory) });
  } catch (err) {
    return sendCreditError(res, err, "Failed to update status");
  }
});

// ── POST /invoices/:id/payments ───────────────────────────────────────────────
// Payment methods a merchant records on an invoice. "transfer" is a transfer
// into ANOTHER bank account (KashBook cannot see it, so the payment carries the
// sale); "bank" is money that landed in the business's KashBook account and
// must name that credit (transactionId), which then stops counting on its own.
const PAYMENT_METHODS = ["cash", "transfer", "card", "cheque", "other", "bank"];

// Status after a payment lands or is undone. DRAFT stays a draft only when
// nothing has been paid; anything paid is out in the world.
function statusAfter(inv, amountPaid) {
  if (amountPaid >= round2(inv.total) && inv.total > 0) return "PAID";
  if (amountPaid > 0) return inv.dueDate && inv.dueDate < lagosToday() ? "OVERDUE" : "PARTIAL";
  if (inv.status === "DRAFT") return "DRAFT";
  return inv.dueDate && inv.dueDate < lagosToday() ? "OVERDUE" : "SENT";
}

// A NUBAN credit this business may use to pay invoices: an incoming bank row
// not matched to a sale or debt, not marked as something else, and not
// explained with an account (money in on an income account keeps no purpose,
// and is income on that account already). Returns the part not yet used by
// other invoice payments.
async function linkableCredit(px, transactionId, businessId) {
  const tx = await px.transaction.findUnique({ where: { id: String(transactionId) } });
  if (!tx || tx.businessId !== businessId) {
    throw creditError(404, "TRANSACTION_NOT_FOUND", "That bank payment was not found.");
  }
  if (tx.type !== "income") {
    throw creditError(400, "NOT_INCOMING", "Pick money that came in.");
  }
  // A cash deposit's credit is the deposit's (409 DEPOSIT_LINKED, with its
  // id), until the owner undoes it on the deposit.
  await assertNotDeposit(px, tx.id);
  if (tx.purpose || tx.accountId || tx.matchedSaleId || tx.matchedCustomerId) {
    throw creditError(409, "TRANSACTION_TAKEN", "That bank payment is already explained.");
  }
  const used = tx.matchedInvoiceId ? Number(tx.matchedAmount || 0) : 0;
  return { tx, remaining: round2(Number(tx.amount) - used) };
}

router.post("/:id/payments", authMiddleware, async (req, res) => {
  try {
    const body = req.body || {};
    const amount = toMoney(body.amount);
    const method = String(body.method || "cash").toLowerCase();
    if (!(amount > 0)) return res.status(400).json({ error: "Valid amount required", code: "BAD_AMOUNT" });
    if (!PAYMENT_METHODS.includes(method)) {
      return res.status(400).json({ error: "Unknown payment method.", code: "BAD_METHOD" });
    }
    if (method === "bank" && !body.transactionId) {
      return res.status(400).json({
        error: "Pick the bank payment that paid this invoice.",
        code: "TRANSACTION_REQUIRED",
      });
    }
    if (method === "bank" && !canUseBank(req)) return res.status(403).json(BANK_DENIED);
    const when = body.date ? new Date(body.date) : new Date();
    if (Number.isNaN(when.getTime())) return res.status(400).json({ error: "Invalid date", code: "BAD_DATE" });
    const note = body.note ? String(body.note).trim().slice(0, 200) || null : null;

    const existing = await prisma.invoice.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: "Invoice not found" });
    if (!(await ownsBusiness(req, existing.businessId)))
      return res.status(403).json({ error: "Access denied" });
    if (existing.type === "quote")
      return res.status(403).json({ error: "Quotes can't take payments — convert it to an invoice first.", code: "QUOTE_NO_PAYMENT" });
    if (existing.type === "credit_note")
      return res.status(403).json({ error: "A credit note is used by applying it to an invoice or recording a refund.", code: "CREDIT_NOTE_NO_PAYMENT" });
    if (existing.status === "VOID")
      return res.status(400).json({ error: "Cannot record payment on a VOID invoice", code: "INVOICE_VOID" });

    // Serialize payments per business so two concurrent posts can't both read a
    // stale amountPaid and overpay / lose an update. Re-read inside the lock;
    // the payment, the invoice and the credit's link commit together. The
    // account the money went into is checked under the lock too, which an
    // account merge or delete also takes (routes/ledger.js), so it is still
    // there when the payment is saved with it.
    const paidResult = await prisma.withBusinessLock(existing.businessId, () =>
      prisma.$transaction(async (px) => {
        const deposit = method === "bank"
          ? null
          : await assertAccountUsable(existing.businessId, body.depositAccountId, "money", { isStaff: req.user.accountType === "staff" }, px);
        const inv = await px.invoice.findUnique({ where: { id: req.params.id } });
        if (inv.writtenOffAt) {
          throw creditError(409, "WRITTEN_OFF", "This invoice was written off. Undo the write-off first.");
        }
        const outstanding = round2(Math.max(0, inv.total - inv.amountPaid));
        if (outstanding <= 0) throw creditError(400, "PAID_IN_FULL", "This invoice is already paid in full.");
        if (amount > outstanding + 0.005) {
          throw creditError(
            400, "EXCEEDS_BALANCE",
            `Payment exceeds outstanding balance of ${outstanding.toFixed(2)}.`, { outstanding },
          );
        }

        let tx = null;
        if (method === "bank") {
          const credit = await linkableCredit(px, body.transactionId, inv.businessId);
          tx = credit.tx;
          if ((tx.currency || "NGN") !== (inv.currency || "NGN")) {
            throw creditError(409, "CURRENCY_MISMATCH", "That bank payment is in a different currency.");
          }
          if (amount > credit.remaining + 0.005) {
            throw creditError(400, "EXCEEDS_TRANSFER", "That is more than is left of the bank payment.", {
              remaining: credit.remaining,
            });
          }
        }
        // The lock date: the day the payment lands on (a bank payment's is
        // the credit's).
        await assertUnlockedIn(px, inv.businessId, tx ? tx.date : when);

        await px.invoicePayment.create({
          data: {
            invoiceId: inv.id,
            amount,
            method,
            note,
            // A payment into the KashBook account happened when the credit landed.
            date: tx ? tx.date : when,
            transactionId: tx ? tx.id : null,
            depositAccountId: deposit ? deposit.id : null,
          },
        });
        if (tx) {
          await px.transaction.update({
            where: { id: tx.id },
            data: {
              matchedInvoiceId: tx.matchedInvoiceId || inv.id,
              matchedAmount: round2(Number(tx.matchedInvoiceId ? tx.matchedAmount || 0 : 0) + amount),
            },
          });
        }
        const paid = sameMoney(outstanding, amount) ? round2(inv.total) : round2(inv.amountPaid + amount);
        const nextStatus = statusAfter(inv, paid);
        // A payment on a draft sends it out, and its goods leave stock on its
        // issue day, which must be open then.
        let touched = new Set();
        if (!movesStock(inv) && movesStock({ ...inv, status: nextStatus })) {
          const lines = await px.invoiceItem.findMany({ where: { invoiceId: inv.id } });
          if (lines.some((l) => movingLine(l, inv.type || "invoice"))) await assertUnlockedIn(px, inv.businessId, inv.issueDate);
          touched = await moveDocStock(px, inv, lines, req.user.id);
        }
        return {
          invoice: await px.invoice.update({
            where: { id: inv.id },
            data: { amountPaid: paid, status: nextStatus },
            include: INCLUDE,
          }),
          inventory: await itemRows(px, touched),
        };
      }, TX),
    );
    const invoice = paidResult.invoice;

    logMoney(req, "INVOICE_PAYMENT", invoice.id, {
      amount, method, transactionId: method === "bank" ? String(body.transactionId) : null,
    });
    res.status(201).json({ ...formatInvoice(invoice, req), inventory: stockRows(req, paidResult.inventory) });
  } catch (err) {
    return sendCreditError(res, err, "Failed to record payment");
  }
});

// DELETE /invoices/:id/payments/:paymentId — undo one payment or refund.
// Money received comes off the invoice (a linked bank credit is freed and
// counts on its own again); a refund goes back onto the credit note (a linked
// debit is freed). Credit applied from a credit note is not undone here.
router.delete("/:id/payments/:paymentId", authMiddleware, async (req, res) => {
  try {
    if (req.user.accountType === "staff") return res.status(403).json(OWNER_ONLY);
    const existing = await prisma.invoice.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: "Invoice not found" });
    if (!(await ownsBusiness(req, existing.businessId))) return res.status(403).json({ error: "Access denied" });

    const updated = await prisma.withBusinessLock(existing.businessId, () =>
      prisma.$transaction(async (px) => {
        const inv = await px.invoice.findUnique({ where: { id: existing.id } });
        const p = await px.invoicePayment.findUnique({ where: { id: String(req.params.paymentId) } });
        if (!p || p.invoiceId !== inv.id) throw creditError(404, "PAYMENT_NOT_FOUND", "Payment not found.");
        const m = String(p.method || "").toLowerCase();
        if (m === "credit_note" || m === "credit_applied") {
          throw creditError(409, "CREDIT_SETTLEMENT", "Credit from a credit note can't be undone here.");
        }
        if (inv.writtenOffAt) {
          throw creditError(409, "WRITTEN_OFF", "This invoice was written off. Undo the write-off first.");
        }
        if (inv.status === "VOID") throw creditError(409, "INVOICE_VOID", "This document is void.");
        // The lock date: the payment's day, and the day of the bank transfer
        // it frees.
        const freed = p.transactionId
          ? await px.transaction.findUnique({ where: { id: p.transactionId }, select: { date: true } })
          : null;
        await assertUnlockedIn(px, inv.businessId, p.date, freed ? freed.date : null);

        await px.invoicePayment.delete({ where: { id: p.id } });
        if (p.transactionId) {
          const tx = await px.transaction.findUnique({ where: { id: p.transactionId } });
          if (tx && m === "refund_bank") {
            if (tx.purpose === "customer_refund") {
              await px.transaction.update({ where: { id: tx.id }, data: { purpose: null } });
            }
          } else if (tx && tx.matchedInvoiceId) {
            const left = round2(Number(tx.matchedAmount || 0) - Number(p.amount));
            let nextInvoice = tx.matchedInvoiceId;
            if (left > 0.005 && tx.matchedInvoiceId === inv.id) {
              const other = await px.invoicePayment.findFirst({
                where: { transactionId: tx.id },
                select: { invoiceId: true },
              });
              nextInvoice = other ? other.invoiceId : null;
            }
            await px.transaction.update({
              where: { id: tx.id },
              data:
                left > 0.005 && nextInvoice
                  ? { matchedInvoiceId: nextInvoice, matchedAmount: left }
                  : { matchedInvoiceId: null, matchedAmount: null },
            });
          }
        }
        const paid = round2(Math.max(0, inv.amountPaid - Number(p.amount)));
        const status =
          inv.type === "credit_note"
            ? paid >= round2(inv.total) ? "PAID" : paid > 0 ? "PARTIAL" : "SENT"
            : statusAfter(inv, paid);
        return px.invoice.update({ where: { id: inv.id }, data: { amountPaid: paid, status }, include: INCLUDE });
      }),
    );
    logMoney(req, "INVOICE_PAYMENT_UNDO", existing.id, { paymentId: String(req.params.paymentId) });
    res.json(formatInvoice(updated, req));
  } catch (err) {
    return sendCreditError(res, err, "Failed to undo payment");
  }
});

// POST /invoices/:id/payments/:paymentId/link  { transactionId }
// A payment recorded as money outside KashBook (e.g. "Transfer" from a build
// that had no "into my KashBook account") that actually landed in the account:
// link it to that credit, so the money counts once (the payment carries it,
// the credit stops counting on its own).
router.post("/:id/payments/:paymentId/link", authMiddleware, async (req, res) => {
  try {
    if (!canUseBank(req)) return res.status(403).json(BANK_DENIED);
    const transactionId = req.body && req.body.transactionId ? String(req.body.transactionId) : null;
    if (!transactionId) return res.status(400).json({ error: "Pick the transfer.", code: "TRANSACTION_REQUIRED" });
    const existing = await prisma.invoice.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: "Invoice not found" });
    if (!(await ownsBusiness(req, existing.businessId))) return res.status(403).json({ error: "Access denied" });

    const updated = await prisma.withBusinessLock(existing.businessId, () =>
      prisma.$transaction(async (px) => {
        const inv = await px.invoice.findUnique({ where: { id: existing.id } });
        const p = await px.invoicePayment.findUnique({ where: { id: String(req.params.paymentId) } });
        if (!p || p.invoiceId !== inv.id) throw creditError(404, "PAYMENT_NOT_FOUND", "Payment not found.");
        if (p.transactionId) throw creditError(409, "ALREADY_LINKED", "This payment is already linked.");
        // A void document's payments count nowhere: a credit linked to one
        // would stop counting too, and the money would vanish from the books.
        if (inv.status === "VOID") throw creditError(409, "INVOICE_VOID", "This document is void.");
        const kind = String(p.method || "").toLowerCase();
        if (!["transfer", "other", "cash", "card", "cheque"].includes(kind)) {
          throw creditError(409, "NOT_LINKABLE", "Only money received can be linked to a transfer.");
        }
        const credit = await linkableCredit(px, transactionId, inv.businessId);
        if ((credit.tx.currency || "NGN") !== (inv.currency || "NGN")) {
          throw creditError(409, "CURRENCY_MISMATCH", "That bank payment is in a different currency.");
        }
        const amount = Number(p.amount);
        if (amount > credit.remaining + 0.005) {
          throw creditError(400, "EXCEEDS_TRANSFER", "That is more than is left of the transfer.", { remaining: credit.remaining });
        }
        // The lock date: the payment moves from its own day to the credit's.
        await assertUnlockedIn(px, inv.businessId, p.date, credit.tx.date);
        await recordLink(px, { req, kind: "invoice_payment", payment: p, transactionId: credit.tx.id });
        await px.invoicePayment.update({
          where: { id: p.id },
          data: { method: "bank", transactionId: credit.tx.id, date: credit.tx.date },
        });
        await px.transaction.update({
          where: { id: credit.tx.id },
          data: {
            matchedInvoiceId: credit.tx.matchedInvoiceId || inv.id,
            matchedAmount: round2(Number(credit.tx.matchedInvoiceId ? credit.tx.matchedAmount || 0 : 0) + amount),
          },
        });
        return px.invoice.findUnique({ where: { id: inv.id }, include: INCLUDE });
      }),
    );
    logMoney(req, "INVOICE_PAYMENT_LINK", existing.id, { paymentId: String(req.params.paymentId), transactionId });
    res.json(formatInvoice(updated, req));
  } catch (err) {
    return sendCreditError(res, err, "Failed to link the payment");
  }
});

// POST /invoices/:id/write-off — give up on what an open invoice still owes.
// DELETE /invoices/:id/write-off — take that back.
router.post("/:id/write-off", authMiddleware, async (req, res) => {
  try {
    if (req.user.accountType === "staff") return res.status(403).json(OWNER_ONLY);
    const existing = await prisma.invoice.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: "Invoice not found" });
    if (!(await ownsBusiness(req, existing.businessId))) return res.status(403).json({ error: "Access denied" });
    if ((existing.type || "invoice") !== "invoice") {
      return res.status(400).json({ error: "Only an invoice can be written off.", code: "NOT_AN_INVOICE" });
    }
    const updated = await prisma.withBusinessLock(existing.businessId, async () => {
      const inv = await prisma.invoice.findUnique({ where: { id: existing.id } });
      if (inv.writtenOffAt) throw creditError(409, "WRITTEN_OFF", "This invoice is already written off.");
      if (!OPEN_STATUSES.includes(inv.status)) {
        throw creditError(409, "INVOICE_NOT_OPEN", "That invoice is not waiting for payment.");
      }
      const left = round2(inv.total - inv.amountPaid);
      if (!(left > 0)) throw creditError(400, "PAID_IN_FULL", "This invoice is already paid in full.");
      // The write-off is dated today, which the lock date may cover.
      const when = new Date();
      await assertUnlocked(inv.businessId, when);
      return prisma.invoice.update({
        where: { id: inv.id },
        data: { writtenOffAt: when, writtenOffAmount: left },
        include: INCLUDE,
      });
    });
    logMoney(req, "INVOICE_WRITE_OFF", existing.id, { amount: updated.writtenOffAmount });
    res.json(formatInvoice(updated, req));
  } catch (err) {
    return sendCreditError(res, err, "Failed to write off");
  }
});

router.delete("/:id/write-off", authMiddleware, async (req, res) => {
  try {
    if (req.user.accountType === "staff") return res.status(403).json(OWNER_ONLY);
    const existing = await prisma.invoice.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: "Invoice not found" });
    if (!(await ownsBusiness(req, existing.businessId))) return res.status(403).json({ error: "Access denied" });
    // Under the business lock, where the lock date is asked: the write-off
    // comes off the day it was dated.
    const updated = await prisma.withBusinessLock(existing.businessId, async () => {
      const cur = await prisma.invoice.findUnique({ where: { id: existing.id }, select: { id: true, businessId: true, writtenOffAt: true } });
      if (!cur) throw creditError(404, "INVOICE_NOT_FOUND", "Invoice not found.");
      await assertUnlocked(cur.businessId, cur.writtenOffAt);
      return prisma.invoice.update({
        where: { id: cur.id },
        data: { writtenOffAt: null, writtenOffAmount: null },
        include: INCLUDE,
      });
    });
    logMoney(req, "INVOICE_WRITE_OFF_UNDO", existing.id, {});
    res.json(formatInvoice(updated, req));
  } catch (err) {
    return sendCreditError(res, err, "Failed to undo the write-off");
  }
});

// ── Credit notes: apply to an invoice, or refund ───────────────────────────────
// A credit note's amountPaid is the credit already used. Both routes re-read
// both documents under the business lock and write everything in one
// transaction, so two taps (or two phones) cannot spend the same credit twice.

const OPEN_STATUSES = ["SENT", "PARTIAL", "OVERDUE"];
// "transfer" = from another bank account; "bank" = from the KashBook account,
// naming the debit (transactionId) so it leaves expenses (books rule: a refund
// lowers sales, it is never an expense).
const REFUND_METHODS = ["cash", "transfer", "card", "cheque", "other", "bank"];
const toMoney = (v) => Math.round(Number(v) * 100) / 100;

function creditError(status, code, error, extra = {}) {
  return Object.assign(new Error(error), { status, code, extra });
}
function sendCreditError(res, err, fallback) {
  if (err.status) return res.status(err.status).json({ error: err.message, code: err.code, ...err.extra });
  console.error(fallback, err);
  return res.status(500).json({ error: fallback });
}
// Lagos calendar day, like the overdue checks above.
const lagosToday = () => new Date(Date.now() + 60 * 60 * 1000).toISOString().slice(0, 10);

// POST /invoices/:id/apply-credit  { invoiceId, amount }  (:id = the credit note)
router.post("/:id/apply-credit", authMiddleware, async (req, res) => {
  try {
    const body = req.body || {};
    const invoiceId = body.invoiceId ? String(body.invoiceId) : null;
    const amount = toMoney(body.amount);
    if (!invoiceId) return res.status(400).json({ error: "invoiceId required" });
    if (!(amount > 0)) return res.status(400).json({ error: "Enter an amount.", code: "BAD_AMOUNT" });

    const note = await prisma.invoice.findUnique({ where: { id: req.params.id } });
    if (!note) return res.status(404).json({ error: "Credit note not found" });
    if (!(await ownsBusiness(req, note.businessId))) return res.status(403).json({ error: "Access denied" });
    if (note.type !== "credit_note") {
      return res.status(400).json({ error: "Only a credit note can be applied.", code: "NOT_A_CREDIT_NOTE" });
    }

    const result = await prisma.withBusinessLock(note.businessId, async () => {
      const cn = await prisma.invoice.findUnique({ where: { id: note.id } });
      const inv = await prisma.invoice.findUnique({ where: { id: invoiceId } });
      if (!inv || inv.businessId !== cn.businessId || (inv.type || "invoice") !== "invoice") {
        throw creditError(404, "INVOICE_NOT_FOUND", "Invoice not found.");
      }
      if (!OPEN_STATUSES.includes(cn.status)) {
        throw creditError(409, "CREDIT_NOT_OPEN", "This credit note is not open.");
      }
      if (!OPEN_STATUSES.includes(inv.status) || inv.writtenOffAt) {
        throw creditError(409, "INVOICE_NOT_OPEN", "That invoice is not waiting for payment.");
      }
      // Credit belongs to one customer and can only pay that customer's invoices.
      if (!cn.customerId || cn.customerId !== inv.customerId) {
        throw creditError(409, "CUSTOMER_MISMATCH", "The credit note and the invoice are for different customers.");
      }
      const remaining = toMoney(cn.total - cn.amountPaid);
      const outstanding = toMoney(inv.total - inv.amountPaid);
      if (amount > remaining) {
        throw creditError(400, "EXCEEDS_CREDIT", "That is more than the credit left.", { remaining });
      }
      if (amount > outstanding) {
        throw creditError(400, "EXCEEDS_BALANCE", "That is more than the invoice still owes.", { outstanding });
      }

      // Applied today, which the lock date may cover.
      const when = new Date();
      await assertUnlocked(cn.businessId, when);
      const invPaid = toMoney(inv.amountPaid + amount);
      const invStatus =
        invPaid >= toMoney(inv.total) ? "PAID" : inv.dueDate && inv.dueDate < lagosToday() ? "OVERDUE" : "PARTIAL";
      const cnUsed = toMoney(cn.amountPaid + amount);
      const cnStatus = cnUsed >= toMoney(cn.total) ? "PAID" : "PARTIAL";

      const [, , , updatedInvoice, updatedCredit] = await prisma.$transaction([
        prisma.creditApplication.create({
          data: { businessId: cn.businessId, creditNoteId: cn.id, invoiceId: inv.id, amount, date: when },
        }),
        // The invoice's balance falls like any payment; the method says it was credit.
        prisma.invoicePayment.create({
          data: { invoiceId: inv.id, amount, method: "credit_note", note: cn.invoiceNumber, date: when },
        }),
        // The credit note keeps its own record of where the credit went.
        prisma.invoicePayment.create({
          data: { invoiceId: cn.id, amount, method: "credit_applied", note: inv.invoiceNumber, date: when },
        }),
        prisma.invoice.update({ where: { id: inv.id }, data: { amountPaid: invPaid, status: invStatus }, include: INCLUDE }),
        prisma.invoice.update({ where: { id: cn.id }, data: { amountPaid: cnUsed, status: cnStatus }, include: INCLUDE }),
      ]);
      return { invoice: updatedInvoice, creditNote: updatedCredit };
    });

    res.status(201).json({ creditNote: formatInvoice(result.creditNote, req), invoice: formatInvoice(result.invoice, req) });
  } catch (err) {
    return sendCreditError(res, err, "Failed to apply credit");
  }
});

// POST /invoices/:id/refund  { amount, method, note?, date?, transactionId? }
// (:id = the credit note). Records money given back to the customer. Books
// rule: the refund lowers sales on its date; when it left the KashBook account
// (method "bank") the debit is marked customer_refund so it is not an expense.
router.post("/:id/refund", authMiddleware, async (req, res) => {
  try {
    const body = req.body || {};
    const amount = toMoney(body.amount);
    const method = String(body.method || "cash").toLowerCase();
    if (!(amount > 0)) return res.status(400).json({ error: "Enter an amount.", code: "BAD_AMOUNT" });
    if (!REFUND_METHODS.includes(method)) {
      return res.status(400).json({ error: "Unknown refund method.", code: "BAD_METHOD" });
    }
    if (method === "bank" && !body.transactionId) {
      return res.status(400).json({ error: "Pick the transfer that paid the refund.", code: "TRANSACTION_REQUIRED" });
    }
    if (method === "bank" && !canUseBank(req)) return res.status(403).json(BANK_DENIED);
    const when = body.date ? new Date(body.date) : new Date();
    if (Number.isNaN(when.getTime())) return res.status(400).json({ error: "Invalid date", code: "BAD_DATE" });

    const note = await prisma.invoice.findUnique({ where: { id: req.params.id } });
    if (!note) return res.status(404).json({ error: "Credit note not found" });
    if (!(await ownsBusiness(req, note.businessId))) return res.status(403).json({ error: "Access denied" });
    if (note.type !== "credit_note") {
      return res.status(400).json({ error: "Only a credit note can be refunded.", code: "NOT_A_CREDIT_NOTE" });
    }

    const updated = await prisma.withBusinessLock(note.businessId, async () => {
      const cn = await prisma.invoice.findUnique({ where: { id: note.id } });
      if (!OPEN_STATUSES.includes(cn.status)) {
        throw creditError(409, "CREDIT_NOT_OPEN", "This credit note is not open.");
      }
      const remaining = toMoney(cn.total - cn.amountPaid);
      if (amount > remaining) {
        throw creditError(400, "EXCEEDS_CREDIT", "That is more than the credit left.", { remaining });
      }
      const cnUsed = toMoney(cn.amountPaid + amount);
      return prisma.$transaction(async (px) => {
        let debit = null;
        if (method === "bank") {
          debit = await px.transaction.findUnique({ where: { id: String(body.transactionId) } });
          if (!debit || debit.businessId !== cn.businessId) {
            throw creditError(404, "TRANSACTION_NOT_FOUND", "That transfer was not found.");
          }
          if (debit.type === "income") throw creditError(400, "NOT_OUTGOING", "Pick money that went out.");
          // Only the provider's own transfer out of the KashBook account in the
          // business's currency, never a hand-typed row: a refund said to have
          // left the KashBook account must have left it (as routes/bills.js).
          const biz = await px.business.findUnique({ where: { id: cn.businessId }, select: { baseCurrency: true } });
          if (!isLedgerBankRow(debit, (biz && biz.baseCurrency) || "NGN")) {
            throw creditError(400, "NOT_OUTGOING", "Pick money that went out of the KashBook account.");
          }
          // Already explained: marked, recorded as an expense, paid towards a
          // bill (release 2), or explained with an account (money out on an
          // expense account keeps no purpose).
          if (debit.purpose || debit.accountId || debit.matchedExpenseId || debit.matchedBillId) {
            throw creditError(409, "TRANSACTION_TAKEN", "That transfer is already explained.");
          }
          // One record per naira: the whole transfer is the refund.
          if (!sameMoney(Number(debit.amount), amount)) {
            throw creditError(400, "AMOUNT_MISMATCH", "The refund must equal the transfer.", {
              transferAmount: Number(debit.amount),
            });
          }
        }
        // The lock date: the day the refund lands on (a bank refund's is the
        // debit's). Asked before anything is written.
        await assertUnlockedIn(px, cn.businessId, debit ? debit.date : when);
        if (debit) {
          // Only if it is still unexplained: a write that took it meanwhile
          // (a bill payment, a categorize) wins, and nothing here is saved.
          const marked = await px.transaction.updateMany({
            where: { id: debit.id, purpose: null, accountId: null, matchedExpenseId: null, matchedBillId: null },
            data: { purpose: "customer_refund" },
          });
          if (marked.count !== 1) throw creditError(409, "TRANSACTION_TAKEN", "That transfer is already explained.");
        }
        await px.invoicePayment.create({
          data: {
            invoiceId: cn.id,
            amount,
            method: `refund_${method}`,
            note: body.note ? String(body.note).trim().slice(0, 200) || null : null,
            date: debit ? debit.date : when,
            transactionId: debit ? debit.id : null,
          },
        });
        return px.invoice.update({
          where: { id: cn.id },
          data: { amountPaid: cnUsed, status: cnUsed >= toMoney(cn.total) ? "PAID" : "PARTIAL" },
          include: INCLUDE,
        });
      });
    });

    logMoney(req, "CREDIT_NOTE_REFUND", note.id, {
      amount, method, transactionId: method === "bank" ? String(body.transactionId) : null,
    });
    res.status(201).json(formatInvoice(updated, req));
  } catch (err) {
    return sendCreditError(res, err, "Failed to record refund");
  }
});

// ── POST /invoices/:id/share-link ─────────────────────────────────────────────
// Returns (and creates if missing) a public link customers can open without
// auth. Idempotent — multiple calls return the same token.
router.post("/:id/share-link", authMiddleware, async (req, res) => {
  try {
    const existing = await prisma.invoice.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: "Invoice not found" });
    if (!(await ownsBusiness(req, existing.businessId)))
      return res.status(403).json({ error: "Access denied" });

    let link = await prisma.invoiceShareLink.findUnique({
      where: { invoiceId: req.params.id },
    });
    if (!link) {
      const token = require("crypto").randomBytes(16).toString("base64url");
      link = await prisma.invoiceShareLink.create({
        data: { invoiceId: req.params.id, token },
      });
    }

    const base = process.env.PUBLIC_BASE_URL ||
      `${req.protocol}://${req.get("host")}`;
    res.json({ token: link.token, url: `${base}/i/${link.token}` });
  } catch (err) {
    console.error("share-link error:", err);
    res.status(500).json({ error: "Failed to create share link" });
  }
});

// ── POST /invoices/:id/convert-to-invoice ─────────────────────────────────────
// Turn an accepted quote into a real invoice: flip type, assign a fresh INV-
// number off the business counter, reset to DRAFT so it can be sent + paid.
router.post("/:id/convert-to-invoice", authMiddleware, async (req, res) => {
  try {
    const existing = await prisma.invoice.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: "Invoice not found" });
    if (!(await ownsBusiness(req, existing.businessId)))
      return res.status(403).json({ error: "Access denied" });
    if (existing.type !== "quote")
      return res.status(400).json({ error: "Only a quote can be converted." });

    // The new invoice carries the customer's addresses and TIN as they are now.
    const snapshot = await snapshotFor(prisma, existing.customerId);

    // Under the business lock, where every document is numbered and the lock
    // date is asked: the new invoice keeps the quote's issueDate, so a quote
    // dated on or before the lock date is moved to an open day before it is
    // converted. Read again under the lock (converted meanwhile, or deleted).
    const invoice = await prisma.withBusinessLock(existing.businessId, async () => {
      const cur = await prisma.invoice.findUnique({ where: { id: existing.id }, select: { id: true, type: true, issueDate: true } });
      if (!cur) throw creditError(404, "INVOICE_NOT_FOUND", "Invoice not found.");
      if (cur.type !== "quote") throw creditError(400, "NOT_A_QUOTE", "Only a quote can be converted.");
      // The quote's day must be a real one (readIssueDay): a quote saved
      // before issue dates were checked may carry other text, which would
      // make an invoice the books place before every real day. Such a quote
      // gets a real day first: editing a quote's date is never refused for
      // the lock date, since a quote is in no books.
      const issueDay = readIssueDay(cur.issueDate);
      if (!issueDay) {
        throw creditError(400, "BAD_DATE", "This quote's date isn't valid. Change it, then convert the quote.", { field: "issueDate" });
      }
      await assertUnlocked(existing.businessId, issueDay);
      const invoiceNumber = await allocateInvoiceNumber(prisma, existing.businessId, "invoice");
      return prisma.invoice.update({
        where: { id: cur.id },
        data: { type: "invoice", invoiceNumber, status: "DRAFT", issueDate: issueDay, ...snapshot },
        include: INCLUDE,
      });
    });
    res.json(formatInvoice(invoice, req));
  } catch (err) {
    return sendCreditError(res, err, "Failed to convert quote");
  }
});

// ── DELETE /invoices/:id ──────────────────────────────────────────────────────
router.delete("/:id", authMiddleware, async (req, res) => {
  try {
    const existing = await prisma.invoice.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: "Invoice not found" });
    if (!(await ownsBusiness(req, existing.businessId)))
      return res.status(403).json({ error: "Access denied" });
    const biz = await prisma.business.findUnique({ where: { id: existing.businessId }, select: { vatEnabled: true } });

    // Under the business lock on a fresh read: the auto-matcher (same lock)
    // could otherwise record a payment between the checks and the delete, and
    // the cascade would take that payment while its bank credit still pointed
    // at the deleted invoice.
    const inventory = await prisma.withBusinessLock(existing.businessId, async () => {
      const cur = await prisma.invoice.findUnique({ where: { id: existing.id } });
      if (!cur) return [];
      if (cur.type === "credit_note" && (cur.amountPaid || 0) > 0) {
        throw creditError(409, "CREDIT_IN_USE", "This credit note has been used.");
      }
      if (cur.type !== "credit_note") {
        const applied = await prisma.creditApplication.count({ where: { invoiceId: cur.id } });
        if (applied) throw creditError(409, "CREDITS_APPLIED", "Credit has been applied to this invoice.");
      }
      // Payments counted in sales go with the invoice if it is deleted, so a
      // paid invoice stays; undo its payments first, or use a credit note.
      const linked = await prisma.invoicePayment.count({ where: { invoiceId: cur.id } });
      if ((cur.amountPaid || 0) > 0 || linked) {
        throw creditError(409, "PAYMENTS_RECORDED", "Payments are recorded on this document.");
      }
      // VAT invoices are numbered in sequence; an issued one is voided, never removed.
      if (cur.type !== "quote" && cur.status !== "DRAFT" && biz?.vatEnabled) {
        throw creditError(409, "VAT_ISSUED_LOCKED", "An issued VAT invoice can be voided, not deleted.");
      }
      // The lock date: the document's day, and a write-off's that goes with it.
      if (inBooks(cur)) await assertUnlocked(cur.businessId, cur.issueDate, cur.writtenOffAt);
      // Its goods come back (a credit note's restocked goods go out again) in
      // the transaction that deletes it.
      return prisma.$transaction(async (px) => {
        const touched = await releaseDocStock(px, cur);
        await px.invoice.delete({ where: { id: cur.id } });
        return itemRows(px, touched);
      }, TX);
    });
    res.json({ ok: true, inventory: stockRows(req, inventory) });
  } catch (err) {
    return sendCreditError(res, err, "Failed to delete invoice");
  }
});

module.exports = router;
