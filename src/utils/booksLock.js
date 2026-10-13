// The lock date (chart of accounts release 2, 2026-10-13), as Zoho Books
// locks transactions: the owner closes the books up to a day, and nothing
// dated on or before it may be added, changed or removed, so figures already
// reported (a VAT return, last year's accounts) cannot move.
//
// Business.booksLockDate is a Lagos day, "YYYY-MM-DD" (null when the books are
// not locked; a CHECK in the migration keeps it a plain day). A route that
// creates, edits or deletes a dated record asks assertUnlocked with every day
// the write touches: the record's old day and its new one, and for a bank
// row's match the row's own day too. Bank rows from the provider always
// arrive: webhooks and the reconcile poller never ask, and the invoice matcher
// skips a credit dated on or before the lock (isLocked) instead of refusing.
//
// Ask inside the business's withBusinessLock, where the write happens: the
// lock date is set under the same lock (PUT /businesses/:id/books-lock), so a
// write and a new lock date never pass each other.
const prisma = require("./db");
const books = require("./books");

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const BOOKS_LOCKED = "BOOKS_LOCKED";

// The day a value lands on in the books, or null when it names none.
//   - a Date (or a time in milliseconds): its Lagos day, as the books read a
//     DateTime column (books.dayKey);
//   - "YYYY-MM-DD" text: that day, as the books read a text date (an
//     invoice's issueDate, the opening balance date);
//   - a timestamp written as text: the books would read it by its first ten
//     characters in a text column but by its Lagos day once stored in a
//     DateTime column, so the earlier of the two is taken and neither reading
//     can land on a locked day;
//   - any other text: EARLIEST. The books read text as its first ten
//     characters, untrimmed (books.dayKey), so " 2026-10-13" or
//     "+002026-10-13" would sit before every real day there; such a value
//     counts as locked whenever a lock date is set (fail closed);
//   - null, undefined, "", or a value that is no date at all: null. A write
//     with no day touches no day, and the route's own date check refuses a
//     date it cannot read.
const EARLIEST = "0000-01-01";
function dayOf(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string") {
    const head = value.slice(0, 10);
    if (!DAY.test(head)) return EARLIEST;
    if (value.length === 10) return head;
    const days = [head];
    const t = Date.parse(value);
    if (Number.isFinite(t)) days.push(books.dayKey(new Date(t)));
    return days.sort()[0];
  }
  const day = books.dayKey(value);
  return DAY.test(day) ? day : null;
}

// The refusal a write gets when it touches a locked day: 409 BOOKS_LOCKED,
// with the lock date as an extra field (the routes spread err.extra into the
// response, as for accountError), so the app can say up to when the books
// are locked.
function lockedError(lockDate) {
  return Object.assign(
    new Error(`The books are locked up to ${lockDate}. Nothing dated on or before that day can be added, changed or removed.`),
    { status: 409, code: BOOKS_LOCKED, extra: { lockDate } },
  );
}

// Whether any of the days is on or before the lock date ("YYYY-MM-DD", or
// null for no lock). Pure, for a caller that already has the lock date (the
// invoice matcher skips such a credit). Days may also come as arrays.
function isLocked(lockDate, ...days) {
  if (typeof lockDate !== "string" || !DAY.test(lockDate)) return false;
  return days.flat(Infinity).some((d) => {
    const day = dayOf(d);
    return day !== null && day <= lockDate;
  });
}

// The business's lock date, or null. db: prisma, or the client of the
// transaction the caller is in. A record with no business has no lock.
async function lockDateOf(businessId, db = prisma) {
  if (businessId === null || businessId === undefined || businessId === "") return null;
  if (typeof businessId !== "string") throw new TypeError("booksLock: businessId must be a business id (a string)");
  const biz = await db.business.findUnique({ where: { id: businessId }, select: { booksLockDate: true } });
  const lockDate = biz && biz.booksLockDate;
  return typeof lockDate === "string" && DAY.test(lockDate) ? lockDate : null;
}

// Refuses (throws lockedError) when any of the days is on or before the
// business's lock date; otherwise returns the lock date (null when the books
// are not locked). db is the client to read with: prisma, or the transaction
// a write runs in (px in prisma.$transaction(async (px) => ...)), so the check
// and the write see the same state.
async function assertUnlockedIn(db, businessId, ...days) {
  const lockDate = await lockDateOf(businessId, db);
  if (lockDate && isLocked(lockDate, ...days)) throw lockedError(lockDate);
  return lockDate;
}

// The same, read with prisma: assertUnlocked(businessId, oldDate, newDate).
async function assertUnlocked(businessId, ...days) {
  return assertUnlockedIn(prisma, businessId, ...days);
}

module.exports = {
  BOOKS_LOCKED,
  dayOf,
  lockedError,
  isLocked,
  lockDateOf,
  assertUnlocked,
  assertUnlockedIn,
};
