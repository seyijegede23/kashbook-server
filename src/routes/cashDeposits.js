// Deposit cash (2026-10-14): cash at hand the owner takes to a bank.
//
//   GET    /cash-deposits?businessId=          { deposits } newest first
//   POST   /cash-deposits                      { deposit, transaction } (201; 200 for a retry)
//   PATCH  /cash-deposits/:id                  { deposit, transaction }
//   POST   /cash-deposits/:id/cancel           { deposit }
//   POST   /cash-deposits/:id/undo             { deposit, transaction }
//   POST   /cash-deposits/:id/link             { deposit, transaction }
//   GET    /cash-deposits/:id/candidates       { transactions }
//
// The owner's only in this release (staff: 403 OWNER_ONLY). A deposit into
// another bank ("account") is done at once; one into the KashBook account
// ("kashbook") waits for the transfer that brings the cash in, which the
// server links by itself when it arrives (utils/cashDeposits.js), or which
// the owner picks. `transaction` in a reply is that credit as it now is (its
// purpose changes with the link), or null, so the app can put both in place.
//
// Refusals are { error, code, field?, ...extra }:
//   400 BAD_AMOUNT, BAD_DATE, ACCOUNT_NOT_ALLOWED (field into or
//       intoAccountId; on into, reason NO_KASHBOOK_ACCOUNT for a business
//       that has no KashBook account), TRANSACTION_REQUIRED
//   403 OWNER_ONLY
//   404 BUSINESS_NOT_FOUND, DEPOSIT_NOT_FOUND, TRANSACTION_NOT_FOUND
//   409 DEPOSIT_ARRIVED (undo it first), DEPOSIT_CANCELLED,
//       DEPOSIT_NOT_KASHBOOK (a deposit into another bank has no transfer),
//       NOT_ELIGIBLE with `reason` (AMOUNT, MATCHED, PURPOSE, LINKED,
//       NOT_BANK, BEFORE), BOOKS_LOCKED with `lockDate`, DEPOSIT_CHANGED
//
// The books lock: recording, editing and cancelling a deposit move its own
// entry, so they ask about the deposit's day (the day it is on, and the day
// it moves to). Linking and undoing change only what the transfer counts as,
// on the transfer's own day, so they ask about that day alone, as does the
// candidates list (utils/cashDeposits.js linkLocked).
//
// Every write runs under the business lock in one transaction, clears the
// business's cached ledger (the bank balance is Anchor's, never touched
// here), and is audited.
const router = require("express").Router();
const auth = require("../middleware/auth");
const { ownerOnly } = require("../middleware/requirePermission");
const prisma = require("../utils/db");
const books = require("../utils/books");
const chart = require("../utils/chart");
const { audit } = require("../utils/audit");
const { twoDecimals, toKobo } = require("../utils/money");
const { assertUnlockedIn, lockDateOf } = require("../utils/booksLock");
const { invalidateLedger } = require("../utils/ledgerData");
const deposits = require("../utils/cashDeposits");

const { DEPOSIT_INCLUDE, depositError, publicDeposit } = deposits;

router.use(auth);
router.use(ownerOnly("Only the business owner can record cash deposits."));

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const NOTE_MAX = 500;
const REF_MAX = 200;
// Far above any cash a shop banks; keeps the amount a plain number.
const AMOUNT_MAX = 1e11;

function sendError(res, err, what) {
  if (err && err.status && err.code) {
    return res.status(err.status).json({
      error: err.message, code: err.code, ...(err.field ? { field: err.field } : {}), ...(err.extra || {}),
    });
  }
  console.error(`[cashDeposits] ${what}:`, err);
  return res.status(500).json({ error: "Something went wrong with the deposit. Please try again." });
}

// What a deposit reads of its business: the owner, the currency, and its
// KashBook account (hasKashBook).
const BUSINESS_FIELDS = { id: true, userId: true, baseCurrency: true, anchorAccountId: true, virtualAccountNumber: true };

// The owner's own business, or 404.
async function loadBusiness(req, businessId) {
  if (typeof businessId !== "string" || !businessId) {
    throw depositError(404, "BUSINESS_NOT_FOUND", "Business not found.");
  }
  const biz = await prisma.business.findFirst({
    where: { id: businessId, userId: req.user.id },
    select: BUSINESS_FIELDS,
  });
  if (!biz) throw depositError(404, "BUSINESS_NOT_FOUND", "Business not found.");
  return biz;
}

// A deposit in one of the owner's businesses, or 404 (another owner's is
// "not found", like one that does not exist).
async function loadDeposit(req, id) {
  const dep = await prisma.cashDeposit.findUnique({
    where: { id: String(id) },
    include: { business: { select: BUSINESS_FIELDS } },
  });
  if (!dep || !dep.business || dep.business.userId !== req.user.id) {
    throw depositError(404, "DEPOSIT_NOT_FOUND", "Deposit not found.");
  }
  return dep;
}

// The business has its KashBook account: a number the cash can be paid into,
// the same test the app makes before it offers KashBook. A business with the
// number whose provider account id is missing (a failed account.creation
// webhook, mended by sync-anchor-account) still gets its credits once it is
// mended, and the poller then links them, so the deposit may wait for it.
const hasKashBook = (biz) => !!(biz && biz.virtualAccountNumber);
const noKashBook = () =>
  depositError(400, "ACCOUNT_NOT_ALLOWED", "This business has no KashBook account yet. Choose the bank the cash went into.", {
    field: "into", reason: "NO_KASHBOOK_ACCOUNT",
  });

// ── What a request says ──────────────────────────────────────────────────────

// Naira and kobo, more than zero.
function readAmount(v) {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isFinite(n) || n <= 0 || n > AMOUNT_MAX || !twoDecimals(n) || toKobo(n) <= 0) {
    throw depositError(400, "BAD_AMOUNT", "Enter the amount you deposited, in naira and kobo.", { field: "amount" });
  }
  return toKobo(n) / 100;
}

// The day the cash was taken: "YYYY-MM-DD" (kept as that day's start in UTC,
// which the books read as the same Lagos day, as a journal's day is kept) or a
// moment (kept as it is, read by its Lagos day). Never after today.
function readDate(v) {
  let when;
  if (typeof v === "string" && DAY.test(v.trim())) {
    const day = v.trim();
    when = new Date(`${day}T00:00:00.000Z`);
    if (Number.isNaN(when.getTime()) || when.toISOString().slice(0, 10) !== day) when = null;
  } else if (typeof v === "string" || typeof v === "number") {
    when = new Date(v);
  }
  const day = when && !Number.isNaN(when.getTime()) ? books.dayKey(when) : "";
  if (!day || day < "1900-01-01") {
    throw depositError(400, "BAD_DATE", "Choose the day you took the cash to the bank.", { field: "date" });
  }
  if (day > books.dayKey(new Date())) {
    throw depositError(400, "BAD_DATE", "A deposit can't be dated after today.", { field: "date" });
  }
  return when;
}

function readInto(v) {
  if (v === "kashbook" || v === "account") return v;
  throw depositError(400, "ACCOUNT_NOT_ALLOWED", "Choose where the cash went.", { field: "into" });
}

// undefined when not sent (an edit keeps it), null when cleared.
function readNote(v) {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const note = String(v).trim().slice(0, NOTE_MAX);
  return note || null;
}

function readClientRef(v) {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const ref = String(v).trim().slice(0, REF_MAX);
  return ref || null;
}

// The bank the cash went into: one of this business's active bank accounts,
// never the KashBook account (the transfer itself brings the cash there) or
// Bank Matching. Read with the transaction's client, under the business lock
// an account merge or delete also takes (routes/ledger.js).
async function bankAccount(px, businessId, id) {
  const refuse = () => depositError(400, "ACCOUNT_NOT_ALLOWED", "Choose the bank the cash went into.", { field: "intoAccountId" });
  if (typeof id !== "string" || !id) throw refuse();
  const acc = await px.ledgerAccount.findFirst({ where: { id, businessId } });
  if (!acc || acc.type !== "bank" || !chart.pickerAllows("money", acc)) throw refuse();
  return acc;
}

// The refusal for a deposit that may no longer be changed this way.
function notOpen(dep) {
  if (dep.status === "arrived") {
    return depositError(409, "DEPOSIT_ARRIVED", "This deposit has arrived. Undo it first.");
  }
  if (dep.status === "cancelled") return depositError(409, "DEPOSIT_CANCELLED", "This deposit was cancelled.");
  return null;
}
const notKashbook = () =>
  depositError(409, "DEPOSIT_NOT_KASHBOOK", "This deposit went into another bank, so it has no KashBook transfer.");

// One round of a write: under the business lock, in one transaction.
const write = (businessId, fn) => prisma.withBusinessLock(businessId, () => prisma.$transaction(fn, { timeout: 20000 }));

const logged = (req, action, dep, metadata) =>
  audit({ req, action, resourceType: "cashDeposit", resourceId: dep.id, metadata: { businessId: dep.businessId, ...metadata } }).catch(() => {});

// A deposit as an audit row records it: what moves money, and its day.
const auditShape = (d) => ({
  amount: Number(d.amount), date: books.dayKey(d.date), into: d.into, intoAccountId: d.intoAccountId || null, status: d.status,
});

// ── Reading ─────────────────────────────────────────────────────────────────

router.get("/", async (req, res) => {
  try {
    const biz = await loadBusiness(req, req.query.businessId);
    const rows = await prisma.cashDeposit.findMany({
      where: { businessId: biz.id },
      include: DEPOSIT_INCLUDE,
      orderBy: [{ date: "desc" }, { createdAt: "desc" }],
    });
    res.json({ deposits: rows.map(publicDeposit) });
  } catch (err) {
    sendError(res, err, "list");
  }
});

// The transfers the owner may pick for a waiting KashBook deposit ("Pick the
// transfer"): this business's KashBook credits of the deposit's amount, from
// the deposit's day on, that nothing explains yet or that the owner marked as
// cash banked (each comes with its `purpose`, "cash_deposit" for those), on a
// day the books lock leaves open (the transfer's own day: a deposit dated in
// the locked part of the books still takes one), oldest first; one the owner
// took off this deposit before comes too, flagged `rejected`. Any other
// deposit has none.
router.get("/:id/candidates", async (req, res) => {
  try {
    const dep = await loadDeposit(req, req.params.id);
    if (dep.status !== "waiting" || dep.into !== "kashbook") return res.json({ transactions: [] });
    const base = dep.business.baseCurrency || "NGN";
    const from = books.dayKey(dep.date);
    const [list, lockDate, cashAccountId] = await Promise.all([
      deposits.creditsOfAmount(prisma, dep.businessId, dep.amount, base, { from }),
      lockDateOf(dep.businessId),
      deposits.cashAccountIdOf(prisma, dep.businessId),
    ]);
    const rejected = new Set(Array.isArray(dep.rejectedTransactionIds) ? dep.rejectedTransactionIds.map(String) : []);
    const transactions = list
      .filter(({ tx, linkedTo }) =>
        !deposits.creditRefusal(tx, dep, { base, linkedTo, cashAccountId }) && !deposits.linkLocked(lockDate, tx))
      // None is a deposit's yet (cashDepositId, as every bank row carries it).
      .map(({ tx }) => ({ ...tx, purpose: tx.purpose || null, cashDepositId: null, rejected: rejected.has(tx.id) }));
    res.json({ transactions });
  } catch (err) {
    sendError(res, err, "candidates");
  }
});

// ── Writing ─────────────────────────────────────────────────────────────────

// { businessId, amount, date, into, intoAccountId?, note?, clientRef? }. A
// deposit into the KashBook account (only for a business that has one) takes
// the oldest eligible transfer that already arrived at once. A retry with the
// same clientRef answers 200 with the first deposit, as it now is.
router.post("/", async (req, res) => {
  try {
    const b = req.body || {};
    const biz = await loadBusiness(req, b.businessId);
    const amount = readAmount(b.amount);
    const date = b.date === undefined ? new Date() : readDate(b.date);
    const into = readInto(b.into);
    const note = readNote(b.note);
    const clientRef = readClientRef(b.clientRef);
    const base = biz.baseCurrency || "NGN";

    const again = async (px) => {
      const first = clientRef
        ? await px.cashDeposit.findUnique({ where: { businessId_clientRef: { businessId: biz.id, clientRef } }, include: DEPOSIT_INCLUDE })
        : null;
      if (!first) return null;
      const credit = first.transactionId ? await px.transaction.findUnique({ where: { id: first.transactionId } }) : null;
      return { retry: true, deposit: first, transaction: credit && { ...credit, cashDepositId: first.id } };
    };

    let result;
    try {
      result = await write(biz.id, async (px) => {
        const first = await again(px);
        if (first) return first;
        if (into === "kashbook" && !hasKashBook(biz)) throw noKashBook();
        const acc = into === "account" ? await bankAccount(px, biz.id, b.intoAccountId) : null;
        // The lock date: the deposit's own day, where its entry lands.
        await assertUnlockedIn(px, biz.id, date);
        const made = await px.cashDeposit.create({
          data: {
            businessId: biz.id, amount, date, into, intoAccountId: acc ? acc.id : null,
            status: into === "kashbook" ? "waiting" : "done",
            note: note === undefined ? null : note, clientRef, createdById: req.user.id,
          },
          include: DEPOSIT_INCLUDE,
        });
        const linked = await deposits.lookBack(px, made, { base });
        return linked ? { ...linked, linked: true } : { deposit: made, transaction: null, linked: false };
      });
    } catch (err) {
      // Two retries at the same moment: the second finds the first.
      if (err && err.code === "P2002" && clientRef) result = await again(prisma);
      if (!result) throw err;
    }

    if (result.retry) {
      return res.status(200).json({ deposit: publicDeposit(result.deposit), transaction: result.transaction });
    }
    invalidateLedger(biz.id);
    // The day too: the first day the cash was said to leave the till stays on
    // record whatever later edits do. The note's words stay out of the audit
    // log, which is kept for years and never purged.
    logged(req, "CASH_DEPOSIT_CREATE", result.deposit, {
      amount, date: books.dayKey(result.deposit.date), into, intoAccountId: result.deposit.intoAccountId,
    });
    if (result.linked) {
      logged(req, "CASH_DEPOSIT_AUTO_LINK", result.deposit, {
        transactionId: result.transaction.id, amount: Number(result.transaction.amount), when: "recorded",
      });
    }
    res.status(201).json({ deposit: publicDeposit(result.deposit), transaction: result.transaction });
  } catch (err) {
    sendError(res, err, "create");
  }
});

// { amount?, date?, into?, intoAccountId?, note? } on a waiting or done
// deposit. Its status follows `into`: a KashBook one waits (and takes an
// eligible transfer that already arrived), one into another bank is done. A
// deposit becomes a KashBook one only for a business that has its KashBook
// account; one that already is stays editable.
router.patch("/:id", async (req, res) => {
  try {
    const b = req.body || {};
    const dep0 = await loadDeposit(req, req.params.id);
    const amount = b.amount === undefined ? undefined : readAmount(b.amount);
    const date = b.date === undefined ? undefined : readDate(b.date);
    const into0 = b.into === undefined ? undefined : readInto(b.into);
    const note = readNote(b.note);
    const base = dep0.business.baseCurrency || "NGN";

    const result = await write(dep0.businessId, async (px) => {
      const cur = await px.cashDeposit.findUnique({ where: { id: dep0.id } });
      if (!cur) throw depositError(404, "DEPOSIT_NOT_FOUND", "Deposit not found.");
      const closed = notOpen(cur);
      if (closed) throw closed;
      const into = into0 || cur.into;
      if (into === "kashbook" && cur.into !== "kashbook" && !hasKashBook(dep0.business)) throw noKashBook();
      let intoAccountId = null;
      if (into === "account") {
        // The account it went into, checked when it changes (one the owner
        // has since made inactive stays where the deposit went).
        const named = b.intoAccountId !== undefined || cur.into !== "account";
        intoAccountId = named
          ? (await bankAccount(px, cur.businessId, b.intoAccountId !== undefined ? b.intoAccountId : null)).id
          : cur.intoAccountId;
      }
      const newDate = date || cur.date;
      // The lock date: the day the deposit is on, and the day it moves to.
      await assertUnlockedIn(px, cur.businessId, cur.date, newDate);
      const status = into === "kashbook" ? "waiting" : "done";
      const moved = await px.cashDeposit.updateMany({
        where: { id: cur.id, status: cur.status },
        data: {
          amount: amount === undefined ? cur.amount : amount,
          date: newDate,
          into,
          intoAccountId,
          status,
          ...(note !== undefined ? { note } : {}),
        },
      });
      if (moved.count !== 1) throw depositError(409, "DEPOSIT_CHANGED", "This deposit just changed. Please try again.");
      const updated = await px.cashDeposit.findUnique({ where: { id: cur.id }, include: DEPOSIT_INCLUDE });
      const linked = await deposits.lookBack(px, updated, { base });
      return linked ? { ...linked, linked: true, was: cur } : { deposit: updated, transaction: null, linked: false, was: cur };
    });

    invalidateLedger(dep0.businessId);
    // The deposit before and after the edit, the day included, so the days
    // it was on can all be read back from the audit trail; `fields` names what
    // actually changed (a value sent again unchanged is not), the note by
    // name only (its words stay out of the audit log, as on create).
    const was = result.was;
    const now = result.deposit;
    logged(req, "CASH_DEPOSIT_UPDATE", now, {
      fields: [
        ["amount", toKobo(was.amount) !== toKobo(now.amount)],
        ["date", new Date(was.date).getTime() !== new Date(now.date).getTime()],
        ["into", was.into !== now.into],
        ["intoAccountId", (was.intoAccountId || null) !== (now.intoAccountId || null)],
        ["note", (was.note || null) !== (now.note || null)],
      ].filter(([, changed]) => changed).map(([k]) => k),
      from: auditShape(was),
      to: auditShape(now),
    });
    if (result.linked) {
      logged(req, "CASH_DEPOSIT_AUTO_LINK", result.deposit, {
        transactionId: result.transaction.id, amount: Number(result.transaction.amount), when: "changed",
      });
    }
    res.json({ deposit: publicDeposit(result.deposit), transaction: result.transaction });
  } catch (err) {
    sendError(res, err, "update");
  }
});

// A waiting or done deposit is cancelled (it posts nothing from now on); one
// already cancelled answers as it is. An arrived one is undone first.
router.post("/:id/cancel", async (req, res) => {
  try {
    const dep0 = await loadDeposit(req, req.params.id);
    const result = await write(dep0.businessId, async (px) => {
      const cur = await px.cashDeposit.findUnique({ where: { id: dep0.id } });
      if (!cur) throw depositError(404, "DEPOSIT_NOT_FOUND", "Deposit not found.");
      if (cur.status === "arrived") throw notOpen(cur);
      if (cur.status === "cancelled") {
        return { deposit: await px.cashDeposit.findUnique({ where: { id: cur.id }, include: DEPOSIT_INCLUDE }), changed: false };
      }
      // The lock date: the deposit leaves its day.
      await assertUnlockedIn(px, cur.businessId, cur.date);
      const moved = await px.cashDeposit.updateMany({
        where: { id: cur.id, status: cur.status },
        data: { status: "cancelled", cancelledAt: new Date() },
      });
      if (moved.count !== 1) throw depositError(409, "DEPOSIT_CHANGED", "This deposit just changed. Please try again.");
      return { deposit: await px.cashDeposit.findUnique({ where: { id: cur.id }, include: DEPOSIT_INCLUDE }), changed: true };
    });
    if (result.changed) {
      invalidateLedger(dep0.businessId);
      logged(req, "CASH_DEPOSIT_CANCEL", result.deposit, { amount: Number(result.deposit.amount), into: result.deposit.into });
    }
    res.json({ deposit: publicDeposit(result.deposit) });
  } catch (err) {
    sendError(res, err, "cancel");
  }
});

// An arrived deposit waits again: its transfer is no longer the deposit (it
// is given back what it was, so it counts as it would have without it:
// unexplained, or marked as cash banked when the owner had marked it so
// before the deposit took it) and is never linked to this deposit by itself
// again (rejectedTransactionIds). Nothing is linked on this call. A waiting
// deposit answers as it is.
router.post("/:id/undo", async (req, res) => {
  try {
    const dep0 = await loadDeposit(req, req.params.id);
    const result = await write(dep0.businessId, async (px) => {
      const cur = await px.cashDeposit.findUnique({ where: { id: dep0.id } });
      if (!cur) throw depositError(404, "DEPOSIT_NOT_FOUND", "Deposit not found.");
      if (cur.status === "cancelled") throw notOpen(cur);
      if (cur.into !== "kashbook") throw notKashbook();
      if (cur.status === "waiting") {
        return { deposit: await px.cashDeposit.findUnique({ where: { id: cur.id }, include: DEPOSIT_INCLUDE }), transaction: null, changed: false };
      }
      const tx = await px.transaction.findUnique({ where: { id: cur.transactionId } });
      // The lock date: the transfer's day alone. What it counts as changes
      // there; the deposit's own entry stays as it is.
      await deposits.assertLinkOpen(px, cur.businessId, tx);
      const before = await deposits.creditBefore(px, cur);
      const rejected = Array.isArray(cur.rejectedTransactionIds) ? cur.rejectedTransactionIds.map(String) : [];
      const moved = await px.cashDeposit.updateMany({
        where: { id: cur.id, status: "arrived", transactionId: cur.transactionId },
        data: {
          status: "waiting", transactionId: null, arrivedAt: null, autoLinked: false,
          adoptedPurpose: null, adoptedAccountId: null,
          rejectedTransactionIds: [...new Set([...rejected, cur.transactionId])],
        },
      });
      if (moved.count !== 1) throw depositError(409, "DEPOSIT_CHANGED", "This deposit just changed. Please try again.");
      if (tx) {
        await px.transaction.updateMany({ where: { id: tx.id, purpose: deposits.CASH_DEPOSIT }, data: before });
      }
      const freed = tx ? await px.transaction.findUnique({ where: { id: tx.id } }) : null;
      return {
        deposit: await px.cashDeposit.findUnique({ where: { id: cur.id }, include: DEPOSIT_INCLUDE }),
        transaction: freed && { ...freed, cashDepositId: null },
        changed: true,
        transactionId: cur.transactionId,
        restoredPurpose: before.purpose,
      };
    });
    if (result.changed) {
      invalidateLedger(dep0.businessId);
      // What the transfer was given back: null (unexplained), or
      // "cash_deposit" (the owner's own marking, from before the deposit).
      logged(req, "CASH_DEPOSIT_UNDO", result.deposit, { transactionId: result.transactionId, restoredPurpose: result.restoredPurpose });
    }
    res.json({ deposit: publicDeposit(result.deposit), transaction: result.transaction });
  } catch (err) {
    sendError(res, err, "undo");
  }
});

// { transactionId }: the owner says which transfer brought a waiting
// KashBook deposit in. It must be eligible, except that it may have arrived
// later than three days after the deposit (a slow bank), may be one the
// owner took off this deposit before, and may be one the owner had marked as
// cash banked (the deposit keeps that marking, for an undo). Never one dated
// before the deposit's own day (NOT_ELIGIBLE BEFORE).
router.post("/:id/link", async (req, res) => {
  try {
    const transactionId = req.body && req.body.transactionId;
    if (typeof transactionId !== "string" || !transactionId) {
      throw depositError(400, "TRANSACTION_REQUIRED", "Pick the transfer that brought the cash in.", { field: "transactionId" });
    }
    const dep0 = await loadDeposit(req, req.params.id);
    const base = dep0.business.baseCurrency || "NGN";
    const result = await write(dep0.businessId, async (px) => {
      const cur = await px.cashDeposit.findUnique({ where: { id: dep0.id } });
      if (!cur) throw depositError(404, "DEPOSIT_NOT_FOUND", "Deposit not found.");
      const closed = notOpen(cur);
      if (closed) throw closed;
      if (cur.into !== "kashbook") throw notKashbook();
      const tx = await px.transaction.findUnique({ where: { id: transactionId } });
      if (!tx || tx.businessId !== cur.businessId) {
        throw depositError(404, "TRANSACTION_NOT_FOUND", "That transfer was not found.", { field: "transactionId" });
      }
      const linkedTo = await deposits.depositOfCredit(px, tx.id);
      const cashAccountId = tx.accountId ? await deposits.cashAccountIdOf(px, cur.businessId) : null;
      const reason = deposits.creditRefusal(tx, cur, { base, linkedTo, cashAccountId });
      if (reason) {
        throw depositError(409, "NOT_ELIGIBLE", "That transfer can't be this deposit.", { reason, field: "transactionId" });
      }
      // The lock date: the transfer's day alone. What it counts as changes
      // there; the deposit's own entry stays as it is.
      await deposits.assertLinkOpen(px, cur.businessId, tx);
      return deposits.linkCredit(px, cur, tx, { autoLinked: false });
    });
    invalidateLedger(dep0.businessId);
    logged(req, "CASH_DEPOSIT_LINK", result.deposit, {
      transactionId: result.transaction.id, amount: Number(result.transaction.amount),
      adoptedPurpose: result.deposit.adoptedPurpose || null,
    });
    res.json({ deposit: publicDeposit(result.deposit), transaction: result.transaction });
  } catch (err) {
    sendError(res, err, "link");
  }
});

module.exports = router;
