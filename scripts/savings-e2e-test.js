// FULL end-to-end test of Savings (pots).
//
// Runs the REAL /savings router, the REAL auth + ownerOnly + requireUnfrozen
// middleware, the REAL AML pipeline, the REAL executeTransfer (with the savings
// reserve gate), the REAL savings integrity loop and the REAL account/business
// deletion guards over a REAL Postgres, driven through actual HTTP. Only the
// bank is stubbed (utils/anchor), because the one thing this must not do is
// move real money.
//
// A pot moves no money: its balance is a reserve that every spend path
// subtracts from the Anchor balance first. The only debit the feature makes is
// KashBook's own break fee on a flexible lock, swept as a book transfer. Every
// outbound bank call lands in nipCalls / bookCalls, so a double-send or a
// double sweep is an array length rather than something you have to reason
// about.
//
// Point TEST_DATABASE_URL at a SCRATCH database. It refuses hosted URLs.
//
//   TEST_DATABASE_URL=postgresql://... node scripts/savings-e2e-test.js
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
if (/render\.com|amazonaws|\.prod/.test(url)) {
  console.error("TEST_DATABASE_URL looks hosted/production. Refusing — this test writes money rows.");
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
// The break fee at its defaults (2%, minimum ₦100): the lock tests assert
// those exact figures, so a value left in the shell must not leak in.
delete process.env.SAVINGS_BREAK_FEE_BPS;
delete process.env.SAVINGS_BREAK_FEE_MIN;
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
// ledger can be checked against the reserve. `bookMode` = "ok" | "reject": a
// definite refusal of a book transfer, for the failed-fee-sweep test.
const anchorState = { gross: 10_000_000, bookMode: "ok" };
const nipCalls = [];
const bookCalls = [];

Module._load = function (request) {
  const resolved = origLoad.apply(this, arguments);
  if (/(^|[\\/])(utils[\\/])?anchor$/.test(request) && resolved && !resolved.__stubbed) {
    resolved.__stubbed = true;
    resolved.getAccountBalance = async () => ({ balance: anchorState.gross, available: anchorState.gross, ledgerBalance: anchorState.gross, hold: 0, pending: 0 });
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
      anchorState.gross = Math.round((anchorState.gross - Number(args.amount)) * 100) / 100;
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
    console.log(`  FAIL  ${name}\n        ${String(e.message).split("\n")[0]}`);
    failures.push(`${name}: ${String(e.message).split("\n")[0]}`);
    failed++;
  }
}
const section = (s) => console.log(`\n── ${s} ${"─".repeat(Math.max(0, 58 - s.length))}`);

const minutesAgo = (n) => new Date(Date.now() - n * 60 * 1000);
const daysFromNow = (n) => new Date(Date.now() + n * 24 * 3600 * 1000);
const sameKobo = (a, b) => toKobo(a) === toKobo(b);

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

async function wipe() {
  await prisma.savingsMovement.deleteMany({});
  await prisma.savingsPot.deleteMany({});
  await prisma.invoicePayment.deleteMany({});
  await prisma.invoice.deleteMany({});
  await prisma.salaryPayment.deleteMany({});
  await prisma.salarySchedule.deleteMany({});
  await prisma.staffTransferRequest.deleteMany({});
  await prisma.staffPermission.deleteMany({});
  await prisma.complianceFlag.deleteMany({});
  await prisma.beneficiary.deleteMany({});
  await prisma.transaction.deleteMany({});
  await prisma.appNotification.deleteMany({});
  await prisma.processedWebhook.deleteMany({});
  await prisma.alertState.deleteMany({});
  await prisma.cronHeartbeat.deleteMany({});
  await prisma.auditLog.deleteMany({});
  await prisma.otpCode.deleteMany({});
  await prisma.business.deleteMany({});
  await prisma.user.deleteMany({});
}

async function seed({ gross = 10_000_000 } = {}) {
  await wipe();
  nipCalls.length = 0; bookCalls.length = 0;
  anchorState.gross = gross; anchorState.bookMode = "ok";
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

// ── Route helpers ─────────────────────────────────────────────────────────────
const mkPot = (over = {}) => POST("/savings/pots", tOwner, { businessId: BIZ_ID, name: "Rent", ...over });
const depositTo = (potId, over = {}) => POST(`/savings/pots/${potId}/deposit`, tOwner, { businessId: BIZ_ID, pin: PIN_OWNER, ...over });
const withdrawFrom = (potId, over = {}) => POST(`/savings/pots/${potId}/withdraw`, tOwner, { businessId: BIZ_ID, pin: PIN_OWNER, ...over });
const closePot = (potId, over = {}) => DEL(`/savings/pots/${potId}?businessId=${over.businessId || BIZ_ID}`, over.token || tOwner);
const send = (over = {}) => POST("/transfers/send", tOwner, {
  businessId: BIZ_ID, accountNumber: "0123456789", bankCode: "058", accountName: "SUPPLIER LTD", bankName: "GTBank",
  narration: "supplier", pin: PIN_OWNER, ...over,
});
const dbPot = (id) => prisma.savingsPot.findUnique({ where: { id } });
const dbMovement = (id) => prisma.savingsMovement.findUnique({ where: { id } });
const dbMovementByRef = (reference) => prisma.savingsMovement.findUnique({ where: { reference } });
const dbTxnByRef = (reference, businessId = BIZ_ID) => prisma.transaction.findFirst({ where: { businessId, reference } });
const alertFired = (key) => prisma.alertState.findUnique({ where: { key } });
const auditCount = (action) => prisma.auditLog.count({ where: { action } });
const wideRange = () => ({ start: new Date(Date.now() - 2 * 86400000), end: new Date(Date.now() + 2 * 86400000) });

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
    assert.strictEqual(potA.locked, false);
    assert.strictEqual(potA.lockUntil, null);
    assert.strictEqual(potA.lockMode, null);
    assert.strictEqual(potA.businessId, BIZ_ID);
    assert.deepStrictEqual(Object.keys(potA).sort(), POT_KEYS, "no partner or backing field leaves the server");
    assert.strictEqual(await auditCount("SAVINGS_POT_CREATED"), 1);
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
    const other = await prisma.user.create({
      data: { id: "sav_other", firstName: "Cid", lastName: "Other", businessName: "Other Co", country: "NG", currency: "NGN", email: "other@savings.test", password: await bcrypt.hash(PASSWORD, 4), transactionPin: await bcrypt.hash(PIN_OWNER, 4), accountType: "OWNER" },
    });
    const tOther = signToken({ userId: other.id, tokenVersion: 0 });
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
    assert.strictEqual(stats.errors, 0);
  });

  // ══ 4. LOCKS ══════════════════════════════════════════════════════════════
  section("4. locks — strict is server-enforced, flexible is a priced confirmation");
  await seed();

  await test("strict lock → 423 POT_LOCKED on withdrawal, even with confirmEarly", async () => {
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
    assert.ok(w.body?.lockUntil, "the refusal says until when");
    assert.strictEqual(w.body?.fee, 0, "a strict lock has no price");
    assert.strictEqual((await dbPot(pot.id)).balance, 10_000);
    assert.strictEqual(await dbMovementByRef("kb_svw_sw1"), null);
    ctx.strictPot = pot;
  });

  await test("PATCH shortening, removing or relaxing a strict lock → 409 LOCK_CANNOT_SHORTEN; extending is allowed", async () => {
    const pot = ctx.strictPot;
    const shorter = await PATCH(`/savings/pots/${pot.id}`, tOwner, { businessId: BIZ_ID, lockUntil: daysFromNow(10).toISOString(), lockMode: "strict" });
    assert.strictEqual(shorter.status, 409, JSON.stringify(shorter.body));
    assert.strictEqual(shorter.body?.code, "LOCK_CANNOT_SHORTEN");
    const removed = await PATCH(`/savings/pots/${pot.id}`, tOwner, { businessId: BIZ_ID, lockUntil: null });
    assert.strictEqual(removed.status, 409);
    assert.strictEqual(removed.body?.code, "LOCK_CANNOT_SHORTEN");
    const relaxed = await PATCH(`/savings/pots/${pot.id}`, tOwner, { businessId: BIZ_ID, lockUntil: daysFromNow(60).toISOString(), lockMode: "flexible" });
    assert.strictEqual(relaxed.status, 409);
    assert.strictEqual(relaxed.body?.code, "LOCK_CANNOT_SHORTEN");
    const longer = await PATCH(`/savings/pots/${pot.id}`, tOwner, { businessId: BIZ_ID, lockUntil: daysFromNow(60).toISOString(), lockMode: "strict" });
    assert.strictEqual(longer.status, 200, JSON.stringify(longer.body));
    assert.strictEqual(longer.body.businessId, BIZ_ID);
    assert.ok(new Date(longer.body.pot.lockUntil) > daysFromNow(59));
    assert.strictEqual(longer.body.pot.lockMode, "strict");
    const past = await PATCH(`/savings/pots/${pot.id}`, tOwner, { businessId: BIZ_ID, lockUntil: daysFromNow(-1).toISOString(), lockMode: "strict" });
    assert.strictEqual(past.status, 400, JSON.stringify(past.body));
    assert.strictEqual(past.body?.code, "BAD_LOCK");
    const row = await dbPot(pot.id);
    assert.ok(new Date(row.lockUntil) > daysFromNow(59), "the refusals changed nothing");
    assert.strictEqual(row.lockMode, "strict");
  });

  await test("flexible lock → 409 EARLY_WITHDRAWAL_CONFIRM carrying the fee, then success with confirmEarly and ONE sweep", async () => {
    const r = await mkPot({ name: "Holiday", lockUntil: daysFromNow(30).toISOString(), lockMode: "flexible" });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    const pot = r.body.pot;
    assert.strictEqual(pot.locked, true);
    assert.strictEqual(pot.lockMode, "flexible");
    assert.strictEqual((await depositTo(pot.id, { amount: 5_000, idempotencyKey: "f1" })).status, 200);
    ctx.expBefore = await sumExpenses(BIZ_ID, wideRange());
    ctx.ledgerBefore = await computeRawLedger(BIZ_ID, "NGN");
    const grossBefore = anchorState.gross;

    const w1 = await withdrawFrom(pot.id, { amount: 1_000, idempotencyKey: "fw1" });
    assert.strictEqual(w1.status, 409, JSON.stringify(w1.body));
    assert.strictEqual(w1.body?.code, "EARLY_WITHDRAWAL_CONFIRM");
    // The refusal names the price of breaking the lock: 2% of ₦1,000 is ₦20,
    // floored at the ₦100 minimum.
    assert.strictEqual(w1.body?.fee, 100, JSON.stringify(w1.body));
    assert.strictEqual(w1.body?.feeBps, 200);
    assert.ok(w1.body?.lockUntil);
    assert.ok(/costs/.test(w1.body.error), `the message states the price: ${w1.body.error}`);
    assert.strictEqual((await dbPot(pot.id)).balance, 5_000);
    assert.strictEqual(await dbMovementByRef("kb_svw_fw1"), null, "nothing is written before the merchant confirms");
    assert.strictEqual(bookCalls.length, 0, "no fee is swept before the merchant confirms");

    const w2 = await withdrawFrom(pot.id, { amount: 1_000, idempotencyKey: "fw1", confirmEarly: true });
    assert.strictEqual(w2.status, 200, JSON.stringify(w2.body));
    assert.strictEqual(w2.body.replay, false);
    assert.strictEqual(w2.body.movement.type, "withdrawal");
    assert.strictEqual(w2.body.movement.status, "completed");
    assert.strictEqual(w2.body.movement.fee, 100);
    assert.strictEqual(w2.body.pot.balance, 4_000, "the fee comes off the bank account, not the pot");
    assert.strictEqual(w2.body.reserved, 4_000);
    // The fee is swept from the Anchor account to the fee account at once, and
    // booked as a savings_fee row: real money for the ledger, invisible to reports.
    assert.strictEqual(bookCalls.length, 1, JSON.stringify(bookCalls));
    assert.strictEqual(bookCalls[0].fromAccountId, BIZ_ANCHOR_ID);
    assert.strictEqual(bookCalls[0].toAccountId, FEE_ACCOUNT);
    assert.strictEqual(bookCalls[0].amount, 100);
    assert.strictEqual(bookCalls[0].reference, "kb_svw_fw1_bfee");
    assert.ok(sameKobo(anchorState.gross, grossBefore - 100), "only the fee left the bank");
    const feeRow = await dbTxnByRef("kb_svw_fw1_bfee");
    assert.ok(feeRow, "fee Transaction row");
    assert.strictEqual(feeRow.purpose, "savings_fee");
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

  await test("the fee row is real money for the ledger and invisible to the reports", async () => {
    const exp = await sumExpenses(BIZ_ID, wideRange());
    assert.ok(sameKobo(exp.total, ctx.expBefore.total), `expenses moved from ${ctx.expBefore.total} to ${exp.total}`);
    assert.strictEqual(exp.count, ctx.expBefore.count);
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

  await test("a lock needs a mode, a mode needs a date, and the date must be real, future and within 5 years", async () => {
    const cases = [
      ["no mode", { name: "X", lockUntil: daysFromNow(3).toISOString() }],
      ["mode without a date", { name: "X", lockMode: "strict" }],
      ["unknown mode", { name: "X", lockUntil: daysFromNow(3).toISOString(), lockMode: "forever" }],
      ["not a date", { name: "X", lockUntil: "next tuesday", lockMode: "strict" }],
      ["past", { name: "X", lockUntil: daysFromNow(-3).toISOString(), lockMode: "flexible" }],
      ["beyond 5 years", { name: "X", lockUntil: daysFromNow(5 * 366 + 2).toISOString(), lockMode: "strict" }],
    ];
    for (const [label, body] of cases) {
      const r = await mkPot(body);
      assert.strictEqual(r.status, 400, `${label}: ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body?.code, "BAD_LOCK", label);
    }
    assert.strictEqual(await prisma.savingsPot.count({ where: { name: "X" } }), 0);
    const modeOnly = await PATCH(`/savings/pots/${ctx.strictPot.id}`, tOwner, { businessId: BIZ_ID, lockMode: "flexible" });
    assert.strictEqual(modeOnly.status, 400, JSON.stringify(modeOnly.body));
    assert.strictEqual(modeOnly.body?.code, "BAD_LOCK");
    assert.strictEqual((await dbPot(ctx.strictPot.id)).lockMode, "strict");
  });

  await test("a flexible lock may be shortened or removed; only strict is one-way", async () => {
    const r = await mkPot({ name: "Soft", lockUntil: daysFromNow(30).toISOString(), lockMode: "flexible" });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    const pot = r.body.pot;
    const shorter = await PATCH(`/savings/pots/${pot.id}`, tOwner, { businessId: BIZ_ID, lockUntil: daysFromNow(5).toISOString() });
    assert.strictEqual(shorter.status, 200, JSON.stringify(shorter.body));
    assert.strictEqual(shorter.body.pot.lockMode, "flexible", "the mode carries over when only the date changes");
    assert.ok(new Date(shorter.body.pot.lockUntil) < daysFromNow(6));
    const removed = await PATCH(`/savings/pots/${pot.id}`, tOwner, { businessId: BIZ_ID, lockUntil: null });
    assert.strictEqual(removed.status, 200, JSON.stringify(removed.body));
    assert.strictEqual(removed.body.pot.lockUntil, null);
    assert.strictEqual(removed.body.pot.lockMode, null);
    assert.strictEqual(removed.body.pot.locked, false);
  });

  await test("with no fee account the break fee is ₦0: confirmation still asked, nothing swept", async () => {
    const pot = (await mkPot({ name: "Free break", lockUntil: daysFromNow(30).toISOString(), lockMode: "flexible" })).body.pot;
    assert.strictEqual((await depositTo(pot.id, { amount: 10_000, idempotencyKey: "nf1" })).status, 200);
    delete process.env.ANCHOR_FEE_ACCOUNT_ID;
    try {
      const cfg = await GET(`/savings?businessId=${BIZ_ID}`, tOwner);
      assert.strictEqual(cfg.body.breakFee.enabled, false);
      const ask = await withdrawFrom(pot.id, { amount: 1_000, idempotencyKey: "nfw1" });
      assert.strictEqual(ask.status, 409, JSON.stringify(ask.body));
      assert.strictEqual(ask.body?.code, "EARLY_WITHDRAWAL_CONFIRM");
      assert.strictEqual(ask.body?.fee, 0, "a fee nothing can collect is not charged");
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
    assert.ok(await alertFired(`savings-break-fee-${row.id}`), "a human is told to collect it by hand");
    assert.strictEqual(await auditCount("SAVINGS_BREAK_FEE_FAILED"), 1);
    const stats = await reconcileSavings();
    assert.strictEqual(stats.feesCollected, 0, JSON.stringify(stats));
    assert.strictEqual(bookCalls.length, before + 1, "the loop does not retry a claimed fee");
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
    assert.deepStrictEqual(quiet, { feesCollected: 0, drift: 0, overReserved: 0, errors: 0 });
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

  // ══ 7. DELETION ═══════════════════════════════════════════════════════════
  section("7. deleting a business or an account — never around a pot with money");
  await seed();

  await test("DELETE /businesses/:id with a pot balance → 400 SAVINGS_REMAINING; allowed once emptied and closed, pots cascade away", async () => {
    const biz2 = await prisma.business.create({
      data: {
        id: "sav_biz2", userId: owner.id, name: "Second Shop", country: "NG", baseCurrency: "NGN",
        anchorAccountId: "anchor-acct-sav2", virtualAccountNumber: "9990009998",
        virtualAccountBank: "Providus Bank", virtualAccountName: "SECOND SHOP", kycBusinessType: "limited_company",
      },
    });
    const pot = (await mkPot({ name: "Van", businessId: biz2.id })).body.pot;
    assert.ok(pot?.id, "fixture: pot on the second business");
    assert.strictEqual((await depositTo(pot.id, { businessId: biz2.id, amount: 5_000, idempotencyKey: "b2d1" })).status, 200);
    const staffTry = await DEL(`/businesses/${biz2.id}`, tStaff);
    assert.strictEqual(staffTry.status, 403);
    const r = await DEL(`/businesses/${biz2.id}`, tOwner);
    assert.strictEqual(r.status, 400, JSON.stringify(r.body));
    assert.strictEqual(r.body?.code, "SAVINGS_REMAINING");
    assert.ok(/Van/.test(r.body.error), `names the pot: ${r.body.error}`);
    assert.ok(await prisma.business.findUnique({ where: { id: biz2.id } }), "nothing was deleted");
    assert.strictEqual((await dbPot(pot.id)).balance, 5_000);
    assert.strictEqual((await withdrawFrom(pot.id, { businessId: biz2.id, amount: 5_000, idempotencyKey: "b2w1" })).status, 200);
    assert.strictEqual((await closePot(pot.id, { businessId: biz2.id })).status, 204);
    const ok = await DEL(`/businesses/${biz2.id}`, tOwner);
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    assert.strictEqual(await prisma.business.findUnique({ where: { id: biz2.id } }), null);
    assert.strictEqual(await prisma.savingsPot.count({ where: { businessId: biz2.id } }), 0, "pots go with the business");
    assert.strictEqual(await prisma.savingsMovement.count({ where: { businessId: biz2.id } }), 0);
    assert.ok(await prisma.business.findUnique({ where: { id: BIZ_ID } }), "the other business is untouched");
  });

  await test("delete-account with a pot balance → 400 SAVINGS_REMAINING, nothing deleted", async () => {
    const pot = (await mkPot({ name: "Rent" })).body.pot;
    assert.strictEqual((await depositTo(pot.id, { amount: 5_000, idempotencyKey: "del1" })).status, 200);
    const staffTry = await POST("/auth/delete-account", tStaff, { password: PASSWORD });
    assert.strictEqual(staffTry.status, 403);
    const wrongPw = await POST("/auth/delete-account", tOwner, { password: "not-it" });
    assert.strictEqual(wrongPw.status, 401);
    const r = await POST("/auth/delete-account", tOwner, { password: PASSWORD });
    assert.strictEqual(r.status, 400, JSON.stringify(r.body));
    assert.strictEqual(r.body?.code, "SAVINGS_REMAINING");
    assert.ok(/Rent/.test(r.body.error), `names the pot: ${r.body.error}`);
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
