// FULL end-to-end test of Staff Payments.
//
// Runs the REAL payroll router, the REAL auth middleware, the REAL ownerOnly
// gate, the REAL AML pipeline and the REAL executeTransfer over a REAL Postgres,
// driven through actual HTTP. Only the outbound bank call is stubbed — because
// the one thing this must not do is move real money.
//
// Every outbound "bank" call is pushed onto anchorCalls, so a double-send is an
// array length rather than something you have to reason about.
//
// Point TEST_DATABASE_URL at a SCRATCH database. It refuses hosted URLs.
//
//   TEST_DATABASE_URL=postgresql://... node scripts/salary-e2e-test.js

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
// Keep the AML pipeline ARMED — the interaction between payroll and the daily
// cap is one of the things most worth testing.
process.env.AML_ENABLED = "true";

// ── Stub the payment provider BEFORE anything requires it ────────────────────
const Module = require("module");
const origLoad = Module._load;
const anchorCalls = [];
Module._load = function (request) {
  const resolved = origLoad.apply(this, arguments);
  if (/(^|[\\/])(utils[\\/])?anchor$/.test(request) && resolved && !resolved.__stubbed) {
    resolved.__stubbed = true;
    resolved.getAccountBalance = async () => ({ balance: 10_000_000, available: 10_000_000 });
    resolved.verifyCounterparty = async ({ accountNumber }) => ({
      accountName: `BANK VERIFIED NAME ${String(accountNumber).slice(-4)}`,
    });
    resolved.getBanks = async () => [{ code: "058", id: "bank-058", name: "GTBank" }];
    resolved.createCounterparty = async () => ({ id: "cp-1" });
    resolved.createTransfer = async (args) => {
      anchorCalls.push(args);
      return { id: `anchor-txn-${anchorCalls.length}`, status: "SUCCESSFUL" };
    };
    resolved.createBookTransfer = async (args) => {
      anchorCalls.push(args);
      return { id: `anchor-book-${anchorCalls.length}` };
    };
  }
  return resolved;
};

const assert = require("assert");
const http = require("http");
const express = require("express");
const bcrypt = require("@node-rs/bcrypt");

const prisma = require("../src/utils/db");
const { signToken } = require("../src/utils/jwt");
const { referenceFor } = require("../src/utils/salarySchedule");
const { staffSpendLast24h } = require("../src/utils/staffTransferCap");

// Patch the provider SINGLETON in place (not by spreading — these are class
// instances and a spread drops the prototype, taking supportsBanking with it).
{
  const { getProvider } = require("../src/providers");
  const ng = getProvider("NG");
  ng.getBanks = async () => [{ code: "058", id: "bank-058", name: "GTBank" }];
  ng.verifyRecipient = async ({ accountNumber }) => ({
    accountName: `BANK VERIFIED NAME ${String(accountNumber).slice(-4)}`,
  });
  ng.payout = async (args) => { anchorCalls.push(args); return { id: "payout-1" }; };
  if (!ng.supportsBanking) {
    console.error("provider stub broke supportsBanking — aborting rather than testing a lie");
    process.exit(1);
  }
}

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use("/auth", require("../src/routes/auth"));
app.use("/payroll", require("../src/routes/payroll"));
app.use("/transfers", require("../src/routes/transfers"));

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
    console.log(`  FAIL  ${name}\n        ${e.message.split("\n")[0]}`);
    failures.push(`${name}: ${e.message.split("\n")[0]}`);
    failed++;
  }
}
const section = (s) => console.log(`\n── ${s} ${"─".repeat(Math.max(0, 58 - s.length))}`);

const PIN_OWNER = "1234";
let owner, staff, staff2, otherOwner, biz;
let tOwner, tStaff, tOther;

async function wipe() {
  await prisma.salaryPayment.deleteMany({});
  await prisma.salarySchedule.deleteMany({});
  await prisma.staffTransferRequest.deleteMany({});
  await prisma.staffPermission.deleteMany({});
  await prisma.transaction.deleteMany({});
  await prisma.appNotification.deleteMany({});
  await prisma.business.deleteMany({});
  await prisma.user.deleteMany({});
}

async function seed() {
  await wipe();
  anchorCalls.length = 0;

  const mk = async (over) =>
    prisma.user.create({
      data: {
        password: await bcrypt.hash("Password123!", 4),
        businessName: "Salary Co", country: "NG", currency: "NGN",
        transactionPin: await bcrypt.hash(over.__pin || PIN_OWNER, 4),
        plan: "PREMIUM",
        ...Object.fromEntries(Object.entries(over).filter(([k]) => !k.startsWith("__"))),
      },
    });

  owner = await mk({ id: "sal_owner", firstName: "Ada", lastName: "Owner", email: "owner@salary.test", accountType: "OWNER" });
  otherOwner = await mk({ id: "sal_other", firstName: "Cid", lastName: "Other", email: "other@salary.test", accountType: "OWNER" });
  staff = await mk({ id: "sal_staff", firstName: "Musa", lastName: "Staff", email: "musa@salary.test", accountType: "STAFF", employerId: owner.id, plan: "FREE" });
  staff2 = await mk({ id: "sal_staff2", firstName: "Bola", lastName: "Two", email: "bola@salary.test", accountType: "STAFF", employerId: owner.id, plan: "FREE" });

  // Give the staff member EVERY capability. The point of the ownerOnly tests is
  // that no permission can unlock payroll, so the staff token must be the most
  // privileged one possible.
  await prisma.staffPermission.create({
    data: {
      userId: staff.id, employerId: owner.id, grantedById: owner.id,
      canViewBalance: true, canTransfer: true, canViewReports: true, canManagePayables: true,
      dailyTransferCap: 1_000_000,
    },
  });

  biz = await prisma.business.create({
    data: {
      id: "sal_biz", userId: owner.id, name: "Ada Stores", country: "NG", baseCurrency: "NGN",
      anchorAccountId: "anchor-acct-sal", virtualAccountNumber: "9990009999",
    },
  });

  // Fund the ledger from a provider source, which is what counts as spendable.
  await prisma.transaction.create({
    data: {
      businessId: biz.id, userId: owner.id, type: "income", amount: 5_000_000,
      description: "seed float", category: "transfer", paymentMethod: "bank",
      source: "anchor", date: new Date(), reference: "seed_float_1",
    },
  });

  tOwner = signToken({ userId: owner.id, tokenVersion: 0 });
  tStaff = signToken({ userId: staff.id, tokenVersion: 0 });
  tOther = signToken({ userId: otherOwner.id, tokenVersion: 0 });
}

// Create a schedule through the real route.
const mkSchedule = (over = {}) =>
  POST("/payroll", tOwner, {
    businessId: biz.id,
    staffUserId: staff.id,
    amount: 50_000,
    frequency: "monthly",
    anchorDay: 25,
    accountNumber: "0123456789",
    bankCode: "058",
    bankName: "GTBank",
    pin: PIN_OWNER,
    ...over,
  });

// Mint a pending payment directly, as the runner would.
async function mintPayment(schedule, periodKey = "2026-09", over = {}) {
  return prisma.salaryPayment.create({
    data: {
      scheduleId: schedule.id,
      businessId: biz.id,
      ownerId: owner.id,
      staffUserId: schedule.staffUserId,
      staffNameSnapshot: schedule.staffNameSnapshot,
      amount: schedule.amount,
      currency: "NGN",
      accountNumber: schedule.accountNumber,
      bankCode: schedule.bankCode,
      bankName: schedule.bankName,
      accountName: schedule.accountName,
      nameVerified: true,
      periodKey,
      scheduledFor: new Date(),
      reference: referenceFor(schedule.id, periodKey),
      expiresAt: new Date(Date.now() + 72 * 3600 * 1000),
      ...over,
    },
  });
}

const dbSchedule = (id) => prisma.salarySchedule.findUnique({ where: { id } });

(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  BASE = `http://127.0.0.1:${server.address().port}`;

  // ══ 1. OWNER-ONLY ═══════════════════════════════════════════════════════
  section("1. owner-only — no permission can ever unlock payroll");
  await seed();
  const sched1 = (await mkSchedule()).body;

  await test("a staff member with EVERY permission is refused on every payroll route", async () => {
    const calls = [
      await GET("/payroll", tStaff),
      await POST("/payroll", tStaff, { businessId: biz.id, staffUserId: staff.id, amount: 1000, anchorDay: 1, accountNumber: "0123456789", bankCode: "058", pin: PIN_OWNER }),
      await PATCH(`/payroll/${sched1.id}`, tStaff, { amount: 1 }),
      await DEL(`/payroll/${sched1.id}`, tStaff),
      await GET("/payroll/payments", tStaff),
      await POST("/payroll/approve", tStaff, { businessId: biz.id, paymentIds: ["x"], pin: PIN_OWNER }),
    ];
    for (const r of calls) {
      assert.strictEqual(r.status, 403, `expected 403, got ${r.status} — ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body?.code, "OWNER_ONLY");
    }
  });

  await test("payroll is NOT a grantable capability — the permission list is unchanged", async () => {
    const { PERMISSIONS } = require("../src/middleware/requirePermission");
    assert.deepStrictEqual(
      [...PERMISSIONS].sort(),
      ["canManagePayables", "canTransfer", "canViewBalance", "canViewReports"],
      "adding a payroll permission would let a staff member schedule their own pay",
    );
  });

  await test("another owner cannot see or touch this owner's schedule", async () => {
    const list = await GET("/payroll", tOther);
    assert.strictEqual(list.status, 200);
    assert.strictEqual(list.body.length, 0);
    const patch = await PATCH(`/payroll/${sched1.id}`, tOther, { status: "paused" });
    assert.strictEqual(patch.status, 404);
  });

  // ══ 2. SETUP GUARDS ═════════════════════════════════════════════════════
  section("2. setup guards");
  await seed();

  await test("creating a schedule without a PIN is refused", async () => {
    const r = await mkSchedule({ pin: undefined });
    // 400 for a malformed/absent PIN, 401 for a wrong one — both are refusals.
    assert.ok([400, 401].includes(r.status), `expected a refusal, got ${r.status}`);
    assert.strictEqual(await prisma.salarySchedule.count(), 0, "no schedule may exist after a refused PIN");
  });

  await test("a wrong PIN is refused", async () => {
    const r = await mkSchedule({ pin: "9999" });
    assert.strictEqual(r.status, 401);
    assert.strictEqual(r.body?.code, "PIN_WRONG");
  });

  await test("the payee name comes from the BANK, not the request body", async () => {
    const r = await mkSchedule({ accountName: "TOTALLY MADE UP NAME" });
    assert.strictEqual(r.status, 201);
    // The stub resolves to "BANK VERIFIED NAME <last4>".
    assert.ok(/BANK VERIFIED NAME/.test(r.body.accountName), `got ${r.body.accountName}`);
    assert.strictEqual(r.body.nameVerified, true);
  });

  await test("a second schedule for the same person is refused by the unique key", async () => {
    const r = await mkSchedule();
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.body?.code, "ALREADY_SCHEDULED");
  });

  await test("a FREE-plan owner gets PRO_REQUIRED", async () => {
    await prisma.user.update({ where: { id: owner.id }, data: { plan: "FREE" } });
    const r = await mkSchedule({ staffUserId: staff2.id });
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.body?.code, "PRO_REQUIRED");
    await prisma.user.update({ where: { id: owner.id }, data: { plan: "PREMIUM" } });
  });

  await test("scheduling a NON-staff user is refused", async () => {
    const r = await mkSchedule({ staffUserId: otherOwner.id });
    assert.strictEqual(r.status, 404);
  });

  await test("scheduling ANOTHER employer's staff is refused", async () => {
    const foreign = await prisma.user.create({
      data: {
        id: "sal_foreign", firstName: "Zed", lastName: "Foreign", businessName: "X",
        accountType: "STAFF", employerId: otherOwner.id, country: "NG", currency: "NGN",
        password: await bcrypt.hash("x", 4),
      },
    });
    const r = await mkSchedule({ staffUserId: foreign.id });
    assert.strictEqual(r.status, 404);
  });

  await test("an amount above the single-transfer cap is refused at SETUP, not on payday", async () => {
    const r = await mkSchedule({ staffUserId: staff2.id, amount: 99_000_000 });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body?.code, "ABOVE_SINGLE_CAP");
  });

  // ══ 3. PIN RE-AUTH ON CHANGE ════════════════════════════════════════════
  section("3. consent is amount- and payee-bound");
  await seed();
  const sched3 = (await mkSchedule()).body;

  await test("raising the salary without a PIN is refused", async () => {
    const r = await PATCH(`/payroll/${sched3.id}`, tOwner, { amount: 500_000 });
    assert.ok([400, 401].includes(r.status), `expected a refusal, got ${r.status}`);
    const row = await dbSchedule(sched3.id);
    assert.strictEqual(row.amount, 50_000, "the amount must not have moved");
  });

  await test("changing the account number without a PIN is refused", async () => {
    const r = await PATCH(`/payroll/${sched3.id}`, tOwner, { accountNumber: "9999999999" });
    assert.ok([400, 401].includes(r.status), `expected a refusal, got ${r.status}`);
  });

  await test("resuming a paused schedule without a PIN is refused", async () => {
    await PATCH(`/payroll/${sched3.id}`, tOwner, { status: "paused" });
    const r = await PATCH(`/payroll/${sched3.id}`, tOwner, { status: "active" });
    assert.ok([400, 401].includes(r.status), `expected a refusal, got ${r.status}`);
    await PATCH(`/payroll/${sched3.id}`, tOwner, { status: "active", pin: PIN_OWNER });
  });

  await test("a PIN'd amount change re-authorises consent", async () => {
    const r = await PATCH(`/payroll/${sched3.id}`, tOwner, { amount: 60_000, pin: PIN_OWNER });
    assert.strictEqual(r.status, 200);
    const row = await dbSchedule(sched3.id);
    assert.strictEqual(row.amount, 60_000);
    assert.strictEqual(row.authorizedAmount, 60_000, "consent must describe the row as it now stands");
  });

  await test("pausing needs no PIN — it spends nothing", async () => {
    const r = await PATCH(`/payroll/${sched3.id}`, tOwner, { status: "paused" });
    assert.strictEqual(r.status, 200);
  });

  await test("resuming after 3 missed months moves FORWARD, and reports the gap", async () => {
    // The catch-up bomb: the recurring engine would fire one payment per daily
    // tick until it caught up. Here the missed periods are reported, never paid.
    await prisma.salarySchedule.update({
      where: { id: sched3.id },
      data: { nextRunDate: new Date(Date.now() - 100 * 24 * 3600 * 1000) },
    });
    const r = await PATCH(`/payroll/${sched3.id}`, tOwner, { status: "active", pin: PIN_OWNER });
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.skippedPeriods >= 3, `expected >=3 skipped, got ${r.body.skippedPeriods}`);
    const row = await dbSchedule(sched3.id);
    assert.ok(new Date(row.nextRunDate) > new Date(), "nextRunDate must be in the future");
  });

  // ══ 4. THE MONEY PATH ═══════════════════════════════════════════════════
  section("4. approve — the only path that moves money");
  await seed();
  const sched4row = await dbSchedule((await mkSchedule()).body.id);
  const pay4 = await mintPayment(sched4row);

  await test("approving without a PIN moves NOTHING", async () => {
    const before = anchorCalls.length;
    const r = await POST("/payroll/approve", tOwner, { businessId: biz.id, paymentIds: [pay4.id] });
    assert.ok([400, 401].includes(r.status), `expected a refusal, got ${r.status}`);
    assert.strictEqual(anchorCalls.length, before, "no bank call may happen without a PIN");
    const row = await prisma.salaryPayment.findUnique({ where: { id: pay4.id } });
    assert.strictEqual(row.status, "pending");
  });

  await test("approving with a PIN sends exactly one payment", async () => {
    const before = anchorCalls.length;
    const r = await POST("/payroll/approve", tOwner, { businessId: biz.id, paymentIds: [pay4.id], pin: PIN_OWNER });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.paidCount, 1);
    assert.strictEqual(anchorCalls.length, before + 1, "exactly one bank call");
    const row = await prisma.salaryPayment.findUnique({ where: { id: pay4.id } });
    assert.strictEqual(row.status, "paid");
    assert.strictEqual(row.owed, false);
    assert.ok(row.executedTransactionId, "the ledger row must be linked");
  });

  await test("the transaction is booked as a TRANSFER, so AML still sees it", async () => {
    // A "salary" category would make payroll invisible to the velocity windows —
    // an unlimited-daily-spend bypass.
    const row = await prisma.salaryPayment.findUnique({ where: { id: pay4.id } });
    const tx = await prisma.transaction.findUnique({ where: { id: row.executedTransactionId } });
    assert.strictEqual(tx.category, "transfer");
    assert.strictEqual(tx.type, "expense");
  });

  await test("paying a staff member does NOT consume their own transfer cap", async () => {
    // recordedBy must be the OWNER. Stamping the payee would eat the recipient's
    // rolling-24h cap with money they never sent.
    const spend = await staffSpendLast24h(prisma, staff.id);
    assert.strictEqual(spend, 0, `salary must not count against the staff member's cap, got ${spend}`);
    const row = await prisma.salaryPayment.findUnique({ where: { id: pay4.id } });
    const tx = await prisma.transaction.findUnique({ where: { id: row.executedTransactionId } });
    assert.strictEqual(tx.recordedBy, owner.id, "recordedBy must be the approving owner");
  });

  await test("approving the SAME payment again is refused and sends nothing", async () => {
    const before = anchorCalls.length;
    const r = await POST("/payroll/approve", tOwner, { businessId: biz.id, paymentIds: [pay4.id], pin: PIN_OWNER });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(anchorCalls.length, before, "a re-approve must not re-send");
  });

  await test("TWO SIMULTANEOUS approvals of one payment send exactly once", async () => {
    const sched = await dbSchedule((await mkSchedule({ staffUserId: staff2.id })).body.id);
    const p = await mintPayment(sched, "2026-10");
    const before = anchorCalls.length;
    const [a, b] = await Promise.all([
      POST("/payroll/approve", tOwner, { businessId: biz.id, paymentIds: [p.id], pin: PIN_OWNER }),
      POST("/payroll/approve", tOwner, { businessId: biz.id, paymentIds: [p.id], pin: PIN_OWNER }),
    ]);
    const codes = [a.status, b.status].sort();
    assert.deepStrictEqual(codes, [200, 409], `expected one win one refusal, got ${codes}`);
    assert.strictEqual(anchorCalls.length, before + 1, "exactly ONE bank call for two racing approvals");
  });

  await test("an EXPIRED payment cannot be approved and moves no money", async () => {
    // Fresh seed: both staff already hold a schedule by this point, and the
    // unique key would refuse a second one.
    await seed();
    const created = await mkSchedule({ staffUserId: staff.id });
    assert.strictEqual(created.status, 201, `fixture failed: ${JSON.stringify(created.body)}`);
    const sched = await dbSchedule(created.body.id);
    const p = await mintPayment(sched, "2026-11", { expiresAt: new Date(Date.now() - 1000) });
    const before = anchorCalls.length;
    const r = await POST("/payroll/approve", tOwner, { businessId: biz.id, paymentIds: [p.id], pin: PIN_OWNER });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(anchorCalls.length, before);
  });

  await test("a batch of two is approved with ONE pin and sends exactly two", async () => {
    await seed();
    const sA = await dbSchedule((await mkSchedule({ staffUserId: staff.id })).body.id);
    const sB = await dbSchedule((await mkSchedule({ staffUserId: staff2.id })).body.id);
    const pA = await mintPayment(sA, "2026-09");
    const pB = await mintPayment(sB, "2026-09");
    const before = anchorCalls.length;
    const r = await POST("/payroll/approve", tOwner, { businessId: biz.id, paymentIds: [pA.id, pB.id], pin: PIN_OWNER });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.paidCount, 2);
    assert.strictEqual(anchorCalls.length, before + 2);
  });

  // ══ 5. STAFF DEPARTURE ══════════════════════════════════════════════════
  section("5. a departed staff member is never paid");
  await seed();

  await test("approving for a removed staff member is refused, and sends nothing", async () => {
    const sched = await dbSchedule((await mkSchedule()).body.id);
    const p = await mintPayment(sched);
    await prisma.user.update({ where: { id: staff.id }, data: { employerId: otherOwner.id } });
    const before = anchorCalls.length;
    const r = await POST("/payroll/approve", tOwner, { businessId: biz.id, paymentIds: [p.id], pin: PIN_OWNER });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.paidCount, 0, "a departed staff member must not be paid");
    assert.strictEqual(anchorCalls.length, before);
    const row = await prisma.salaryPayment.findUnique({ where: { id: p.id } });
    assert.strictEqual(row.status, "rejected");
    await prisma.user.update({ where: { id: staff.id }, data: { employerId: owner.id } });
  });

  await test("deleting a staff member cancels their pending payment AND the schedule", async () => {
    await seed();
    const sched = await dbSchedule((await mkSchedule()).body.id);
    const p = await mintPayment(sched);
    const r = await DEL(`/auth/staff/${staff.id}`, tOwner);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const row = await prisma.salaryPayment.findUnique({ where: { id: p.id } });
    assert.strictEqual(row.status, "rejected");
    assert.strictEqual(await prisma.salarySchedule.count({ where: { id: sched.id } }), 0);
  });

  await test("paid history SURVIVES the staff member being deleted", async () => {
    await seed();
    const sched = await dbSchedule((await mkSchedule()).body.id);
    const p = await mintPayment(sched);
    await POST("/payroll/approve", tOwner, { businessId: biz.id, paymentIds: [p.id], pin: PIN_OWNER });
    await DEL(`/auth/staff/${staff.id}`, tOwner);
    const row = await prisma.salaryPayment.findUnique({ where: { id: p.id } });
    assert.strictEqual(row.status, "paid", "a paid record must never be rewritten");
    assert.strictEqual(row.staffNameSnapshot, "Musa Staff", "the name snapshot keeps history readable");
  });

  // ══ 6. SKIP / REJECT ════════════════════════════════════════════════════
  section("6. skip and decline are explicit, never silent");
  await seed();

  await test("skipping clears `owed` — the only way a period is unpaid on purpose", async () => {
    const sched = await dbSchedule((await mkSchedule()).body.id);
    const p = await mintPayment(sched);
    const r = await POST(`/payroll/payments/${p.id}/skip`, tOwner, {});
    assert.strictEqual(r.status, 200);
    const row = await prisma.salaryPayment.findUnique({ where: { id: p.id } });
    assert.strictEqual(row.status, "skipped");
    assert.strictEqual(row.owed, false);
  });

  await test("declining leaves the period OWED, so it stays visible", async () => {
    const sched = await dbSchedule((await mkSchedule({ staffUserId: staff2.id })).body.id);
    const p = await mintPayment(sched, "2026-12");
    const r = await POST(`/payroll/payments/${p.id}/reject`, tOwner, { reason: "wrong amount" });
    assert.strictEqual(r.status, 200);
    const row = await prisma.salaryPayment.findUnique({ where: { id: p.id } });
    assert.strictEqual(row.status, "rejected");
    assert.strictEqual(row.owed, true, "declining does not cancel the obligation");
  });

  // ══ 7. THE RUNNER ═══════════════════════════════════════════════════════
  section("7. the runner mints, and never pays");
  await seed();
  const { processSalaryPayments, expireStaleSalaryPayments, sweepStuckSalaryApprovals } =
    require("../src/utils/salaryRunner");

  await test("the runner queues a due payment and moves NO money", async () => {
    const s = await dbSchedule((await mkSchedule()).body.id);
    await prisma.salarySchedule.update({ where: { id: s.id }, data: { nextRunDate: new Date(Date.now() - 1000) } });
    const before = anchorCalls.length;
    const n = await processSalaryPayments();
    assert.strictEqual(n, 1);
    assert.strictEqual(anchorCalls.length, before, "the cron must never call the bank");
    const p = await prisma.salaryPayment.findFirst({ where: { scheduleId: s.id } });
    assert.strictEqual(p.status, "pending");
  });

  await test("running TWICE on the same day mints ONE payment", async () => {
    // The period, not the tick, is the identity.
    const s = await prisma.salarySchedule.findFirst({});
    await prisma.salarySchedule.update({ where: { id: s.id }, data: { nextRunDate: new Date(Date.now() - 1000) } });
    const countBefore = await prisma.salaryPayment.count({ where: { scheduleId: s.id } });
    await processSalaryPayments();
    await processSalaryPayments();
    const countAfter = await prisma.salaryPayment.count({ where: { scheduleId: s.id } });
    assert.ok(countAfter <= countBefore + 1, `expected at most one new payment, got ${countAfter - countBefore}`);
  });

  await test("a schedule whose amount was changed WITHOUT a PIN pays nobody", async () => {
    await seed();
    const s = await dbSchedule((await mkSchedule()).body.id);
    // Simulate a code path that writes `amount` without re-authorising.
    await prisma.salarySchedule.update({
      where: { id: s.id },
      data: { amount: 999_000, nextRunDate: new Date(Date.now() - 1000) },
    });
    const n = await processSalaryPayments();
    assert.strictEqual(n, 0, "drifted consent must mint nothing");
    const row = await dbSchedule(s.id);
    assert.strictEqual(row.status, "suspended");
  });

  await test("expiry leaves the period OWED and never pays it", async () => {
    await seed();
    const s = await dbSchedule((await mkSchedule()).body.id);
    const p = await mintPayment(s, "2026-09", { expiresAt: new Date(Date.now() - 1000) });
    const n = await expireStaleSalaryPayments();
    assert.strictEqual(n, 1);
    const row = await prisma.salaryPayment.findUnique({ where: { id: p.id } });
    assert.strictEqual(row.status, "expired");
    assert.strictEqual(row.owed, true);
  });

  await test("a stranded approval is parked FAILED, never returned to pending", async () => {
    await seed();
    const s = await dbSchedule((await mkSchedule()).body.id);
    const p = await mintPayment(s, "2026-09", {
      status: "approving",
      decidedAt: new Date(Date.now() - 20 * 60 * 1000),
      claimToken: "stale-token",
    });
    const n = await sweepStuckSalaryApprovals();
    assert.strictEqual(n, 1);
    const row = await prisma.salaryPayment.findUnique({ where: { id: p.id } });
    assert.strictEqual(row.status, "failed", "re-offering an ambiguous payment is how you pay twice");
  });

  await test("the reaper never touches a payment mid-approval", async () => {
    await seed();
    const s = await dbSchedule((await mkSchedule()).body.id);
    const p = await mintPayment(s, "2026-09", { status: "approving", decidedAt: new Date(), claimToken: "fresh" });
    await expireStaleSalaryPayments();
    await sweepStuckSalaryApprovals();
    const row = await prisma.salaryPayment.findUnique({ where: { id: p.id } });
    assert.strictEqual(row.status, "approving");
  });

  // ══ 8. STAFF SEE NOTHING ════════════════════════════════════════════════
  section("8. staff see nothing");

  await test("no notification is EVER addressed to a staff member", async () => {
    // The strongest available assertion that this feature is invisible to them.
    const n = await prisma.appNotification.count({ where: { userId: { in: [staff.id, staff2.id] } } });
    assert.strictEqual(n, 0, `${n} notification(s) leaked to staff`);
  });

  await test("no salary row is reachable through the transfers approval queue", async () => {
    const r = await GET("/transfers/approvals", tStaff);
    if (r.status === 200) {
      const rows = Array.isArray(r.body) ? r.body : r.body?.requests || [];
      for (const row of rows) {
        assert.ok(!row.periodKey, "a salary payment must never surface in the transfer queue");
      }
    }
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
