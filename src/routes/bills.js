// Bills (chart of accounts release 2, 2026-10-13): Zoho-style bills replace
// payables. A bill is a BusinessDebt row (the table name is kept and `name` is
// the vendor) with dated BillPayment rows. A payment from the KashBook account
// names the debit that paid it: the debit then carries matchedBillId and
// matchedAmount (the payment, at most the debit), so that part of it stops
// counting on its own (utils/books.js isDebitMatched) and the payment counts
// in its place; the rest of the debit counts as it did. Mounted at /bills in
// server.js, which also clears the owner's cached ledgers after a successful
// write here.
//
// Who may do what (owners hold every capability):
//   - read, add, edit and pay a bill: the owner, or staff with canManagePayables;
//   - pay from the KashBook account: staff also need canViewBalance, because
//     the debit is a bank row;
//   - delete a bill, or one of its payments: the owner only.
// Every write runs under the business lock and in one transaction, checks the
// books lock date (utils/booksLock.js) with every day it touches, leaves an
// audit row and clears the business's cached ledger.
//
// The contract (the app's api.js and AppContext read these shapes):
//   GET    /bills?businessId=             → { bills: [Bill] }, newest bill date first
//   GET    /bills/:id                     → { bill: Bill }
//   POST   /bills                         → 201 { bill: Bill, payment, transaction, inventory }
//          { businessId, vendorName, accountId, amount, billDate?, dueDate?,
//            billNumber?, note?, receivedViaAccountId?, items?, payNow? }
//   PATCH  /bills/:id                     → { bill: Bill, inventory }
//          any of the POST fields except businessId and payNow; only the
//          fields sent change
//   DELETE /bills/:id                     → { deleted: id, transactions: [debits freed], inventory }
//   POST   /bills/:id/payments            → 201 { bill: Bill, payment: Payment, transaction: debit | null }
//          { amount, method, date?, paidThroughAccountId?, transactionId?, note? }
//   DELETE /bills/:id/payments/:paymentId → { bill: Bill, transaction: debit freed | null }
//
// Bill: every BusinessDebt column (id, businessId, name, type, originalAmount,
// remainingAmount, status, billDate, dueDate, billNumber, accountId,
// receivedViaAccountId, estimated, note, createdById, createdAt, updatedAt,
// ...) plus vendorName (= name), amount (= originalAmount), amountPaid,
// balance (= remainingAmount, what is still owed), payments, oldest first,
// and items, a restock's lines in the order entered (BillItem: id, billId,
// itemId, quantity, unitCost, amount, position, createdAt; [] on any other
// bill).
// status is "unpaid", "partial" or "paid". Payment: every BillPayment column
// (id, billId, amount, date, method, paidThroughAccountId, transactionId,
// estimated, outsideBooks, note, createdById, createdAt). The sync bundle
// sends bills in the same shape (publicBill, utils/billView.js).
//
// The fields:
//   - accountId: what the bill is for (chart.pickerAllows context "bill": an
//     expense account, or a liability such as Loans). Required.
//   - receivedViaAccountId: for a bill on a liability (a loan), the account
//     the borrowed money went into (context "money"). On any other bill it is
//     not kept.
//   - items (release 3): a restock, [{ itemId, quantity, unitCost }], 1 to
//     100 lines of this business's goods (a service has no stock). The bill
//     is then on Inventory Asset (the account sent is not used), its amount is
//     what the lines come to (each quantity times unitCost to the kobo,
//     utils/stock.js lineCost; an amount sent must be that), and each line
//     brings its goods into stock at that value on the bill's date (a
//     "purchase" movement, "bill:<lineId>"). An edit that sends other lines
//     replaces them; the same lines again change nothing. An edit or a delete
//     that would take back goods already sold is refused (STOCK_ALREADY_SOLD).
//     Such a bill stays a restock: another account is refused.
//   - payNow (POST only): { method, date?, paidThroughAccountId?,
//     transactionId?, note? }, the whole amount paid in the same request (the
//     Restock screen's "paid now"), by the rules of POST /bills/:id/payments;
//     no date is the bill's date.
//   - inventory: the items whose stock the request moved, as they are now
//     (what the stock cost, stockValue and avgCost, only for the owner and
//     staff with canViewReports; null for anyone else).
//   - method: cash, transfer (from another bank account), pos, cheque, other,
//     or bank (from the KashBook account: transactionId names the debit, the
//     provider's own transfer out of that account and never a row typed in by
//     hand, and the payment is dated when the money left).
//     paidThroughAccountId (context "money") says which account paid, for any
//     method but bank.
//
// Refusals are { error, code, field?, ...extra }:
//   400 BUSINESS_REQUIRED, VENDOR_REQUIRED, BAD_AMOUNT, BAD_DATE, BAD_ITEMS
//       { line? }, BAD_QUANTITY { line }, BAD_COST { line }, AMOUNT_MISMATCH
//       { amount: what the lines come to }, BAD_PAY_NOW, NOT_STOCKED { itemId,
//       line } (a service, or goods whose stock is not counted: buying those
//       is ordinary spending, an expense or a bill on a spending account),
//       ACCOUNT_REQUIRED, BAD_METHOD, TRANSACTION_REQUIRED, NOT_OUTGOING
//       (money in, or a row that is not a transfer out of the KashBook
//       account), PAID_IN_FULL, EXCEEDS_BALANCE { balance }, EXCEEDS_TRANSFER
//       { transferAmount }, and the account refusals ACCOUNT_NOT_FOUND and
//       ACCOUNT_NOT_ALLOWED (utils/ledgerData.js assertAccountUsable)
//   403 PERMISSION_DENIED { permission }, OWNER_ONLY, or Forbidden (a business
//       that is not the caller's)
//   404 BILL_NOT_FOUND, PAYMENT_NOT_FOUND, TRANSACTION_NOT_FOUND,
//       ITEM_NOT_FOUND { itemId, line }
//   409 BOOKS_LOCKED { lockDate }, AMOUNT_BELOW_PAID { paid },
//       TRANSACTION_TAKEN, CURRENCY_MISMATCH, BILL_CHANGED, BILL_NOT_CONVERTED,
//       ITEM_ARCHIVED { itemId, line }, STOCK_ALREADY_SOLD { itemId },
//       STOCK_BILL_ACCOUNT (another account for a restock)
const router = require("express").Router();
const auth = require("../middleware/auth");
const prisma = require("../utils/db");
const chart = require("../utils/chart");
const { requirePermission, ownerOnly } = require("../middleware/requirePermission");
const { ownerIdOf } = require("../utils/scope");
const { assertAccountUsable, invalidateLedger, accountsFor } = require("../utils/ledgerData");
const { assertUnlockedIn } = require("../utils/booksLock");
const { audit } = require("../utils/audit");
const { toKobo } = require("../utils/money");
const { BILL_INCLUDE, billFor } = require("../utils/billView");
const stock = require("../utils/stock");
const { publicItem } = require("../utils/items");
const { PROVIDER_SOURCES, isLedgerBankRow } = require("../config/moneySources");

router.use(auth);

// Payment methods (the migration's CHECK holds the same list). "transfer" is
// money sent from another bank account, which KashBook cannot see; "bank" is
// money that left the KashBook account and names that debit.
const METHODS = ["cash", "transfer", "pos", "cheque", "other", "bank"];

// Amounts are worked in kobo (whole numbers) and stored in naira.
const naira = (kobo) => kobo / 100;
const MAX_KOBO = 1e14; // a trillion naira: anything above is a typo
const paidKobo = (payments) => (payments || []).reduce((s, p) => s + toKobo(p.amount), 0);

function statusOf(amountKobo, paidK) {
  if (paidK >= amountKobo) return "paid";
  return paidK > 0 ? "partial" : "unpaid";
}

// A bill as a client receives it: publicBill (utils/billView.js), through
// billFor, so staff who do not see the bank get no debit ids (viewBill).
const viewBill = (req, row) => billFor(row, { canSeeBank: req.user.permissions?.canViewBalance === true });

// A bill with its payments and a restock's lines, in the order entered.
const BILL_FULL = Object.freeze({ ...BILL_INCLUDE, items: { orderBy: [{ position: "asc" }, { createdAt: "asc" }] } });

// Long enough for a restock of a hundred lines and its payment.
const TX = { timeout: 20000 };

// Every bank row the server sends says which cash deposit it is (cashDepositId,
// utils/cashDeposits.js withDepositIds). The debits a bill names never are:
// only a credit brings a deposit in.
const asDebit = (t) => (t && typeof t === "object" ? { ...t, cashDepositId: null } : t);

// Whether the caller may see what stock cost (an item's stockValue and
// avgCost): the owner, or staff with the reports.
const seesCosts = (req) => req.user.accountType !== "staff" || req.user.permissions?.canViewReports === true;

// The items a request moved, as its reply carries them (the app replaces its
// copies), as routes/inventory.js shows them (utils/items.js publicItem):
// without the old cost column, and what the stock cost and the purchase
// information only for those who may see costs.
async function itemRows(req, px, ids) {
  const list = [...ids];
  if (!list.length) return [];
  const rows = await px.inventoryItem.findMany({ where: { id: { in: list } } });
  const costs = seesCosts(req);
  return rows.map((row) => publicItem(row, costs));
}

// ── Refusals ─────────────────────────────────────────────────────────────────

function billError(status, code, message, extra, field) {
  const err = Object.assign(new Error(message), { status, code });
  if (extra) err.extra = extra;
  if (field) err.field = field;
  return err;
}

// A coded refusal as the app reads it, with the field it is about and
// whatever else it carries (the lock date, the balance); a 500 otherwise. An
// account refused by utils/ledgerData.js and a locked day by
// utils/booksLock.js come the same way.
function sendError(res, err, fallback) {
  if (err && err.status && err.code) {
    return res.status(err.status).json({
      error: err.message,
      code: err.code,
      ...(err.field ? { field: err.field } : {}),
      ...(err.extra || {}),
    });
  }
  console.error(`[bills] ${fallback}:`, err);
  return res.status(500).json({ error: fallback });
}

const billNotFound = () => billError(404, "BILL_NOT_FOUND", "Bill not found.");
const billChanged = () => billError(409, "BILL_CHANGED", "This bill just changed. Try again.");
const badDate = (field) => billError(400, "BAD_DATE", "That date isn't valid.", null, field);
const accountRequired = () => billError(400, "ACCOUNT_REQUIRED", "Choose what the bill is for.", null, "accountId");

// ── Reading a request ────────────────────────────────────────────────────────

// Money as the app sends it, a number or a number written as text, kept to
// the kobo. More than zero and a real number, or refused.
function readAmount(v, field = "amount") {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  const kobo = Number.isFinite(n) ? Math.round(n * 100) : NaN;
  if (!(kobo > 0) || kobo > MAX_KOBO) {
    throw billError(400, "BAD_AMOUNT", "Enter an amount more than zero.", null, field);
  }
  return kobo;
}

// Text, trimmed and cut to `max`; null when empty or not text at all.
function readText(v, max) {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}

// A date as the app sends it: the phone's own day ("YYYY-MM-DD") or a full
// timestamp. null or "" clears an optional one. A year before 2000, or more
// than ten years ahead, is a typo and refused.
function readDate(v, field) {
  if (v === null || v === "") return null;
  if (typeof v !== "string" && typeof v !== "number") throw badDate(field);
  const d = new Date(v);
  if (!Number.isFinite(d.getTime())) throw badDate(field);
  const year = d.getUTCFullYear();
  if (year < 2000 || year > new Date().getUTCFullYear() + 10) throw badDate(field);
  return d;
}

const sameTime = (a, b) => (a ? new Date(a).getTime() : null) === (b ? new Date(b).getTime() : null);

// ── Whose bill ───────────────────────────────────────────────────────────────

// The business, when it is the caller's (staff act for their employer). An id
// is text: anything else names no business.
async function ownedBusiness(req, businessId) {
  if (typeof businessId !== "string" || !businessId) return null;
  return prisma.business.findFirst({
    where: { id: businessId, userId: ownerIdOf(req) },
    select: { id: true, baseCurrency: true },
  });
}

// The bill in the path, when it is the caller's and sits in one of their
// businesses; null otherwise, which is answered 404 whether the bill exists
// or not. A bill left without a business (its business was deleted) is in
// none.
async function ownedBill(req) {
  const bill = await prisma.businessDebt.findUnique({
    where: { id: String(req.params.id) },
    select: { id: true, userId: true, businessId: true },
  });
  if (!bill || !bill.businessId || bill.userId !== ownerIdOf(req)) return null;
  const biz = await ownedBusiness(req, bill.businessId);
  return biz ? { id: bill.id, biz } : null;
}

// The bill again, under the lock, as the write will see it.
async function freshBill(px, found) {
  const bill = await px.businessDebt.findUnique({ where: { id: found.id }, include: BILL_FULL });
  if (!bill || bill.businessId !== found.biz.id) throw billNotFound();
  return bill;
}

// A payable from before bills keeps what was paid on it only as
// remainingAmount, until scripts/backfill-r2.js writes that as one payment
// kept outside the books. Money never moves on such a row: what it says is
// paid would not be its payments.
function assertConverted(bill) {
  const stated = toKobo(bill.originalAmount) - toKobo(bill.remainingAmount);
  if (stated !== paidKobo(bill.payments)) {
    throw billError(409, "BILL_NOT_CONVERTED", "This bill is from before bills and is still being converted. Try again later.");
  }
}

// What the legacy `type` column says (older code and the backfill read it):
// the category the account stands for, else loan for a liability, else other.
function typeFor(account) {
  if (account.categorySlug) return account.categorySlug;
  return chart.classOf(account.type) === "liability" ? "loan" : "other";
}

const isLiability = (account) => !!account && chart.classOf(account.type) === "liability";

// The days a bill's payments count on (a payment kept outside the books counts
// nowhere). A bill's account decides how each of them counts.
const countedPaymentDays = (bill) => bill.payments.filter((p) => !p.outsideBooks).map((p) => p.date);

// A KashBook debit a payment may name: money out of this business, in its
// currency, that nothing explains yet (no purpose such as a refund or a
// savings fee, no account, and no expense or bill carrying it). Read under the
// lock; the link itself is then written only if the row is still so
// (compare-and-set), so two payments never take one debit.
//
// It must be a transfer out of the KashBook account itself: the provider's own
// row, the one the ledger posts to the KashBook Account
// (config/moneySources.js isLedgerBankRow). No route changes such a row's
// amount or deletes it (routes/transactions.js and the sync queue refuse every
// bank row), so the payment never outlives its debit. A row typed in by hand
// (POST /transactions, paid in cash) moved no KashBook money at all, and it
// can be edited and deleted: naming one would make a bill read as paid from
// the KashBook account when nothing left it. It is refused like money in.
function debitRefusal(tx, biz) {
  if (!tx || tx.businessId !== biz.id) {
    return billError(404, "TRANSACTION_NOT_FOUND", "That transfer was not found.", null, "transactionId");
  }
  if (tx.type !== "expense") return billError(400, "NOT_OUTGOING", "Pick money that went out.", null, "transactionId");
  const base = biz.baseCurrency || "NGN";
  if ((tx.currency || "NGN") !== base) {
    return billError(409, "CURRENCY_MISMATCH", "That transfer is in a different currency.", null, "transactionId");
  }
  if (!isLedgerBankRow(tx, base)) {
    return billError(400, "NOT_OUTGOING", "Pick money that went out of the KashBook account.", null, "transactionId");
  }
  if (tx.purpose || tx.accountId || tx.matchedExpenseId || tx.matchedBillId ||
      tx.matchedSaleId || tx.matchedCustomerId || tx.matchedInvoiceId) {
    return billError(409, "TRANSACTION_TAKEN", "That transfer is already explained.", null, "transactionId");
  }
  return null;
}
// The same, as the condition the link is written under: a transfer out of the
// KashBook account (isLedgerBankRow, whose currency was checked on the read
// and never changes on a bank row) that nothing explains.
const UNEXPLAINED = {
  type: "expense", source: { in: PROVIDER_SOURCES }, paymentMethod: "bank", category: "transfer",
  purpose: null, accountId: null, matchedExpenseId: null, matchedBillId: null,
  matchedSaleId: null, matchedCustomerId: null, matchedInvoiceId: null,
};

// Frees the debit a payment named, when it is still this bill's; returns the
// row as it now is, or null (nothing to free: unlinked already, or gone with
// its business). Only the bill's own link is taken off.
async function freeDebit(px, transactionId, billId) {
  if (!transactionId) return null;
  const tx = await px.transaction.findUnique({ where: { id: transactionId } });
  if (!tx || tx.matchedBillId !== billId) return null;
  // matchedAmount is the bill payment's, unless something else claims the
  // row as well (never, while the transaction routes refuse a debit a bill
  // took): then that link keeps its amount.
  const data = tx.matchedExpenseId ? { matchedBillId: null } : { matchedBillId: null, matchedAmount: null };
  const freed = await px.transaction.updateMany({ where: { id: tx.id, matchedBillId: billId }, data });
  if (freed.count !== 1) return null;
  return px.transaction.findUnique({ where: { id: tx.id } });
}

// Money that enters or leaves the books through a bill leaves a trail. Fire
// and forget, as on the invoice routes.
function logBill(req, action, billId, metadata) {
  audit({ req, action, resourceType: "bill", resourceId: billId, metadata }).catch(() => {});
}

const isStaffReq = (req) => req.user.accountType === "staff";

// ── Restocks (release 3) ─────────────────────────────────────────────────────

const MAX_LINES = 100;

// A restock's lines as sent, [{ itemId, quantity, unitCost }], 1 to 100. A
// quantity has at most three decimals (2.5 kg); a cost is 0 or more. Each
// line's amount is lineCost(quantity, unitCost), to the kobo, the one rule
// the stock engine values goods by. Returns { lines: [{ itemId, quantity,
// unitCost, amountK }], amountK } (amounts in kobo). Whether each item is
// this business's goods is the stock engine's to say, under the lock.
function readItems(v) {
  if (!Array.isArray(v) || v.length < 1 || v.length > MAX_LINES) {
    throw billError(400, "BAD_ITEMS", "A restock has 1 to 100 lines.", null, "items");
  }
  const num = (x) => (typeof x === "string" && x.trim() !== "" ? Number(x) : x);
  const lines = v.map((it, line) => {
    if (!it || typeof it !== "object") throw billError(400, "BAD_ITEMS", "Each line names an item, a quantity and a cost.", { line }, "items");
    const itemId = typeof it.itemId === "string" && it.itemId.trim() ? it.itemId.trim() : null;
    if (!itemId) throw billError(400, "BAD_ITEMS", "Pick the item for each line.", { line }, "items");
    const quantity = num(it.quantity);
    if (!stock.validQuantity(quantity)) {
      throw billError(400, "BAD_QUANTITY", "Enter a quantity more than 0, with at most three decimals.", { line }, "items");
    }
    const unitCost = num(it.unitCost);
    if (typeof unitCost !== "number" || !Number.isFinite(unitCost) || unitCost < 0 || unitCost > 1e12) {
      throw billError(400, "BAD_COST", "Enter a cost of 0 or more.", { line }, "items");
    }
    return { itemId, quantity, unitCost, amountK: toKobo(stock.lineCost(quantity, unitCost)) };
  });
  const amountK = lines.reduce((s, l) => s + l.amountK, 0);
  if (!(amountK > 0) || amountK > MAX_KOBO) {
    throw billError(400, "BAD_AMOUNT", "A restock's lines must come to more than zero.", null, "items");
  }
  return { lines, amountK };
}

// Whether a bill's saved lines are the lines sent (same items, quantities and
// costs, in the same order): an edit that sends them again moves nothing.
function sameItems(saved, lines) {
  if (saved.length !== lines.length) return false;
  return saved.every((s, i) => {
    const l = lines[i];
    return s.itemId === l.itemId && Math.round(s.quantity * 1000) === Math.round(l.quantity * 1000) &&
      Number(s.unitCost) === l.unitCost && toKobo(s.amount) === l.amountK;
  });
}

// The business's Inventory Asset account, the one a restock is on.
async function stockAccountOf(px, businessId) {
  const account = await px.ledgerAccount.findFirst({ where: { businessId, systemKey: chart.SYS.STOCK } });
  if (!account) throw billError(409, "NO_STOCK_ACCOUNT", "This business's chart has no Inventory Asset account yet. Try again.");
  return account;
}

// Writes a restock's lines and brings their goods into stock at each line's
// amount on the bill's date (a "purchase" movement, "bill:<lineId>"). A
// refusal names the line (an item of another business, a service or goods
// whose stock is not counted, an archived item). Returns the ids of the items
// it moved.
async function writeItems(px, bill, lines, date, createdById) {
  const touched = new Set();
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const row = await px.billItem.create({
      data: { billId: bill.id, itemId: l.itemId, quantity: l.quantity, unitCost: l.unitCost, amount: naira(l.amountK), position: i },
    });
    try {
      await stock.putIn(px, {
        businessId: bill.businessId, itemId: l.itemId, quantity: l.quantity, value: naira(l.amountK), date,
        sourceKey: `bill:${row.id}`, kind: "purchase", createdById,
      });
    } catch (err) {
      if (err && err.code) err.extra = { ...(err.extra || {}), line: i };
      throw err;
    }
    touched.add(l.itemId);
  }
  return touched;
}

// Takes a restock's goods back out of stock and removes its lines (refused
// with 409 STOCK_ALREADY_SOLD when some have been sold since). Returns the
// ids of the items it moved.
async function removeItems(px, bill) {
  if (!bill.items || !bill.items.length) return new Set();
  const { items } = await stock.removeBySource(px, bill.businessId, bill.items.map((i) => `bill:${i.id}`));
  await px.billItem.deleteMany({ where: { billId: bill.id } });
  return new Set(items.map((i) => i.id));
}

// ── Paying ───────────────────────────────────────────────────────────────────

// A payment as sent (POST /bills/:id/payments, or a new bill's payNow): the
// method (none is cash), the debit a payment from the KashBook account names,
// and its day (none: `defaultDay`, today unless given; a payment from the
// KashBook account takes the debit's). Staff paying from the KashBook account
// also need canViewBalance.
function readPayment(req, src) {
  const method = src.method === undefined || src.method === null || src.method === ""
    ? "cash"
    : String(src.method).toLowerCase();
  if (!METHODS.includes(method)) throw billError(400, "BAD_METHOD", "Unknown payment method.", null, "method");
  const bank = method === "bank";
  if (bank && !src.transactionId) {
    throw billError(400, "TRANSACTION_REQUIRED", "Pick the transfer that paid this bill.", null, "transactionId");
  }
  if (bank && isStaffReq(req) && req.user.permissions?.canViewBalance !== true) {
    throw billError(
      403, "PERMISSION_DENIED",
      "You don't have access to the bank account. Ask the business owner to link this transfer.",
      { permission: "canViewBalance" },
    );
  }
  return {
    method,
    bank,
    when: bank || src.date == null || src.date === "" ? null : readDate(src.date, "date"),
    transactionId: bank ? String(src.transactionId) : null,
    paidThroughAccountId: src.paidThroughAccountId,
    note: readText(src.note, 200),
  };
}

// Records a payment of amountK on `bill` (read under the lock, with its
// payments): at most what it still owes; from the KashBook account, the debit
// it names (debitRefusal) must be at least the payment, and is linked only if
// nothing took it since it was read. The payment's day must be open.
// `defaultDay`: the day a payment sent with none is on. Returns { payment,
// transaction } (the debit as it now is, or null).
async function payBill(px, req, biz, bill, amountK, pay, defaultDay) {
  const amountBillK = toKobo(bill.originalAmount);
  const paidK = paidKobo(bill.payments);
  const balanceK = amountBillK - paidK;
  if (balanceK <= 0) throw billError(400, "PAID_IN_FULL", "This bill is already paid in full.");
  if (amountK > balanceK) {
    throw billError(400, "EXCEEDS_BALANCE", "That is more than the bill still owes.", { balance: naira(balanceK) }, "amount");
  }

  let tx = null;
  let paidThrough = null;
  if (pay.bank) {
    tx = await px.transaction.findUnique({ where: { id: pay.transactionId } });
    const refused = debitRefusal(tx, biz);
    if (refused) throw refused;
    if (amountK > toKobo(tx.amount)) {
      throw billError(400, "EXCEEDS_TRANSFER", "That is more than the transfer.", { transferAmount: Number(tx.amount) }, "amount");
    }
  } else {
    paidThrough = await assertAccountUsable(
      bill.businessId, pay.paidThroughAccountId, "money", { isStaff: isStaffReq(req), field: "paidThroughAccountId" }, px,
    );
  }
  const date = pay.bank ? tx.date : pay.when || defaultDay || new Date();
  await assertUnlockedIn(px, bill.businessId, date);

  // The debit first, and only if nothing took it since it was read.
  if (pay.bank) {
    const linked = await px.transaction.updateMany({
      where: { id: tx.id, businessId: bill.businessId, ...UNEXPLAINED },
      data: { matchedBillId: bill.id, matchedAmount: naira(amountK) },
    });
    if (linked.count !== 1) {
      throw billError(409, "TRANSACTION_TAKEN", "That transfer is already explained.", null, "transactionId");
    }
  }
  const payment = await px.billPayment.create({
    data: {
      billId: bill.id,
      amount: naira(amountK),
      date,
      method: pay.method,
      paidThroughAccountId: paidThrough ? paidThrough.id : null,
      transactionId: pay.bank ? tx.id : null,
      note: pay.note,
      createdById: req.user.id,
    },
  });
  const newPaidK = paidK + amountK;
  const moved = await px.businessDebt.updateMany({
    where: { id: bill.id, updatedAt: bill.updatedAt },
    data: { remainingAmount: naira(amountBillK - newPaidK), status: statusOf(amountBillK, newPaidK) },
  });
  if (moved.count !== 1) throw billChanged();
  return { payment, transaction: pay.bank ? await px.transaction.findUnique({ where: { id: tx.id } }) : null };
}

// ── GET /bills?businessId= ───────────────────────────────────────────────────
router.get("/", requirePermission("canManagePayables"), async (req, res) => {
  try {
    const { businessId } = req.query;
    if (!businessId) return res.status(400).json({ error: "businessId required", code: "BUSINESS_REQUIRED" });
    const biz = await ownedBusiness(req, businessId);
    if (!biz) return res.status(403).json({ error: "Forbidden" });
    const bills = await prisma.businessDebt.findMany({
      where: { businessId: biz.id, userId: ownerIdOf(req) },
      include: BILL_FULL,
      orderBy: [{ billDate: "desc" }, { createdAt: "desc" }],
    });
    res.json({ bills: bills.map((b) => viewBill(req, b)) });
  } catch (err) {
    sendError(res, err, "Failed to load bills");
  }
});

// ── GET /bills/:id ───────────────────────────────────────────────────────────
router.get("/:id", requirePermission("canManagePayables"), async (req, res) => {
  try {
    const found = await ownedBill(req);
    if (!found) return sendError(res, billNotFound());
    const bill = await prisma.businessDebt.findUnique({ where: { id: found.id }, include: BILL_FULL });
    if (!bill) return sendError(res, billNotFound());
    res.json({ bill: viewBill(req, bill) });
  } catch (err) {
    sendError(res, err, "Failed to load the bill");
  }
});

// ── POST /bills ──────────────────────────────────────────────────────────────
router.post("/", requirePermission("canManagePayables"), async (req, res) => {
  try {
    const body = req.body || {};
    const isStaff = isStaffReq(req);
    if (!body.businessId) throw billError(400, "BUSINESS_REQUIRED", "businessId required", null, "businessId");
    const biz = await ownedBusiness(req, body.businessId);
    if (!biz) return res.status(403).json({ error: "Forbidden" });
    const vendorName = readText(body.vendorName !== undefined ? body.vendorName : body.name, 120);
    if (!vendorName) throw billError(400, "VENDOR_REQUIRED", "Say who the bill is from.", null, "vendorName");
    // A restock: its lines say the amount, and an amount sent must be theirs.
    const restock = body.items === undefined || body.items === null ? null : readItems(body.items);
    let amountK;
    if (restock) {
      amountK = restock.amountK;
      if (body.amount !== undefined && body.amount !== null && body.amount !== "" && readAmount(body.amount) !== amountK) {
        throw billError(400, "AMOUNT_MISMATCH", "The bill's amount must be what its lines come to.", { amount: naira(amountK) }, "amount");
      }
    } else {
      amountK = readAmount(body.amount);
      if (!body.accountId) throw accountRequired();
    }
    // No bill date is today. A due date is optional.
    const billDate = body.billDate == null || body.billDate === "" ? new Date() : readDate(body.billDate, "billDate");
    const dueDate = body.dueDate === undefined ? null : readDate(body.dueDate, "dueDate");
    const billNumber = readText(body.billNumber, 50);
    const note = readText(body.note, 500);
    // Paid in the same request, in full.
    let payNow = null;
    if (body.payNow !== undefined && body.payNow !== null && body.payNow !== false) {
      if (typeof body.payNow !== "object" || Array.isArray(body.payNow)) {
        throw billError(400, "BAD_PAY_NOW", "Say how the bill was paid.", null, "payNow");
      }
      payNow = readPayment(req, body.payNow);
    }
    // A chart missing a system account gets it first, outside the business
    // lock (accountsFor takes a lock of its own).
    if (restock) await accountsFor(biz.id);

    // The account is checked under the lock an account merge or delete also
    // takes (routes/ledger.js), so it is still there when the bill names it.
    // The bill, a restock's goods and a payment made now are written in one
    // transaction: a refusal of any of them leaves nothing.
    const result = await prisma.withBusinessLock(biz.id, () =>
      prisma.$transaction(async (px) => {
        await assertUnlockedIn(px, biz.id, billDate);
        // A restock is on Inventory Asset, whatever account was sent.
        const account = restock
          ? await stockAccountOf(px, biz.id)
          : await assertAccountUsable(biz.id, body.accountId, "bill", { isStaff, field: "accountId" }, px);
        // Where borrowed money went: only a bill on a liability has it.
        const via = isLiability(account)
          ? await assertAccountUsable(biz.id, body.receivedViaAccountId, "money", { isStaff, field: "receivedViaAccountId" }, px)
          : null;
        const created = await px.businessDebt.create({
          data: {
            userId: ownerIdOf(req),
            businessId: biz.id,
            name: vendorName,
            type: typeFor(account),
            originalAmount: naira(amountK),
            remainingAmount: naira(amountK),
            status: "unpaid",
            billDate,
            dueDate,
            billNumber,
            note,
            accountId: account.id,
            receivedViaAccountId: via ? via.id : null,
            createdById: req.user.id,
          },
          include: BILL_FULL,
        });
        const touched = restock ? await writeItems(px, created, restock.lines, billDate, req.user.id) : new Set();
        const paid = payNow ? await payBill(px, req, biz, created, amountK, payNow, billDate) : null;
        return {
          bill: await px.businessDebt.findUnique({ where: { id: created.id }, include: BILL_FULL }),
          payment: paid ? paid.payment : null,
          transaction: paid ? paid.transaction : null,
          inventory: await itemRows(req, px, touched),
        };
      }, TX),
    );

    const bill = result.bill;
    invalidateLedger(biz.id);
    logBill(req, "BILL_CREATE", bill.id, {
      businessId: biz.id, amount: bill.originalAmount, accountId: bill.accountId, lines: bill.items.length,
    });
    if (result.payment) {
      logBill(req, "BILL_PAYMENT", bill.id, {
        paymentId: result.payment.id, amount: result.payment.amount, method: result.payment.method,
        transactionId: result.payment.transactionId,
      });
    }
    res.status(201).json({
      bill: viewBill(req, bill),
      payment: result.payment,
      transaction: asDebit(result.transaction),
      inventory: result.inventory,
    });
  } catch (err) {
    sendError(res, err, "Failed to add the bill");
  }
});

// ── PATCH /bills/:id ─────────────────────────────────────────────────────────
// Only the fields sent change. Any change touches the bill's own day (and the
// new one when it moves), so a bill dated on or before the lock date stays as
// it is. A new account changes how every payment counts, so their days are
// checked too. The amount is never below what is already paid.
//
// A restock (release 3): lines sent replace its lines when they differ (their
// goods leave stock and the new ones come in, refused with 409
// STOCK_ALREADY_SOLD when some have been sold since); its amount is always
// what its lines come to (an amount sent must be that); it stays on Inventory
// Asset (another account is refused, 409 STOCK_BILL_ACCOUNT); and a new bill
// date moves its goods' movements to that day. Lines sent for another bill
// make it a restock.
router.patch("/:id", requirePermission("canManagePayables"), async (req, res) => {
  try {
    const body = req.body || {};
    const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
    const isStaff = isStaffReq(req);
    const found = await ownedBill(req);
    if (!found) throw billNotFound();

    // What the request asks for, read before the lock.
    const ask = {};
    if (has("vendorName") || has("name")) {
      ask.name = readText(has("vendorName") ? body.vendorName : body.name, 120);
      if (!ask.name) throw billError(400, "VENDOR_REQUIRED", "Say who the bill is from.", null, "vendorName");
    }
    if (has("amount")) ask.amountK = readAmount(body.amount);
    if (has("billDate")) {
      ask.billDate = readDate(body.billDate, "billDate");
      if (!ask.billDate) throw badDate("billDate");
    }
    if (has("dueDate")) ask.dueDate = readDate(body.dueDate, "dueDate");
    if (has("billNumber")) ask.billNumber = readText(body.billNumber, 50);
    if (has("note")) ask.note = readText(body.note, 500);
    if (has("accountId")) {
      if (!body.accountId) throw accountRequired();
      ask.accountId = String(body.accountId);
    }
    if (has("receivedViaAccountId")) {
      ask.receivedViaAccountId = body.receivedViaAccountId ? String(body.receivedViaAccountId) : null;
    }
    if (has("items")) ask.items = readItems(body.items);
    if (ask.items) await accountsFor(found.biz.id);

    const result = await prisma.withBusinessLock(found.biz.id, () =>
      prisma.$transaction(async (px) => {
        const cur = await freshBill(px, found);
        // A restock, now or after this edit: on Inventory Asset, its amount
        // its lines'.
        const restock = cur.items.length > 0 || !!ask.items;
        const stockAccount = restock ? await stockAccountOf(px, cur.businessId) : null;
        if (restock && ask.accountId !== undefined && ask.accountId !== stockAccount.id) {
          throw billError(409, "STOCK_BILL_ACCOUNT", "A restock stays on Inventory Asset. Delete it and add a bill instead.", null, "accountId");
        }
        const itemsChange = !!ask.items && !sameItems(cur.items, ask.items.lines);
        let wantK = ask.amountK;
        if (restock) {
          const linesK = ask.items ? ask.items.amountK : toKobo(cur.originalAmount);
          if (ask.amountK !== undefined && ask.amountK !== linesK) {
            throw billError(400, "AMOUNT_MISMATCH", "The bill's amount must be what its lines come to.", { amount: naira(linesK) }, "amount");
          }
          wantK = ask.items ? linesK : undefined;
        }
        const data = {};
        if (ask.name !== undefined && ask.name !== cur.name) data.name = ask.name;
        if (ask.billDate !== undefined && !sameTime(ask.billDate, cur.billDate)) data.billDate = ask.billDate;
        if (ask.dueDate !== undefined && !sameTime(ask.dueDate, cur.dueDate)) data.dueDate = ask.dueDate;
        if (ask.billNumber !== undefined && ask.billNumber !== cur.billNumber) data.billNumber = ask.billNumber;
        if (ask.note !== undefined && ask.note !== cur.note) data.note = ask.note;
        const amountChange = wantK !== undefined && wantK !== toKobo(cur.originalAmount);
        const accountChange = restock
          ? cur.accountId !== stockAccount.id
          : ask.accountId !== undefined && ask.accountId !== cur.accountId;
        // The account. One the bill names already is taken as it is, even if
        // the owner has since rested it, so an edit of other fields saves.
        let account = cur.accountId ? await px.ledgerAccount.findUnique({ where: { id: cur.accountId } }) : null;
        // Where the money went changes only on a bill that can keep it (one on
        // a liability, or moving to another account), or to let one go.
        const viaChange = ask.receivedViaAccountId !== undefined && ask.receivedViaAccountId !== cur.receivedViaAccountId &&
          (accountChange || isLiability(account) || !!cur.receivedViaAccountId);
        if (!Object.keys(data).length && !amountChange && !accountChange && !viaChange && !itemsChange) {
          return { bill: cur, fields: [], inventory: [] };
        }

        // The bill's own day, and the day it moves to.
        await assertUnlockedIn(px, cur.businessId, cur.billDate, data.billDate);

        if (accountChange) {
          account = restock
            ? stockAccount
            : await assertAccountUsable(cur.businessId, ask.accountId, "bill", { isStaff, field: "accountId" }, px);
          data.accountId = account.id;
          data.type = typeFor(account);
          await assertUnlockedIn(px, cur.businessId, countedPaymentDays(cur));
        }
        // Where borrowed money went: kept only on a bill on a liability, and
        // let go when the bill moves to spending.
        if (isLiability(account)) {
          if (viaChange) {
            const via = await assertAccountUsable(cur.businessId, ask.receivedViaAccountId, "money", { isStaff, field: "receivedViaAccountId" }, px);
            data.receivedViaAccountId = via ? via.id : null;
          }
        } else if (cur.receivedViaAccountId && (accountChange || viaChange)) {
          data.receivedViaAccountId = null;
        }

        if (amountChange) {
          assertConverted(cur);
          const paidK = paidKobo(cur.payments);
          if (wantK < paidK) {
            throw billError(409, "AMOUNT_BELOW_PAID", "The bill can't be less than what is already paid on it.", { paid: naira(paidK) }, "amount");
          }
          data.originalAmount = naira(wantK);
          data.remainingAmount = naira(wantK - paidK);
          data.status = statusOf(wantK, paidK);
        }
        if (!Object.keys(data).length && !itemsChange) return { bill: cur, fields: [], inventory: [] };

        // The goods: the old lines' leave stock and the new ones' come in on
        // the bill's day; or, lines unchanged, their movements move to the
        // bill's new day.
        let touched = new Set();
        if (itemsChange) {
          const out = await removeItems(px, cur);
          const back = await writeItems(px, cur, ask.items.lines, data.billDate || cur.billDate, req.user.id);
          touched = new Set([...out, ...back]);
        } else if (data.billDate && cur.items.length) {
          await px.stockMovement.updateMany({
            where: { businessId: cur.businessId, sourceKey: { in: cur.items.map((i) => `bill:${i.id}`) } },
            data: { date: data.billDate },
          });
        }

        const fields = Object.keys(data);
        if (itemsChange) fields.push("items");
        // Touched even when only its lines changed, so a write racing this one
        // sees the bill changed.
        const moved = await px.businessDebt.updateMany({
          where: { id: cur.id, updatedAt: cur.updatedAt },
          data: Object.keys(data).length ? data : { updatedAt: new Date() },
        });
        if (moved.count !== 1) throw billChanged();
        return {
          bill: await px.businessDebt.findUnique({ where: { id: cur.id }, include: BILL_FULL }),
          fields,
          before: { amount: cur.originalAmount, accountId: cur.accountId, billDate: cur.billDate, lines: cur.items.length },
          inventory: await itemRows(req, px, touched),
        };
      }, TX),
    );

    if (result.fields.length) {
      invalidateLedger(found.biz.id);
      logBill(req, "BILL_UPDATE", found.id, { fields: result.fields, before: result.before });
    }
    res.json({ bill: viewBill(req, result.bill), inventory: result.inventory });
  } catch (err) {
    sendError(res, err, "Failed to update the bill");
  }
});

// ── DELETE /bills/:id (owner only) ───────────────────────────────────────────
// The bill and its payments go; every debit a payment named is freed and
// counts on its own again. Refused when the bill's day, or a day a payment
// counts on, is locked. A restock's goods leave stock again (refused with 409
// STOCK_ALREADY_SOLD when some have been sold since).
router.delete("/:id", ownerOnly("Only the business owner can delete a bill."), async (req, res) => {
  try {
    const found = await ownedBill(req);
    if (!found) throw billNotFound();
    const result = await prisma.withBusinessLock(found.biz.id, () =>
      prisma.$transaction(async (px) => {
        const bill = await freshBill(px, found);
        await assertUnlockedIn(px, bill.businessId, bill.billDate, countedPaymentDays(bill));
        const touched = await removeItems(px, bill);
        const transactions = [];
        for (const p of bill.payments) {
          const freed = await freeDebit(px, p.transactionId, bill.id);
          if (freed) transactions.push(freed);
        }
        const gone = await px.businessDebt.deleteMany({ where: { id: bill.id, updatedAt: bill.updatedAt } });
        if (gone.count !== 1) throw billChanged();
        return { bill, transactions, inventory: await itemRows(req, px, touched) };
      }, TX),
    );

    invalidateLedger(found.biz.id);
    logBill(req, "BILL_DELETE", found.id, {
      businessId: found.biz.id,
      amount: result.bill.originalAmount,
      paid: naira(paidKobo(result.bill.payments)),
      freedTransactions: result.transactions.map((t) => t.id),
      lines: result.bill.items.length,
    });
    res.json({ deleted: found.id, transactions: result.transactions.map(asDebit), inventory: result.inventory });
  } catch (err) {
    sendError(res, err, "Failed to delete the bill");
  }
});

// ── POST /bills/:id/payments ─────────────────────────────────────────────────
// At most what the bill still owes. From the KashBook account (method "bank")
// the payment names the debit that paid it: this business's transfer out of
// the KashBook account (debitRefusal), not explained by anything else, and at
// least the payment. It is dated when the money left, and the debit carries
// the link (matchedBillId) and the amount (matchedAmount). Paying a bill
// dated on or before the lock date is fine; the payment's own day must be
// open.
router.post("/:id/payments", requirePermission("canManagePayables"), async (req, res) => {
  try {
    const body = req.body || {};
    const amountK = readAmount(body.amount);
    // No date is today; a payment from the KashBook account takes the debit's.
    const pay = readPayment(req, body);
    const found = await ownedBill(req);
    if (!found) throw billNotFound();

    const result = await prisma.withBusinessLock(found.biz.id, () =>
      prisma.$transaction(async (px) => {
        const bill = await freshBill(px, found);
        assertConverted(bill);
        const paid = await payBill(px, req, found.biz, bill, amountK, pay, null);
        return {
          bill: await px.businessDebt.findUnique({ where: { id: bill.id }, include: BILL_FULL }),
          payment: paid.payment,
          transaction: paid.transaction,
        };
      }),
    );

    invalidateLedger(found.biz.id);
    logBill(req, "BILL_PAYMENT", found.id, {
      paymentId: result.payment.id, amount: result.payment.amount, method: pay.method, transactionId: result.payment.transactionId,
    });
    res.status(201).json({ bill: viewBill(req, result.bill), payment: result.payment, transaction: asDebit(result.transaction) });
  } catch (err) {
    sendError(res, err, "Failed to record the payment");
  }
});

// ── DELETE /bills/:id/payments/:paymentId (owner only) ───────────────────────
// Takes a payment back: the bill owes it again, and a debit it named is freed
// and counts on its own again. The payment's day must be open; for the
// estimated payment of a bill from before bills, which counts nowhere, the
// bill's own day, since the bill's open part on that day grows by it.
router.delete("/:id/payments/:paymentId", ownerOnly("Only the business owner can remove a payment."), async (req, res) => {
  try {
    const found = await ownedBill(req);
    if (!found) throw billNotFound();
    const paymentId = String(req.params.paymentId);
    const result = await prisma.withBusinessLock(found.biz.id, () =>
      prisma.$transaction(async (px) => {
        const bill = await freshBill(px, found);
        const p = bill.payments.find((x) => x.id === paymentId);
        if (!p) throw billError(404, "PAYMENT_NOT_FOUND", "Payment not found.");
        await assertUnlockedIn(px, bill.businessId, p.outsideBooks ? bill.billDate : p.date);
        await px.billPayment.delete({ where: { id: p.id } });
        const transaction = await freeDebit(px, p.transactionId, bill.id);
        const amountBillK = toKobo(bill.originalAmount);
        const newPaidK = paidKobo(bill.payments) - toKobo(p.amount);
        const moved = await px.businessDebt.updateMany({
          where: { id: bill.id, updatedAt: bill.updatedAt },
          data: { remainingAmount: naira(amountBillK - newPaidK), status: statusOf(amountBillK, newPaidK) },
        });
        if (moved.count !== 1) throw billChanged();
        return {
          bill: await px.businessDebt.findUnique({ where: { id: bill.id }, include: BILL_FULL }),
          payment: p,
          transaction,
        };
      }),
    );

    invalidateLedger(found.biz.id);
    logBill(req, "BILL_PAYMENT_DELETE", found.id, {
      paymentId, amount: result.payment.amount, method: result.payment.method,
      freedTransaction: result.transaction ? result.transaction.id : null,
    });
    res.json({ bill: viewBill(req, result.bill), transaction: asDebit(result.transaction) });
  } catch (err) {
    sendError(res, err, "Failed to remove the payment");
  }
});

module.exports = router;
