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
//   * a transfer explained with an account being matched as well (counted twice)
//   * staff marking a credit as the owner's own money, or moving, clearing or
//     unlinking what the owner filed there (the owner's stake is the owner's)
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
const { ensureChart } = require("../src/utils/ledgerData");

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
  await test("debt-matched credit: counted once, the debt payment carries the applied slice", async () => {
    // Books rule (2026-10-09): a debt repayment is a sale on the day it is
    // paid, carried by the DebtPayment. So the credit itself counts only the
    // remainder its match did not use (matchedAmount puts that back), and the
    // total does not move when the credit is applied to the debt.
    const { bankCountedAmount } = require("../src/utils/books");
    const before = await income();
    const cX = await credit(123456);
    assert.strictEqual(await income(), before + 123456);
    const r = await POST(`/transactions/${cX.id}/match-debt`, tOwner, { customerId: customer.id });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const applied = r.body.amountApplied;
    assert.ok(applied > 0 && applied < 123456, "scenario needs a partial application");
    const tx = await prisma.transaction.findUnique({ where: { id: cX.id } });
    assert.strictEqual(Number(tx.matchedAmount), applied, "matchedAmount must record the applied slice");
    assert.strictEqual(bankCountedAmount(tx), 123456 - applied, "the credit keeps only its remainder");
    assert.strictEqual(await income(), before + 123456,
      "the applied slice moved to the debt payment; nothing counted twice or lost");
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

  // ══ 6d. EXPLAINED WITH AN ACCOUNT ══════════════════════════════════════
  // Chart of accounts (2026-10-12): a transfer the merchant explained with an
  // account is explained. Money in on an income account (and money out on an
  // expense account) keeps no purpose, so the account itself must refuse a
  // match, as a purpose does: matching it too would explain the naira twice.
  section("6d. explained with an account");
  await ensureChart(biz.id);
  const accountBySeed = (seed) => prisma.ledgerAccount.findFirst({ where: { businessId: biz.id, seed } });
  const incomeAcc = await accountBySeed("general_income");
  const rentAcc = await accountBySeed("rent");
  const categorize = (id, accountId) => POST(`/transactions/${id}/categorize`, tOwner, { accountId });
  const explainedCredit = async (amount) => {
    const c = await credit(amount);
    const r = await categorize(c.id, incomeAcc.id);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.transaction.accountId, incomeAcc.id);
    assert.strictEqual(r.body.transaction.purpose, null, "an income account keeps no purpose");
    return c;
  };
  const newSale = (amount) =>
    prisma.sales.create({ data: { userId: owner.id, businessId: biz.id, amount, paymentMethod: "transfer", date: new Date() } });
  // The repayment recorded by hand in section 6, which a credit could carry.
  const handRepayment = () =>
    prisma.debtPayment.findFirst({ where: { transactionId: null, debt: { customerId: customer.id } } });

  await test("a credit on an income account can't be matched, made a sale, or applied to a debt", async () => {
    const c = await explainedCredit(1200);
    const s = await newSale(1200);
    const salesBefore = await prisma.sales.count({ where: { businessId: biz.id } });
    const owedBefore = (await prisma.customer.findUnique({ where: { id: customer.id } })).totalOwed;
    assert.ok(owedBefore > 0, "the customer must owe something, or match-debt would refuse for that");
    for (const [p, b] of [["match", { saleId: s.id }], ["create-sale", {}], ["match-debt", { customerId: customer.id }]]) {
      const r = await POST(`/transactions/${c.id}/${p}`, tOwner, b);
      assert.strictEqual(r.status, 409, `${p}: ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.code, "MARKED_NOT_INCOME", p);
      // An older app shows this text as it is: it names what explains the row.
      assert.ok(/explained with an account/.test(r.body.error), `${p}: ${r.body.error}`);
    }
    const tx = await prisma.transaction.findUnique({ where: { id: c.id } });
    assert.strictEqual(tx.accountId, incomeAcc.id, "the account stays");
    assert.ok(!tx.matchedSaleId && !tx.matchedCustomerId && tx.matchedAmount === null, "nothing linked");
    assert.strictEqual((await prisma.sales.findUnique({ where: { id: s.id } })).matchedTransactionId, null);
    assert.strictEqual(await prisma.sales.count({ where: { businessId: biz.id } }), salesBefore, "no sale made");
    assert.strictEqual((await prisma.customer.findUnique({ where: { id: customer.id } })).totalOwed, owedBefore, "the debt did not move");
    await prisma.sales.delete({ where: { id: s.id } });
  });
  await test("…nor linked to a repayment recorded by hand", async () => {
    const c = await explainedCredit(500);
    const dp = await handRepayment();
    assert.ok(dp && Number(dp.amount) <= 500, "need a hand-recorded repayment the credit could carry");
    const r = await POST(`/transactions/${c.id}/link-debt-payment`, tOwner, { debtPaymentId: dp.id });
    assert.strictEqual(r.status, 409, JSON.stringify(r.body));
    assert.strictEqual(r.body.code, "MARKED_NOT_INCOME");
    assert.strictEqual((await prisma.debtPayment.findUnique({ where: { id: dp.id } })).transactionId, null);
    assert.strictEqual((await prisma.transaction.findUnique({ where: { id: c.id } })).matchedCustomerId, null);
  });
  await test("taking the account off makes the credit matchable again", async () => {
    const c = await explainedCredit(1300);
    const s = await newSale(1300);
    assert.strictEqual((await POST(`/transactions/${c.id}/match`, tOwner, { saleId: s.id })).status, 409);
    const u = await categorize(c.id, null);
    assert.strictEqual(u.status, 200, JSON.stringify(u.body));
    assert.strictEqual(u.body.transaction.accountId, null);
    const r = await POST(`/transactions/${c.id}/match`, tOwner, { saleId: s.id });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    await DEL(`/transactions/${c.id}/match`, tOwner);
    await prisma.sales.delete({ where: { id: s.id } });
  });
  await test("a debit on an expense account can't be recorded as an expense as well", async () => {
    const d = await debit(2200);
    const r0 = await categorize(d.id, rentAcc.id);
    assert.strictEqual(r0.status, 200, JSON.stringify(r0.body));
    assert.strictEqual(r0.body.transaction.purpose, null, "an expense account keeps no purpose");
    const before = await prisma.expense.count({ where: { businessId: biz.id } });
    const r = await POST(`/transactions/${d.id}/create-expense`, tOwner, { category: "rent" });
    assert.strictEqual(r.status, 409, JSON.stringify(r.body));
    assert.strictEqual(r.body.code, "MARKED_NOT_EXPENSE");
    assert.ok(/explained with an account/.test(r.body.error), r.body.error);
    assert.strictEqual(await prisma.expense.count({ where: { businessId: biz.id } }), before, "no expense made");
    const tx = await prisma.transaction.findUnique({ where: { id: d.id } });
    assert.strictEqual(tx.matchedExpenseId, null);
    assert.strictEqual(tx.accountId, rentAcc.id, "the account stays");
  });
  // Two phones at once, one explaining a transfer with an account and the
  // other linking it. Both pass the checks made before the business lock, so
  // only the check under the lock can refuse whichever comes second. To make
  // that order certain, the test holds the lock (taken as utils/db.js takes
  // it) while the two requests queue for it, then lets go: Postgres hands the
  // lock on in queue order.
  const lockWaiters = async () => {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT count(*)::int AS n FROM pg_locks
        WHERE locktype = 'advisory' AND NOT granted AND objsubid = 1
          AND classid::bigint = ((hashtextextended($1, 0) >> 32) & 4294967295)
          AND objid::bigint = (hashtextextended($1, 0) & 4294967295)`,
      biz.id,
    );
    return rows[0].n;
  };
  const untilWaiting = async (n) => {
    for (let i = 0; i < 600; i++) {
      if ((await lockWaiters()) >= n) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`expected ${n} requests waiting for the business lock`);
  };
  const inQueueOrder = async (first, second) => {
    let a;
    let b;
    await prisma.withBusinessLock(biz.id, async () => {
      a = first();
      await untilWaiting(1);
      b = second();
      await untilWaiting(2);
    });
    return Promise.all([a, b]);
  };
  await test("an account and a link at the same moment: the second in the lock's queue is refused", async () => {
    const dp = await handRepayment();
    assert.ok(dp, "need the hand-recorded repayment");
    // [route, the bank row, the account that explains it, the route's body]
    const routes = [
      ["match", credit, incomeAcc, async () => ({ saleId: (await newSale(500)).id })],
      ["create-sale", credit, incomeAcc, async () => ({ customerId: customer.id })],
      ["match-debt", credit, incomeAcc, async () => ({ customerId: customer.id })],
      ["link-debt-payment", credit, incomeAcc, async () => ({ debtPaymentId: dp.id })],
      ["create-expense", debit, rentAcc, async () => ({ customerId: customer.id })],
    ];
    const undo = { "create-sale": "?deleteSale=true", "create-expense": "?deleteExpense=true" };
    const isLinked = (tx) => !!(tx.matchedSaleId || tx.matchedCustomerId || tx.matchedExpenseId);
    for (const [p, row, account, bodyFor] of routes) {
      // The account first: the link passed its outer check while nothing
      // explained the row, so the check under the lock must refuse it.
      const r1 = await row(500);
      const body1 = await bodyFor();
      const [explain1, link1] = await inQueueOrder(
        () => categorize(r1.id, account.id),
        () => POST(`/transactions/${r1.id}/${p}`, tOwner, body1),
      );
      const tx1 = await prisma.transaction.findUnique({ where: { id: r1.id } });
      // Undo first, so a failed check below leaves the debt as it was.
      if (isLinked(tx1)) await DEL(`/transactions/${r1.id}/match${undo[p] || ""}`, tOwner);
      assert.strictEqual(explain1.status, 200, `${p}, account first: ${JSON.stringify(explain1.body)}`);
      assert.ok(!isLinked(tx1), `${p}: the transfer was explained AND linked`);
      assert.strictEqual(link1.status, 409, `${p}, account first: the link answered ${link1.status}`);
      assert.strictEqual(link1.body.code, "ALREADY_MATCHED", p);

      // The link first: the account is refused under the lock in turn.
      const r2 = await row(500);
      const body2 = await bodyFor();
      const [link2, explain2] = await inQueueOrder(
        () => POST(`/transactions/${r2.id}/${p}`, tOwner, body2),
        () => categorize(r2.id, account.id),
      );
      const tx2 = await prisma.transaction.findUnique({ where: { id: r2.id } });
      if (isLinked(tx2)) await DEL(`/transactions/${r2.id}/match${undo[p] || ""}`, tOwner);
      assert.ok(link2.status >= 200 && link2.status < 300, `${p}, link first: ${JSON.stringify(link2.body)}`);
      assert.strictEqual(tx2.accountId, null, `${p}: the transfer was linked AND explained`);
      assert.strictEqual(explain2.status, 409, `${p}, link first: the account answered ${explain2.status}`);
      assert.strictEqual(explain2.body.code, "ALREADY_MATCHED", p);
    }
  });

  // ══ 6e. THE OWNER'S STAKE ══════════════════════════════════════════════
  // The owner's own money in (Owner's Equity, Share Capital) and out
  // (Drawings) is the owner's to file, whether by an account or by the
  // purpose "owner_money", and what the owner filed there is the owner's to
  // change: staff get 403 OWNER_ONLY and nothing moves. The owner still can,
  // and staff still explain everything else.
  section("6e. the owner's stake is the owner's");
  const [drawingsAcc, equityAcc, loansAcc, salesAcc, shareAcc] = await Promise.all(
    ["drawings", "owners_equity", "loans", "sales", "share_capital"].map(accountBySeed),
  );
  const rowOf = (id) => prisma.transaction.findUnique({ where: { id } });
  const refused = (r, what) => {
    assert.strictEqual(r.status, 403, `${what}: ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, "OWNER_ONLY", what);
  };
  const classify = (id, token, purpose) => POST(`/transactions/${id}/classify`, token, { purpose });
  const categorizeAs = (id, token, accountId) => POST(`/transactions/${id}/categorize`, token, { accountId });

  await test("staff can't mark a credit as the owner's money; the owner can", async () => {
    const c = await credit(50000);
    const before = await income();
    refused(await classify(c.id, tStaffYes, "owner_money"), "staff");
    const row = await rowOf(c.id);
    assert.deepStrictEqual([row.purpose, row.accountId], [null, null], "nothing written");
    assert.strictEqual(await income(), before, "still a sale");
    const noBank = await classify(c.id, tStaffNo, "owner_money");
    assert.strictEqual(noBank.body.code, "PERMISSION_DENIED", "staff without bank access are refused first");
    const ok = await classify(c.id, tOwner, "owner_money");
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    assert.strictEqual(ok.body.transaction.purpose, "owner_money");
  });
  await test("the owner's drawings on a debit: staff can't move or clear them; the owner can", async () => {
    const d = await debit(80000);
    assert.strictEqual((await categorizeAs(d.id, tOwner, drawingsAcc.id)).status, 200);
    const before = await expenses();
    refused(await categorizeAs(d.id, tStaffYes, rentAcc.id), "staff: Rent");
    refused(await categorizeAs(d.id, tStaffYes, null), "staff: clear");
    const row = await rowOf(d.id);
    assert.deepStrictEqual([row.accountId, row.purpose], [drawingsAcc.id, "account"], "still the owner's drawings");
    assert.strictEqual(await expenses(), before, "still not spending");
    const ok = await categorizeAs(d.id, tOwner, rentAcc.id);
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    assert.strictEqual((await categorizeAs(d.id, tOwner, null)).status, 200, "the owner clears it");
  });
  await test("the owner's money on Owner's Equity: staff can't classify, recategorize or clear it; the owner can", async () => {
    const c = await credit(300000);
    const set = await categorizeAs(c.id, tOwner, equityAcc.id);
    assert.strictEqual(set.body.transaction.purpose, "owner_money", JSON.stringify(set.body));
    const before = await income();
    refused(await classify(c.id, tStaffYes, null), "staff: classify none");
    refused(await classify(c.id, tStaffYes, "loan"), "staff: classify a loan");
    refused(await categorizeAs(c.id, tStaffYes, loansAcc.id), "staff: Loans");
    refused(await categorizeAs(c.id, tStaffYes, salesAcc.id), "staff: Sales");
    refused(await categorizeAs(c.id, tStaffYes, null), "staff: clear");
    const row = await rowOf(c.id);
    assert.deepStrictEqual([row.accountId, row.purpose], [equityAcc.id, "owner_money"], "as the owner left it");
    assert.strictEqual(await income(), before, "still not a sale");
    const ok = await classify(c.id, tOwner, null);
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    assert.deepStrictEqual([ok.body.transaction.purpose, ok.body.transaction.accountId], [null, null], "the owner takes it back");
  });
  await test("the owner's money by purpose alone: staff can't clear it or explain it otherwise; the owner can", async () => {
    const c = await credit(70000);
    assert.strictEqual((await classify(c.id, tOwner, "owner_money")).status, 200);
    const before = await income();
    refused(await classify(c.id, tStaffYes, null), "staff: classify none");
    refused(await categorizeAs(c.id, tStaffYes, null), "staff: clear");
    refused(await categorizeAs(c.id, tStaffYes, incomeAcc.id), "staff: income");
    assert.strictEqual((await rowOf(c.id)).purpose, "owner_money");
    assert.strictEqual(await income(), before, "still not a sale");
    assert.strictEqual((await categorizeAs(c.id, tOwner, incomeAcc.id)).status, 200, "the owner calls it income");
  });
  await test("Share Capital and an auto-debit on Drawings are the owner's too; staff still explain and clear the rest", async () => {
    const c = await credit(1000);
    assert.strictEqual((await categorizeAs(c.id, tOwner, shareAcc.id)).body.transaction.purpose, "account");
    refused(await categorizeAs(c.id, tStaffYes, incomeAcc.id), "staff: Share Capital to income");
    const auto = await debit(2000, { reference: `kashbook_rec_me2e_${Date.now()}_1`, accountId: drawingsAcc.id, purpose: "account" });
    refused(await categorizeAs(auto.id, tStaffYes, rentAcc.id), "staff: the auto-debit's drawings to Rent");
    const mine = await credit(20000);
    assert.strictEqual((await classify(mine.id, tStaffYes, "loan")).status, 200, "staff: a loan");
    assert.strictEqual((await classify(mine.id, tStaffYes, null)).status, 200, "staff: clear the loan");
    assert.strictEqual((await categorizeAs(mine.id, tStaffYes, incomeAcc.id)).status, 200, "staff: income");
    assert.strictEqual((await categorizeAs(mine.id, tStaffYes, null)).status, 200, "staff: clear the income");
    const out = await debit(3000);
    assert.strictEqual((await categorizeAs(out.id, tStaffYes, rentAcc.id)).status, 200, "staff: Rent");
    assert.strictEqual((await categorizeAs(out.id, tStaffYes, loansAcc.id)).status, 200, "staff: Loans");
    assert.strictEqual((await categorizeAs(out.id, tStaffYes, null)).status, 200, "staff: clear");
    refused(await categorizeAs(out.id, tStaffYes, drawingsAcc.id), "staff never file drawings themselves");
  });
  await test("the owner's drawings recorded from a transfer: staff can't unlink or delete them; the owner can", async () => {
    const d = await debit(250000);
    const made = await POST(`/transactions/${d.id}/create-expense`, tOwner, { accountId: drawingsAcc.id });
    assert.strictEqual(made.status, 201, JSON.stringify(made.body));
    const before = await expenses();
    refused(await DEL(`/transactions/${d.id}/match`, tStaffYes), "staff: unlink");
    refused(await DEL(`/transactions/${d.id}/match?deleteExpense=true`, tStaffYes), "staff: delete");
    assert.strictEqual((await rowOf(d.id)).matchedExpenseId, made.body.expense.id, "still recorded");
    assert.ok(await prisma.expense.findUnique({ where: { id: made.body.expense.id } }), "the expense is kept");
    assert.strictEqual(await expenses(), before, "still not spending");
    // A line on Drawings is enough.
    const d2 = await debit(9000);
    const split = await prisma.expense.create({
      data: {
        userId: owner.id, businessId: biz.id, paymentMethod: "transfer", date: new Date(), amount: 9000, category: "rent", matchedTransactionId: d2.id,
        items: { create: [
          { accountId: rentAcc.id, category: "rent", amount: 4000, position: 0 },
          { accountId: drawingsAcc.id, category: "other", amount: 5000, position: 1 },
        ] },
      },
    });
    await prisma.transaction.update({ where: { id: d2.id }, data: { matchedExpenseId: split.id, matchedAmount: 9000 } });
    refused(await DEL(`/transactions/${d2.id}/match`, tStaffYes), "staff: unlink an expense with a drawings line");
    // Staff still undo an expense of their own on spending.
    const d3 = await debit(1500);
    assert.strictEqual((await POST(`/transactions/${d3.id}/create-expense`, tStaffYes, { accountId: rentAcc.id })).status, 201);
    const undo = await DEL(`/transactions/${d3.id}/match?deleteExpense=true`, tStaffYes);
    assert.strictEqual(undo.status, 200, JSON.stringify(undo.body));
    assert.strictEqual(undo.body.expenseDeleted, true);
    // The owner can.
    assert.strictEqual((await DEL(`/transactions/${d2.id}/match`, tOwner)).status, 200, "the owner unlinks");
    const u = await DEL(`/transactions/${d.id}/match?deleteExpense=true`, tOwner);
    assert.strictEqual(u.status, 200, JSON.stringify(u.body));
    assert.strictEqual(u.body.expenseDeleted, true);
    await prisma.expense.delete({ where: { id: split.id } });
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
