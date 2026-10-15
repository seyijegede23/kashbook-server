// FULL end-to-end test of Savings (pots).
//
// Runs the REAL /savings router, the REAL auth + ownerOnly + requireUnfrozen
// middleware, the REAL AML pipeline, the REAL executeTransfer (with the savings
// reserve gate), the REAL savings integrity loop, the REAL /auth/me flags, the
// REAL account/business deletion guards and the REAL /sync read staff get,
// over a REAL Postgres, driven through actual HTTP. Only the bank is stubbed
// (utils/anchor), because the one thing this must not do is move real money.
//
// A pot moves no money: its balance is a reserve that every spend path
// subtracts from the Anchor balance first. A pot opens at 00:00 Lagos time on
// its day. An Unbreakable pot (lockMode "strict") cannot be opened before then
// by anyone; taking money out of a Breakable one ("flexible") early costs
// KashBook's break fee, swept as a book transfer when the money not set aside
// covers it, and counted in the books as a Bank Fees and Charges expense.
// Every outbound bank call lands in nipCalls / bookCalls, so a double-send or
// a double sweep is an array length rather than something you have to reason
// about.
//
// LOCAL databases only: TEST_DATABASE_URL must point at localhost, and every
// scenario starts by truncating every table there.
//
//   node <scratchpad>/with-local-db.js <scratch db> node scripts/savings-e2e-test.js
//
// The concurrency section fires 40 requests at once, each of which holds a
// pooled connection while it waits for the business lock, so the pool is
// widened to 60 (DB_POOL_MAX). A local Postgres with the default
// max_connections=100 is fine.

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  console.error("Refusing to run without TEST_DATABASE_URL.");
  process.exit(1);
}
if (/render\.com|amazonaws|\.prod/.test(url) || !/@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url)) {
  console.error("TEST_DATABASE_URL is not a local database. Refusing: this test truncates every table.");
  process.exit(1);
}

process.env.DATABASE_URL = url;
process.env.JWT_SECRET = "e2e-only-secret-0123456789abcdef0123456789abcdef";
process.env.NODE_ENV = "test";
// Keep the AML pipeline ARMED — the sends that race the reserve in the
// concurrency section must pass the same gates they pass in production.
process.env.AML_ENABLED = "true";
process.env.SAVINGS_ENABLED = "true";
// Fees ON: a ₦50 fee + ₦50 stamp duty above ₦10k is part of what the spend
// gate must cover, and the fee account is where the break fee is swept to.
process.env.ANCHOR_FEE_ACCOUNT_ID = "fee-acct-e2e";
// Sections 1 to 8 were written for a ₦100 minimum break fee and free deposits
// and assert those exact figures, so they run with both pinned. Section 9 runs
// on the live defaults (owner, 2026-10-15: exactly 2% with no minimum, ₦250 on
// every deposit). A value left in the shell must not leak in.
delete process.env.SAVINGS_BREAK_FEE_BPS;
process.env.SAVINGS_BREAK_FEE_MIN = "100";
process.env.SAVINGS_DEPOSIT_FEE = "0";
process.env.DB_POOL_MAX = process.env.DB_POOL_MAX || "60";

// ── Stub the bank BEFORE anything requires it ────────────────────────────────
const Module = require("module");
const origLoad = Module._load;

const ANCHOR_BANKS = [
  { code: "058", id: "bank-058", name: "GTBank" },
  { code: "101", id: "bank-providus", name: "Providus Bank" },
];
// `gross` is what Anchor would report for the deposit account. Every NIP send
// and every book transfer debits it, like the real one, so the stub's own
// ledger can be checked against the reserve. `grossBy` gives one account its
// own balance (a second business), `unreadable` makes an account's balance
// read fail, and `reads` counts the reads per account. `bookMode` = "ok" |
// "reject" (a definite refusal: nothing moves) | "moved-then-502" and
// "moved-then-network" (the money moves, then the answer is lost), for the
// failed-fee-sweep tests.
const anchorState = { gross: 10_000_000, bookMode: "ok", grossBy: {}, unreadable: new Set(), reads: {} };
const nipCalls = [];
const bookCalls = [];
const grossOf = (id) => (id in anchorState.grossBy ? anchorState.grossBy[id] : anchorState.gross);
const debit = (id, amount) => {
  if (id in anchorState.grossBy) anchorState.grossBy[id] = Math.round((anchorState.grossBy[id] - Number(amount)) * 100) / 100;
  else anchorState.gross = Math.round((anchorState.gross - Number(amount)) * 100) / 100;
};

Module._load = function (request) {
  const resolved = origLoad.apply(this, arguments);
  if (/(^|[\\/])(utils[\\/])?anchor$/.test(request) && resolved && !resolved.__stubbed) {
    resolved.__stubbed = true;
    resolved.getAccountBalance = async (id) => {
      anchorState.reads[id] = (anchorState.reads[id] || 0) + 1;
      if (anchorState.unreadable.has(id)) throw Object.assign(new Error("Anchor 503 (stub)"), { httpStatus: 503 });
      const g = grossOf(id);
      return { balance: g, available: g, ledgerBalance: g, hold: 0, pending: 0 };
    };
    resolved.verifyCounterparty = async ({ accountNumber }) => ({
      accountName: `BANK VERIFIED NAME ${String(accountNumber).slice(-4)}`,
    });
    resolved.getBanks = async () => ANCHOR_BANKS;
    resolved.createCounterparty = async () => ({ counterpartyId: "cp-1" });
    resolved.createTransfer = async (args) => {
      nipCalls.push({ ...args });
      // Anchor debits the amount AND the government stamp duty on >₦10k; our
      // own ₦50 fee leaves separately, as the book transfer below.
      const { statutoryStamp = 0 } = require("../src/config/fees").computeTransferFee(Number(args.amount), "nip");
      anchorState.gross = Math.round((anchorState.gross - Number(args.amount) - statutoryStamp) * 100) / 100;
      return { transferId: `anc_tr_${nipCalls.length}`, raw: {} };
    };
    resolved.createBookTransfer = async (args) => {
      bookCalls.push({ ...args });
      if (anchorState.bookMode === "reject") {
        throw Object.assign(new Error("Anchor rejected the book transfer"), { httpStatus: 422 });
      }
      debit(args.fromAccountId, args.amount);
      if (anchorState.bookMode === "moved-then-502") {
        throw Object.assign(new Error("Anchor request failed (502)"), { httpStatus: 502 });
      }
      if (anchorState.bookMode === "moved-then-network") throw new TypeError("fetch failed");
      return { transferId: `anc_bk_${bookCalls.length}`, raw: {} };
    };
  }
  return resolved;
};

// Nothing here may reach the network. Everything that could is either stubbed
// above or gated on config this test does not set (push tokens, SMTP, the
// admin alert email), so any fetch at all is a bug worth failing loudly on.
globalThis.fetch = async (input) => {
  throw new Error(`e2e: unexpected network call to ${String(input)}`);
};

const assert = require("assert");
const http = require("http");
const express = require("express");
const bcrypt = require("@node-rs/bcrypt");

const prisma = require("../src/utils/db");
const { signToken } = require("../src/utils/jwt");
const balanceCache = require("../src/utils/balanceCache");
const { MONEY_EPS } = require("../src/config/fees");
const { toKobo } = require("../src/utils/money");
const { reconcileSavings } = require("../src/utils/savingsReconcile");
const { computeRawLedger } = require("../src/utils/ledgerBalance");
const { sumExpenses } = require("../src/utils/insightsEngine");
const { booksFor } = require("../src/utils/booksData");
const savings = require("../src/utils/savings");

// Patch the provider SINGLETON in place (class instances; a spread would drop
// the prototype and supportsBanking with it).
{
  const { getProvider } = require("../src/providers");
  const ng = getProvider("NG");
  ng.getBanks = async () => ANCHOR_BANKS;
  ng.verifyRecipient = async ({ accountNumber }) => ({
    accountName: `BANK VERIFIED NAME ${String(accountNumber).slice(-4)}`,
  });
  ng.payout = async (args) => { nipCalls.push(args); return { id: "payout-1" }; };
  if (!ng.supportsBanking) {
    console.error("provider stub broke supportsBanking — aborting rather than testing a lie");
    process.exit(1);
  }
}

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use("/auth", require("../src/routes/auth"));
app.use("/transfers", require("../src/routes/transfers"));
app.use("/businesses", require("../src/routes/businesses"));
app.use("/savings", require("../src/routes/savings"));
// Read only here: what staff with bank access are sent about the bank rows.
app.use("/sync", require("../src/routes/sync"));

let server, BASE;

const req = (method, path, { token, body } = {}) =>
  new Promise((resolve) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const r = http.request(
      `${BASE}${path}`,
      {
        method,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          let j = null;
          try { j = JSON.parse(d); } catch { /* non-JSON */ }
          resolve({ status: res.statusCode, body: j, raw: d });
        });
      },
    );
    r.on("error", (e) => resolve({ status: 0, body: { error: e.message }, raw: e.message }));
    if (data) r.write(data);
    r.end();
  });

const GET = (p, t) => req("GET", p, { token: t });
const POST = (p, t, b) => req("POST", p, { token: t, body: b });
const PATCH = (p, t, b) => req("PATCH", p, { token: t, body: b });
const DEL = (p, t) => req("DELETE", p, { token: t });

let passed = 0, failed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (e) {
    // assert's first line is only "Expected values to be strictly equal:";
    // the values that explain the failure are on the lines after it.
    const detail = String(e.message).split("\n").filter((l) => l.trim()).slice(0, 6).join("\n        ");
    console.log(`  FAIL  ${name}\n        ${detail}`);
    failures.push(`${name}: ${String(e.message).split("\n")[0]}`);
    failed++;
  }
}
const section = (s) => console.log(`\n── ${s} ${"─".repeat(Math.max(0, 58 - s.length))}`);

const minutesAgo = (n) => new Date(Date.now() - n * 60 * 1000);
const daysFromNow = (n) => new Date(Date.now() + n * 24 * 3600 * 1000);
const sameKobo = (a, b) => toKobo(a) === toKobo(b);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Lagos days, worked out here on their own (not with the code under test):
// Lagos is UTC+1 all year.
const LAGOS_MS = 60 * 60 * 1000;
const lagosDayPlus = (n) => new Date(Date.now() + LAGOS_MS + n * 86400000).toISOString().slice(0, 10);
const lagosDayOf = (at) => new Date(new Date(at).getTime() + LAGOS_MS).toISOString().slice(0, 10);
const lagosMidnightIso = (day) => new Date(`${day}T00:00:00.000+01:00`).toISOString();
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const inWords = (day) => { const [y, m, d] = day.split("-").map(Number); return `${d} ${MONTHS[m - 1]} ${y}`; };

const PIN_OWNER = "1234";
const PASSWORD = "Password123!";
const ctx = {}; // fixtures handed from one test to the next within a section
const BIZ_ID = "sav_biz";
const BIZ_NUBAN = "9990009999";
const BIZ_ANCHOR_ID = "anchor-acct-sav";
const FEE_ACCOUNT = "fee-acct-e2e";
let owner, staff, biz;
let tOwner, tStaff;

// What the server is allowed to say about a pot and a movement. No partner
// fields, no backing: a pot is a name, a target, a balance and a lock.
const POT_KEYS = ["balance", "businessId", "closedAt", "createdAt", "id", "lockMode", "lockUntil", "locked", "name", "status", "targetAmount"];
const MOVEMENT_KEYS = ["amount", "completedAt", "createdAt", "fee", "id", "potId", "reference", "status", "type"];
// What a deletion refusal carries, on both routes: the pot's name and day, and
// the owner's own business it is in (the app opens that one's savings). The
// refusal only ever reaches the pot's owner, and the pot id never leaves.
const REFUSAL_KEYS = ["businessId", "businessName", "code", "error", "opensOn", "potName", "unbreakable"];

// Every table but Prisma's migration history, in one statement. TRUNCATE
// resolves the foreign keys itself (CASCADE), covers every table added since
// this file was written, and never fires AuditLog's append-only row trigger
// (migration 20260803170000), which refuses a DELETE.
async function wipe() {
  const tables = await prisma.$queryRawUnsafe(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`,
  );
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables.map((t) => `"${t.tablename}"`).join(", ")} CASCADE`);
}

async function seed({ gross = 10_000_000 } = {}) {
  await wipe();
  nipCalls.length = 0; bookCalls.length = 0;
  anchorState.gross = gross; anchorState.bookMode = "ok";
  anchorState.grossBy = {}; anchorState.unreadable.clear(); anchorState.reads = {};
  balanceCache.bustBalance(BIZ_ID);
  process.env.SAVINGS_ENABLED = "true";
  process.env.ANCHOR_FEE_ACCOUNT_ID = FEE_ACCOUNT;

  const mk = async (over) =>
    prisma.user.create({
      data: {
        password: await bcrypt.hash(PASSWORD, 4),
        businessName: "Ada Stores", country: "NG", currency: "NGN",
        transactionPin: await bcrypt.hash(over.__pin || PIN_OWNER, 4),
        plan: "PREMIUM",
        ...Object.fromEntries(Object.entries(over).filter(([k]) => !k.startsWith("__"))),
      },
    });

  owner = await mk({ id: "sav_owner", firstName: "Ada", lastName: "Owner", email: "owner@savings.test", phone: "+2348012345678", accountType: "OWNER" });
  staff = await mk({ id: "sav_staff", firstName: "Musa", lastName: "Staff", email: "musa@savings.test", phone: "+2348012345679", accountType: "STAFF", employerId: owner.id, plan: "FREE" });

  // The most privileged staff token possible: the point of the owner-only tests
  // is that no permission can unlock savings.
  await prisma.staffPermission.create({
    data: {
      userId: staff.id, employerId: owner.id, grantedById: owner.id,
      canViewBalance: true, canTransfer: true, canViewReports: true, canManagePayables: true,
      dailyTransferCap: 1_000_000,
    },
  });

  // limited_company: singleMax ₦4m / daily ₦8m, so twenty ₦100k sends fit
  // inside the daily window and nothing here reaches the step-up OTP (>₦1m).
  biz = await prisma.business.create({
    data: {
      id: BIZ_ID, userId: owner.id, name: "Ada Stores", country: "NG", baseCurrency: "NGN",
      anchorAccountId: BIZ_ANCHOR_ID, virtualAccountNumber: BIZ_NUBAN,
      virtualAccountBank: "Providus Bank", virtualAccountName: "ADA STORES",
      kycBusinessType: "limited_company",
    },
  });

  tOwner = signToken({ userId: owner.id, tokenVersion: 0 });
  tStaff = signToken({ userId: staff.id, tokenVersion: 0 });
}

// Another account, for the tests where someone else knocks.
async function mkUser(id, over = {}) {
  const u = await prisma.user.create({
    data: {
      id, firstName: "Cid", lastName: "Other", businessName: "Other Co", country: "NG", currency: "NGN",
      email: `${id}@savings.test`, password: await bcrypt.hash(PASSWORD, 4), transactionPin: await bcrypt.hash(PIN_OWNER, 4),
      accountType: "OWNER", ...over,
    },
  });
  return { user: u, token: signToken({ userId: u.id, tokenVersion: 0 }) };
}

// A second banked business of the owner's.
const mkBiz = (id, nuban, name = "Second Shop") => prisma.business.create({
  data: {
    id, userId: owner.id, name, country: "NG", baseCurrency: "NGN",
    anchorAccountId: `anchor-acct-${id}`, virtualAccountNumber: nuban,
    virtualAccountBank: "Providus Bank", virtualAccountName: name.toUpperCase(), kycBusinessType: "limited_company",
  },
});

// ── Route helpers ─────────────────────────────────────────────────────────────
// Every pot is Breakable or Unbreakable with its day (owner, 2026-10-15). A
// test that asks for no lock gets a Breakable pot whose day has come: money
// in it comes out free at any time, as an unlocked pot's did.
const mkPot = async (over = {}) => {
  const lockAsked = "lockUntil" in over || "lockMode" in over;
  const r = await POST("/savings/pots", tOwner, {
    businessId: BIZ_ID, name: "Rent", ...(lockAsked ? {} : { lockUntil: lagosDayPlus(1), lockMode: "flexible" }), ...over,
  });
  if (lockAsked || r.status !== 201) return r;
  const opened = await prisma.savingsPot.update({ where: { id: r.body.pot.id }, data: { lockUntil: new Date(Date.now() - 60_000) } });
  r.body.pot = { ...r.body.pot, lockUntil: opened.lockUntil.toISOString(), locked: false };
  return r;
};
const depositTo = (potId, over = {}) => POST(`/savings/pots/${potId}/deposit`, tOwner, { businessId: BIZ_ID, pin: PIN_OWNER, ...over });
const withdrawFrom = (potId, over = {}) => POST(`/savings/pots/${potId}/withdraw`, tOwner, { businessId: BIZ_ID, pin: PIN_OWNER, ...over });
const closePot = (potId, over = {}) => DEL(`/savings/pots/${potId}?businessId=${over.businessId || BIZ_ID}`, over.token || tOwner);
const send = (over = {}) => POST("/transfers/send", tOwner, {
  businessId: BIZ_ID, accountNumber: "0123456789", bankCode: "058", accountName: "SUPPLIER LTD", bankName: "GTBank",
  narration: "supplier", pin: PIN_OWNER, ...over,
});
const meFeatures = async (token) => {
  const r = await GET("/auth/me", token);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  return r.body.user.features;
};
const dbPot = (id) => prisma.savingsPot.findUnique({ where: { id } });
const dbMovement = (id) => prisma.savingsMovement.findUnique({ where: { id } });
const dbMovementByRef = (reference) => prisma.savingsMovement.findUnique({ where: { reference } });
const dbTxnByRef = (reference, businessId = BIZ_ID) => prisma.transaction.findFirst({ where: { businessId, reference } });
const alertFired = (key) => prisma.alertState.findUnique({ where: { key } });
const auditCount = (action) => prisma.auditLog.count({ where: { action } });
const wideRange = () => ({ start: new Date(Date.now() - 2 * 86400000), end: new Date(Date.now() + 2 * 86400000) });
const bankCharges = async () => (await booksFor(BIZ_ID, { from: lagosDayPlus(-2), to: lagosDayPlus(2) })).expenses.lines.bankCharges.gross;

(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  BASE = `http://127.0.0.1:${server.address().port}`;

  // ══ 1. OWNER-ONLY + INPUT GATES ═══════════════════════════════════════════
  section("1. owner only — no permission unlocks savings");
  await seed();
  const potA = (await mkPot({ name: "Rent", targetAmount: 250_000 })).body?.pot;

  await test("a pot is born active through the real route, with exactly the public fields", async () => {
    assert.ok(potA?.id, "fixture: no pot");
    assert.strictEqual(potA.status, "active");
    assert.strictEqual(potA.balance, 0);
    assert.strictEqual(potA.name, "Rent");
    assert.strictEqual(potA.targetAmount, 250_000);
    // mkPot's default: a Breakable pot whose day has come.
    assert.strictEqual(potA.locked, false);
    assert.strictEqual(potA.lockMode, "flexible");
    assert.strictEqual(potA.businessId, BIZ_ID);
    assert.deepStrictEqual(Object.keys(potA).sort(), POT_KEYS, "no partner or backing field leaves the server");
    assert.strictEqual(await auditCount("SAVINGS_POT_CREATED"), 1);
  });

  await test("a pot needs Breakable or Unbreakable and its day: none of either is refused, nothing made", async () => {
    const before = await prisma.savingsPot.count({ where: { businessId: BIZ_ID } });
    const r = await POST("/savings/pots", tOwner, { businessId: BIZ_ID, name: "No lock" });
    assert.strictEqual(r.status, 400, JSON.stringify(r.body));
    assert.strictEqual(r.body?.code, "LOCK_REQUIRED");
    assert.strictEqual(r.body?.error, "Choose Breakable or Unbreakable and the day the pot opens.");
    const dayOnly = await POST("/savings/pots", tOwner, { businessId: BIZ_ID, name: "Day only", lockUntil: lagosDayPlus(10) });
    assert.strictEqual(dayOnly.status, 400, JSON.stringify(dayOnly.body));
    assert.strictEqual(dayOnly.body?.code, "BAD_LOCK", "a day needs a kind");
    const modeOnly = await POST("/savings/pots", tOwner, { businessId: BIZ_ID, name: "Kind only", lockMode: "strict" });
    assert.strictEqual(modeOnly.status, 400, JSON.stringify(modeOnly.body));
    assert.strictEqual(modeOnly.body?.code, "BAD_LOCK", "a kind needs a day");
    assert.strictEqual(await prisma.savingsPot.count({ where: { businessId: BIZ_ID } }), before, "nothing was made");
  });

  await test("a staff member with EVERY permission gets 403 OWNER_ONLY on every /savings route", async () => {
    const calls = [
      await GET(`/savings?businessId=${BIZ_ID}`, tStaff),
      await POST("/savings/pots", tStaff, { businessId: BIZ_ID, name: "X" }),
      await PATCH(`/savings/pots/${potA.id}`, tStaff, { businessId: BIZ_ID, name: "Y" }),
      await DEL(`/savings/pots/${potA.id}?businessId=${BIZ_ID}`, tStaff),
      await POST(`/savings/pots/${potA.id}/deposit`, tStaff, { businessId: BIZ_ID, amount: 1000, pin: PIN_OWNER }),
      await POST(`/savings/pots/${potA.id}/withdraw`, tStaff, { businessId: BIZ_ID, amount: 1000, pin: PIN_OWNER }),
      await GET(`/savings/pots/${potA.id}/movements?businessId=${BIZ_ID}`, tStaff),
    ];
    for (const r of calls) {
      assert.strictEqual(r.status, 403, `expected 403, got ${r.status} — ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body?.code, "OWNER_ONLY");
    }
    assert.strictEqual(await prisma.savingsMovement.count(), 0, "a staff call must not create a movement");
    assert.strictEqual((await dbPot(potA.id)).name, "Rent");
  });

  await test("no token → 401; another owner → 403/404 on every pot route, never a movement", async () => {
    const anon = await GET(`/savings?businessId=${BIZ_ID}`);
    assert.strictEqual(anon.status, 401);
    const { token: tOther } = await mkUser("sav_other");
    const list = await GET(`/savings?businessId=${BIZ_ID}`, tOther);
    assert.strictEqual(list.status, 404, JSON.stringify(list.body));
    const calls = [
      await POST(`/savings/pots/${potA.id}/deposit`, tOther, { businessId: BIZ_ID, amount: 1000, pin: PIN_OWNER }),
      await POST(`/savings/pots/${potA.id}/withdraw`, tOther, { businessId: BIZ_ID, amount: 1000, pin: PIN_OWNER }),
      await PATCH(`/savings/pots/${potA.id}`, tOther, { businessId: BIZ_ID, name: "Mine now" }),
      await DEL(`/savings/pots/${potA.id}?businessId=${BIZ_ID}`, tOther),
      await GET(`/savings/pots/${potA.id}/movements?businessId=${BIZ_ID}`, tOther),
    ];
    for (const r of calls) {
      assert.ok([403, 404].includes(r.status), `expected 403/404, got ${r.status} ${JSON.stringify(r.body)}`);
    }
    assert.strictEqual(await prisma.savingsMovement.count(), 0);
    const row = await dbPot(potA.id);
    assert.strictEqual(row.balance, 0);
    assert.strictEqual(row.name, "Rent");
    assert.strictEqual(row.status, "active");
  });

  await test("a wrong or missing PIN is refused and audited BEFORE any money read", async () => {
    const wrong = await depositTo(potA.id, { amount: 1000, pin: "9999" });
    assert.strictEqual(wrong.status, 401, JSON.stringify(wrong.body));
    assert.strictEqual(wrong.body?.code, "PIN_WRONG");
    assert.strictEqual(await auditCount("PIN_FAILED"), 1);
    const missing = await depositTo(potA.id, { amount: 1000, pin: undefined });
    assert.strictEqual(missing.status, 400, JSON.stringify(missing.body));
    assert.strictEqual(await auditCount("PIN_FAILED"), 2);
    const wd = await withdrawFrom(potA.id, { amount: 1000, pin: "0000" });
    assert.strictEqual(wd.status, 401);
    assert.strictEqual(wd.body?.code, "PIN_WRONG");
    assert.strictEqual(await prisma.savingsMovement.count(), 0);
  });

  await test("amount 0.005 → 400 BAD_AMOUNT (money is 2 dp)", async () => {
    const d = await depositTo(potA.id, { amount: 0.005 });
    assert.strictEqual(d.status, 400, JSON.stringify(d.body));
    assert.strictEqual(d.body?.code, "BAD_AMOUNT");
    const w = await withdrawFrom(potA.id, { amount: 0.005 });
    assert.strictEqual(w.status, 400);
    assert.strictEqual(w.body?.code, "BAD_AMOUNT");
    assert.strictEqual(await prisma.savingsMovement.count(), 0);
  });

  await test("zero, negative, non-numeric and missing amounts → 400 BAD_AMOUNT", async () => {
    for (const amount of [0, -5, "abc", ""]) {
      const r = await depositTo(potA.id, { amount });
      assert.strictEqual(r.status, 400, `amount ${JSON.stringify(amount)}: ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body?.code, "BAD_AMOUNT");
    }
    const missing = await depositTo(potA.id, {});
    assert.strictEqual(missing.status, 400);
    assert.strictEqual(missing.body?.code, "BAD_AMOUNT");
    assert.strictEqual(await prisma.savingsMovement.count(), 0);
  });

  await test("pot creation gates: a name, a sane target, a bank account, an owned business", async () => {
    const noName = await mkPot({ name: "   " });
    assert.strictEqual(noName.status, 400, JSON.stringify(noName.body));
    assert.strictEqual(noName.body?.code, "BAD_NAME");
    const badTarget = await mkPot({ name: "X", targetAmount: -1 });
    assert.strictEqual(badTarget.status, 400);
    assert.strictEqual(badTarget.body?.code, "BAD_AMOUNT");
    const fractional = await mkPot({ name: "X", targetAmount: 10.005 });
    assert.strictEqual(fractional.status, 400);
    assert.strictEqual(fractional.body?.code, "BAD_AMOUNT");
    const unbanked = await prisma.business.create({
      data: { id: "sav_biz_nobank", userId: owner.id, name: "Side Hustle", country: "NG", baseCurrency: "NGN" },
    });
    const noBank = await mkPot({ name: "X", businessId: unbanked.id });
    assert.strictEqual(noBank.status, 400, JSON.stringify(noBank.body));
    assert.strictEqual(noBank.body?.code, "NO_BANKING");
    const unknown = await mkPot({ name: "X", businessId: "no-such-business" });
    assert.strictEqual(unknown.status, 404);
    assert.strictEqual(await prisma.savingsPot.count(), 1, "none of these created a pot");
  });

  await test("at most 10 open pots; closing one frees the slot, closed pots do not count", async () => {
    for (let i = 2; i <= 10; i++) {
      const r = await mkPot({ name: `Pot ${i}` });
      assert.strictEqual(r.status, 201, `pot ${i}: ${JSON.stringify(r.body)}`);
    }
    const eleventh = await mkPot({ name: "One too many" });
    assert.strictEqual(eleventh.status, 409, JSON.stringify(eleventh.body));
    assert.strictEqual(eleventh.body?.code, "POT_LIMIT");
    const tenth = await prisma.savingsPot.findFirst({ where: { businessId: BIZ_ID, name: "Pot 10" } });
    const closed = await closePot(tenth.id);
    assert.strictEqual(closed.status, 204, closed.raw);
    const again = await mkPot({ name: "Fits now" });
    assert.strictEqual(again.status, 201, JSON.stringify(again.body));
    assert.strictEqual(await prisma.savingsPot.count({ where: { businessId: BIZ_ID, status: "active" } }), 10);
    assert.strictEqual(await prisma.savingsPot.count({ where: { businessId: BIZ_ID, status: "closed" } }), 1);
  });

  await test("SAVINGS_ENABLED unset: creation and deposits 403 SAVINGS_DISABLED, reads and withdrawals still work", async () => {
    const dep = await depositTo(potA.id, { amount: 1000, idempotencyKey: "gatedep" });
    assert.strictEqual(dep.status, 200, JSON.stringify(dep.body));
    delete process.env.SAVINGS_ENABLED;
    try {
      const create = await mkPot({ name: "Blocked" });
      assert.strictEqual(create.status, 403, JSON.stringify(create.body));
      assert.strictEqual(create.body?.code, "SAVINGS_DISABLED");
      const dep2 = await depositTo(potA.id, { amount: 1000, idempotencyKey: "gatedep2" });
      assert.strictEqual(dep2.status, 403);
      assert.strictEqual(dep2.body?.code, "SAVINGS_DISABLED");
      assert.strictEqual(await dbMovementByRef("kb_sv_gatedep2"), null);
      const list = await GET(`/savings?businessId=${BIZ_ID}`, tOwner);
      assert.strictEqual(list.status, 200);
      assert.strictEqual(list.body.enabled, false);
      assert.ok(list.body.pots.some((p) => p.id === potA.id), "pots are still listed with the switch off");
      assert.strictEqual(list.body.totals.reserved, 1000, "the reserve is still reported with the switch off");
      const bal = await GET(`/transfers/balance?businessId=${BIZ_ID}`, tOwner);
      assert.strictEqual(bal.body.savingsReserved, 1000, "the reserve still gates spending with the switch off");
      const moves = await GET(`/savings/pots/${potA.id}/movements?businessId=${BIZ_ID}`, tOwner);
      assert.strictEqual(moves.status, 200);
      assert.strictEqual(moves.body.movements.length, 1);
      const wd = await withdrawFrom(potA.id, { amount: 1000, idempotencyKey: "gatewd" });
      assert.strictEqual(wd.status, 200, JSON.stringify(wd.body));
      assert.strictEqual(wd.body.movement.status, "completed");
      assert.strictEqual((await dbPot(potA.id)).balance, 0);
    } finally {
      process.env.SAVINGS_ENABLED = "true";
    }
  });

  // ══ 2. LEDGER POTS: THE RESERVE ═══════════════════════════════════════════
  section("2. ledger pots — nothing moves, the server refuses to spend it");
  await seed({ gross: 1_500_000 });
  const rent = (await mkPot({ name: "Rent" })).body.pot;
  let ledgerDep;

  await test("a deposit is one completed movement and raises the reserve; no money moves", async () => {
    const r = await depositTo(rent.id, { amount: 1_000_000, idempotencyKey: "l1" });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    ledgerDep = r.body.movement;
    assert.deepStrictEqual(Object.keys(ledgerDep).sort(), MOVEMENT_KEYS);
    assert.strictEqual(ledgerDep.type, "deposit");
    assert.strictEqual(ledgerDep.status, "completed");
    assert.strictEqual(ledgerDep.amount, 1_000_000);
    assert.strictEqual(ledgerDep.fee, 0);
    assert.strictEqual(ledgerDep.reference, "kb_sv_l1");
    assert.ok(ledgerDep.completedAt, "completed at once");
    assert.strictEqual(r.body.pot.balance, 1_000_000);
    assert.strictEqual(r.body.reserved, 1_000_000);
    assert.strictEqual(r.body.replay, false);
    assert.strictEqual(nipCalls.length, 0, "a deposit moves no money");
    assert.strictEqual(bookCalls.length, 0);
    assert.strictEqual(await prisma.transaction.count(), 0, "a deposit writes no bank row");
    assert.strictEqual(anchorState.gross, 1_500_000, "the bank balance is untouched");
    assert.strictEqual(await auditCount("SAVINGS_DEPOSIT"), 1);
  });

  await test("GET /savings reports the pot, the totals and the break fee", async () => {
    const r = await GET(`/savings?businessId=${BIZ_ID}`, tOwner);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.enabled, true);
    assert.strictEqual(r.body.hasBankAccount, true);
    assert.deepStrictEqual(r.body.totals, { saved: 1_000_000, reserved: 1_000_000 });
    assert.deepStrictEqual(r.body.breakFee, { enabled: true, bps: 200, pct: 2, min: 100 });
    assert.strictEqual(r.body.pots.length, 1);
    assert.strictEqual(r.body.pots[0].id, rent.id);
    assert.strictEqual(r.body.pots[0].balance, 1_000_000);
  });

  await test("GET /transfers/balance shows spendable = gross − reserve", async () => {
    const r = await GET(`/transfers/balance?businessId=${BIZ_ID}`, tOwner);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.balance, 500_000);
    assert.strictEqual(r.body.grossBalance, 1_500_000);
    assert.strictEqual(r.body.savingsReserved, 1_000_000);
  });

  await test("GET /businesses/:id/balance shows the same spendable figure, cached or not", async () => {
    balanceCache.bustBalance(BIZ_ID);
    const r = await GET(`/businesses/${BIZ_ID}/balance`, tOwner);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.balance, 500_000);
    assert.strictEqual(r.body.grossBalance, 1_500_000);
    assert.strictEqual(r.body.savingsReserved, 1_000_000);
    assert.strictEqual(r.body.hasAccount, true);
    // And again from the cache: the reserve is never cached.
    const cached = await GET(`/businesses/${BIZ_ID}/balance`, tOwner);
    assert.strictEqual(cached.body.cached, true);
    assert.strictEqual(cached.body.balance, 500_000);
    assert.strictEqual(cached.body.savingsReserved, 1_000_000);
  });

  await test("POST /transfers/send beyond spendable → 400 INSUFFICIENT_BALANCE naming the reserve, no bank call", async () => {
    const r = await send({ amount: 600_000, idempotencyKey: "over1" });
    assert.strictEqual(r.status, 400, JSON.stringify(r.body));
    assert.strictEqual(r.body?.code, "INSUFFICIENT_BALANCE");
    assert.ok(/set aside in savings/.test(r.body.error), `message must name the reserve: ${r.body.error}`);
    assert.strictEqual(nipCalls.length, 0);
    assert.strictEqual(await prisma.transaction.count(), 0);
  });

  await test("POST /transfers/send within spendable succeeds and is booked as a plain transfer", async () => {
    const grossBefore = anchorState.gross;
    const r = await send({ amount: 400_000, idempotencyKey: "ok1" });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.status, "success");
    assert.strictEqual(r.body.reference, "kbtf_ok1");
    assert.strictEqual(r.body.route, "nip");
    assert.strictEqual(nipCalls.length, 1);
    assert.strictEqual(nipCalls[0].amount, 400_000);
    assert.strictEqual(bookCalls.length, 1, "the ₦50 transfer fee is swept");
    assert.strictEqual(bookCalls[0].reference, "kbtf_ok1_fee");
    assert.strictEqual(bookCalls[0].toAccountId, FEE_ACCOUNT);
    const txn = await dbTxnByRef("kbtf_ok1");
    assert.ok(txn, "the send must be booked");
    assert.strictEqual(txn.purpose, null, "a plain send carries no purpose");
    assert.strictEqual(txn.fee, 100, "₦50 fee + ₦50 stamp duty");
    // amount + stamp duty (Anchor's debit) + our fee (the book transfer) left the bank.
    assert.ok(sameKobo(anchorState.gross, grossBefore - 400_000 - 100), `bank ${anchorState.gross}`);
  });

  await test("a withdrawal frees the reserve; still no money moves", async () => {
    const r = await withdrawFrom(rent.id, { amount: 1_000_000, idempotencyKey: "lw1" });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.movement.type, "withdrawal");
    assert.strictEqual(r.body.movement.status, "completed");
    assert.strictEqual(r.body.movement.fee, 0);
    assert.strictEqual(r.body.movement.reference, "kb_svw_lw1");
    assert.strictEqual(r.body.pot.balance, 0);
    assert.strictEqual(r.body.reserved, 0);
    const bal = await GET(`/transfers/balance?businessId=${BIZ_ID}`, tOwner);
    assert.strictEqual(bal.body.savingsReserved, 0);
    assert.strictEqual(bal.body.balance, bal.body.grossBalance);
    assert.ok(sameKobo(bal.body.grossBalance, anchorState.gross));
    assert.strictEqual(nipCalls.length, 1, "a withdrawal moves no money");
    assert.strictEqual(bookCalls.length, 1, "no fee on an unlocked pot");
    assert.strictEqual(await auditCount("SAVINGS_WITHDRAWAL"), 1);
  });

  await test("the same idempotencyKey replays the movement and never credits or debits the pot twice", async () => {
    const dep = await depositTo(rent.id, { amount: 1_000_000, idempotencyKey: "l1" });
    assert.strictEqual(dep.status, 200, JSON.stringify(dep.body));
    assert.strictEqual(dep.body.replay, true);
    assert.strictEqual(dep.body.movement.id, ledgerDep.id);
    assert.strictEqual((await dbPot(rent.id)).balance, 0, "a replayed deposit must not increment the pot");
    const wd = await withdrawFrom(rent.id, { amount: 1_000_000, idempotencyKey: "lw1" });
    assert.strictEqual(wd.status, 200, JSON.stringify(wd.body));
    assert.strictEqual(wd.body.replay, true);
    assert.strictEqual(wd.body.movement.reference, "kb_svw_lw1");
    assert.strictEqual((await dbPot(rent.id)).balance, 0, "a replayed withdrawal must not decrement the pot");
    assert.strictEqual(await prisma.savingsMovement.count(), 2, "replays add no rows");
  });

  await test("the same key with a different amount → 409 IDEMPOTENCY_MISMATCH; on another pot → 409 IDEMPOTENCY_REUSED", async () => {
    const wrong = await depositTo(rent.id, { amount: 999_999, idempotencyKey: "l1" });
    assert.strictEqual(wrong.status, 409, JSON.stringify(wrong.body));
    assert.strictEqual(wrong.body?.code, "IDEMPOTENCY_MISMATCH");
    const other = (await mkPot({ name: "Other" })).body.pot;
    const reused = await depositTo(other.id, { amount: 1_000_000, idempotencyKey: "l1" });
    assert.strictEqual(reused.status, 409, JSON.stringify(reused.body));
    assert.strictEqual(reused.body?.code, "IDEMPOTENCY_REUSED");
    assert.strictEqual(await prisma.savingsMovement.count(), 2);
    assert.strictEqual((await dbPot(rent.id)).balance, 0);
    assert.strictEqual((await dbPot(other.id)).balance, 0);
  });

  await test("a withdrawal above the pot balance → 400 INSUFFICIENT_POT_BALANCE", async () => {
    const d = await depositTo(rent.id, { amount: 500_000, idempotencyKey: "l2" });
    assert.strictEqual(d.status, 200, JSON.stringify(d.body));
    const r = await withdrawFrom(rent.id, { amount: 500_000.01, idempotencyKey: "lwover" });
    assert.strictEqual(r.status, 400, JSON.stringify(r.body));
    assert.strictEqual(r.body?.code, "INSUFFICIENT_POT_BALANCE");
    assert.strictEqual(r.body?.potBalance, 500_000);
    assert.strictEqual((await dbPot(rent.id)).balance, 500_000);
    assert.strictEqual(await dbMovementByRef("kb_svw_lwover"), null, "a refused withdrawal leaves no row");
  });

  await test("a deposit beyond spendable (gross − reserved) → 400 INSUFFICIENT_BALANCE; exactly spendable is allowed", async () => {
    const spendable = Math.round((anchorState.gross - 500_000) * 100) / 100;
    const r = await depositTo(rent.id, { amount: spendable + 1, idempotencyKey: "l3" });
    assert.strictEqual(r.status, 400, JSON.stringify(r.body));
    assert.strictEqual(r.body?.code, "INSUFFICIENT_BALANCE");
    assert.strictEqual(r.body?.reserved, 500_000);
    assert.ok(sameKobo(r.body?.availableBalance, spendable), `availableBalance ${r.body?.availableBalance} vs ${spendable}`);
    assert.strictEqual((await dbPot(rent.id)).balance, 500_000);
    assert.strictEqual(await dbMovementByRef("kb_sv_l3"), null, "no movement row for a refused deposit");
    // The gate is ≥ to the kobo: every naira in the account can be set aside.
    const edge = await depositTo(rent.id, { amount: spendable, idempotencyKey: "l3b" });
    assert.strictEqual(edge.status, 200, JSON.stringify(edge.body));
    assert.ok(sameKobo(edge.body.reserved, anchorState.gross), "the whole account is now reserved");
    const bal = await GET(`/transfers/balance?businessId=${BIZ_ID}`, tOwner);
    assert.strictEqual(bal.body.balance, 0);
    const back = await withdrawFrom(rent.id, { amount: spendable, idempotencyKey: "l3bw" });
    assert.strictEqual(back.status, 200, JSON.stringify(back.body));
    assert.strictEqual(back.body.pot.balance, 500_000);
  });

  await test("bank unreachable → deposit fails CLOSED (503 BALANCE_UNAVAILABLE), pot untouched", async () => {
    const anchor = require("../src/utils/anchor");
    const real = anchor.getAccountBalance;
    anchor.getAccountBalance = async () => { throw new Error("Anchor 503"); };
    try {
      const r = await depositTo(rent.id, { amount: 1, idempotencyKey: "l4" });
      assert.strictEqual(r.status, 503, JSON.stringify(r.body));
      assert.strictEqual(r.body?.code, "BALANCE_UNAVAILABLE");
      assert.strictEqual((await dbPot(rent.id)).balance, 500_000);
      assert.strictEqual(await dbMovementByRef("kb_sv_l4"), null);
    } finally {
      anchor.getAccountBalance = real;
    }
  });

  await test("reserve above gross: spendable floors at 0, sends and deposits refuse (the alarm is in section 5)", async () => {
    const before = anchorState.gross;
    anchorState.gross = 100;
    try {
      const bal = await GET(`/transfers/balance?businessId=${BIZ_ID}`, tOwner);
      assert.strictEqual(bal.body.balance, 0);
      assert.strictEqual(bal.body.grossBalance, 100);
      assert.strictEqual(bal.body.savingsReserved, 500_000);
      const r = await send({ amount: 1_000, idempotencyKey: "over2" });
      assert.strictEqual(r.status, 400, JSON.stringify(r.body));
      assert.strictEqual(r.body?.code, "INSUFFICIENT_BALANCE");
      assert.strictEqual(nipCalls.length, 1);
      const d = await depositTo(rent.id, { amount: 1, idempotencyKey: "over3" });
      assert.strictEqual(d.status, 400, JSON.stringify(d.body));
      assert.strictEqual(d.body?.code, "INSUFFICIENT_BALANCE");
    } finally {
      anchorState.gross = before;
    }
  });

  await test("DELETE a pot with money → 409 POT_NOT_EMPTY; empty → 204; closed pots leave the list and refuse money", async () => {
    const full = await closePot(rent.id);
    assert.strictEqual(full.status, 409, JSON.stringify(full.body));
    assert.strictEqual(full.body?.code, "POT_NOT_EMPTY");
    assert.strictEqual(full.body?.balance, 500_000);
    assert.strictEqual((await dbPot(rent.id)).status, "active");
    const out = await withdrawFrom(rent.id, { amount: 500_000, idempotencyKey: "lwall" });
    assert.strictEqual(out.status, 200, JSON.stringify(out.body));
    const empty = await closePot(rent.id);
    assert.strictEqual(empty.status, 204, empty.raw);
    const row = await dbPot(rent.id);
    assert.strictEqual(row.status, "closed");
    assert.ok(row.closedAt);
    assert.strictEqual(row.balance, 0);
    assert.strictEqual((await closePot(rent.id)).status, 204, "closing a closed pot is a no-op, not an error");
    const list = await GET(`/savings?businessId=${BIZ_ID}`, tOwner);
    assert.ok(!list.body.pots.some((p) => p.id === rent.id), "a closed pot leaves the list");
    const dep = await depositTo(rent.id, { amount: 1, idempotencyKey: "lclosed" });
    assert.strictEqual(dep.status, 409, JSON.stringify(dep.body));
    assert.strictEqual(dep.body?.code, "POT_NOT_READY");
    const wd = await withdrawFrom(rent.id, { amount: 1, idempotencyKey: "lclosedw" });
    assert.strictEqual(wd.status, 409);
    assert.strictEqual(wd.body?.code, "POT_NOT_READY");
    const patch = await PATCH(`/savings/pots/${rent.id}`, tOwner, { businessId: BIZ_ID, name: "Reopen?" });
    assert.strictEqual(patch.status, 409);
    assert.strictEqual(patch.body?.code, "POT_CLOSED");
    const bal = await GET(`/transfers/balance?businessId=${BIZ_ID}`, tOwner);
    assert.strictEqual(bal.body.savingsReserved, 0, "a closed pot reserves nothing");
    assert.ok((await auditCount("SAVINGS_POT_CLOSED")) >= 1);
  });

  await test("movements are listed newest first with the pot; 30 a page, a cursor for the rest", async () => {
    const r = await GET(`/savings/pots/${rent.id}/movements?businessId=${BIZ_ID}`, tOwner);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.movements.length >= 3, "a closed pot's history is still readable");
    assert.deepStrictEqual(Object.keys(r.body.movements[0]).sort(), MOVEMENT_KEYS);
    const times = r.body.movements.map((m) => new Date(m.createdAt).getTime());
    for (let i = 1; i < times.length; i++) assert.ok(times[i - 1] >= times[i], "newest first");
    assert.strictEqual(r.body.nextCursor, null);
    assert.strictEqual(r.body.pot.id, rent.id);
    assert.strictEqual(r.body.pot.status, "closed");

    const pages = (await mkPot({ name: "Pages" })).body.pot;
    for (let i = 0; i < 31; i++) {
      const d = await depositTo(pages.id, { amount: 1, idempotencyKey: `pg${i}` });
      assert.strictEqual(d.status, 200, `deposit ${i}: ${JSON.stringify(d.body)}`);
    }
    const p1 = await GET(`/savings/pots/${pages.id}/movements?businessId=${BIZ_ID}`, tOwner);
    assert.strictEqual(p1.body.movements.length, 30);
    assert.strictEqual(p1.body.nextCursor, p1.body.movements[29].id);
    const p2 = await GET(`/savings/pots/${pages.id}/movements?businessId=${BIZ_ID}&cursor=${encodeURIComponent(p1.body.nextCursor)}`, tOwner);
    assert.strictEqual(p2.status, 200, JSON.stringify(p2.body));
    assert.strictEqual(p2.body.movements.length, 1);
    assert.strictEqual(p2.body.movements[0].reference, "kb_sv_pg0", "the oldest movement is on the last page");
    assert.strictEqual(p2.body.nextCursor, null);
    const ids = new Set(p1.body.movements.map((m) => m.id));
    assert.ok(!ids.has(p2.body.movements[0].id), "pages do not overlap");
    assert.strictEqual((await withdrawFrom(pages.id, { amount: 31, idempotencyKey: "pgall" })).status, 200);
  });

  // ══ 2b. KOBO ══════════════════════════════════════════════════════════════
  // About one kobo amount in eight used to be refused as having "more than 2
  // decimal places" (19.99 * 100 is 1998.9999999999998), the pot's own balance
  // among them, which then blocked closing the pot and deleting the account.
  section("2b. every kobo amount is money: in, out, as a target, to the last kobo");
  await seed();

  await test("19.99, 4.35, 1.10, 0.07 and 2500.55 go in and come out; targets of 19.99 and 4.35 are kept to the kobo", async () => {
    const created = await mkPot({ name: "Kobo", targetAmount: 19.99 });
    assert.strictEqual(created.status, 201, JSON.stringify(created.body));
    const pot = created.body.pot;
    assert.strictEqual(pot.targetAmount, 19.99);
    const t = await PATCH(`/savings/pots/${pot.id}`, tOwner, { businessId: BIZ_ID, targetAmount: "4.35" });
    assert.strictEqual(t.status, 200, JSON.stringify(t.body));
    assert.strictEqual(t.body.pot.targetAmount, 4.35);
    let n = 0;
    for (const amount of [19.99, 4.35, "1.10", 0.07, 2500.55]) {
      const d = await depositTo(pot.id, { amount, idempotencyKey: `kd${n}` });
      assert.strictEqual(d.status, 200, `deposit ${amount}: ${JSON.stringify(d.body)}`);
      const w = await withdrawFrom(pot.id, { amount, idempotencyKey: `kw${n}` });
      assert.strictEqual(w.status, 200, `withdraw ${amount}: ${JSON.stringify(w.body)}`);
      n++;
    }
    assert.strictEqual((await dbPot(pot.id)).balance, 0);
    assert.strictEqual((await dbMovementByRef("kb_sv_kd2")).amount, 1.1, "booked as whole kobo");
    // Not money: a third decimal, and a target of Infinity in any spelling.
    assert.strictEqual((await depositTo(pot.id, { amount: 10.005, idempotencyKey: "kbad" })).body?.code, "BAD_AMOUNT");
    for (const targetAmount of ["1e999", "Infinity", 1e300]) {
      const r = await mkPot({ name: "Too big", targetAmount });
      assert.strictEqual(r.status, 400, `${targetAmount}: ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body?.code, "BAD_AMOUNT");
    }
    assert.strictEqual(await prisma.savingsPot.count({ where: { name: "Too big" } }), 0);
  });

  await test("₦1,000.05 + ₦1,500.02 in: the pot shows ₦2,500.07, that figure comes out in one go, and the pot closes", async () => {
    const pot = (await mkPot({ name: "Round trip" })).body.pot;
    assert.strictEqual((await depositTo(pot.id, { amount: 1000.05, idempotencyKey: "rt1" })).status, 200);
    const d2 = await depositTo(pot.id, { amount: 1500.02, idempotencyKey: "rt2" });
    assert.strictEqual(d2.status, 200, JSON.stringify(d2.body));
    assert.strictEqual(d2.body.pot.balance, 2500.07, "shown as whole kobo, never 2500.0699999999997");
    const list = await GET(`/savings?businessId=${BIZ_ID}`, tOwner);
    assert.strictEqual(list.body.pots.find((p) => p.id === pot.id).balance, 2500.07);
    const all = await withdrawFrom(pot.id, { amount: d2.body.pot.balance, idempotencyKey: "rt3" });
    assert.strictEqual(all.status, 200, JSON.stringify(all.body));
    assert.strictEqual(all.body.pot.balance, 0);
    assert.strictEqual((await dbPot(pot.id)).balance, 0, "no float residue is left behind");
    assert.strictEqual((await closePot(pot.id)).status, 204);
  });

  await test("₦2,500 out of ₦2,500.07 leaves ₦0.07, shown and taken out as such; ₦35 + ₦0.02 comes out as ₦35.02", async () => {
    const pot = (await mkPot({ name: "Leftover" })).body.pot;
    assert.strictEqual((await depositTo(pot.id, { amount: 1000.05, idempotencyKey: "lo1" })).status, 200);
    assert.strictEqual((await depositTo(pot.id, { amount: 1500.02, idempotencyKey: "lo2" })).status, 200);
    const most = await withdrawFrom(pot.id, { amount: 2500, idempotencyKey: "lo3" });
    assert.strictEqual(most.status, 200, JSON.stringify(most.body));
    assert.strictEqual(most.body.pot.balance, 0.07, "the residue 0.06999999999970896 is shown as the 7 kobo it is");
    const rest = await withdrawFrom(pot.id, { amount: most.body.pot.balance, idempotencyKey: "lo4" });
    assert.strictEqual(rest.status, 200, JSON.stringify(rest.body));
    assert.strictEqual((await dbPot(pot.id)).balance, 0);
    assert.strictEqual((await closePot(pot.id)).status, 204);
    const p2 = (await mkPot({ name: "Thirty five" })).body.pot;
    assert.strictEqual((await depositTo(p2.id, { amount: 35, idempotencyKey: "tf1" })).status, 200);
    assert.strictEqual((await depositTo(p2.id, { amount: 0.02, idempotencyKey: "tf2" })).status, 200);
    const out = await withdrawFrom(p2.id, { amount: 35.02, idempotencyKey: "tf3" });
    assert.strictEqual(out.status, 200, JSON.stringify(out.body));
    assert.strictEqual((await closePot(p2.id)).status, 204);
    const t = await reconcileSavings();
    assert.strictEqual(t.drift, 0, `the movements agree with every pot: ${JSON.stringify(t)}`);
  });

  // ══ 3. CONCURRENCY ════════════════════════════════════════════════════════
  section("3. concurrency — reserved + sent never exceed gross");
  await seed({ gross: 1_200_000 });
  const tax = (await mkPot({ name: "Tax" })).body.pot;

  await test("20 concurrent deposit + send pairs never overshoot the bank balance", async () => {
    const ops = [];
    for (let i = 0; i < 20; i++) {
      ops.push(depositTo(tax.id, { amount: 100_000, idempotencyKey: `concdep${i}` }));
      ops.push(send({ amount: 100_000, idempotencyKey: `concsend${i}`, narration: `conc ${i}` }));
    }
    const results = await Promise.all(ops);
    for (const r of results) {
      assert.ok(
        r.status === 200 || (r.status === 400 && r.body?.code === "INSUFFICIENT_BALANCE"),
        `every outcome is success or INSUFFICIENT_BALANCE, got ${r.status} ${JSON.stringify(r.body)}`,
      );
    }
    const reserved = (await dbPot(tax.id)).balance;
    const sent = await prisma.transaction.findMany({ where: { businessId: BIZ_ID, reference: { startsWith: "kbtf_concsend" } }, select: { amount: true, fee: true } });
    const sentTotal = sent.reduce((s, t) => s + Number(t.amount) + Number(t.fee || 0), 0);
    const depositsOk = results.filter((r, i) => i % 2 === 0 && r.status === 200).length;
    const sendsOk = results.filter((r, i) => i % 2 === 1 && r.status === 200).length;
    assert.strictEqual(sendsOk, sent.length, "every successful send is booked exactly once");
    assert.strictEqual(nipCalls.length, sent.length, "one bank call per booked send");
    assert.ok(reserved + sentTotal <= 1_200_000 + MONEY_EPS, `reserved ${reserved} + sent ${sentTotal} > gross 1,200,000`);
    assert.ok(reserved + sentTotal >= 1_100_000, `the lock must not starve either side: reserved ${reserved} + sent ${sentTotal}`);
    assert.ok(depositsOk + sendsOk >= 11, `expected ~12 successes, got ${depositsOk} deposits + ${sendsOk} sends`);
    // The stub's own ledger agrees: what is left at the bank covers the reserve.
    assert.ok(anchorState.gross + MONEY_EPS >= reserved, `bank ${anchorState.gross} < reserve ${reserved}`);
    // And the movement ledger agrees with the pot.
    const agg = await prisma.savingsMovement.aggregate({ where: { potId: tax.id, status: "completed", type: "deposit" }, _sum: { amount: true } });
    assert.ok(sameKobo(agg._sum.amount || 0, reserved));
    assert.strictEqual(await prisma.savingsMovement.count({ where: { potId: tax.id } }), depositsOk, "one row per successful deposit, none for a refusal");
  });

  await test("the integrity loop finds nothing to say about the race", async () => {
    const stats = await reconcileSavings();
    assert.strictEqual(stats.drift, 0, JSON.stringify(stats));
    assert.strictEqual(stats.overReserved, 0, JSON.stringify(stats));
    assert.strictEqual(stats.feesCollected, 0);
    assert.strictEqual(stats.feesDeferred, 0);
    assert.strictEqual(stats.errors, 0);
  });

  // ══ 4. LOCKS ══════════════════════════════════════════════════════════════
  section("4. locks: Unbreakable is server-enforced, Breakable is a priced confirmation");
  await seed();

  await test("Unbreakable lock → 423 POT_LOCKED on withdrawal, even with confirmEarly, naming the day it opens", async () => {
    const r = await mkPot({ name: "School fees", lockUntil: daysFromNow(30).toISOString(), lockMode: "strict" });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    const pot = r.body.pot;
    assert.strictEqual(pot.locked, true);
    assert.strictEqual(pot.lockMode, "strict");
    const d = await depositTo(pot.id, { amount: 10_000, idempotencyKey: "s1" });
    assert.strictEqual(d.status, 200, "a locked pot still takes deposits");
    const w = await withdrawFrom(pot.id, { amount: 1_000, idempotencyKey: "sw1", confirmEarly: true });
    assert.strictEqual(w.status, 423, JSON.stringify(w.body));
    assert.strictEqual(w.body?.code, "POT_LOCKED");
    assert.strictEqual(w.body?.lockUntil, pot.lockUntil, "the refusal says until when");
    assert.strictEqual(w.body?.error, `This pot is unbreakable. It opens on ${inWords(lagosDayOf(pot.lockUntil))}.`);
    assert.ok(!("fee" in w.body) && !("feeBps" in w.body), "an Unbreakable pot has no price: nothing opens it early");
    assert.strictEqual((await dbPot(pot.id)).balance, 10_000);
    assert.strictEqual(await dbMovementByRef("kb_svw_sw1"), null);
    ctx.strictPot = pot;
  });

  await test("PATCH shortening, removing or relaxing an Unbreakable lock → 409 LOCK_CANNOT_SHORTEN; extending is allowed; its own day again changes nothing", async () => {
    const pot = ctx.strictPot;
    const shorter = await PATCH(`/savings/pots/${pot.id}`, tOwner, { businessId: BIZ_ID, pin: PIN_OWNER, lockUntil: daysFromNow(10).toISOString(), lockMode: "strict" });
    assert.strictEqual(shorter.status, 409, JSON.stringify(shorter.body));
    assert.strictEqual(shorter.body?.code, "LOCK_CANNOT_SHORTEN");
    // Every empty value asks to remove the lock, and none gets round it.
    for (const lockUntil of [null, "", 0, false]) {
      const removed = await PATCH(`/savings/pots/${pot.id}`, tOwner, { businessId: BIZ_ID, pin: PIN_OWNER, lockUntil });
      assert.strictEqual(removed.status, 409, `${JSON.stringify(lockUntil)}: ${JSON.stringify(removed.body)}`);
      assert.strictEqual(removed.body?.code, "LOCK_CANNOT_SHORTEN");
    }
    const relaxed = await PATCH(`/savings/pots/${pot.id}`, tOwner, { businessId: BIZ_ID, pin: PIN_OWNER, lockUntil: daysFromNow(60).toISOString(), lockMode: "flexible" });
    assert.strictEqual(relaxed.status, 409);
    assert.strictEqual(relaxed.body?.code, "LOCK_CANNOT_SHORTEN");
    const same = await PATCH(`/savings/pots/${pot.id}`, tOwner, { businessId: BIZ_ID, pin: PIN_OWNER, name: "School fees 2027", lockUntil: lagosDayOf(pot.lockUntil), lockMode: "strict" });
    assert.strictEqual(same.status, 200, JSON.stringify(same.body));
    assert.strictEqual(same.body.pot.lockUntil, pot.lockUntil, "the same opening day is no change");
    assert.strictEqual(same.body.pot.name, "School fees 2027");
    const longer = await PATCH(`/savings/pots/${pot.id}`, tOwner, { businessId: BIZ_ID, pin: PIN_OWNER, lockUntil: daysFromNow(60).toISOString(), lockMode: "strict" });
    assert.strictEqual(longer.status, 200, JSON.stringify(longer.body));
    assert.strictEqual(longer.body.businessId, BIZ_ID);
    assert.ok(new Date(longer.body.pot.lockUntil) > daysFromNow(59));
    assert.strictEqual(longer.body.pot.lockMode, "strict");
    const past = await PATCH(`/savings/pots/${pot.id}`, tOwner, { businessId: BIZ_ID, pin: PIN_OWNER, lockUntil: daysFromNow(-1).toISOString(), lockMode: "strict" });
    assert.strictEqual(past.status, 400, JSON.stringify(past.body));
    assert.strictEqual(past.body?.code, "BAD_LOCK");
    const row = await dbPot(pot.id);
    assert.ok(new Date(row.lockUntil) > daysFromNow(59), "the refusals changed nothing");
    assert.strictEqual(row.lockMode, "strict");
  });

  await test("Breakable lock → 409 EARLY_WITHDRAWAL_CONFIRM carrying the fee and the day, then success with confirmEarly and ONE sweep", async () => {
    const r = await mkPot({ name: "Holiday", lockUntil: daysFromNow(30).toISOString(), lockMode: "flexible" });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    const pot = r.body.pot;
    assert.strictEqual(pot.locked, true);
    assert.strictEqual(pot.lockMode, "flexible");
    assert.strictEqual((await depositTo(pot.id, { amount: 5_000, idempotencyKey: "f1" })).status, 200);
    ctx.expBefore = await sumExpenses(BIZ_ID, wideRange());
    ctx.chargesBefore = await bankCharges();
    ctx.ledgerBefore = await computeRawLedger(BIZ_ID, "NGN");
    const grossBefore = anchorState.gross;

    const w1 = await withdrawFrom(pot.id, { amount: 1_000, idempotencyKey: "fw1" });
    assert.strictEqual(w1.status, 409, JSON.stringify(w1.body));
    assert.strictEqual(w1.body?.code, "EARLY_WITHDRAWAL_CONFIRM");
    // The refusal names the price of breaking the lock: 2% of ₦1,000 is ₦20,
    // floored at the ₦100 minimum.
    assert.strictEqual(w1.body?.fee, 100, JSON.stringify(w1.body));
    assert.strictEqual(w1.body?.feeBps, 200);
    assert.strictEqual(w1.body?.lockUntil, pot.lockUntil);
    assert.ok(/costs/.test(w1.body.error), `the message states the price: ${w1.body.error}`);
    assert.ok(w1.body.error.startsWith(`This pot opens on ${inWords(lagosDayOf(pot.lockUntil))}. Withdrawing `), `the message names the day: ${w1.body.error}`);
    assert.ok(/ early costs .+\. Confirm to continue\.$/.test(w1.body.error), w1.body.error);
    assert.strictEqual((await dbPot(pot.id)).balance, 5_000);
    assert.strictEqual(await dbMovementByRef("kb_svw_fw1"), null, "nothing is written before the merchant confirms");
    assert.strictEqual(bookCalls.length, 0, "no fee is swept before the merchant confirms");

    // Other pots from earlier scenarios in this section still hold money, so the
    // reserve is the business total: assert the change, not an absolute figure.
    const reservedBefore = (
      await prisma.savingsPot.aggregate({ _sum: { balance: true }, where: { businessId: BIZ_ID, status: "active" } })
    )._sum.balance || 0;
    const w2 = await withdrawFrom(pot.id, { amount: 1_000, idempotencyKey: "fw1", confirmEarly: true });
    assert.strictEqual(w2.status, 200, JSON.stringify(w2.body));
    assert.strictEqual(w2.body.replay, false);
    assert.strictEqual(w2.body.movement.type, "withdrawal");
    assert.strictEqual(w2.body.movement.status, "completed");
    assert.strictEqual(w2.body.movement.fee, 100);
    assert.strictEqual(w2.body.pot.balance, 4_000, "the fee comes off the bank account, not the pot");
    assert.ok(sameKobo(w2.body.reserved, reservedBefore - 1_000), `reserved ${reservedBefore} → ${w2.body.reserved}`);
    // The fee is swept from the Anchor account to the fee account at once, and
    // booked as a savings_fee row.
    assert.strictEqual(bookCalls.length, 1, JSON.stringify(bookCalls));
    assert.strictEqual(bookCalls[0].fromAccountId, BIZ_ANCHOR_ID);
    assert.strictEqual(bookCalls[0].toAccountId, FEE_ACCOUNT);
    assert.strictEqual(bookCalls[0].amount, 100);
    assert.strictEqual(bookCalls[0].reference, "kb_svw_fw1_bfee");
    assert.strictEqual(bookCalls[0].reason, "Savings early withdrawal fee", "the transfer names no pot");
    assert.ok(sameKobo(anchorState.gross, grossBefore - 100), "only the fee left the bank");
    const feeRow = await dbTxnByRef("kb_svw_fw1_bfee");
    assert.ok(feeRow, "fee Transaction row");
    assert.strictEqual(feeRow.purpose, "savings_fee");
    assert.strictEqual(feeRow.description, "Savings early withdrawal fee · Ref: kb_svw_fw1_bfee", "the bank row names no pot: staff with bank access read it");
    assert.strictEqual(feeRow.type, "expense");
    assert.strictEqual(feeRow.category, "transfer");
    assert.strictEqual(feeRow.paymentMethod, "bank");
    assert.strictEqual(feeRow.source, "anchor");
    assert.strictEqual(feeRow.amount, 100);
    assert.strictEqual(feeRow.fee, 0);
    assert.strictEqual(feeRow.currency, "NGN");
    assert.strictEqual(feeRow.providerTxnId, "anc_bk_1", "Anchor's transfer id is kept");
    assert.ok((await dbMovementByRef("kb_svw_fw1")).feeCollectedAt, "fee claimed as collected");
    assert.strictEqual(await auditCount("SAVINGS_BREAK_FEE"), 1);
    assert.strictEqual(await prisma.transaction.count({ where: { businessId: BIZ_ID } }), 1, "the fee is the only bank row a pot ever writes");
    ctx.flexPot = pot;
  });

  await test("the fee row is real money for the ledger and a Bank Fees and Charges expense of ₦100", async () => {
    const charges = await bankCharges();
    assert.ok(sameKobo(charges, ctx.chargesBefore + 100), `Bank Fees and Charges moved from ${ctx.chargesBefore} to ${charges}`);
    const exp = await sumExpenses(BIZ_ID, wideRange());
    assert.ok(sameKobo(exp.total, ctx.expBefore.total + 100), `expenses moved from ${ctx.expBefore.total} to ${exp.total}`);
    assert.strictEqual(exp.count, ctx.expBefore.count + 1, "one more expense record: the fee");
    const ledger = await computeRawLedger(BIZ_ID, "NGN");
    assert.ok(sameKobo(ledger, ctx.ledgerBefore - 100), `ledger ${ctx.ledgerBefore} → ${ledger}`);
  });

  await test("a big early withdrawal pays 2% (₦2,000 on ₦100,000); an expired lock pays nothing and asks no confirmation", async () => {
    const pot = ctx.flexPot;
    assert.strictEqual((await depositTo(pot.id, { amount: 100_000, idempotencyKey: "f2" })).status, 200);
    const before = bookCalls.length;
    const grossBefore = anchorState.gross;
    const w = await withdrawFrom(pot.id, { amount: 100_000, idempotencyKey: "fw2", confirmEarly: true });
    assert.strictEqual(w.status, 200, JSON.stringify(w.body));
    assert.strictEqual(w.body.movement.fee, 2_000);
    assert.strictEqual(w.body.pot.balance, 4_000);
    assert.strictEqual(bookCalls.length, before + 1);
    assert.strictEqual(bookCalls[before].amount, 2_000);
    assert.strictEqual(bookCalls[before].reference, "kb_svw_fw2_bfee");
    assert.ok(sameKobo(anchorState.gross, grossBefore - 2_000));
    assert.strictEqual((await dbTxnByRef("kb_svw_fw2_bfee"))?.amount, 2_000);
    // Lock expired: no confirmation, no fee, no sweep.
    await prisma.savingsPot.update({ where: { id: pot.id }, data: { lockUntil: minutesAgo(5) } });
    const free = await withdrawFrom(pot.id, { amount: 1_000, idempotencyKey: "fw3" });
    assert.strictEqual(free.status, 200, JSON.stringify(free.body));
    assert.strictEqual(free.body.movement.fee, 0);
    assert.strictEqual(free.body.pot.locked, false);
    assert.strictEqual(free.body.pot.balance, 3_000);
    assert.strictEqual(bookCalls.length, before + 1, "no sweep for an on-time withdrawal");
    assert.strictEqual(await dbTxnByRef("kb_svw_fw3_bfee"), null);
    assert.strictEqual((await dbMovementByRef("kb_svw_fw3")).feeCollectedAt, null);
  });

  await test("a lock needs a mode, a mode needs a date, and the day must be real, after today and within 5 years", async () => {
    const cases = [
      ["no mode", { name: "X", lockUntil: daysFromNow(3).toISOString() }],
      ["mode without a date", { name: "X", lockMode: "strict" }],
      ["unknown mode", { name: "X", lockUntil: daysFromNow(3).toISOString(), lockMode: "forever" }],
      ["not a date", { name: "X", lockUntil: "next tuesday", lockMode: "strict" }],
      ["a day the calendar lacks", { name: "X", lockUntil: "2027-02-30", lockMode: "strict" }],
      ["past", { name: "X", lockUntil: daysFromNow(-3).toISOString(), lockMode: "flexible" }],
      ["today (Lagos)", { name: "X", lockUntil: lagosDayPlus(0), lockMode: "strict" }],
      ["yesterday (Lagos)", { name: "X", lockUntil: lagosDayPlus(-1), lockMode: "flexible" }],
      ["beyond 5 years", { name: "X", lockUntil: daysFromNow(5 * 366 + 2).toISOString(), lockMode: "strict" }],
    ];
    for (const [label, body] of cases) {
      const r = await mkPot(body);
      assert.strictEqual(r.status, 400, `${label}: ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body?.code, "BAD_LOCK", label);
    }
    assert.strictEqual(await prisma.savingsPot.count({ where: { name: "X" } }), 0);
    const modeOnly = await PATCH(`/savings/pots/${ctx.strictPot.id}`, tOwner, { businessId: BIZ_ID, pin: PIN_OWNER, lockMode: "flexible" });
    assert.strictEqual(modeOnly.status, 400, JSON.stringify(modeOnly.body));
    assert.strictEqual(modeOnly.body?.code, "BAD_LOCK");
    assert.strictEqual((await dbPot(ctx.strictPot.id)).lockMode, "strict");
  });

  await test("an EMPTY Breakable pot's day may move earlier, but its lock is never removed (a pot with money: section 4b)", async () => {
    const r = await mkPot({ name: "Soft", lockUntil: daysFromNow(30).toISOString(), lockMode: "flexible" });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    const pot = r.body.pot;
    const shorter = await PATCH(`/savings/pots/${pot.id}`, tOwner, { businessId: BIZ_ID, pin: PIN_OWNER, lockUntil: daysFromNow(5).toISOString() });
    assert.strictEqual(shorter.status, 200, JSON.stringify(shorter.body));
    assert.strictEqual(shorter.body.pot.lockMode, "flexible", "the mode carries over when only the date changes");
    assert.ok(new Date(shorter.body.pot.lockUntil) < daysFromNow(6));
    const removed = await PATCH(`/savings/pots/${pot.id}`, tOwner, { businessId: BIZ_ID, pin: PIN_OWNER, lockUntil: null });
    assert.strictEqual(removed.status, 400, JSON.stringify(removed.body));
    assert.strictEqual(removed.body?.code, "LOCK_REQUIRED");
    const row = await dbPot(pot.id);
    assert.strictEqual(row.lockMode, "flexible", "every pot stays Breakable or Unbreakable");
    assert.ok(new Date(row.lockUntil) < daysFromNow(6) && new Date(row.lockUntil) > new Date(), "the shorter day stands");
  });

  await test("with no fee account the break fee is ₦0: GET /savings shows all zeros, confirmation still asked, nothing swept", async () => {
    const pot = (await mkPot({ name: "Free break", lockUntil: daysFromNow(30).toISOString(), lockMode: "flexible" })).body.pot;
    assert.strictEqual((await depositTo(pot.id, { amount: 10_000, idempotencyKey: "nf1" })).status, 200);
    delete process.env.ANCHOR_FEE_ACCOUNT_ID;
    try {
      const cfg = await GET(`/savings?businessId=${BIZ_ID}`, tOwner);
      assert.deepStrictEqual(cfg.body.breakFee, { enabled: false, bps: 0, pct: 0, min: 0 }, "the app shows no rate and no minimum for a free withdrawal");
      const ask = await withdrawFrom(pot.id, { amount: 1_000, idempotencyKey: "nfw1" });
      assert.strictEqual(ask.status, 409, JSON.stringify(ask.body));
      assert.strictEqual(ask.body?.code, "EARLY_WITHDRAWAL_CONFIRM");
      assert.strictEqual(ask.body?.fee, 0, "a fee nothing can collect is not charged");
      assert.strictEqual(ask.body?.feeBps, 0);
      assert.ok(/Confirm to withdraw early\.$/.test(ask.body.error), ask.body.error);
      const before = bookCalls.length;
      const ok = await withdrawFrom(pot.id, { amount: 1_000, idempotencyKey: "nfw1", confirmEarly: true });
      assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
      assert.strictEqual(ok.body.movement.fee, 0);
      assert.strictEqual(ok.body.pot.balance, 9_000);
      assert.strictEqual(bookCalls.length, before, "nothing to sweep");
      assert.strictEqual((await dbMovementByRef("kb_svw_nfw1")).feeCollectedAt, null);
    } finally {
      process.env.ANCHOR_FEE_ACCOUNT_ID = FEE_ACCOUNT;
    }
    process.env.SAVINGS_BREAK_FEE_BPS = "0";
    try {
      const cfg = await GET(`/savings?businessId=${BIZ_ID}`, tOwner);
      assert.deepStrictEqual(cfg.body.breakFee, { enabled: false, bps: 0, pct: 0, min: 0 }, "a rate of 0 is no fee either");
    } finally {
      delete process.env.SAVINGS_BREAK_FEE_BPS;
    }
  });

  await test("a sweep the bank refuses: the withdrawal still succeeds, the fee is claimed once, alerted, and never retried", async () => {
    const pot = (await mkPot({ name: "Refused sweep", lockUntil: daysFromNow(30).toISOString(), lockMode: "flexible" })).body.pot;
    assert.strictEqual((await depositTo(pot.id, { amount: 10_000, idempotencyKey: "rs0" })).status, 200);
    const before = bookCalls.length;
    anchorState.bookMode = "reject";
    let w;
    try { w = await withdrawFrom(pot.id, { amount: 1_000, idempotencyKey: "rs1", confirmEarly: true }); }
    finally { anchorState.bookMode = "ok"; }
    assert.strictEqual(w.status, 200, JSON.stringify(w.body));
    assert.strictEqual(w.body.movement.fee, 100);
    assert.strictEqual(w.body.pot.balance, 9_000, "the merchant's withdrawal is never blocked by our fee");
    assert.strictEqual(bookCalls.length, before + 1, "the attempt itself is counted");
    assert.strictEqual(bookCalls[before].reference, "kb_svw_rs1_bfee");
    assert.strictEqual(await dbTxnByRef("kb_svw_rs1_bfee"), null, "no ledger row for money that did not move");
    const row = await dbMovementByRef("kb_svw_rs1");
    assert.ok(row.feeCollectedAt, "claimed before the transfer, so it can never be charged twice");
    const alert = await alertFired(`savings-break-fee-${row.id}`);
    assert.ok(alert, "a human is told to collect it by hand");
    assert.ok(alert.lastValue.startsWith("The bank refused the ₦100 early-withdrawal fee kb_svw_rs1_bfee (Ada Stores), so nothing moved."), alert.lastValue);
    assert.ok(/collect it by hand with that reference/.test(alert.lastValue), alert.lastValue);
    assert.strictEqual(await auditCount("SAVINGS_BREAK_FEE_FAILED"), 1);
    assert.strictEqual(await auditCount("SAVINGS_BREAK_FEE_UNCONFIRMED"), 0);
    const stats = await reconcileSavings();
    assert.strictEqual(stats.feesCollected, 0, JSON.stringify(stats));
    assert.strictEqual(stats.feesDeferred, 0, JSON.stringify(stats));
    assert.strictEqual(bookCalls.length, before + 1, "the loop does not retry a claimed fee");
  });

  await test("a pot opens at 00:00 Lagos on its day: a bare day as sent, a timestamp moved up to the next midnight", async () => {
    const day1 = lagosDayPlus(1);
    const r = await mkPot({ name: "Day pot", lockUntil: day1, lockMode: "flexible" });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    assert.strictEqual(r.body.pot.lockUntil, lagosMidnightIso(day1), "opens at the start of the chosen day, Lagos time");
    assert.strictEqual(r.body.pot.locked, true);
    assert.strictEqual((await dbPot(r.body.pot.id)).lockUntil.toISOString(), lagosMidnightIso(day1), "stored as that moment");
    // A timestamp mid-afternoon in three days opens at the start of the fourth.
    const t = await mkPot({ name: "Timestamp pot", lockUntil: `${lagosDayPlus(3)}T15:30:00.000+01:00`, lockMode: "strict" });
    assert.strictEqual(t.status, 201, JSON.stringify(t.body));
    assert.strictEqual(t.body.pot.lockUntil, lagosMidnightIso(lagosDayPlus(4)), "never earlier than asked");
    // The old app's "until 15 Mar" (23:59:59 that day) opens on 16 Mar.
    const old = await mkPot({ name: "Old app pot", lockUntil: new Date(`${lagosDayPlus(5)}T23:59:59.000+01:00`).toISOString(), lockMode: "flexible" });
    assert.strictEqual(old.body.pot.lockUntil, lagosMidnightIso(lagosDayPlus(6)));
    // PATCH takes a bare day the same way.
    const moved = await PATCH(`/savings/pots/${r.body.pot.id}`, tOwner, { businessId: BIZ_ID, pin: PIN_OWNER, lockUntil: lagosDayPlus(2) });
    assert.strictEqual(moved.status, 200, JSON.stringify(moved.body));
    assert.strictEqual(moved.body.pot.lockUntil, lagosMidnightIso(lagosDayPlus(2)));
    // GET /savings shows the same moment.
    const list = await GET(`/savings?businessId=${BIZ_ID}`, tOwner);
    assert.strictEqual(list.body.pots.find((p) => p.id === r.body.pot.id).lockUntil, lagosMidnightIso(lagosDayPlus(2)));
    for (const p of [r.body.pot, t.body.pot, old.body.pot]) assert.strictEqual((await closePot(p.id)).status, 204);
  });

  await test("an Unbreakable pot is refused until its very moment, however asked, and opens at it", async () => {
    const r = await mkPot({ name: "Timed", lockUntil: lagosDayPlus(1), lockMode: "strict" });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    const pot = r.body.pot;
    assert.strictEqual((await depositTo(pot.id, { amount: 2_000, idempotencyKey: "tm0" })).status, 200);
    // The API cannot set a pot's day this close; the moment is moved here, as
    // if the clock had run on to just before the pot's midnight.
    const opensAt = new Date(Date.now() + 3_000);
    await prisma.savingsPot.update({ where: { id: pot.id }, data: { lockUntil: opensAt } });
    const books = bookCalls.length;
    for (const [key, confirmEarly] of [["tm1", true], ["tm2", false]]) {
      const w = await withdrawFrom(pot.id, { amount: 500, idempotencyKey: key, confirmEarly });
      assert.strictEqual(w.status, 423, `${key}: ${JSON.stringify(w.body)}`);
      assert.strictEqual(w.body?.code, "POT_LOCKED");
      assert.strictEqual(w.body?.lockUntil, opensAt.toISOString());
    }
    // Neither removing the lock nor relaxing it opens it either.
    assert.strictEqual((await PATCH(`/savings/pots/${pot.id}`, tOwner, { businessId: BIZ_ID, pin: PIN_OWNER, lockUntil: null })).body?.code, "LOCK_CANNOT_SHORTEN");
    assert.strictEqual((await dbPot(pot.id)).balance, 2_000);
    assert.strictEqual(await prisma.savingsMovement.count({ where: { potId: pot.id, type: "withdrawal" } }), 0);
    const wait = opensAt.getTime() - Date.now();
    assert.ok(wait > 0, `the refusals must land before the moment (${wait} ms left)`);
    await sleep(wait + 50);
    const open = await withdrawFrom(pot.id, { amount: 500, idempotencyKey: "tm3" });
    assert.strictEqual(open.status, 200, JSON.stringify(open.body));
    assert.strictEqual(open.body.movement.fee, 0, "an opened pot costs nothing to empty");
    assert.strictEqual(open.body.pot.locked, false);
    assert.strictEqual(open.body.pot.balance, 1_500);
    assert.strictEqual(bookCalls.length, books, "no sweep");
    ctx.timedPot = pot;
  });

  await test("a KashBook admin is just another user to a pot: no route opens, relaxes or empties it", async () => {
    const pot = ctx.strictPot;
    const { token: tAdmin } = await mkUser("sav_admin", { role: "ADMIN" });
    const calls = [
      await POST(`/savings/pots/${pot.id}/withdraw`, tAdmin, { businessId: BIZ_ID, amount: 1_000, pin: PIN_OWNER, confirmEarly: true }),
      await PATCH(`/savings/pots/${pot.id}`, tAdmin, { businessId: BIZ_ID, lockUntil: null }),
      await PATCH(`/savings/pots/${pot.id}`, tAdmin, { businessId: BIZ_ID, lockUntil: lagosDayPlus(1), lockMode: "flexible" }),
      // The admin's own correct PIN changes nothing: the pot is not theirs.
      await PATCH(`/savings/pots/${pot.id}`, tAdmin, { businessId: BIZ_ID, pin: PIN_OWNER, lockUntil: null }),
      await DEL(`/savings/pots/${pot.id}?businessId=${BIZ_ID}`, tAdmin),
      await GET(`/savings?businessId=${BIZ_ID}`, tAdmin),
    ];
    for (const r of calls) assert.ok([403, 404].includes(r.status), `expected 403/404, got ${r.status} ${JSON.stringify(r.body)}`);
    const row = await dbPot(pot.id);
    assert.strictEqual(row.balance, 10_000);
    assert.strictEqual(row.lockMode, "strict");
    assert.ok(new Date(row.lockUntil) > daysFromNow(59));
  });

  // ══ 4b. LOCK EDITS ════════════════════════════════════════════════════════
  // Taking money out of a Breakable pot before its day costs the fee, so its
  // lock is no way round it: while it holds money and has not opened, its day
  // stays or moves later. And a lock commits money (an Unbreakable one for up
  // to five years, with no way back), so changing one needs the PIN.
  section("4b. lock edits: a Breakable pot with money keeps its day; a lock change needs the PIN");
  await seed();

  await test("a Breakable pot with money cannot drop its lock or move it earlier, however asked: 409 BREAKABLE_LOCK_KEPT, nothing changes", async () => {
    const day = lagosDayPlus(60);
    const pot = (await mkPot({ name: "Holiday", lockUntil: day, lockMode: "flexible" })).body.pot;
    assert.ok(pot?.id, "fixture");
    assert.strictEqual((await depositTo(pot.id, { amount: 10_000, idempotencyKey: "kp0" })).status, 200);
    const tries = [
      ["removed (null)", { lockUntil: null }],
      ['removed ("")', { lockUntil: "" }],
      ["removed (0)", { lockUntil: 0 }],
      ["removed (false)", { lockUntil: false }],
      ["moved to tomorrow", { lockUntil: lagosDayPlus(1) }],
      ["moved earlier, as a timestamp", { lockUntil: daysFromNow(10).toISOString(), lockMode: "flexible" }],
      ["made Unbreakable on an earlier day", { lockUntil: lagosDayPlus(1), lockMode: "strict" }],
    ];
    let last;
    for (const [label, change] of tries) {
      last = await PATCH(`/savings/pots/${pot.id}`, tOwner, { businessId: BIZ_ID, pin: PIN_OWNER, ...change });
      assert.strictEqual(last.status, 409, `${label}: ${JSON.stringify(last.body)}`);
      assert.strictEqual(last.body?.code, "BREAKABLE_LOCK_KEPT", label);
      assert.strictEqual(last.body?.lockUntil, lagosMidnightIso(day), `${label}: the refusal carries the day`);
    }
    assert.strictEqual(last.body.error, `This pot holds money and opens on ${inWords(day)}. Until then its day can move later but not earlier. To take money out sooner, take it out early and pay the early withdrawal fee.`);
    const row = await dbPot(pot.id);
    assert.strictEqual(row.lockUntil.toISOString(), lagosMidnightIso(day), "the lock is as it was");
    assert.strictEqual(row.lockMode, "flexible");
    // The way out before the day is still the priced one.
    const ask = await withdrawFrom(pot.id, { amount: 10_000, idempotencyKey: "kp1" });
    assert.strictEqual(ask.status, 409, JSON.stringify(ask.body));
    assert.strictEqual(ask.body?.code, "EARLY_WITHDRAWAL_CONFIRM");
    assert.strictEqual(ask.body?.fee, 200, "2% of ₦10,000");
    assert.strictEqual(bookCalls.length, 0);
    ctx.keptPot = pot;
  });

  await test("its day can move later, and it can become Unbreakable on its own day or a later one", async () => {
    const pot = ctx.keptPot;
    const later = await PATCH(`/savings/pots/${pot.id}`, tOwner, { businessId: BIZ_ID, pin: PIN_OWNER, lockUntil: lagosDayPlus(90) });
    assert.strictEqual(later.status, 200, JSON.stringify(later.body));
    assert.strictEqual(later.body.pot.lockUntil, lagosMidnightIso(lagosDayPlus(90)));
    assert.strictEqual(later.body.pot.lockMode, "flexible");
    const strict = await PATCH(`/savings/pots/${pot.id}`, tOwner, { businessId: BIZ_ID, pin: PIN_OWNER, lockUntil: lagosDayPlus(90), lockMode: "strict" });
    assert.strictEqual(strict.status, 200, JSON.stringify(strict.body));
    assert.strictEqual(strict.body.pot.lockMode, "strict");
    assert.strictEqual(strict.body.pot.lockUntil, lagosMidnightIso(lagosDayPlus(90)));
    const w = await withdrawFrom(pot.id, { amount: 1_000, idempotencyKey: "kp2", confirmEarly: true });
    assert.strictEqual(w.status, 423, "Unbreakable now: nothing opens it early");
  });

  await test("an opened or emptied Breakable pot keeps its kind (the lock never goes) but may be locked again", async () => {
    const opened = (await mkPot({ name: "Opened", lockUntil: lagosDayPlus(30), lockMode: "flexible" })).body.pot;
    assert.strictEqual((await depositTo(opened.id, { amount: 5_000, idempotencyKey: "op0" })).status, 200);
    await prisma.savingsPot.update({ where: { id: opened.id }, data: { lockUntil: minutesAgo(1) } });
    const off = await PATCH(`/savings/pots/${opened.id}`, tOwner, { businessId: BIZ_ID, pin: PIN_OWNER, lockUntil: null });
    assert.strictEqual(off.status, 400, JSON.stringify(off.body));
    assert.strictEqual(off.body?.code, "LOCK_REQUIRED");
    assert.strictEqual((await dbPot(opened.id)).lockMode, "flexible");
    const again = await PATCH(`/savings/pots/${opened.id}`, tOwner, { businessId: BIZ_ID, pin: PIN_OWNER, lockUntil: lagosDayPlus(40), lockMode: "strict" });
    assert.strictEqual(again.status, 200, JSON.stringify(again.body));
    assert.strictEqual(again.body.pot.locked, true, "an opened pot may be locked again");
    assert.strictEqual(again.body.pot.lockMode, "strict");
    const emptied = (await mkPot({ name: "Emptied", lockUntil: lagosDayPlus(30), lockMode: "flexible" })).body.pot;
    assert.strictEqual((await depositTo(emptied.id, { amount: 5_000, idempotencyKey: "em0" })).status, 200);
    const out = await withdrawFrom(emptied.id, { amount: 5_000, idempotencyKey: "em1", confirmEarly: true });
    assert.strictEqual(out.status, 200, JSON.stringify(out.body));
    assert.strictEqual(out.body.movement.fee, 100, "the fee was paid on the way out");
    const free = await PATCH(`/savings/pots/${emptied.id}`, tOwner, { businessId: BIZ_ID, pin: PIN_OWNER, lockUntil: null });
    assert.strictEqual(free.status, 400, JSON.stringify(free.body));
    assert.strictEqual(free.body?.code, "LOCK_REQUIRED");
    assert.strictEqual((await dbPot(emptied.id)).lockMode, "flexible");
  });

  await test("a lock change needs the owner's PIN: none → 400, wrong → 401 PIN_WRONG, each audited, the pot unchanged; a rename needs none", async () => {
    const day = lagosDayPlus(20);
    const pot = (await mkPot({ name: "Rent", lockUntil: day, lockMode: "flexible" })).body.pot;
    assert.strictEqual((await depositTo(pot.id, { amount: 10_000, idempotencyKey: "pn0" })).status, 200);
    const fails = await auditCount("PIN_FAILED");
    const far = lagosDayPlus(5 * 365);
    const attempts = [
      ["Unbreakable for five years, no PIN", { lockUntil: far, lockMode: "strict" }, 400],
      ["Unbreakable for five years, a wrong PIN", { lockUntil: far, lockMode: "strict", pin: "0000" }, 401],
      ["a later day alone, no PIN", { lockUntil: far }, 400],
      ["a mode alone, no PIN", { lockMode: "strict" }, 400],
    ];
    for (const [label, change, status] of attempts) {
      const r = await PATCH(`/savings/pots/${pot.id}`, tOwner, { businessId: BIZ_ID, ...change });
      assert.strictEqual(r.status, status, `${label}: ${JSON.stringify(r.body)}`);
      if (status === 401) assert.strictEqual(r.body?.code, "PIN_WRONG", label);
    }
    assert.strictEqual(await auditCount("PIN_FAILED"), fails + attempts.length, "every refused PIN is audited");
    const row = await dbPot(pot.id);
    assert.strictEqual(row.lockMode, "flexible", "nothing changed");
    assert.strictEqual(row.lockUntil.toISOString(), lagosMidnightIso(day));
    // A rename and a new target lock nothing: no PIN.
    const rename = await PATCH(`/savings/pots/${pot.id}`, tOwner, { businessId: BIZ_ID, name: "Rent 2027", targetAmount: 500_000 });
    assert.strictEqual(rename.status, 200, JSON.stringify(rename.body));
    assert.strictEqual(rename.body.pot.name, "Rent 2027");
    assert.strictEqual(rename.body.pot.lockMode, "flexible");
    // With the PIN the same change goes through.
    const ok = await PATCH(`/savings/pots/${pot.id}`, tOwner, { businessId: BIZ_ID, pin: PIN_OWNER, lockUntil: far, lockMode: "strict" });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    assert.strictEqual(ok.body.pot.lockMode, "strict");
  });

  await test("the audit rows keep the whole lock (before and after) and only the fields read: junk keys never reach the log", async () => {
    const day = lagosDayPlus(10);
    const pot = (await mkPot({ name: "Audit me", lockUntil: day, lockMode: "flexible" })).body.pot;
    const created = await prisma.auditLog.findFirst({ where: { action: "SAVINGS_POT_CREATED", resourceId: pot.id } });
    assert.deepStrictEqual(created.metadata, { lockMode: "flexible", lockUntil: lagosMidnightIso(day) });
    const junk = Object.fromEntries(Array.from({ length: 2_000 }, (_, i) => [`junk${i}`, i]));
    const r = await PATCH(`/savings/pots/${pot.id}`, tOwner, { ...junk, businessId: BIZ_ID, pin: PIN_OWNER, name: "Audited", lockUntil: lagosDayPlus(40), lockMode: "strict" });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const latest = () => prisma.auditLog.findFirst({ where: { action: "SAVINGS_POT_UPDATED", resourceId: pot.id }, orderBy: { createdAt: "desc" } });
    const row = await latest();
    assert.deepStrictEqual(row.metadata, {
      fields: ["name", "lockUntil", "lockMode"],
      before: { lockUntil: lagosMidnightIso(day), lockMode: "flexible" },
      after: { lockUntil: lagosMidnightIso(lagosDayPlus(40)), lockMode: "strict" },
    });
    assert.strictEqual(row.severity, "warn", "an Unbreakable lock is audited at warn");
    const onlyJunk = await PATCH(`/savings/pots/${pot.id}`, tOwner, { ...junk, businessId: BIZ_ID });
    assert.strictEqual(onlyJunk.status, 200, JSON.stringify(onlyJunk.body));
    const row2 = await latest();
    assert.notStrictEqual(row2.id, row.id);
    assert.deepStrictEqual(row2.metadata, { fields: [] });
    assert.strictEqual(row2.severity, "info");
  });

  // ══ 4c. A FEE SWEEP THAT FAILS ════════════════════════════════════════════
  // The bank refused it (nothing moved: section 4), the answer was lost after
  // the money moved, or the money moved and its row would not write: three
  // different truths, three different alerts, and the books follow the bank.
  section("4c. a fee sweep that fails tells a human what is true; the fee's bank row names no pot");
  await seed();
  const wedding = (await mkPot({ name: "Secret Wedding Fund", lockUntil: lagosDayPlus(30), lockMode: "flexible" })).body.pot;
  assert.strictEqual((await depositTo(wedding.id, { amount: 100_000, idempotencyKey: "wd0" })).status, 200, "fixture deposit");

  for (const [mode, key] of [["moved-then-502", "wd1"], ["moved-then-network", "wd2"]]) {
    await test(`the fee moved but the answer was lost (${mode}): booked anyway, claimed once, and a human told to check the bank first`, async () => {
      const ledgerBefore = await computeRawLedger(BIZ_ID, "NGN");
      const grossBefore = anchorState.gross;
      const callsBefore = bookCalls.length;
      anchorState.bookMode = mode;
      let w;
      try { w = await withdrawFrom(wedding.id, { amount: 1_000, idempotencyKey: key, confirmEarly: true }); }
      finally { anchorState.bookMode = "ok"; }
      assert.strictEqual(w.status, 200, JSON.stringify(w.body));
      assert.strictEqual(w.body.movement.fee, 100);
      assert.strictEqual(bookCalls.length, callsBefore + 1, "one attempt");
      assert.ok(sameKobo(anchorState.gross, grossBefore - 100), "the bank moved the fee");
      const feeRow = await dbTxnByRef(`kb_svw_${key}_bfee`);
      assert.ok(feeRow, "the fee is booked: the safe side");
      assert.strictEqual(feeRow.purpose, "savings_fee");
      assert.strictEqual(feeRow.amount, 100);
      assert.strictEqual(feeRow.providerTxnId, null, "no transfer id came back");
      assert.ok(sameKobo(await computeRawLedger(BIZ_ID, "NGN"), ledgerBefore - 100), "the books moved with the bank");
      const mv = await dbMovementByRef(`kb_svw_${key}`);
      assert.ok(mv.feeCollectedAt, "claimed: never swept twice");
      const alert = await alertFired(`savings-break-fee-${mv.id}`);
      assert.ok(alert, "a human is alerted");
      assert.ok(alert.lastValue.startsWith(`The ₦100 early-withdrawal fee kb_svw_${key}_bfee (Ada Stores) may have moved. Check Anchor for that reference before collecting anything.`), alert.lastValue);
      assert.ok(!/refused|could not be swept/.test(alert.lastValue), "never the alert for money that did not move");
      const a = await prisma.auditLog.findFirst({ where: { action: "SAVINGS_BREAK_FEE_UNCONFIRMED", resourceId: mv.id } });
      assert.ok(a, "audited");
      assert.strictEqual(a.severity, "alert");
      assert.strictEqual(a.metadata.booked, true);
      assert.strictEqual(await prisma.auditLog.count({ where: { action: { in: ["SAVINGS_BREAK_FEE_FAILED", "SAVINGS_BREAK_FEE"] }, resourceId: mv.id } }), 0);
      const t = await reconcileSavings();
      assert.strictEqual(t.feesCollected, 0, JSON.stringify(t));
      assert.strictEqual(bookCalls.length, callsBefore + 1, "the loop never re-sends a claimed fee");
    });
  }

  await test("the fee was swept but its row would not write (twice): the alert says never to collect it again", async () => {
    const realCreate = prisma.transaction.create;
    let failures = 0;
    prisma.transaction.create = async (args) => {
      if (String(args?.data?.reference || "").endsWith("_bfee")) { failures++; throw new Error("database went away (injected)"); }
      return realCreate.call(prisma.transaction, args);
    };
    const callsBefore = bookCalls.length;
    const grossBefore = anchorState.gross;
    let w;
    try { w = await withdrawFrom(wedding.id, { amount: 1_000, idempotencyKey: "wd3", confirmEarly: true }); }
    finally { prisma.transaction.create = realCreate; }
    assert.strictEqual(w.status, 200, JSON.stringify(w.body));
    assert.strictEqual(failures, 2, "the row write is tried twice");
    assert.strictEqual(bookCalls.length, callsBefore + 1);
    assert.ok(sameKobo(anchorState.gross, grossBefore - 100), "the fee moved");
    assert.strictEqual(await dbTxnByRef("kb_svw_wd3_bfee"), null, "its row is missing");
    const mv = await dbMovementByRef("kb_svw_wd3");
    assert.ok(mv.feeCollectedAt, "claimed");
    const alert = await alertFired(`savings-break-fee-${mv.id}`);
    assert.ok(alert.lastValue.startsWith(`The ₦100 early-withdrawal fee kb_svw_wd3_bfee (Ada Stores) WAS swept (Anchor transfer anc_bk_${callsBefore + 1}), but its ledger row could not be written.`), alert.lastValue);
    assert.ok(/Do not collect it again: add the savings_fee row\./.test(alert.lastValue), alert.lastValue);
    const a = await prisma.auditLog.findFirst({ where: { action: "SAVINGS_BREAK_FEE_BOOKKEEPING_FAILED", resourceId: mv.id } });
    assert.strictEqual(a?.metadata?.transferId, `anc_bk_${callsBefore + 1}`, JSON.stringify(a?.metadata));
    assert.strictEqual(await prisma.auditLog.count({ where: { action: "SAVINGS_BREAK_FEE", resourceId: mv.id } }), 0);
  });

  await test("a row write that fails once is written on the second try: one row, collected, no alert", async () => {
    const realCreate = prisma.transaction.create;
    let failures = 0;
    prisma.transaction.create = async (args) => {
      if (String(args?.data?.reference || "").endsWith("_bfee") && failures === 0) { failures++; throw new Error("connection reset (injected)"); }
      return realCreate.call(prisma.transaction, args);
    };
    let w;
    try { w = await withdrawFrom(wedding.id, { amount: 1_000, idempotencyKey: "wd4", confirmEarly: true }); }
    finally { prisma.transaction.create = realCreate; }
    assert.strictEqual(w.status, 200, JSON.stringify(w.body));
    assert.strictEqual(failures, 1);
    assert.strictEqual(await prisma.transaction.count({ where: { businessId: BIZ_ID, reference: "kb_svw_wd4_bfee" } }), 1);
    const mv = await dbMovementByRef("kb_svw_wd4");
    assert.strictEqual(await prisma.auditLog.count({ where: { action: "SAVINGS_BREAK_FEE", resourceId: mv.id } }), 1);
    assert.strictEqual(await alertFired(`savings-break-fee-${mv.id}`), null);
  });

  await test("no fee row names the pot, and staff with every permission find no pot name in what /sync sends them", async () => {
    const rows = await prisma.transaction.findMany({ where: { businessId: BIZ_ID, purpose: "savings_fee" }, select: { description: true, reference: true } });
    assert.ok(rows.length >= 3, `fixture: fee rows ${rows.length}`);
    for (const r of rows) assert.strictEqual(r.description, `Savings early withdrawal fee · Ref: ${r.reference}`);
    for (const c of bookCalls.filter((b) => b.reference?.endsWith("_bfee"))) assert.ok(!/Wedding/.test(c.reason), c.reason);
    const s = await GET(`/sync?businessId=${BIZ_ID}`, tStaff);
    assert.strictEqual(s.status, 200, s.raw.slice(0, 300));
    assert.ok(/kb_svw_wd4_bfee/.test(s.raw), "the fee rows are in what staff are sent (the check is not blind)");
    assert.ok(!/Secret Wedding Fund/.test(s.raw), "the pot's name never reaches staff");
    assert.strictEqual((await GET(`/savings?businessId=${BIZ_ID}`, tStaff)).status, 403);
  });

  // ══ 5. RECONCILE ══════════════════════════════════════════════════════════
  section("5. reconcile — fees swept once, drift and over-reserve alarmed");
  await seed();
  const guard = (await mkPot({ name: "Guarded", lockUntil: daysFromNow(30).toISOString(), lockMode: "flexible" })).body.pot;
  assert.strictEqual((await depositTo(guard.id, { amount: 10_000, idempotencyKey: "r1" })).status, 200, "fixture deposit");

  await test("an early-withdrawal fee a crash left uncollected is swept once, and only once, across two ticks", async () => {
    const w = await withdrawFrom(guard.id, { amount: 1_000, idempotencyKey: "rw1", confirmEarly: true });
    assert.strictEqual(w.status, 200, JSON.stringify(w.body));
    assert.strictEqual(w.body.movement.fee, 100);
    assert.strictEqual(bookCalls.length, 1);
    // Simulate the crash: the withdrawal committed, the sweep never ran.
    await prisma.transaction.deleteMany({ where: { businessId: BIZ_ID, reference: "kb_svw_rw1_bfee" } });
    await prisma.savingsMovement.update({ where: { id: w.body.movement.id }, data: { feeCollectedAt: null } });
    bookCalls.length = 0;
    anchorState.gross += 100; // that transfer never happened

    const t1 = await reconcileSavings();
    assert.strictEqual(t1.feesCollected, 1, JSON.stringify(t1));
    assert.strictEqual(t1.feesDeferred, 0);
    assert.strictEqual(t1.errors, 0);
    assert.strictEqual(bookCalls.length, 1);
    assert.strictEqual(bookCalls[0].reference, "kb_svw_rw1_bfee");
    assert.strictEqual(bookCalls[0].amount, 100);
    assert.strictEqual(bookCalls[0].toAccountId, FEE_ACCOUNT);
    const feeRow = await dbTxnByRef("kb_svw_rw1_bfee");
    assert.ok(feeRow, "the ledger row is written by the loop too");
    assert.strictEqual(feeRow.purpose, "savings_fee");
    assert.ok((await dbMovement(w.body.movement.id)).feeCollectedAt);

    const t2 = await reconcileSavings();
    assert.strictEqual(t2.feesCollected, 0, JSON.stringify(t2));
    assert.strictEqual(bookCalls.length, 1, "one sweep, ever");
    assert.strictEqual(await prisma.transaction.count({ where: { businessId: BIZ_ID, reference: "kb_svw_rw1_bfee" } }), 1);
    assert.strictEqual(t1.drift, 0);
    assert.strictEqual(t1.overReserved, 0);
  });

  await test("a pot whose balance was edited away from its movements fires savings-ledger-drift", async () => {
    await prisma.savingsPot.update({ where: { id: guard.id }, data: { balance: 9_001 } });
    try {
      const stats = await reconcileSavings();
      assert.strictEqual(stats.drift, 1, JSON.stringify(stats));
      assert.ok(await alertFired(`savings-ledger-drift-${guard.id}`), "alert must fire");
    } finally {
      await prisma.savingsPot.update({ where: { id: guard.id }, data: { balance: 9_000 } });
    }
    const after = await reconcileSavings();
    assert.strictEqual(after.drift, 0, "restored, the pot is quiet again");
  });

  await test("reserved above the bank balance fires savings-overreserved and is audited", async () => {
    const before = anchorState.gross;
    anchorState.gross = 100;
    try {
      const stats = await reconcileSavings();
      assert.strictEqual(stats.overReserved, 1, JSON.stringify(stats));
      assert.ok(await alertFired(`savings-overreserved-${BIZ_ID}`), "alert must fire");
      assert.strictEqual(await auditCount("SAVINGS_OVERRESERVED"), 1);
    } finally {
      anchorState.gross = before;
    }
    const quiet = await reconcileSavings();
    assert.deepStrictEqual(quiet, { feesCollected: 0, feesDeferred: 0, drift: 0, overReserved: 0, errors: 0 });
  });

  // ══ 5b. A FEE THAT MUST WAIT ══════════════════════════════════════════════
  section("5b. a break fee never comes out of another pot: it waits for money");
  await seed({ gross: 20_000 });
  const vault = (await mkPot({ name: "Vault", lockUntil: lagosDayPlus(30), lockMode: "strict" })).body.pot;
  const trip = (await mkPot({ name: "Trip", lockUntil: lagosDayPlus(30), lockMode: "flexible" })).body.pot;
  assert.strictEqual((await depositTo(vault.id, { amount: 15_000, idempotencyKey: "v1" })).status, 200, "fixture deposit");
  assert.strictEqual((await depositTo(trip.id, { amount: 5_000, idempotencyKey: "t1" })).status, 200, "fixture deposit");

  await test("short of spendable money, the fee is deferred: the withdrawal succeeds, nothing is claimed or swept", async () => {
    // Every naira is in a pot, then ₦1,000 leaves by a path the reserve does
    // not gate (a bank charge, a legal debit): the bank now holds less than
    // the pots promise.
    anchorState.gross = 19_000;
    const w = await withdrawFrom(trip.id, { amount: 1_000, idempotencyKey: "tw1", confirmEarly: true });
    assert.strictEqual(w.status, 200, JSON.stringify(w.body));
    assert.strictEqual(w.body.movement.fee, 100, "the fee is owed");
    assert.strictEqual(w.body.pot.balance, 4_000);
    // Spendable after the withdrawal: 19,000 − (15,000 + 4,000) = 0. Sweeping
    // the ₦100 now would take it from the money set aside in "Vault".
    assert.strictEqual(bookCalls.length, 0, "no sweep");
    const row = await dbMovementByRef("kb_svw_tw1");
    assert.strictEqual(row.feeCollectedAt, null, "not claimed: it is still to collect");
    assert.strictEqual(await dbTxnByRef("kb_svw_tw1_bfee"), null, "no fee row for money that did not move");
    assert.strictEqual(anchorState.gross, 19_000);
    assert.strictEqual((await dbPot(vault.id)).balance, 15_000, "the other pot is whole");
    ctx.waitingFee = row;
  });

  await test("the loop defers it while short, alerts once a day after a day of waiting, and never sweeps it into another pot's money", async () => {
    const t1 = await reconcileSavings();
    assert.strictEqual(t1.feesDeferred, 1, JSON.stringify(t1));
    assert.strictEqual(t1.feesCollected, 0);
    assert.strictEqual(t1.errors, 0);
    assert.strictEqual(t1.overReserved, 0, "19,000 set aside, 19,000 at the bank: not over");
    const key = `savings-break-fee-waiting-${ctx.waitingFee.id}`;
    assert.strictEqual(await alertFired(key), null, "no alert in the first day");
    // A day and an hour later.
    const old = new Date(Date.now() - 25 * 3600 * 1000);
    await prisma.savingsMovement.update({ where: { id: ctx.waitingFee.id }, data: { createdAt: old, completedAt: old } });
    const t2 = await reconcileSavings();
    assert.strictEqual(t2.feesDeferred, 1, JSON.stringify(t2));
    const first = await alertFired(key);
    assert.ok(first, "a fee waiting over a day pages a human");
    const t3 = await reconcileSavings();
    assert.strictEqual(t3.feesDeferred, 1, JSON.stringify(t3));
    assert.strictEqual((await alertFired(key)).lastFiredAt.getTime(), first.lastFiredAt.getTime(), "not every tick");
    // Two hours on, the alert engine's own cooldown (an hour) has passed but
    // the day has not: still quiet.
    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000);
    await prisma.alertState.update({ where: { key }, data: { lastFiredAt: twoHoursAgo } });
    assert.strictEqual((await reconcileSavings()).feesDeferred, 1);
    assert.strictEqual((await alertFired(key)).lastFiredAt.getTime(), twoHoursAgo.getTime(), "once a day, not once an hour");
    // A day on, while it still waits, it pages again.
    const dayAgo = new Date(Date.now() - 25 * 3600 * 1000);
    await prisma.alertState.update({ where: { key }, data: { lastFiredAt: dayAgo } });
    assert.strictEqual((await reconcileSavings()).feesDeferred, 1);
    assert.ok((await alertFired(key)).lastFiredAt > dayAgo, "and again the next day");
    assert.strictEqual(bookCalls.length, 0, "still no sweep");
  });

  await test("once money arrives the loop sweeps it, once", async () => {
    anchorState.gross += 5_000; // a customer pays in
    const t1 = await reconcileSavings();
    assert.strictEqual(t1.feesCollected, 1, JSON.stringify(t1));
    assert.strictEqual(t1.feesDeferred, 0);
    assert.strictEqual(bookCalls.length, 1);
    assert.strictEqual(bookCalls[0].reference, "kb_svw_tw1_bfee");
    assert.strictEqual(bookCalls[0].amount, 100);
    assert.strictEqual(bookCalls[0].toAccountId, FEE_ACCOUNT);
    assert.ok((await dbMovementByRef("kb_svw_tw1")).feeCollectedAt);
    const feeRow = await dbTxnByRef("kb_svw_tw1_bfee");
    assert.strictEqual(feeRow?.purpose, "savings_fee");
    assert.strictEqual(feeRow?.amount, 100);
    assert.strictEqual(anchorState.gross, 23_900);
    assert.ok(anchorState.gross >= 19_000, "the pots are still covered");
    const t2 = await reconcileSavings();
    assert.deepStrictEqual(t2, { feesCollected: 0, feesDeferred: 0, drift: 0, overReserved: 0, errors: 0 });
    assert.strictEqual(bookCalls.length, 1, "one sweep, ever");
  });

  // ══ 5c. THE QUEUE TURNS ═══════════════════════════════════════════════════
  section("5c. fees that cannot be swept go to the back: no business holds up another");
  await seed();

  await test("50 old fees that cannot be swept never keep a newer fee of another business out: one bank read each a tick, swept on the second", async () => {
    // The main business owes 50 old fees and its bank holds nothing, so every
    // one of them waits. They hang off a closed pot, which the drift check
    // passes by.
    anchorState.grossBy[BIZ_ANCHOR_ID] = 0;
    const dead = (await mkPot({ name: "Old pot" })).body.pot;
    assert.strictEqual((await closePot(dead.id)).status, 204);
    const old = new Date(Date.now() - 3600_000);
    await prisma.savingsMovement.createMany({
      data: Array.from({ length: 50 }, (_, i) => ({
        potId: dead.id, businessId: BIZ_ID, userId: owner.id, type: "withdrawal", amount: 1, fee: 1,
        status: "completed", reference: `kb_svw_stuck${i}`, createdAt: old, completedAt: old, updatedAt: old,
      })),
    });
    // Another business's newer fee, deferred while its bank could not be read.
    const shop = await mkBiz("sav_biz_q", "9990009996", "Queue Shop");
    anchorState.grossBy[shop.anchorAccountId] = 100_000;
    const potQ = (await mkPot({ name: "Q pot", businessId: shop.id, lockUntil: lagosDayPlus(30), lockMode: "flexible" })).body.pot;
    assert.strictEqual((await depositTo(potQ.id, { businessId: shop.id, amount: 10_000, idempotencyKey: "q0" })).status, 200);
    anchorState.unreadable.add(shop.anchorAccountId);
    let w;
    try { w = await withdrawFrom(potQ.id, { businessId: shop.id, amount: 1_000, idempotencyKey: "q1", confirmEarly: true }); }
    finally { anchorState.unreadable.delete(shop.anchorAccountId); }
    assert.strictEqual(w.status, 200, JSON.stringify(w.body));
    assert.strictEqual((await dbMovementByRef("kb_svw_q1")).feeCollectedAt, null, "the newer fee waits");
    const books = bookCalls.length;

    anchorState.reads = {};
    const t1 = await reconcileSavings();
    assert.deepStrictEqual([t1.feesCollected, t1.feesDeferred, t1.errors], [0, 50, 0], JSON.stringify(t1));
    assert.strictEqual(anchorState.reads[BIZ_ANCHOR_ID], 1, "one bank read for fifty fees of one business");
    assert.strictEqual((await dbMovementByRef("kb_svw_q1")).feeCollectedAt, null, "the 50 older fees fill the first tick");
    anchorState.reads = {};
    const t2 = await reconcileSavings();
    assert.strictEqual(t2.feesCollected, 1, `the newer fee is swept on the second tick: ${JSON.stringify(t2)}`);
    assert.strictEqual(t2.feesDeferred, 49);
    assert.strictEqual(anchorState.reads[BIZ_ANCHOR_ID], 1, "still one read");
    assert.strictEqual(bookCalls.length, books + 1);
    assert.strictEqual(bookCalls[books].reference, "kb_svw_q1_bfee");
    assert.strictEqual(bookCalls[books].fromAccountId, shop.anchorAccountId);
    assert.ok((await dbMovementByRef("kb_svw_q1")).feeCollectedAt);
    // The 50 still wait, unclaimed, and keep taking their turn.
    assert.strictEqual(await prisma.savingsMovement.count({ where: { businessId: BIZ_ID, fee: { gt: 0 }, feeCollectedAt: null } }), 50);
    const t3 = await reconcileSavings();
    assert.deepStrictEqual([t3.feesCollected, t3.feesDeferred, t3.errors], [0, 50, 0], JSON.stringify(t3));
    assert.strictEqual(bookCalls.length, books + 1, "nothing swept from an empty account");
  });

  // ══ 6. FROZEN ═════════════════════════════════════════════════════════════
  section("6. frozen — no money moves in either direction");
  await seed();
  const fz = (await mkPot({ name: "Frozen test" })).body.pot;
  assert.strictEqual((await depositTo(fz.id, { amount: 5_000, idempotencyKey: "fz0" })).status, 200, "fixture deposit");

  await test("frozen BUSINESS → 423 FROZEN inside the lock on deposit and withdrawal", async () => {
    await prisma.business.update({ where: { id: BIZ_ID }, data: { accountStatus: "frozen" } });
    try {
      const d = await depositTo(fz.id, { amount: 1_000, idempotencyKey: "fz1" });
      assert.strictEqual(d.status, 423, JSON.stringify(d.body));
      assert.strictEqual(d.body?.code, "FROZEN");
      const w = await withdrawFrom(fz.id, { amount: 1_000, idempotencyKey: "fz2" });
      assert.strictEqual(w.status, 423, JSON.stringify(w.body));
      assert.strictEqual(w.body?.code, "FROZEN");
      assert.strictEqual((await dbPot(fz.id)).balance, 5_000);
      assert.strictEqual(await prisma.savingsMovement.count({ where: { reference: { in: ["kb_sv_fz1", "kb_svw_fz2"] } } }), 0);
    } finally {
      await prisma.business.update({ where: { id: BIZ_ID }, data: { accountStatus: "active" } });
    }
  });

  await test("frozen OWNER → 423 on every write (requireUnfrozen), reads still answer", async () => {
    await prisma.user.update({ where: { id: owner.id }, data: { accountStatus: "frozen" } });
    try {
      const c = await mkPot({ name: "Nope" });
      assert.strictEqual(c.status, 423, JSON.stringify(c.body));
      assert.strictEqual(c.body?.code, "FROZEN");
      const d = await depositTo(fz.id, { amount: 1_000, idempotencyKey: "fz3" });
      assert.strictEqual(d.status, 423);
      const w = await withdrawFrom(fz.id, { amount: 1_000, idempotencyKey: "fz4" });
      assert.strictEqual(w.status, 423);
      const p = await PATCH(`/savings/pots/${fz.id}`, tOwner, { businessId: BIZ_ID, name: "Renamed" });
      assert.strictEqual(p.status, 423);
      const x = await closePot(fz.id);
      assert.strictEqual(x.status, 423);
      const g = await GET(`/savings?businessId=${BIZ_ID}`, tOwner);
      assert.strictEqual(g.status, 200);
      assert.strictEqual(g.body.totals.reserved, 5_000);
      const m = await GET(`/savings/pots/${fz.id}/movements?businessId=${BIZ_ID}`, tOwner);
      assert.strictEqual(m.status, 200);
      const row = await dbPot(fz.id);
      assert.strictEqual(row.balance, 5_000);
      assert.strictEqual(row.name, "Frozen test");
      assert.strictEqual(row.status, "active");
    } finally {
      await prisma.user.update({ where: { id: owner.id }, data: { accountStatus: "active" } });
    }
  });

  await test("a fee still waiting when the owner or the business is frozen is never swept: it waits for the freeze to lift, then goes once", async () => {
    // A fee deferred while the bank could not be read.
    const pot = (await mkPot({ name: "Frozen fee", lockUntil: lagosDayPlus(30), lockMode: "flexible" })).body.pot;
    assert.strictEqual((await depositTo(pot.id, { amount: 10_000, idempotencyKey: "ff0" })).status, 200);
    anchorState.unreadable.add(BIZ_ANCHOR_ID);
    let w;
    try { w = await withdrawFrom(pot.id, { amount: 1_000, idempotencyKey: "ff1", confirmEarly: true }); }
    finally { anchorState.unreadable.delete(BIZ_ANCHOR_ID); }
    assert.strictEqual(w.status, 200, JSON.stringify(w.body));
    assert.strictEqual(w.body.movement.fee, 100);
    const id = w.body.movement.id;
    assert.strictEqual((await dbMovement(id)).feeCollectedAt, null, "deferred, not claimed");
    // Waiting over a day, so a sweep that defers for money would page a human.
    const dayAndHour = new Date(Date.now() - 25 * 3600 * 1000);
    await prisma.savingsMovement.update({ where: { id }, data: { createdAt: dayAndHour, completedAt: dayAndHour } });
    const books = bookCalls.length;
    const setOwner = (s) => prisma.user.update({ where: { id: owner.id }, data: { accountStatus: s } });
    const setBiz = (s) => prisma.business.update({ where: { id: BIZ_ID }, data: { accountStatus: s } });
    for (const [what, set] of [["owner", setOwner], ["business", setBiz]]) {
      await set("frozen");
      try {
        const t = await reconcileSavings();
        assert.strictEqual(t.feesCollected, 0, `${what}: ${JSON.stringify(t)}`);
        assert.strictEqual(t.feesDeferred, 0, `${what}: a frozen account's fee is not even looked at`);
        // A freeze landing between the loop's list and its lock: the sweep itself waits.
        const outcome = await prisma.withBusinessLock(BIZ_ID, () => savings.collectSavingsFee(id));
        assert.strictEqual(outcome, "deferred", what);
        assert.strictEqual(bookCalls.length, books, `${what}: nothing leaves a frozen account`);
        assert.strictEqual((await dbMovement(id)).feeCollectedAt, null, `${what}: nothing claimed`);
        assert.strictEqual(await dbTxnByRef("kb_svw_ff1_bfee"), null);
      } finally {
        await set("active");
      }
    }
    assert.strictEqual(await alertFired(`savings-break-fee-waiting-${id}`), null, "no fee-waiting alert: the freeze is already with a human");
    const t = await reconcileSavings();
    assert.strictEqual(t.feesCollected, 1, JSON.stringify(t));
    assert.strictEqual(bookCalls.length, books + 1);
    assert.strictEqual(bookCalls[books].reference, "kb_svw_ff1_bfee");
    assert.ok((await dbMovement(id)).feeCollectedAt);
    assert.strictEqual((await reconcileSavings()).feesCollected, 0, "once");
  });

  // ══ 7. DELETION ═══════════════════════════════════════════════════════════
  section("7. deleting a business or an account — never around a pot with money");
  await seed();

  await test("DELETE /businesses/:id of ANOTHER owner's business → 404, and not a word about its pots", async () => {
    const biz2 = await mkBiz("sav_biz2", "9990009998");
    const pot = (await mkPot({ name: "Van", businessId: biz2.id })).body.pot;
    assert.ok(pot?.id, "fixture: pot on the second business");
    assert.strictEqual((await depositTo(pot.id, { businessId: biz2.id, amount: 5_000, idempotencyKey: "b2d1" })).status, 200);
    const { user: other, token: tOther } = await mkUser("sav_other7");
    // Two businesses of their own, so "your only business" is not what answers.
    for (const id of ["sav_other7_a", "sav_other7_b"]) {
      await prisma.business.create({ data: { id, userId: other.id, name: id, country: "NG", baseCurrency: "NGN" } });
    }
    const r = await DEL(`/businesses/${biz2.id}`, tOther);
    assert.strictEqual(r.status, 404, JSON.stringify(r.body));
    assert.ok(!/Van/.test(r.raw), `the pot's name must not leave the server: ${r.raw}`);
    assert.ok(!("potName" in (r.body || {})) && r.body?.code !== "SAVINGS_REMAINING", JSON.stringify(r.body));
    assert.strictEqual((await DEL("/businesses/no-such-business", tOwner)).status, 404);
    assert.ok(await prisma.business.findUnique({ where: { id: biz2.id } }), "nothing was deleted");
    assert.strictEqual((await dbPot(pot.id)).balance, 5_000);
    ctx.vanPot = pot;
  });

  await test("DELETE /businesses/:id with a pot balance → 409 SAVINGS_REMAINING naming the pot; allowed once emptied and closed, pots cascade away", async () => {
    const pot = ctx.vanPot;
    const staffTry = await DEL("/businesses/sav_biz2", tStaff);
    assert.strictEqual(staffTry.status, 403);
    const r = await DEL("/businesses/sav_biz2", tOwner);
    assert.strictEqual(r.status, 409, JSON.stringify(r.body));
    assert.deepStrictEqual(Object.keys(r.body).sort(), REFUSAL_KEYS);
    assert.strictEqual(r.body.code, "SAVINGS_REMAINING");
    assert.strictEqual(r.body.potName, "Van");
    assert.strictEqual(r.body.opensOn, null, "an unlocked pot has no opening day");
    assert.strictEqual(r.body.unbreakable, false);
    assert.strictEqual(r.body.error, 'The savings pot "Van" still has money in it. Take it out and close the pot first, then delete this business.');
    assert.ok(await prisma.business.findUnique({ where: { id: "sav_biz2" } }), "nothing was deleted");
    assert.strictEqual((await dbPot(pot.id)).balance, 5_000);
    assert.strictEqual((await withdrawFrom(pot.id, { businessId: "sav_biz2", amount: 5_000, idempotencyKey: "b2w1" })).status, 200);
    assert.strictEqual((await closePot(pot.id, { businessId: "sav_biz2" })).status, 204);
    // The pots are empty; the bank-balance guard /auth/delete-account uses
    // answers next. Money in the account stops the delete, and so does a
    // bank that cannot be read (fail closed).
    const acct = "anchor-acct-sav_biz2";
    anchorState.grossBy[acct] = 5_000;
    const funded = await DEL("/businesses/sav_biz2", tOwner);
    assert.strictEqual(funded.status, 400, JSON.stringify(funded.body));
    assert.strictEqual(funded.body?.code, "BALANCE_REMAINING");
    assert.strictEqual(funded.body?.error, "Second Shop still has money in its bank account. Transfer it out first, then delete this business.");
    anchorState.unreadable.add(acct);
    let down;
    try { down = await DEL("/businesses/sav_biz2", tOwner); }
    finally { anchorState.unreadable.delete(acct); }
    assert.strictEqual(down.status, 503, JSON.stringify(down.body));
    assert.strictEqual(down.body?.code, "BALANCE_UNAVAILABLE");
    assert.ok(await prisma.business.findUnique({ where: { id: "sav_biz2" } }), "neither refusal deleted anything");
    assert.strictEqual(await auditCount("BUSINESS_DELETED"), 0);
    anchorState.grossBy[acct] = 0;
    const ok = await DEL("/businesses/sav_biz2", tOwner);
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    assert.strictEqual(await prisma.business.findUnique({ where: { id: "sav_biz2" } }), null);
    assert.strictEqual(await prisma.savingsPot.count({ where: { businessId: "sav_biz2" } }), 0, "pots go with the business");
    assert.strictEqual(await prisma.savingsMovement.count({ where: { businessId: "sav_biz2" } }), 0);
    assert.ok(await prisma.business.findUnique({ where: { id: BIZ_ID } }), "the other business is untouched");
    const a = await prisma.auditLog.findFirst({ where: { action: "BUSINESS_DELETED", resourceId: "sav_biz2" } });
    assert.ok(a, "a deletion is audited");
    assert.deepStrictEqual(a.metadata, { name: "Second Shop", banked: true });
  });

  await test("an Unbreakable pot refuses DELETE /businesses/:id with the day it opens: nobody, not even KashBook", async () => {
    const biz3 = await mkBiz("sav_biz3", "9990009997", "Third Shop");
    const day = lagosDayPlus(40);
    const pot = (await mkPot({ name: "School fees", businessId: biz3.id, lockUntil: day, lockMode: "strict" })).body.pot;
    assert.ok(pot?.id, "fixture: Unbreakable pot");
    assert.strictEqual((await depositTo(pot.id, { businessId: biz3.id, amount: 3_000, idempotencyKey: "b3d1" })).status, 200);
    const r = await DEL(`/businesses/${biz3.id}`, tOwner);
    assert.strictEqual(r.status, 409, JSON.stringify(r.body));
    assert.deepStrictEqual(Object.keys(r.body).sort(), REFUSAL_KEYS);
    assert.strictEqual(r.body.code, "SAVINGS_REMAINING");
    assert.strictEqual(r.body.potName, "School fees");
    assert.strictEqual(r.body.opensOn, day);
    assert.strictEqual(r.body.unbreakable, true);
    assert.strictEqual(r.body.error, `The savings pot "School fees" is unbreakable and opens on ${inWords(day)}. Nobody, not even KashBook, can take the money out before then. After that, take it out and close the pot, then delete this business.`);
    const out = await withdrawFrom(pot.id, { businessId: biz3.id, amount: 3_000, idempotencyKey: "b3w0", confirmEarly: true });
    assert.strictEqual(out.status, 423, "and it cannot be emptied to get round the refusal");
    assert.ok(await prisma.business.findUnique({ where: { id: biz3.id } }));
    ctx.schoolPot = pot;
    ctx.schoolDay = day;
  });

  await test("delete-account with an Unbreakable pot → 409 naming it and its day, before an older plain pot; nothing deleted", async () => {
    // An older pot with money in the main business: the Unbreakable one is
    // still the one named, because it is the one nobody can empty.
    const float = (await mkPot({ name: "Float" })).body.pot;
    await prisma.savingsPot.update({ where: { id: float.id }, data: { createdAt: new Date(Date.now() - 86400000) } });
    assert.strictEqual((await depositTo(float.id, { amount: 1_000, idempotencyKey: "fl1" })).status, 200);
    const staffTry = await POST("/auth/delete-account", tStaff, { password: PASSWORD });
    assert.strictEqual(staffTry.status, 403);
    const wrongPw = await POST("/auth/delete-account", tOwner, { password: "not-it" });
    assert.strictEqual(wrongPw.status, 401);
    const r = await POST("/auth/delete-account", tOwner, { password: PASSWORD });
    assert.strictEqual(r.status, 409, JSON.stringify(r.body));
    assert.deepStrictEqual(Object.keys(r.body).sort(), REFUSAL_KEYS);
    assert.strictEqual(r.body.potName, "School fees");
    assert.strictEqual(r.body.opensOn, ctx.schoolDay);
    assert.strictEqual(r.body.unbreakable, true);
    assert.strictEqual(r.body.error, `Your savings pot "School fees" is unbreakable and opens on ${inWords(ctx.schoolDay)}. Nobody, not even KashBook, can take the money out before then. After that, take it out and close the pot, then delete your account.`);
    const u = await prisma.user.findUnique({ where: { id: owner.id } });
    assert.strictEqual(u.accountStatus, "active", "nothing was deleted");
    assert.strictEqual(u.tokenVersion, 0);
    // Its day comes: emptied and closed, the business can go, and the plain pot is next in line.
    await prisma.savingsPot.update({ where: { id: ctx.schoolPot.id }, data: { lockUntil: minutesAgo(1) } });
    assert.strictEqual((await withdrawFrom(ctx.schoolPot.id, { businessId: "sav_biz3", amount: 3_000, idempotencyKey: "b3w1" })).status, 200);
    assert.strictEqual((await closePot(ctx.schoolPot.id, { businessId: "sav_biz3" })).status, 204);
    anchorState.grossBy["anchor-acct-sav_biz3"] = 0; // its account is empty too
    assert.strictEqual((await DEL("/businesses/sav_biz3", tOwner)).status, 200);
    const next = await POST("/auth/delete-account", tOwner, { password: PASSWORD });
    assert.strictEqual(next.status, 409, JSON.stringify(next.body));
    assert.strictEqual(next.body.potName, "Float");
    assert.strictEqual(next.body.unbreakable, false);
    assert.strictEqual((await withdrawFrom(float.id, { amount: 1_000, idempotencyKey: "fl2" })).status, 200);
    assert.strictEqual((await closePot(float.id)).status, 204);
  });

  await test("delete-account with a pot balance → 409 SAVINGS_REMAINING, nothing deleted", async () => {
    const pot = (await mkPot({ name: "Rent" })).body.pot;
    assert.strictEqual((await depositTo(pot.id, { amount: 5_000, idempotencyKey: "del1" })).status, 200);
    const r = await POST("/auth/delete-account", tOwner, { password: PASSWORD });
    assert.strictEqual(r.status, 409, JSON.stringify(r.body));
    assert.strictEqual(r.body?.code, "SAVINGS_REMAINING");
    assert.strictEqual(r.body.potName, "Rent");
    assert.strictEqual(r.body.opensOn, null);
    assert.strictEqual(r.body.unbreakable, false);
    assert.strictEqual(r.body.error, 'Your savings pot "Rent" still has money in it. Take it out and close the pot first, then delete your account.');
    const u = await prisma.user.findUnique({ where: { id: owner.id } });
    assert.strictEqual(u.accountStatus, "active", "nothing was deleted");
    assert.strictEqual(u.tokenVersion, 0);
    assert.strictEqual((await prisma.business.findUnique({ where: { id: BIZ_ID } })).accountStatus, "active");
    assert.strictEqual((await dbPot(pot.id)).balance, 5_000);
    ctx.delPot = pot;
  });

  await test("with the pot emptied and closed the savings guard steps aside: the bank-balance guard answers, then deletion proceeds", async () => {
    assert.strictEqual((await withdrawFrom(ctx.delPot.id, { amount: 5_000, idempotencyKey: "delw" })).status, 200);
    assert.strictEqual((await closePot(ctx.delPot.id)).status, 204);
    const bank = await POST("/auth/delete-account", tOwner, { password: PASSWORD });
    assert.strictEqual(bank.status, 400, JSON.stringify(bank.body));
    assert.strictEqual(bank.body?.code, "BALANCE_REMAINING");
    anchorState.gross = 0;
    const done = await POST("/auth/delete-account", tOwner, { password: PASSWORD });
    assert.strictEqual(done.status, 200, JSON.stringify(done.body));
    assert.strictEqual(done.body?.ok, true);
    const u = await prisma.user.findUnique({ where: { id: owner.id } });
    assert.strictEqual(u.accountStatus, "closed");
    assert.strictEqual(u.tokenVersion, 1, "every session is revoked");
    assert.strictEqual((await prisma.user.findUnique({ where: { id: staff.id } })).accountStatus, "closed");
    assert.strictEqual((await prisma.business.findUnique({ where: { id: BIZ_ID } })).accountStatus, "closed");
    const after = await GET(`/savings?businessId=${BIZ_ID}`, tOwner);
    assert.strictEqual(after.status, 401, "the old token is dead");
    assert.strictEqual(await auditCount("ACCOUNT_DELETED"), 1);
  });

  // ══ 8. /auth/me FLAGS ═════════════════════════════════════════════════════
  section("8. /auth/me: the retired flag, the switch, and who sees savings");
  await seed();

  await test("switch on: savings stays false (older apps never show it), savingsPots true, the owner sees savings and staff do not", async () => {
    const o = await meFeatures(tOwner);
    assert.strictEqual(o.savings, false, "the first flag is retired for good");
    assert.strictEqual(o.savingsPots, true);
    assert.strictEqual(o.savingsVisible, true, "the owner sees savings, pots or not");
    assert.strictEqual(typeof o.fcy, "boolean");
    const s = await meFeatures(tStaff);
    assert.strictEqual(s.savings, false);
    assert.strictEqual(s.savingsPots, true, "the switch itself is no secret");
    assert.strictEqual(s.savingsVisible, false, "staff never see pots");
  });

  await test("switch off: savings shows only while an owner's pot still holds money, never another owner's", async () => {
    const pot = (await mkPot({ name: "Kept", lockUntil: lagosDayPlus(10), lockMode: "strict" })).body.pot;
    const empty = (await mkPot({ name: "Empty" })).body.pot;
    assert.ok(pot?.id && empty?.id, "fixtures");
    const { token: tOther } = await mkUser("sav_other8");
    delete process.env.SAVINGS_ENABLED;
    try {
      const o = await meFeatures(tOwner);
      assert.deepStrictEqual([o.savings, o.savingsPots, o.savingsVisible], [false, false, false], "empty pots hide nothing: no money to show");
    } finally { process.env.SAVINGS_ENABLED = "true"; }
    assert.strictEqual((await depositTo(pot.id, { amount: 2_500, idempotencyKey: "me1" })).status, 200);
    delete process.env.SAVINGS_ENABLED;
    try {
      const o = await meFeatures(tOwner);
      assert.strictEqual(o.savingsPots, false);
      assert.strictEqual(o.savingsVisible, true, "turning the switch off never hides money");
      assert.strictEqual(o.savings, false);
      assert.strictEqual((await meFeatures(tStaff)).savingsVisible, false, "not even then for staff");
      assert.strictEqual((await meFeatures(tOther)).savingsVisible, false, "another owner's pot is not this owner's");
      // The pot stays readable and its lock holds with the switch off.
      const list = await GET(`/savings?businessId=${BIZ_ID}`, tOwner);
      assert.strictEqual(list.status, 200);
      assert.strictEqual(list.body.enabled, false);
      assert.ok(list.body.pots.some((p) => p.id === pot.id && p.balance === 2_500));
      assert.strictEqual((await withdrawFrom(pot.id, { amount: 2_500, idempotencyKey: "me2", confirmEarly: true })).status, 423);
      // Its day comes; emptied, savings is hidden again.
      await prisma.savingsPot.update({ where: { id: pot.id }, data: { lockUntil: minutesAgo(1) } });
      assert.strictEqual((await withdrawFrom(pot.id, { amount: 2_500, idempotencyKey: "me3" })).status, 200);
      assert.strictEqual((await meFeatures(tOwner)).savingsVisible, false);
    } finally {
      process.env.SAVINGS_ENABLED = "true";
    }
  });

  // ══ 9. THE LIVE DEFAULTS (owner, 2026-10-15) ═════════════════════════════
  section("9. each deposit costs ₦250 on top; an early withdrawal costs exactly 2%");
  await seed({ gross: 10_000 });
  delete process.env.SAVINGS_DEPOSIT_FEE;
  delete process.env.SAVINGS_BREAK_FEE_MIN;
  try {
    await test("GET /savings names both fees: ₦250 a deposit, 2% with no minimum", async () => {
      const r = await GET(`/savings?businessId=${BIZ_ID}`, tOwner);
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.deepStrictEqual(r.body.depositFee, { enabled: true, amount: 250 });
      assert.deepStrictEqual(r.body.breakFee, { enabled: true, bps: 200, pct: 2, min: 0 });
    });

    await test("a deposit puts the amount typed in the pot, sweeps ₦250 from the money not set aside, and books it as a bank charge", async () => {
      const pot = (await mkPot({ name: "Rent", lockUntil: lagosDayPlus(30), lockMode: "flexible" })).body.pot;
      const chargesBefore = await bankCharges();
      const ledgerBefore = await computeRawLedger(BIZ_ID, "NGN");
      const d = await depositTo(pot.id, { amount: 1_000, idempotencyKey: "df1" });
      assert.strictEqual(d.status, 200, JSON.stringify(d.body));
      assert.strictEqual(d.body.movement.type, "deposit");
      assert.strictEqual(d.body.movement.fee, 250);
      assert.strictEqual(d.body.pot.balance, 1_000, "the pot gets exactly what was typed");
      assert.strictEqual(bookCalls.length, 1, JSON.stringify(bookCalls));
      assert.strictEqual(bookCalls[0].fromAccountId, BIZ_ANCHOR_ID);
      assert.strictEqual(bookCalls[0].toAccountId, FEE_ACCOUNT);
      assert.strictEqual(bookCalls[0].amount, 250);
      assert.strictEqual(bookCalls[0].reference, "kb_sv_df1_dfee");
      assert.strictEqual(bookCalls[0].reason, "Savings deposit fee", "the transfer names no pot");
      assert.strictEqual(anchorState.gross, 9_750, "only the fee left the bank");
      const row = await dbTxnByRef("kb_sv_df1_dfee");
      assert.ok(row, "fee Transaction row");
      assert.strictEqual(row.purpose, "savings_fee");
      assert.strictEqual(row.description, "Savings deposit fee · Ref: kb_sv_df1_dfee", "the bank row names no pot");
      assert.strictEqual(row.type, "expense");
      assert.strictEqual(row.amount, 250);
      assert.ok((await dbMovementByRef("kb_sv_df1")).feeCollectedAt, "claimed as collected");
      assert.strictEqual(await auditCount("SAVINGS_DEPOSIT_FEE"), 1);
      assert.ok(sameKobo(await bankCharges(), chargesBefore + 250), "a Bank Fees and Charges expense of ₦250");
      assert.ok(sameKobo(await computeRawLedger(BIZ_ID, "NGN"), ledgerBefore - 250), "real money off the ledger");
      ctx.feePot = pot;
    });

    await test("the same request again charges nothing more", async () => {
      const again = await depositTo(ctx.feePot.id, { amount: 1_000, idempotencyKey: "df1" });
      assert.strictEqual(again.status, 200, JSON.stringify(again.body));
      assert.strictEqual(again.body.replay, true);
      assert.strictEqual(bookCalls.length, 1, "no second sweep");
      assert.strictEqual(anchorState.gross, 9_750);
      assert.strictEqual((await dbPot(ctx.feePot.id)).balance, 1_000);
    });

    await test("the amount AND the fee must be free: short by the fee, refused with the most that fits; exactly that fits", async () => {
      // Free now: 9,750 − 1,000 = 8,750. ₦8,600 + ₦250 is ₦8,850.
      const r = await depositTo(ctx.feePot.id, { amount: 8_600, idempotencyKey: "df2" });
      assert.strictEqual(r.status, 400, JSON.stringify(r.body));
      assert.strictEqual(r.body.code, "INSUFFICIENT_BALANCE");
      assert.strictEqual(r.body.fee, 250);
      assert.strictEqual(r.body.maxDeposit, 8_500);
      assert.ok(sameKobo(r.body.availableBalance, 8_750));
      assert.ok(/Each deposit costs ₦250(\.00)?, so you can save up to ₦8,500(\.00)?\.$/.test(r.body.error), r.body.error);
      assert.strictEqual(await dbMovementByRef("kb_sv_df2"), null, "nothing written");
      assert.strictEqual(bookCalls.length, 1, "nothing swept");
      const ok = await depositTo(ctx.feePot.id, { amount: 8_500, idempotencyKey: "df3" });
      assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
      assert.strictEqual(bookCalls.length, 2);
      assert.strictEqual(anchorState.gross, 9_500);
      assert.strictEqual((await dbPot(ctx.feePot.id)).balance, 9_500);
    });

    await test("an early withdrawal costs exactly 2%, no minimum: ₦20 on ₦1,000, ₦24.68 on ₦1,234", async () => {
      const w1 = await withdrawFrom(ctx.feePot.id, { amount: 1_000, idempotencyKey: "dw1" });
      assert.strictEqual(w1.status, 409, JSON.stringify(w1.body));
      assert.strictEqual(w1.body.code, "EARLY_WITHDRAWAL_CONFIRM");
      assert.strictEqual(w1.body.fee, 20);
      assert.strictEqual(w1.body.feeBps, 200);
      assert.ok(/Withdrawing ₦1,000(\.00)? early costs ₦20(\.00)?\. Confirm to continue\.$/.test(w1.body.error), w1.body.error);
      const w2 = await withdrawFrom(ctx.feePot.id, { amount: 1_000, idempotencyKey: "dw1", confirmEarly: true });
      assert.strictEqual(w2.status, 200, JSON.stringify(w2.body));
      assert.strictEqual(w2.body.movement.fee, 20);
      assert.strictEqual(bookCalls.length, 3);
      assert.strictEqual(bookCalls[2].amount, 20);
      assert.strictEqual(bookCalls[2].reference, "kb_svw_dw1_bfee");
      assert.strictEqual(anchorState.gross, 9_480);
      assert.strictEqual((await dbPot(ctx.feePot.id)).balance, 8_500);
      const w3 = await withdrawFrom(ctx.feePot.id, { amount: 1_234, idempotencyKey: "dw2", confirmEarly: true });
      assert.strictEqual(w3.status, 200, JSON.stringify(w3.body));
      assert.strictEqual(w3.body.movement.fee, 24.68, "to the kobo");
      assert.ok(sameKobo(anchorState.gross, 9_455.32), String(anchorState.gross));
    });

    await test("a deposit fee the bank refuses alerts a human in the deposit's words and is never charged twice; the deposit stands", async () => {
      anchorState.bookMode = "reject";
      try {
        const d = await depositTo(ctx.feePot.id, { amount: 100, idempotencyKey: "df4" });
        assert.strictEqual(d.status, 200, JSON.stringify(d.body));
        const mv = await dbMovementByRef("kb_sv_df4");
        assert.ok(mv.feeCollectedAt, "claimed before the transfer, so never charged twice");
        assert.strictEqual(await dbTxnByRef("kb_sv_df4_dfee"), null, "no row for money that did not move");
        assert.strictEqual(await auditCount("SAVINGS_DEPOSIT_FEE_FAILED"), 1);
        const alert = await alertFired(`savings-deposit-fee-${mv.id}`);
        assert.ok(alert && alert.lastValue.startsWith("The bank refused the ₦250 deposit fee kb_sv_df4_dfee (Ada Stores), so nothing moved."), alert && alert.lastValue);
      } finally {
        anchorState.bookMode = "ok";
      }
    });

    await test("a deposit fee a crash left behind is swept once by the reconcile loop", async () => {
      // As if the server died between the deposit's commit and its sweep.
      await prisma.savingsPot.update({ where: { id: ctx.feePot.id }, data: { balance: { increment: 500 } } });
      const mv = await prisma.savingsMovement.create({
        data: { potId: ctx.feePot.id, businessId: BIZ_ID, userId: owner.id, type: "deposit", amount: 500, fee: 250, status: "completed", reference: "kb_sv_crash1", completedAt: new Date() },
      });
      const before = bookCalls.length;
      const t = await reconcileSavings();
      assert.strictEqual(t.feesCollected, 1, JSON.stringify(t));
      assert.strictEqual(t.drift, 0, JSON.stringify(t));
      assert.strictEqual(bookCalls.length, before + 1);
      assert.strictEqual(bookCalls[before].reference, "kb_sv_crash1_dfee");
      assert.strictEqual(bookCalls[before].amount, 250);
      assert.ok((await dbMovement(mv.id)).feeCollectedAt);
      assert.ok(await dbTxnByRef("kb_sv_crash1_dfee"));
      const again = await reconcileSavings();
      assert.strictEqual(again.feesCollected, 0, "never twice");
      assert.strictEqual(bookCalls.length, before + 1);
    });

    await test("no fee account: deposits cost nothing and GET /savings says so", async () => {
      delete process.env.ANCHOR_FEE_ACCOUNT_ID;
      try {
        const r = await GET(`/savings?businessId=${BIZ_ID}`, tOwner);
        assert.deepStrictEqual(r.body.depositFee, { enabled: false, amount: 0 });
        const before = bookCalls.length;
        const d = await depositTo(ctx.feePot.id, { amount: 100, idempotencyKey: "df5" });
        assert.strictEqual(d.status, 200, JSON.stringify(d.body));
        assert.strictEqual(d.body.movement.fee, 0);
        assert.strictEqual(bookCalls.length, before);
      } finally {
        process.env.ANCHOR_FEE_ACCOUNT_ID = FEE_ACCOUNT;
      }
    });
  } finally {
    process.env.SAVINGS_BREAK_FEE_MIN = "100";
    process.env.SAVINGS_DEPOSIT_FEE = "0";
  }

  // ── done ──
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log("\nFAILURES:");
    for (const f of failures) console.log(`  - ${f}`);
  }
  await prisma.$disconnect();
  server.close();
  process.exit(failed ? 1 : 0);
})().catch(async (e) => {
  console.error("\nSUITE CRASHED:", e);
  try { await prisma.$disconnect(); } catch {}
  if (server) server.close();
  process.exit(1);
});
