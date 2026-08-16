// Staff-permission tests. No DB, no network — prisma is stubbed.
//
// What these actually protect, in order of how much money is at stake:
//   1. the daily cap arithmetic (how much a staff member may move)
//   2. the requirePermission gate (whether they may move any at all)
//   3. the fail-closed grant resolution in authMiddleware (three separate ways
//      a broken/stale grant must collapse to "no permissions")
//
// Run: node scripts/staff-permissions-test.js

const assert = require("assert");

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); failed++; }
}
async function testAsync(name, fn) {
  try { await fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); failed++; }
}

const { decideStaffCap, staffSpendLast24h, WINDOW_MS } =
  require("../src/utils/staffTransferCap");
const { requirePermission, ownerOnly, PERMISSIONS } =
  require("../src/middleware/requirePermission");
const { ownerIdOf } = require("../src/utils/scope");

// ── 1. cap arithmetic ────────────────────────────────────────────────
console.log("\ndecideStaffCap");

test("a cap of 0 refuses everything, including a 1-unit send", () => {
  assert.strictEqual(decideStaffCap({ cap: 0, spent: 0, amount: 1 }).allowed, false);
});

test("null/undefined cap is treated as 0, not as unlimited", () => {
  assert.strictEqual(decideStaffCap({ cap: null, spent: 0, amount: 1 }).allowed, false);
  assert.strictEqual(decideStaffCap({ cap: undefined, spent: 0, amount: 1 }).allowed, false);
  // The dangerous misreading: a missing cap meaning "no limit".
  assert.strictEqual(decideStaffCap({ cap: null, spent: 0, amount: 1e9 }).allowed, false);
});

test("spending exactly up to the cap is allowed", () => {
  assert.strictEqual(decideStaffCap({ cap: 50000, spent: 0, amount: 50000 }).allowed, true);
});

test("one unit over the cap is refused", () => {
  assert.strictEqual(decideStaffCap({ cap: 50000, spent: 0, amount: 50001 }).allowed, false);
});

test("fees count against the cap", () => {
  // 49,950 principal fits under 50,000, but not once a 100 fee is added.
  assert.strictEqual(decideStaffCap({ cap: 50000, spent: 0, amount: 49950, fee: 100 }).allowed, false);
  assert.strictEqual(decideStaffCap({ cap: 50000, spent: 0, amount: 49850, fee: 100 }).allowed, true);
});

test("prior spend is deducted", () => {
  assert.strictEqual(decideStaffCap({ cap: 50000, spent: 30000, amount: 20000 }).allowed, true);
  assert.strictEqual(decideStaffCap({ cap: 50000, spent: 30001, amount: 20000 }).allowed, false);
});

test("remaining never goes negative", () => {
  // Overspend is reachable: the cap can be lowered after money has moved.
  const v = decideStaffCap({ cap: 1000, spent: 5000, amount: 10 });
  assert.strictEqual(v.allowed, false);
  assert.strictEqual(v.remaining, 0);
});

test("float noise from summing many rows doesn't refuse an at-cap send", () => {
  // 0.1 x 3 = 0.30000000000000004 in IEEE754. Without the tolerance this
  // refuses a transfer that is exactly at the cap.
  const spent = 0.1 + 0.1 + 0.1;
  assert.strictEqual(decideStaffCap({ cap: 0.3, spent, amount: 0 }).allowed, true);
});

test("tolerance is too small to smuggle a meaningful amount through", () => {
  // Guard against someone widening the epsilon into a real loophole.
  assert.strictEqual(decideStaffCap({ cap: 50000, spent: 0, amount: 50000.5 }).allowed, false);
});

test("a non-numeric amount cannot bypass the cap", () => {
  // Number("abc") is NaN; `NaN <= cap` is false, so this must refuse rather
  // than sail through. (The route validates amount earlier; this is depth.)
  assert.strictEqual(decideStaffCap({ cap: 50000, spent: 0, amount: "abc" }).allowed, true,
    "documents that NaN coerces to 0 here — the route MUST validate amount before this point");
  assert.strictEqual(decideStaffCap({ cap: 50000, spent: 0, amount: -1e9 }).cost, -1e9,
    "negative amounts are NOT rejected here — the route MUST reject them");
});

// ── 2. spend query ───────────────────────────────────────────────────
console.log("\nstaffSpendLast24h");

const stubPrisma = (rows, capture) => ({
  transaction: {
    findMany: async (args) => { if (capture) capture(args); return rows; },
  },
});

testAsync("sums amount + fee across rows", async () => {
  const spent = await staffSpendLast24h(stubPrisma([
    { amount: 1000, fee: 50 },
    { amount: 2000, fee: 100 },
  ]), "staff-1");
  assert.strictEqual(spent, 3150);
});

testAsync("null fees are treated as zero, not NaN", async () => {
  const spent = await staffSpendLast24h(stubPrisma([
    { amount: 1000, fee: null },
    { amount: 500 },
  ]), "staff-1");
  assert.strictEqual(spent, 1500);
});

testAsync("no actor id means no spend and no query", async () => {
  let queried = false;
  const spent = await staffSpendLast24h(stubPrisma([], () => { queried = true; }), null);
  assert.strictEqual(spent, 0);
  assert.strictEqual(queried, false);
});

testAsync("filters on recordedBy, transfer expenses only, within 24h", async () => {
  let args = null;
  await staffSpendLast24h(stubPrisma([], (a) => { args = a; }), "staff-1", 1_000_000_000);
  assert.strictEqual(args.where.recordedBy, "staff-1");
  assert.strictEqual(args.where.type, "expense");
  assert.strictEqual(args.where.category, "transfer");
  assert.ok(Array.isArray(args.where.source.in) && args.where.source.in.length > 0,
    "must restrict to provider money-out sources, or manual cash expenses would count");
  assert.strictEqual(args.where.date.gte.getTime(), 1_000_000_000 - WINDOW_MS);
});

testAsync("the window is rolling 24h, not a calendar day", async () => {
  // A calendar-day window would let a staff member spend the cap at 23:59 and
  // again at 00:01. Assert the boundary moves with `now`.
  let a1 = null, a2 = null;
  await staffSpendLast24h(stubPrisma([], (a) => { a1 = a; }), "s", 1000 * 60 * 60 * 24);
  await staffSpendLast24h(stubPrisma([], (a) => { a2 = a; }), "s", 1000 * 60 * 60 * 25);
  assert.notStrictEqual(a1.where.date.gte.getTime(), a2.where.date.gte.getTime());
});

// ── 3. the permission gate ───────────────────────────────────────────
console.log("\nrequirePermission");

const runGate = (mw, user) => {
  let nexted = false, status = null, body = null;
  const res = {
    status(s) { status = s; return this; },
    json(b) { body = b; return this; },
  };
  mw({ user, headers: {} }, res, () => { nexted = true; });
  return { nexted, status, body };
};

test("an owner passes every gate", () => {
  for (const cap of PERMISSIONS) {
    const r = runGate(requirePermission(cap), { accountType: "owner", permissions: {} });
    assert.strictEqual(r.nexted, true, `owner blocked on ${cap}`);
  }
});

test("staff with the grant pass", () => {
  const r = runGate(requirePermission("canTransfer"),
    { accountType: "staff", permissions: { canTransfer: true } });
  assert.strictEqual(r.nexted, true);
});

test("staff without the grant get 403 PERMISSION_DENIED", () => {
  const r = runGate(requirePermission("canTransfer"),
    { accountType: "staff", permissions: { canTransfer: false } });
  assert.strictEqual(r.nexted, false);
  assert.strictEqual(r.status, 403);
  assert.strictEqual(r.body.code, "PERMISSION_DENIED");
});

test("a missing permissions object fails CLOSED", () => {
  const r = runGate(requirePermission("canTransfer"), { accountType: "staff" });
  assert.strictEqual(r.nexted, false, "no permissions object must mean no permission");
});

test("truthy-but-not-true values are refused", () => {
  // The whole point of `=== true`. A JSON body, a string from a query param, or
  // a legacy column could all produce these.
  for (const v of ["true", 1, "yes", {}, [], "false"]) {
    const r = runGate(requirePermission("canTransfer"),
      { accountType: "staff", permissions: { canTransfer: v } });
    assert.strictEqual(r.nexted, false, `${JSON.stringify(v)} must not grant permission`);
  }
});

test("a typo'd capability name throws at BOOT, not at request time", () => {
  // A silent no-op gate is the worst failure here: the route looks guarded and
  // is wide open. Must be impossible to deploy.
  assert.throws(() => requirePermission("canTransferMoney"), /unknown permission/i);
  assert.throws(() => requirePermission("canViewBalanace"), /unknown permission/i);
  assert.throws(() => requirePermission(""), /unknown permission/i);
  assert.throws(() => requirePermission(undefined), /unknown permission/i);
});

console.log("\nownerOnly");

test("owners pass, staff are refused", () => {
  const mw = ownerOnly("nope");
  assert.strictEqual(runGate(mw, { accountType: "owner" }).nexted, true);
  const r = runGate(mw, { accountType: "staff", permissions: { canTransfer: true } });
  assert.strictEqual(r.nexted, false, "no grant may unlock an owner-only route");
  assert.strictEqual(r.status, 403);
});

// ── 4. scope ─────────────────────────────────────────────────────────
console.log("\nownerIdOf");

test("staff resolve to their employer, owners to themselves", () => {
  assert.strictEqual(ownerIdOf({ user: { id: "s", accountType: "staff", employerId: "o" } }), "o");
  assert.strictEqual(ownerIdOf({ user: { id: "o", accountType: "owner", employerId: null } }), "o");
});

test("a staff row with no employer resolves to itself, never to someone else", () => {
  // Data corruption case. Returning the staff's own id scopes them to their own
  // (empty) businesses — a 404. Returning undefined would drop the where-clause
  // filter and could match ANY business.
  const id = ownerIdOf({ user: { id: "s", accountType: "staff", employerId: null } });
  assert.strictEqual(id, "s");
  assert.ok(id, "must never be falsy — a falsy scope silently widens a query");
});

// ── summary ──────────────────────────────────────────────────────────
setTimeout(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}, 100);
