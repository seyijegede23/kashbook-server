// Release 2 of the chart of accounts end to end (2026-10-13): manual journals
// (Adjustments in the app) and the lock date, over the real routers, a real
// Postgres and real login tokens.
//
// Journals: MJ-00001 numbering from the business's counter under the business
// lock (parallel creates never share a number, a refused create gives its
// number back), debits equal to credits to the kobo before anything is
// published, drafts that may be unbalanced, one-sided lines, accounts a
// journal may use (never one the engine keeps, never another business's),
// an inactive account kept on an edit, owner-only writes, staff with the
// Reports permission reading, and a business with journals that can still be
// deleted.
//
// The lock date: the owner alone sets it, a day up to today, under the
// business lock; then every route that adds, changes or removes a dated
// record refuses a day on or before it (409 BOOKS_LOCKED with the lock date),
// checking the record's day before and after an edit and the day of any bank
// row it moves: sales, expenses (receipts exempt), invoices, credit notes,
// their payments, refunds, write-offs and applied credit, quotes converted,
// customer debts and repayments, manual rows, and explaining a bank row
// (match, create-sale, create-expense, match-debt, link, classify,
// categorize, unmatch). Quotes are never locked; the automatic invoice
// matcher skips a locked credit instead of refusing it. Customers belong to
// one business: a new one names it, and debts are refused for one with none.
// A debit that paid a bill is never explained a second way.
//
//   TEST_DATABASE_URL=postgresql://postgres:<pw>@localhost:5432/kashbook_coa_e2e_a3 \
//     node scripts/journals-lock-e2e-test.js
const url = process.env.TEST_DATABASE_URL;
if (!url) {
  console.error("TEST_DATABASE_URL is required (a local scratch database).");
  process.exit(1);
}
if (!["localhost", "127.0.0.1"].includes(new URL(url).hostname)) {
  console.error("Refusing: local databases only.");
  process.exit(1);
}
process.env.DATABASE_URL = url;
process.env.JWT_SECRET = "e2e-only-secret-0123456789abcdef0123456789abcdef";
process.env.NODE_ENV = "test";

const assert = require("assert");
const http = require("http");
const express = require("express");
const prisma = require("../src/utils/db");
const { signToken } = require("../src/utils/jwt");
const { accountsFor, invalidateOwner } = require("../src/utils/ledgerData");
const { tryMatchInvoice } = require("../src/utils/invoiceMatch");
const chart = require("../src/utils/chart");

const app = express();
app.use(express.json({ limit: "1mb" }));
// As server.js does: ids and query values are plain strings, and a write that
// succeeds clears the owner's cached ledgers.
app.use(require("../src/middleware/idGuard").idGuard);
app.use((req, res, next) => {
  if (req.method !== "GET") res.on("finish", () => res.statusCode < 400 && req.user && invalidateOwner(req.user.accountType === "staff" ? req.user.employerId : req.user.id));
  next();
});
app.use("/journals", require("../src/routes/journals"));
app.use("/businesses", require("../src/routes/businesses"));
app.use("/sales", require("../src/routes/sales"));
app.use("/expenses", require("../src/routes/expenses"));
app.use("/invoices", require("../src/routes/invoices"));
app.use("/customers", require("../src/routes/customers"));
app.use("/transactions", require("../src/routes/transactions"));

let BASE;
const call = (method, path, token, body) =>
  new Promise((resolve) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const r = http.request(`${BASE}${path}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        let j = null;
        try { j = JSON.parse(d); } catch { /* empty */ }
        resolve({ status: res.statusCode, body: j });
      });
    });
    r.on("error", (e) => resolve({ status: 0, body: { error: e.message } }));
    if (data) r.write(data);
    r.end();
  });

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${name}\n        ${String(e.message).split("\n")[0]}`);
  }
}
const eq = (a, b, what = "") => assert.strictEqual(a, b, `${what} ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
const section = (s) => console.log(`\n── ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = Date.now().toString(36);

// Lagos days: a day in the locked period, the lock date itself (locked too),
// a day after it, and today.
const DAY_MS = 24 * 60 * 60 * 1000;
const lagosDay = (ms) => new Date(ms + 60 * 60 * 1000).toISOString().slice(0, 10);
const daysAgo = (n) => lagosDay(Date.now() - n * DAY_MS);
const TODAY = lagosDay(Date.now());
const YESTERDAY = lagosDay(Date.now() - 24 * 3600 * 1000);
const OLD = daysAgo(40);
const LOCK = daysAgo(30);
const OPEN = daysAgo(20);
const TOMORROW = daysAgo(-1);
// Noon in Lagos on a day: a bank row's time, read as that day.
const atNoon = (day) => new Date(`${day}T11:00:00.000Z`);

// A refusal for the lock date: 409 BOOKS_LOCKED, naming the lock date.
function locked(r, lockDate = LOCK, what = "") {
  eq(r.status, 409, `${what} status ${JSON.stringify(r.body)}`);
  eq(r.body && r.body.code, "BOOKS_LOCKED", `${what} code`);
  eq(r.body && r.body.lockDate, lockDate, `${what} lockDate`);
}
function ok(r, status, what = "") {
  eq(r.status, status, `${what} ${JSON.stringify(r.body)}`);
  return r.body;
}

(async () => {
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  BASE = `http://127.0.0.1:${server.address().port}`;
  console.log(`\nJOURNALS AND THE LOCK DATE — END TO END\n${BASE}\nold ${OLD}, lock ${LOCK}, open ${OPEN}, today ${TODAY}`);

  const mkUser = (data) => prisma.user.create({
    data: { password: "x", lastName: "T", businessName: "B", country: "NG", currency: "NGN", ...data },
  });
  const owner = await mkUser({ email: `mj-${tag}@t.local`, firstName: "Ada", accountType: "OWNER" });
  const rival = await mkUser({ email: `mj-rival-${tag}@t.local`, firstName: "Rival", accountType: "OWNER" });
  const mkBiz = (userId, name) => prisma.business.create({ data: { userId, name: `${name} ${tag}`, country: "NG", baseCurrency: "NGN" } });
  const biz = await mkBiz(owner.id, "Mj");
  const biz2 = await mkBiz(owner.id, "Mj Two");
  const rivalBiz = await mkBiz(rival.id, "Rival");
  const T = signToken({ userId: owner.id, tokenVersion: 0 });
  const TR = signToken({ userId: rival.id, tokenVersion: 0 });
  const staffWith = async (name, grants) => {
    const s = await mkUser({ email: `mj-${name}-${tag}@t.local`, firstName: name, accountType: "STAFF", employerId: owner.id });
    await prisma.staffPermission.create({ data: { userId: s.id, employerId: owner.id, grantedById: owner.id, ...grants } });
    return signToken({ userId: s.id, tokenVersion: 0 });
  };
  const tPlain = await staffWith("plain", {});
  const tReports = await staffWith("reports", { canViewReports: true });
  const tBank = await staffWith("bank", { canViewReports: true, canViewBalance: true });

  const accts = await accountsFor(biz.id);
  const sys = (k) => accts.find((a) => a.systemKey === k);
  const cash = sys(chart.SYS.CASH);
  const ar = sys(chart.SYS.AR);
  const kashbook = sys(chart.SYS.KASHBOOK);
  const equity = sys(chart.SYS.OWNER_EQUITY);
  const vat = sys(chart.SYS.VAT);
  const rent = accts.find((a) => a.categorySlug === "rent");
  const prepaid = accts.find((a) => a.seed === "prepaid_expenses");
  const rivalCash = (await accountsFor(rivalBiz.id)).find((a) => a.systemKey === chart.SYS.CASH);
  const mkAccount = (name, type = "other_current_asset", extra = {}) =>
    prisma.ledgerAccount.create({ data: { businessId: biz.id, type, name, nameKey: chart.nameKey(name), ...extra } });

  const line = (accountId, debit, credit = 0, description) => ({ accountId, debit, credit, ...(description ? { description } : {}) });
  const move = (amount, from = cash.id, to = rent.id) => [line(to, amount), line(from, 0, amount)];
  const newJournal = (body, token = T) => call("POST", "/journals", token, { businessId: biz.id, ...body });

  const bankRow = (type, amount, day, extra = {}) => prisma.transaction.create({
    data: {
      businessId: biz.id, userId: owner.id, type, amount, date: atNoon(day), paymentMethod: "bank", category: "transfer",
      source: "anchor", currency: "NGN", description: `${type} ${day}`, ...extra,
    },
  });
  const setLock = (date, token = T, bizId = biz.id) => call("PUT", `/businesses/${bizId}/books-lock`, token, { date });

  try {
    // ════════════════════════════════════════════════════════════════════
    section("Journals: numbering, balance to the kobo, drafts and lines");
    let j1;
    let j2;
    await test("a draft with no lines is numbered MJ-00001 and dated today", async () => {
      j1 = ok(await newJournal({ note: "  First  " }), 201);
      eq(j1.number, "MJ-00001");
      eq(j1.status, "draft");
      eq(j1.day, TODAY);
      eq(j1.note, "First");
      eq(j1.lines.length, 0);
      eq(j1.balanced, false);
    });
    await test("a published journal balanced to the kobo is MJ-00002, and its lines keep their order", async () => {
      j2 = ok(await newJournal({ date: OPEN, status: "published", lines: [line(rent.id, 1000.5, 0, "Rent paid ahead"), line(cash.id, 0, 1000.5)] }), 201);
      eq(j2.number, "MJ-00002");
      eq(j2.status, "published");
      eq(j2.day, OPEN);
      eq(j2.totalDebit, 1000.5);
      eq(j2.totalCredit, 1000.5);
      eq(j2.balanced, true);
      eq(j2.lines.map((l) => [l.accountId, l.debit, l.credit, l.position]).join("|"), [[rent.id, 1000.5, 0, 0], [cash.id, 0, 1000.5, 1]].join("|"));
      eq(j2.lines[0].description, "Rent paid ahead");
      const row = await prisma.manualJournal.findUnique({ where: { id: j2.id } });
      eq(row.date.toISOString(), `${OPEN}T00:00:00.000Z`, "stored as the day's start in UTC");
    });
    await test("an unbalanced journal is never published, and gives its number back", async () => {
      const r = await newJournal({ status: "published", lines: [line(rent.id, 100.11), line(cash.id, 0, 100.1)] });
      eq(r.status, 400);
      eq(r.body.code, "NOT_BALANCED");
      eq(r.body.debit, 100.11);
      eq(r.body.credit, 100.1);
      eq(r.body.difference, 0.01);
      const empty = await newJournal({ status: "published", lines: [] });
      eq(empty.body.code, "NOT_BALANCED", "nothing to post");
      const next = ok(await newJournal({ status: "published", lines: move(50) }), 201);
      eq(next.number, "MJ-00003", "no number lost to the refusals");
    });
    await test("amounts balance in kobo, whatever floating point makes of them", async () => {
      const r = ok(await newJournal({ status: "published", lines: [line(rent.id, 0.3), line(cash.id, 0, 0.1), line(prepaid.id, 0, 0.2)] }), 201);
      eq(r.balanced, true);
      const big = ok(await newJournal({ status: "published", lines: [line(rent.id, "2500.55"), line(cash.id, 0, 2500.55)] }), 201);
      eq(big.lines[0].debit, 2500.55, "a numeric string is read as money");
    });
    await test("a line is a debit or a credit in naira and kobo, on an account", async () => {
      const bad = async (lines, code, lineNo) => {
        const r = await newJournal({ lines });
        eq(r.status, 400, JSON.stringify(r.body));
        eq(r.body.code, code);
        eq(r.body.field, "lines");
        if (lineNo !== undefined) eq(r.body.line, lineNo, "the line refused");
      };
      await bad([line(rent.id, 10), line(cash.id, 0, 10.005)], "BAD_AMOUNT", 1);
      await bad([line(rent.id, -10)], "BAD_AMOUNT", 0);
      await bad([line(rent.id, "ten")], "BAD_AMOUNT", 0);
      await bad([line(rent.id, 1e12)], "BAD_AMOUNT", 0);
      await bad([line(rent.id, 10, 10)], "BOTH_SIDES", 0);
      await bad([{ debit: 10 }], "ACCOUNT_REQUIRED", 0);
      await bad([{ accountId: { not: "x" }, debit: 10 }], "ACCOUNT_REQUIRED", 0);
      await bad(["nonsense"], "BAD_LINE", 0);
      const many = Array.from({ length: 101 }, () => line(rent.id, 1));
      eq((await newJournal({ lines: many })).body.code, "TOO_MANY_LINES");
      eq((await newJournal({ lines: "x" })).body.code, "BAD_LINES");
    });
    await test("an empty row of the editor is left out", async () => {
      const r = ok(await newJournal({ lines: [line(rent.id, 5), { accountId: "", debit: "", credit: "" }, line(cash.id, 0, 5)] }), 201);
      eq(r.lines.length, 2);
      eq(r.lines.map((l) => l.position).join(","), "0,1");
    });
    await test("only accounts a journal may use: never one the engine keeps, never another business's", async () => {
      const refused = async (accountId, code) => {
        const r = await newJournal({ lines: [line(rent.id, 5), line(accountId, 0, 5)] });
        eq(r.status, 400, JSON.stringify(r.body));
        eq(r.body.code, code);
        eq(r.body.line, 1);
      };
      await refused(ar.id, "ACCOUNT_NOT_ALLOWED");
      await refused(kashbook.id, "ACCOUNT_NOT_ALLOWED");
      await refused(rivalCash.id, "ACCOUNT_NOT_FOUND");
      await refused("00000000-0000-4000-8000-000000000000", "ACCOUNT_NOT_FOUND");
      const resting = await mkAccount(`Resting ${tag}`, "other_current_asset", { inactiveAt: new Date() });
      await refused(resting.id, "ACCOUNT_NOT_ALLOWED");
      ok(await newJournal({ status: "published", lines: [line(equity.id, 0, 7), line(vat.id, 7)] }), 201, "equity and VAT Payable are the owner's to adjust");
    });
    await test("a draft may be unbalanced; it is published once it balances", async () => {
      const d = ok(await newJournal({ lines: [line(rent.id, 100)] }), 201);
      eq(d.balanced, false);
      const p1 = await call("POST", `/journals/${d.id}/publish`, T);
      eq(p1.body.code, "NOT_BALANCED");
      eq(p1.body.difference, 100);
      const fixed = ok(await call("PATCH", `/journals/${d.id}`, T, { lines: move(100) }), 200);
      eq(fixed.status, "draft");
      eq(fixed.balanced, true);
      const pub = ok(await call("POST", `/journals/${d.id}/publish`, T), 200);
      eq(pub.status, "published");
      const again = ok(await call("POST", `/journals/${d.id}/publish`, T), 200);
      eq(again.status, "published", "publishing twice changes nothing");
    });
    await test("a published journal may be edited, stays balanced, and may go back to a draft", async () => {
      const r = await call("PATCH", `/journals/${j2.id}`, T, { lines: [line(rent.id, 10), line(cash.id, 0, 9)] });
      eq(r.body.code, "NOT_BALANCED", "a published journal stays balanced");
      const e = ok(await call("PATCH", `/journals/${j2.id}`, T, { lines: move(1200), note: "Corrected", date: OPEN }), 200);
      eq(e.status, "published");
      eq(e.totalDebit, 1200);
      eq(e.note, "Corrected");
      eq(e.number, "MJ-00002", "its number stays");
      const stored = await prisma.manualJournalLine.findMany({ where: { journalId: j2.id } });
      eq(stored.length, 2, "the lines were replaced, not added to");
      const back = ok(await call("PATCH", `/journals/${j2.id}`, T, { status: "draft" }), 200);
      eq(back.status, "draft");
      ok(await call("PATCH", `/journals/${j2.id}`, T, { status: "published" }), 200);
      const cleared = ok(await call("PATCH", `/journals/${j2.id}`, T, { note: null }), 200);
      eq(cleared.note, null);
    });
    await test("dates and statuses are checked", async () => {
      for (const date of ["2026-02-30", "garbage", 20261001, "2026-1-5"]) {
        const r = await newJournal({ date });
        eq(r.body.code, "BAD_DATE", `date ${date}`);
      }
      eq((await call("PATCH", `/journals/${j1.id}`, T, { date: null })).body.code, "BAD_DATE");
      eq((await newJournal({ status: "posted" })).body.code, "BAD_STATUS");
      eq((await newJournal({ note: "x".repeat(501) })).body.code, "NOTE_TOO_LONG");
      eq((await newJournal({ note: { a: 1 } })).body.code, "BAD_NOTE");
      const future = ok(await newJournal({ date: TOMORROW }), 201);
      eq(future.day, TOMORROW, "a journal may be dated ahead");
    });
    await test("an account the journal names already is kept on an edit after it rests; a new resting one is not", async () => {
      const keep = await mkAccount(`Float ${tag}`);
      const j = ok(await newJournal({ status: "published", lines: [line(keep.id, 40), line(cash.id, 0, 40)] }), 201);
      await prisma.ledgerAccount.update({ where: { id: keep.id }, data: { inactiveAt: new Date() } });
      ok(await call("PATCH", `/journals/${j.id}`, T, { lines: [line(keep.id, 45), line(cash.id, 0, 45)] }), 200);
      const other = await mkAccount(`Float two ${tag}`, "other_current_asset", { inactiveAt: new Date() });
      const r = await call("PATCH", `/journals/${j.id}`, T, { lines: [line(keep.id, 45), line(other.id, 0, 45)] });
      eq(r.body.code, "ACCOUNT_NOT_ALLOWED");
      eq(r.body.line, 1);
    });
    await test("parallel creates never share a number, and the counter keeps the last one", async () => {
      const before = (await prisma.business.findUnique({ where: { id: biz.id } })).journalCounter;
      const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => newJournal({ note: `parallel ${i}` })));
      for (const r of rs) eq(r.status, 201, JSON.stringify(r.body));
      const nums = rs.map((r) => Number(r.body.number.slice(3))).sort((a, b) => a - b);
      eq(new Set(nums).size, 6, "distinct numbers");
      eq(nums[0], before + 1);
      eq(nums[5], before + 6, "no gaps");
      eq((await prisma.business.findUnique({ where: { id: biz.id } })).journalCounter, before + 6);
      const other = ok(await call("POST", "/journals", T, { businessId: biz2.id }), 201);
      eq(other.number, "MJ-00001", "each business numbers its own");
    });
    await test("the owner reads every journal; staff need the Reports permission", async () => {
      const all = ok(await call("GET", `/journals?businessId=${biz.id}`, T), 200);
      assert.ok(all.journals.length >= 10, "listed");
      assert.ok(all.journals.every((j) => j.businessId === biz.id), "this business's only");
      const pub = ok(await call("GET", `/journals?businessId=${biz.id}&status=published`, T), 200);
      assert.ok(pub.journals.length && pub.journals.every((j) => j.status === "published"), "the status filter");
      eq((await call("GET", `/journals?businessId=${biz.id}&status=void`, T)).body.code, "BAD_STATUS");
      eq((await call("GET", `/journals?businessId=${biz.id}`, tPlain)).body.code, "PERMISSION_DENIED");
      ok(await call("GET", `/journals?businessId=${biz.id}`, tReports), 200);
      ok(await call("GET", `/journals/${j2.id}`, tReports), 200);
      eq((await call("GET", `/journals/${j2.id}`, tPlain)).body.code, "PERMISSION_DENIED");
      eq((await call("GET", "/journals", T)).body.code, "BUSINESS_REQUIRED");
      eq((await call("GET", "/journals/not-a-uuid", T)).status, 400);
    });
    await test("only the owner writes; staff with every permission are refused", async () => {
      for (const t of [tReports, tBank]) {
        eq((await newJournal({ lines: move(1) }, t)).body.code, "OWNER_ONLY");
        eq((await call("PATCH", `/journals/${j1.id}`, t, { note: "x" })).body.code, "OWNER_ONLY");
        eq((await call("POST", `/journals/${j1.id}/publish`, t)).body.code, "OWNER_ONLY");
        eq((await call("DELETE", `/journals/${j1.id}`, t)).body.code, "OWNER_ONLY");
      }
    });
    await test("another owner can neither see nor touch a journal", async () => {
      eq((await call("GET", `/journals?businessId=${biz.id}`, TR)).status, 404);
      eq((await call("GET", `/journals/${j2.id}`, TR)).status, 404);
      eq((await call("PATCH", `/journals/${j2.id}`, TR, { note: "mine" })).status, 404);
      eq((await call("DELETE", `/journals/${j2.id}`, TR)).status, 404);
      eq((await call("POST", "/journals", TR, { businessId: biz.id })).status, 404);
      eq((await call("POST", "/journals", T, { businessId: { not: "x" } })).body.code, "BAD_ID");
    });
    await test("a deleted journal is gone, and its number is not used again", async () => {
      const d = ok(await newJournal({ note: "to delete" }), 201);
      eq((await call("DELETE", `/journals/${d.id}`, T)).status, 204);
      eq((await call("GET", `/journals/${d.id}`, T)).status, 404);
      eq(await prisma.manualJournalLine.count({ where: { journalId: d.id } }), 0);
      const n = ok(await newJournal({}), 201);
      eq(Number(n.number.slice(3)), Number(d.number.slice(3)) + 1);
    });
    await test("an account a journal line names can't be deleted from under it", async () => {
      const acc = await mkAccount(`Named ${tag}`);
      ok(await newJournal({ lines: [line(acc.id, 3), line(cash.id, 0, 3)] }), 201);
      await assert.rejects(prisma.ledgerAccount.delete({ where: { id: acc.id } }), "refused by the line's key");
      assert.ok(await prisma.ledgerAccount.findUnique({ where: { id: acc.id } }), "still there");
    });
    await test("a business with journals can still be deleted, journals and all", async () => {
      const gone = await mkBiz(owner.id, "Mj Gone");
      const goneCash = (await accountsFor(gone.id)).find((a) => a.systemKey === chart.SYS.CASH);
      const goneRent = (await accountsFor(gone.id)).find((a) => a.categorySlug === "rent");
      const j = ok(await call("POST", "/journals", T, { businessId: gone.id, status: "published", lines: [line(goneRent.id, 9), line(goneCash.id, 0, 9)] }), 201);
      ok(await call("DELETE", `/businesses/${gone.id}`, T), 200);
      eq(await prisma.manualJournal.count({ where: { id: j.id } }), 0);
      eq(await prisma.ledgerAccount.count({ where: { businessId: gone.id } }), 0);
    });

    // ════════════════════════════════════════════════════════════════════
    section("The lock date: who sets it, and to what");
    await test("only the owner sets it, on their own business", async () => {
      eq((await setLock(LOCK, tBank)).body.code, "OWNER_ONLY");
      eq((await setLock(LOCK, tReports)).body.code, "OWNER_ONLY");
      eq((await setLock(LOCK, TR)).status, 404, "another owner's business");
    });
    await test("a day up to yesterday, or null; nothing else (today stays open)", async () => {
      eq((await call("PUT", `/businesses/${biz.id}/books-lock`, T, {})).body.code, "BAD_DATE");
      for (const date of ["2026-13-01", "2026-02-29", "yesterday", 5, TOMORROW, TODAY, `${LOCK}T00:00:00Z`]) {
        const r = await setLock(date);
        eq(r.status, 400, `date ${date}`);
        eq(r.body.code, "BAD_DATE");
      }
      const t = ok(await setLock(YESTERDAY), 200);
      eq(t.booksLockDate, YESTERDAY, "yesterday may be locked");
      eq(t.kycBvn, undefined, "the business as GET /businesses sends it");
      const n = ok(await setLock(null), 200);
      eq(n.booksLockDate, null, "null unlocks");
      eq((await prisma.business.findUnique({ where: { id: biz.id } })).booksLockDate, null);
    });
    await test("the lock is set under the business lock", async () => {
      let released = 0;
      let held;
      const holding = new Promise((r) => (held = r));
      const hold = prisma.withBusinessLock(biz.id, async () => {
        held();
        await sleep(700);
        released = Date.now();
      });
      await holding;
      const r = await setLock(null);
      const done = Date.now();
      await hold;
      ok(r, 200);
      assert.ok(done >= released, "the lock date waited for the business lock");
    });
    await test("a write waiting on the business lock sees a lock date set meanwhile", async () => {
      let held;
      let release;
      const holding = new Promise((r) => (held = r));
      const releasing = new Promise((r) => (release = r));
      const hold = prisma.withBusinessLock(biz.id, async () => {
        held();
        await releasing;
      });
      await holding;
      const sale = call("POST", "/sales", T, { businessId: biz.id, amount: 10, date: OLD });
      const journal = newJournal({ date: OLD, lines: move(1) });
      await sleep(400);
      try {
        // What PUT /businesses/:id/books-lock does while it holds the lock.
        await prisma.business.update({ where: { id: biz.id }, data: { booksLockDate: LOCK } });
        release();
        await hold;
        locked(await sale, LOCK, "the sale");
        locked(await journal, LOCK, "the journal");
      } finally {
        release();
        await prisma.business.update({ where: { id: biz.id }, data: { booksLockDate: null } });
      }
    });

    // ════════════════════════════════════════════════════════════════════
    section("Before the lock: records on both sides of it");
    // Customers, one per purpose, all of this business.
    const mkCustomer = async (name) => ok(await call("POST", "/customers", T, { businessId: biz.id, name: `${name} ${tag}` }), 201);
    const custA = await mkCustomer("Customer A");
    const custDel = await mkCustomer("To delete");
    const custDelOpen = await mkCustomer("To delete open");
    const custMatch = await mkCustomer("Matched");
    const custLink = await mkCustomer("Linked");
    const custRestore = await mkCustomer("Restored");
    const custInv = await mkCustomer("Invoiced");
    const custOther = ok(await call("POST", "/customers", T, { businessId: biz2.id, name: `Elsewhere ${tag}` }), 201);
    const orphan = await prisma.customer.create({ data: { userId: owner.id, businessId: null, name: `Orphan ${tag}` } });
    const orphanDebt = await prisma.debt.create({ data: { customerId: orphan.id, amount: 300, date: atNoon(OPEN) } });
    const orphanPay = await prisma.debtPayment.create({ data: { debtId: orphanDebt.id, amount: 50, date: atNoon(OPEN) } });

    // Sales, expenses, debts and manual rows on a locked day and an open one.
    const saleOld = ok(await call("POST", "/sales", T, { businessId: biz.id, amount: 500, date: OLD }), 201);
    const saleOpen = ok(await call("POST", "/sales", T, { businessId: biz.id, amount: 600, date: OPEN }), 201);
    const saleOpen2 = ok(await call("POST", "/sales", T, { businessId: biz.id, amount: 650, date: OPEN }), 201);
    const saleMatchedOld = ok(await call("POST", "/sales", T, { businessId: biz.id, amount: 400, date: OPEN }), 201);
    const saleToMatchOld = ok(await call("POST", "/sales", T, { businessId: biz.id, amount: 410, date: OLD }), 201);
    const saleForOpenCredit = ok(await call("POST", "/sales", T, { businessId: biz.id, amount: 420, date: OPEN }), 201);
    const saleOldMatchedOpen = ok(await call("POST", "/sales", T, { businessId: biz.id, amount: 430, date: OLD }), 201);
    const expOld = ok(await call("POST", "/expenses", T, { businessId: biz.id, amount: 70, category: "rent", date: OLD }), 201);
    const expOpen = ok(await call("POST", "/expenses", T, { businessId: biz.id, amount: 80, category: "rent", date: OPEN }), 201);
    const expOpen2 = ok(await call("POST", "/expenses", T, { businessId: biz.id, amount: 85, category: "rent", date: OPEN }), 201);
    ok(await call("POST", `/customers/${custDel.id}/debts`, T, { amount: 90, date: OLD }), 201);
    ok(await call("POST", `/customers/${custDelOpen.id}/debts`, T, { amount: 95, date: OPEN }), 201);
    const custAWithDebt = ok(await call("POST", `/customers/${custA.id}/debts`, T, { amount: 1000, date: OPEN }), 201);
    const custADebt = custAWithDebt.debts[0];
    const manualOld = ok(await call("POST", "/transactions", T, { businessId: biz.id, type: "income", amount: 15, date: OLD }), 201);
    const manualOpen = ok(await call("POST", "/transactions", T, { businessId: biz.id, type: "income", amount: 16, date: OPEN }), 201);

    // Bank rows: credits and debits on both sides of the lock, one per use.
    const creditOld = await bankRow("income", 410, OLD);
    const creditOpenInv = await bankRow("income", 420, OPEN);
    const creditOpenForOldSale = await bankRow("income", 410, OPEN);
    const creditOldForSale = await bankRow("income", 400, OLD);
    const creditOldCreate = await bankRow("income", 111, OLD);
    const creditOpenCreate = await bankRow("income", 112, OPEN);
    const creditOldDebt = await bankRow("income", 113, OLD);
    const creditOpenDebt = await bankRow("income", 114, OPEN);
    const creditOldLink = await bankRow("income", 115, OLD);
    const creditOpenLink = await bankRow("income", 116, OPEN);
    const creditOpenLink2 = await bankRow("income", 117, OPEN);
    const creditOldClassify = await bankRow("income", 118, OLD);
    const creditOpenClassify = await bankRow("income", 119, OPEN);
    const creditOldMatched = await bankRow("income", 120, OLD);
    const creditOpenMatchedOldSale = await bankRow("income", 430, OPEN);
    const creditOpenRestore = await bankRow("income", 121, OPEN);
    const creditOpenForUnmatch = await bankRow("income", 650, OPEN);
    const debitOld = await bankRow("expense", 130, OLD);
    const debitOpen = await bankRow("expense", 131, OPEN);
    const debitOldCat = await bankRow("expense", 132, OLD);
    const debitOpenCat = await bankRow("expense", 133, OPEN);
    const debitOldForExpense = await bankRow("expense", 134, OLD);
    const debitBill = await bankRow("expense", 135, OPEN, { matchedBillId: "00000000-0000-4000-8000-0000000000b1", matchedAmount: 135 });
    const debitOldRefund = await bankRow("expense", 60, OLD);
    const debitOpenRefund = await bankRow("expense", 61, OPEN);

    // Matches made while the books are open.
    await test("records on a day that will be locked can be made while the books are open", async () => {
      ok(await call("POST", `/transactions/${creditOldForSale.id}/match`, T, { saleId: saleMatchedOld.id }), 200, "an open sale matched to a credit on a day that will be locked");
      ok(await call("POST", `/transactions/${creditOldMatched.id}/create-sale`, T, {}), 201);
      ok(await call("POST", `/transactions/${creditOpenMatchedOldSale.id}/match`, T, { saleId: saleOldMatchedOpen.id }), 200, "an open credit matched to a sale on a day that will be locked");
      ok(await call("POST", `/transactions/${creditOpenForUnmatch.id}/match`, T, { saleId: saleOpen2.id }), 200);
      // A repayment recorded on a day that will be locked, then linked to an
      // open credit: the link moves it to the credit's day, and undoing the
      // link would move it back.
      const withDebt = ok(await call("POST", `/customers/${custRestore.id}/debts`, T, { amount: 121, date: OLD }), 201);
      const debt = withDebt.debts[0];
      const paid = ok(await call("POST", `/customers/${custRestore.id}/debts/${debt.id}/payment`, T, { amount: 121, method: "cash" }), 200);
      const payment = paid.debts.find((d) => d.id === debt.id).payments[0];
      await prisma.debtPayment.update({ where: { id: payment.id }, data: { date: atNoon(OLD) } });
      ok(await call("POST", `/transactions/${creditOpenRestore.id}/link-debt-payment`, T, { debtPaymentId: payment.id }), 200);
    });
    // An expense recorded from a debit on a day that will be locked, then
    // moved to an open day of its own: it still records that debit.
    const fromDebit = ok(await call("POST", `/transactions/${debitOldForExpense.id}/create-expense`, T, {}), 201);
    ok(await call("PATCH", `/expenses/${fromDebit.expense.id}`, T, { date: OPEN }), 200);

    // Documents.
    const items = (rate) => [{ name: "Goods", quantity: 1, rate }];
    const mkDoc = async (body) => ok(await call("POST", "/invoices", T, { businessId: biz.id, items: items(1000), status: "SENT", ...body }), 201);
    const invOld = await mkDoc({ issueDate: OLD });
    const invOpen = await mkDoc({ issueDate: OPEN });
    const invOpenPaidEarly = await mkDoc({ issueDate: OPEN });
    const invForLink = await mkDoc({ issueDate: OPEN });
    const invForWriteOff = await mkDoc({ issueDate: OPEN });
    const invToWriteOffToday = await mkDoc({ issueDate: OPEN });
    const invBank = await mkDoc({ issueDate: OPEN, items: items(410) });
    const invBankOpen = await mkDoc({ issueDate: OPEN, items: items(420) });
    const draftOld = await mkDoc({ issueDate: OLD, status: "DRAFT" });
    const draftOpen = await mkDoc({ issueDate: OPEN, status: "DRAFT" });
    const quoteOld = await mkDoc({ issueDate: OLD, type: "quote", status: "DRAFT" });
    const quoteOpen = await mkDoc({ issueDate: OPEN, type: "quote", status: "DRAFT" });
    const quoteToDelete = await mkDoc({ issueDate: OLD, type: "quote", status: "DRAFT" });
    const invApply = await mkDoc({ issueDate: OPEN, customerId: custInv.id });
    const cnOpen = await mkDoc({ issueDate: OPEN, type: "credit_note", customerId: custInv.id });
    const cnOld = await mkDoc({ issueDate: OLD, type: "credit_note", customerId: custInv.id });
    const early = ok(await call("POST", `/invoices/${invOpenPaidEarly.id}/payments`, T, { amount: 100, method: "cash", date: OLD }), 201);
    const earlyPayment = early.payments.find((p) => Number(p.amount) === 100);
    const forLink = ok(await call("POST", `/invoices/${invForLink.id}/payments`, T, { amount: 115, method: "transfer", date: OPEN }), 201);
    const linkPayment = forLink.payments[0];
    // A write-off dated on a day that will be locked.
    await prisma.invoice.update({ where: { id: invForWriteOff.id }, data: { writtenOffAt: atNoon(OLD), writtenOffAmount: 1000 } });

    // A journal on each side of the lock.
    const jOld = ok(await newJournal({ date: OLD, status: "published", lines: move(25) }), 201);
    const jOldDraft = ok(await newJournal({ date: OLD, lines: move(26) }), 201);
    const jOpen = ok(await newJournal({ date: OPEN, status: "published", lines: move(27) }), 201);

    // ════════════════════════════════════════════════════════════════════
    section(`Locked up to ${LOCK}`);
    await test("the owner locks the books, and GET /businesses shows it", async () => {
      eq(ok(await setLock(LOCK), 200).booksLockDate, LOCK);
      const list = ok(await call("GET", "/businesses", T), 200);
      eq(list.find((b) => b.id === biz.id).booksLockDate, LOCK);
      eq(list.find((b) => b.id === biz2.id).booksLockDate, null, "another business stays open");
      const log = await prisma.auditLog.findFirst({ where: { action: "BOOKS_LOCK_SET", resourceId: biz.id }, orderBy: { createdAt: "desc" } });
      eq(log && log.metadata && log.metadata.to, LOCK, "audited");
    });

    section("Journals and the lock");
    await test("nothing is added on or before the lock date; after it, it is", async () => {
      locked(await newJournal({ date: OLD, lines: move(1) }), LOCK, "before");
      locked(await newJournal({ date: LOCK, lines: move(1) }), LOCK, "on the lock date");
      ok(await newJournal({ date: OPEN, lines: move(1) }), 201);
      ok(await call("POST", "/journals", T, { businessId: biz2.id, date: OLD }), 201, "another business's own lock");
    });
    await test("a locked journal is not edited, published or deleted; an open one is not moved into the lock", async () => {
      locked(await call("PATCH", `/journals/${jOld.id}`, T, { note: "x" }), LOCK, "edit");
      locked(await call("PATCH", `/journals/${jOld.id}`, T, { date: OPEN }), LOCK, "moved out");
      locked(await call("POST", `/journals/${jOldDraft.id}/publish`, T), LOCK, "publish");
      locked(await call("DELETE", `/journals/${jOld.id}`, T), LOCK, "delete");
      locked(await call("DELETE", `/journals/${jOldDraft.id}`, T), LOCK, "a draft too");
      locked(await call("PATCH", `/journals/${jOpen.id}`, T, { date: OLD }), LOCK, "moved in");
      ok(await call("PATCH", `/journals/${jOpen.id}`, T, { note: "still open" }), 200);
      ok(await call("POST", `/journals/${jOld.id}/publish`, T), 200, "a published one asked again changes nothing");
    });

    section("Sales");
    await test("a sale on or before the lock date is refused; after it, saved", async () => {
      locked(await call("POST", "/sales", T, { businessId: biz.id, amount: 10, date: OLD }));
      locked(await call("POST", "/sales", T, { businessId: biz.id, amount: 10, date: LOCK }));
      ok(await call("POST", "/sales", T, { businessId: biz2.id, amount: 10, date: OLD }), 201, "another business's own lock");
    });
    await test("the day a sale lands on is the day the books read", async () => {
      // 22:30 UTC on the lock date is 23:30 in Lagos, still the lock date.
      locked(await call("POST", "/sales", T, { businessId: biz.id, amount: 10, date: `${LOCK}T22:30:00.000Z` }));
      // 23:30 UTC is 00:30 the next day in Lagos: open.
      ok(await call("POST", "/sales", T, { businessId: biz.id, amount: 10, date: `${LOCK}T23:30:00.000Z` }), 201);
      ok(await call("POST", "/sales", T, { businessId: biz.id, amount: 10, date: OPEN }), 201);
    });
    await test("a locked sale is not edited or deleted; an open one is not moved into the lock", async () => {
      locked(await call("PATCH", `/sales/${saleOld.id}`, T, { notes: "x" }), LOCK, "edit");
      locked(await call("PATCH", `/sales/${saleOld.id}`, T, { date: OPEN }), LOCK, "moved out");
      locked(await call("DELETE", `/sales/${saleOld.id}`, T), LOCK, "delete");
      locked(await call("PATCH", `/sales/${saleOpen.id}`, T, { date: OLD }), LOCK, "moved in");
      ok(await call("PATCH", `/sales/${saleOpen.id}`, T, { notes: "fine" }), 200);
    });
    await test("an open sale matched to a locked transfer keeps its amount; its notes still change", async () => {
      locked(await call("PATCH", `/sales/${saleMatchedOld.id}`, T, { amount: 390 }), LOCK, "amount");
      ok(await call("PATCH", `/sales/${saleMatchedOld.id}`, T, { notes: "noted" }), 200);
      locked(await call("DELETE", `/sales/${saleMatchedOld.id}`, T), LOCK, "deleting it frees the locked transfer");
    });
    await test("staff are held to the lock date too", async () => {
      locked(await call("POST", "/sales", tPlain, { businessId: biz.id, amount: 10, date: OLD }));
    });
    await test("a credit sale opens a debt only for this business's own customer", async () => {
      const own = ok(await call("POST", "/sales", T, { businessId: biz.id, amount: 33, date: OPEN, isCredit: true, paymentMethod: "credit", customerId: custA.id }), 201);
      assert.ok(own.debt, "a debt for this business's customer");
      const other = ok(await call("POST", "/sales", T, { businessId: biz.id, amount: 34, date: OPEN, isCredit: true, paymentMethod: "credit", customerId: custOther.id }), 201);
      eq(other.debt, null, "another business's customer");
      const none = ok(await call("POST", "/sales", T, { businessId: biz.id, amount: 35, date: OPEN, isCredit: true, paymentMethod: "credit", customerId: orphan.id }), 201);
      eq(none.debt, null, "a customer with no business");
      eq(await prisma.debt.count({ where: { saleId: { in: [other.id, none.id] } } }), 0);
    });

    section("Expenses");
    await test("an expense on or before the lock date is refused; after it, saved", async () => {
      locked(await call("POST", "/expenses", T, { businessId: biz.id, amount: 10, category: "rent", date: OLD }));
      locked(await call("POST", "/expenses", T, { businessId: biz.id, amount: 10, category: "rent", date: LOCK }));
      ok(await call("POST", "/expenses", T, { businessId: biz.id, amount: 10, category: "rent", date: OPEN }), 201);
      ok(await call("POST", "/expenses", T, { businessId: biz2.id, amount: 10, category: "rent", date: OLD }), 201, "another business's own lock");
    });
    await test("a locked expense is not edited or deleted; an open one is not moved into the lock", async () => {
      locked(await call("PATCH", `/expenses/${expOld.id}`, T, { notes: "x" }), LOCK, "edit");
      locked(await call("PATCH", `/expenses/${expOld.id}`, T, { date: OPEN }), LOCK, "moved out");
      locked(await call("DELETE", `/expenses/${expOld.id}`, T), LOCK, "delete");
      locked(await call("PATCH", `/expenses/${expOpen.id}`, T, { date: OLD }), LOCK, "moved in");
      ok(await call("PATCH", `/expenses/${expOpen.id}`, T, { notes: "fine" }), 200);
      ok(await call("DELETE", `/expenses/${expOpen2.id}`, T), 200);
    });
    await test("receipts are exempt: one comes off a locked expense", async () => {
      await prisma.expense.update({
        where: { id: expOld.id },
        data: { attachments: [{ id: "r-a3", name: "Receipt", mime: "image/png", size: 10, uploadedAt: new Date().toISOString() }] },
      });
      const r = ok(await call("DELETE", `/expenses/${expOld.id}/attachments/r-a3`, T), 200);
      eq(r.attachments.length, 0);
    });

    section("Invoices, credit notes and quotes");
    await test("a document on or before the lock date is refused, a draft included; a quote never is", async () => {
      locked(await call("POST", "/invoices", T, { businessId: biz.id, issueDate: OLD, items: items(5), status: "SENT" }));
      locked(await call("POST", "/invoices", T, { businessId: biz.id, issueDate: LOCK, items: items(5) }), LOCK, "a draft");
      locked(await call("POST", "/invoices", T, { businessId: biz.id, issueDate: OLD, items: items(5), type: "credit_note", status: "SENT" }), LOCK, "a credit note");
      ok(await call("POST", "/invoices", T, { businessId: biz.id, issueDate: OLD, items: items(5), type: "quote" }), 201, "a quote");
      ok(await call("POST", "/invoices", T, { businessId: biz.id, issueDate: OPEN, items: items(5), status: "SENT" }), 201);
    });
    await test("a locked document is not edited; an open one is not moved into the lock", async () => {
      locked(await call("PUT", `/invoices/${invOld.id}`, T, { issueDate: OLD, items: items(1000), notes: "x" }), LOCK, "edit");
      locked(await call("PUT", `/invoices/${invOld.id}`, T, { issueDate: OPEN, items: items(1000) }), LOCK, "moved out");
      locked(await call("PUT", `/invoices/${invOpen.id}`, T, { issueDate: OLD, items: items(1000) }), LOCK, "moved in");
      locked(await call("PUT", `/invoices/${draftOld.id}`, T, { issueDate: OLD, items: items(900) }), LOCK, "a draft");
      ok(await call("PUT", `/invoices/${invOpen.id}`, T, { issueDate: OPEN, items: items(1000), notes: "fine" }), 200);
      ok(await call("PUT", `/invoices/${quoteOld.id}`, T, { issueDate: OLD, items: items(900) }), 200, "a quote");
    });
    await test("an open invoice with a payment dated in the lock keeps its lines and totals", async () => {
      locked(await call("PUT", `/invoices/${invOpenPaidEarly.id}`, T, { issueDate: OPEN, items: items(1200) }));
    });
    await test("a locked document is not sent, voided or deleted", async () => {
      locked(await call("PATCH", `/invoices/${draftOld.id}/status`, T, { status: "SENT" }), LOCK, "sent");
      locked(await call("PATCH", `/invoices/${invOld.id}/status`, T, { status: "VOID" }), LOCK, "voided");
      locked(await call("DELETE", `/invoices/${invOld.id}`, T), LOCK, "deleted");
      locked(await call("DELETE", `/invoices/${draftOld.id}`, T), LOCK, "a draft deleted");
      ok(await call("PATCH", `/invoices/${quoteOpen.id}/status`, T, { status: "SENT" }), 200, "a quote is never locked");
      ok(await call("DELETE", `/invoices/${quoteToDelete.id}`, T), 200, "an old quote may go");
      ok(await call("DELETE", `/invoices/${draftOpen.id}`, T), 200);
    });
    await test("payments: none dated in the lock, none taken from a locked transfer", async () => {
      locked(await call("POST", `/invoices/${invOpen.id}/payments`, T, { amount: 10, method: "cash", date: OLD }), LOCK, "dated in the lock");
      ok(await call("POST", `/invoices/${invOpen.id}/payments`, T, { amount: 10, method: "cash", date: OPEN }), 201);
      locked(await call("POST", `/invoices/${invBank.id}/payments`, T, { amount: 410, method: "bank", transactionId: creditOld.id }), LOCK, "a locked credit");
      eq((await prisma.transaction.findUnique({ where: { id: creditOld.id } })).matchedInvoiceId, null, "the credit is left as it was");
      ok(await call("POST", `/invoices/${invBankOpen.id}/payments`, T, { amount: 420, method: "bank", transactionId: creditOpenInv.id }), 201);
      locked(await call("DELETE", `/invoices/${invOpenPaidEarly.id}/payments/${earlyPayment.id}`, T), LOCK, "undoing a payment dated in the lock");
    });
    await test("a payment is not linked to a locked transfer", async () => {
      locked(await call("POST", `/invoices/${invForLink.id}/payments/${linkPayment.id}/link`, T, { transactionId: creditOldLink.id }));
      ok(await call("POST", `/invoices/${invForLink.id}/payments/${linkPayment.id}/link`, T, { transactionId: creditOpenLink2.id }), 200);
    });
    await test("write-offs: a locked one is not undone; one dated today is fine", async () => {
      locked(await call("DELETE", `/invoices/${invForWriteOff.id}/write-off`, T));
      ok(await call("POST", `/invoices/${invToWriteOffToday.id}/write-off`, T), 200);
      ok(await call("DELETE", `/invoices/${invToWriteOffToday.id}/write-off`, T), 200);
    });
    await test("credit notes: no refund dated in the lock or paid by a locked debit; credit applied today is fine", async () => {
      locked(await call("POST", `/invoices/${cnOpen.id}/refund`, T, { amount: 10, method: "cash", date: OLD }), LOCK, "dated in the lock");
      locked(await call("POST", `/invoices/${cnOpen.id}/refund`, T, { amount: 60, method: "bank", transactionId: debitOldRefund.id }), LOCK, "a locked debit");
      eq((await prisma.transaction.findUnique({ where: { id: debitOldRefund.id } })).purpose, null, "the debit is left as it was");
      ok(await call("POST", `/invoices/${cnOpen.id}/refund`, T, { amount: 61, method: "bank", transactionId: debitOpenRefund.id }), 201);
      ok(await call("POST", `/invoices/${cnOpen.id}/apply-credit`, T, { invoiceId: invApply.id, amount: 5 }), 201);
      locked(await call("PUT", `/invoices/${cnOld.id}`, T, { issueDate: OLD, items: items(900) }), LOCK, "a locked credit note");
    });
    await test("a quote dated in the lock is not converted until it is moved out; an open one is", async () => {
      locked(await call("POST", `/invoices/${quoteOld.id}/convert-to-invoice`, T));
      eq((await prisma.invoice.findUnique({ where: { id: quoteOld.id } })).type, "quote", "still a quote");
      const conv = ok(await call("POST", `/invoices/${quoteOpen.id}/convert-to-invoice`, T), 200);
      eq(conv.type, "invoice");
      ok(await call("PUT", `/invoices/${quoteOld.id}`, T, { issueDate: OPEN, items: items(900) }), 200, "moved out of the lock");
      ok(await call("POST", `/invoices/${quoteOld.id}/convert-to-invoice`, T), 200);
    });
    await test("the automatic matcher skips a locked credit, and still pays from an open one", async () => {
      const inv = await mkDoc({ issueDate: OPEN, items: items(777.77) });
      const lockedCredit = await bankRow("income", 777.77, OLD);
      await tryMatchInvoice(await prisma.business.findUnique({ where: { id: biz.id } }), 777.77, "e2e", { transactionId: lockedCredit.id });
      eq(await prisma.invoicePayment.count({ where: { invoiceId: inv.id } }), 0, "nothing paid on a locked day");
      eq((await prisma.transaction.findUnique({ where: { id: lockedCredit.id } })).matchedInvoiceId, null, "the credit stays as it came");
      const openCredit = await bankRow("income", 777.77, OPEN);
      await tryMatchInvoice(await prisma.business.findUnique({ where: { id: biz.id } }), 777.77, "e2e", { transactionId: openCredit.id });
      eq(await prisma.invoicePayment.count({ where: { invoiceId: inv.id, transactionId: openCredit.id } }), 1, "paid from the open credit");
      eq((await prisma.transaction.findUnique({ where: { id: openCredit.id } })).matchedInvoiceId, inv.id);
    });

    section("Customers and debts");
    await test("a new customer names its business", async () => {
      const none = await call("POST", "/customers", T, { name: `No business ${tag}` });
      eq(none.status, 400);
      eq(none.body.code, "BUSINESS_REQUIRED");
      eq((await call("POST", "/customers", T, { name: "x", businessId: "" })).body.code, "BUSINESS_REQUIRED");
      eq((await call("POST", "/customers", T, { name: "x", businessId: { not: "y" } })).body.code, "BAD_ID");
      eq((await call("POST", "/customers", T, { name: "x", businessId: rivalBiz.id })).status, 403);
      const c = ok(await call("POST", "/customers", T, { name: `Named ${tag}`, businessId: biz.id }), 201);
      eq(c.businessId, biz.id);
    });
    await test("a customer with no business takes no debts or repayments", async () => {
      eq((await call("POST", `/customers/${orphan.id}/debts`, T, { amount: 10 })).body.code, "BUSINESS_REQUIRED");
      eq((await call("POST", `/customers/${orphan.id}/credit`, T, { amount: 10 })).body.code, "BUSINESS_REQUIRED");
      eq((await call("POST", `/customers/${orphan.id}/debts/${orphanDebt.id}/payment`, T, { amount: 10 })).body.code, "BUSINESS_REQUIRED");
      eq(await prisma.debt.count({ where: { customerId: orphan.id } }), 1, "nothing added");
    });
    await test("a debt on or before the lock date is refused; after it, added", async () => {
      locked(await call("POST", `/customers/${custA.id}/debts`, T, { amount: 10, date: OLD }));
      locked(await call("POST", `/customers/${custA.id}/credit`, T, { amount: 10, date: LOCK }), LOCK, "the older route");
      ok(await call("POST", `/customers/${custA.id}/debts`, T, { amount: 10, date: OPEN }), 201);
      ok(await call("POST", `/customers/${custA.id}/credit`, T, { amount: 10, date: OPEN }), 200);
    });
    await test("a repayment today is fine while the lock is in the past", async () => {
      ok(await call("POST", `/customers/${custA.id}/debts/${custADebt.id}/payment`, T, { amount: 10, method: "cash" }), 200);
    });
    await test("a customer whose credit falls in the lock is not deleted; one after it is", async () => {
      locked(await call("DELETE", `/customers/${custDel.id}`, T));
      ok(await call("DELETE", `/customers/${custDelOpen.id}`, T), 200);
    });

    section("Bank rows");
    await test("matching: neither a locked transfer nor a locked sale", async () => {
      locked(await call("POST", `/transactions/${creditOld.id}/match`, T, { saleId: saleOpen.id }), LOCK, "a locked credit");
      locked(await call("POST", `/transactions/${creditOpenForOldSale.id}/match`, T, { saleId: saleToMatchOld.id }), LOCK, "a locked sale");
      const sale = await prisma.sales.findUnique({ where: { id: saleToMatchOld.id } });
      eq(sale.matchedTransactionId, null, "the sale is left as it was");
      ok(await call("POST", `/transactions/${creditOpenLink.id}/match`, T, { saleId: saleForOpenCredit.id }), 200);
    });
    await test("a sale or an expense is not recorded from a locked transfer", async () => {
      locked(await call("POST", `/transactions/${creditOldCreate.id}/create-sale`, T, {}), LOCK, "create-sale");
      ok(await call("POST", `/transactions/${creditOpenCreate.id}/create-sale`, T, {}), 201);
      locked(await call("POST", `/transactions/${debitOld.id}/create-expense`, T, {}), LOCK, "create-expense");
      ok(await call("POST", `/transactions/${debitOpen.id}/create-expense`, T, {}), 201);
      locked(await call("POST", `/transactions/${creditOldCreate.id}/create-sale`, tBank, {}), LOCK, "staff too");
    });
    await test("a locked transfer is not applied to a debt; this business's customers only", async () => {
      locked(await call("POST", `/transactions/${creditOldDebt.id}/match-debt`, T, { customerId: custA.id }));
      eq((await call("POST", `/transactions/${creditOpenDebt.id}/match-debt`, T, { customerId: custOther.id })).status, 404, "another business's customer");
      eq((await call("POST", `/transactions/${creditOpenDebt.id}/match-debt`, T, { customerId: orphan.id })).status, 404, "a customer with no business");
      ok(await call("POST", `/transactions/${creditOpenDebt.id}/match-debt`, T, { customerId: custA.id }), 200);
    });
    await test("a repayment is not linked across the lock, nor one of a customer with no business", async () => {
      const withDebt = ok(await call("POST", `/customers/${custLink.id}/debts`, T, { amount: 115, date: OPEN }), 201);
      const debt = withDebt.debts[0];
      const paid = ok(await call("POST", `/customers/${custLink.id}/debts/${debt.id}/payment`, T, { amount: 100, method: "cash" }), 200);
      const payment = paid.debts.find((d) => d.id === debt.id).payments[0];
      locked(await call("POST", `/transactions/${creditOldLink.id}/link-debt-payment`, T, { debtPaymentId: payment.id }), LOCK, "a locked credit");
      const orphanCredit = await bankRow("income", 60, OPEN);
      eq((await call("POST", `/transactions/${orphanCredit.id}/link-debt-payment`, T, { debtPaymentId: orphanPay.id })).body.code, "PAYMENT_NOT_FOUND", "no business");
      await prisma.debtPayment.update({ where: { id: payment.id }, data: { date: atNoon(OLD) } });
      const fresh = await bankRow("income", 150, OPEN);
      locked(await call("POST", `/transactions/${fresh.id}/link-debt-payment`, T, { debtPaymentId: payment.id }), LOCK, "a repayment dated in the lock");
      eq((await prisma.debtPayment.findUnique({ where: { id: payment.id } })).transactionId, null, "the repayment is left as it was");
    });
    await test("a locked transfer is not marked or categorized", async () => {
      locked(await call("POST", `/transactions/${creditOldClassify.id}/classify`, T, { purpose: "cash_deposit" }), LOCK, "classify");
      ok(await call("POST", `/transactions/${creditOpenClassify.id}/classify`, T, { purpose: "cash_deposit" }), 200);
      locked(await call("POST", `/transactions/${debitOldCat.id}/categorize`, T, { accountId: rent.id }), LOCK, "categorize");
      ok(await call("POST", `/transactions/${debitOpenCat.id}/categorize`, T, { accountId: rent.id }), 200);
    });
    await test("unmatching: not a locked transfer, not one whose sale is locked, not one whose repayment goes back into the lock", async () => {
      locked(await call("DELETE", `/transactions/${creditOldMatched.id}/match?deleteSale=true`, T), LOCK, "a locked credit");
      locked(await call("DELETE", `/transactions/${creditOpenMatchedOldSale.id}/match`, T), LOCK, "a locked sale");
      locked(await call("DELETE", `/transactions/${creditOpenRestore.id}/match`, T), LOCK, "a linked repayment going back to its locked day");
      ok(await call("DELETE", `/transactions/${creditOpenForUnmatch.id}/match`, T), 200);
    });
    await test("an open expense recording a locked transfer keeps its amount; its notes still change", async () => {
      ok(await call("PATCH", `/expenses/${fromDebit.expense.id}`, T, { notes: "noted" }), 200);
      locked(await call("PATCH", `/expenses/${fromDebit.expense.id}`, T, { amount: 120 }), LOCK, "amount");
      locked(await call("DELETE", `/expenses/${fromDebit.expense.id}`, T), LOCK, "deleting it frees the locked transfer");
    });
    await test("manual rows: none dated in the lock, none edited or deleted there", async () => {
      locked(await call("POST", "/transactions", T, { businessId: biz.id, type: "income", amount: 5, date: OLD }));
      ok(await call("POST", "/transactions", T, { businessId: biz.id, type: "income", amount: 5, date: OPEN }), 201);
      locked(await call("PATCH", `/transactions/${manualOld.id}`, T, { description: "x" }), LOCK, "edit");
      locked(await call("PATCH", `/transactions/${manualOpen.id}`, T, { date: OLD }), LOCK, "moved in");
      locked(await call("DELETE", `/transactions/${manualOld.id}`, T), LOCK, "delete");
      ok(await call("DELETE", `/transactions/${manualOpen.id}`, T), 200);
    });
    await test("a debit that paid a bill is never explained a second way", async () => {
      eq((await call("POST", `/transactions/${debitBill.id}/create-expense`, T, {})).body.code, "ALREADY_MATCHED");
      eq((await call("POST", `/transactions/${debitBill.id}/categorize`, T, { accountId: rent.id })).body.code, "ALREADY_MATCHED");
      eq((await call("DELETE", `/transactions/${debitBill.id}/match`, T)).body.code, "BILL_LINKED");
      const cn = await mkDoc({ issueDate: OPEN, type: "credit_note", items: items(135) });
      eq((await call("POST", `/invoices/${cn.id}/refund`, T, { amount: 135, method: "bank", transactionId: debitBill.id })).body.code, "TRANSACTION_TAKEN");
      const row = await prisma.transaction.findUnique({ where: { id: debitBill.id } });
      eq(row.matchedExpenseId, null);
      eq(row.accountId, null);
      eq(row.purpose, null);
    });

    // ════════════════════════════════════════════════════════════════════
    // The route locks up to yesterday at the latest; a lock date of today (an
    // older lock, or one written by hand) must still hold, so it is written
    // straight to the business here.
    const lockToday = (bizId) => prisma.business.update({ where: { id: bizId }, data: { booksLockDate: TODAY } });
    section(`Locked up to today (${TODAY}), written directly`);
    await test("today's own writes wait for tomorrow", async () => {
      await lockToday(biz.id);
      locked(await call("POST", "/sales", T, { businessId: biz.id, amount: 10 }), TODAY, "a sale dated now");
      locked(await call("POST", "/expenses", T, { businessId: biz.id, amount: 10, category: "rent" }), TODAY, "an expense dated now");
      locked(await newJournal({ lines: move(1) }), TODAY, "a journal dated today");
      locked(await call("POST", `/invoices/${invOpen.id}/payments`, T, { amount: 10, method: "cash" }), TODAY, "a payment dated now");
      locked(await call("POST", `/invoices/${invToWriteOffToday.id}/write-off`, T), TODAY, "a write-off");
      locked(await call("POST", `/invoices/${cnOpen.id}/apply-credit`, T, { invoiceId: invApply.id, amount: 5 }), TODAY, "applying credit");
      locked(await call("POST", `/customers/${custA.id}/debts/${custADebt.id}/payment`, T, { amount: 10, method: "cash" }), TODAY, "a repayment");
      locked(await call("POST", "/invoices", T, { businessId: biz.id, issueDate: TODAY, items: items(5), status: "SENT" }), TODAY, "an invoice dated today");
    });
    await test("a date the books cannot read as a day (year 11476, year -1) counts as locked", async () => {
      const count0 = await prisma.transaction.count({ where: { businessId: biz.id } });
      for (const date of ["+011476-03-01T00:00:00.000Z", "-000001-06-01T00:00:00.000Z"]) {
        locked(await call("POST", "/transactions", T, { businessId: biz.id, type: "income", amount: 70, date }), TODAY, `a row dated ${date}`);
      }
      eq(await prisma.transaction.count({ where: { businessId: biz.id } }), count0, "nothing saved");
    });
    await test("a credit landing today is booked, and the matcher leaves it alone", async () => {
      const fresh = await call("POST", "/invoices", T, { businessId: biz2.id, issueDate: OPEN, items: items(321.09), status: "SENT" });
      ok(fresh, 201);
      // biz2 is open; lock biz2 today, then a credit lands today.
      await lockToday(biz2.id);
      const credit = await prisma.transaction.create({
        data: {
          businessId: biz2.id, userId: owner.id, type: "income", amount: 321.09, date: new Date(), paymentMethod: "bank",
          category: "transfer", source: "anchor", currency: "NGN", description: "today",
        },
      });
      await tryMatchInvoice(await prisma.business.findUnique({ where: { id: biz2.id } }), 321.09, "e2e", { transactionId: credit.id });
      eq(await prisma.invoicePayment.count({ where: { invoiceId: fresh.body.id } }), 0);
      assert.ok(await prisma.transaction.findUnique({ where: { id: credit.id } }), "the bank row stands");
    });

    // ════════════════════════════════════════════════════════════════════
    section("Unlocked again");
    await test("with the lock cleared, what was refused goes through", async () => {
      ok(await setLock(null), 200);
      ok(await call("PATCH", `/sales/${saleOld.id}`, T, { notes: "after the lock" }), 200);
      ok(await call("PATCH", `/journals/${jOld.id}`, T, { note: "after the lock" }), 200);
      ok(await call("POST", `/journals/${jOldDraft.id}/publish`, T), 200);
      ok(await call("PATCH", `/expenses/${expOld.id}`, T, { notes: "after the lock" }), 200);
      ok(await call("POST", `/transactions/${creditOldCreate.id}/create-sale`, T, {}), 201);
      ok(await call("DELETE", `/invoices/${draftOld.id}`, T), 200);
      ok(await call("DELETE", `/customers/${custDel.id}`, T), 200);
      ok(await call("DELETE", `/journals/${jOld.id}`, T), 204);
    });
  } finally {
    server.close();
    console.log(`\n${passed} passed, ${failed} failed`);
    await prisma.$disconnect();
    process.exit(failed ? 1 : 0);
  }
})().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
