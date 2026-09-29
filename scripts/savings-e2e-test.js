// FULL end-to-end test of Savings (pots).
//
// Runs the REAL /savings router, the REAL auth + ownerOnly + requireUnfrozen
// middleware, the REAL AML pipeline, the REAL executeTransfer (with the savings
// reserve gate), the REAL savings reconcile loop, the REAL PiggyVest webhook
// route (with the REAL HMAC check) and the REAL Anchor credit poller over a
// REAL Postgres, driven through actual HTTP. Only the two partners are stubbed:
// Anchor (utils/anchor) and PiggyVest (services/piggyvest), because the one
// thing this must not do is move real money.
//
// Every outbound bank call lands in nipCalls / bookCalls, every PiggyVest payout
// in pv.transferCalls, so a double-send is an array length rather than something
// you have to reason about.
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
// Keep the AML pipeline ARMED — PiggyVest deposits must pass the same gates as
// Send Money, and the velocity windows must keep counting them.
process.env.AML_ENABLED = "true";
process.env.SAVINGS_ENABLED = "true";
// The PiggyVest secret is ALSO the webhook HMAC key. The webhook tests use the
// real verifyWebhookSignature with real HMACs over this value.
const PVB_SECRET = "e2e-pvb-secret-key-0123456789";
process.env.PVB_SECRET_KEY = PVB_SECRET;
delete process.env.PVB_VERIFY_WEBHOOK;
// BVN at rest is AES-GCM; ensureProfile decrypts it for the partner.
process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
// The Anchor credit poller (utils/anchorReconcile) refuses to run without these;
// the transport is a fetch stub below, nothing reaches this host.
const ANCHOR_BASE = "http://anchor.e2e.invalid";
process.env.ANCHOR_BASE_URL = ANCHOR_BASE;
process.env.ANCHOR_API_KEY = "e2e-anchor-key";
// Fees ON: a ₦50 fee + ₦50 stamp duty above ₦10k is part of what the spend
// gate must cover and what a PiggyVest deposit movement must record.
process.env.ANCHOR_FEE_ACCOUNT_ID = "fee-acct-e2e";
process.env.DB_POOL_MAX = process.env.DB_POOL_MAX || "60";

// ── Stub the partners BEFORE anything requires them ──────────────────────────
const Module = require("module");
const origLoad = Module._load;

// Anchor: the merchant's bank. Gross balance is controllable; every NIP attempt
// is recorded even when it throws (a lost response is exactly the case where a
// second attempt would double-send).
const ANCHOR_BANKS = [
  { code: "058", id: "bank-058", name: "GTBank" },
  { code: "090110", id: "bank-vfd", name: "VFD Microfinance Bank" },
  { code: "101", id: "bank-providus", name: "Providus Bank" },
];
const anchorState = { gross: 10_000_000, mode: "ok" }; // mode: ok | network | reject
const nipCalls = [];
const bookCalls = [];

// PiggyVest: an in-memory partner. Wallets, credits, payouts and verify answers
// are all controllable per test.
const PV_FUNDING_BANK = "VFD MFB"; // what their rail calls the funding bank; must map to an Anchor code
const pv = {
  wallets: new Map(),
  banks: [{ code: "101", name: "Providus Bank" }, { code: "058", name: "GTBank" }],
  transferCalls: [],
  verifyCalls: [],
  enquiries: [],
  customerCalls: [],
  subAccountCalls: [],
  transferMode: "ok", // ok | timeout | reject
  subAccountMode: "ok", // ok | timeout | reject
  verify: new Map(), // reference → verify answer (default not_found)
  accrued: new Map(), // walletId → accrual rows
  enquiryName: "ADA STORES",
  nextWallet: 1,
  nextRef: 1,
  reset() {
    this.wallets.clear(); this.transferCalls.length = 0; this.verifyCalls.length = 0;
    this.enquiries.length = 0; this.customerCalls.length = 0; this.subAccountCalls.length = 0;
    this.transferMode = "ok"; this.subAccountMode = "ok"; this.verify.clear(); this.accrued.clear();
    this.enquiryName = "ADA STORES"; this.nextWallet = 1; this.nextRef = 1;
  },
  wallet(id) {
    const w = this.wallets.get(id);
    if (!w) throw new Error(`e2e: no fake wallet ${id}`);
    return w;
  },
  // PiggyVest reserves the funding account asynchronously; this is that event.
  reserveAccount(walletId, { bankName = PV_FUNDING_BANK } = {}) {
    const w = this.wallet(walletId);
    const n = Number(String(walletId).replace(/\D/g, "")) || 1;
    w.accounts = [{ accountNumber: String(7000000000 + n), accountName: `PIGGYVEST/${w.name}`, bankName, bankCode: null }];
    return w.accounts[0];
  },
  credit(walletId, c) {
    const w = this.wallet(walletId);
    w.credits.push({ id: c.id, amount: c.amount, reference: c.reference || null, narration: c.narration || "", category: c.category || "credit", senderAccount: c.senderAccount || null, createdAt: c.createdAt || new Date().toISOString() });
    w.balance = Math.round((w.balance + c.amount) * 100) / 100;
  },
};
const otpDispatches = [];

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
      if (anchorState.mode === "network") {
        // A code-less transport failure: Anchor MAY have acted.
        throw Object.assign(new Error("fetch failed"), { cause: { code: "ECONNRESET" } });
      }
      if (anchorState.mode === "reject") {
        throw Object.assign(new Error("Anchor rejected the transfer"), { httpStatus: 422 });
      }
      anchorState.gross = Math.round((anchorState.gross - Number(args.amount)) * 100) / 100;
      return { transferId: `anc_tr_${nipCalls.length}`, raw: {} };
    };
    resolved.createBookTransfer = async (args) => {
      bookCalls.push({ ...args });
      anchorState.gross = Math.round((anchorState.gross - Number(args.amount)) * 100) / 100;
      return { transferId: `anc_bk_${bookCalls.length}`, raw: {} };
    };
  }
  if (/(^|[\\/])(services[\\/])?piggyvest$/.test(request) && resolved && !resolved.__stubbed) {
    resolved.__stubbed = true;
    resolved.isConfigured = () => true;
    resolved.isLive = () => false;
    resolved.createCustomer = async ({ bvn, name, email, phone, thirdPartyId }) => {
      pv.customerCalls.push({ bvnDigits: String(bvn || "").length, name, email, phone, thirdPartyId });
      return { customerId: "pvcust_1", walletId: "pvw_default", newCustomer: true, raw: {} };
    };
    resolved.createSubAccount = async ({ name, customerId }) => {
      pv.subAccountCalls.push({ name, customerId });
      if (pv.subAccountMode === "timeout") throw Object.assign(new Error("PiggyVest POST /api/v1/wallet/sub-account timed out after 20000ms"), { code: "ETIMEDOUT" });
      if (pv.subAccountMode === "reject") throw Object.assign(new Error("customer is not verified"), { status: 400 });
      const id = `pvw_${pv.nextWallet++}`;
      pv.wallets.set(id, { id, name, balance: 0, withdrawalCount: 0, interestRate: 10, accounts: [], credits: [] });
      return { walletId: id, raw: {} };
    };
    resolved.getWallet = async (walletId) => {
      const w = pv.wallets.get(walletId);
      if (!w) throw Object.assign(new Error("wallet not found"), { status: 404 });
      return { walletId, balance: w.balance, withdrawalCount: w.withdrawalCount, interestRate: w.interestRate, status: "active", raw: {} };
    };
    resolved.getWalletAccounts = async (walletId) => {
      const w = pv.wallets.get(walletId);
      return w ? w.accounts.map((a) => ({ ...a })) : [];
    };
    resolved.getBanks = async () => pv.banks;
    resolved.nameEnquiry = async ({ bankCode, accountNumber }) => {
      pv.enquiries.push({ bankCode, accountNumber });
      return { accountName: pv.enquiryName, raw: {} };
    };
    resolved.transferToBank = async (args) => {
      pv.transferCalls.push({ ...args });
      if (pv.transferMode === "timeout") throw Object.assign(new Error("PiggyVest POST /api/v1/transfer/bank timed out after 30000ms"), { code: "ETIMEDOUT" });
      if (pv.transferMode === "reject") throw Object.assign(new Error("Insufficient wallet balance"), { status: 400 });
      return { reference: args.reference, pvReference: `pvref_${pv.nextRef++}`, raw: {} };
    };
    resolved.verifyTransaction = async (reference) => {
      pv.verifyCalls.push(reference);
      return pv.verify.get(reference) || { status: "not_found", raw: null };
    };
    resolved.listCreditTransactions = async (walletId) => {
      const w = pv.wallets.get(walletId);
      return w ? w.credits.map((c) => ({ ...c })) : [];
    };
    resolved.getAccruedInterest = async (walletId) => pv.accrued.get(walletId) || [];
    resolved.testFunding = async () => { throw new Error("e2e: testFunding must not be called"); };
    // verifyWebhookSignature stays REAL: the webhook tests sign with PVB_SECRET.
  }
  if (/(^|[\\/])(utils[\\/])?otp$/.test(request) && resolved && !resolved.__stubbed) {
    resolved.__stubbed = true;
    resolved.dispatchOtp = async (identifier, type) => { otpDispatches.push({ identifier, type }); };
  }
  return resolved;
};

// The Anchor credit poller and the sender-lookup helpers use global fetch.
// Everything else that might reach the network is either stubbed above or
// gated on config this test does not set (push tokens, SMTP, admin email).
const anchorFeed = []; // Anchor /transactions rows the poller will see
const jsonResponse = (body, status = 200) => ({
  ok: status < 300, status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});
globalThis.fetch = async (input) => {
  const u = String(input);
  if (u.startsWith(ANCHOR_BASE)) {
    if (u.includes("/transactions?")) return jsonResponse({ data: anchorFeed });
    return jsonResponse({ errors: [{ detail: "e2e: not stubbed" }] }, 404);
  }
  throw new Error(`e2e: unexpected network call to ${u}`);
};

const assert = require("assert");
const http = require("http");
const crypto = require("crypto");
const express = require("express");
const bcrypt = require("@node-rs/bcrypt");

const prisma = require("../src/utils/db");
const { signToken } = require("../src/utils/jwt");
const { encrypt } = require("../src/utils/crypto");
const balanceCache = require("../src/utils/balanceCache");
const { MONEY_EPS } = require("../src/config/fees");
const { toKobo } = require("../src/utils/money");
const { reconcileSavings } = require("../src/utils/savingsReconcile");
const { reconcileBusiness } = require("../src/utils/anchorReconcile");
const { computeRawLedger } = require("../src/utils/ledgerBalance");
const { sumIncome, sumExpenses } = require("../src/utils/insightsEngine");

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

// Same mounting order as server.js: the webhook takes the RAW body before the
// JSON parser, so the HMAC runs over the exact bytes.
const app = express();
app.use(
  "/webhooks/piggyvest",
  express.raw({ type: "*/*", limit: "1mb" }),
  require("../src/routes/piggyvestWebhook"),
);
app.use(express.json({ limit: "10mb" }));
app.use("/auth", require("../src/routes/auth"));
app.use("/transfers", require("../src/routes/transfers"));
app.use("/businesses", require("../src/routes/businesses"));
app.use("/transactions", require("../src/routes/transactions"));
app.use("/savings", require("../src/routes/savings"));

let server, BASE;

const req = (method, path, { token, body, rawBody, headers = {} } = {}) =>
  new Promise((resolve) => {
    const data = rawBody !== undefined ? rawBody : body === undefined ? null : JSON.stringify(body);
    const r = http.request(
      `${BASE}${path}`,
      {
        method,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}),
          ...headers,
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

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, { timeoutMs = 4000, everyMs = 40, label = "condition" } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${label}`);
    await pause(everyMs);
  }
}
const minutesAgo = (n) => new Date(Date.now() - n * 60 * 1000);
const daysFromNow = (n) => new Date(Date.now() + n * 24 * 3600 * 1000);
const sameKobo = (a, b) => toKobo(a) === toKobo(b);

const PIN_OWNER = "1234";
const PASSWORD = "Password123!";
const ctx = {}; // fixtures handed from one test to the next within a section
const BIZ_ID = "sav_biz";
const BIZ_NUBAN = "9990009999";
let owner, staff, biz;
let tOwner, tStaff;

async function wipe() {
  await prisma.savingsMovement.deleteMany({});
  await prisma.savingsPot.deleteMany({});
  await prisma.savingsProfile.deleteMany({});
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
  nipCalls.length = 0; bookCalls.length = 0; anchorFeed.length = 0; otpDispatches.length = 0;
  anchorState.gross = gross; anchorState.mode = "ok";
  pv.reset();
  balanceCache.bustBalance(BIZ_ID);
  process.env.SAVINGS_ENABLED = "true";

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

  // limited_company: singleMax ₦4m / daily ₦8m, so the step-up OTP (>₦1m) is
  // reachable and twenty ₦100k sends fit inside the daily window.
  biz = await prisma.business.create({
    data: {
      id: BIZ_ID, userId: owner.id, name: "Ada Stores", country: "NG", baseCurrency: "NGN",
      anchorAccountId: "anchor-acct-sav", virtualAccountNumber: BIZ_NUBAN,
      virtualAccountBank: "Providus Bank", virtualAccountName: "ADA STORES",
      kycBusinessType: "limited_company", kycBvn: encrypt("22222222222"),
    },
  });

  tOwner = signToken({ userId: owner.id, tokenVersion: 0 });
  tStaff = signToken({ userId: staff.id, tokenVersion: 0 });
}

// ── Route helpers ─────────────────────────────────────────────────────────────
const mkPot = (over = {}) => POST("/savings/pots", tOwner, { businessId: BIZ_ID, name: "Rent", backing: "ledger", ...over });
const depositTo = (potId, over = {}) => POST(`/savings/pots/${potId}/deposit`, tOwner, { businessId: BIZ_ID, pin: PIN_OWNER, ...over });
const withdrawFrom = (potId, over = {}) => POST(`/savings/pots/${potId}/withdraw`, tOwner, { businessId: BIZ_ID, pin: PIN_OWNER, ...over });
const send = (over = {}) => POST("/transfers/send", tOwner, {
  businessId: BIZ_ID, accountNumber: "0123456789", bankCode: "058", accountName: "SUPPLIER LTD", bankName: "GTBank",
  narration: "supplier", pin: PIN_OWNER, ...over,
});
const dbPot = (id) => prisma.savingsPot.findUnique({ where: { id } });
const dbMovement = (id) => prisma.savingsMovement.findUnique({ where: { id } });
const dbMovementByRef = (reference) => prisma.savingsMovement.findUnique({ where: { reference } });
const dbTxnByRef = (reference) => prisma.transaction.findFirst({ where: { businessId: BIZ_ID, reference } });
const dbBiz = () => prisma.business.findUnique({ where: { id: BIZ_ID } });
const alertFired = (key) => prisma.alertState.findUnique({ where: { key } });
const pushes = (title) => prisma.appNotification.count({ where: { userId: owner.id, title } });
const wideRange = () => ({ start: new Date(Date.now() - 2 * 86400000), end: new Date(Date.now() + 2 * 86400000) });

// A PiggyVest pot, created through the real route, then (by default) brought
// to `active` the way production does it: the partner reserves the funding
// account and the reconcile loop maps its bank to an Anchor code.
async function mkPvPot(name, { ready = true, balance = 0 } = {}) {
  const r = await mkPot({ name, backing: "piggyvest" });
  assert.strictEqual(r.status, 201, `pv pot fixture (${name}): ${JSON.stringify(r.body)}`);
  let pot = await dbPot(r.body.pot.id);
  if (ready) {
    pv.reserveAccount(pot.pvWalletId);
    pv.wallet(pot.pvWalletId).balance = balance;
    await reconcileSavings({ full: false });
    pot = await dbPot(pot.id);
    assert.strictEqual(pot.status, "active", `pv pot fixture (${name}) did not activate: ${pot.status} ${pot.error || ""}`);
  }
  return pot;
}

// Webhook signing: HMAC-SHA512 hex over JSON.stringify(body), keyed with the secret.
const signPvb = (bodyStr) => crypto.createHmac("sha512", PVB_SECRET).update(bodyStr).digest("hex");
const webhook = (evt, { pretty = false, signature } = {}) => {
  const compact = JSON.stringify(evt);
  const body = pretty ? JSON.stringify(evt, null, 2) : compact;
  return req("POST", "/webhooks/piggyvest", { rawBody: body, headers: { "x-pvb-signature": signature ?? signPvb(compact) } });
};
const markerCount = (eventId) => prisma.processedWebhook.count({ where: { eventId: `pvb:${eventId}` } });

(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  BASE = `http://127.0.0.1:${server.address().port}`;

  // ══ 1. OWNER-ONLY + INPUT GATES ═══════════════════════════════════════════
  section("1. owner only — no permission unlocks savings");
  await seed();
  const potA = (await mkPot({ name: "Rent" })).body?.pot;

  await test("a ledger pot is born active through the real route", async () => {
    assert.ok(potA?.id, "fixture: no pot");
    assert.strictEqual(potA.status, "active");
    assert.strictEqual(potA.backing, "ledger");
    assert.strictEqual(potA.balance, 0);
  });

  await test("a staff member with EVERY permission gets 403 OWNER_ONLY on every /savings route", async () => {
    const calls = [
      await GET(`/savings?businessId=${BIZ_ID}`, tStaff),
      await POST("/savings/pots", tStaff, { businessId: BIZ_ID, name: "X", backing: "ledger" }),
      await PATCH(`/savings/pots/${potA.id}`, tStaff, { name: "Y" }),
      await DEL(`/savings/pots/${potA.id}`, tStaff),
      await POST(`/savings/pots/${potA.id}/deposit`, tStaff, { businessId: BIZ_ID, amount: 1000, pin: PIN_OWNER }),
      await POST(`/savings/pots/${potA.id}/withdraw`, tStaff, { businessId: BIZ_ID, amount: 1000, pin: PIN_OWNER }),
      await GET(`/savings/pots/${potA.id}/movements?businessId=${BIZ_ID}`, tStaff),
    ];
    for (const r of calls) {
      assert.strictEqual(r.status, 403, `expected 403, got ${r.status} — ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body?.code, "OWNER_ONLY");
    }
    assert.strictEqual(await prisma.savingsMovement.count(), 0, "a staff call must not create a movement");
  });

  await test("no token → 401; another owner's pot → 403/404, never a movement", async () => {
    const anon = await GET(`/savings?businessId=${BIZ_ID}`);
    assert.strictEqual(anon.status, 401);
    const other = await prisma.user.create({
      data: { id: "sav_other", firstName: "Cid", lastName: "Other", businessName: "Other Co", country: "NG", currency: "NGN", password: await bcrypt.hash(PASSWORD, 4), transactionPin: await bcrypt.hash(PIN_OWNER, 4), accountType: "OWNER" },
    });
    const tOther = signToken({ userId: other.id, tokenVersion: 0 });
    const r = await POST(`/savings/pots/${potA.id}/deposit`, tOther, { businessId: BIZ_ID, amount: 1000, pin: PIN_OWNER });
    assert.ok([403, 404].includes(r.status), `expected 403/404, got ${r.status}`);
    assert.strictEqual(await prisma.savingsMovement.count(), 0);
    assert.strictEqual((await dbPot(potA.id)).balance, 0);
  });

  await test("a wrong PIN is refused and audited BEFORE any money read", async () => {
    const r = await depositTo(potA.id, { amount: 1000, pin: "9999" });
    assert.strictEqual(r.status, 401);
    assert.strictEqual(r.body?.code, "PIN_WRONG");
    assert.strictEqual(await prisma.auditLog.count({ where: { action: "PIN_FAILED" } }), 1);
    assert.strictEqual(await prisma.savingsMovement.count(), 0);
  });

  await test("amount 0.005 → 400 (money is 2 dp)", async () => {
    const d = await depositTo(potA.id, { amount: 0.005 });
    assert.strictEqual(d.status, 400, JSON.stringify(d.body));
    assert.strictEqual(d.body?.code, "BAD_AMOUNT");
    const w = await withdrawFrom(potA.id, { amount: 0.005 });
    assert.strictEqual(w.status, 400);
    assert.strictEqual(w.body?.code, "BAD_AMOUNT");
    assert.strictEqual(await prisma.savingsMovement.count(), 0);
  });

  await test("zero, negative and missing amounts → 400", async () => {
    for (const amount of [0, -5, "abc"]) {
      const r = await depositTo(potA.id, { amount });
      assert.strictEqual(r.status, 400, `amount ${amount}: ${JSON.stringify(r.body)}`);
    }
    const missing = await depositTo(potA.id, {});
    assert.strictEqual(missing.status, 400);
    assert.strictEqual(await prisma.savingsMovement.count(), 0);
  });

  await test("SAVINGS_ENABLED unset: creation and deposits 403 SAVINGS_DISABLED, reads and withdrawals still work", async () => {
    const dep = await depositTo(potA.id, { amount: 1000, idempotencyKey: "gate-dep" });
    assert.strictEqual(dep.status, 200, JSON.stringify(dep.body));
    delete process.env.SAVINGS_ENABLED;
    try {
      const create = await mkPot({ name: "Blocked" });
      assert.strictEqual(create.status, 403);
      assert.strictEqual(create.body?.code, "SAVINGS_DISABLED");
      const dep2 = await depositTo(potA.id, { amount: 1000, idempotencyKey: "gate-dep2" });
      assert.strictEqual(dep2.status, 403);
      assert.strictEqual(dep2.body?.code, "SAVINGS_DISABLED");
      const list = await GET(`/savings?businessId=${BIZ_ID}`, tOwner);
      assert.strictEqual(list.status, 200);
      assert.strictEqual(list.body.enabled, false);
      assert.strictEqual(list.body.pots.length, 1);
      assert.strictEqual(list.body.totals.reserved, 1000, "the reserve is still reported with the switch off");
      const bal = await GET(`/transfers/balance?businessId=${BIZ_ID}`, tOwner);
      assert.strictEqual(bal.body.savingsReserved, 1000, "the reserve still gates spending with the switch off");
      const wd = await withdrawFrom(potA.id, { amount: 1000, idempotencyKey: "gate-wd" });
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

  await test("a ledger deposit is one completed movement and raises the reserve", async () => {
    const r = await depositTo(rent.id, { amount: 1_000_000, idempotencyKey: "l1" });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    ledgerDep = r.body.movement;
    assert.strictEqual(ledgerDep.status, "completed");
    assert.strictEqual(ledgerDep.reference, "kb_sv_l1");
    assert.strictEqual(r.body.pot.balance, 1_000_000);
    assert.strictEqual(r.body.reserved, 1_000_000);
    assert.strictEqual(nipCalls.length, 0, "a ledger deposit moves no money");
    assert.strictEqual(await prisma.transaction.count(), 0, "a ledger deposit writes no bank row");
  });

  await test("GET /transfers/balance shows spendable = gross − reserve", async () => {
    const r = await GET(`/transfers/balance?businessId=${BIZ_ID}`, tOwner);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.balance, 500_000);
    assert.strictEqual(r.body.grossBalance, 1_500_000);
    assert.strictEqual(r.body.savingsReserved, 1_000_000);
  });

  await test("GET /businesses/:id/balance shows the same spendable figure", async () => {
    balanceCache.bustBalance(BIZ_ID);
    const r = await GET(`/businesses/${BIZ_ID}/balance`, tOwner);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.balance, 500_000);
    assert.strictEqual(r.body.grossBalance, 1_500_000);
    assert.strictEqual(r.body.savingsReserved, 1_000_000);
    assert.strictEqual(r.body.hasAccount, true);
    // And again from the cache: the reserve is never cached.
    const cached = await GET(`/businesses/${BIZ_ID}/balance`, tOwner);
    assert.strictEqual(cached.body.balance, 500_000);
  });

  await test("POST /transfers/send beyond spendable → 400 INSUFFICIENT_BALANCE naming the reserve, no bank call", async () => {
    const r = await send({ amount: 600_000, idempotencyKey: "over1" });
    assert.strictEqual(r.status, 400, JSON.stringify(r.body));
    assert.strictEqual(r.body?.code, "INSUFFICIENT_BALANCE");
    assert.ok(/set aside in savings/.test(r.body.error), `message must name the reserve: ${r.body.error}`);
    assert.strictEqual(nipCalls.length, 0);
    assert.strictEqual(await prisma.transaction.count(), 0);
  });

  await test("POST /transfers/send within spendable succeeds", async () => {
    const r = await send({ amount: 400_000, idempotencyKey: "ok1" });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(nipCalls.length, 1);
    const txn = await dbTxnByRef("kbtf_ok1");
    assert.ok(txn, "the send must be booked");
    assert.strictEqual(txn.purpose, null, "a plain send carries no purpose");
  });

  await test("a ledger withdrawal frees the reserve", async () => {
    const r = await withdrawFrom(rent.id, { amount: 1_000_000, idempotencyKey: "lw1" });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.movement.status, "completed");
    assert.strictEqual(r.body.movement.reference, "kb_svw_lw1");
    assert.strictEqual(r.body.pot.balance, 0);
    assert.strictEqual(r.body.reserved, 0);
    const bal = await GET(`/transfers/balance?businessId=${BIZ_ID}`, tOwner);
    assert.strictEqual(bal.body.savingsReserved, 0);
    assert.strictEqual(bal.body.balance, bal.body.grossBalance);
    assert.strictEqual(nipCalls.length, 1, "a ledger withdrawal moves no money");
  });

  await test("the same ledger idempotencyKey replays the movement and does not credit the pot twice", async () => {
    const r = await depositTo(rent.id, { amount: 1_000_000, idempotencyKey: "l1" });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.replay, true);
    assert.strictEqual(r.body.movement.id, ledgerDep.id);
    assert.strictEqual((await dbPot(rent.id)).balance, 0, "a replay must not increment the pot");
  });

  await test("a ledger withdrawal above the pot balance → 400 INSUFFICIENT_POT_BALANCE", async () => {
    await depositTo(rent.id, { amount: 500_000, idempotencyKey: "l2" });
    const r = await withdrawFrom(rent.id, { amount: 500_000.01, idempotencyKey: "lw-over" });
    assert.strictEqual(r.status, 400, JSON.stringify(r.body));
    assert.strictEqual(r.body?.code, "INSUFFICIENT_POT_BALANCE");
    assert.strictEqual((await dbPot(rent.id)).balance, 500_000);
  });

  await test("ledger deposit beyond spendable → 400 INSUFFICIENT_BALANCE, pot untouched", async () => {
    // gross is now 1,500,000 − 400,000 − ₦50 fee sweep = 1,099,950; 500,000 reserved.
    const r = await depositTo(rent.id, { amount: 700_000, idempotencyKey: "l3" });
    assert.strictEqual(r.status, 400, JSON.stringify(r.body));
    assert.strictEqual(r.body?.code, "INSUFFICIENT_BALANCE");
    assert.strictEqual(r.body.reserved, 500_000);
    assert.strictEqual((await dbPot(rent.id)).balance, 500_000);
    assert.strictEqual(await dbMovementByRef("kb_sv_l3"), null, "no movement row for a refused ledger deposit");
  });

  await test("bank unreachable → ledger deposit fails CLOSED (503 BALANCE_UNAVAILABLE)", async () => {
    const anchor = require("../src/utils/anchor");
    const real = anchor.getAccountBalance;
    anchor.getAccountBalance = async () => { throw new Error("Anchor 503"); };
    try {
      const r = await depositTo(rent.id, { amount: 1, idempotencyKey: "l4" });
      assert.strictEqual(r.status, 503, JSON.stringify(r.body));
      assert.strictEqual(r.body?.code, "BALANCE_UNAVAILABLE");
      assert.strictEqual((await dbPot(rent.id)).balance, 500_000);
    } finally {
      anchor.getAccountBalance = real;
    }
  });

  await test("reserve above gross: spendable floors at 0, sends refuse, reconcile alarms savings-overreserved", async () => {
    const before = anchorState.gross;
    anchorState.gross = 100;
    try {
      const bal = await GET(`/transfers/balance?businessId=${BIZ_ID}`, tOwner);
      assert.strictEqual(bal.body.balance, 0);
      const r = await send({ amount: 1_000, idempotencyKey: "over2" });
      assert.strictEqual(r.status, 400);
      assert.strictEqual(r.body?.code, "INSUFFICIENT_BALANCE");
      const stats = await reconcileSavings({ full: true });
      assert.strictEqual(stats.overReserved, 1, JSON.stringify(stats));
      assert.ok(await alertFired(`savings-overreserved-${BIZ_ID}`), "alert must fire");
    } finally {
      anchorState.gross = before;
    }
  });

  await test("a pot balance that disagrees with its movements alarms savings-ledger-drift", async () => {
    await prisma.savingsPot.update({ where: { id: rent.id }, data: { balance: 500_001 } });
    try {
      const stats = await reconcileSavings({ full: true });
      assert.ok(stats.drift >= 1, JSON.stringify(stats));
      assert.ok(await alertFired(`savings-ledger-drift-${rent.id}`));
    } finally {
      await prisma.savingsPot.update({ where: { id: rent.id }, data: { balance: 500_000 } });
    }
  });

  await test("DELETE a pot with money → 409 POT_NOT_EMPTY; empty → 204, closed pots leave the list and refuse deposits", async () => {
    const full = await DEL(`/savings/pots/${rent.id}?businessId=${BIZ_ID}`, tOwner);
    assert.strictEqual(full.status, 409, JSON.stringify(full.body));
    assert.strictEqual(full.body?.code, "POT_NOT_EMPTY");
    await withdrawFrom(rent.id, { amount: 500_000, idempotencyKey: "lw-all" });
    const empty = await DEL(`/savings/pots/${rent.id}?businessId=${BIZ_ID}`, tOwner);
    assert.strictEqual(empty.status, 204);
    const row = await dbPot(rent.id);
    assert.strictEqual(row.status, "closed");
    assert.ok(row.closedAt);
    const list = await GET(`/savings?businessId=${BIZ_ID}`, tOwner);
    assert.strictEqual(list.body.pots.length, 0);
    const dep = await depositTo(rent.id, { amount: 1, idempotencyKey: "l-closed" });
    assert.strictEqual(dep.status, 409);
    assert.strictEqual(dep.body?.code, "POT_NOT_READY");
    const bal = await GET(`/transfers/balance?businessId=${BIZ_ID}`, tOwner);
    assert.strictEqual(bal.body.savingsReserved, 0, "a closed pot reserves nothing");
  });

  await test("movements are listed newest first with the pot", async () => {
    const r = await GET(`/savings/pots/${rent.id}/movements?businessId=${BIZ_ID}`, tOwner);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.movements.length >= 3);
    const times = r.body.movements.map((m) => new Date(m.createdAt).getTime());
    for (let i = 1; i < times.length; i++) assert.ok(times[i - 1] >= times[i], "newest first");
    assert.strictEqual(r.body.pot.id, rent.id);
  });

  // ══ 3. CONCURRENCY ════════════════════════════════════════════════════════
  section("3. concurrency — reserved + sent never exceed gross");
  await seed({ gross: 1_200_000 });
  const tax = (await mkPot({ name: "Tax" })).body.pot;

  await test("20 concurrent ledger-deposit + send pairs never overshoot the bank balance", async () => {
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
  });

  // ══ 4. LOCKS ══════════════════════════════════════════════════════════════
  section("4. locks — strict is server-enforced, flexible is a confirmation");
  await seed();

  await test("strict lock → 423 POT_LOCKED on withdrawal", async () => {
    const r = await mkPot({ name: "School fees", lockUntil: daysFromNow(30).toISOString(), lockMode: "strict" });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    const pot = r.body.pot;
    assert.strictEqual(pot.locked, true);
    await depositTo(pot.id, { amount: 10_000, idempotencyKey: "s1" });
    const w = await withdrawFrom(pot.id, { amount: 1_000, idempotencyKey: "sw1", confirmEarly: true });
    assert.strictEqual(w.status, 423, JSON.stringify(w.body));
    assert.strictEqual(w.body?.code, "POT_LOCKED");
    assert.strictEqual((await dbPot(pot.id)).balance, 10_000);
    ctx.strictPot = pot;
  });

  await test("PATCH shortening or relaxing a strict lock → 409 LOCK_CANNOT_SHORTEN; extending is allowed", async () => {
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
    assert.ok(new Date(longer.body.pot.lockUntil) > daysFromNow(59));
    const past = await PATCH(`/savings/pots/${pot.id}`, tOwner, { businessId: BIZ_ID, lockUntil: daysFromNow(-1).toISOString(), lockMode: "strict" });
    assert.ok([400, 409].includes(past.status), `a past date is refused, got ${past.status}`);
  });

  await test("flexible lock → 409 EARLY_WITHDRAWAL_CONFIRM, then success with confirmEarly", async () => {
    const r = await mkPot({ name: "Holiday", lockUntil: daysFromNow(30).toISOString(), lockMode: "flexible" });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    const pot = r.body.pot;
    await depositTo(pot.id, { amount: 5_000, idempotencyKey: "f1" });
    const w1 = await withdrawFrom(pot.id, { amount: 1_000, idempotencyKey: "fw1" });
    assert.strictEqual(w1.status, 409, JSON.stringify(w1.body));
    assert.strictEqual(w1.body?.code, "EARLY_WITHDRAWAL_CONFIRM");
    assert.strictEqual((await dbPot(pot.id)).balance, 5_000);
    const w2 = await withdrawFrom(pot.id, { amount: 1_000, idempotencyKey: "fw1", confirmEarly: true });
    assert.strictEqual(w2.status, 200, JSON.stringify(w2.body));
    assert.strictEqual(w2.body.movement.status, "completed");
    assert.strictEqual(w2.body.pot.balance, 4_000);
  });

  await test("a lock needs a mode, and a mode needs a date", async () => {
    const noMode = await mkPot({ name: "X", lockUntil: daysFromNow(3).toISOString() });
    assert.strictEqual(noMode.status, 400);
    assert.strictEqual(noMode.body?.code, "BAD_LOCK");
    const pot = ctx.strictPot;
    const modeOnly = await PATCH(`/savings/pots/${pot.id}`, tOwner, { businessId: BIZ_ID, lockMode: "flexible" });
    assert.strictEqual(modeOnly.status, 400);
    assert.strictEqual(modeOnly.body?.code, "BAD_LOCK");
  });

  // ══ 5. PIGGYVEST POTS: PROVISIONING ═══════════════════════════════════════
  section("5. PiggyVest pots — provisioning");
  await seed();
  let pvPot; // "Rent", the main PiggyVest pot for sections 5–8

  await test("creating a PiggyVest pot: customer once, one wallet create, row provisioning with the wallet id", async () => {
    const r = await mkPot({ name: "Rent", backing: "piggyvest" });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    assert.strictEqual(r.body.pot.status, "provisioning");
    assert.strictEqual(r.body.pot.fundingAccount, null);
    assert.strictEqual(pv.customerCalls.length, 1);
    assert.strictEqual(pv.customerCalls[0].thirdPartyId, owner.id);
    assert.strictEqual(pv.customerCalls[0].bvnDigits, 11, "the BVN reaches the partner decrypted");
    assert.strictEqual(pv.subAccountCalls.length, 1);
    const profile = await prisma.savingsProfile.findUnique({ where: { businessId: BIZ_ID } });
    assert.strictEqual(profile.status, "ready");
    assert.strictEqual(profile.pvCustomerId, "pvcust_1");
    pvPot = await dbPot(r.body.pot.id);
    assert.strictEqual(pvPot.pvWalletId, "pvw_1");
    assert.strictEqual(pvPot.pvBankCode, null);
  });

  await test("deposit before active → 409 POT_NOT_READY, no movement, no bank call", async () => {
    const r = await depositTo(pvPot.id, { amount: 1_000, idempotencyKey: "early" });
    assert.strictEqual(r.status, 409, JSON.stringify(r.body));
    assert.strictEqual(r.body?.code, "POT_NOT_READY");
    assert.strictEqual(await prisma.savingsMovement.count(), 0);
    assert.strictEqual(nipCalls.length, 0);
  });

  await test("reconcile activates the pot once the funding account is reserved, with the ANCHOR bank code", async () => {
    const acct = pv.reserveAccount(pvPot.pvWalletId);
    const stats = await reconcileSavings({ full: false });
    assert.strictEqual(stats.provisioned, 1, JSON.stringify(stats));
    pvPot = await dbPot(pvPot.id);
    assert.strictEqual(pvPot.status, "active");
    assert.strictEqual(pvPot.pvAccountNumber, acct.accountNumber);
    assert.strictEqual(pvPot.pvBankName, PV_FUNDING_BANK);
    assert.strictEqual(pvPot.pvBankCode, "090110", "VFD MFB must map to Anchor's VFD code");
    assert.ok(await pushes("Savings pot ready"));
    const list = await GET(`/savings?businessId=${BIZ_ID}`, tOwner);
    const shown = list.body.pots.find((p) => p.id === pvPot.id);
    assert.deepStrictEqual(shown.fundingAccount, { accountNumber: acct.accountNumber, bankName: PV_FUNDING_BANK, accountName: acct.accountName });
    assert.strictEqual(list.body.partner.status, "ready");
  });

  await test("a second PiggyVest pot reuses the customer", async () => {
    const other = await mkPvPot("Restock");
    assert.strictEqual(pv.customerCalls.length, 1, "createCustomer is called once per business");
    assert.strictEqual(pv.subAccountCalls.length, 2);
    assert.notStrictEqual(other.pvWalletId, pvPot.pvWalletId);
    ctx.restock = other;
  });

  await test("a funding bank Anchor cannot name fails CLOSED: pot → error, never fundable", async () => {
    const r = await mkPot({ name: "Odd bank", backing: "piggyvest" });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    const pot = await dbPot(r.body.pot.id);
    pv.reserveAccount(pot.pvWalletId, { bankName: "Zenith Bank" });
    await reconcileSavings({ full: false });
    const row = await dbPot(pot.id);
    assert.strictEqual(row.status, "error");
    assert.strictEqual(row.pvBankCode, null);
    assert.ok(/Zenith/.test(row.error || ""), row.error);
    const dep = await depositTo(pot.id, { amount: 1_000, idempotencyKey: "odd" });
    assert.strictEqual(dep.status, 409);
    assert.strictEqual(dep.body?.code, "POT_NOT_READY");
    assert.strictEqual(nipCalls.length, 0);
  });

  await test("a wallet create that times out leaves the row provisioning; reconcile ages it to error after 10 min", async () => {
    pv.subAccountMode = "timeout";
    let r;
    try { r = await mkPot({ name: "Lost wallet", backing: "piggyvest" }); }
    finally { pv.subAccountMode = "ok"; }
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    assert.strictEqual(r.body.pot.status, "provisioning");
    let row = await dbPot(r.body.pot.id);
    assert.strictEqual(row.pvWalletId, null);
    assert.ok(/create pending/.test(row.error || ""), row.error);
    await reconcileSavings({ full: false });
    row = await dbPot(row.id);
    assert.strictEqual(row.status, "provisioning", "not aged out yet");
    await prisma.savingsPot.update({ where: { id: row.id }, data: { createdAt: minutesAgo(11) } });
    await reconcileSavings({ full: false });
    row = await dbPot(row.id);
    assert.strictEqual(row.status, "error");
    assert.ok(await alertFired(`savings-provision-${row.id}`));
  });

  await test("a definite partner refusal on wallet create → 502 POT_PROVISION_FAILED, row in error", async () => {
    pv.subAccountMode = "reject";
    let r;
    try { r = await mkPot({ name: "Refused", backing: "piggyvest" }); }
    finally { pv.subAccountMode = "ok"; }
    assert.strictEqual(r.status, 502, JSON.stringify(r.body));
    assert.strictEqual(r.body?.code, "POT_PROVISION_FAILED");
    const row = await prisma.savingsPot.findFirst({ where: { name: "Refused" } });
    assert.strictEqual(row.status, "error");
  });

  await test("without KYC, email/phone or a BVN, no partner customer is created (409 SAVINGS_PROFILE_INCOMPLETE)", async () => {
    await prisma.savingsProfile.deleteMany({ where: { businessId: BIZ_ID } });
    const calls = pv.customerCalls.length;
    await prisma.user.update({ where: { id: owner.id }, data: { phone: null } });
    try {
      const r = await mkPot({ name: "No phone", backing: "piggyvest" });
      assert.strictEqual(r.status, 409, JSON.stringify(r.body));
      assert.strictEqual(r.body?.code, "SAVINGS_PROFILE_INCOMPLETE");
      assert.strictEqual(r.body?.missing, "phone");
    } finally {
      await prisma.user.update({ where: { id: owner.id }, data: { phone: "+2348012345678" } });
    }
    await prisma.business.update({ where: { id: BIZ_ID }, data: { kycBvn: null } });
    try {
      const r = await mkPot({ name: "No bvn", backing: "piggyvest" });
      assert.strictEqual(r.status, 409);
      assert.strictEqual(r.body?.missing, "bvn");
    } finally {
      await prisma.business.update({ where: { id: BIZ_ID }, data: { kycBvn: encrypt("22222222222") } });
    }
    assert.strictEqual(pv.customerCalls.length, calls, "no partner call without a complete profile");
    assert.strictEqual(await prisma.savingsPot.count({ where: { name: { in: ["No phone", "No bvn"] } } }), 0);
    // Restore the profile for the sections that follow.
    await prisma.savingsProfile.create({ data: { businessId: BIZ_ID, status: "ready", pvCustomerId: "pvcust_1" } });
  });

  // ══ 6. PIGGYVEST DEPOSITS ═════════════════════════════════════════════════
  section("6. PiggyVest deposits — a real NIP transfer, booked first");
  let expBefore, limitsBefore, dep1;
  {
    expBefore = await sumExpenses(BIZ_ID, wideRange());
    limitsBefore = (await GET(`/transfers/limits?businessId=${BIZ_ID}`, tOwner)).body;
  }

  await test("deposit → exactly one createTransfer with a kb_sv_ reference, movement `sent`, Transaction purpose savings_deposit", async () => {
    const r = await depositTo(pvPot.id, { amount: 50_000, idempotencyKey: "dep1" });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    dep1 = r.body.movement;
    assert.strictEqual(dep1.status, "sent");
    assert.strictEqual(dep1.reference, "kb_sv_dep1");
    assert.strictEqual(dep1.fee, 100, "₦50 fee + ₦50 stamp duty");
    assert.strictEqual(nipCalls.length, 1);
    assert.strictEqual(nipCalls[0].reference, "kb_sv_dep1");
    assert.strictEqual(nipCalls[0].amount, 50_000);
    const txn = await dbTxnByRef("kb_sv_dep1");
    assert.ok(txn, "the Anchor debit is booked");
    assert.strictEqual(txn.purpose, "savings_deposit");
    assert.strictEqual(txn.type, "expense");
    assert.strictEqual(txn.category, "transfer");
    assert.strictEqual(txn.source, "anchor");
    assert.strictEqual(txn.providerTxnId, "anc_tr_1", "Anchor's transfer id is kept");
    const row = await dbMovement(dep1.id);
    assert.strictEqual(row.transactionId, txn.id);
    assert.strictEqual(row.providerTransferId, "anc_tr_1");
    assert.strictEqual(row.payoutAccountNumber, pvPot.pvAccountNumber);
    assert.strictEqual(row.payoutBankCode, "090110");
    assert.ok(await pushes("Savings deposit sent"));
  });

  await test("the same idempotencyKey → same movement id, replay:true, no second createTransfer", async () => {
    const r = await depositTo(pvPot.id, { amount: 50_000, idempotencyKey: "dep1" });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.replay, true);
    assert.strictEqual(r.body.movement.id, dep1.id);
    assert.strictEqual(nipCalls.length, 1);
    assert.strictEqual(await prisma.transaction.count({ where: { reference: "kb_sv_dep1" } }), 1);
  });

  await test("insightsEngine.sumExpenses EXCLUDES the deposit; /transfers/limits INCLUDES it", async () => {
    const after = await sumExpenses(BIZ_ID, wideRange());
    assert.ok(sameKobo(after.total, expBefore.total), `expenses moved from ${expBefore.total} to ${after.total}`);
    assert.strictEqual(after.count, expBefore.count);
    const limits = (await GET(`/transfers/limits?businessId=${BIZ_ID}`, tOwner)).body;
    assert.ok(sameKobo(limits.dailySoFar, limitsBefore.dailySoFar + 50_000), `dailySoFar ${limitsBefore.dailySoFar} → ${limits.dailySoFar}`);
  });

  await test("the savings debit cannot be recorded as an expense (409 SAVINGS_ROW_NOT_MATCHABLE)", async () => {
    const txn = await dbTxnByRef("kb_sv_dep1");
    const r = await POST(`/transactions/${txn.id}/create-expense`, tOwner, { category: "rent", description: "x" });
    assert.strictEqual(r.status, 409, JSON.stringify(r.body));
    assert.strictEqual(r.body?.code, "SAVINGS_ROW_NOT_MATCHABLE");
  });

  await test("a large deposit needs the step-up OTP: 401 OTP_REQUIRED, one code sent, no movement, no bank call", async () => {
    const r = await depositTo(pvPot.id, { amount: 1_200_000, idempotencyKey: "big1" });
    assert.strictEqual(r.status, 401, JSON.stringify(r.body));
    assert.strictEqual(r.body?.code, "OTP_REQUIRED");
    assert.ok(r.body.otpIdentifier && !r.body.otpIdentifier.includes("owner@savings.test"), "only the masked identifier leaves");
    assert.strictEqual(otpDispatches.length, 1);
    assert.strictEqual(otpDispatches[0].identifier, "owner@savings.test");
    assert.strictEqual(await dbMovementByRef("kb_sv_big1"), null, "refused before the movement row exists");
    assert.strictEqual(nipCalls.length, 1);
  });

  await test("insufficient gross (pre-Anchor) → movement `failed`, 400 INSUFFICIENT_BALANCE, zero createTransfer calls", async () => {
    const before = anchorState.gross;
    anchorState.gross = 1_000;
    let r;
    try { r = await depositTo(pvPot.id, { amount: 30_000, idempotencyKey: "dep2" }); }
    finally { anchorState.gross = before; }
    assert.strictEqual(r.status, 400, JSON.stringify(r.body));
    assert.strictEqual(r.body?.code, "INSUFFICIENT_BALANCE");
    const row = await dbMovementByRef("kb_sv_dep2");
    assert.ok(row, "the movement row was written before the attempt");
    assert.strictEqual(row.status, "failed");
    assert.strictEqual(nipCalls.length, 1);
    assert.strictEqual(await dbTxnByRef("kb_sv_dep2"), null);
    // A failed movement is not in flight: the same key may NOT be re-sent. It
    // answers with the ORIGINAL refusal (409, replay:true) so the client mints
    // a new key rather than reading "sent" off a failure.
    const again = await depositTo(pvPot.id, { amount: 30_000, idempotencyKey: "dep2" });
    assert.strictEqual(again.status, 409, JSON.stringify(again.body));
    assert.strictEqual(again.body?.code, "DEPOSIT_FAILED");
    assert.strictEqual(again.body?.replay, true);
    assert.strictEqual(nipCalls.length, 1);
    // The same key with a DIFFERENT amount is a client bug, named as such.
    const wrong = await depositTo(pvPot.id, { amount: 31_000, idempotencyKey: "dep2" });
    assert.strictEqual(wrong.status, 409);
    assert.strictEqual(wrong.body?.code, "IDEMPOTENCY_MISMATCH");
    assert.strictEqual(nipCalls.length, 1);
  });

  await test("createTransfer throwing a network error → 202 and movement `unknown`; a retry never re-sends", async () => {
    anchorState.mode = "network";
    let r;
    try { r = await depositTo(pvPot.id, { amount: 40_000, idempotencyKey: "dep3" }); }
    finally { anchorState.mode = "ok"; }
    assert.strictEqual(r.status, 202, JSON.stringify(r.body));
    assert.strictEqual(r.body.movement.status, "unknown");
    assert.strictEqual(r.body.movement.reference, "kb_sv_dep3");
    assert.strictEqual(nipCalls.length, 2, "the attempt itself is counted");
    assert.strictEqual(await dbTxnByRef("kb_sv_dep3"), null);
    const retry = await depositTo(pvPot.id, { amount: 40_000, idempotencyKey: "dep3" });
    assert.strictEqual(retry.status, 202, JSON.stringify(retry.body));
    assert.strictEqual(retry.body.replay, true);
    assert.strictEqual(retry.body.movement.id, r.body.movement.id);
    assert.strictEqual(nipCalls.length, 2, "an unknown outcome is NEVER re-sent");
    assert.ok(await prisma.auditLog.count({ where: { action: "SAVINGS_DEPOSIT_UNKNOWN" } }));
    ctx.dep3 = r.body.movement;
  });

  await test("an `unknown` deposit with no Anchor row after 30 min → needs_review (reconcile), still never re-sent", async () => {
    const stats0 = await reconcileSavings({ full: false });
    assert.strictEqual((await dbMovement(ctx.dep3.id)).status, "unknown", `too early: ${JSON.stringify(stats0)}`);
    await prisma.savingsMovement.update({ where: { id: ctx.dep3.id }, data: { createdAt: minutesAgo(31) } });
    const stats = await reconcileSavings({ full: false });
    assert.strictEqual(stats.depositsReviewed, 1, JSON.stringify(stats));
    const row = await dbMovement(ctx.dep3.id);
    assert.strictEqual(row.status, "needs_review");
    assert.ok(/no bank record/.test(row.error || ""), row.error);
    assert.ok(await alertFired(`savings-deposit-review-${row.id}`));
    assert.strictEqual(nipCalls.length, 2);
    // Under review: the key answers 409 NEEDS_REVIEW, and is never re-sent.
    const retry = await depositTo(pvPot.id, { amount: 40_000, idempotencyKey: "dep3" });
    assert.strictEqual(retry.status, 409, JSON.stringify(retry.body));
    assert.strictEqual(retry.body?.code, "NEEDS_REVIEW");
    assert.strictEqual(retry.body?.replay, true);
    assert.strictEqual(nipCalls.length, 2);
  });

  await test("an `unknown` deposit whose Anchor row DOES exist is repaired to `sent` by reconcile", async () => {
    // Simulate: Anchor accepted, our process died before the movement update.
    const r = await depositTo(pvPot.id, { amount: 1_000, idempotencyKey: "dep4" });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    await prisma.savingsMovement.update({ where: { id: r.body.movement.id }, data: { status: "unknown", transactionId: null, providerTransferId: null } });
    const stats = await reconcileSavings({ full: false });
    assert.strictEqual(stats.depositsSent, 1, JSON.stringify(stats));
    const row = await dbMovement(r.body.movement.id);
    assert.strictEqual(row.status, "sent");
    assert.strictEqual(row.transactionId, (await dbTxnByRef("kb_sv_dep4")).id);
    assert.strictEqual(nipCalls.length, 3);
  });

  await test("a PiggyVest inflow carrying our reference completes the deposit once", async () => {
    pv.credit(pvPot.pvWalletId, { id: "pvtx_dep1", amount: 50_000, narration: "NIP/ADA STORES/Savings Rent kb_sv_dep1" });
    const stats = await reconcileSavings({ full: false });
    assert.strictEqual(stats.depositsCompleted, 1, JSON.stringify(stats));
    const row = await dbMovement(dep1.id);
    assert.strictEqual(row.status, "completed");
    assert.strictEqual(row.pvTxnId, "pvtx_dep1");
    assert.strictEqual(row.landedAmount, 50_000);
    assert.ok(row.completedAt);
    assert.strictEqual((await dbPot(pvPot.id)).balance, 50_000, "pot balance is a copy of the wallet");
    assert.ok(await pushes("Savings deposit arrived"));
    const again = await reconcileSavings({ full: false });
    assert.strictEqual(again.depositsCompleted, 0);
    assert.strictEqual(await prisma.savingsMovement.count({ where: { pvTxnId: "pvtx_dep1" } }), 1);
    assert.strictEqual(await prisma.savingsMovement.count({ where: { potId: pvPot.id, type: "external_deposit" } }), 0, "our own deposit is never re-booked as external");
  });

  await test("POST /transfers/send to a pot's funding account moves nothing", async () => {
    const before = nipCalls.length;
    const r = await send({ accountNumber: pvPot.pvAccountNumber, bankCode: "090110", accountName: undefined, bankName: PV_FUNDING_BANK, amount: 1_000, idempotencyKey: "topot" });
    assert.ok(r.status >= 400 && r.status < 500, `expected a refusal, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(nipCalls.length, before, "no bank call");
    assert.strictEqual(await dbTxnByRef("kbtf_topot"), null, "no ledger row");
    ctx.toPotResponse = r;
  });

  await test("...and the refusal carries code SAVINGS_DEST_USE_DEPOSIT (the plan's contract)", async () => {
    const r = ctx.toPotResponse;
    assert.strictEqual(r.body?.code, "SAVINGS_DEST_USE_DEPOSIT", `got ${JSON.stringify(r.body)} — routes/transfers.js maps this error to a bare "Transfer failed"`);
  });

  await test("closing a PiggyVest pot that holds money → 409 POT_NOT_EMPTY (live wallet balance)", async () => {
    const r = await DEL(`/savings/pots/${pvPot.id}?businessId=${BIZ_ID}`, tOwner);
    assert.strictEqual(r.status, 409, JSON.stringify(r.body));
    assert.strictEqual(r.body?.code, "POT_NOT_EMPTY");
    assert.strictEqual((await dbPot(pvPot.id)).status, "active");
  });

  // ══ 7. PIGGYVEST WITHDRAWALS ══════════════════════════════════════════════
  section("7. PiggyVest withdrawals — claimed before the POST, settled by verify");
  let wd1;

  await test("withdrawal → 202 `processing`, one transferToBank to the merchant's OWN NUBAN with a kb_svw_ reference", async () => {
    assert.strictEqual(pv.wallet(pvPot.pvWalletId).balance, 50_000, "fixture");
    const r = await withdrawFrom(pvPot.id, { amount: 20_000, idempotencyKey: "wd1" });
    assert.strictEqual(r.status, 202, JSON.stringify(r.body));
    wd1 = r.body.movement;
    assert.strictEqual(wd1.status, "processing");
    assert.strictEqual(wd1.reference, "kb_svw_wd1");
    assert.strictEqual(pv.transferCalls.length, 1);
    const call = pv.transferCalls[0];
    assert.strictEqual(call.reference, "kb_svw_wd1");
    assert.strictEqual(call.accountNumber, BIZ_NUBAN, "payout goes to the merchant's own account");
    assert.strictEqual(call.bankCode, "101", "PiggyVest's code for Providus");
    assert.strictEqual(call.walletId, pvPot.pvWalletId);
    assert.strictEqual(call.amount, 20_000);
    assert.strictEqual(pv.enquiries.length, 1, "the payout target is name-checked first");
    const row = await dbMovement(wd1.id);
    assert.strictEqual(row.payoutAccountNumber, BIZ_NUBAN);
    assert.strictEqual(row.pvReference, "pvref_1");
    assert.strictEqual(r.body.pot.balance, 30_000, "optimistic pot figure");
    assert.strictEqual(nipCalls.length, 3, "a withdrawal is not an Anchor transfer");
    // PiggyVest has accepted it and is working on it; every reconcile tick from
    // here until the success test must see "pending", not "not found".
    pv.verify.set("kb_svw_wd1", { status: "pending" });
  });

  await test("a second withdrawal while one is in flight → 409 WITHDRAWAL_IN_FLIGHT, no partner call", async () => {
    const r = await withdrawFrom(pvPot.id, { amount: 1_000, idempotencyKey: "wd1b" });
    assert.strictEqual(r.status, 409, JSON.stringify(r.body));
    assert.strictEqual(r.body?.code, "WITHDRAWAL_IN_FLIGHT");
    assert.strictEqual(pv.transferCalls.length, 1);
    assert.strictEqual(await dbMovementByRef("kb_svw_wd1b"), null);
  });

  await test("the same withdrawal key replays and is never re-POSTed", async () => {
    const r = await withdrawFrom(pvPot.id, { amount: 20_000, idempotencyKey: "wd1" });
    assert.strictEqual(r.body?.replay, true, JSON.stringify(r.body));
    assert.strictEqual(r.body.movement.id, wd1.id);
    assert.strictEqual(pv.transferCalls.length, 1);
  });

  await test("a payout name mismatch stops the withdrawal BEFORE any partner call", async () => {
    // Fresh pot so the in-flight guard does not mask the check.
    const pot = await mkPvPot("Name check", { balance: 5_000 });
    pv.enquiryName = "SOMEBODY ELSE";
    let r;
    try { r = await withdrawFrom(pot.id, { amount: 1_000, idempotencyKey: "nm1" }); }
    finally { pv.enquiryName = "ADA STORES"; }
    assert.strictEqual(r.status, 409, JSON.stringify(r.body));
    assert.strictEqual(r.body?.code, "PAYOUT_TARGET_UNVERIFIED");
    assert.strictEqual(pv.transferCalls.length, 1);
    assert.strictEqual(await dbMovementByRef("kb_svw_nm1"), null);
  });

  await test("webhook payload is not proof: verify says pending → still processing (reconcile)", async () => {
    pv.verify.set("kb_svw_wd1", { status: "pending" });
    const stats = await reconcileSavings({ full: false });
    assert.strictEqual(stats.withdrawalsSettled, 0, JSON.stringify(stats));
    assert.strictEqual((await dbMovement(wd1.id)).status, "processing");
  });

  await test("verify success on reconcile → completed, wallet re-read, push sent", async () => {
    pv.verify.set("kb_svw_wd1", { status: "success", amount: 20_000, fee: 0, txnId: "pvt_wd1" });
    pv.wallet(pvPot.pvWalletId).balance = 30_000; // PiggyVest debited the wallet
    const stats = await reconcileSavings({ full: false });
    assert.strictEqual(stats.withdrawalsSettled, 1, JSON.stringify(stats));
    const row = await dbMovement(wd1.id);
    assert.strictEqual(row.status, "completed");
    assert.ok(row.completedAt);
    assert.strictEqual(row.pvReference, "pvt_wd1");
    assert.strictEqual(row.landedTransactionId, null, "landing is orthogonal to completion");
    assert.strictEqual((await dbPot(pvPot.id)).balance, 30_000);
    assert.ok(await pushes("Savings withdrawal complete"));
    assert.strictEqual(pv.transferCalls.length, 1);
  });

  // ── The Anchor credit coming home ──
  let incomeBefore, ledgerBefore, invoice;
  await test("an Anchor credit with the kb_svw_ narration books as purpose savings_withdrawal and lands the movement", async () => {
    invoice = await prisma.invoice.create({
      data: { businessId: BIZ_ID, userId: owner.id, invoiceNumber: "INV-0001", status: "SENT", type: "invoice", issueDate: new Date().toISOString().slice(0, 10), total: 20_000, amountPaid: 0 },
    });
    incomeBefore = await sumIncome(BIZ_ID, wideRange());
    // The RAW ledger: this seed has only debits so far, and computeLedgerBalance
    // floors a negative ledger at 0, which would hide the credit.
    ledgerBefore = await computeRawLedger(BIZ_ID, "NGN");
    anchorFeed.push({
      id: "anc_tx_land_1",
      attributes: {
        direction: "credit", amount: 20_000 * 100, createdAt: minutesAgo(11).toISOString(),
        reference: "PVPAY0001", narration: "KashBook savings kb_svw_wd1",
        counterParty: { accountName: "PIGGYTECH GLOBAL LIMITED", bankName: "Providus Bank", accountNumber: "5550001111" },
      },
      relationships: {},
    });
    const created = await reconcileBusiness(await dbBiz());
    assert.strictEqual(created, 1);
    const txn = await dbTxnByRef("anc_txn_PVPAY0001");
    assert.ok(txn, "the credit is booked");
    assert.strictEqual(txn.purpose, "savings_withdrawal");
    assert.strictEqual(txn.type, "income");
    assert.strictEqual(txn.source, "anchor");
    assert.strictEqual(txn.amount, 20_000);
    const row = await dbMovement(wd1.id);
    assert.strictEqual(row.landedTransactionId, txn.id);
    assert.strictEqual(row.landedAmount, 20_000);
    assert.ok(await pushes("Savings arrived"));
    assert.strictEqual(await pushes("Invoice Paid ✅"), 0, "no invoice push for the merchant's own money");
    ctx.landedTxn = txn;
  });

  await test("an open invoice of the same amount stays SENT; sumIncome excludes the credit; the ledger balance includes it", async () => {
    const inv = await prisma.invoice.findUnique({ where: { id: invoice.id } });
    assert.strictEqual(inv.status, "SENT");
    assert.strictEqual(inv.amountPaid, 0);
    assert.strictEqual(await prisma.invoicePayment.count({ where: { invoiceId: invoice.id } }), 0);
    const income = await sumIncome(BIZ_ID, wideRange());
    assert.ok(sameKobo(income.total, incomeBefore.total), `income moved ${incomeBefore.total} → ${income.total}`);
    const ledger = await computeRawLedger(BIZ_ID, "NGN");
    assert.ok(sameKobo(ledger, ledgerBefore + 20_000), `ledger ${ledgerBefore} → ${ledger}`);
  });

  await test("the landed credit cannot be matched to a sale, debt or invoice (409 SAVINGS_ROW_NOT_MATCHABLE)", async () => {
    const txn = ctx.landedTxn;
    for (const [path, body] of [["match", { saleId: "x" }], ["match-debt", { customerId: "x" }], ["create-sale", { channel: "walk-in" }]]) {
      const r = await POST(`/transactions/${txn.id}/${path}`, tOwner, body);
      assert.strictEqual(r.status, 409, `${path}: ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body?.code, "SAVINGS_ROW_NOT_MATCHABLE");
    }
  });

  await test("re-polling the same credit books nothing twice", async () => {
    const created = await reconcileBusiness(await dbBiz());
    assert.strictEqual(created, 0);
    assert.strictEqual(await prisma.transaction.count({ where: { businessId: BIZ_ID, purpose: "savings_withdrawal" } }), 1);
  });

  await test("a CUSTOMER credit of the same amount is still income and still settles the invoice", async () => {
    anchorFeed.length = 0;
    anchorFeed.push({
      id: "anc_tx_cust_1",
      attributes: {
        direction: "credit", amount: 20_000 * 100, createdAt: minutesAgo(12).toISOString(),
        reference: "CUST0001", narration: "invoice payment",
        counterParty: { accountName: "OLU AJAYI", bankName: "GTBank", accountNumber: "0011223344" },
      },
      relationships: {},
    });
    const created = await reconcileBusiness(await dbBiz());
    assert.strictEqual(created, 1);
    const txn = await dbTxnByRef("anc_txn_CUST0001");
    assert.strictEqual(txn.purpose, null);
    const inv = await prisma.invoice.findUnique({ where: { id: invoice.id } });
    assert.strictEqual(inv.status, "PAID");
    const income = await sumIncome(BIZ_ID, wideRange());
    assert.ok(income.total > incomeBefore.total, "a customer's money counts");
  });

  await test("transferToBank timeout → `unknown`; two not_found verifies 10 min apart → `failed` with ONE partner call", async () => {
    pv.transferMode = "timeout";
    let r;
    try { r = await withdrawFrom(pvPot.id, { amount: 5_000, idempotencyKey: "wd2" }); }
    finally { pv.transferMode = "ok"; }
    assert.strictEqual(r.status, 202, JSON.stringify(r.body));
    assert.strictEqual(r.body.movement.status, "unknown");
    const calls = pv.transferCalls.length;
    assert.strictEqual(pv.transferCalls[calls - 1].reference, "kb_svw_wd2");
    // Tick 1: first miss.
    await reconcileSavings({ full: false });
    let row = await dbMovementByRef("kb_svw_wd2");
    assert.strictEqual(row.status, "unknown");
    assert.strictEqual(row.verifyMisses, 1);
    assert.ok(row.lastVerifiedAt);
    // A retry from the client replays, never re-POSTs.
    const retry = await withdrawFrom(pvPot.id, { amount: 5_000, idempotencyKey: "wd2" });
    assert.strictEqual(retry.body?.replay, true);
    // Tick 2, ten minutes later: second miss → failed.
    await prisma.savingsMovement.update({ where: { id: row.id }, data: { lastVerifiedAt: minutesAgo(11) } });
    const stats = await reconcileSavings({ full: false });
    assert.strictEqual(stats.withdrawalsSettled, 1, JSON.stringify(stats));
    row = await dbMovementByRef("kb_svw_wd2");
    assert.strictEqual(row.status, "failed");
    assert.ok(/no record/.test(row.error || ""), row.error);
    assert.strictEqual(pv.transferCalls.length, calls, "no second transferToBank");
    assert.ok(await pushes("Savings withdrawal failed"));
    assert.strictEqual((await dbPot(pvPot.id)).balance, 30_000, "the optimistic debit is undone from the wallet");
  });

  await test("(cadence) three not_found ticks at the loop's own 5-minute spacing must still reach `failed`", async () => {
    // The production loop runs every 5 minutes. Two misses "ten minutes apart"
    // must therefore be reachable from ticks at t, t+5, t+10.
    const pot = ctx.restock;
    pv.wallet(pot.pvWalletId).balance = 10_000;
    pv.transferMode = "timeout";
    let r;
    try { r = await withdrawFrom(pot.id, { amount: 1_000, idempotencyKey: "wdc1" }); }
    finally { pv.transferMode = "ok"; }
    assert.strictEqual(r.body?.movement?.status, "unknown", JSON.stringify(r.body));
    const id = r.body.movement.id;
    await reconcileSavings({ full: false });                                              // t
    await prisma.savingsMovement.update({ where: { id }, data: { lastVerifiedAt: minutesAgo(5) } });
    await reconcileSavings({ full: false });                                              // t+5
    await prisma.savingsMovement.update({ where: { id }, data: { lastVerifiedAt: minutesAgo(5) } });
    await reconcileSavings({ full: false });                                              // t+10
    const row = await dbMovement(id);
    assert.strictEqual(row.status, "failed", `still ${row.status} after three 5-minute ticks (verifyMisses=${row.verifyMisses}): applyWithdrawalOutcome advances lastVerifiedAt on every not_found, so the 10-minute spacing is never reached`);
  });

  await test("forfeit: withdrawal count 4 → 409 INTEREST_FORFEIT_CONFIRM, then success with acceptInterestForfeit", async () => {
    pv.wallet(pvPot.pvWalletId).withdrawalCount = 4;
    const calls = pv.transferCalls.length;
    const r1 = await withdrawFrom(pvPot.id, { amount: 1_000, idempotencyKey: "wd3" });
    assert.strictEqual(r1.status, 409, JSON.stringify(r1.body));
    assert.strictEqual(r1.body?.code, "INTEREST_FORFEIT_CONFIRM");
    assert.strictEqual(r1.body?.withdrawalsThisMonth, 4);
    assert.strictEqual(pv.transferCalls.length, calls);
    assert.strictEqual(await dbMovementByRef("kb_svw_wd3"), null);
    const r2 = await withdrawFrom(pvPot.id, { amount: 1_000, idempotencyKey: "wd3", acceptInterestForfeit: true });
    assert.strictEqual(r2.status, 202, JSON.stringify(r2.body));
    assert.strictEqual(r2.body.movement.status, "processing");
    assert.strictEqual(pv.transferCalls.length, calls + 1);
    // Settle it so the pot is free for the next tests.
    pv.verify.set("kb_svw_wd3", { status: "success", txnId: "pvt_wd3" });
    pv.wallet(pvPot.pvWalletId).balance = 29_000;
    pv.wallet(pvPot.pvWalletId).withdrawalCount = 5;
    await reconcileSavings({ full: false });
    assert.strictEqual((await dbMovementByRef("kb_svw_wd3")).status, "completed");
    pv.wallet(pvPot.pvWalletId).withdrawalCount = 0;
    await reconcileSavings({ full: false });
  });

  await test("a definite partner refusal (4xx) → 502 WITHDRAWAL_REJECTED, movement failed, pot figure restored", async () => {
    pv.transferMode = "reject";
    let r;
    try { r = await withdrawFrom(pvPot.id, { amount: 1_000, idempotencyKey: "wd4" }); }
    finally { pv.transferMode = "ok"; }
    assert.strictEqual(r.status, 502, JSON.stringify(r.body));
    assert.strictEqual(r.body?.code, "WITHDRAWAL_REJECTED");
    const row = await dbMovementByRef("kb_svw_wd4");
    assert.strictEqual(row.status, "failed");
    assert.strictEqual((await dbPot(pvPot.id)).balance, 29_000);
    const next = await withdrawFrom(pvPot.id, { amount: 1_000, idempotencyKey: "wd4b" });
    assert.strictEqual(next.status, 202, `a failed row is not in flight: ${JSON.stringify(next.body)}`);
    pv.verify.set("kb_svw_wd4b", { status: "success", txnId: "pvt_wd4b" });
    pv.wallet(pvPot.pvWalletId).balance = 28_000;
    await reconcileSavings({ full: false });
    assert.strictEqual((await dbMovementByRef("kb_svw_wd4b")).status, "completed");
  });

  await test("a withdrawal completed at PiggyVest with no Anchor credit for 2h raises savings-unlanded (never auto-tagged)", async () => {
    const row = await dbMovementByRef("kb_svw_wd4b");
    await prisma.savingsMovement.update({ where: { id: row.id }, data: { completedAt: minutesAgo(130) } });
    await reconcileSavings({ full: false });
    assert.ok(await alertFired(`savings-unlanded-${row.id}`));
    assert.strictEqual((await dbMovement(row.id)).landedTransactionId, null);
  });

  // ══ 8. WEBHOOK ════════════════════════════════════════════════════════════
  section("8. PiggyVest webhook — a signed nudge, never proof");
  let wd5;

  await test("GET /webhooks/piggyvest → 200 (their registration probe)", async () => {
    const r = await req("GET", "/webhooks/piggyvest");
    assert.strictEqual(r.status, 200);
  });

  await test("fixture: a processing withdrawal whose verify says pending", async () => {
    const r = await withdrawFrom(pvPot.id, { amount: 2_000, idempotencyKey: "wd5" });
    assert.strictEqual(r.status, 202, JSON.stringify(r.body));
    wd5 = r.body.movement;
    pv.verify.set("kb_svw_wd5", { status: "pending" });
  });

  await test("bad signature → 401, nothing processed, no marker", async () => {
    const evt = { eventId: "evt_bad_1", eventType: "bank-transfer.outflow.success", eventData: { reference: "kb_svw_wd5" }, pvb_wallet: pvPot.pvWalletId };
    const r = await webhook(evt, { signature: "0".repeat(128) });
    assert.strictEqual(r.status, 401);
    const wrongKey = crypto.createHmac("sha512", "not-the-secret").update(JSON.stringify(evt)).digest("hex");
    assert.strictEqual((await webhook(evt, { signature: wrongKey })).status, 401);
    assert.strictEqual((await req("POST", "/webhooks/piggyvest", { rawBody: JSON.stringify(evt) })).status, 401, "no header at all");
    await pause(150);
    assert.strictEqual(await markerCount("evt_bad_1"), 0);
    assert.strictEqual(pv.verifyCalls.filter((x) => x === "kb_svw_wd5").length, 0, "an unsigned nudge triggers no verify");
  });

  await test("outflow.success with a valid HMAC → 200; verify says pending → still processing", async () => {
    const evt = { eventId: "evt_ok_1", eventType: "bank-transfer.outflow.success", eventData: { reference: "kb_svw_wd5", amount: 200000, status: "success" }, pvb_wallet: pvPot.pvWalletId };
    const r = await webhook(evt);
    assert.strictEqual(r.status, 200, r.raw);
    await waitFor(async () => (await markerCount("evt_ok_1")) === 1, { label: "marker evt_ok_1" });
    assert.ok(pv.verifyCalls.includes("kb_svw_wd5"), "the nudge re-checks with our own key");
    assert.strictEqual((await dbMovement(wd5.id)).status, "processing", "a payload saying success is not proof");
  });

  await test("pretty-printed body with a valid HMAC over the compact form → 200 and processed", async () => {
    const evt = { eventId: "evt_pretty_1", eventType: "bank-transfer.outflow.success", eventData: { reference: "kb_svw_wd5" }, pvb_wallet: pvPot.pvWalletId };
    const r = await webhook(evt, { pretty: true });
    assert.strictEqual(r.status, 200, r.raw);
    await waitFor(async () => (await markerCount("evt_pretty_1")) === 1, { label: "marker evt_pretty_1" });
  });

  await test("duplicate eventId → one ProcessedWebhook marker", async () => {
    const evt = { eventId: "evt_dup_1", eventType: "bank-transfer.outflow.success", eventData: { reference: "kb_svw_wd5" }, pvb_wallet: pvPot.pvWalletId };
    const [a, b] = [await webhook(evt), await webhook(evt)];
    assert.strictEqual(a.status, 200);
    assert.strictEqual(b.status, 200);
    await waitFor(async () => (await markerCount("evt_dup_1")) >= 1, { label: "marker evt_dup_1" });
    await pause(150);
    assert.strictEqual(await markerCount("evt_dup_1"), 1);
  });

  await test("once verify says success, the nudge settles it (no reconcile tick needed)", async () => {
    pv.verify.set("kb_svw_wd5", { status: "success", txnId: "pvt_wd5" });
    pv.wallet(pvPot.pvWalletId).balance = 26_000;
    const evt = { eventId: "evt_ok_2", eventType: "bank-transfer.outflow.success", eventData: { reference: "kb_svw_wd5" }, pvb_wallet: pvPot.pvWalletId };
    assert.strictEqual((await webhook(evt)).status, 200);
    await waitFor(async () => (await dbMovement(wd5.id)).status === "completed", { label: "wd5 completed" });
    assert.strictEqual((await dbPot(pvPot.id)).balance, 26_000);
    assert.strictEqual(pv.transferCalls.filter((c) => c.reference === "kb_svw_wd5").length, 1);
  });

  await test("an inflow event nudges the wallet reconcile (deposit completed by webhook)", async () => {
    const r = await depositTo(pvPot.id, { amount: 3_000, idempotencyKey: "dep5" });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    pv.credit(pvPot.pvWalletId, { id: "pvtx_dep5", amount: 3_000, narration: "Savings Rent kb_sv_dep5" });
    const evt = { eventId: "evt_in_1", eventType: "bank-transfer.inflow.success", eventData: { wallet_id: pvPot.pvWalletId, amount: 300000 } };
    assert.strictEqual((await webhook(evt)).status, 200);
    await waitFor(async () => (await dbMovement(r.body.movement.id)).status === "completed", { label: "dep5 completed by webhook" });
    assert.strictEqual((await dbMovement(r.body.movement.id)).pvTxnId, "pvtx_dep5");
  });

  await test("unknown event types are acknowledged and ignored", async () => {
    const evt = { eventId: "evt_weird_1", eventType: "something.else", eventData: {} };
    assert.strictEqual((await webhook(evt)).status, 200);
    await waitFor(async () => (await markerCount("evt_weird_1")) === 1, { label: "marker evt_weird_1" });
  });

  await test("malformed JSON with any signature → 400", async () => {
    const r = await req("POST", "/webhooks/piggyvest", { rawBody: "{not json", headers: { "x-pvb-signature": signPvb("{not json") } });
    assert.strictEqual(r.status, 400);
  });

  // ══ 9. INTEREST + STRAY INFLOWS ═══════════════════════════════════════════
  section("9. interest and external inflows — booked once, keyed on the partner id");

  await test("an interest inflow → exactly one `interest` movement across two reconcile ticks; interestEarned follows", async () => {
    const wallet = pv.wallet(pvPot.pvWalletId);
    pv.credit(pvPot.pvWalletId, { id: "pvtx_int_1", amount: 12.5, narration: "Interest payout for the month", category: "interest" });
    pv.accrued.set(pvPot.pvWalletId, [{ amount: 1.1, rate: 10 }, { amount: 2.1, rate: 10 }]);
    await reconcileSavings({ full: true });
    await reconcileSavings({ full: true });
    const rows = await prisma.savingsMovement.findMany({ where: { potId: pvPot.id, type: "interest" } });
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].pvTxnId, "pvtx_int_1");
    assert.strictEqual(rows[0].status, "completed");
    assert.strictEqual(rows[0].amount, 12.5);
    const pot = await dbPot(pvPot.id);
    assert.strictEqual(pot.interestEarned, 12.5);
    assert.ok(sameKobo(pot.interestAccruedMtd, 3.2));
    assert.strictEqual(pot.interestRate, 10);
    assert.ok(sameKobo(pot.balance, wallet.balance));
    assert.strictEqual(await pushes("Interest paid"), 1);
    assert.strictEqual(await prisma.transaction.count({ where: { businessId: BIZ_ID, purpose: "savings_interest" } }), 0, "interest inside the wallet is not a bank row");
  });

  await test("an inflow that is not ours and not interest → one `external_deposit` movement", async () => {
    pv.credit(pvPot.pvWalletId, { id: "pvtx_ext_1", amount: 7_000, narration: "NIP/OLU AJAYI/gift" });
    await reconcileSavings({ full: false });
    await reconcileSavings({ full: false });
    const rows = await prisma.savingsMovement.findMany({ where: { potId: pvPot.id, type: "external_deposit" } });
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].pvTxnId, "pvtx_ext_1");
    assert.strictEqual(rows[0].amount, 7_000);
    const pot = await dbPot(pvPot.id);
    assert.strictEqual(pot.interestEarned, 12.5, "an external deposit is not interest");
    assert.ok(sameKobo(pot.balance, pv.wallet(pvPot.pvWalletId).balance));
  });

  await test("GET /savings totals: saved is the wallet copy, interestEarned the sum of interest", async () => {
    const r = await GET(`/savings?businessId=${BIZ_ID}`, tOwner);
    assert.strictEqual(r.status, 200);
    const shown = r.body.pots.find((p) => p.id === pvPot.id);
    assert.ok(sameKobo(shown.balance, pv.wallet(pvPot.pvWalletId).balance));
    assert.strictEqual(shown.interestEarned, 12.5);
    assert.ok(r.body.totals.interestEarned >= 12.5);
    assert.strictEqual(r.body.totals.reserved, 0, "PiggyVest money is not in the Anchor reserve");
  });

  // ══ 10. FROZEN ════════════════════════════════════════════════════════════
  section("10. frozen — no money moves in either direction");
  await seed();
  const fz = (await mkPot({ name: "Frozen test" })).body.pot;
  await depositTo(fz.id, { amount: 5_000, idempotencyKey: "fz0" });

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
      const g = await GET(`/savings?businessId=${BIZ_ID}`, tOwner);
      assert.strictEqual(g.status, 200);
      assert.strictEqual((await dbPot(fz.id)).balance, 5_000);
    } finally {
      await prisma.user.update({ where: { id: owner.id }, data: { accountStatus: "active" } });
    }
  });

  // ══ 11. ACCOUNT DELETION ══════════════════════════════════════════════════
  section("11. account deletion — never around a pot with money");
  await seed();

  await test("delete-account with a pot balance → 400 SAVINGS_REMAINING", async () => {
    const pot = (await mkPot({ name: "Rent" })).body.pot;
    await depositTo(pot.id, { amount: 5_000, idempotencyKey: "del1" });
    const r = await POST("/auth/delete-account", tOwner, { password: PASSWORD });
    assert.strictEqual(r.status, 400, JSON.stringify(r.body));
    assert.strictEqual(r.body?.code, "SAVINGS_REMAINING");
    assert.ok(/Rent/.test(r.body.error));
    const u = await prisma.user.findUnique({ where: { id: owner.id } });
    assert.strictEqual(u.accountStatus, "active", "nothing was deleted");
    ctx.delPot = pot;
  });

  await test("delete-account with a movement still settling → 400 SAVINGS_REMAINING", async () => {
    const pot = ctx.delPot;
    await withdrawFrom(pot.id, { amount: 5_000, idempotencyKey: "delw" });
    await DEL(`/savings/pots/${pot.id}?businessId=${BIZ_ID}`, tOwner);
    const pvp = await mkPvPot("Pending", { balance: 0 });
    const mv = await prisma.savingsMovement.create({
      data: { potId: pvp.id, businessId: BIZ_ID, userId: owner.id, type: "withdrawal", backing: "piggyvest", amount: 1, status: "processing", reference: "kb_svw_manual1" },
    });
    const r = await POST("/auth/delete-account", tOwner, { password: PASSWORD });
    assert.strictEqual(r.status, 400, JSON.stringify(r.body));
    assert.strictEqual(r.body?.code, "SAVINGS_REMAINING");
    assert.ok(/processed/.test(r.body.error));
    await prisma.savingsMovement.update({ where: { id: mv.id }, data: { status: "failed" } });
    await prisma.savingsPot.update({ where: { id: pvp.id }, data: { status: "closed", closedAt: new Date() } });
  });

  await test("with pots empty and closed, the savings guard steps aside (the bank-balance guard answers instead)", async () => {
    const r = await POST("/auth/delete-account", tOwner, { password: PASSWORD });
    assert.strictEqual(r.status, 400, JSON.stringify(r.body));
    assert.strictEqual(r.body?.code, "BALANCE_REMAINING");
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
