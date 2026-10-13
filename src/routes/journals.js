// Manual journals (chart of accounts release 2, 2026-10-13; Adjustments in
// the app): the owner's own entries, as Zoho Books' manual journals. A journal
// is a ManualJournal row with its one-sided ManualJournalLine rows (each line
// a debit or a credit), numbered per business from Business.journalCounter
// (MJ-00001). Only a published journal posts, on its date, in both views; a
// draft is the owner's work in progress and counts nowhere. Mounted at
// /journals in server.js, which clears the owner's cached ledgers after a
// successful write here.
//
//   GET    /journals?businessId[&status]   owner, or staff with the Reports permission
//   GET    /journals/:id                   the same
//   POST   /journals                       owner: { businessId, date, note, status, lines }
//   PATCH  /journals/:id                   owner: any of date, note, status, lines
//   POST   /journals/:id/publish           owner
//   DELETE /journals/:id                   owner (204)
//
// A line is { accountId, debit, credit, description }: one side more than
// zero and the other zero, in naira and kobo. A line with neither is an empty
// row of the editor and is left out. A published journal's debits equal its
// credits to the kobo, with at least one of each; a draft may be unbalanced
// while the owner works on it, each of its lines still a whole line. An
// account must be one a journal may use (chart.pickerAllows "journal": active,
// and never one the engine keeps in step with the records, such as Accounts
// Receivable or the KashBook Account). On an edit, an account the journal
// names already is kept even when the owner has since made it inactive, as an
// expense's or an invoice's lines are.
//
// Every write runs under the business lock: the number is taken from the
// counter there, the accounts are checked there (an account merge or delete
// takes the same lock), and so is the lock date (utils/booksLock.js), which
// refuses adding, changing or removing a journal dated on or before it,
// drafts included, as Zoho Books locks every transaction.
const router = require("express").Router();
const auth = require("../middleware/auth");
const { requirePermission, ownerOnly } = require("../middleware/requirePermission");
const { validateIdParam } = require("../middleware/validate");
const prisma = require("../utils/db");
const { ownerIdOf } = require("../utils/scope");
const { audit } = require("../utils/audit");
const { dayKey } = require("../utils/books");
const { toKobo, twoDecimals } = require("../utils/money");
const { accountError, assertAccountUsable, invalidateLedger } = require("../utils/ledgerData");
const { assertUnlocked } = require("../utils/booksLock");

router.use(auth);

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const STATUSES = ["draft", "published"];
const MAX_LINES = 100;
// At most a hundred billion naira a line, so a journal's totals in kobo stay
// whole numbers JavaScript holds exactly (100 lines of it is 10^15 kobo).
const MAX_LINE_AMOUNT = 100000000000;
const NOTE_MAX = 500;
const DESCRIPTION_MAX = 200;
// The lines in the order the owner entered them.
const LINES = { orderBy: [{ position: "asc" }, { id: "asc" }] };

// A coded refusal, as the app reads it: { error, code }, plus `field` and any
// `extra` (for a line, its place in the list as sent: `line`).
function journalError(message, code, status = 400, { field, extra } = {}) {
  const err = Object.assign(new Error(message), { status, code });
  if (field) err.field = field;
  if (extra) err.extra = extra;
  return err;
}

const lineError = (message, code, line) => journalError(message, code, 400, { field: "lines", extra: { line } });

function sendError(res, err, what) {
  if (err && err.status) {
    return res.status(err.status).json({
      error: err.message,
      code: err.code,
      ...(err.field ? { field: err.field } : {}),
      ...(err.extra || {}),
    });
  }
  console.error(`[journals] ${what}:`, err);
  return res.status(500).json({ error: "Something went wrong with the adjustment. Please try again." });
}

const owner = ownerOnly("Only the business owner can make adjustments.");

// ── Reading a request ───────────────────────────────────────────────────────

// The business a request names, when it is the owner's (for staff, their
// employer's). Writes are the owner's alone (ownerOnly), so for a write it is
// the owner's own business.
async function loadBusiness(req, businessId) {
  if (businessId === undefined || businessId === null || businessId === "") {
    throw journalError("Choose a business.", "BUSINESS_REQUIRED", 400, { field: "businessId" });
  }
  if (typeof businessId !== "string") throw journalError("Choose a business.", "BAD_BUSINESS", 400, { field: "businessId" });
  const biz = await prisma.business.findFirst({ where: { id: businessId, userId: ownerIdOf(req) }, select: { id: true } });
  if (!biz) throw journalError("Business not found.", "BUSINESS_NOT_FOUND", 404);
  return biz;
}

// The journal a request names, with its lines, when it is in one of the
// owner's businesses. Another owner's journal is "not found", like one that
// does not exist.
async function loadJournal(req, id) {
  const j = await prisma.manualJournal.findUnique({
    where: { id: String(id) },
    include: { lines: LINES, business: { select: { userId: true } } },
  });
  if (!j || !j.business || j.business.userId !== ownerIdOf(req)) {
    throw journalError("Adjustment not found.", "JOURNAL_NOT_FOUND", 404);
  }
  return j;
}

// The journal's day: a real calendar day, "YYYY-MM-DD". It is stored as that
// day's start in UTC, which the books read as the same Lagos day
// (books.dayKey), as a sale's or an expense's date is stored.
function readDay(v) {
  const day = typeof v === "string" ? v.trim() : "";
  const d = new Date(`${day}T00:00:00.000Z`);
  if (
    !DAY.test(day) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== day ||
    day < "1900-01-01" || day > "2999-12-31"
  ) {
    throw journalError("Choose the adjustment's date.", "BAD_DATE", 400, { field: "date" });
  }
  return day;
}
const dateOf = (day) => new Date(`${day}T00:00:00.000Z`);

// The note: undefined when not sent (an edit keeps it), null when cleared.
function readNote(v) {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== "string" && typeof v !== "number") throw journalError("That note isn't valid.", "BAD_NOTE", 400, { field: "note" });
  const note = String(v).trim();
  if (note.length > NOTE_MAX) {
    throw journalError(`Keep the note under ${NOTE_MAX} characters.`, "NOTE_TOO_LONG", 400, { field: "note" });
  }
  return note || null;
}

// "draft" or "published"; undefined when not sent.
function readStatus(v) {
  if (v === undefined) return undefined;
  const status = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (!STATUSES.includes(status)) throw journalError("An adjustment is a draft or published.", "BAD_STATUS", 400, { field: "status" });
  return status;
}

// A debit or a credit as sent, in naira: 0 when blank, null when it is not an
// amount of money (not a number, below zero, more than two decimals, or more
// than a line may hold). Read as money.twoDecimals reads it (2500.55 is two
// decimals whatever 2500.55 * 100 comes to in floating point) and kept to
// the kobo.
function amountOf(v) {
  if (v === undefined || v === null || v === "") return 0;
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.trim()) : NaN;
  if (!Number.isFinite(n) || n < 0 || n > MAX_LINE_AMOUNT || !twoDecimals(n)) return null;
  return toKobo(n) / 100;
}

// The lines a write sends, read and checked for shape (the accounts are
// checked after, under the business lock): an array of at most MAX_LINES.
// An empty row (no debit and no credit) is left out; the rest keep the order
// sent (position). `sent` is a line's place in the list as sent, which a
// refusal names as `line`.
function readLines(raw) {
  if (!Array.isArray(raw)) throw journalError("Send the adjustment's lines.", "BAD_LINES", 400, { field: "lines" });
  if (raw.length > MAX_LINES) {
    throw journalError(`An adjustment can have at most ${MAX_LINES} lines.`, "TOO_MANY_LINES", 400, { field: "lines" });
  }
  const lines = [];
  raw.forEach((l, i) => {
    if (!l || typeof l !== "object" || Array.isArray(l)) throw lineError("Each line needs an account and an amount.", "BAD_LINE", i);
    const debit = amountOf(l.debit);
    const credit = amountOf(l.credit);
    if (debit === null || credit === null) throw lineError("Enter each amount in naira and kobo.", "BAD_AMOUNT", i);
    if (!debit && !credit) return;
    if (debit && credit) throw lineError("A line is a debit or a credit, not both.", "BOTH_SIDES", i);
    // Only the request's top-level fields are checked before the routes run
    // (middleware/idGuard.js), so a line's account is checked here: an id is
    // text, never an object a lookup could read as a filter.
    if (typeof l.accountId !== "string" || !l.accountId.trim()) {
      throw lineError("Choose an account for every line.", "ACCOUNT_REQUIRED", i);
    }
    let description = null;
    if (typeof l.description === "string" || typeof l.description === "number") {
      description = String(l.description).trim().slice(0, DESCRIPTION_MAX) || null;
    }
    lines.push({ accountId: l.accountId.trim(), debit, credit, description, position: lines.length, sent: i });
  });
  return lines;
}

const lineData = (l) => ({
  accountId: l.accountId, debit: l.debit, credit: l.credit, description: l.description, position: l.position,
});

// Every account the lines name, each checked once. `kept`: the accounts the
// journal names already (an edit). Those need only still be in this
// business's chart; any other must be one a journal may use now
// (assertAccountUsable, context "journal"). A refusal names the line.
// Checked before anything is written: a line naming an account that does not
// exist would otherwise be refused only when the transaction commits (the
// migration defers that key), with a far less useful error.
async function checkAccounts(businessId, lines, kept = new Set()) {
  const done = new Set();
  for (const l of lines) {
    if (done.has(l.accountId)) continue;
    const at = { field: "lines", line: l.sent };
    if (kept.has(l.accountId)) {
      const acc = await prisma.ledgerAccount.findFirst({ where: { id: l.accountId, businessId }, select: { id: true } });
      if (!acc) throw accountError("That account isn't in this business's chart.", "ACCOUNT_NOT_FOUND", 400, at);
    } else {
      await assertAccountUsable(businessId, l.accountId, "journal", at);
    }
    done.add(l.accountId);
  }
}

// The lines' totals, in kobo.
function totalsOf(lines) {
  let debitK = 0;
  let creditK = 0;
  for (const l of lines) {
    debitK += toKobo(l.debit);
    creditK += toKobo(l.credit);
  }
  return { debitK, creditK };
}

// A journal is published only when its debits equal its credits to the kobo
// and it moves something (at least one debit and one credit).
function assertBalanced(lines) {
  const { debitK, creditK } = totalsOf(lines);
  if (debitK > 0 && debitK === creditK) return;
  throw journalError(
    debitK === creditK
      ? "Add a debit and a credit before publishing."
      : "The debits and the credits must be equal before publishing.",
    "NOT_BALANCED",
    400,
    { field: "lines", extra: { debit: debitK / 100, credit: creditK / 100, difference: (debitK - creditK) / 100 } },
  );
}

// "MJ-00001": the counter, five digits at least.
const numberOf = (n) => `MJ-${String(n).padStart(5, "0")}`;

// The next number, from the business's counter. Taken under the business lock
// and in the transaction that creates the journal, so a create that fails
// gives its number back. A number already in use (none should be) is skipped.
async function nextNumber(px, businessId) {
  for (let i = 0; i < 1000; i++) {
    const { journalCounter } = await px.business.update({
      where: { id: businessId },
      data: { journalCounter: { increment: 1 } },
      select: { journalCounter: true },
    });
    const number = numberOf(journalCounter);
    if (!(await px.manualJournal.count({ where: { businessId, number } }))) return number;
  }
  throw journalError("The adjustment couldn't be numbered. Please try again.", "NUMBER_UNAVAILABLE", 409);
}

// A journal as the app receives it. `day` is its Lagos day, the day the books
// count it on; the totals are naira, `balanced` true when it could post.
function publicJournal(j) {
  const lines = (j.lines || []).map((l) => ({
    id: l.id, accountId: l.accountId, debit: l.debit, credit: l.credit, description: l.description, position: l.position,
  }));
  const { debitK, creditK } = totalsOf(lines);
  return {
    id: j.id,
    businessId: j.businessId,
    number: j.number,
    date: j.date,
    day: dayKey(j.date),
    note: j.note,
    status: j.status,
    createdById: j.createdById,
    createdAt: j.createdAt,
    updatedAt: j.updatedAt,
    lines,
    totalDebit: debitK / 100,
    totalCredit: creditK / 100,
    balanced: debitK > 0 && debitK === creditK,
  };
}

const logJournal = (req, action, j, metadata = {}) =>
  audit({
    req, action, resourceType: "manualJournal", resourceId: j.id,
    metadata: { number: j.number, businessId: j.businessId, ...metadata },
  }).catch(() => {});

// ── Reading ─────────────────────────────────────────────────────────────────

router.get("/", requirePermission("canViewReports"), async (req, res) => {
  try {
    const biz = await loadBusiness(req, req.query.businessId);
    const status = readStatus(req.query.status === "" ? undefined : req.query.status);
    const rows = await prisma.manualJournal.findMany({
      where: { businessId: biz.id, ...(status ? { status } : {}) },
      include: { lines: LINES },
      orderBy: [{ date: "desc" }, { createdAt: "desc" }],
      take: 1000,
    });
    res.json({ journals: rows.map(publicJournal) });
  } catch (err) {
    sendError(res, err, "list");
  }
});

router.get("/:id", requirePermission("canViewReports"), validateIdParam, async (req, res) => {
  try {
    res.json(publicJournal(await loadJournal(req, req.params.id)));
  } catch (err) {
    sendError(res, err, "read");
  }
});

// ── The owner's adjustments ─────────────────────────────────────────────────

// POST /journals  { businessId, date?, note?, status?, lines }
// A new journal, numbered from the counter. date: "YYYY-MM-DD", today (Lagos)
// when not sent; status: "draft" (the default) or "published".
router.post("/", owner, async (req, res) => {
  try {
    const body = req.body || {};
    const biz = await loadBusiness(req, body.businessId);
    const day = body.date === undefined || body.date === null || body.date === "" ? dayKey(new Date()) : readDay(body.date);
    const note = readNote(body.note);
    const status = readStatus(body.status) || "draft";
    const lines = readLines(body.lines === undefined || body.lines === null ? [] : body.lines);
    if (status === "published") assertBalanced(lines);

    const journal = await prisma.withBusinessLock(biz.id, async () => {
      await assertUnlocked(biz.id, day);
      await checkAccounts(biz.id, lines);
      return prisma.$transaction(async (px) => {
        const number = await nextNumber(px, biz.id);
        return px.manualJournal.create({
          data: {
            businessId: biz.id,
            number,
            date: dateOf(day),
            note: note === undefined ? null : note,
            status,
            createdById: req.user.id,
            lines: { create: lines.map(lineData) },
          },
          include: { lines: LINES },
        });
      });
    });
    invalidateLedger(biz.id);
    logJournal(req, "JOURNAL_CREATE", journal, { status, day, total: totalsOf(lines).debitK / 100 });
    res.status(201).json(publicJournal(journal));
  } catch (err) {
    sendError(res, err, "create");
  }
});

// PATCH /journals/:id  { date?, note?, status?, lines? }
// Only what is sent changes; `lines` replaces every line. A published journal
// may be edited (it stays balanced), published, or taken back to a draft.
// The lock date is checked against its day before and after the edit.
router.patch("/:id", owner, validateIdParam, async (req, res) => {
  try {
    const body = req.body || {};
    const j0 = await loadJournal(req, req.params.id);
    const newDay = body.date === undefined ? undefined : readDay(body.date);
    const note = readNote(body.note);
    const status = readStatus(body.status);
    const lines = body.lines === undefined ? undefined : readLines(body.lines);

    const journal = await prisma.withBusinessLock(j0.businessId, async () => {
      // Read again under the lock: deleted, published or edited meanwhile.
      const cur = await loadJournal(req, j0.id);
      await assertUnlocked(cur.businessId, cur.date, newDay);
      if (lines) await checkAccounts(cur.businessId, lines, new Set(cur.lines.map((l) => l.accountId)));
      if ((status || cur.status) === "published") assertBalanced(lines || cur.lines);
      return prisma.$transaction(async (px) => {
        if (lines) {
          await px.manualJournalLine.deleteMany({ where: { journalId: cur.id } });
          if (lines.length) await px.manualJournalLine.createMany({ data: lines.map((l) => ({ journalId: cur.id, ...lineData(l) })) });
        }
        return px.manualJournal.update({
          where: { id: cur.id },
          data: {
            ...(newDay !== undefined ? { date: dateOf(newDay) } : {}),
            ...(note !== undefined ? { note } : {}),
            ...(status !== undefined ? { status } : {}),
            // A change to its lines alone is a change to the journal too.
            updatedAt: new Date(),
          },
          include: { lines: LINES },
        });
      });
    });
    invalidateLedger(journal.businessId);
    logJournal(req, "JOURNAL_UPDATE", journal, {
      fields: ["date", "note", "status", "lines"].filter((k) => body[k] !== undefined),
      status: journal.status,
    });
    res.json(publicJournal(journal));
  } catch (err) {
    sendError(res, err, "update");
  }
});

// POST /journals/:id/publish: a draft starts to post, once it balances. A
// journal already published comes back as it is.
router.post("/:id/publish", owner, validateIdParam, async (req, res) => {
  try {
    const j0 = await loadJournal(req, req.params.id);
    const { journal, changed } = await prisma.withBusinessLock(j0.businessId, async () => {
      const cur = await loadJournal(req, j0.id);
      if (cur.status === "published") return { journal: cur, changed: false };
      await assertUnlocked(cur.businessId, cur.date);
      assertBalanced(cur.lines);
      const row = await prisma.manualJournal.update({
        where: { id: cur.id },
        data: { status: "published" },
        include: { lines: LINES },
      });
      return { journal: row, changed: true };
    });
    if (changed) {
      invalidateLedger(journal.businessId);
      logJournal(req, "JOURNAL_PUBLISH", journal);
    }
    res.json(publicJournal(journal));
  } catch (err) {
    sendError(res, err, "publish");
  }
});

// DELETE /journals/:id: the journal and its lines go (its number is not used
// again). 204.
router.delete("/:id", owner, validateIdParam, async (req, res) => {
  try {
    const j0 = await loadJournal(req, req.params.id);
    await prisma.withBusinessLock(j0.businessId, async () => {
      const cur = await prisma.manualJournal.findUnique({ where: { id: j0.id }, select: { id: true, businessId: true, date: true } });
      if (!cur) throw journalError("Adjustment not found.", "JOURNAL_NOT_FOUND", 404);
      await assertUnlocked(cur.businessId, cur.date);
      await prisma.manualJournal.delete({ where: { id: cur.id } });
    });
    invalidateLedger(j0.businessId);
    logJournal(req, "JOURNAL_DELETE", j0, { status: j0.status, day: dayKey(j0.date) });
    res.status(204).end();
  } catch (err) {
    sendError(res, err, "delete");
  }
});

module.exports = router;
