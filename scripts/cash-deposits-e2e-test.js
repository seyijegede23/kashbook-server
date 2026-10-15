// Deposit cash, end to end (2026-10-14): the real /cash-deposits,
// /transactions, /invoices, /sync and /ledger routers over HTTP, the real
// Anchor webhook route (signed: NIP credits and KashBook to KashBook book
// transfers), the reconcile poller against a stubbed Anchor list, the real
// auth middleware and permission gates, a real local Postgres.
//
// Covers: a deposit into another bank (Cash at Hand down, that bank up, the
// profit the same); a KashBook deposit that waits and a credit of its amount
// dated from its day to three days after that links by itself (purpose
// cash_deposit, a notification, never an open invoice's payment), and one four
// days after or before its day that does not; a credit first, then the
// deposit, linked when it is recorded; two deposits and two credits, oldest
// first; undo (the same credit never again, a new one yes); the owner's pick
// outside the window, and every reason a pick is refused; the guard on every
// route that changes a credit; the books lock; staff and other businesses;
// a retried request; edits and cancels; the accounts a deposit names (in use,
// merged); the sync bundle and cashDepositId on every bank row; a business
// deleted with its deposits; and, at the end, the ledger: balanced,
// Undeposited Funds the waiting deposits, Cash at Hand down by every live
// deposit, the KashBook Account equal to the bank ledger, and the profit and
// loss equal to the books rule.
//
// And, since the review (2026-10-15): one notification per credit, the
// deposit's own (its sender and day, and data the app acts on), from the
// webhook, a book transfer and the poller, the usual one for any other
// credit; a book transfer brings a deposit in like any credit; a deposit
// saved while its credit is being booked, in both orders (held open on
// purpose), from the webhook without paidAt and from the poller; the books
// lock asks a link or an undo about the transfer's day alone (a deposit dated
// in the locked part still takes its transfer, oldest first and before an
// open invoice, is undone and picked, and nothing on or before the lock moves
// in either view); a pick dated before the deposit's day (BEFORE); a transfer
// the owner had marked as cash banked, taken only when picked and given back
// by an undo (Cash at Hand falls once); no KashBook deposit for a business
// without a KashBook account; the audit keeps every day a deposit was on;
// staff never read a deposit's note; a merge refused with DEPOSIT_TARGET.
//
// Point it at a LOCAL scratch database (a clone of the migrated template):
//   node scratchpad/with-local-db.js postgres node scratchpad/clone-local-db.js kashbook_coa_e2e kashbook_coa_e2e_dep
//   node scratchpad/with-local-db.js kashbook_coa_e2e_dep node scripts/cash-deposits-e2e-test.js
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
process.env.ANCHOR_BASE_URL = "https://anchor.test.local";
process.env.ANCHOR_API_KEY = "test-key";
process.env.ANCHOR_WEBHOOK_SECRET = "e2e-anchor-webhook-secret";
// No mail leaves a test run (the webhook mails the owner when it can).
for (const k of ["SMTP_HOST", "SMTP_USER", "SMTP_PASS", "TXN_SMTP_HOST", "TXN_SMTP_USER", "TXN_SMTP_PASS"]) process.env[k] = "";

const assert = require("assert");
const crypto = require("crypto");
const http = require("http");
const express = require("express");
const prisma = require("../src/utils/db");
const { signToken } = require("../src/utils/jwt");
const chart = require("../src/utils/chart");
const { ensureChart, invalidateLedger, loadLedger } = require("../src/utils/ledgerData");
const { booksFor } = require("../src/utils/booksData");
const { computeRawLedger } = require("../src/utils/ledgerBalance");
const depositsModule = require("../src/utils/cashDeposits");
const { reconcileBusiness } = require("../src/utils/anchorReconcile");

// Anchor's /transactions list, as the reconcile poller reads it (stubbed, as
// scripts/anchor-reconcile-test.js does; a row may carry its Payment link).
// Every push to Expo is kept (PUSHES). Nothing else may leave the process
// (a Payment lookup fails here, as when Anchor is down, and is answered
// without a sender).
let LIST = [];
const PUSHES = [];
global.fetch = async (u, opts = {}) => {
  const s = String(u);
  if (s.startsWith("https://anchor.test.local/transactions")) {
    return {
      ok: true,
      json: async () => ({
        data: LIST.map((c) => ({
          id: c.id,
          type: "Transaction",
          attributes: { direction: "Credit", amount: Math.round(c.amount * 100), createdAt: c.at.toISOString() },
          relationships: c.paymentId ? { payment: { data: { id: c.paymentId } } } : {},
        })),
      }),
    };
  }
  if (s.includes("exp.host")) {
    try { PUSHES.push(JSON.parse(opts.body)); } catch { /* not JSON */ }
    return { ok: true, json: async () => ({}) };
  }
  throw new Error(`unexpected fetch ${s}`);
};

const app = express();
// As server.js mounts it: the raw body, for the signature.
app.use("/webhooks/anchor", express.raw({ type: "application/json", limit: "1mb" }), require("../src/routes/anchor"));
app.use(express.json({ limit: "2mb" }));
app.use(require("../src/middleware/idGuard").idGuard);
app.use("/cash-deposits", require("../src/routes/cashDeposits"));
app.use("/transactions", require("../src/routes/transactions"));
app.use("/invoices", require("../src/routes/invoices"));
app.use("/sync", require("../src/routes/sync"));
app.use("/ledger", require("../src/routes/ledger"));

let BASE;
const call = (method, p, token, body, headers = {}) =>
  new Promise((resolve) => {
    const data = body === undefined ? null : typeof body === "string" ? body : JSON.stringify(body);
    const r = http.request(`${BASE}${p}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}),
        ...headers,
      },
    }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        let j = null;
        try { j = JSON.parse(d); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, body: j });
      });
    });
    r.on("error", (e) => resolve({ status: 0, body: { error: e.message } }));
    if (data) r.write(data);
    r.end();
  });
const GET = (p, t) => call("GET", p, t);
const POST = (p, t, b) => call("POST", p, t, b === undefined ? {} : b);
const PATCH = (p, t, b) => call("PATCH", p, t, b === undefined ? {} : b);
const DEL = (p, t) => call("DELETE", p, t);

let passed = 0;
let failed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (e) {
    failed++;
    failures.push(name);
    console.log(`  FAIL  ${name}\n        ${String(e && e.stack ? e.stack : e).split("\n").slice(0, 3).join("\n        ")}`);
  }
}
const eq = (a, b, what = "") => assert.strictEqual(a, b, `${what} ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
const ok = (v, what) => assert.ok(v, what);
const section = (s) => console.log(`\n── ${s}`);
const status = (r, want, what = "") => assert.strictEqual(r.status, want, `${what} status ${r.status}: ${JSON.stringify(r.body)}`);
const refused = (r, want, code, what = "") => {
  status(r, want, what);
  eq(r.body && r.body.code, code, `${what} code`);
};

const tag = Date.now().toString(36);
const DAY = 86400000;
const lagosDay = (offset = 0) => new Date(Date.now() + 3600000 + offset * DAY).toISOString().slice(0, 10);
const shift = (day, n) => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const noon = (day, hh = "12") => new Date(`${day}T${hh}:00:00+01:00`);
const today = lagosDay(0);
const kobo = (n) => Math.round(Number(n) * 100);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, what, ms = 8000) {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}
// A Lagos day as the deposit's notification words it: "13 Oct".
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayWords = (day) => `${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1]}`;
const depositBody = (naira, from, day) =>
  `${naira}${from ? ` from ${from}` : ""} is your cash deposit of ${dayWords(day)}. Not right? Undo it on the deposit.`;

(async () => {
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  BASE = `http://127.0.0.1:${server.address().port}`;
  console.log(`\nDEPOSIT CASH, END TO END\n${BASE}`);

  try {
    // ── People, businesses and charts ────────────────────────────────────────
    const mkUser = (data) => prisma.user.create({
      data: { password: "x", lastName: "T", businessName: "B", country: "NG", currency: "NGN", ...data },
    });
    // The owner's phone takes pushes (each one reaches the Expo stub above).
    const owner = await mkUser({ email: `dep-${tag}@t.local`, firstName: "Ada", accountType: "OWNER", expoPushToken: `ExponentPushToken[${tag}]` });
    const rival = await mkUser({ email: `dep-rival-${tag}@t.local`, firstName: "Rival", accountType: "OWNER" });
    const nuban = String(Date.now()).slice(-10);
    const mkBiz = async (userId, name, extra = {}) => {
      const b = await prisma.business.create({ data: { userId, name: `${name} ${tag}`, country: "NG", baseCurrency: "NGN", ...extra } });
      await ensureChart(b.id);
      return b;
    };
    const biz = await mkBiz(owner.id, "Deposits", { anchorAccountId: `dep-acct-${tag}`, virtualAccountNumber: nuban });
    const rivalBiz = await mkBiz(rival.id, "Rival");
    // Another KashBook shop, whose transfers to this one are book transfers.
    const neighbour = await mkBiz(rival.id, "Neighbour", { anchorAccountId: `nb-acct-${tag}` });
    const T = signToken({ userId: owner.id, tokenVersion: 0 });
    const TR = signToken({ userId: rival.id, tokenVersion: 0 });
    const staff = await mkUser({ email: `dep-staff-${tag}@t.local`, firstName: "Staff", accountType: "STAFF", employerId: owner.id });
    await prisma.staffPermission.create({
      data: { userId: staff.id, employerId: owner.id, grantedById: owner.id, canViewBalance: true, canViewReports: true },
    });
    const TS = signToken({ userId: staff.id, tokenVersion: 0 });
    // A second member who also holds the bills permission.
    const staffB = await mkUser({ email: `dep-staffb-${tag}@t.local`, firstName: "Staffb", accountType: "STAFF", employerId: owner.id });
    await prisma.staffPermission.create({
      data: { userId: staffB.id, employerId: owner.id, grantedById: owner.id, canViewBalance: true, canViewReports: true, canManagePayables: true },
    });
    const TSB = signToken({ userId: staffB.id, tokenVersion: 0 });
    const customer = await prisma.customer.create({ data: { userId: owner.id, businessId: biz.id, name: `Bola ${tag}` } });

    const accounts = await prisma.ledgerAccount.findMany({ where: { businessId: biz.id } });
    const sys = (k) => accounts.find((a) => a.systemKey === k);
    const CASH = sys(chart.SYS.CASH);
    const UNDEP = sys(chart.SYS.UNDEPOSITED);
    const KASHBOOK = sys(chart.SYS.KASHBOOK);
    const OTHER_BANK = sys(chart.SYS.OTHER_BANK);
    const BANK_MATCH = sys(chart.SYS.BANK_MATCH);
    const RENT = accounts.find((a) => a.categorySlug === "rent");
    const PREPAID = accounts.find((a) => a.seed === "prepaid_expenses");
    const rivalOther = (await prisma.ledgerAccount.findMany({ where: { businessId: rivalBiz.id } })).find((a) => a.systemKey === chart.SYS.OTHER_BANK);
    for (const [n, a] of Object.entries({ CASH, UNDEP, KASHBOOK, OTHER_BANK, BANK_MATCH, RENT, PREPAID, rivalOther })) ok(a, `chart has ${n}`);

    const bizRow = { id: biz.id, userId: owner.id, name: biz.name, baseCurrency: "NGN" };
    let seq = 0;
    // A credit as the Anchor webhook books it.
    const credit = async (amount, date, over = {}, b = biz) => {
      const n = ++seq;
      const row = await prisma.transaction.create({
        data: {
          businessId: b.id, userId: b.userId, type: "income", amount, category: "transfer", paymentMethod: "bank",
          date, source: "anchor", currency: "NGN", description: "Transfer received from ADA OBI (GTBank Plc) · ",
          senderName: "ADA OBI", reference: `anc_pay_${tag}_${n}`, providerTxnId: `${tag}_${n}`, ...over,
        },
      });
      invalidateLedger(b.id);
      return row;
    };
    const arrive = (row) => depositsModule.matchArrivingCredit(bizRow, row);
    const deposit = (body, token = T) => POST("/cash-deposits", token, { businessId: biz.id, ...body });
    const depNow = (id) => prisma.cashDeposit.findUnique({ where: { id } });
    const txNow = (id) => prisma.transaction.findUnique({ where: { id } });
    const balances = async () => {
      invalidateLedger(biz.id);
      const r = await GET(`/ledger/balances?businessId=${biz.id}`, T);
      status(r, 200, "balances");
      return new Map(r.body.balances.map((x) => [x.accountId, x.balance]));
    };
    const profit = async (basis) => {
      invalidateLedger(biz.id);
      const r = await GET(`/ledger/reports/profit-and-loss?businessId=${biz.id}&basis=${basis}&from=${lagosDay(-60)}&to=${today}`, T);
      status(r, 200, "P&L");
      return r.body;
    };
    const kashbookDeposit = async (amount, day, extra = {}) => {
      const r = await deposit({ amount, date: day, into: "kashbook", ...extra });
      status(r, 201, `KashBook deposit ${amount}`);
      return r.body;
    };
    // The owner's notifications that name an amount (₦4,500 or ₦4,500.00),
    // oldest first. Each test below uses amounts of its own.
    const toldOf = async (naira) => {
      const re = new RegExp(`₦${Number(naira).toLocaleString("en-NG")}(\\.00)?(?![\\d,.])`);
      const all = await prisma.appNotification.findMany({ where: { userId: owner.id }, orderBy: { createdAt: "asc" } });
      return all.filter((n) => re.test(`${n.title} ${n.body}`));
    };
    // The books locked up to a day (null: open), as PUT /books-lock sets it.
    const lockBooks = (day) => prisma.business.update({ where: { id: biz.id }, data: { booksLockDate: day } });
    // Everything the ledger holds on or before `to`, in both views: each
    // entry as it is, and the balances as of that day.
    const snapshot = async (to) => {
      const out = {};
      for (const basis of ["sold", "paid"]) {
        invalidateLedger(biz.id);
        const L = await loadLedger(biz.id, { basis });
        const entries = L.entries.filter((e) => e.day <= to).map((e) => JSON.stringify(e)).sort();
        const r = await GET(`/ledger/balances?businessId=${biz.id}&asOf=${to}&basis=${basis}`, T);
        status(r, 200, `balances as of ${to}`);
        out[basis] = { entries, balances: r.body.balances };
      }
      return out;
    };
    // Credits the owner marked as cash banked ("Cash I already recorded")
    // that may end up with no deposit naming them.
    const marked = new Set();

    // ═════════════════════════════════════════════════════════════════════════
    section("a deposit into another bank");
    let otherDep;
    await test("Cash at Hand falls, Other Bank Account rises, the profit is the same in both views", async () => {
      const before = await balances();
      const plPaid = await profit("paid");
      const plSold = await profit("sold");
      const r = await deposit({ amount: 50000, date: lagosDay(-1), into: "account", intoAccountId: OTHER_BANK.id, note: "Monday's takings" });
      status(r, 201);
      otherDep = r.body.deposit;
      eq(otherDep.status, "done");
      eq(otherDep.into, "account");
      eq(otherDep.intoAccountId, OTHER_BANK.id);
      eq(otherDep.amount, 50000);
      eq(otherDep.note, "Monday's takings");
      eq(r.body.transaction, null);
      const after = await balances();
      eq(kobo(after.get(CASH.id)) - kobo(before.get(CASH.id)), -5000000, "Cash at Hand");
      eq(kobo(after.get(OTHER_BANK.id)) - kobo(before.get(OTHER_BANK.id)), 5000000, "Other Bank Account");
      eq((await profit("paid")).profit, plPaid.profit, "when paid");
      eq((await profit("sold")).profit, plSold.profit, "when sold");
      const cash = await GET(`/ledger/cash?businessId=${biz.id}`, T);
      eq(kobo(cash.body.cashAtHand), kobo(after.get(CASH.id)), "the Dashboard's Cash at Hand");
      const log = await waitFor(() => prisma.auditLog.findFirst({ where: { action: "CASH_DEPOSIT_CREATE", resourceId: otherDep.id } }), "the audit row");
      ok(log, "audited");
    });
    await test("the deposit's entry: kind cash_deposit, its ref the deposit, on its day; staff read it without the owner's note", async () => {
      invalidateLedger(biz.id);
      const range = `businessId=${biz.id}&from=${lagosDay(-1)}&to=${today}`;
      const r = await GET(`/ledger/accounts/${CASH.id}/transactions?${range}`, T);
      status(r, 200);
      const line = r.body.lines.find((l) => l.ref === otherDep.id);
      ok(line, "on the Cash at Hand statement");
      eq(line.kind, "cash_deposit");
      eq(line.day, lagosDay(-1));
      eq(line.amount, -50000);
      eq(line.memo, "Monday's takings");
      const gl = await GET(`/ledger/reports/general-ledger?${range}`, T);
      eq(gl.body.entries.find((e) => e.ref === otherDep.id).memo, "Monday's takings", "the owner, in the general ledger");
      // Deposits are the owner's alone: staff with reports and the bank, with
      // the bills permission or not, get the same lines without the note.
      for (const [who, token] of [["staff", TS], ["staff with bills", TSB]]) {
        for (const acc of [CASH, OTHER_BANK]) {
          const s = await GET(`/ledger/accounts/${acc.id}/transactions?${range}`, token);
          status(s, 200, `${who}, ${acc.name}`);
          const sl = s.body.lines.find((l) => l.ref === otherDep.id);
          ok(sl, `${who}: the line on ${acc.name}`);
          eq(sl.memo, "", `${who}: no note on ${acc.name}`);
          eq(sl.kind, "cash_deposit", who);
          eq(sl.day, lagosDay(-1), who);
          eq(Math.abs(sl.amount), 50000, who);
        }
        const g = await GET(`/ledger/reports/general-ledger?${range}`, token);
        status(g, 200, `${who}, general ledger`);
        const ge = g.body.entries.find((e) => e.ref === otherDep.id);
        ok(ge, `${who}: the general ledger entry`);
        eq(ge.memo, "", `${who}: no note in the general ledger`);
        eq(ge.kind, "cash_deposit", who);
      }
    });
    await test("refused: an account a deposit can't go into, a bad amount, a bad date", async () => {
      for (const [id, what] of [[KASHBOOK.id, "KashBook"], [BANK_MATCH.id, "Bank Matching"], [RENT.id, "Rent"], [CASH.id, "Cash"], [rivalOther.id, "another business's"], [undefined, "none"], ["nope", "unknown"]]) {
        const r = await deposit({ amount: 100, date: today, into: "account", intoAccountId: id });
        refused(r, 400, "ACCOUNT_NOT_ALLOWED", what);
        eq(r.body.field, "intoAccountId", what);
      }
      refused(await deposit({ amount: 100, date: today, into: "safe" }), 400, "ACCOUNT_NOT_ALLOWED", "into");
      for (const amount of [0, -5, 10.005, "abc", null, 1e12]) {
        const r = await deposit({ amount, date: today, into: "kashbook" });
        refused(r, 400, "BAD_AMOUNT", String(amount));
        eq(r.body.field, "amount");
      }
      for (const date of [lagosDay(1), "2026-13-40", "soon", ""]) {
        const r = await deposit({ amount: 100, date, into: "kashbook" });
        refused(r, 400, "BAD_DATE", String(date));
        eq(r.body.field, "date");
      }
      eq(await prisma.cashDeposit.count({ where: { businessId: biz.id } }), 1, "nothing saved");
    });

    // ═════════════════════════════════════════════════════════════════════════
    section("a KashBook deposit and the credit that brings it in");
    const D = lagosDay(-8);
    const windowDeps = [];
    await test("a deposit waits; a credit of its amount from its day to three days after links by itself; one notification, with what the app acts on", async () => {
      for (let k = 0; k <= 3; k++) windowDeps.push(await kashbookDeposit(1000 + k, D));
      for (const d of windowDeps) {
        eq(d.deposit.status, "waiting");
        eq(d.transaction, null);
      }
      for (let k = 0; k <= 3; k++) {
        const row = await credit(1000 + k, noon(shift(D, k), k === 3 ? "23" : "09"));
        eq(await arrive(row), true, `day ${k}`);
        const t = await txNow(row.id);
        eq(t.purpose, "cash_deposit", `day ${k} purpose`);
        eq(t.accountId, null);
        const dep = await depNow(windowDeps[k].deposit.id);
        eq(dep.status, "arrived", `day ${k}`);
        eq(dep.transactionId, row.id);
        eq(dep.autoLinked, true);
        eq(dep.arrivedAt.getTime(), row.date.getTime(), "arrived when the money did");
      }
      const want = depositBody("₦1,003", "ADA OBI", D);
      const told = await toldOf(1003);
      eq(told.length, 1, "one notification");
      eq(told[0].title, "Cash deposit arrived");
      eq(told[0].body, want, "who sent it and which deposit");
      const push = PUSHES.find((p) => p.body === want);
      ok(push, "the push went out");
      assert.deepStrictEqual(push.data, { kind: "cash_deposit", depositId: windowDeps[3].deposit.id, businessId: biz.id }, "the push's data");
      ok(await prisma.auditLog.findFirst({ where: { action: "CASH_DEPOSIT_AUTO_LINK", resourceId: windowDeps[3].deposit.id } }), "audited");
    });
    await test("while it waits Undeposited Funds holds it; once it arrives that is back to 0 and the KashBook Account has it", async () => {
      const b0 = await balances();
      const plPaid = await profit("paid");
      const plSold = await profit("sold");
      const d = await kashbookDeposit(2750.25, lagosDay(-1));
      const b1 = await balances();
      eq(kobo(b1.get(CASH.id)) - kobo(b0.get(CASH.id)), -275025, "Cash at Hand, while it waits");
      eq(kobo(b1.get(UNDEP.id)) - kobo(b0.get(UNDEP.id)), 275025, "Undeposited Funds, while it waits");
      eq(kobo(b1.get(KASHBOOK.id)), kobo(b0.get(KASHBOOK.id)), "nothing in the bank yet");
      const row = await credit(2750.25, noon(today, "03"));
      eq(await arrive(row), true);
      const b2 = await balances();
      eq(kobo(b2.get(CASH.id)) - kobo(b0.get(CASH.id)), -275025, "Cash at Hand, once");
      eq(kobo(b2.get(UNDEP.id)) - kobo(b0.get(UNDEP.id)), 0, "Undeposited Funds back to 0");
      eq(kobo(b2.get(KASHBOOK.id)) - kobo(b0.get(KASHBOOK.id)), 275025, "the KashBook Account has it");
      eq(kobo(b2.get(KASHBOOK.id)), kobo(await computeRawLedger(biz.id, "NGN")), "the KashBook Account is the bank ledger");
      eq((await profit("paid")).profit, plPaid.profit, "never a sale, when paid");
      eq((await profit("sold")).profit, plSold.profit, "never a sale, when sold");
      eq((await depNow(d.deposit.id)).status, "arrived");
      eq((await toldOf(2750.25))[0].body, depositBody("₦2,750.25", "ADA OBI", lagosDay(-1)), "kobo in the notification");
    });
    await test("a credit four days after the deposit's day, or the day before it, is left alone", async () => {
      const late = await kashbookDeposit(2004, D);
      const row4 = await credit(2004, noon(shift(D, 4), "00"));
      eq(await arrive(row4), false, "day 4");
      const rowBefore = await credit(2004, noon(shift(D, -1), "23"));
      eq(await arrive(rowBefore), false, "the day before");
      eq((await depNow(late.deposit.id)).status, "waiting");
      eq((await txNow(row4.id)).purpose, null);
      eq((await txNow(rowBefore.id)).purpose, null);
      eq((await toldOf(2004)).length, 0, "no deposit notification (the caller sends its usual one)");
      // Left for the owner, who may still pick the late one (below).
      windowDeps.push(late);
    });
    await test("a credit of another amount, or in another business, is left alone", async () => {
      const d = await kashbookDeposit(3000, today);
      eq(await arrive(await credit(3000.01, noon(today, "08"))), false, "a kobo more");
      eq(await arrive(await credit(3000, noon(today, "08"), {}, rivalBiz)), false, "another business");
      eq((await depNow(d.deposit.id)).status, "waiting");
      await POST(`/cash-deposits/${d.deposit.id}/cancel`, T);
    });

    section("the webhook and the poller: a deposit's credit is never an invoice's payment, and makes one notification");
    const sign = (raw) => crypto.createHmac("sha1", process.env.ANCHOR_WEBHOOK_SECRET).update(raw).digest("base64");
    // A NIP credit, as Anchor sends it live (with paidAt), or without paidAt.
    const webhook = (amount, paymentId, { paidAt = new Date().toISOString() } = {}) => {
      const payment = {
        paymentId, amount: Math.round(amount * 100), narration: "deposit",
        virtualNuban: { accountNumber: nuban },
        counterParty: { accountName: "ADA OBI", bank: { name: "GTBank Plc" }, accountNumber: "0123456789" },
      };
      if (paidAt) payment.paidAt = paidAt;
      const raw = JSON.stringify({ data: { id: `evt_${paymentId}`, type: "payment.settled", attributes: { payment } } });
      return call("POST", "/webhooks/anchor", null, raw, { "x-anchor-signature": sign(raw) });
    };
    // A KashBook to KashBook transfer into this business (a book transfer).
    const bookWebhook = (amount, transferId, srcAccountId) => {
      const raw = JSON.stringify({
        data: {
          id: `evt_bk_${transferId}`,
          type: "book.transfer.successful",
          attributes: { amount: Math.round(amount * 100), reason: "cash swap" },
          relationships: {
            destinationAccount: { data: { id: biz.anchorAccountId } },
            transfer: { data: { id: transferId } },
            ...(srcAccountId ? { account: { data: { id: srcAccountId } } } : {}),
          },
        },
      });
      return call("POST", "/webhooks/anchor", null, raw, { "x-anchor-signature": sign(raw) });
    };
    const invoice = async (total) => {
      const r = await POST("/invoices", T, {
        businessId: biz.id, customerId: customer.id, issueDate: today, status: "SENT", items: [{ name: "Goods", quantity: 1, rate: total }],
      });
      status(r, 201, "invoice");
      return r.body;
    };
    const arrivedNow = (id, what = "the deposit to arrive") =>
      waitFor(async () => {
        const x = await depNow(id);
        return x.status === "arrived" ? x : null;
      }, what);
    await test("webhook: the waiting deposit takes the credit, the open invoice of that amount stays open, one notification", async () => {
      const inv = await invoice(4500);
      const d = await kashbookDeposit(4500, today);
      const payId = `${tag}-dep-anc_inb_trsf`;
      status(await webhook(4500, payId), 200);
      const row = await waitFor(() => prisma.transaction.findFirst({ where: { businessId: biz.id, reference: `anc_pay_${payId}` } }), "the credit");
      const dep = await arrivedNow(d.deposit.id);
      eq(dep.transactionId, row.id);
      eq((await txNow(row.id)).purpose, "cash_deposit");
      await sleep(400); // the invoice matcher would have run by now
      const after = await prisma.invoice.findUnique({ where: { id: inv.id }, include: { payments: true } });
      eq(after.amountPaid, 0, "not paid");
      eq(after.payments.length, 0);
      const told = await toldOf(4500);
      assert.deepStrictEqual(told.map((n) => n.body), [depositBody("₦4,500", "ADA OBI", today)], "only the deposit's notification");
      const push = PUSHES.find((p) => p.body === told[0].body);
      eq(push && push.data && push.data.depositId, d.deposit.id, "its data names the deposit");
    });
    await test("webhook, no deposit waiting: the same kind of credit pays the open invoice and makes the usual notification, as before", async () => {
      const inv = await invoice(4600);
      const payId = `${tag}-inv-anc_inb_trsf`;
      status(await webhook(4600, payId), 200);
      const paid = await waitFor(async () => {
        const x = await prisma.invoice.findUnique({ where: { id: inv.id } });
        return x.amountPaid > 0 ? x : null;
      }, "the invoice to be paid");
      eq(paid.amountPaid, 4600);
      const row = await prisma.transaction.findFirst({ where: { businessId: biz.id, reference: `anc_pay_${payId}` } });
      eq(row.purpose, null);
      eq(row.matchedInvoiceId, inv.id);
      const told = await toldOf(4600);
      ok(told.some((n) => n.title === "ADA OBI sent ₦4,600.00 🎉"), "the usual notification");
      ok(!told.some((n) => n.title === "Cash deposit arrived"), "no deposit's");
    });
    await test("a book transfer (KashBook to KashBook) brings a waiting deposit in too: the open invoice stays open, one notification", async () => {
      const inv = await invoice(8800);
      const d = await kashbookDeposit(8800, today);
      const bookId = `${tag}-bk-dep`;
      status(await bookWebhook(8800, bookId, neighbour.anchorAccountId), 200);
      const row = await waitFor(() => prisma.transaction.findFirst({ where: { businessId: biz.id, reference: `anc_bk_${bookId}` } }), "the book transfer's credit");
      const dep = await arrivedNow(d.deposit.id);
      eq(dep.transactionId, row.id);
      eq(dep.autoLinked, true);
      eq((await txNow(row.id)).purpose, "cash_deposit");
      await sleep(400);
      const after = await prisma.invoice.findUnique({ where: { id: inv.id }, include: { payments: true } });
      eq(after.amountPaid, 0, "not paid");
      eq(after.payments.length, 0);
      const told = await toldOf(8800);
      assert.deepStrictEqual(told.map((n) => n.body), [depositBody("₦8,800", neighbour.name, today)], "only the deposit's notification");
    });
    await test("a book transfer with no deposit waiting: the usual notification, and it may pay an open invoice, as before", async () => {
      const inv = await invoice(8900);
      const bookId = `${tag}-bk-inv`;
      status(await bookWebhook(8900, bookId, neighbour.anchorAccountId), 200);
      const paid = await waitFor(async () => {
        const x = await prisma.invoice.findUnique({ where: { id: inv.id } });
        return x.amountPaid > 0 ? x : null;
      }, "the invoice to be paid");
      eq(paid.amountPaid, 8900);
      const told = await toldOf(8900);
      ok(told.some((n) => n.title === `${neighbour.name} sent ₦8,900.00 🎉`), "the usual notification");
    });
    await test("the reconcile poller: a credit it books goes to the waiting deposit, not the open invoice; one notification", async () => {
      const inv = await invoice(4700);
      const d = await kashbookDeposit(4700, lagosDay(-1));
      LIST = [{ id: `${tag}-rec-anc_txn`, amount: 4700, at: new Date(Date.now() - 20 * 60000) }];
      eq(await reconcileBusiness({ ...bizRow, anchorAccountId: biz.anchorAccountId }), 1, "booked");
      LIST = [];
      const row = await prisma.transaction.findFirst({ where: { businessId: biz.id, reference: `anc_txn_${tag}-rec-anc_txn` } });
      ok(row, "the poller's row");
      eq(row.purpose, "cash_deposit");
      const dep = await depNow(d.deposit.id);
      eq(dep.status, "arrived");
      eq(dep.transactionId, row.id);
      eq((await prisma.invoice.findUnique({ where: { id: inv.id } })).amountPaid, 0, "the invoice stays open");
      // The list names no sender here: the notification names none either.
      assert.deepStrictEqual((await toldOf(4700)).map((n) => n.body), [depositBody("₦4,700", "", lagosDay(-1))], "only the deposit's notification");
    });

    section("recorded after the money arrived; oldest first");
    await test("the credit first: the deposit takes it when it is recorded", async () => {
      const row = await credit(5100, noon(lagosDay(-2), "10"));
      const r = await deposit({ amount: 5100, date: lagosDay(-3), into: "kashbook" });
      status(r, 201);
      eq(r.body.deposit.status, "arrived");
      eq(r.body.deposit.transactionId, row.id);
      eq(r.body.deposit.autoLinked, true);
      eq(r.body.deposit.adoptedPurpose, null);
      eq(r.body.deposit.transaction.id, row.id);
      eq(r.body.deposit.transaction.senderName, "ADA OBI");
      eq(r.body.transaction.id, row.id);
      eq(r.body.transaction.purpose, "cash_deposit");
      eq(r.body.transaction.cashDepositId, r.body.deposit.id);
    });
    await test("two credits waiting: a deposit takes the oldest", async () => {
      const older = await credit(5200, noon(lagosDay(-2), "09"));
      const newer = await credit(5200, noon(lagosDay(-1), "09"));
      const r = await deposit({ amount: 5200, date: lagosDay(-2), into: "kashbook" });
      eq(r.body.transaction.id, older.id);
      eq((await txNow(newer.id)).purpose, null);
    });
    let pairA;
    let pairB;
    let pairCredits;
    await test("two deposits, two credits: the older deposit (by its day) takes the first credit", async () => {
      // B is recorded first but is dated later.
      pairB = (await kashbookDeposit(7000, lagosDay(-1))).deposit;
      pairA = (await kashbookDeposit(7000, lagosDay(-2))).deposit;
      const c1 = await credit(7000, noon(today, "07"));
      eq(await arrive(c1), true);
      eq((await depNow(pairA.id)).transactionId, c1.id, "A first");
      eq((await depNow(pairB.id)).status, "waiting");
      const c2 = await credit(7000, noon(today, "08"));
      eq(await arrive(c2), true);
      eq((await depNow(pairB.id)).transactionId, c2.id, "then B");
      pairCredits = [c1, c2];
      // Offered again, a credit already a deposit's is answered as one (so
      // no other matcher gets it) and taken by no other deposit.
      eq(await arrive(c2), true, "a credit already linked is a deposit's");
      eq((await depNow(pairB.id)).transactionId, c2.id, "B keeps it");
      eq((await depNow(pairA.id)).transactionId, c1.id, "A keeps its own");
    });

    section("a deposit saved while its credit is being booked");
    // Holds the deposit route's look-back open once it has run: the deposit is
    // saved and has looked for its credit, under the business lock, but has
    // not committed. `reached` gives what the look-back found.
    const holdLookBack = () => {
      const orig = depositsModule.lookBack;
      let open;
      const gate = new Promise((r) => (open = r));
      let ran;
      const reached = new Promise((r) => (ran = r));
      depositsModule.lookBack = async (...args) => {
        const out = await orig(...args);
        ran(out);
        await gate;
        return out;
      };
      return { reached, release: () => { depositsModule.lookBack = orig; open(); } };
    };
    // What the held look-back found; a deposit answered before its look-back
    // ran (refused, say) fails the test instead of leaving it waiting.
    const lookedBack = (hold, saving) => Promise.race([
      hold.reached,
      saving.then((r) => { throw new Error(`the deposit answered first: ${r.status} ${JSON.stringify(r.body)}`); }),
    ]);
    await test("the webhook (no paidAt) books the credit meanwhile: it waits for the deposit, then takes it; no invoice paid, one notification", async () => {
      const inv = await invoice(6200);
      const hold = holdLookBack();
      let saving;
      let row;
      try {
        saving = deposit({ amount: 6200, date: today, into: "kashbook" });
        eq(await lookedBack(hold, saving), null, "the look-back ran before the credit was there");
        const payId = `${tag}-race-webhook`;
        status(await webhook(6200, payId, { paidAt: null }), 200);
        row = await waitFor(() => prisma.transaction.findFirst({ where: { businessId: biz.id, reference: `anc_pay_${payId}` } }), "the credit");
        await sleep(500); // its matcher has had time to decide: it must still be waiting
        eq((await txNow(row.id)).purpose, null, "nothing decided while the deposit is open");
      } finally {
        hold.release();
      }
      const r = await saving;
      status(r, 201);
      eq(r.body.deposit.status, "waiting");
      const dep = await arrivedNow(r.body.deposit.id);
      eq(dep.transactionId, row.id);
      eq((await txNow(row.id)).purpose, "cash_deposit");
      await sleep(400);
      eq((await prisma.invoice.findUnique({ where: { id: inv.id } })).amountPaid, 0, "the invoice stays open");
      assert.deepStrictEqual((await toldOf(6200)).map((n) => n.body), [depositBody("₦6,200", "ADA OBI", today)], "one notification");
    });
    await test("the poller books the credit meanwhile (a list row with its payment link): it waits, then takes it", async () => {
      const hold = holdLookBack();
      let saving;
      let booking;
      let row;
      try {
        saving = deposit({ amount: 6300, date: lagosDay(-1), into: "kashbook" });
        eq(await lookedBack(hold, saving), null, "the look-back ran before the credit was there");
        LIST = [{ id: `${tag}-race-rec`, paymentId: `${tag}-race-pay`, amount: 6300, at: new Date(Date.now() - 20 * 60000) }];
        booking = reconcileBusiness({ ...bizRow, anchorAccountId: biz.anchorAccountId });
        row = await waitFor(() => prisma.transaction.findFirst({ where: { businessId: biz.id, reference: `anc_pay_${tag}-race-pay` } }), "the poller's credit");
        await sleep(500);
        eq((await txNow(row.id)).purpose, null, "nothing decided while the deposit is open");
      } finally {
        hold.release();
      }
      const r = await saving;
      status(r, 201);
      eq(await booking, 1, "booked");
      LIST = [];
      const dep = await depNow(r.body.deposit.id);
      eq(dep.status, "arrived");
      eq(dep.transactionId, row.id);
      eq((await toldOf(6300)).length, 1, "one notification");
    });
    await test("the other order: the deposit's look-back takes a credit booked a moment before; the credit's own matcher then finds it the deposit's (no invoice, one notification)", async () => {
      const inv = await invoice(6250);
      const orig = depositsModule.matchArrivingCredit;
      let open;
      const gate = new Promise((r) => (open = r));
      let started;
      const reached = new Promise((r) => (started = r));
      depositsModule.matchArrivingCredit = async (...args) => {
        started();
        await gate;
        return orig(...args);
      };
      const payId = `${tag}-race-order`;
      try {
        status(await webhook(6250, payId), 200);
        // Booked; its matcher has not run yet.
        await Promise.race([reached, sleep(8000).then(() => { throw new Error("the credit's matcher never ran"); })]);
        const row = await prisma.transaction.findFirst({ where: { businessId: biz.id, reference: `anc_pay_${payId}` } });
        ok(row, "booked");
        const r = await deposit({ amount: 6250, date: today, into: "kashbook" });
        status(r, 201);
        eq(r.body.deposit.status, "arrived", "the look-back took it");
        eq(r.body.transaction.id, row.id);
      } finally {
        depositsModule.matchArrivingCredit = orig;
        open();
      }
      await waitFor(async () => (await toldOf(6250)).length > 0, "the notification");
      await sleep(400);
      eq((await prisma.invoice.findUnique({ where: { id: inv.id } })).amountPaid, 0, "the invoice stays open");
      assert.deepStrictEqual((await toldOf(6250)).map((n) => n.body), [depositBody("₦6,250", "ADA OBI", today)], "one notification, the deposit's");
    });

    section("undo, and the owner's own pick");
    await test("undo: the deposit waits again, its credit counts as before, and is never taken by itself again", async () => {
      const [c1] = pairCredits;
      const r = await POST(`/cash-deposits/${pairA.id}/undo`, T);
      status(r, 200);
      eq(r.body.deposit.status, "waiting");
      eq(r.body.deposit.transactionId, null);
      eq(r.body.deposit.autoLinked, false);
      eq(r.body.deposit.arrivedAt, null);
      ok(r.body.deposit.rejectedTransactionIds.includes(c1.id), "rejected");
      eq(r.body.transaction.id, c1.id);
      eq(r.body.transaction.purpose, null);
      eq(r.body.transaction.accountId, null);
      eq(r.body.transaction.cashDepositId, null);
      eq(await arrive(await txNow(c1.id)), false, "not again by itself");
      // An edit runs the look-back; the rejected credit is still not taken.
      const e = await PATCH(`/cash-deposits/${pairA.id}`, T, { note: "counted twice" });
      status(e, 200);
      eq(e.body.deposit.status, "waiting");
      eq(e.body.transaction, null);
      const undoLog = await waitFor(() => prisma.auditLog.findFirst({ where: { action: "CASH_DEPOSIT_UNDO", resourceId: pairA.id } }), "the audit row");
      eq(undoLog.metadata.restoredPurpose, null, "audited: given back unexplained");
      // Undo again: nothing to undo, answered as it is.
      const again = await POST(`/cash-deposits/${pairA.id}/undo`, T);
      status(again, 200);
      eq(again.body.transaction, null);
    });
    await test("a new credit of its amount is taken", async () => {
      const c3 = await credit(7000, noon(today, "09"));
      eq(await arrive(c3), true);
      const dep = await depNow(pairA.id);
      eq(dep.status, "arrived");
      eq(dep.transactionId, c3.id);
    });
    let slowDep;
    let slowCredit;
    await test("pick the transfer: candidates from the deposit's day on, a rejected one flagged; a link outside the window", async () => {
      slowDep = (await kashbookDeposit(8000, lagosDay(-12))).deposit;
      slowCredit = await credit(8000, noon(lagosDay(-1), "10"));
      eq(await arrive(slowCredit), false, "ten days later: not by itself");
      const before = await credit(8000, noon(lagosDay(-13), "10"));
      const other = await credit(8000.5, noon(lagosDay(-1), "11"));
      const c = await GET(`/cash-deposits/${slowDep.id}/candidates`, T);
      status(c, 200);
      const ids = c.body.transactions.map((t) => t.id);
      ok(ids.includes(slowCredit.id), "the slow credit");
      ok(!ids.includes(before.id), "not one before its day");
      ok(!ids.includes(other.id), "not another amount");
      eq(c.body.transactions.find((t) => t.id === slowCredit.id).rejected, false);
      eq(c.body.transactions.find((t) => t.id === slowCredit.id).cashDepositId, null);
      eq(c.body.transactions.find((t) => t.id === slowCredit.id).purpose, null, "each with its purpose");
      const r = await POST(`/cash-deposits/${slowDep.id}/link`, T, { transactionId: slowCredit.id });
      status(r, 200);
      eq(r.body.deposit.status, "arrived");
      eq(r.body.deposit.autoLinked, false);
      eq(r.body.transaction.purpose, "cash_deposit");
      eq(r.body.transaction.cashDepositId, slowDep.id);
      ok(await waitFor(() => prisma.auditLog.findFirst({ where: { action: "CASH_DEPOSIT_LINK", resourceId: slowDep.id } }), "the audit row"), "audited");
      // Undone, the credit comes back as a candidate, flagged.
      status(await POST(`/cash-deposits/${slowDep.id}/undo`, T), 200);
      const again = await GET(`/cash-deposits/${slowDep.id}/candidates`, T);
      eq(again.body.transactions.find((t) => t.id === slowCredit.id).rejected, true);
      // The owner may pick it all the same; it leaves the rejected list.
      const r2 = await POST(`/cash-deposits/${slowDep.id}/link`, T, { transactionId: slowCredit.id });
      status(r2, 200);
      ok(!r2.body.deposit.rejectedTransactionIds.includes(slowCredit.id), "no longer rejected");
    });
    await test("a pick refused, with its reason: AMOUNT, MATCHED, PURPOSE, LINKED, NOT_BANK, BEFORE", async () => {
      const d = (await kashbookDeposit(9000, lagosDay(-3))).deposit;
      const link = (transactionId) => POST(`/cash-deposits/${d.id}/link`, T, { transactionId });
      const reason = async (transactionId, want) => {
        const r = await link(transactionId);
        refused(r, 409, "NOT_ELIGIBLE", want);
        eq(r.body.reason, want);
        eq(r.body.field, "transactionId", want);
      };
      await reason((await credit(9001, noon(lagosDay(-2)))).id, "AMOUNT");
      const forSale = await credit(9000, noon(lagosDay(-2)));
      status(await POST(`/transactions/${forSale.id}/create-sale`, T, {}), 201, "create-sale");
      await reason(forSale.id, "MATCHED");
      const owners = await credit(9000, noon(lagosDay(-2)));
      status(await POST(`/transactions/${owners.id}/classify`, T, { purpose: "owner_money" }), 200, "classify");
      await reason(owners.id, "PURPOSE");
      await reason(slowCredit.id, "LINKED");
      const debit = await credit(9000, noon(lagosDay(-2)), { type: "expense" });
      await reason(debit.id, "NOT_BANK");
      const manual = await prisma.transaction.create({
        data: { businessId: biz.id, userId: owner.id, type: "income", amount: 9000, date: noon(lagosDay(-2)), paymentMethod: "cash" },
      });
      await reason(manual.id, "NOT_BANK");
      // The cash cannot reach the bank before it left the till.
      const early = await credit(9000, noon(lagosDay(-4), "23"));
      await reason(early.id, "BEFORE");
      eq((await txNow(early.id)).purpose, null, "left as it was");
      refused(await link(""), 400, "TRANSACTION_REQUIRED");
      refused(await link((await credit(9000, noon(lagosDay(-2)), {}, rivalBiz)).id), 404, "TRANSACTION_NOT_FOUND", "another business's credit");
      eq((await depNow(d.id)).status, "waiting");
      await POST(`/cash-deposits/${d.id}/cancel`, T);
    });

    section("a transfer the owner had already marked as cash banked");
    await test("never taken by the server itself; offered to pick with its purpose; picked, Cash at Hand falls once; undo gives the marking back", async () => {
      const day = lagosDay(-1);
      const x = await credit(10500, noon(day, "10"));
      status(await POST(`/transactions/${x.id}/classify`, T, { purpose: "cash_deposit" }), 200, "Cash I already recorded");
      marked.add(x.id);
      const b0 = await balances();
      const pl = { paid: kobo((await profit("paid")).profit), sold: kobo((await profit("sold")).profit) };
      const d = (await kashbookDeposit(10500, day)).deposit;
      eq(d.status, "waiting", "the server does not take a marked transfer by itself");
      const b1 = await balances();
      eq(kobo(b1.get(CASH.id)) - kobo(b0.get(CASH.id)), -1050000, "until it is picked, Cash at Hand falls twice for that cash");
      const c = await GET(`/cash-deposits/${d.id}/candidates`, T);
      const offered = c.body.transactions.find((t) => t.id === x.id);
      ok(offered, "offered to pick");
      eq(offered.purpose, "cash_deposit", "with its purpose");
      eq(offered.rejected, false);
      const r = await POST(`/cash-deposits/${d.id}/link`, T, { transactionId: x.id });
      status(r, 200, "picked");
      eq(r.body.deposit.status, "arrived");
      eq(r.body.deposit.adoptedPurpose, "cash_deposit");
      eq(r.body.transaction.purpose, "cash_deposit");
      eq(r.body.transaction.accountId, null);
      eq(r.body.transaction.cashDepositId, d.id);
      const row = await depNow(d.id);
      eq(row.adoptedPurpose, "cash_deposit");
      eq(row.adoptedAccountId, null);
      const b2 = await balances();
      eq(kobo(b2.get(CASH.id)), kobo(b0.get(CASH.id)), "Cash at Hand falls once: the marking and the deposit are one");
      eq(kobo(b2.get(UNDEP.id)), kobo(b0.get(UNDEP.id)), "nothing left in Undeposited Funds");
      eq(kobo(b2.get(KASHBOOK.id)), kobo(b0.get(KASHBOOK.id)), "the bank as it was");
      eq(kobo((await profit("paid")).profit), pl.paid, "never a sale, when paid");
      eq(kobo((await profit("sold")).profit), pl.sold, "never a sale, when sold");
      const guard = await POST(`/transactions/${x.id}/classify`, T, { purpose: null });
      refused(guard, 409, "DEPOSIT_LINKED", "now the deposit's");
      const u = await POST(`/cash-deposits/${d.id}/undo`, T);
      status(u, 200, "undo");
      eq(u.body.deposit.status, "waiting");
      eq(u.body.deposit.adoptedPurpose, null);
      eq(u.body.transaction.purpose, "cash_deposit", "marked as cash banked again");
      eq(u.body.transaction.accountId, null);
      eq(u.body.transaction.cashDepositId, null);
      const back = await depNow(d.id);
      eq(back.adoptedPurpose, null);
      eq(back.adoptedAccountId, null);
      const linkLog = await waitFor(() => prisma.auditLog.findFirst({ where: { action: "CASH_DEPOSIT_LINK", resourceId: d.id } }), "the link row");
      eq(linkLog.metadata.adoptedPurpose, "cash_deposit", "the audit says the transfer was the owner's marking");
      const undoLog = await waitFor(() => prisma.auditLog.findFirst({ where: { action: "CASH_DEPOSIT_UNDO", resourceId: d.id } }), "the undo row");
      eq(undoLog.metadata.restoredPurpose, "cash_deposit", "and that the undo gave it back");
      const b3 = await balances();
      eq(kobo(b3.get(CASH.id)), kobo(b1.get(CASH.id)), "as before the pick");
      eq(kobo((await profit("paid")).profit), pl.paid, "still never a sale, when paid");
      eq(kobo((await profit("sold")).profit), pl.sold, "still never a sale, when sold");
      status(await POST(`/cash-deposits/${d.id}/cancel`, T), 200);
      eq(kobo((await balances()).get(CASH.id)), kobo(b0.get(CASH.id)), "cancelled: the marking alone");
    });
    await test("marked through Cash at Hand's own account (categorize): picked, its account cleared; undo puts it back", async () => {
      const y = await credit(10600, noon(today, "08"));
      status(await POST(`/transactions/${y.id}/categorize`, T, { accountId: CASH.id }), 200, "categorize");
      marked.add(y.id);
      const t0 = await txNow(y.id);
      eq(t0.purpose, "cash_deposit");
      eq(t0.accountId, CASH.id);
      const b0 = await balances();
      const d = (await kashbookDeposit(10600, today)).deposit;
      eq(d.status, "waiting");
      const r = await POST(`/cash-deposits/${d.id}/link`, T, { transactionId: y.id });
      status(r, 200, "picked");
      eq(r.body.transaction.accountId, null, "its account cleared");
      eq(r.body.transaction.purpose, "cash_deposit");
      const row = await depNow(d.id);
      eq(row.adoptedPurpose, "cash_deposit");
      eq(row.adoptedAccountId, CASH.id);
      const b1 = await balances();
      eq(kobo(b1.get(CASH.id)), kobo(b0.get(CASH.id)), "Cash at Hand falls once");
      eq(kobo(b1.get(UNDEP.id)), kobo(b0.get(UNDEP.id)), "nothing left in Undeposited Funds");
      const u = await POST(`/cash-deposits/${d.id}/undo`, T);
      status(u, 200, "undo");
      eq(u.body.transaction.purpose, "cash_deposit");
      eq(u.body.transaction.accountId, CASH.id, "back on Cash at Hand");
      status(await POST(`/cash-deposits/${d.id}/cancel`, T), 200);
      eq(kobo((await balances()).get(CASH.id)), kobo(b0.get(CASH.id)), "cancelled: the marking alone");
    });
    await test("refused: a marked transfer dated before the deposit's day (BEFORE), Cash at Hand's account with no marking (PURPOSE)", async () => {
      const early = await credit(10700, noon(lagosDay(-2), "10"));
      status(await POST(`/transactions/${early.id}/classify`, T, { purpose: "cash_deposit" }), 200);
      marked.add(early.id);
      const d = (await kashbookDeposit(10700, lagosDay(-1))).deposit;
      const c = await GET(`/cash-deposits/${d.id}/candidates`, T);
      eq(c.body.transactions.some((t) => t.id === early.id), false, "not offered");
      const r = await POST(`/cash-deposits/${d.id}/link`, T, { transactionId: early.id });
      refused(r, 409, "NOT_ELIGIBLE", "before");
      eq(r.body.reason, "BEFORE");
      // Filed on Cash at Hand without the marking (no route writes this).
      const odd = await credit(10700, noon(lagosDay(-1), "11"), { accountId: CASH.id });
      const r2 = await POST(`/cash-deposits/${d.id}/link`, T, { transactionId: odd.id });
      refused(r2, 409, "NOT_ELIGIBLE", "account alone");
      eq(r2.body.reason, "PURPOSE");
      eq((await depNow(d.id)).status, "waiting");
      status(await POST(`/cash-deposits/${d.id}/cancel`, T), 200);
      await prisma.transaction.update({ where: { id: odd.id }, data: { accountId: null } });
    });

    section("the guard: a deposit's credit is changed only on the deposit");
    await test("classify, categorize, match, create-sale, create-expense, match-debt, link a repayment, unmatch: 409 DEPOSIT_LINKED", async () => {
      const linked = slowCredit.id;
      const tries = [
        ["classify", POST(`/transactions/${linked}/classify`, T, { purpose: null })],
        ["classify (staff)", POST(`/transactions/${linked}/classify`, TS, { purpose: "loan" })],
        ["categorize", POST(`/transactions/${linked}/categorize`, T, { accountId: null })],
        ["match", POST(`/transactions/${linked}/match`, T, { saleId: "s-x" })],
        ["create-sale", POST(`/transactions/${linked}/create-sale`, T, {})],
        ["create-expense", POST(`/transactions/${linked}/create-expense`, T, {})],
        ["match-debt", POST(`/transactions/${linked}/match-debt`, T, { customerId: customer.id })],
        ["link-debt-payment", POST(`/transactions/${linked}/link-debt-payment`, T, { debtPaymentId: "dp-x" })],
        ["unmatch", DEL(`/transactions/${linked}/match`, T)],
      ];
      for (const [what, p] of tries) {
        const r = await p;
        refused(r, 409, "DEPOSIT_LINKED", what);
        eq(r.body.depositId, slowDep.id, what);
      }
      const t = await txNow(linked);
      eq(t.purpose, "cash_deposit", "unchanged");
      eq(t.matchedSaleId, null);
    });
    await test("an invoice payment from it, or a payment linked to it: 409 DEPOSIT_LINKED", async () => {
      const inv = await invoice(8000);
      const r = await POST(`/invoices/${inv.id}/payments`, T, { amount: 8000, method: "bank", transactionId: slowCredit.id });
      refused(r, 409, "DEPOSIT_LINKED", "bank payment");
      eq(r.body.depositId, slowDep.id);
      const cash = await POST(`/invoices/${inv.id}/payments`, T, { amount: 8000, method: "transfer" });
      status(cash, 201, "a transfer payment");
      const pay = cash.body.payments[0];
      refused(await POST(`/invoices/${inv.id}/payments/${pay.id}/link`, T, { transactionId: slowCredit.id }), 409, "DEPOSIT_LINKED", "link");
      eq((await prisma.invoice.findUnique({ where: { id: inv.id } })).amountPaid, 8000, "only the transfer payment");
    });

    section("edits, cancels, retries");
    await test("a retry with the same clientRef answers 200 with the first deposit", async () => {
      const ref = `ref-${tag}`;
      const a = await deposit({ amount: 1500, date: today, into: "account", intoAccountId: OTHER_BANK.id, clientRef: ref });
      status(a, 201);
      const b = await deposit({ amount: 1500, date: today, into: "account", intoAccountId: OTHER_BANK.id, clientRef: ref });
      status(b, 200);
      eq(b.body.deposit.id, a.body.deposit.id);
      eq(await prisma.cashDeposit.count({ where: { businessId: biz.id, clientRef: ref } }), 1);
    });
    await test("edit: amount, date and note; into another bank and back; the look-back on the way back", async () => {
      const d = (await kashbookDeposit(6100, lagosDay(-1))).deposit;
      const e1 = await PATCH(`/cash-deposits/${d.id}`, T, { amount: 6200.5, date: lagosDay(-2), note: "  corrected  " });
      status(e1, 200);
      eq(e1.body.deposit.amount, 6200.5);
      eq(e1.body.deposit.note, "corrected");
      eq(e1.body.deposit.status, "waiting");
      const e2 = await PATCH(`/cash-deposits/${d.id}`, T, { into: "account" });
      refused(e2, 400, "ACCOUNT_NOT_ALLOWED", "no account");
      eq(e2.body.field, "intoAccountId");
      const e3 = await PATCH(`/cash-deposits/${d.id}`, T, { into: "account", intoAccountId: OTHER_BANK.id });
      status(e3, 200);
      eq(e3.body.deposit.status, "done");
      eq(e3.body.deposit.intoAccountId, OTHER_BANK.id);
      const c = await credit(6200.5, noon(lagosDay(-1), "15"));
      const e4 = await PATCH(`/cash-deposits/${d.id}`, T, { into: "kashbook" });
      status(e4, 200);
      eq(e4.body.deposit.status, "arrived", "the credit already there is taken");
      eq(e4.body.deposit.intoAccountId, null);
      eq(e4.body.transaction.id, c.id);
      eq(e4.body.transaction.cashDepositId, d.id);
      refused(await PATCH(`/cash-deposits/${d.id}`, T, { note: "x" }), 409, "DEPOSIT_ARRIVED");
      refused(await POST(`/cash-deposits/${d.id}/cancel`, T), 409, "DEPOSIT_ARRIVED");
      refused(await POST(`/cash-deposits/${d.id}/link`, T, { transactionId: c.id }), 409, "DEPOSIT_ARRIVED");
    });
    await test("the audit keeps every day a deposit was on: the day on create; from and to on each edit, and only what changed; no note words", async () => {
      const r = await deposit({ amount: 700, date: lagosDay(-3), into: "account", intoAccountId: OTHER_BANK.id, note: "first words" });
      status(r, 201);
      const id = r.body.deposit.id;
      const created = await waitFor(() => prisma.auditLog.findFirst({ where: { action: "CASH_DEPOSIT_CREATE", resourceId: id } }), "the create row");
      eq(created.metadata.date, lagosDay(-3), "the first day");
      eq(created.metadata.amount, 700);
      status(await PATCH(`/cash-deposits/${id}`, T, { date: lagosDay(-2), note: "second words", amount: 700 }), 200);
      const u1 = await waitFor(() => prisma.auditLog.findFirst({ where: { action: "CASH_DEPOSIT_UPDATE", resourceId: id } }), "the update row");
      eq(u1.metadata.from.date, lagosDay(-3), "from");
      eq(u1.metadata.to.date, lagosDay(-2), "to");
      assert.deepStrictEqual([...u1.metadata.fields].sort(), ["date", "note"], "the amount sent again unchanged is no change");
      eq(u1.metadata.from.amount, 700);
      eq(u1.metadata.to.status, "done");
      status(await PATCH(`/cash-deposits/${id}`, T, { date: lagosDay(-1) }), 200);
      const both = await waitFor(async () => {
        const rows = await prisma.auditLog.findMany({ where: { action: "CASH_DEPOSIT_UPDATE", resourceId: id }, orderBy: { createdAt: "asc" } });
        return rows.length === 2 ? rows : null;
      }, "the second update row");
      eq(both[1].metadata.from.date, lagosDay(-2));
      eq(both[1].metadata.to.date, lagosDay(-1));
      const all = await prisma.auditLog.findMany({ where: { resourceId: id } });
      ok(!JSON.stringify(all.map((a) => a.metadata)).includes("words"), "no note words in the audit log");
      status(await POST(`/cash-deposits/${id}/cancel`, T), 200);
    });
    await test("cancel: a waiting or done deposit posts nothing more; twice answers as it is; then no edit", async () => {
      const w = (await kashbookDeposit(1234, today)).deposit;
      const before = await balances();
      const r = await POST(`/cash-deposits/${w.id}/cancel`, T);
      status(r, 200);
      eq(r.body.deposit.status, "cancelled");
      ok(r.body.deposit.cancelledAt, "cancelledAt");
      const after = await balances();
      eq(kobo(after.get(CASH.id)) - kobo(before.get(CASH.id)), 123400, "Cash at Hand back");
      eq(kobo(after.get(UNDEP.id)) - kobo(before.get(UNDEP.id)), -123400, "Undeposited Funds");
      status(await POST(`/cash-deposits/${w.id}/cancel`, T), 200, "again");
      refused(await PATCH(`/cash-deposits/${w.id}`, T, { amount: 5 }), 409, "DEPOSIT_CANCELLED");
      refused(await POST(`/cash-deposits/${w.id}/undo`, T), 409, "DEPOSIT_CANCELLED");
      refused(await POST(`/cash-deposits/${w.id}/link`, T, { transactionId: slowCredit.id }), 409, "DEPOSIT_CANCELLED");
      eq(await arrive(await credit(1234, noon(today, "10"))), false, "a cancelled deposit takes nothing");
      refused(await POST(`/cash-deposits/${otherDep.id}/undo`, T), 409, "DEPOSIT_NOT_KASHBOOK");
      const c = await GET(`/cash-deposits/${otherDep.id}/candidates`, T);
      eq(c.body.transactions.length, 0, "no candidates for another bank's deposit");
    });

    section("who may");
    await test("staff: 403 OWNER_ONLY on every route", async () => {
      const someId = otherDep.id;
      for (const [what, p] of [
        ["list", GET(`/cash-deposits?businessId=${biz.id}`, TS)],
        ["create", POST("/cash-deposits", TS, { businessId: biz.id, amount: 10, date: today, into: "kashbook" })],
        ["edit", PATCH(`/cash-deposits/${someId}`, TS, { note: "x" })],
        ["cancel", POST(`/cash-deposits/${someId}/cancel`, TS)],
        ["undo", POST(`/cash-deposits/${slowDep.id}/undo`, TS)],
        ["link", POST(`/cash-deposits/${pairB.id}/link`, TS, { transactionId: "x" })],
        ["candidates", GET(`/cash-deposits/${someId}/candidates`, TS)],
      ]) refused(await p, 403, "OWNER_ONLY", what);
    });
    await test("another business: its owner gets 404, and so does a stranger's id", async () => {
      refused(await GET(`/cash-deposits?businessId=${biz.id}`, TR), 404, "BUSINESS_NOT_FOUND");
      refused(await GET("/cash-deposits", T), 404, "BUSINESS_NOT_FOUND", "none named");
      refused(await PATCH(`/cash-deposits/${otherDep.id}`, TR, { note: "x" }), 404, "DEPOSIT_NOT_FOUND");
      refused(await POST(`/cash-deposits/${otherDep.id}/cancel`, TR), 404, "DEPOSIT_NOT_FOUND");
      refused(await GET(`/cash-deposits/${otherDep.id}/candidates`, TR), 404, "DEPOSIT_NOT_FOUND");
      refused(await POST("/cash-deposits", TR, { businessId: biz.id, amount: 10, date: today, into: "kashbook" }), 404, "BUSINESS_NOT_FOUND");
      const mine = await POST("/cash-deposits", TR, { businessId: rivalBiz.id, amount: 10, date: today, into: "account", intoAccountId: rivalOther.id });
      status(mine, 201, "the rival's own");
      refused(await POST(`/cash-deposits/${mine.body.deposit.id}/undo`, T), 404, "DEPOSIT_NOT_FOUND", "the rival's, from the owner");
      const list = await GET(`/cash-deposits?businessId=${rivalBiz.id}`, TR);
      eq(list.body.deposits.length, 1, "each sees their own");
    });
    await test("a business without its KashBook account: no KashBook deposit, on create or on a switch (ACCOUNT_NOT_ALLOWED, into, NO_KASHBOOK_ACCOUNT)", async () => {
      const r = await POST("/cash-deposits", TR, { businessId: rivalBiz.id, amount: 10, date: today, into: "kashbook" });
      refused(r, 400, "ACCOUNT_NOT_ALLOWED", "create");
      eq(r.body.field, "into");
      eq(r.body.reason, "NO_KASHBOOK_ACCOUNT");
      const a = await POST("/cash-deposits", TR, { businessId: rivalBiz.id, amount: 10, date: today, into: "account", intoAccountId: rivalOther.id });
      status(a, 201, "into another bank, as ever");
      const s = await PATCH(`/cash-deposits/${a.body.deposit.id}`, TR, { into: "kashbook" });
      refused(s, 400, "ACCOUNT_NOT_ALLOWED", "switch");
      eq(s.body.field, "into");
      eq(s.body.reason, "NO_KASHBOOK_ACCOUNT");
      eq((await depNow(a.body.deposit.id)).into, "account", "unchanged");
      status(await PATCH(`/cash-deposits/${a.body.deposit.id}`, TR, { amount: 12 }), 200, "other edits as ever");
      eq(await prisma.cashDeposit.count({ where: { businessId: rivalBiz.id, into: "kashbook" } }), 0, "none saved");
      // A number whose provider account id is missing (a failed
      // account.creation webhook, mended later by sync-anchor-account): the
      // app offers KashBook on the number alone, and so does the server, so
      // the deposit waits for the credit the mended account will bring.
      await prisma.business.update({ where: { id: rivalBiz.id }, data: { virtualAccountNumber: `R${nuban}` } });
      try {
        const n = await POST("/cash-deposits", TR, { businessId: rivalBiz.id, amount: 10, date: today, into: "kashbook" });
        status(n, 201, "a number alone is enough");
        eq(n.body.deposit.status, "waiting");
        await prisma.cashDeposit.delete({ where: { id: n.body.deposit.id } });
      } finally {
        await prisma.business.update({ where: { id: rivalBiz.id }, data: { virtualAccountNumber: null } });
      }
    });
    await test("the list: newest first, each with its linked transfer", async () => {
      const r = await GET(`/cash-deposits?businessId=${biz.id}`, T);
      status(r, 200);
      const days = r.body.deposits.map((d) => d.date);
      ok(days.every((d, i) => i === 0 || d <= days[i - 1]), "newest first");
      const slow = r.body.deposits.find((d) => d.id === slowDep.id);
      eq(slow.transaction.id, slowCredit.id);
      eq(slow.transaction.amount, 8000);
      eq(slow.transaction.senderName, "ADA OBI");
      ok(r.body.deposits.every((d) => "adoptedPurpose" in d), "each says whether its transfer was one the owner marked");
    });

    section("the sync bundle and cashDepositId");
    await test("owner: cashDeposits whole, then changed ones; every bank row with cashDepositId", async () => {
      const full = await GET(`/sync?businessId=${biz.id}`, T);
      status(full, 200);
      ok(Array.isArray(full.body.cashDeposits), "a list");
      eq(full.body.cashDeposits.length, await prisma.cashDeposit.count({ where: { businessId: biz.id } }), "all of them");
      const row = full.body.transactions.find((t) => t.id === slowCredit.id);
      eq(row.cashDepositId, slowDep.id);
      ok(full.body.transactions.every((t) => "cashDepositId" in t), "on every row");
      eq(full.body.transactions.filter((t) => t.cashDepositId).length, await prisma.cashDeposit.count({ where: { businessId: biz.id, status: "arrived" } }));
      await sleep(20);
      const since = full.body.syncedAt;
      const d = (await kashbookDeposit(4321, today)).deposit;
      const c = await credit(4321, noon(today, "06"));
      eq(await arrive(c), true);
      const inc = await GET(`/sync?businessId=${biz.id}&since=${encodeURIComponent(since)}`, T);
      const got = inc.body.cashDeposits.find((x) => x.id === d.id);
      ok(got, "the new deposit comes");
      eq(got.status, "arrived");
      eq(inc.body.cashDeposits.some((x) => x.id === otherDep.id), false, "an unchanged one does not");
      const tx = inc.body.transactions.find((x) => x.id === c.id);
      ok(tx, "its credit comes");
      eq(tx.cashDepositId, d.id);
      eq(tx.purpose, "cash_deposit");
      // An undo moves both again.
      await sleep(20);
      const since2 = inc.body.syncedAt;
      status(await POST(`/cash-deposits/${d.id}/undo`, T), 200);
      const inc2 = await GET(`/sync?businessId=${biz.id}&since=${encodeURIComponent(since2)}`, T);
      eq(inc2.body.cashDeposits.find((x) => x.id === d.id).status, "waiting");
      eq(inc2.body.transactions.find((x) => x.id === c.id).cashDepositId, null);
      status(await POST(`/cash-deposits/${d.id}/cancel`, T), 200);
    });
    await test("staff with the bank rows: no deposits, but each row says whether it is one", async () => {
      const s = await GET(`/sync?businessId=${biz.id}`, TS);
      status(s, 200);
      eq(s.body.cashDeposits, null);
      eq(s.body.transactions.find((t) => t.id === slowCredit.id).cashDepositId, slowDep.id);
      const list = await GET(`/transactions?businessId=${biz.id}&limit=500`, TS);
      status(list, 200);
      eq(list.body.find((t) => t.id === slowCredit.id).cashDepositId, slowDep.id);
      ok(list.body.every((t) => "cashDepositId" in t), "GET /transactions too");
    });

    section("the accounts a deposit names");
    await test("a bank account with deposits is in use; a merge moves them, never into a non-bank (DEPOSIT_TARGET)", async () => {
      const mk = async (name) => {
        const r = await POST("/ledger/accounts", T, { businessId: biz.id, type: "bank", name: `${name} ${tag}` });
        status(r, 201, name);
        return r.body;
      };
      const gtb = await mk("GTBank");
      const zenith = await mk("Zenith");
      const d = await deposit({ amount: 2500, date: today, into: "account", intoAccountId: gtb.id });
      status(d, 201);
      refused(await DEL(`/ledger/accounts/${gtb.id}`, T), 409, "ACCOUNT_IN_USE");
      refused(await PATCH(`/ledger/accounts/${gtb.id}`, T, { type: "credit_card" }), 409, "TYPE_LOCKED");
      for (const target of [PREPAID, CASH, UNDEP]) {
        const m = await POST(`/ledger/accounts/${gtb.id}/merge`, T, { intoId: target.id });
        refused(m, 400, "DEPOSIT_TARGET", target.name);
        ok(/another bank account/.test(m.body.error), "says what to do");
      }
      status(await POST(`/ledger/accounts/${gtb.id}/merge`, T, { intoId: zenith.id }), 200, "merge");
      eq((await depNow(d.body.deposit.id)).intoAccountId, zenith.id);
      // An inactive bank takes no new deposit.
      status(await PATCH(`/ledger/accounts/${zenith.id}`, T, { inactive: true }), 200);
      refused(await deposit({ amount: 10, date: today, into: "account", intoAccountId: zenith.id }), 400, "ACCOUNT_NOT_ALLOWED");
      const b = await balances();
      eq(b.get(zenith.id), 2500, "the deposit stays where it went");
      // A bank no deposit names still merges into any account of its kind.
      const plain = await mk("Plain");
      status(await POST(`/ledger/accounts/${plain.id}/merge`, T, { intoId: PREPAID.id }), 200, "no deposit: as before");
    });

    section("the books lock");
    await test("nothing on or before the lock date: create, edit or cancel a deposit there; link or undo a transfer dated there; the server skips such a transfer", async () => {
      // Recorded while the books are open, then locked up to yesterday.
      const d1 = (await kashbookDeposit(3300, lagosDay(-3))).deposit;
      // Booked, and not yet offered to the deposit (as if the webhook ran
      // its matcher only after the lock was set).
      const lockedCredit = await credit(3300, noon(lagosDay(-2), "10"));
      const arrivedDep = (await kashbookDeposit(3400, lagosDay(-3))).deposit;
      const arrivedCredit = await credit(3400, noon(lagosDay(-2), "11"));
      eq(await arrive(arrivedCredit), true);
      await lockBooks(lagosDay(-1));
      try {
        eq(await arrive(lockedCredit), false, "the server's link skips a transfer dated on a locked day");
        eq((await depNow(d1.id)).status, "waiting");
        const r = await deposit({ amount: 10, date: lagosDay(-1), into: "kashbook" });
        refused(r, 409, "BOOKS_LOCKED", "create");
        eq(r.body.lockDate, lagosDay(-1));
        status(await deposit({ amount: 10, date: today, into: "account", intoAccountId: OTHER_BANK.id }), 201, "today is open");
        refused(await PATCH(`/cash-deposits/${d1.id}`, T, { note: "x" }), 409, "BOOKS_LOCKED", "edit");
        refused(await POST(`/cash-deposits/${d1.id}/cancel`, T), 409, "BOOKS_LOCKED", "cancel");
        refused(await POST(`/cash-deposits/${d1.id}/link`, T, { transactionId: lockedCredit.id }), 409, "BOOKS_LOCKED", "link a transfer dated on a locked day");
        const c = await GET(`/cash-deposits/${d1.id}/candidates`, T);
        eq(c.body.transactions.some((t) => t.id === lockedCredit.id), false, "a transfer dated on a locked day is not offered");
        refused(await POST(`/cash-deposits/${arrivedDep.id}/undo`, T), 409, "BOOKS_LOCKED", "undo a transfer dated on a locked day");
        const open = (await kashbookDeposit(10, today)).deposit;
        refused(await PATCH(`/cash-deposits/${open.id}`, T, { date: lagosDay(-1) }), 409, "BOOKS_LOCKED", "moved onto a locked day");
        await POST(`/cash-deposits/${open.id}/cancel`, T);
      } finally {
        await lockBooks(null);
      }
      // Open again: the owner links it.
      status(await POST(`/cash-deposits/${d1.id}/link`, T, { transactionId: lockedCredit.id }), 200);
    });
    await test("a deposit dated in the locked part still takes its transfer on an open day: by itself before an open invoice, undone, picked; nothing on or before the lock moves, in either view", async () => {
      const lockDay = lagosDay(-1);
      const dep = (await kashbookDeposit(3500, lagosDay(-2))).deposit;
      const inv = await invoice(3500);
      await lockBooks(lockDay);
      try {
        const snap0 = await snapshot(lockDay);
        const pl0 = { paid: kobo((await profit("paid")).profit), sold: kobo((await profit("sold")).profit) };
        const payId = `${tag}-lock-anc_inb`;
        status(await webhook(3500, payId), 200);
        const row = await waitFor(() => prisma.transaction.findFirst({ where: { businessId: biz.id, reference: `anc_pay_${payId}` } }), "the credit");
        const arrived = await arrivedNow(dep.id);
        eq(arrived.transactionId, row.id, "the deposit took it by itself");
        await sleep(400);
        eq((await prisma.invoice.findUnique({ where: { id: inv.id } })).amountPaid, 0, "the open invoice stays open");
        assert.deepStrictEqual((await toldOf(3500)).map((n) => n.body), [depositBody("₦3,500", "ADA OBI", lagosDay(-2))], "one notification");
        assert.deepStrictEqual(await snapshot(lockDay), snap0, "nothing on or before the lock moved (the link)");
        eq(kobo((await profit("paid")).profit), pl0.paid, "never a sale, when paid");
        eq(kobo((await profit("sold")).profit), pl0.sold, "never a sale, when sold");
        // Undo, with only the deposit's day locked.
        const u = await POST(`/cash-deposits/${dep.id}/undo`, T);
        status(u, 200, "undo");
        eq(u.body.deposit.status, "waiting");
        eq(u.body.transaction.purpose, null);
        assert.deepStrictEqual(await snapshot(lockDay), snap0, "nor the undo");
        eq(kobo((await profit("paid")).profit) - pl0.paid, 350000, "undone, it counts as a sale when paid, on its own open day");
        // The owner picks it again, with the deposit's day locked.
        const c = await GET(`/cash-deposits/${dep.id}/candidates`, T);
        ok(c.body.transactions.some((t) => t.id === row.id && t.rejected), "offered, flagged");
        const l = await POST(`/cash-deposits/${dep.id}/link`, T, { transactionId: row.id });
        status(l, 200, "the owner's pick");
        assert.deepStrictEqual(await snapshot(lockDay), snap0, "nor the pick");
        eq(kobo((await profit("paid")).profit), pl0.paid, "a deposit again, never a sale");
        // Its own day stays closed to it: a waiting deposit there is neither
        // edited nor cancelled (above); this one is held by its transfer.
        refused(await POST(`/cash-deposits/${dep.id}/cancel`, T), 409, "DEPOSIT_ARRIVED");
      } finally {
        await lockBooks(null);
      }
    });
    await test("oldest first across the lock: the older deposit, dated in the locked part, takes the transfer before a newer one", async () => {
      const older = (await kashbookDeposit(3600, lagosDay(-2))).deposit;
      const newer = (await kashbookDeposit(3600, today)).deposit;
      await lockBooks(lagosDay(-1));
      try {
        const c = await credit(3600, noon(today, "09"));
        eq(await arrive(c), true);
        eq((await depNow(older.id)).transactionId, c.id, "the older one");
        eq((await depNow(newer.id)).status, "waiting", "the newer one waits");
        status(await POST(`/cash-deposits/${newer.id}/cancel`, T), 200, "a deposit on an open day is cancelled as ever");
      } finally {
        await lockBooks(null);
      }
    });

    section("a business deleted with its deposits");
    await test("its deposits, credits and accounts go with it in one statement", async () => {
      const gone = await mkBiz(owner.id, "Gone");
      const goneOther = (await prisma.ledgerAccount.findMany({ where: { businessId: gone.id } })).find((a) => a.systemKey === chart.SYS.OTHER_BANK);
      const c = await credit(900, noon(today, "04"), {}, { id: gone.id, userId: owner.id });
      await prisma.cashDeposit.create({ data: { businessId: gone.id, amount: 900, date: noon(today), into: "kashbook", status: "arrived", transactionId: c.id } });
      await prisma.cashDeposit.create({ data: { businessId: gone.id, amount: 100, date: noon(today), into: "account", intoAccountId: goneOther.id, status: "done" } });
      // Never one by one: the account and the credit a deposit names are kept.
      await assert.rejects(prisma.transaction.delete({ where: { id: c.id } }), "the credit is refused deletion");
      await assert.rejects(prisma.ledgerAccount.delete({ where: { id: goneOther.id } }), "the account is refused deletion");
      const del = await prisma.business.deleteMany({ where: { id: gone.id } });
      eq(del.count, 1);
      eq(await prisma.cashDeposit.count({ where: { businessId: gone.id } }), 0);
    });
    await test("a marking kept only while the deposit holds its transfer (the database refuses it otherwise)", async () => {
      const w = (await kashbookDeposit(1111, today)).deposit;
      await assert.rejects(
        prisma.cashDeposit.update({ where: { id: w.id }, data: { adoptedPurpose: "cash_deposit" } }),
        "a waiting deposit keeps no marking",
      );
      await assert.rejects(
        prisma.cashDeposit.update({ where: { id: otherDep.id }, data: { adoptedPurpose: "owner_money" } }),
        "never another purpose",
      );
      status(await POST(`/cash-deposits/${w.id}/cancel`, T), 200);
    });

    section("the ledger at the end");
    await test("balanced; Undeposited Funds is the waiting deposits; Cash at Hand is down by every live deposit and every marked transfer no deposit holds; KashBook = bank ledger", async () => {
      const live = await prisma.cashDeposit.findMany({ where: { businessId: biz.id, status: { not: "cancelled" } } });
      const sumK = (list) => list.reduce((s, d) => s + kobo(d.amount), 0);
      const held = new Set(live.filter((d) => d.status === "arrived").map((d) => d.transactionId));
      const markedFree = (await prisma.transaction.findMany({ where: { businessId: biz.id, type: "income", purpose: "cash_deposit" } }))
        .filter((t) => !held.has(t.id));
      ok(markedFree.length >= 3, `${markedFree.length} marked transfers no deposit holds`);
      ok(markedFree.every((t) => marked.has(t.id)), "each one the owner marked");
      const b = await balances();
      eq(kobo(b.get(CASH.id)), -sumK(live) - sumK(markedFree), "Cash at Hand");
      eq(kobo(b.get(UNDEP.id)), sumK(live.filter((d) => d.status === "waiting")), "Undeposited Funds");
      ok(live.some((d) => d.status === "waiting"), "some still wait");
      // Other Bank Account: the deposits into it, and the invoice payment
      // recorded as a transfer into another bank (the guard's test, above).
      const transfers = await prisma.invoicePayment.findMany({
        where: { invoice: { businessId: biz.id }, method: "transfer", depositAccountId: null, transactionId: null },
      });
      eq(transfers.length, 1, "one transfer payment");
      eq(kobo(b.get(OTHER_BANK.id)), sumK(live.filter((d) => d.intoAccountId === OTHER_BANK.id)) + sumK(transfers), "Other Bank Account");
      eq(kobo(b.get(KASHBOOK.id)), kobo(await computeRawLedger(biz.id, "NGN")), "KashBook Account");
      for (const basis of ["sold", "paid"]) {
        invalidateLedger(biz.id);
        const tb = await GET(`/ledger/reports/trial-balance?businessId=${biz.id}&basis=${basis}`, T);
        eq(tb.body.balanced, true, `${basis} trial balance`);
        const bs = await GET(`/ledger/reports/balance-sheet?businessId=${biz.id}&basis=${basis}`, T);
        eq(bs.body.balanced, true, `${basis} balance sheet`);
        const pl = await profit(basis);
        const books = await booksFor(biz.id, { from: lagosDay(-60), to: today, basis });
        eq(kobo(pl.totalIncome), kobo(books.sales.total), `${basis} income`);
        eq(kobo(pl.totalExpenses), kobo(books.expenses.total), `${basis} expenses`);
      }
      // Enough of every kind for the sums above to mean something.
      const arrived = live.filter((d) => d.status === "arrived");
      ok(arrived.length >= 8, `${arrived.length} arrived`);
      ok(live.some((d) => d.into === "account"), "some went into another bank");
    });
    await test("every arrived deposit's credit is cash_deposit with no account; every other cash_deposit credit is one the owner marked; no marking outlives its link", async () => {
      const arrived = await prisma.cashDeposit.findMany({ where: { businessId: biz.id, status: "arrived" }, include: { transaction: true } });
      for (const d of arrived) {
        eq(d.transaction.purpose, "cash_deposit", d.id);
        eq(d.transaction.accountId, null, d.id);
      }
      const all = await prisma.transaction.findMany({ where: { businessId: biz.id, purpose: "cash_deposit" }, include: { cashDeposit: true } });
      for (const t of all) ok((t.cashDeposit && t.cashDeposit.status === "arrived") || marked.has(t.id), `${t.id} is a deposit's or the owner's marking`);
      eq(await prisma.cashDeposit.count({
        where: { businessId: biz.id, status: { not: "arrived" }, OR: [{ adoptedPurpose: { not: null } }, { adoptedAccountId: { not: null } }] },
      }), 0, "no marking kept by a deposit that holds no transfer");
    });
  } finally {
    server.close();
    await prisma.$disconnect();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failures.length) console.log(`failed:\n  - ${failures.join("\n  - ")}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
