// End-to-end test of the staff transfer approval queue against a REAL Postgres.
//
// The unit tests cover arithmetic. This covers the things only a database can
// answer, and each is a way real money gets sent twice or lost:
//
//   1. Two owners tapping approve at the same instant must produce ONE execution.
//   2. A held request must not touch the ledger balance while it is pending.
//   3. The unique idempotency key must actually reject a duplicate.
//   4. Reject must not be able to race an in-flight approval.
//   5. The expiry reaper must not touch a row that is mid-approval.
//
// Point it at a SCRATCH database. It creates and drops its own rows.
//
//   TEST_DATABASE_URL=postgresql://... node scripts/staff-approval-db-test.js

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  console.error("Refusing to run without TEST_DATABASE_URL. This test writes and deletes rows.");
  process.exit(1);
}
if (/render\.com|amazonaws|\.prod/.test(url)) {
  console.error("TEST_DATABASE_URL looks like a hosted/production database. Refusing.");
  process.exit(1);
}

// src/utils/db.js builds its pool from DATABASE_URL at require time, and
// computeLedgerBalance goes through it. Pin it to the scratch database BEFORE
// anything requires that module, so a stray DATABASE_URL in the environment
// can't point half of this test at a different database than the other half.
process.env.DATABASE_URL = url;

const assert = require("assert");
const { PrismaPg } = require("@prisma/adapter-pg");
const { PrismaClient } = require("@prisma/client");
const { Pool } = require("pg");

const pool = new Pool({ connectionString: url });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

const { expireStaleRequests, staffSpendLast24h, APPROVAL_TTL_MS } =
  require("../src/utils/staffTransferCap");

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); failed++; }
}

const ID = (s) => `stest_${s}`;
let owner, staff, biz;

async function seed() {
  await cleanup();
  owner = await prisma.user.create({
    data: { id: ID("owner"), email: `${ID("owner")}@t.local`, password: "x", firstName: "Ada", lastName: "Owner", accountType: "OWNER", businessName: "Test Co" },
  });
  staff = await prisma.user.create({
    data: { id: ID("staff"), email: `${ID("staff")}@t.local`, password: "x", firstName: "Ben", lastName: "Staff", accountType: "STAFF", employerId: owner.id, businessName: "Test Co" },
  });
  biz = await prisma.business.create({
    data: { id: ID("biz"), userId: owner.id, name: "Test Co", country: "NG", baseCurrency: "NGN" },
  });
}

async function cleanup() {
  await prisma.staffTransferRequest.deleteMany({ where: { ownerId: ID("owner") } }).catch(() => {});
  await prisma.transaction.deleteMany({ where: { businessId: ID("biz") } }).catch(() => {});
  await prisma.staffPermission.deleteMany({ where: { userId: ID("staff") } }).catch(() => {});
  await prisma.business.deleteMany({ where: { id: ID("biz") } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: [ID("owner"), ID("staff")] } } }).catch(() => {});
}

const makeRequest = (over = {}) =>
  prisma.staffTransferRequest.create({
    data: {
      businessId: biz.id, requestedById: staff.id, ownerId: owner.id,
      accountNumber: "0123456789", bankCode: "058", accountName: "Jane Payee",
      amount: 75000, currency: "NGN", status: "pending",
      idempotencyKey: `kbsa_${Math.random().toString(36).slice(2)}${Date.now()}`,
      expiresAt: new Date(Date.now() + APPROVAL_TTL_MS),
      ...over,
    },
  });

// The exact claim the approve route makes. If this ever stops being atomic,
// two approvals both proceed to spend money.
const claim = (id) =>
  prisma.staffTransferRequest.updateMany({
    where: { id, status: "pending" },
    data: { status: "approving", decidedById: owner.id, decidedAt: new Date() },
  });

(async () => {
  console.log("\nstaff transfer approval — against a real database\n");
  await seed();

  await test("two simultaneous approvals: exactly ONE claim wins", async () => {
    const r = await makeRequest();
    // Fired together, not sequentially — this is the double-tap.
    const results = await Promise.all([claim(r.id), claim(r.id), claim(r.id)]);
    const winners = results.filter((x) => x.count === 1).length;
    assert.strictEqual(winners, 1, `${winners} callers would have sent money`);
    const after = await prisma.staffTransferRequest.findUnique({ where: { id: r.id } });
    assert.strictEqual(after.status, "approving");
  });

  await test("a claim on an already-executed request wins nothing", async () => {
    const r = await makeRequest({ status: "executed" });
    const c = await claim(r.id);
    assert.strictEqual(c.count, 0);
  });

  await test("the idempotency key is genuinely unique at the DB level", async () => {
    const r = await makeRequest();
    await assert.rejects(
      () => makeRequest({ idempotencyKey: r.idempotencyKey }),
      (e) => e.code === "P2002",
      "a duplicate key must be refused by the constraint, not just by application code",
    );
  });

  await test("a pending request does NOT move the ledger balance", async () => {
    const { computeLedgerBalance } = require("../src/utils/ledgerBalance");
    const before = await computeLedgerBalance(biz.id);
    await makeRequest({ amount: 5_000_000 });
    const after = await computeLedgerBalance(biz.id);
    assert.deepStrictEqual(
      JSON.parse(JSON.stringify(after)),
      JSON.parse(JSON.stringify(before)),
      "money that has not moved must not appear in the ledger",
    );
  });

  await test("reject cannot steal a request that approve already claimed", async () => {
    const r = await makeRequest();
    const won = await claim(r.id);
    assert.strictEqual(won.count, 1);
    // The reject route's guarded write, running after the claim.
    const rejected = await prisma.staffTransferRequest.updateMany({
      where: { id: r.id, ownerId: owner.id, status: "pending" },
      data: { status: "rejected" },
    });
    assert.strictEqual(rejected.count, 0, "an in-flight transfer must not be markable as rejected");
  });

  await test("the reaper expires a lapsed pending request", async () => {
    const r = await makeRequest({ expiresAt: new Date(Date.now() - 1000) });
    const n = await expireStaleRequests(prisma);
    assert.ok(n >= 1);
    const after = await prisma.staffTransferRequest.findUnique({ where: { id: r.id } });
    assert.strictEqual(after.status, "expired");
  });

  await test("the reaper leaves a mid-approval request alone, even past expiry", async () => {
    const r = await makeRequest({ status: "approving", expiresAt: new Date(Date.now() - 1000) });
    await expireStaleRequests(prisma);
    const after = await prisma.staffTransferRequest.findUnique({ where: { id: r.id } });
    assert.strictEqual(after.status, "approving", "expiring an in-flight send would strand real money");
  });

  await test("an approval stranded mid-flight becomes FAILED, not pending", async () => {
    // A killed process leaves "approving" with no catch to clean it up. It must
    // become terminal: re-offering an ambiguous send could pay twice.
    const { sweepStuckApprovals } = require("../src/utils/staffTransferCap");
    const r = await makeRequest({ status: "approving", decidedAt: new Date(Date.now() - 60 * 60 * 1000) });
    await sweepStuckApprovals(prisma);
    const after = await prisma.staffTransferRequest.findUnique({ where: { id: r.id } });
    assert.strictEqual(after.status, "failed");
    assert.notStrictEqual(after.status, "pending");
    // And a terminal row is not claimable, so it can never execute again.
    assert.strictEqual((await claim(r.id)).count, 0);
  });

  await test("an approval in flight RIGHT NOW is not swept", async () => {
    const { sweepStuckApprovals } = require("../src/utils/staffTransferCap");
    const r = await makeRequest({ status: "approving", decidedAt: new Date() });
    await sweepStuckApprovals(prisma);
    const after = await prisma.staffTransferRequest.findUnique({ where: { id: r.id } });
    assert.strictEqual(after.status, "approving", "killing a live approval would strand real money");
  });

  await test("the same client idempotency key cannot create two held requests", async () => {
    // The retry path: one intent, one row. Two rows means the owner can approve
    // the same transfer twice and pay the beneficiary twice.
    const key = `kbsa_dup${Date.now()}`;
    await makeRequest({ idempotencyKey: key });
    await assert.rejects(() => makeRequest({ idempotencyKey: key }), (e) => e.code === "P2002");
  });

  await test("a held request records whether the payee name was bank-verified", async () => {
    const unverified = await makeRequest({ accountName: "ACME Suppliers Ltd", nameVerified: false });
    assert.strictEqual(unverified.nameVerified, false,
      "an unchecked, staff-supplied name must be flagged so the owner is not misled");
    const verified = await makeRequest({ accountName: "REAL NAME", nameVerified: true });
    assert.strictEqual(verified.nameVerified, true);
  });

  await test("the reaper leaves an unexpired request alone", async () => {
    const r = await makeRequest();
    await expireStaleRequests(prisma);
    const after = await prisma.staffTransferRequest.findUnique({ where: { id: r.id } });
    assert.strictEqual(after.status, "pending");
  });

  await test("spend counts a staff transfer, and skips an owner-approved one", async () => {
    await prisma.transaction.deleteMany({ where: { businessId: biz.id } });
    await prisma.staffTransferRequest.deleteMany({ where: { ownerId: owner.id } });

    const normal = await prisma.transaction.create({
      data: {
        businessId: biz.id, userId: owner.id, recordedBy: staff.id,
        type: "expense", category: "transfer", source: "anchor",
        amount: 10000, fee: 100, date: new Date(), currency: "NGN",
        reference: `t_${Date.now()}_a`,
      },
    });
    assert.strictEqual(await staffSpendLast24h(prisma, staff.id), 10100);

    const approvedTxn = await prisma.transaction.create({
      data: {
        businessId: biz.id, userId: owner.id, recordedBy: staff.id,
        type: "expense", category: "transfer", source: "anchor",
        amount: 500000, fee: 100, date: new Date(), currency: "NGN",
        reference: `t_${Date.now()}_b`,
      },
    });
    // Before the request row exists, the big transfer counts.
    assert.strictEqual(await staffSpendLast24h(prisma, staff.id), 510200);

    await makeRequest({
      status: "executed", amount: 500000,
      executedTransactionId: approvedTxn.id, decidedAt: new Date(),
    });
    // Once it is linked to an owner approval, it stops counting.
    assert.strictEqual(await staffSpendLast24h(prisma, staff.id), 10100,
      "an owner-approved transfer must not consume the staff member's autonomous cap");
    void normal;
  });

  await test("a manual cash expense never counts toward the transfer cap", async () => {
    await prisma.transaction.create({
      data: {
        businessId: biz.id, userId: owner.id, recordedBy: staff.id,
        type: "expense", category: "transfer", source: "manual",
        amount: 999999, date: new Date(), currency: "NGN",
        reference: `t_${Date.now()}_c`,
      },
    });
    assert.strictEqual(await staffSpendLast24h(prisma, staff.id), 10100,
      "only provider money-out counts; bookkeeping entries are not spend");
  });

  await test("a transfer older than the window drops out", async () => {
    await prisma.transaction.create({
      data: {
        businessId: biz.id, userId: owner.id, recordedBy: staff.id,
        type: "expense", category: "transfer", source: "anchor",
        amount: 888888, date: new Date(Date.now() - 25 * 60 * 60 * 1000),
        currency: "NGN", reference: `t_${Date.now()}_d`,
      },
    });
    assert.strictEqual(await staffSpendLast24h(prisma, staff.id), 10100);
  });

  await cleanup();
  await prisma.$disconnect();
  await pool.end();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})().catch(async (e) => {
  console.error("\nharness error:", e);
  await cleanup().catch(() => {});
  await prisma.$disconnect().catch(() => {});
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
