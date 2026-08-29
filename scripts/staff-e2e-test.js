// FULL end-to-end test of the staff-permissions feature.
//
// Runs the REAL routers, the REAL auth middleware and the REAL permission guards
// over a REAL Postgres, driven through actual HTTP. Nothing here is mocked
// except the payment provider — because the one thing this must not do is move
// real money.
//
// It answers the questions a unit test cannot:
//   * does a staff member with no grant actually get refused, on every door
//   * does granting actually work, immediately, without a re-login
//   * does the cap hold, and does the hold path produce exactly one request
//   * can a staff member reach another employer's data or another staff
//     member's request
//   * does approve move money exactly once, and land in the ledger correctly
//   * does revoking take effect on the very next request
//
// Point TEST_DATABASE_URL at a SCRATCH database. It refuses hosted URLs.
//
//   TEST_DATABASE_URL=postgresql://... node scripts/staff-e2e-test.js

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
// Keep the AML pipeline ARMED. Disabling it would hide the very interactions
// (freeze, tier caps, step-up) this test exists to exercise.
process.env.AML_ENABLED = "true";

// ── Stub the payment provider BEFORE anything requires it ────────────────────
// executeTransfer talks to Anchor. Intercepting at the module boundary means the
// route, the AML pipeline, the lock, the ledger write and the cap accounting all
// run for real; only the outbound bank call is replaced.
// Anchor's real module refuses to do anything without live API keys
// (ensureConfigured throws ANCHOR_NOT_CONFIGURED), so the methods executeTransfer
// uses are replaced wholesale. Method names must match the real export list in
// src/utils/anchor.js exactly — a typo here silently leaves the real function in
// place and the test fails for the wrong reason.
const Module = require("module");
const origLoad = Module._load;
const anchorCalls = [];       // every outbound "bank" call, so double-sends are visible
const providerCalls = [];
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

// Patch the provider SINGLETON in place. Not by wrapping getProvider and
// spreading the result — these are class instances, so `{...p}` silently drops
// everything on the prototype including supportsBanking, and every transfer
// comes back BANKING_NOT_AVAILABLE. Assigning onto the instance shadows the
// prototype method and leaves the rest of the object intact.
{
  const { getProvider } = require("../src/providers");
  const ng = getProvider("NG");
  ng.getBanks = async () => [{ code: "058", id: "bank-058", name: "GTBank" }];
  ng.verifyRecipient = async ({ accountNumber }) => {
    providerCalls.push({ fn: "verifyRecipient", accountNumber });
    return { accountName: `BANK VERIFIED NAME ${String(accountNumber).slice(-4)}` };
  };
  ng.payout = async (args) => { anchorCalls.push(args); return { id: "payout-1" }; };
  if (!ng.supportsBanking) {
    console.error("provider stub broke supportsBanking — aborting rather than testing a lie");
    process.exit(1);
  }
}
const { expireStaleRequests } = require("../src/utils/staffTransferCap");

// ── Build the app exactly as server.js mounts it (minus crons/webhooks) ──────
const app = express();
app.use(express.json({ limit: "10mb" }));
app.use("/auth", require("../src/routes/auth"));
app.use("/businesses", require("../src/routes/businesses"));
app.use("/transfers", require("../src/routes/transfers"));
app.use("/recurring-expenses", require("../src/routes/recurringExpenses").router);
app.use("/sync", require("../src/routes/sync"));
app.use("/payables", require("../src/routes/payables"));
app.use("/business-debts", require("../src/routes/businessDebts"));
app.use("/insights", require("../src/routes/insights"));

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
const section = (s) => console.log(`\n── ${s} ${"─".repeat(Math.max(0, 60 - s.length))}`);

const PIN_OWNER = "1234";
const PIN_STAFF = "5678";
let owner, staff, otherOwner, otherStaff, biz, otherBiz;
let tOwner, tStaff, tOther, tOtherStaff;

async function seed() {
  await wipe();
  const mk = async (over) =>
    prisma.user.create({
      data: {
        password: await bcrypt.hash("Password123!", 4),
        businessName: "E2E Co", country: "NG", currency: "NGN",
        transactionPin: await bcrypt.hash(over.__pin, 4),
        plan: "PREMIUM",
        ...Object.fromEntries(Object.entries(over).filter(([k]) => !k.startsWith("__"))),
      },
    });

  owner = await mk({ id: "e2e_owner", email: "e2e_owner@t.local", firstName: "Ada", lastName: "Owner", accountType: "OWNER", __pin: PIN_OWNER });
  staff = await mk({ id: "e2e_staff", email: "e2e_staff@t.local", firstName: "Ben", lastName: "Staff", accountType: "STAFF", employerId: owner.id, __pin: PIN_STAFF });
  otherOwner = await mk({ id: "e2e_other", email: "e2e_other@t.local", firstName: "Cid", lastName: "Rival", accountType: "OWNER", __pin: PIN_OWNER });
  otherStaff = await mk({ id: "e2e_ostaff", email: "e2e_ostaff@t.local", firstName: "Dee", lastName: "Rival", accountType: "STAFF", employerId: otherOwner.id, __pin: PIN_STAFF });

  biz = await prisma.business.create({
    data: { id: "e2e_biz", userId: owner.id, name: "Ada Stores", country: "NG", baseCurrency: "NGN",
            anchorAccountId: "anchor-acct-1", virtualAccountNumber: "9990001111" },
  });
  otherBiz = await prisma.business.create({
    data: { id: "e2e_obiz", userId: otherOwner.id, name: "Cid Stores", country: "NG", baseCurrency: "NGN",
            anchorAccountId: "anchor-acct-2", virtualAccountNumber: "9990002222" },
  });

  // Fund the ledger so transfers are not refused for balance. Bank credit from a
  // provider source, which is what computeLedgerBalance counts as spendable.
  await prisma.transaction.create({
    data: { businessId: biz.id, userId: owner.id, type: "income", amount: 5_000_000,
            category: "transfer", paymentMethod: "bank", source: "anchor", currency: "NGN",
            date: new Date(), reference: "e2e_funding" },
  });

  tOwner = signToken({ userId: owner.id, tokenVersion: 0 });
  tStaff = signToken({ userId: staff.id, tokenVersion: 0 });
  tOther = signToken({ userId: otherOwner.id, tokenVersion: 0 });
  tOtherStaff = signToken({ userId: otherStaff.id, tokenVersion: 0 });
}

async function wipe() {
  const ids = ["e2e_owner", "e2e_staff", "e2e_other", "e2e_ostaff"];
  const bids = ["e2e_biz", "e2e_obiz"];
  await prisma.staffTransferRequest.deleteMany({ where: { businessId: { in: bids } } }).catch(() => {});
  await prisma.complianceFlag.deleteMany({ where: { businessId: { in: bids } } }).catch(() => {});
  await prisma.beneficiary.deleteMany({ where: { businessId: { in: bids } } }).catch(() => {});
  await prisma.transaction.deleteMany({ where: { businessId: { in: bids } } }).catch(() => {});
  await prisma.recurringExpense.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
  // By userId as well as businessId. A row whose businessId is null still holds
  // an FK to User, so filtering on businessId alone leaves it behind, the User
  // delete fails, the .catch swallows it, and the NEXT run dies on a unique
  // violation while creating the same fixtures — a failure that looks like a
  // product bug and is not.
  await prisma.businessDebt.deleteMany({ where: { OR: [{ businessId: { in: bids } }, { userId: { in: ids } }] } }).catch(() => {});
  await prisma.payable.deleteMany({ where: { businessId: { in: bids } } }).catch(() => {});
  await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } }).catch(() => {});
  await prisma.staffPermission.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
  await prisma.business.deleteMany({ where: { id: { in: bids } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
}

const grant = (perms, cap) =>
  PATCH(`/auth/staff/${staff.id}/permissions`, tOwner, { pin: PIN_OWNER, permissions: perms, dailyTransferCap: cap });

const ALL_OFF = { canViewBalance: false, canTransfer: false, canViewReports: false, canManagePayables: false };

const send = (amount, over = {}) =>
  POST("/transfers/send", tStaff, {
    businessId: biz.id, accountNumber: "0123456789", bankCode: "058",
    amount, pin: PIN_STAFF, narration: "e2e", ...over,
  });

(async () => {
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  BASE = `http://127.0.0.1:${server.address().port}`;
  console.log(`\nSTAFF PERMISSIONS — FULL END-TO-END (real routers, real DB, stubbed bank)\n${BASE}`);

  await seed();

  // ══ 1. NO GRANT: every money door must be shut ═════════════════════════════
  section("1. staff with NO grant");

  await test("GET /transfers/balance is refused", async () => {
    const r = await GET(`/transfers/balance?businessId=${biz.id}`, tStaff);
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.body.code, "PERMISSION_DENIED");
  });
  await test("GET /transfers/limits is refused", async () => {
    assert.strictEqual((await GET(`/transfers/limits?businessId=${biz.id}`, tStaff)).status, 403);
  });
  await test("GET /transfers/beneficiaries is refused", async () => {
    assert.strictEqual((await GET(`/transfers/beneficiaries?businessId=${biz.id}`, tStaff)).status, 403);
  });
  await test("GET /transfers/banks is refused", async () => {
    assert.strictEqual((await GET(`/transfers/banks`, tStaff)).status, 403);
  });
  await test("POST /transfers/send is refused", async () => {
    const r = await send(1000);
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.body.code, "PERMISSION_DENIED");
  });
  await test("GET /sync withholds bank rows but KEEPS bookkeeping", async () => {
    const r = await GET(`/sync?businessId=${biz.id}`, tStaff);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.bankWithheld, true);
    assert.strictEqual(r.body.transactions.length, 0, "the bank ledger must not be handed over");
    assert.ok(Array.isArray(r.body.sales), "sales are the staff member's actual job and must remain");
  });
  await test("GET /businesses strips the account number and provider ids", async () => {
    const r = await GET(`/businesses`, tStaff);
    assert.strictEqual(r.status, 200);
    const b = r.body.find((x) => x.id === biz.id);
    assert.ok(b, "staff must still see the business itself");
    assert.strictEqual(b.virtualAccountNumber, undefined, "account number leaked");
    assert.strictEqual(b.anchorAccountId, undefined, "provider id leaked");
    assert.strictEqual(b.kycBvn, undefined, "BVN leaked");
    assert.strictEqual(b.kycBvnHash, undefined, "BVN hash leaked");
  });
  await test("GET /businesses/:id/balance is refused", async () => {
    assert.ok([403, 404].includes((await GET(`/businesses/${biz.id}/balance`, tStaff)).status));
  });
  await test("payables mutations are refused", async () => {
    const r = await POST(`/payables`, tStaff, { businessId: biz.id, creditorName: "X", amount: 100 });
    assert.strictEqual(r.status, 403);
  });
  await test("recurring auto-debits are OWNER-ONLY, not grantable", async () => {
    const r = await POST(`/recurring-expenses`, tStaff, { businessId: biz.id, amount: 100, frequency: "daily" });
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.body.code, "OWNER_ONLY");
  });
  await test("staff cannot create other staff", async () => {
    const r = await POST(`/auth/staff`, tStaff, { firstName: "Mole", password: "Password123!", email: "mole@t.local" });
    assert.strictEqual(r.status, 403);
  });
  await test("staff cannot grant THEMSELVES a capability", async () => {
    const r = await PATCH(`/auth/staff/${staff.id}/permissions`, tStaff, {
      pin: PIN_STAFF, permissions: { canTransfer: true, canViewBalance: true }, dailyTransferCap: 1e9,
    });
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.body.code, "OWNER_ONLY");
    const g = await prisma.staffPermission.findUnique({ where: { userId: staff.id } });
    assert.strictEqual(g, null, "no grant row may exist after a refused self-grant");
  });

  // ══ 1b. THE SIDE DOORS ═════════════════════════════════════════════════════
  // Same data, different route. Gating the obvious endpoint while another one
  // serves the same field is the failure mode this whole section exists for.
  section("1b. side doors into the same data");

  await test("business debts are refused", async () => {
    const r = await GET(`/business-debts?businessId=${biz.id}`, tStaff);
    assert.strictEqual(r.status, 403);
  });
  await test("/sync withholds recurring auto-debits from ALL staff", async () => {
    await prisma.recurringExpense.create({
      data: { userId: owner.id, businessId: biz.id, amount: 5000, frequency: "monthly",
              category: "rent", nextDue: new Date(), payeeAccountNumber: "0999888777" },
    });
    const r = await GET(`/sync?businessId=${biz.id}`, tStaff);
    assert.strictEqual(r.body.recurring.length, 0,
      "standing instructions are owner-only — no capability unlocks them");
  });
  await test("/sync withholds debts without canManagePayables", async () => {
    // Seed a debt FIRST. Asserting "the list is empty" against a table that was
    // already empty passes whatever the gate does — a vacuous test is worse than
    // no test, because it reads as coverage.
    await prisma.businessDebt.create({
      data: { userId: owner.id, businessId: biz.id, name: "Supplier Co", originalAmount: 250_000, remainingAmount: 250_000 },
    });
    const owned = await GET(`/sync?businessId=${biz.id}`, tOwner);
    assert.strictEqual(owned.body.debts.length, 1, "the owner must still see it — otherwise this proves nothing");
    const r = await GET(`/sync?businessId=${biz.id}`, tStaff);
    assert.strictEqual(r.body.debts.length, 0);
  });
  await test("POST /sync cannot be used to plant a business", async () => {
    const r = await POST(`/sync`, tStaff, {
      queue: [{ id: "op1", type: "add_business", data: { id: "planted_biz", name: "Mine" }, timestamp: Date.now() }],
    });
    const planted = await prisma.business.findUnique({ where: { id: "planted_biz" } });
    assert.strictEqual(planted, null, "staff must not be able to create a business they own");
    void r;
  });
  await test("the NUBAN is redacted out of DM message text", async () => {
    // The inbox is a staff surface, but payment messages spell out the account
    // number — so the inbox must not become a way to read the field
    // GET /businesses strips for them.
    const { redactAccountNumber } = require("../src/utils/instagram");
    const msg = `Bank: GTBank\nAccount Number: ${biz.virtualAccountNumber}\nAccount Name: Ada Stores`;
    const out = redactAccountNumber(msg, biz);
    assert.ok(!out.includes(biz.virtualAccountNumber), `NUBAN survived redaction: ${out}`);
    assert.ok(out.includes(biz.virtualAccountNumber.slice(-4)), "keep the last 4 so it stays recognisable");
    // An owner-visible message is returned untouched.
    assert.strictEqual(redactAccountNumber(msg, { virtualAccountNumber: null }), msg);
  });
  await test("redaction never mangles a customer's own numbers", async () => {
    const { redactAccountNumber } = require("../src/utils/instagram");
    // A generic 10-digit regex would destroy all of these. Only OUR number goes.
    const msg = "my number is 0812345678 and my ref is 1234567890";
    assert.strictEqual(redactAccountNumber(msg, biz), msg);
  });
  await test("staff cannot rebind the bank account via sync-anchor-account", async () => {
    const r = await POST(`/businesses/${biz.id}/sync-anchor-account`, tStaff, {});
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.body.code, "OWNER_ONLY");
  });
  await test("insights refuses the balance question behind canViewReports", async () => {
    // The capability that governs "how much is in my account" is canViewBalance,
    // not canViewReports. Otherwise the distinction is a phrasing trick.
    await grant({ canViewReports: true }, 0);
    const { answerQuestion } = require("../src/utils/insightsEngine");
    const withOut = await answerQuestion("what is my balance", biz, null, { canViewBalance: false });
    assert.ok(!/\d/.test(withOut.answer.replace(/[^0-9]/g, "")) || !withOut.data,
      `balance leaked through insights: ${withOut.answer}`);
    assert.strictEqual(withOut.data, undefined);
    await grant(ALL_OFF, 0);
  });

  // ══ 2. GRANTING ════════════════════════════════════════════════════════════
  section("2. granting");

  await test("granting requires the owner's transaction PIN", async () => {
    const r = await PATCH(`/auth/staff/${staff.id}/permissions`, tOwner, {
      pin: "0000", permissions: { canViewBalance: true },
    });
    assert.strictEqual(r.status, 401);
    assert.strictEqual(r.body.code, "PIN_WRONG");
  });
  await test("a wrong PIN grants NOTHING", async () => {
    // Deliberately not "no row exists": an earlier section legitimately creates
    // one. What must hold is that the REFUSED call changed no capability.
    const g = await prisma.staffPermission.findUnique({ where: { userId: staff.id } });
    assert.ok(
      !g || (!g.canViewBalance && !g.canTransfer && !g.canViewReports && !g.canManagePayables),
      "a refused PIN must not have granted anything",
    );
  });
  await test("owner cannot grant to ANOTHER employer's staff", async () => {
    const r = await PATCH(`/auth/staff/${otherStaff.id}/permissions`, tOwner, {
      pin: PIN_OWNER, permissions: { canTransfer: true }, dailyTransferCap: 1e9,
    });
    assert.strictEqual(r.status, 404);
    assert.strictEqual(await prisma.staffPermission.count({ where: { userId: otherStaff.id } }), 0);
  });
  await test("granting canViewBalance works with the correct PIN", async () => {
    const r = await grant({ canViewBalance: true }, 0);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.permissions.canViewBalance, true);
  });
  await test("the grant takes effect on the very NEXT request — no re-login", async () => {
    const r = await GET(`/transfers/balance?businessId=${biz.id}`, tStaff);
    assert.strictEqual(r.status, 200, "permissions must be read fresh from the DB, never cached in the JWT");
  });
  await test("but canTransfer is still refused — capabilities are independent", async () => {
    assert.strictEqual((await send(1000)).status, 403);
  });
  await test("/sync now returns the bank ledger", async () => {
    const r = await GET(`/sync?businessId=${biz.id}`, tStaff);
    assert.strictEqual(r.body.bankWithheld, false);
    assert.ok(r.body.transactions.length > 0);
  });
  await test("/businesses now includes the account number", async () => {
    const b = (await GET(`/businesses`, tStaff)).body.find((x) => x.id === biz.id);
    assert.strictEqual(b.virtualAccountNumber, "9990001111");
  });
  await test("...but STILL never the BVN", async () => {
    const b = (await GET(`/businesses`, tStaff)).body.find((x) => x.id === biz.id);
    assert.strictEqual(b.kycBvn, undefined);
    assert.strictEqual(b.kycBvnHash, undefined, "no capability may ever expose the owner's BVN");
  });
  await test("a cap alone, without canTransfer, grants nothing", async () => {
    await grant({ canViewBalance: true }, 999999);
    assert.strictEqual((await send(1000)).status, 403);
  });

  // ══ 3. THE CAP ═════════════════════════════════════════════════════════════
  section("3. the daily cap");

  await test("canTransfer with cap 0 HOLDS every transfer", async () => {
    await grant({ canViewBalance: true, canTransfer: true }, 0);
    const r = await send(1000);
    assert.strictEqual(r.status, 202);
    assert.strictEqual(r.body.code, "PENDING_APPROVAL");
    assert.strictEqual(await prisma.transaction.count({ where: { businessId: biz.id, type: "expense" } }), 0,
      "a held transfer must write NO ledger row");
  });
  await test("the held request stores a BANK-VERIFIED payee, not the staff member's text", async () => {
    await prisma.staffTransferRequest.deleteMany({ where: { businessId: biz.id } });
    await send(1000, { accountName: "TOTALLY LEGIT SUPPLIER LTD" });
    const r = await prisma.staffTransferRequest.findFirst({ where: { businessId: biz.id } });
    assert.strictEqual(r.nameVerified, true);
    assert.ok(r.accountName.startsWith("BANK VERIFIED"),
      `payee spoofable — stored "${r.accountName}"`);
    assert.notStrictEqual(r.accountName, "TOTALLY LEGIT SUPPLIER LTD");
  });
  await test("a retry with the SAME idempotency key does not create a second request", async () => {
    await prisma.staffTransferRequest.deleteMany({ where: { businessId: biz.id } });
    const key = "retrykey123";
    const a = await send(2000, { idempotencyKey: key });
    const b = await send(2000, { idempotencyKey: key });
    assert.strictEqual(a.status, 202);
    assert.strictEqual(b.status, 202);
    assert.strictEqual(a.body.requestId, b.body.requestId, "a retry must return the SAME request");
    assert.strictEqual(await prisma.staffTransferRequest.count({ where: { businessId: biz.id } }), 1,
      "two approvable requests for one intent = the owner can pay twice");
  });
  await test("under the cap, the transfer goes straight through", async () => {
    await prisma.staffTransferRequest.deleteMany({ where: { businessId: biz.id } });
    await grant({ canViewBalance: true, canTransfer: true }, 50_000);
    const r = await send(10_000);
    assert.strictEqual(r.status, 200, `expected send, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.status, "success");
  });
  await test("the ledger row belongs to the OWNER, attributed to the STAFF", async () => {
    const tx = await prisma.transaction.findFirst({
      where: { businessId: biz.id, type: "expense" }, orderBy: { createdAt: "desc" },
    });
    assert.strictEqual(tx.userId, owner.id, "ledger + compliance rows must stay owner-scoped");
    assert.strictEqual(tx.recordedBy, staff.id, "the cap is computed from this — losing it uncaps the staff member");
  });
  await test("spend accumulates, and crossing the cap flips to a hold", async () => {
    const r = await send(45_000); // 10k already spent + fees
    assert.strictEqual(r.status, 202, "should exceed the 50k cap and hold");
    assert.strictEqual(r.body.code, "PENDING_APPROVAL");
  });
  await test("a small transfer still fits in the remaining headroom", async () => {
    const r = await send(1_000);
    assert.strictEqual(r.status, 200);
  });

  // ══ 4. APPROVAL QUEUE ══════════════════════════════════════════════════════
  section("4. the approval queue");

  let heldId;
  await test("an over-cap send appears in the OWNER's queue", async () => {
    await prisma.staffTransferRequest.deleteMany({ where: { businessId: biz.id } });
    const r = await send(500_000);
    assert.strictEqual(r.status, 202);
    heldId = r.body.requestId;
    const q = await GET(`/transfers/approvals`, tOwner);
    assert.strictEqual(q.status, 200);
    assert.strictEqual(q.body.length, 1);
    assert.strictEqual(q.body[0].id, heldId);
    assert.strictEqual(q.body[0].requestedByName, "Ben Staff", "the owner must know WHO asked");
  });
  await test("the staff member sees their own request", async () => {
    const q = await GET(`/transfers/approvals`, tStaff);
    assert.strictEqual(q.body.length, 1);
    assert.strictEqual(q.body[0].id, heldId);
  });
  await test("a RIVAL owner cannot see it", async () => {
    assert.strictEqual((await GET(`/transfers/approvals`, tOther)).body.length, 0);
  });
  await test("a RIVAL owner cannot approve it", async () => {
    const r = await POST(`/transfers/approvals/${heldId}/approve`, tOther, { pin: PIN_OWNER });
    assert.strictEqual(r.status, 404, "cross-tenant approval must be impossible");
  });
  await test("a RIVAL owner cannot reject it", async () => {
    assert.ok([404, 409].includes((await POST(`/transfers/approvals/${heldId}/reject`, tOther, { reason: "x" })).status));
  });
  await test("another employer's STAFF cannot cancel it", async () => {
    const r = await POST(`/transfers/approvals/${heldId}/cancel`, tOtherStaff, {});
    assert.strictEqual(r.status, 409);
    const still = await prisma.staffTransferRequest.findUnique({ where: { id: heldId } });
    assert.strictEqual(still.status, "pending");
  });
  await test("the requesting STAFF cannot approve their own request", async () => {
    const r = await POST(`/transfers/approvals/${heldId}/approve`, tStaff, { pin: PIN_STAFF });
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.body.code, "OWNER_ONLY");
  });
  await test("approving requires the owner's PIN", async () => {
    const r = await POST(`/transfers/approvals/${heldId}/approve`, tOwner, { pin: "9999" });
    assert.strictEqual(r.status, 401);
    const still = await prisma.staffTransferRequest.findUnique({ where: { id: heldId } });
    assert.strictEqual(still.status, "pending", "a failed PIN must not consume the request");
  });
  await test("the owner approves, and the money moves EXACTLY once", async () => {
    const before = anchorCalls.length;
    const r = await POST(`/transfers/approvals/${heldId}/approve`, tOwner, { pin: PIN_OWNER });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(anchorCalls.length, before + 1, "exactly one outbound transfer");
    const row = await prisma.staffTransferRequest.findUnique({ where: { id: heldId } });
    assert.strictEqual(row.status, "executed");
    assert.ok(row.executedTransactionId, "must link to the ledger row it produced");
  });
  await test("approving the SAME request again moves no further money", async () => {
    const before = anchorCalls.length;
    const r = await POST(`/transfers/approvals/${heldId}/approve`, tOwner, { pin: PIN_OWNER });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(anchorCalls.length, before, "a second approval must not reach the bank");
  });
  await test("an owner-approved transfer does NOT consume the staff member's cap", async () => {
    const { staffSpendLast24h } = require("../src/utils/staffTransferCap");
    const spent = await staffSpendLast24h(prisma, staff.id);
    assert.ok(spent < 100_000, `approved 500k must be excluded from unsupervised spend, got ${spent}`);
  });
  await test("reject closes a request and moves no money", async () => {
    await prisma.staffTransferRequest.deleteMany({ where: { businessId: biz.id } });
    const h = (await send(400_000)).body.requestId;
    const before = anchorCalls.length;
    const r = await POST(`/transfers/approvals/${h}/reject`, tOwner, { reason: "wrong supplier" });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(anchorCalls.length, before);
    const row = await prisma.staffTransferRequest.findUnique({ where: { id: h } });
    assert.strictEqual(row.status, "rejected");
    assert.strictEqual(row.reason, "wrong supplier");
  });
  await test("a rejected request can never be approved afterwards", async () => {
    const row = await prisma.staffTransferRequest.findFirst({ where: { status: "rejected", businessId: biz.id } });
    const before = anchorCalls.length;
    const r = await POST(`/transfers/approvals/${row.id}/approve`, tOwner, { pin: PIN_OWNER });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(anchorCalls.length, before);
  });
  await test("staff can withdraw their own pending request", async () => {
    await prisma.staffTransferRequest.deleteMany({ where: { businessId: biz.id } });
    const h = (await send(400_000)).body.requestId;
    const r = await POST(`/transfers/approvals/${h}/cancel`, tStaff, {});
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await prisma.staffTransferRequest.findUnique({ where: { id: h } })).status, "cancelled");
  });
  await test("an EXPIRED request cannot be approved", async () => {
    await prisma.staffTransferRequest.deleteMany({ where: { businessId: biz.id } });
    const h = (await send(400_000)).body.requestId;
    await prisma.staffTransferRequest.update({ where: { id: h }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const before = anchorCalls.length;
    const r = await POST(`/transfers/approvals/${h}/approve`, tOwner, { pin: PIN_OWNER });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.body.code, "EXPIRED");
    assert.strictEqual(anchorCalls.length, before, "a stale approval must never reach the bank");
  });
  await test("the reaper lapses it and tells the requester", async () => {
    const n = await expireStaleRequests(prisma, { pushTo: async () => {} });
    assert.ok(n >= 1);
  });
  await test("a departed staff member's request is refused, not paid", async () => {
    await prisma.staffTransferRequest.deleteMany({ where: { businessId: biz.id } });
    const h = (await send(400_000)).body.requestId;
    await prisma.user.update({ where: { id: staff.id }, data: { employerId: otherOwner.id } });
    const before = anchorCalls.length;
    const r = await POST(`/transfers/approvals/${h}/approve`, tOwner, { pin: PIN_OWNER });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.body.code, "STAFF_GONE");
    assert.strictEqual(anchorCalls.length, before);
    await prisma.user.update({ where: { id: staff.id }, data: { employerId: owner.id } });
  });

  // ══ 5. REVOCATION AND FREEZE ═══════════════════════════════════════════════
  section("5. revocation, freeze, stale grants");

  await test("revoking takes effect on the very next request", async () => {
    await grant(ALL_OFF, 0);
    assert.strictEqual((await GET(`/transfers/balance?businessId=${biz.id}`, tStaff)).status, 403);
    assert.strictEqual((await send(100)).status, 403);
  });
  await test("a grant naming a DIFFERENT employer is ignored entirely", async () => {
    await grant({ canViewBalance: true, canTransfer: true }, 50_000);
    await prisma.staffPermission.update({ where: { userId: staff.id }, data: { employerId: otherOwner.id } });
    const r = await GET(`/transfers/balance?businessId=${biz.id}`, tStaff);
    assert.strictEqual(r.status, 403, "a stale grant from a previous employer must never be honoured");
    await prisma.staffPermission.update({ where: { userId: staff.id }, data: { employerId: owner.id } });
  });
  await test("a compliance-frozen OWNER stops a staff transfer", async () => {
    await prisma.user.update({ where: { id: owner.id }, data: { accountStatus: "frozen", complianceFreezeReason: "e2e" } });
    const before = anchorCalls.length;
    const r = await send(1_000);
    assert.ok([423, 403].includes(r.status), `frozen owner must block staff sends, got ${r.status}`);
    assert.strictEqual(anchorCalls.length, before);
    await prisma.user.update({ where: { id: owner.id }, data: { accountStatus: "active", complianceFreezeReason: null } });
  });
  await test("a frozen STAFF member is stopped too", async () => {
    await prisma.user.update({ where: { id: staff.id }, data: { accountStatus: "frozen" } });
    const before = anchorCalls.length;
    const r = await send(1_000);
    assert.ok([423, 403].includes(r.status));
    assert.strictEqual(anchorCalls.length, before);
    await prisma.user.update({ where: { id: staff.id }, data: { accountStatus: "active" } });
  });
  await test("a lapsed Pro plan cannot GRANT, but can still REVOKE", async () => {
    await prisma.user.update({ where: { id: owner.id }, data: { plan: "FREE" } });
    const up = await grant({ canTransfer: true, canViewBalance: true }, 50_000);
    assert.strictEqual(up.status, 403);
    assert.strictEqual(up.body.code, "PRO_REQUIRED");
    const down = await grant(ALL_OFF, 0);
    assert.strictEqual(down.status, 200, "an owner must never be locked out of removing access");
    await prisma.user.update({ where: { id: owner.id }, data: { plan: "PREMIUM" } });
  });
  await test("deleting a staff member cancels what they left in the queue", async () => {
    await grant({ canViewBalance: true, canTransfer: true }, 0);
    const h = (await send(1_000)).body.requestId;
    await DEL(`/auth/staff/${staff.id}`, tOwner);
    const row = await prisma.staffTransferRequest.findUnique({ where: { id: h } });
    assert.strictEqual(row.status, "cancelled");
    assert.strictEqual(await prisma.staffPermission.count({ where: { userId: staff.id } }), 0,
      "the grant must cascade away with the user");
  });

  // ══ 6. AUDIT TRAIL ═════════════════════════════════════════════════════════
  section("6. audit trail");

  await test("every money-relevant staff event is recorded", async () => {
    const rows = await prisma.auditLog.findMany({
      where: { actorId: { in: [owner.id, staff.id] } }, select: { action: true },
    });
    const acts = new Set(rows.map((r) => r.action));
    for (const need of ["STAFF_PERMISSION_GRANTED", "STAFF_TRANSFER_HELD", "STAFF_TRANSFER_SENT",
                        "STAFF_TRANSFER_APPROVED", "STAFF_TRANSFER_REJECTED", "STAFF_DELETED"]) {
      assert.ok(acts.has(need), `missing audit action: ${need} (have: ${[...acts].join(", ")})`);
    }
  });
  await test("a refused staff send leaves a trail", async () => {
    const denied = await prisma.auditLog.count({ where: { action: "STAFF_PERMISSION_DENIED" } });
    assert.ok(denied > 0, "probing the money endpoint must be visible");
  });

  await wipe();
  await prisma.$disconnect();
  server.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failures.length) console.log("\nFAILURES:\n" + failures.map((f) => "  - " + f).join("\n"));
  process.exitCode = failed ? 1 : 0;
})().catch(async (e) => {
  console.error("\nHARNESS ERROR:", e);
  await wipe().catch(() => {});
  await prisma.$disconnect().catch(() => {});
  try { server?.close(); } catch {}
  process.exitCode = 1;
});
