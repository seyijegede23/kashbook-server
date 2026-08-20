// End-to-end test of bank-credit matching: match-to-sale, create-sale-from-
// credit, apply-to-debt, and unmatch — through the REAL routers over HTTP
// against a REAL Postgres. No provider stub needed: matching never calls a bank.
//
// Each assertion names the bug it keeps dead:
//   * the feature 404ing (the router spent months unmounted)
//   * match offered on outbound transfers
//   * match-debt applying twice on a repeat call
//   * unmatch leaving the debt payments applied
//   * a matched credit double-counting in income
//   * staff without canViewBalance reaching the bank ledger through this door
//
//   TEST_DATABASE_URL=postgresql://... node scripts/match-e2e-test.js

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
process.env.JWT_SECRET = "e2e-only-secret-0123456789abcdef0123456789abcdef";
process.env.NODE_ENV = "test";

const assert = require("assert");
const http = require("http");
const express = require("express");
const bcrypt = require("@node-rs/bcrypt");

const prisma = require("../src/utils/db");
const { signToken } = require("../src/utils/jwt");
const { sumIncome, sumExpenses } = require("../src/utils/insightsEngine");

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use("/auth", require("../src/routes/auth"));
app.use("/customers", require("../src/routes/customers"));
app.use("/sales", require("../src/routes/sales"));
app.use("/transactions", require("../src/routes/transactions"));

let server, BASE;
const req = (method, path, { token, body } = {}) =>
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
        try { j = JSON.parse(d); } catch {}
        resolve({ status: res.statusCode, body: j, raw: d });
      });
    });
    r.on("error", (e) => resolve({ status: 0, body: { error: e.message } }));
    if (data) r.write(data);
    r.end();
  });
const GET = (p, t) => req("GET", p, { token: t });
const POST = (p, t, b) => req("POST", p, { token: t, body: b });
const DEL = (p, t) => req("DELETE", p, { token: t });

let passed = 0, failed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (e) {
    console.log(`  FAIL  ${name}\n        ${e.message.split("\n")[0]}`);
    failures.push(name); failed++;
  }
}
const section = (s) => console.log(`\n── ${s} ${"─".repeat(Math.max(0, 58 - s.length))}`);

let owner, staffNo, staffYes, biz, customer, tOwner, tStaffNo, tStaffYes;
let seq = 0;
const credit = (amount, over = {}) =>
  prisma.transaction.create({
    data: {
      businessId: biz.id, userId: owner.id, type: "income", amount,
      category: "transfer", paymentMethod: "bank", source: "anchor",
      currency: "NGN", date: new Date(), reference: `m_${Date.now()}_${seq++}`,
      description: `Transfer received from TEST SENDER · Ref: x${seq}`,
      ...over,
    },
  });

// The income window sumIncome aggregates over.
const RANGE = { start: new Date(Date.now() - 7 * 86400000), end: new Date(Date.now() + 86400000) };
const income = async () => (await sumIncome(biz.id, RANGE)).total;

async function wipe() {
  const ids = ["me2e_owner", "me2e_sno", "me2e_syes"];
  await prisma.debtPayment.deleteMany({ where: { debt: { customer: { userId: owner?.id || "me2e_owner" } } } }).catch(() => {});
  await prisma.debt.deleteMany({ where: { customer: { userId: "me2e_owner" } } }).catch(() => {});
  await prisma.customer.deleteMany({ where: { userId: "me2e_owner" } }).catch(() => {});
  await prisma.sales.deleteMany({ where: { businessId: "me2e_biz" } }).catch(() => {});
  await prisma.expense.deleteMany({ where: { businessId: "me2e_biz" } }).catch(() => {});
  await prisma.transaction.deleteMany({ where: { businessId: "me2e_biz" } }).catch(() => {});
  await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } }).catch(() => {});
  await prisma.staffPermission.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
  await prisma.business.deleteMany({ where: { id: "me2e_biz" } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
}

(async () => {
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  BASE = `http://127.0.0.1:${server.address().port}`;
  console.log(`\nBANK-CREDIT MATCHING — END-TO-END (real routers, real DB)\n${BASE}`);

  await wipe();
  const mk = (over) => prisma.user.create({
    data: {
      password: "x", businessName: "Match Co", country: "NG", currency: "NGN",
      plan: "PREMIUM", ...over,
    },
  });
  owner = await mk({ id: "me2e_owner", email: "me2e_owner@t.local", firstName: "Own", lastName: "Er", accountType: "OWNER" });
  staffNo = await mk({ id: "me2e_sno", email: "me2e_sno@t.local", firstName: "No", lastName: "Grant", accountType: "STAFF", employerId: owner.id });
  staffYes = await mk({ id: "me2e_syes", email: "me2e_syes@t.local", firstName: "Has", lastName: "Grant", accountType: "STAFF", employerId: owner.id });
  await prisma.staffPermission.create({
    data: { userId: staffYes.id, employerId: owner.id, canViewBalance: true, grantedById: owner.id },
  });
  biz = await prisma.business.create({
    data: { id: "me2e_biz", userId: owner.id, name: "Match Co", country: "NG", baseCurrency: "NGN" },
  });
  customer = await prisma.customer.create({
    data: { userId: owner.id, businessId: biz.id, name: "Debt Customer", totalOwed: 7000 },
  });
  // Two debts, oldest first: 4,000 then 3,000 — the FIFO order under test.
  await prisma.debt.create({ data: { customerId: customer.id, amount: 4000, date: new Date(Date.now() - 2 * 86400000) } });
  await prisma.debt.create({ data: { customerId: customer.id, amount: 3000, date: new Date(Date.now() - 1 * 86400000) } });

  tOwner = signToken({ userId: owner.id, tokenVersion: 0 });
  tStaffNo = signToken({ userId: staffNo.id, tokenVersion: 0 });
  tStaffYes = signToken({ userId: staffYes.id, tokenVersion: 0 });

  // ══ 1. THE DOOR IS GATED ═══════════════════════════════════════════════
  section("1. permission");
  const probe = await credit(1000);

  await test("staff without canViewBalance: 403 on every matching door", async () => {
    assert.strictEqual((await GET(`/transactions?businessId=${biz.id}`, tStaffNo)).status, 403);
    assert.strictEqual((await POST(`/transactions/${probe.id}/match`, tStaffNo, { saleId: "x" })).status, 403);
    assert.strictEqual((await POST(`/transactions/${probe.id}/match-debt`, tStaffNo, { customerId: "x" })).status, 403);
    assert.strictEqual((await POST(`/transactions/${probe.id}/create-sale`, tStaffNo, {})).status, 403);
    assert.strictEqual((await DEL(`/transactions/${probe.id}/match`, tStaffNo)).status, 403);
  });
  await test("staff WITH canViewBalance can read the ledger", async () => {
    const r = await GET(`/transactions?businessId=${biz.id}`, tStaffYes);
    assert.strictEqual(r.status, 200);
    assert.ok(Array.isArray(r.body));
  });
  await test("owner reads the ledger and the endpoints EXIST (no more 404)", async () => {
    const r = await GET(`/transactions?businessId=${biz.id}`, tOwner);
    assert.strictEqual(r.status, 200, "the router spent months unmounted — this is the mount test");
  });

  // ══ 2. INCOME ONLY ═════════════════════════════════════════════════════
  section("2. income only");
  const outbound = await credit(500, { type: "expense", description: "Transfer to SOMEONE" });

  await test("matching an OUTBOUND transfer is refused on all three paths", async () => {
    for (const [p, b] of [["match", { saleId: "x" }], ["match-debt", { customerId: "x" }], ["create-sale", {}]]) {
      const r = await POST(`/transactions/${outbound.id}/${p}`, tOwner, b);
      assert.strictEqual(r.status, 400, `${p} accepted an expense row`);
      assert.strictEqual(r.body.code, "NOT_INCOMING");
    }
  });

  // ══ 3. MATCH TO EXISTING SALE ══════════════════════════════════════════
  section("3. match to an existing sale");
  const sale = await prisma.sales.create({
    data: { userId: owner.id, businessId: biz.id, amount: 2500, paymentMethod: "transfer", date: new Date() },
  });
  const c1 = await credit(2500);

  await test("the matched pair counts ONCE in income", async () => {
    const before = await income();
    const r = await POST(`/transactions/${c1.id}/match`, tOwner, { saleId: sale.id });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const after = await income();
    assert.strictEqual(before - after, 2500, "matching must remove exactly the credit from the sum");
    const [tx, s] = await Promise.all([
      prisma.transaction.findUnique({ where: { id: c1.id } }),
      prisma.sales.findUnique({ where: { id: sale.id } }),
    ]);
    assert.strictEqual(tx.matchedSaleId, sale.id);
    assert.strictEqual(s.matchedTransactionId, c1.id, "both sides must link — the old Promise.all could half-write");
  });
  await test("re-matching the same credit: 409", async () => {
    const r = await POST(`/transactions/${c1.id}/match`, tOwner, { saleId: sale.id });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.body.code, "ALREADY_MATCHED");
  });
  await test("a second credit cannot steal an already-matched sale", async () => {
    const c2 = await credit(2500);
    const r = await POST(`/transactions/${c2.id}/match`, tOwner, { saleId: sale.id });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.body.code, "SALE_ALREADY_MATCHED");
  });
  await test("plain unmatch relinks nothing and restores the count", async () => {
    const before = await income();
    const r = await DEL(`/transactions/${c1.id}/match`, tOwner);
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await income()) - before, 2500);
    const s = await prisma.sales.findUnique({ where: { id: sale.id } });
    assert.strictEqual(s.matchedTransactionId, null);
  });

  // ══ 4. CREATE SALE FROM CREDIT ═════════════════════════════════════════
  section("4. create a sale from the transfer");
  const c3 = await credit(8000);

  let createdSaleId;
  await test("one call records the sale at the transfer's amount, matched", async () => {
    const before = await income();
    const r = await POST(`/transactions/${c3.id}/create-sale`, tOwner, { description: "POS goods", channel: "walk-in" });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    createdSaleId = r.body.sale.id;
    assert.strictEqual(Number(r.body.sale.amount), 8000, "amount comes from the credit, never the client");
    assert.strictEqual(r.body.transaction.matchedSaleId, createdSaleId);
    const after = await income();
    assert.strictEqual(after, before, "sale in + credit out = income unchanged, counted exactly once");
  });
  await test("create-sale on an already-matched credit: 409", async () => {
    const r = await POST(`/transactions/${c3.id}/create-sale`, tOwner, {});
    assert.strictEqual(r.status, 409);
  });
  await test("unmatch with deleteSale removes the created sale (the undo)", async () => {
    const before = await income();
    const r = await DEL(`/transactions/${c3.id}/match?deleteSale=true`, tOwner);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.saleDeleted, true);
    assert.strictEqual(await prisma.sales.findUnique({ where: { id: createdSaleId } }), null,
      "without the delete, unlinking leaves an orphan sale that re-opens the double count");
    assert.strictEqual((await income()) - before, 0, "credit back in, sale gone: net zero change");
  });

  // ══ 5. APPLY TO DEBT ═══════════════════════════════════════════════════
  section("5. apply to a customer's debt");
  const c4 = await credit(5000);

  await test("5,000 walks the debts oldest-first: 4,000 paid, 1,000 partial", async () => {
    const r = await POST(`/transactions/${c4.id}/match-debt`, tOwner, { customerId: customer.id });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.amountApplied, 5000);
    assert.strictEqual(r.body.remainder, 0);
    const debts = await prisma.debt.findMany({ where: { customerId: customer.id }, orderBy: { date: "asc" } });
    assert.strictEqual(debts[0].paid, true);
    assert.strictEqual(debts[1].paidAmount, 1000);
    assert.strictEqual(debts[1].paid, false);
    const cust = await prisma.customer.findUnique({ where: { id: customer.id } });
    assert.strictEqual(cust.totalOwed, 2000);
    const stamped = await prisma.debtPayment.count({ where: { transactionId: c4.id } });
    assert.strictEqual(stamped, 2, "every payment must carry the credit's id or unmatch can't find it");
  });
  await test("debt-matched credit: applied slice leaves income, remainder STAYS", async () => {
    // Two rules in one flow. (a) matchedCustomerId excludes like matchedSaleId
    // does — before that fix a debt-matched credit still counted. (b) only the
    // APPLIED slice is excluded: a credit bigger than the debt leaves a
    // remainder of real money, which used to vanish from income entirely
    // (matchedAmount is what puts it back).
    const before = await income();
    const cX = await credit(123456);
    assert.strictEqual(await income(), before + 123456);
    const r = await POST(`/transactions/${cX.id}/match-debt`, tOwner, { customerId: customer.id });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const applied = r.body.amountApplied;
    assert.ok(applied > 0 && applied < 123456, "scenario needs a partial application");
    const tx = await prisma.transaction.findUnique({ where: { id: cX.id } });
    assert.strictEqual(Number(tx.matchedAmount), applied, "matchedAmount must record the applied slice");
    assert.strictEqual(await income(), before + 123456 - applied,
      "only the applied slice may leave income — the remainder is real money");
    const u = await DEL(`/transactions/${cX.id}/match`, tOwner);
    assert.strictEqual(u.status, 200);
    const txAfter = await prisma.transaction.findUnique({ where: { id: cX.id } });
    assert.strictEqual(txAfter.matchedAmount, null, "unmatch must clear matchedAmount");
    assert.strictEqual(await income(), before + 123456, "unmatch restores the full credit to income");
  });
  await test("matching the same credit to debt AGAIN: 409, and nothing moves", async () => {
    const owedBefore = (await prisma.customer.findUnique({ where: { id: customer.id } })).totalOwed;
    const payBefore = await prisma.debtPayment.count({ where: { debt: { customerId: customer.id } } });
    const r = await POST(`/transactions/${c4.id}/match-debt`, tOwner, { customerId: customer.id });
    assert.strictEqual(r.status, 409, "the old handler double-applied here");
    assert.strictEqual((await prisma.customer.findUnique({ where: { id: customer.id } })).totalOwed, owedBefore);
    assert.strictEqual(await prisma.debtPayment.count({ where: { debt: { customerId: customer.id } } }), payBefore);
  });
  await test("TWO SIMULTANEOUS match-debt calls: exactly one applies", async () => {
    // The sequential double-apply is caught by the outer check; this is the
    // race the INNER re-check under the lock exists for. Two requests in
    // flight at once each pass the outer read; the lock serializes them and
    // the second must see the first's write and refuse.
    const cR = await credit(500);
    const payBefore = await prisma.debtPayment.count({ where: { debt: { customerId: customer.id } } });
    const owedBefore = (await prisma.customer.findUnique({ where: { id: customer.id } })).totalOwed;
    const [a, b] = await Promise.all([
      POST(`/transactions/${cR.id}/match-debt`, tOwner, { customerId: customer.id }),
      POST(`/transactions/${cR.id}/match-debt`, tOwner, { customerId: customer.id }),
    ]);
    const codes = [a.status, b.status].sort();
    assert.deepStrictEqual(codes, [200, 409], `expected one win one refusal, got ${codes}`);
    const payAfter = await prisma.debtPayment.count({ where: { debt: { customerId: customer.id } } });
    const owedAfter = (await prisma.customer.findUnique({ where: { id: customer.id } })).totalOwed;
    assert.strictEqual(payAfter, payBefore + 1, "exactly ONE application may land");
    assert.strictEqual(owedBefore - owedAfter, 500, "the debt must move by one credit's worth, not two");
    await DEL(`/transactions/${cR.id}/match`, tOwner); // restore
  });
  await test("overpayment: amountApplied caps at the debt, remainder reported", async () => {
    const c5 = await credit(10000);
    const r = await POST(`/transactions/${c5.id}/match-debt`, tOwner, { customerId: customer.id });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.amountApplied, 2000);
    assert.strictEqual(r.body.remainder, 8000);
    assert.strictEqual(r.body.customer.totalOwed, 0);
    await DEL(`/transactions/${c5.id}/match`, tOwner); // restore for the next tests
  });
  await test("matching against a customer with NOTHING owed: 409", async () => {
    // c4's match cleared 5,000 of 7,000; the overpayment test cleared and then
    // restored the rest — customer still owes 2,000, so first drain it.
    const cDrain = await credit(2000);
    await POST(`/transactions/${cDrain.id}/match-debt`, tOwner, { customerId: customer.id });
    const cust = await prisma.customer.findUnique({ where: { id: customer.id } });
    assert.strictEqual(cust.totalOwed, 0);
    const cNew = await credit(100);
    const r = await POST(`/transactions/${cNew.id}/match-debt`, tOwner, { customerId: customer.id });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.body.code, "NO_OUTSTANDING_DEBT");
    await DEL(`/transactions/${cDrain.id}/match`, tOwner); // restore
  });

  // ══ 6. UNMATCH REVERSES EXACTLY ════════════════════════════════════════
  section("6. unmatch reverses exactly");

  await test("unmatch restores debt state byte-for-byte, sparing manual payments", async () => {
    // Snapshot, add a MANUAL payment (no transactionId), match, unmatch.
    const debts0 = await prisma.debt.findMany({ where: { customerId: customer.id }, orderBy: { date: "asc" } });
    const manualTarget = debts0.find((d) => !d.paid);
    assert.ok(manualTarget, "need an unpaid debt for the manual payment");
    const rp = await POST(`/customers/${customer.id}/debts/${manualTarget.id}/payment`, tOwner, { amount: 500, note: "cash on visit" });
    assert.strictEqual(rp.status, 200, JSON.stringify(rp.body));

    const snapDebts = await prisma.debt.findMany({ where: { customerId: customer.id }, orderBy: { date: "asc" } });
    const snapOwed = (await prisma.customer.findUnique({ where: { id: customer.id } })).totalOwed;
    const snapManual = await prisma.debtPayment.count({ where: { transactionId: null, debt: { customerId: customer.id } } });

    const c6 = await credit(1500);
    const m = await POST(`/transactions/${c6.id}/match-debt`, tOwner, { customerId: customer.id });
    assert.strictEqual(m.status, 200);
    const u = await DEL(`/transactions/${c6.id}/match`, tOwner);
    assert.strictEqual(u.status, 200);

    const debtsAfter = await prisma.debt.findMany({ where: { customerId: customer.id }, orderBy: { date: "asc" } });
    for (let i = 0; i < snapDebts.length; i++) {
      assert.strictEqual(debtsAfter[i].paidAmount, snapDebts[i].paidAmount, `debt ${i} paidAmount not restored`);
      assert.strictEqual(debtsAfter[i].paid, snapDebts[i].paid, `debt ${i} paid flag not restored`);
    }
    assert.strictEqual((await prisma.customer.findUnique({ where: { id: customer.id } })).totalOwed, snapOwed);
    assert.strictEqual(await prisma.debtPayment.count({ where: { transactionId: c6.id } }), 0, "this credit's payments must be gone");
    assert.strictEqual(
      await prisma.debtPayment.count({ where: { transactionId: null, debt: { customerId: customer.id } } }),
      snapManual,
      "the manual cash payment must SURVIVE the reversal",
    );
  });
  await test("unmatch on an unmatched credit is an idempotent no-op", async () => {
    const c7 = await credit(50);
    const r = await DEL(`/transactions/${c7.id}/match`, tOwner);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.matched, false);
  });

  // ══ 6b. COMPOSED AMOUNTS — the transfer is a CEILING ═══════════════════
  section("6b. capped amounts");
  const expenses = async () => (await sumExpenses(biz.id, RANGE)).total;
  const debit = (amount, over = {}) =>
    credit(amount, { type: "expense", description: `Transfer to TEST PAYEE · Ref: y${seq}`, ...over });

  await test("create-sale BELOW the transfer is allowed and reports the remainder", async () => {
    const c9 = await credit(5000);
    const before = await income();
    const r = await POST(`/transactions/${c9.id}/create-sale`, tOwner, { amount: 4500, description: "goods" });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    assert.strictEqual(Number(r.body.sale.amount), 4500);
    assert.strictEqual(r.body.remainder, 500);
    // Sale (4500) in, credit excluded, but the 500 remainder is REAL money
    // that arrived — matchedAmount keeps it in income, so the total is
    // unchanged: 4500 recorded + 500 unrecorded remainder = the 5000 credit.
    assert.strictEqual(before - (await income()), 0,
      "the remainder must stay in income, not silently vanish");
    const txC9 = await prisma.transaction.findUnique({ where: { id: c9.id } });
    assert.strictEqual(Number(txC9.matchedAmount), 4500);
    await DEL(`/transactions/${c9.id}/match?deleteSale=true`, tOwner);
  });
  await test("create-sale ABOVE the transfer: 400, nothing written", async () => {
    const c10 = await credit(3000);
    const salesBefore = await prisma.sales.count({ where: { businessId: biz.id } });
    const r = await POST(`/transactions/${c10.id}/create-sale`, tOwner, { amount: 3000.01 });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.code, "AMOUNT_EXCEEDS_TRANSFER");
    assert.strictEqual(await prisma.sales.count({ where: { businessId: biz.id } }), salesBefore);
    const tx = await prisma.transaction.findUnique({ where: { id: c10.id } });
    assert.strictEqual(tx.matchedSaleId, null, "a refused create must not leave a half-match");
  });
  await test("float noise from price × quantity does not trip the cap", async () => {
    // 3 × 1666.67 = 5000.009999... in IEEE754; the epsilon must absorb it.
    const c11 = await credit(5000.01);
    const r = await POST(`/transactions/${c11.id}/create-sale`, tOwner, { amount: 3 * 1666.67 });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    await DEL(`/transactions/${c11.id}/match?deleteSale=true`, tOwner);
  });

  // ══ 6c. THE EXPENSE MIRROR ═════════════════════════════════════════════
  section("6c. record an outbound transfer as an expense");

  await test("create-expense on an INCOME row: 400 NOT_OUTGOING", async () => {
    const cI = await credit(700);
    const r = await POST(`/transactions/${cI.id}/create-expense`, tOwner, {});
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.code, "NOT_OUTGOING");
  });
  await test("staff without canViewBalance: 403 on create-expense", async () => {
    const d0 = await debit(700);
    assert.strictEqual((await POST(`/transactions/${d0.id}/create-expense`, tStaffNo, {})).status, 403);
  });

  let dMain, expMain;
  await test("recording the debit counts the expense ONCE (bank leg excluded)", async () => {
    dMain = await debit(6000);
    const before = await expenses(); // includes the 6000 bank debit
    const r = await POST(`/transactions/${dMain.id}/create-expense`, tOwner, {
      amount: 6000, description: "shop rent", category: "Rent",
    });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    expMain = r.body.expense;
    assert.strictEqual(expMain.category, "rent", "category is lowercased");
    assert.strictEqual(expMain.paymentMethod, "transfer", "'bank' would read as a bank movement");
    assert.strictEqual(r.body.transaction.matchedExpenseId, expMain.id);
    // Expense row (+6000) in, bank debit (−6000 excluded): total unchanged.
    assert.strictEqual(await expenses(), before,
      "recording a transfer as an expense must not change the expense total");
  });
  await test("recording it AGAIN: 409, sequentially and in a race", async () => {
    assert.strictEqual((await POST(`/transactions/${dMain.id}/create-expense`, tOwner, {})).status, 409);
    const dR = await debit(800);
    const [a, b] = await Promise.all([
      POST(`/transactions/${dR.id}/create-expense`, tOwner, {}),
      POST(`/transactions/${dR.id}/create-expense`, tOwner, {}),
    ]);
    assert.deepStrictEqual([a.status, b.status].sort(), [201, 409], "exactly one may land");
    assert.strictEqual(
      await prisma.expense.count({ where: { matchedTransactionId: dR.id } }), 1,
      "the race must produce exactly ONE expense row",
    );
    await DEL(`/transactions/${dR.id}/match?deleteExpense=true`, tOwner);
  });
  await test("create-expense below the cap allowed; above refused", async () => {
    const d2 = await debit(2000);
    const over = await POST(`/transactions/${d2.id}/create-expense`, tOwner, { amount: 2500 });
    assert.strictEqual(over.status, 400);
    assert.strictEqual(over.body.code, "AMOUNT_EXCEEDS_TRANSFER");
    const under = await POST(`/transactions/${d2.id}/create-expense`, tOwner, { amount: 1500 });
    assert.strictEqual(under.status, 201);
    assert.strictEqual(under.body.remainder, 500);
    await DEL(`/transactions/${d2.id}/match?deleteExpense=true`, tOwner);
  });
  await test("unmatch with deleteExpense removes the record (the undo)", async () => {
    const before = await expenses();
    const r = await DEL(`/transactions/${dMain.id}/match?deleteExpense=true`, tOwner);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.expenseDeleted, true);
    assert.strictEqual(await prisma.expense.findUnique({ where: { id: expMain.id } }), null);
    assert.strictEqual(await expenses(), before,
      "expense gone, bank debit back in: total must be unchanged");
  });
  await test("plain unmatch keeps the expense as its own record", async () => {
    const d3 = await debit(900);
    const r = await POST(`/transactions/${d3.id}/create-expense`, tOwner, { category: "supplies" });
    assert.strictEqual(r.status, 201);
    const u = await DEL(`/transactions/${d3.id}/match`, tOwner);
    assert.strictEqual(u.status, 200);
    assert.strictEqual(u.body.expenseDeleted, false);
    const exp = await prisma.expense.findUnique({ where: { id: r.body.expense.id } });
    assert.ok(exp, "the expense must survive a plain unlink");
    assert.strictEqual(exp.matchedTransactionId, null);
    const tx = await prisma.transaction.findUnique({ where: { id: d3.id } });
    assert.strictEqual(tx.matchedExpenseId, null);
    await prisma.expense.delete({ where: { id: exp.id } }); // tidy for later sums
  });

  // ══ 7. TENANCY ═════════════════════════════════════════════════════════
  section("7. tenancy");
  await test("a rival owner cannot match, read, or unmatch this business's credits", async () => {
    const rival = await mk({ id: "me2e_rival", email: "me2e_rival@t.local", firstName: "Riv", lastName: "Al", accountType: "OWNER" });
    const tRival = signToken({ userId: rival.id, tokenVersion: 0 });
    const c8 = await credit(75);
    assert.strictEqual((await POST(`/transactions/${c8.id}/match-debt`, tRival, { customerId: customer.id })).status, 403);
    assert.strictEqual((await POST(`/transactions/${c8.id}/create-sale`, tRival, {})).status, 403);
    assert.strictEqual((await DEL(`/transactions/${c8.id}/match`, tRival)).status, 403);
    await prisma.user.delete({ where: { id: rival.id } });
  });

  await wipe();
  await prisma.$disconnect();
  server.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failures.length) console.log("FAILURES:\n" + failures.map((f) => "  - " + f).join("\n"));
  process.exitCode = failed ? 1 : 0;
})().catch(async (e) => {
  console.error("\nHARNESS ERROR:", e);
  await wipe().catch(() => {});
  await prisma.$disconnect().catch(() => {});
  try { server?.close(); } catch {}
  process.exitCode = 1;
});
