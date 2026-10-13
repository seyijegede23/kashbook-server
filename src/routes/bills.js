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
//   POST   /bills                         → 201 { bill: Bill }
//          { businessId, vendorName, accountId, amount, billDate?, dueDate?,
//            billNumber?, note?, receivedViaAccountId? }
//   PATCH  /bills/:id                     → { bill: Bill }
//          any of the POST fields except businessId; only the fields sent change
//   DELETE /bills/:id                     → { deleted: id, transactions: [debits freed] }
//   POST   /bills/:id/payments            → 201 { bill: Bill, payment: Payment, transaction: debit | null }
//          { amount, method, date?, paidThroughAccountId?, transactionId?, note? }
//   DELETE /bills/:id/payments/:paymentId → { bill: Bill, transaction: debit freed | null }
//
// Bill: every BusinessDebt column (id, businessId, name, type, originalAmount,
// remainingAmount, status, billDate, dueDate, billNumber, accountId,
// receivedViaAccountId, estimated, note, createdById, createdAt, updatedAt,
// ...) plus vendorName (= name), amount (= originalAmount), amountPaid,
// balance (= remainingAmount, what is still owed) and payments, oldest first.
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
//   - method: cash, transfer (from another bank account), pos, cheque, other,
//     or bank (from the KashBook account: transactionId names the debit, the
//     provider's own transfer out of that account and never a row typed in by
//     hand, and the payment is dated when the money left).
//     paidThroughAccountId (context "money") says which account paid, for any
//     method but bank.
//
// Refusals are { error, code, field?, ...extra }:
//   400 BUSINESS_REQUIRED, VENDOR_REQUIRED, BAD_AMOUNT, BAD_DATE,
//       ACCOUNT_REQUIRED, BAD_METHOD, TRANSACTION_REQUIRED, NOT_OUTGOING
//       (money in, or a row that is not a transfer out of the KashBook
//       account), PAID_IN_FULL, EXCEEDS_BALANCE { balance }, EXCEEDS_TRANSFER
//       { transferAmount }, and the account refusals ACCOUNT_NOT_FOUND and
//       ACCOUNT_NOT_ALLOWED (utils/ledgerData.js assertAccountUsable)
//   403 PERMISSION_DENIED { permission }, OWNER_ONLY, or Forbidden (a business
//       that is not the caller's)
//   404 BILL_NOT_FOUND, PAYMENT_NOT_FOUND, TRANSACTION_NOT_FOUND
//   409 BOOKS_LOCKED { lockDate }, AMOUNT_BELOW_PAID { paid },
//       TRANSACTION_TAKEN, CURRENCY_MISMATCH, BILL_CHANGED, BILL_NOT_CONVERTED
const router = require("express").Router();
const auth = require("../middleware/auth");
const prisma = require("../utils/db");
const chart = require("../utils/chart");
const { requirePermission, ownerOnly } = require("../middleware/requirePermission");
const { ownerIdOf } = require("../utils/scope");
const { assertAccountUsable, invalidateLedger } = require("../utils/ledgerData");
const { assertUnlockedIn } = require("../utils/booksLock");
const { audit } = require("../utils/audit");
const { toKobo } = require("../utils/money");
const { BILL_INCLUDE, billFor } = require("../utils/billView");
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
  const bill = await px.businessDebt.findUnique({ where: { id: found.id }, include: BILL_INCLUDE });
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

// ── GET /bills?businessId= ───────────────────────────────────────────────────
router.get("/", requirePermission("canManagePayables"), async (req, res) => {
  try {
    const { businessId } = req.query;
    if (!businessId) return res.status(400).json({ error: "businessId required", code: "BUSINESS_REQUIRED" });
    const biz = await ownedBusiness(req, businessId);
    if (!biz) return res.status(403).json({ error: "Forbidden" });
    const bills = await prisma.businessDebt.findMany({
      where: { businessId: biz.id, userId: ownerIdOf(req) },
      include: BILL_INCLUDE,
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
    const bill = await prisma.businessDebt.findUnique({ where: { id: found.id }, include: BILL_INCLUDE });
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
    const amountK = readAmount(body.amount);
    if (!body.accountId) throw accountRequired();
    // No bill date is today. A due date is optional.
    const billDate = body.billDate == null || body.billDate === "" ? new Date() : readDate(body.billDate, "billDate");
    const dueDate = body.dueDate === undefined ? null : readDate(body.dueDate, "dueDate");
    const billNumber = readText(body.billNumber, 50);
    const note = readText(body.note, 500);

    // The account is checked under the lock an account merge or delete also
    // takes (routes/ledger.js), so it is still there when the bill names it.
    const bill = await prisma.withBusinessLock(biz.id, () =>
      prisma.$transaction(async (px) => {
        await assertUnlockedIn(px, biz.id, billDate);
        const account = await assertAccountUsable(biz.id, body.accountId, "bill", { isStaff, field: "accountId" }, px);
        // Where borrowed money went: only a bill on a liability has it.
        const via = isLiability(account)
          ? await assertAccountUsable(biz.id, body.receivedViaAccountId, "money", { isStaff, field: "receivedViaAccountId" }, px)
          : null;
        return px.businessDebt.create({
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
          include: BILL_INCLUDE,
        });
      }),
    );

    invalidateLedger(biz.id);
    logBill(req, "BILL_CREATE", bill.id, { businessId: biz.id, amount: bill.originalAmount, accountId: bill.accountId });
    res.status(201).json({ bill: viewBill(req, bill) });
  } catch (err) {
    sendError(res, err, "Failed to add the bill");
  }
});

// ── PATCH /bills/:id ─────────────────────────────────────────────────────────
// Only the fields sent change. Any change touches the bill's own day (and the
// new one when it moves), so a bill dated on or before the lock date stays as
// it is. A new account changes how every payment counts, so their days are
// checked too. The amount is never below what is already paid.
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

    const result = await prisma.withBusinessLock(found.biz.id, () =>
      prisma.$transaction(async (px) => {
        const cur = await freshBill(px, found);
        const data = {};
        if (ask.name !== undefined && ask.name !== cur.name) data.name = ask.name;
        if (ask.billDate !== undefined && !sameTime(ask.billDate, cur.billDate)) data.billDate = ask.billDate;
        if (ask.dueDate !== undefined && !sameTime(ask.dueDate, cur.dueDate)) data.dueDate = ask.dueDate;
        if (ask.billNumber !== undefined && ask.billNumber !== cur.billNumber) data.billNumber = ask.billNumber;
        if (ask.note !== undefined && ask.note !== cur.note) data.note = ask.note;
        const amountChange = ask.amountK !== undefined && ask.amountK !== toKobo(cur.originalAmount);
        const accountChange = ask.accountId !== undefined && ask.accountId !== cur.accountId;
        // The account. One the bill names already is taken as it is, even if
        // the owner has since rested it, so an edit of other fields saves.
        let account = cur.accountId ? await px.ledgerAccount.findUnique({ where: { id: cur.accountId } }) : null;
        // Where the money went changes only on a bill that can keep it (one on
        // a liability, or moving to another account), or to let one go.
        const viaChange = ask.receivedViaAccountId !== undefined && ask.receivedViaAccountId !== cur.receivedViaAccountId &&
          (accountChange || isLiability(account) || !!cur.receivedViaAccountId);
        if (!Object.keys(data).length && !amountChange && !accountChange && !viaChange) return { bill: cur, fields: [] };

        // The bill's own day, and the day it moves to.
        await assertUnlockedIn(px, cur.businessId, cur.billDate, data.billDate);

        if (accountChange) {
          account = await assertAccountUsable(cur.businessId, ask.accountId, "bill", { isStaff, field: "accountId" }, px);
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
          if (ask.amountK < paidK) {
            throw billError(409, "AMOUNT_BELOW_PAID", "The bill can't be less than what is already paid on it.", { paid: naira(paidK) }, "amount");
          }
          data.originalAmount = naira(ask.amountK);
          data.remainingAmount = naira(ask.amountK - paidK);
          data.status = statusOf(ask.amountK, paidK);
        }
        if (!Object.keys(data).length) return { bill: cur, fields: [] };

        const moved = await px.businessDebt.updateMany({ where: { id: cur.id, updatedAt: cur.updatedAt }, data });
        if (moved.count !== 1) throw billChanged();
        return {
          bill: await px.businessDebt.findUnique({ where: { id: cur.id }, include: BILL_INCLUDE }),
          fields: Object.keys(data),
          before: { amount: cur.originalAmount, accountId: cur.accountId, billDate: cur.billDate },
        };
      }),
    );

    if (result.fields.length) {
      invalidateLedger(found.biz.id);
      logBill(req, "BILL_UPDATE", found.id, { fields: result.fields, before: result.before });
    }
    res.json({ bill: viewBill(req, result.bill) });
  } catch (err) {
    sendError(res, err, "Failed to update the bill");
  }
});

// ── DELETE /bills/:id (owner only) ───────────────────────────────────────────
// The bill and its payments go; every debit a payment named is freed and
// counts on its own again. Refused when the bill's day, or a day a payment
// counts on, is locked.
router.delete("/:id", ownerOnly("Only the business owner can delete a bill."), async (req, res) => {
  try {
    const found = await ownedBill(req);
    if (!found) throw billNotFound();
    const result = await prisma.withBusinessLock(found.biz.id, () =>
      prisma.$transaction(async (px) => {
        const bill = await freshBill(px, found);
        await assertUnlockedIn(px, bill.businessId, bill.billDate, countedPaymentDays(bill));
        const transactions = [];
        for (const p of bill.payments) {
          const freed = await freeDebit(px, p.transactionId, bill.id);
          if (freed) transactions.push(freed);
        }
        const gone = await px.businessDebt.deleteMany({ where: { id: bill.id, updatedAt: bill.updatedAt } });
        if (gone.count !== 1) throw billChanged();
        return { bill, transactions };
      }),
    );

    invalidateLedger(found.biz.id);
    logBill(req, "BILL_DELETE", found.id, {
      businessId: found.biz.id,
      amount: result.bill.originalAmount,
      paid: naira(paidKobo(result.bill.payments)),
      freedTransactions: result.transactions.map((t) => t.id),
    });
    res.json({ deleted: found.id, transactions: result.transactions });
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
    const isStaff = isStaffReq(req);
    const amountK = readAmount(body.amount);
    const method = body.method === undefined || body.method === null || body.method === ""
      ? "cash"
      : String(body.method).toLowerCase();
    if (!METHODS.includes(method)) throw billError(400, "BAD_METHOD", "Unknown payment method.", null, "method");
    const bank = method === "bank";
    if (bank && !body.transactionId) {
      throw billError(400, "TRANSACTION_REQUIRED", "Pick the transfer that paid this bill.", null, "transactionId");
    }
    if (bank && isStaff && req.user.permissions?.canViewBalance !== true) {
      return res.status(403).json({
        error: "You don't have access to the bank account. Ask the business owner to link this transfer.",
        code: "PERMISSION_DENIED",
        permission: "canViewBalance",
      });
    }
    // No date is today; a payment from the KashBook account takes the debit's.
    const when = bank ? null : body.date == null || body.date === "" ? new Date() : readDate(body.date, "date");
    const note = readText(body.note, 200);
    const found = await ownedBill(req);
    if (!found) throw billNotFound();

    const result = await prisma.withBusinessLock(found.biz.id, () =>
      prisma.$transaction(async (px) => {
        const bill = await freshBill(px, found);
        assertConverted(bill);
        const amountBillK = toKobo(bill.originalAmount);
        const paidK = paidKobo(bill.payments);
        const balanceK = amountBillK - paidK;
        if (balanceK <= 0) throw billError(400, "PAID_IN_FULL", "This bill is already paid in full.");
        if (amountK > balanceK) {
          throw billError(400, "EXCEEDS_BALANCE", "That is more than the bill still owes.", { balance: naira(balanceK) }, "amount");
        }

        let tx = null;
        let paidThrough = null;
        if (bank) {
          tx = await px.transaction.findUnique({ where: { id: String(body.transactionId) } });
          const refused = debitRefusal(tx, found.biz);
          if (refused) throw refused;
          if (amountK > toKobo(tx.amount)) {
            throw billError(400, "EXCEEDS_TRANSFER", "That is more than the transfer.", { transferAmount: Number(tx.amount) }, "amount");
          }
        } else {
          paidThrough = await assertAccountUsable(bill.businessId, body.paidThroughAccountId, "money", { isStaff, field: "paidThroughAccountId" }, px);
        }
        const date = bank ? tx.date : when;
        await assertUnlockedIn(px, bill.businessId, date);

        // The debit first, and only if nothing took it since it was read.
        if (bank) {
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
            method,
            paidThroughAccountId: paidThrough ? paidThrough.id : null,
            transactionId: bank ? tx.id : null,
            note,
            createdById: req.user.id,
          },
        });
        const newPaidK = paidK + amountK;
        const moved = await px.businessDebt.updateMany({
          where: { id: bill.id, updatedAt: bill.updatedAt },
          data: { remainingAmount: naira(amountBillK - newPaidK), status: statusOf(amountBillK, newPaidK) },
        });
        if (moved.count !== 1) throw billChanged();
        return {
          bill: await px.businessDebt.findUnique({ where: { id: bill.id }, include: BILL_INCLUDE }),
          payment,
          transaction: bank ? await px.transaction.findUnique({ where: { id: tx.id } }) : null,
        };
      }),
    );

    invalidateLedger(found.biz.id);
    logBill(req, "BILL_PAYMENT", found.id, {
      paymentId: result.payment.id, amount: result.payment.amount, method, transactionId: result.payment.transactionId,
    });
    res.status(201).json({ bill: viewBill(req, result.bill), payment: result.payment, transaction: result.transaction });
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
          bill: await px.businessDebt.findUnique({ where: { id: bill.id }, include: BILL_INCLUDE }),
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
    res.json({ bill: viewBill(req, result.bill), transaction: result.transaction });
  } catch (err) {
    sendError(res, err, "Failed to remove the payment");
  }
});

module.exports = router;
