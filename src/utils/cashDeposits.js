// Deposit cash (2026-10-14): the owner takes cash from the till to a bank.
//
// A deposit moves the business's own money from Cash at Hand to a bank. It is
// never a sale and never spending, so the books rule (utils/books.js) does not
// read it; the ledger posts it (utils/ledger.js, loaded by
// utils/ledgerData.js). A deposit into another bank is done at once. A deposit
// into the KashBook account waits for the transfer that brings the cash in,
// and that transfer is found here, by the server itself:
//
//   - an ELIGIBLE credit for a waiting KashBook deposit is this business's
//     money in, a provider row the ledger posts to the KashBook Account
//     (config/moneySources.isLedgerBankRow, in the business's currency), of
//     the deposit's amount to the kobo, not explained in any way (no purpose,
//     no account, no match) and not another deposit's, dated (its Lagos day)
//     from the deposit's day to three days after it, and not one the owner
//     took off this deposit before (rejectedTransactionIds);
//   - a credit that arrives (matchArrivingCredit, called by the Anchor webhook
//     and the reconcile poller right after they book it) goes to the OLDEST
//     waiting deposit it is eligible for, and the owner gets one notification
//     for it, the deposit's own (the caller sends its usual "money received"
//     one only for a credit that is no deposit's);
//   - a deposit recorded (or changed) after its transfer arrived takes the
//     OLDEST eligible credit at once (lookBack).
//
// The owner may also pick the credit (the link route): one the server would
// take, one that came more than three days after (a slow bank), one the owner
// took off this deposit before, or one the owner had already marked as cash
// banked ("Cash I already recorded": purpose cash_deposit, with no account or
// with Cash at Hand's) that no deposit names. Picking that one makes the
// marking and the deposit one thing, so Cash at Hand falls once for that
// cash; the deposit keeps what the credit was (adoptedPurpose,
// adoptedAccountId) and an undo gives it back. The server never takes a
// marked credit by itself: it may be cash the owner banked on another day
// without recording a deposit. Never a credit dated before the deposit's own
// day (NOT_ELIGIBLE BEFORE): the cash cannot reach the bank before it left the
// till.
//
// A linked credit carries purpose "cash_deposit" and no account, and the
// deposit names it (CashDeposit.transactionId, set only while the deposit has
// arrived). It is the deposit's until the owner undoes it there: every route
// that changes what a credit is refuses it (assertNotDeposit, 409
// DEPOSIT_LINKED).
//
// The books lock (utils/booksLock.js): a deposit's own entry is on its own day
// and is the same whether it waits or has arrived, so linking or undoing
// changes only what the credit counts as, on the credit's own day. A link, an
// undo, the server's own linking and the "Pick the transfer" list ask about
// that day alone (linkLocked, assertLinkOpen): a deposit dated in the locked
// part of the books still takes a transfer that arrives on an open day.
// Recording, editing or cancelling a deposit moves its own entry, and asks
// about its own day (routes/cashDeposits.js).
//
// Every write here runs inside the business's withBusinessLock and one
// $transaction, the caller's or its own.
const prisma = require("./db");
const books = require("./books");
const chart = require("./chart");
const { isLedgerBankRow, PROVIDER_SOURCES } = require("../config/moneySources");
const { toKobo } = require("./money");
const { lockDateOf, isLocked, assertUnlockedIn } = require("./booksLock");
const { pushTo } = require("./pushNotification");
const { audit } = require("./audit");
const { invalidateLedger } = require("./ledgerData");

// How many days after the deposit's own day its transfer may arrive and still
// be taken by the server itself. The owner may pick a slower one by hand.
const WINDOW_DAYS = 3;
const DEPOSIT_LINKED = "DEPOSIT_LINKED";
const LINKED_MESSAGE = "This transfer is your cash deposit. Undo it on the deposit first.";
// The purpose of a deposit's credit, and of one the owner marked as cash
// banked ("Cash I already recorded").
const CASH_DEPOSIT = "cash_deposit";

// The linked credit as a deposit shows it.
const DEPOSIT_INCLUDE = { transaction: { select: { id: true, date: true, senderName: true, amount: true } } };

// A coded refusal, in the shape every router here answers with: { error,
// code, field?, ...extra }. `expose` lets the sync queue (routes/sync.js) send
// the message as it is.
function depositError(status, code, message, extra) {
  const err = Object.assign(new Error(message), { status, code, expose: true });
  if (extra && extra.field) err.field = extra.field;
  const rest = { ...(extra || {}) };
  delete rest.field;
  if (Object.keys(rest).length) err.extra = rest;
  return err;
}

// 409 NOT_ELIGIBLE with its reason (creditRefusal), on the transfer picked.
const notEligible = (reason, message = "That transfer can't be this deposit.") =>
  depositError(409, "NOT_ELIGIBLE", message, { reason, field: "transactionId" });

// "YYYY-MM-DD" n days after `day`.
function addDays(day, n) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// The first moment of a Lagos day (UTC+1, no daylight saving).
const dayStart = (day) => new Date(`${day}T00:00:00+01:00`);

const rejectedOf = (dep) => (Array.isArray(dep && dep.rejectedTransactionIds) ? dep.rejectedTransactionIds.map(String) : []);

// The books lock and a link or an undo: the credit's own day alone (see the
// header). True when that day is on or before the lock date.
function linkLocked(lockDate, tx) {
  return isLocked(lockDate, tx ? tx.date : null);
}

// The same, refused (409 BOOKS_LOCKED) inside the caller's transaction.
function assertLinkOpen(px, businessId, tx) {
  return assertUnlockedIn(px, businessId, tx ? tx.date : null);
}

// Matched to a record in any way: a sale, a customer's repayments, invoice
// payments (an expense or a bill too, which only a debit can be), or any
// amount a match accounted for.
function isMatched(tx) {
  return !!(
    tx.matchedSaleId || tx.matchedCustomerId || tx.matchedInvoiceId || tx.matchedExpenseId || tx.matchedBillId ||
    (tx.matchedAmount != null && toKobo(tx.matchedAmount) !== 0)
  );
}

// Nothing explains the credit yet (no purpose, no account): the only kind the
// server links by itself.
const unexplained = (tx) => !tx.purpose && !tx.accountId;

// The owner marked the credit as cash banked and nothing else: purpose
// cash_deposit with no account, or with the business's Cash at Hand account
// (`cashAccountId`; categorizing a credit with Cash at Hand writes both).
const markedAsBanked = (tx, cashAccountId) =>
  tx.purpose === CASH_DEPOSIT && (!tx.accountId || (!!cashAccountId && tx.accountId === cashAccountId));

// The credit's Lagos day is before the deposit's.
function beforeDeposit(tx, dep) {
  const day = books.dayKey(tx.date);
  const from = books.dayKey(dep.date);
  return !!day && !!from && day < from;
}

// Why a credit cannot be a deposit's, or null when it can (the three-day
// window and the deposit's rejected transfers aside: the owner may pick
// those). `linkedTo`: the deposit already naming the credit, if any.
// `cashAccountId`: the business's Cash at Hand account, for a credit the
// owner marked as cash banked through it.
//   NOT_BANK  not money that came into the KashBook account
//   LINKED    another deposit's
//   AMOUNT    not the deposit's amount, to the kobo
//   MATCHED   matched to a sale, a repayment or an invoice
//   PURPOSE   explained already (a purpose, or an account), other than
//             marked as cash banked
//   BEFORE    dated (its Lagos day) before the deposit's own day
function creditRefusal(tx, dep, { base = "NGN", linkedTo = null, cashAccountId = null } = {}) {
  if (!tx || tx.type !== "income" || !isLedgerBankRow(tx, base)) return "NOT_BANK";
  if (linkedTo && (!dep || linkedTo.id !== dep.id)) return "LINKED";
  if (dep && toKobo(tx.amount) !== toKobo(dep.amount)) return "AMOUNT";
  if (isMatched(tx)) return "MATCHED";
  if (!unexplained(tx) && !markedAsBanked(tx, cashAccountId)) return "PURPOSE";
  if (dep && beforeDeposit(tx, dep)) return "BEFORE";
  return null;
}

// The credit's Lagos day is from the deposit's day to WINDOW_DAYS after it.
function inWindow(tx, dep) {
  const day = books.dayKey(tx.date);
  const from = books.dayKey(dep.date);
  return !!day && !!from && day >= from && day <= addDays(from, WINDOW_DAYS);
}

// This business's provider credits of `amount` (to the kobo) in its currency,
// dated from the Lagos day `from` (to the day `to`, when given), oldest
// first, each with the deposit already naming it (linkedTo).
async function creditsOfAmount(px, businessId, amount, base, { from, to } = {}) {
  const date = {};
  if (from) date.gte = dayStart(from);
  if (to) date.lt = dayStart(addDays(to, 1));
  const rows = await px.transaction.findMany({
    where: {
      businessId,
      type: "income",
      paymentMethod: "bank",
      source: { in: PROVIDER_SOURCES },
      amount: { gte: Number(amount) - 0.005, lte: Number(amount) + 0.005 },
      ...(from || to ? { date } : {}),
    },
    orderBy: [{ date: "asc" }, { createdAt: "asc" }],
    take: 500,
  });
  const same = rows.filter((tx) => toKobo(tx.amount) === toKobo(amount) && isLedgerBankRow(tx, base));
  if (!same.length) return [];
  const taken = await px.cashDeposit.findMany({
    where: { transactionId: { in: same.map((tx) => tx.id) } },
    select: { id: true, transactionId: true },
  });
  const by = new Map(taken.map((d) => [d.transactionId, d]));
  return same.map((tx) => ({ tx, linkedTo: by.get(tx.id) || null }));
}

// The business's currency and owner.
function businessOf(px, businessId) {
  return px.business.findUnique({ where: { id: businessId }, select: { id: true, userId: true, baseCurrency: true } });
}

// The business's Cash at Hand account's id, or null. A system account: never
// merged away or deleted (routes/ledger.js).
async function cashAccountIdOf(px, businessId) {
  const acc = await px.ledgerAccount.findFirst({ where: { businessId, systemKey: chart.SYS.CASH }, select: { id: true } });
  return acc ? acc.id : null;
}

// Links `tx` to the waiting deposit `dep`, in the caller's transaction: the
// credit becomes the deposit's (purpose cash_deposit, no account), the
// deposit has arrived, on the credit's own date. A credit the owner had
// marked as cash banked is taken as it is, and the deposit keeps what it was
// (adoptedPurpose, adoptedAccountId) for an undo to give back. `tx` is the
// credit as the caller read it, under the business lock. Both writes check
// that nothing changed since (each only if it is still as it was), so a write
// that took either meanwhile wins and nothing is half done. A transfer the
// owner picks leaves the deposit's rejected list. Returns { deposit,
// transaction }.
async function linkCredit(px, dep, tx, { autoLinked }) {
  const adopted = !unexplained(tx);
  if (adopted) {
    const cashAccountId = tx.accountId ? await cashAccountIdOf(px, dep.businessId) : null;
    if (!markedAsBanked(tx, cashAccountId)) throw notEligible("PURPOSE", "That transfer is already explained.");
  }
  if (beforeDeposit(tx, dep)) throw notEligible("BEFORE");
  const credit = await px.transaction.updateMany({
    where: {
      id: tx.id, businessId: dep.businessId, type: "income",
      purpose: tx.purpose ?? null, accountId: tx.accountId ?? null,
      matchedSaleId: null, matchedCustomerId: null, matchedInvoiceId: null, matchedExpenseId: null, matchedBillId: null,
    },
    data: { purpose: CASH_DEPOSIT, accountId: null },
  });
  if (credit.count !== 1) throw notEligible("PURPOSE", "That transfer is already explained.");
  const rejected = rejectedOf(dep);
  const moved = await px.cashDeposit.updateMany({
    where: { id: dep.id, status: "waiting", into: "kashbook" },
    data: {
      status: "arrived",
      transactionId: tx.id,
      arrivedAt: tx.date,
      autoLinked: !!autoLinked,
      adoptedPurpose: adopted ? tx.purpose : null,
      adoptedAccountId: adopted ? tx.accountId || null : null,
      ...(autoLinked ? {} : { rejectedTransactionIds: rejected.filter((id) => id !== tx.id) }),
    },
  });
  if (moved.count !== 1) throw depositError(409, "DEPOSIT_CHANGED", "This deposit just changed. Please try again.");
  // One query at a time: a transaction's queries share one connection.
  const deposit = await px.cashDeposit.findUnique({ where: { id: dep.id }, include: DEPOSIT_INCLUDE });
  const transaction = await px.transaction.findUnique({ where: { id: tx.id } });
  return { deposit, transaction: transaction && { ...transaction, cashDepositId: deposit.id } };
}

// What an undo gives the credit back: what it was before the deposit took it
// (marked as cash banked, with Cash at Hand's account when it had it), else
// nothing at all (unexplained, as it arrived). In the caller's transaction.
async function creditBefore(px, dep) {
  if (dep.adoptedPurpose !== CASH_DEPOSIT) return { purpose: null, accountId: null };
  let accountId = null;
  if (dep.adoptedAccountId) {
    const acc = await px.ledgerAccount.findFirst({
      where: { id: dep.adoptedAccountId, businessId: dep.businessId }, select: { id: true },
    });
    accountId = acc ? acc.id : null;
  }
  return { purpose: CASH_DEPOSIT, accountId };
}

// A waiting KashBook deposit that was just recorded or changed: the OLDEST
// eligible credit nothing explains that already arrived is linked at once
// (autoLinked). A credit on a locked day is skipped; so is one the owner
// marked as cash banked (the owner may pick that one). In the caller's
// transaction, under its business lock. Returns { deposit, transaction } or
// null.
async function lookBack(px, dep, { base } = {}) {
  if (!dep || dep.into !== "kashbook" || dep.status !== "waiting") return null;
  const from = books.dayKey(dep.date);
  if (!from) return null;
  const biz = base ? null : await businessOf(px, dep.businessId);
  const lockDate = await lockDateOf(dep.businessId, px);
  const currency = base || (biz && biz.baseCurrency) || "NGN";
  const rejected = new Set(rejectedOf(dep));
  const list = await creditsOfAmount(px, dep.businessId, dep.amount, currency, { from, to: addDays(from, WINDOW_DAYS) });
  const hit = list.find(({ tx, linkedTo }) =>
    unexplained(tx) && !creditRefusal(tx, dep, { base: currency, linkedTo }) && inWindow(tx, dep) &&
    !rejected.has(tx.id) && !linkLocked(lockDate, tx));
  if (!hit) return null;
  try {
    return await linkCredit(px, dep, hit.tx, { autoLinked: true });
  } catch (err) {
    // The credit changed between the read and the write, and nothing was
    // written: the deposit waits, as when no credit is found.
    if (err && err.code === "NOT_ELIGIBLE") return null;
    throw err;
  }
}

// Naira as the owner reads it in a notification: "₦45,000", "₦2,500.50".
function amountText(n) {
  const kobo = toKobo(n);
  const whole = kobo % 100 === 0;
  return `₦${(kobo / 100).toLocaleString("en-NG", { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 })}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// A Lagos day as a notification reads it: "13 Oct".
function dayText(date) {
  const day = books.dayKey(date);
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return "";
  const [, m, d] = day.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]}`;
}

// Who sent a credit, as its row names them: the name, else the bank and the
// last four digits of the account, else nobody.
function senderOf(tx) {
  const name = String((tx && tx.senderName) || "").trim();
  if (name) return name;
  const bank = String((tx && tx.senderBank) || "").trim();
  const account = String((tx && tx.senderAccount) || "").replace(/\D/g, "");
  return bank && account.length >= 4 ? `${bank} ****${account.slice(-4)}` : "";
}

// The one notification a credit that is a cash deposit makes, in the server's
// English like every other push: "₦45,000 from ADA OBI is your cash deposit
// of 13 Oct. Not right? Undo it on the deposit."
function depositNotification(deposit, tx) {
  const who = senderOf(tx);
  const day = dayText(deposit.date);
  return {
    title: "Cash deposit arrived",
    body: `${amountText(tx.amount)}${who ? ` from ${who}` : ""} is your cash deposit${day ? ` of ${day}` : ""}. Not right? Undo it on the deposit.`,
  };
}

// A credit the Anchor webhook or the reconcile poller has just booked: the
// OLDEST waiting KashBook deposit it is eligible for takes it. True comes back
// when the credit is a deposit's (taken now, or by a deposit's own look-back
// at that very moment), after the owner has been told, once; the caller then
// sends no "money received" notification of its own, and does not offer the
// credit to the invoice, Instagram or WhatsApp matchers. Never throws and
// never holds the credit's booking up: the credit is already booked, and
// anything that goes wrong here is logged and answered false (the owner can
// still link it by hand).
async function matchArrivingCredit(biz, tx) {
  try {
    if (!biz || !biz.id || !tx || !tx.id || tx.type !== "income") return false;
    // Decided under the business lock, which a deposit being recorded or
    // changed holds from its save until its look-back has committed: whichever
    // of the two runs second sees the other. (A count of waiting deposits
    // taken outside the lock could miss a deposit saved at that very moment,
    // and then neither would link.)
    const result = await prisma.withBusinessLock(biz.id, () =>
      prisma.$transaction(async (px) => {
        // Already a deposit's: a deposit recorded at this moment took it
        // through its own look-back. Nobody else may have it, and the owner
        // hears of it once, as of any deposit's credit.
        const named = await px.cashDeposit.findUnique({ where: { transactionId: String(tx.id) } });
        if (named) {
          if (named.businessId !== biz.id) return null;
          const owner = await businessOf(px, biz.id);
          const cur = await px.transaction.findUnique({ where: { id: tx.id } });
          return owner && cur ? { deposit: named, transaction: cur, ownerId: owner.userId, linkedNow: false } : null;
        }
        const deposits = await px.cashDeposit.findMany({
          where: { businessId: biz.id, into: "kashbook", status: "waiting" },
          orderBy: [{ date: "asc" }, { createdAt: "asc" }],
        });
        // Nothing waits (nearly always).
        if (!deposits.length) return null;
        const cur = await px.transaction.findUnique({ where: { id: tx.id } });
        if (!cur || cur.businessId !== biz.id || !unexplained(cur)) return null;
        const owner = await businessOf(px, biz.id);
        if (!owner) return null;
        // The credit's own day alone (linkLocked): a deposit dated in the
        // locked part of the books still takes it, oldest first.
        const lockDate = await lockDateOf(biz.id, px);
        if (linkLocked(lockDate, cur)) return null;
        if (creditRefusal(cur, null, { base: owner.baseCurrency || "NGN" })) return null;
        const dep = deposits.find((d) =>
          toKobo(d.amount) === toKobo(cur.amount) && inWindow(cur, d) && !rejectedOf(d).includes(cur.id));
        if (!dep) return null;
        const linked = await linkCredit(px, dep, cur, { autoLinked: true });
        return { ...linked, ownerId: owner.userId, linkedNow: true };
      }),
    );
    if (!result) return false;

    const { deposit, transaction, ownerId, linkedNow } = result;
    if (linkedNow) {
      invalidateLedger(biz.id);
      await audit({
        action: "CASH_DEPOSIT_AUTO_LINK", resourceType: "cashDeposit", resourceId: deposit.id,
        metadata: { businessId: biz.id, transactionId: transaction.id, amount: Number(transaction.amount), when: "arrived" },
      }).catch(() => {});
    }
    try {
      const { title, body } = depositNotification(deposit, transaction);
      // The app pulls the deposit when this arrives (data.kind).
      await pushTo(ownerId, title, body, { kind: "cash_deposit", depositId: deposit.id, businessId: biz.id });
    } catch (err) {
      console.warn(`[cashDeposits] push failed for ${biz.id}: ${err.message}`);
    }
    return true;
  } catch (err) {
    console.warn(`[cashDeposits] matching an arriving credit failed for ${biz && biz.id}: ${err && err.message}`);
    return false;
  }
}

// The deposit that names a credit (only an arrived one does), or null.
function depositOfCredit(px, transactionId) {
  if (!transactionId) return Promise.resolve(null);
  return px.cashDeposit.findUnique({ where: { transactionId: String(transactionId) }, select: { id: true, status: true } });
}

// Every route that changes what a bank credit is (a purpose, an account, a
// match, a payment from it) asks this first, inside its business lock, with
// the client of its transaction: a credit that is a cash deposit is refused
// with 409 DEPOSIT_LINKED (and the deposit's id), until the owner undoes it
// on the deposit.
async function assertNotDeposit(px, transactionId) {
  const dep = await depositOfCredit(px, transactionId);
  if (dep) throw depositError(409, DEPOSIT_LINKED, LINKED_MESSAGE, { depositId: dep.id });
}

// Every bank row the server sends says which cash deposit it is: cashDepositId,
// the arrived deposit's id, else null. Staff who see the bank rows get no
// deposits, and the app tells a deposit's credit by this. `rows` is one row or
// a list (the same shape comes back, each row a copy with the field); one
// lookup for the lot: a single row by its id, a list by its businesses'
// arrived deposits (a business has few, and no list of ids grows with the
// rows). Only a credit can be a deposit.
async function withDepositIds(db, rows) {
  const list = Array.isArray(rows) ? rows : rows ? [rows] : [];
  const credits = list.filter((t) => t && t.id && t.type === "income");
  const by = new Map();
  if (credits.length === 1) {
    const dep = await depositOfCredit(db, credits[0].id);
    if (dep) by.set(credits[0].id, dep.id);
  } else if (credits.length) {
    const businessIds = [...new Set(credits.map((t) => t.businessId).filter(Boolean))];
    const deps = businessIds.length
      ? await db.cashDeposit.findMany({
        where: { businessId: { in: businessIds }, transactionId: { not: null } },
        select: { id: true, transactionId: true },
      })
      : [];
    for (const d of deps) by.set(d.transactionId, d.id);
  }
  const out = list.map((t) => (t && typeof t === "object" ? { ...t, cashDepositId: by.get(t.id) || null } : t));
  return Array.isArray(rows) ? out : out[0] || rows;
}

// A deposit as the app receives it (GET /cash-deposits, the sync bundle and
// every reply): with the linked transfer's id, date, sender and amount while
// it has arrived, and adoptedPurpose ("cash_deposit") while that transfer is
// one the owner had marked as cash banked before the deposit took it (an undo
// gives that marking back).
function publicDeposit(d) {
  if (!d) return null;
  const t = d.transaction || null;
  return {
    id: d.id,
    businessId: d.businessId,
    amount: Number(d.amount),
    date: d.date,
    into: d.into,
    intoAccountId: d.intoAccountId || null,
    status: d.status,
    transactionId: d.transactionId || null,
    transaction: t ? { id: t.id, date: t.date, senderName: t.senderName || null, amount: Number(t.amount) } : null,
    rejectedTransactionIds: rejectedOf(d),
    note: d.note || null,
    clientRef: d.clientRef || null,
    autoLinked: !!d.autoLinked,
    adoptedPurpose: d.adoptedPurpose || null,
    createdById: d.createdById || null,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    arrivedAt: d.arrivedAt || null,
    cancelledAt: d.cancelledAt || null,
  };
}

module.exports = {
  WINDOW_DAYS,
  DEPOSIT_LINKED,
  LINKED_MESSAGE,
  CASH_DEPOSIT,
  DEPOSIT_INCLUDE,
  depositError,
  addDays,
  linkLocked,
  assertLinkOpen,
  creditRefusal,
  inWindow,
  creditsOfAmount,
  cashAccountIdOf,
  linkCredit,
  creditBefore,
  lookBack,
  matchArrivingCredit,
  depositOfCredit,
  assertNotDeposit,
  withDepositIds,
  publicDeposit,
  amountText,
  dayText,
  depositNotification,
};
