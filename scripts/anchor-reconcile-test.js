// The Anchor reconcile poller against a REAL Postgres, with Anchor's
// /transactions list stubbed: a credit the webhook already booked is never
// booked a second time, whichever order the two writers ran in.
//
// Each assertion names the bug it keeps dead:
//   * the webhook books a credit as anc_pay_<paymentId>, the list shows it with
//     no Payment link, and the poller books it again as "Anonymous sender"
//     (live 2026-10-14: ₦6,300 counted twice; seven such rows since July)
//   * a row the webhook repaired (re-keyed to anc_pay_) booked again
//   * two same-amount credits collapsed into one, or a missed credit swallowed
//   * a credit with a Payment link double-booked under a second key
//
//   TEST_DATABASE_URL=postgresql://... node scripts/anchor-reconcile-test.js

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  console.error("Refusing to run without TEST_DATABASE_URL.");
  process.exit(1);
}
if (/render\.com|amazonaws|\.prod/.test(url)) {
  console.error("TEST_DATABASE_URL looks hosted/production. Refusing.");
  process.exit(1);
}
process.env.DATABASE_URL = url;
process.env.NODE_ENV = "test";
process.env.ANCHOR_BASE_URL = "https://anchor.test.local";
process.env.ANCHOR_API_KEY = "test-key";

const assert = require("assert");
const prisma = require("../src/utils/db");
const { reconcileBusiness } = require("../src/utils/anchorReconcile");

let passed = 0;
let failed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  PASS ${name}`);
  } catch (e) {
    failed++;
    failures.push(`${name}: ${e.message}`);
    console.log(`  FAIL ${name}\n       ${e.message}`);
  }
}

// Anchor's list as the stub serves it. A credit: { id, amount (naira), at,
// paymentId? } → the live shape (kobo amounts, no payment link unless given).
let LIST = [];
global.fetch = async (u) => {
  if (!String(u).startsWith("https://anchor.test.local/transactions")) throw new Error(`unexpected fetch ${u}`);
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
};

const OWNER = "arc_owner";
const BIZ = "arc_biz";
let biz;
const ago = (min) => new Date(Date.now() - min * 60000);

async function wipe() {
  await prisma.invoicePayment.deleteMany({ where: { invoice: { businessId: BIZ } } }).catch(() => {});
  await prisma.transaction.deleteMany({ where: { businessId: BIZ } });
  await prisma.appNotification.deleteMany({ where: { userId: OWNER } });
  await prisma.business.deleteMany({ where: { id: BIZ } });
  await prisma.user.deleteMany({ where: { id: OWNER } });
}
async function reset() {
  await prisma.transaction.deleteMany({ where: { businessId: BIZ } });
  LIST = [];
}
// A row as the webhook books it.
const webhookRow = (paymentId, amount, at, over = {}) =>
  prisma.transaction.create({
    data: {
      businessId: BIZ, userId: OWNER, type: "income", amount, category: "transfer", paymentMethod: "bank",
      date: at, source: "anchor", currency: "NGN", description: "Transfer received from ADA OBI (GTBank Plc) · ",
      senderName: "ADA OBI", reference: `anc_pay_${paymentId}`, providerTxnId: paymentId, ...over,
    },
  });
const rows = () => prisma.transaction.findMany({ where: { businessId: BIZ }, orderBy: { date: "asc" } });
const run = () => reconcileBusiness(biz);

(async () => {
  console.log("\nANCHOR RECONCILE — no credit booked twice (real DB, stubbed Anchor list)");
  await wipe();
  await prisma.user.create({
    data: { id: OWNER, email: "arc_owner@t.local", password: "x", businessName: "Recon Co", country: "NG", currency: "NGN", firstName: "Re", lastName: "Con", accountType: "OWNER" },
  });
  biz = await prisma.business.create({
    data: { id: BIZ, userId: OWNER, name: "Recon Co", country: "NG", baseCurrency: "NGN", anchorAccountId: "arc-dep-1" },
  });

  await test("webhook first, list without a Payment link: claimed, not booked again (the live bug)", async () => {
    await reset();
    const at = ago(20);
    const w = await webhookRow("pay1-anc_inb_trsf", 6300, at);
    LIST = [{ id: "txn1-anc_txn", amount: 6300, at: new Date(at.getTime() + 3000) }];
    assert.strictEqual(await run(), 0);
    const all = await rows();
    assert.strictEqual(all.length, 1, "one row only");
    assert.strictEqual(all[0].id, w.id);
    assert.strictEqual(all[0].reference, "anc_pay_pay1-anc_inb_trsf", "the webhook's key stays");
    assert.strictEqual(all[0].providerTxnId, "txn1-anc_txn", "the list id is recorded on it");
  });

  await test("the next tick finds the claimed row and books nothing", async () => {
    assert.strictEqual(await run(), 0);
    assert.strictEqual((await rows()).length, 1);
  });

  await test("a row the webhook repaired (re-keyed, list id kept) is never booked again", async () => {
    await reset();
    const at = ago(30);
    await webhookRow("pay2-anc_inb_trsf", 2500, at, { providerTxnId: "txn2-anc_txn" });
    LIST = [{ id: "txn2-anc_txn", amount: 2500, at }];
    assert.strictEqual(await run(), 0);
    assert.strictEqual((await rows()).length, 1);
  });

  await test("two same-amount credits the webhook booked: each claims one row, nothing new", async () => {
    await reset();
    const at = ago(25);
    await webhookRow("pay3a-anc_inb_trsf", 1000, at);
    await webhookRow("pay3b-anc_inb_trsf", 1000, new Date(at.getTime() + 60000));
    LIST = [
      { id: "txn3a-anc_txn", amount: 1000, at: new Date(at.getTime() + 2000) },
      { id: "txn3b-anc_txn", amount: 1000, at: new Date(at.getTime() + 62000) },
    ];
    assert.strictEqual(await run(), 0);
    const all = await rows();
    assert.strictEqual(all.length, 2);
    assert.deepStrictEqual(all.map((r) => r.providerTxnId).sort(), ["txn3a-anc_txn", "txn3b-anc_txn"]);
  });

  await test("a third same-amount credit the webhook missed is still booked (once)", async () => {
    await reset();
    const at = ago(25);
    await webhookRow("pay4a-anc_inb_trsf", 1000, at);
    await webhookRow("pay4b-anc_inb_trsf", 1000, new Date(at.getTime() + 60000));
    LIST = [
      { id: "txn4a-anc_txn", amount: 1000, at: new Date(at.getTime() + 2000) },
      { id: "txn4b-anc_txn", amount: 1000, at: new Date(at.getTime() + 62000) },
      { id: "txn4c-anc_txn", amount: 1000, at: new Date(at.getTime() + 120000) },
    ];
    assert.strictEqual(await run(), 1);
    assert.strictEqual((await rows()).length, 3);
    assert.strictEqual(await run(), 0, "and not again on the next tick");
    assert.strictEqual((await rows()).length, 3);
  });

  await test("a credit the webhook never saw is booked as before (anc_txn_ key)", async () => {
    await reset();
    LIST = [{ id: "txn5-anc_txn", amount: 4200, at: ago(15) }];
    assert.strictEqual(await run(), 1);
    const all = await rows();
    assert.strictEqual(all.length, 1);
    assert.strictEqual(all[0].reference, "anc_txn_txn5-anc_txn");
    assert.strictEqual(await run(), 0);
  });

  await test("a different amount or a time outside the window is not taken for a twin", async () => {
    await reset();
    const at = ago(40);
    await webhookRow("pay6-anc_inb_trsf", 3000, at);
    LIST = [
      { id: "txn6a-anc_txn", amount: 3000.5, at },
      { id: "txn6b-anc_txn", amount: 3000, at: new Date(at.getTime() + 6 * 60000) },
    ];
    assert.strictEqual(await run(), 2);
    const w = (await rows()).find((r) => r.reference === "anc_pay_pay6-anc_inb_trsf");
    assert.strictEqual(w.providerTxnId, "pay6-anc_inb_trsf", "the webhook row stays unclaimed");
  });

  await test("a credit with a Payment link the webhook booked: skipped by its key", async () => {
    await reset();
    const at = ago(20);
    await webhookRow("pay7-anc_inb_trsf", 900, at);
    LIST = [{ id: "txn7-anc_txn", amount: 900, at, paymentId: "pay7-anc_inb_trsf" }];
    assert.strictEqual(await run(), 0);
    assert.strictEqual((await rows()).length, 1);
  });

  await test("a fresh credit (under 10 minutes) waits for the webhook", async () => {
    await reset();
    LIST = [{ id: "txn8-anc_txn", amount: 700, at: ago(3) }];
    assert.strictEqual(await run(), 0);
    assert.strictEqual((await rows()).length, 0);
  });

  // ── The one-off repair of the duplicates booked before the fix ──
  const { spawnSync } = require("child_process");
  const repair = (...extra) => {
    const r = spawnSync(process.execPath, ["scripts/repair-anchor-duplicates.js", ...extra], {
      cwd: require("path").join(__dirname, ".."), env: { ...process.env, DATABASE_URL: url }, encoding: "utf8",
    });
    const line = (r.stdout || "").split(/\r?\n/).find((l) => l.startsWith("RESULT ")) || "";
    return { status: r.status, out: r.stdout + r.stderr, result: line ? JSON.parse(line.slice(7)) : null };
  };
  // A row as the old poller booked it.
  const pollerRow = (listId, amount, at, over = {}) =>
    prisma.transaction.create({
      data: {
        businessId: BIZ, userId: OWNER, type: "income", amount, category: "transfer", paymentMethod: "bank",
        date: at, source: "anchor", currency: "NGN", description: `Transfer received from Anonymous sender · Ref: ${listId}`,
        reference: `anc_txn_${listId}`, providerTxnId: listId, ...over,
      },
    });

  await test("repair: removes the poller's copy, keeps the webhook's row, leaves a genuine second credit", async () => {
    await reset();
    await prisma.business.update({ where: { id: BIZ }, data: { booksLockDate: null } });
    const at = ago(600);
    const w1 = await webhookRow("rp1-anc_inb_trsf", 6300, at);
    const d1 = await pollerRow("rt1-anc_txn", 6300, new Date(at.getTime() + 3000));
    // Same amount 22 minutes later, no webhook row of its own: a real credit.
    const real = await pollerRow("rt2-anc_txn", 6300, new Date(at.getTime() + 22 * 60000));
    // A copy something points at: listed, never removed.
    const w3 = await webhookRow("rp3-anc_inb_trsf", 1500, at);
    const d3 = await pollerRow("rt3-anc_txn", 1500, at, { purpose: "owner_funding" });

    const dry = repair("--dry-run");
    assert.strictEqual(dry.status, 0, dry.out);
    assert.strictEqual(dry.result.pairs, 2);
    assert.strictEqual(dry.result.wouldRemove, 1);
    assert.strictEqual(dry.result.amount, 6300);
    assert.strictEqual(dry.result.left, 1);
    assert.strictEqual((await rows()).length, 5, "a dry run writes nothing");

    const go = repair();
    assert.strictEqual(go.status, 0, go.out);
    assert.strictEqual(go.result.removed, 1);
    const ids = (await rows()).map((r) => r.id);
    assert.ok(!ids.includes(d1.id), "the copy is gone");
    for (const keep of [w1.id, real.id, w3.id, d3.id]) assert.ok(ids.includes(keep), "the rest stay");
    const kept = await prisma.transaction.findUnique({ where: { id: w1.id } });
    assert.strictEqual(kept.reference, "anc_pay_rp1-anc_inb_trsf");
    assert.strictEqual(kept.providerTxnId, "rt1-anc_txn", "the kept row now carries the list id");
    const log = await prisma.auditLog.findFirst({ where: { action: "ANCHOR_DUPLICATE_REMOVED", resourceId: d1.id } });
    assert.ok(log && log.metadata.deleted.id === d1.id, "the deleted row is in the audit log");

    // The fixed poller sees that credit on Anchor's list again: nothing booked.
    LIST = [{ id: "rt1-anc_txn", amount: 6300, at: new Date(at.getTime() + 3000) }];
    assert.strictEqual(await run(), 0);
    assert.strictEqual(repair("--dry-run").result.wouldRemove, 0, "a second run finds nothing to remove");
  });

  await test("repair: a copy dated inside the books lock is left unless --include-locked", async () => {
    await reset();
    const at = ago(3 * 24 * 60);
    await webhookRow("rp4-anc_inb_trsf", 800, at);
    const d4 = await pollerRow("rt4-anc_txn", 800, at);
    await prisma.business.update({ where: { id: BIZ }, data: { booksLockDate: require("../src/utils/books").dayKey(new Date(Date.now() - 86400000)) } });
    const r1 = repair();
    assert.strictEqual(r1.result.removed, 0);
    assert.strictEqual(r1.result.left, 1);
    assert.ok(await prisma.transaction.findUnique({ where: { id: d4.id } }));
    const r2 = repair("--include-locked");
    assert.strictEqual(r2.result.removed, 1);
    assert.strictEqual(await prisma.transaction.findUnique({ where: { id: d4.id } }), null);
    await prisma.business.update({ where: { id: BIZ }, data: { booksLockDate: null } });
  });

  await wipe();
  await prisma.$disconnect();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failures.length) console.log("FAILURES:\n" + failures.map((f) => "  - " + f).join("\n"));
  process.exitCode = failed ? 1 : 0;
})().catch(async (e) => {
  console.error("\nHARNESS ERROR:", e);
  await wipe().catch(() => {});
  await prisma.$disconnect().catch(() => {});
  process.exitCode = 1;
});
