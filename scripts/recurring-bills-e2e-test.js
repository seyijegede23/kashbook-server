// Recurring rules on credit (chart of accounts release 2, 2026-10-13): a recurring
// rule saved on credit makes an unpaid bill, never an expense on credit; one
// that cannot (no business, an account that is not spending) is paused and
// its owner told; one that names where it is paid from, and a cash rule, still
// record their expense. The bills it makes are real bills: listed by GET
// /bills, payable through POST /bills/:id/payments, and the books and the
// ledger agree on them in both views, Accounts Payable holding exactly what is
// still owed.
//   TEST_DATABASE_URL=<local db> node scripts/recurring-bills-e2e-test.js
const url = process.env.TEST_DATABASE_URL;
if (!url || !["localhost", "127.0.0.1"].includes(new URL(url).hostname)) {
  console.error("Refusing: a LOCAL TEST_DATABASE_URL is required.");
  process.exit(1);
}
process.env.DATABASE_URL = url;
process.env.JWT_SECRET = "e2e-only-secret-0123456789abcdef0123456789abcdef";
process.env.NODE_ENV = "test";

const assert = require("assert");
const http = require("http");
const express = require("express");
const prisma = require("../src/utils/db");
const chart = require("../src/utils/chart");
const { signToken } = require("../src/utils/jwt");
const { ensureChart, loadLedger, invalidateOwner } = require("../src/utils/ledgerData");
const { booksFor } = require("../src/utils/booksData");
const ledger = require("../src/utils/ledger");
const { processRecurringExpenses } = require("../src/utils/recurringExpenseRunner");

const app = express();
app.use(express.json());
app.use(require("../src/middleware/idGuard").idGuard);
app.use("/bills", require("../src/routes/bills"));
let BASE;
const call = (method, path, token, body) =>
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
        try { j = JSON.parse(d); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, body: j });
      });
    });
    r.on("error", (e) => resolve({ status: 0, body: { error: e.message } }));
    if (data) r.write(data);
    r.end();
  });

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${name}\n        ${String(e.message).split("\n")[0]}`);
  }
}
const eq = (a, b, what = "") => assert.strictEqual(a, b, `${what} ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
const kob = (n) => Math.round(Number(n) * 100);
const tag = Date.now().toString(36);

(async () => {
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  BASE = `http://127.0.0.1:${server.address().port}`;
  try {
    const owner = await prisma.user.create({
      data: { password: "x", lastName: "T", businessName: "B", country: "NG", currency: "NGN", email: `rr-${tag}@t.local`, firstName: "Ada", accountType: "OWNER" },
    });
    const T = signToken({ userId: owner.id, tokenVersion: 0 });
    const biz = await prisma.business.create({ data: { userId: owner.id, name: `Runner ${tag}`, country: "NG", baseCurrency: "NGN" } });
    await ensureChart(biz.id);
    const accounts = await prisma.ledgerAccount.findMany({ where: { businessId: biz.id } });
    const C = chart.indexChart(accounts);
    const RENT = C.byCategorySlug.get("rent");
    const UTIL = C.byCategorySlug.get("utility");
    const LOANS = chart.sysAccount(C, chart.SYS.LOANS);
    const CASH = chart.sysAccount(C, chart.SYS.CASH);
    const AP = chart.sysAccount(C, chart.SYS.AP);
    let FIXED = accounts.find((a) => a.type === "fixed_asset");
    if (!FIXED) {
      FIXED = await prisma.ledgerAccount.create({
        data: { businessId: biz.id, type: "fixed_asset", name: `Equipment ${tag}`, nameKey: chart.nameKey(`Equipment ${tag}`) },
      });
    }
    // A rule with an inactive spending account keeps it, as its expense would.
    const RESTED = await prisma.ledgerAccount.create({
      data: { businessId: biz.id, type: "expense", name: `Security ${tag}`, nameKey: chart.nameKey(`Security ${tag}`), inactiveAt: new Date() },
    });
    const custom = `pest-control-${tag}`;

    const due = new Date("2001-01-01T09:00:00Z");
    const now = new Date("2001-01-02T00:05:00Z"); // 01:05 in Lagos, as the cron runs
    const day = "2001-01-02";
    const rule = (data) => prisma.recurringExpense.create({
      data: { userId: owner.id, businessId: biz.id, category: "other", amount: 1000, frequency: "monthly", nextDue: due, paymentMethod: "credit", ...data },
    });
    const R = {
      rent: await rule({ category: "rent", amount: 30000, notes: "  \nShop rent\nLekki branch  " }),
      util: await rule({ paymentMethod: " Credit ", accountId: UTIL.id, category: "utility", amount: 8000, payeeAccountName: "IKEJA ELECTRIC" }),
      loan: await rule({ accountId: LOANS.id, amount: 50000 }),
      paidCash: await rule({ category: "transport", paidThroughAccountId: CASH.id, amount: 2000 }),
      cash: await rule({ paymentMethod: "cash", category: "fuel", amount: 5000 }),
      noBiz: await rule({ businessId: null, amount: 700 }),
      custom: await rule({ category: custom, amount: 12345.67 }),
      fixed: await rule({ accountId: FIXED.id, amount: 90000 }),
      bare: await rule({ category: "rent", amount: 1500, notes: "" }),
      autoNoPayee: await rule({ category: "rent", amount: 2500, autoSend: true }),
      rested: await rule({ accountId: RESTED.id, amount: 4000, notes: "Guard" }),
      noise: await rule({ category: "rent", amount: 1234.565 }),
    };
    const ids = Object.values(R).map((r) => r.id);
    const billsOf = () => prisma.businessDebt.findMany({ where: { businessId: biz.id }, include: { payments: true } });

    const run = await processRecurringExpenses({ now });
    console.log("run:", JSON.stringify(run));

    await test("the run: 7 bills, 3 rules paused, 2 expenses (the paid-from rule and the cash rule), no auto-debits", async () => {
      eq(run.processed, 12, "processed"); // twelve rules, all due
      eq(run.createdBills, 7, "bills");
      eq(run.pausedCreditRules, 3, "paused");
      eq(run.createdExpenses, 2, "expenses");
      eq(run.autoDebited + run.autoDebitErrors, 0, "auto-debits");
    });

    const bills = await billsOf();
    const byNote = (fn) => bills.find(fn);
    await test("no expense on credit was recorded (a credit expense only where the rule names Cash as paid from)", async () => {
      const xs = await prisma.expense.findMany({ where: { userId: owner.id } });
      eq(xs.length, 2, "two expenses in all, none without a business");
      const credit = xs.filter((x) => String(x.paymentMethod).trim().toLowerCase() === "credit");
      eq(credit.length, 1, "one on credit");
      eq(credit[0].paidThroughAccountId, CASH.id, "the one paid from Cash");
      eq(credit[0].amount, 2000);
      ok(xs.some((x) => x.paymentMethod === "cash" && x.amount === 5000), "the cash rule's");
    });
    await test("the rent rule's bill: unpaid, its amount, dated the run, on Rent, from the note's first line", async () => {
      const b = bills.find((x) => x.originalAmount === 30000);
      ok(b, "made");
      eq(b.accountId, RENT.id);
      eq(b.name, "Shop rent");
      eq(b.note, "Shop rent\nLekki branch");
      eq(b.type, "rent");
      eq(b.remainingAmount, 30000);
      eq(b.status, "unpaid");
      eq(b.billDate.toISOString(), now.toISOString());
      eq(b.dueDate, null);
      eq(b.billNumber, null);
      eq(b.estimated, false);
      eq(b.userId, owner.id);
      eq(b.createdById, owner.id);
      eq(b.receivedViaAccountId, null);
      eq(b.payments.length, 0);
    });
    await test("\" Credit \" is credit; the rule's own account; the payee as the supplier", async () => {
      const b = bills.find((x) => x.originalAmount === 8000);
      eq(b.accountId, UTIL.id);
      eq(b.name, "IKEJA ELECTRIC");
      eq(b.note, null);
      eq(b.type, "utility");
    });
    await test("a custom category gets its account (ensureChart) and the bill goes on it", async () => {
      const acc = await prisma.ledgerAccount.findFirst({ where: { businessId: biz.id, categorySlug: custom } });
      ok(acc, "account made");
      const b = bills.find((x) => x.accountId === acc.id);
      ok(b, "bill on it");
      eq(kob(b.originalAmount), 1234567);
      eq(b.type, custom);
      eq(b.name, acc.name, "no note, no payee: the account's name");
    });
    await test("no note and no payee: the account's name; an auto-debit with no payee is bookkeeping, so a bill", async () => {
      ok(bills.find((x) => x.originalAmount === 1500 && x.name === RENT.name), "bare");
      ok(bills.find((x) => x.originalAmount === 2500 && x.accountId === RENT.id), "auto, no payee");
    });
    await test("a rested spending account the rule names is kept; an amount with float noise is kept to the kobo", async () => {
      ok(bills.find((x) => x.accountId === RESTED.id && x.originalAmount === 4000 && x.name === "Guard"), "rested");
      const k = require("../src/utils/money").toKobo(1234.565);
      ok(bills.find((x) => kob(x.originalAmount) === k && x.originalAmount === k / 100 && x.remainingAmount === k / 100), "kobo");
    });
    await test("the loan, equipment and no-business rules: paused, nothing recorded, owner told, audited", async () => {
      for (const [r, reason, accountId] of [[R.loan, "account_not_spending", LOANS.id], [R.fixed, "account_not_spending", FIXED.id], [R.noBiz, "no_business", null]]) {
        const now2 = await prisma.recurringExpense.findUnique({ where: { id: r.id } });
        eq(now2.active, false, `${reason} paused`);
        const a = await prisma.auditLog.findFirst({ where: { action: "RECURRING_PAUSED_CREDIT", resourceId: r.id } });
        ok(a, "audited");
        eq(a.metadata.reason, reason);
        eq(a.metadata.accountId, accountId);
        eq(a.actorType, "system");
      }
      eq(bills.some((b) => [LOANS.id, FIXED.id].includes(b.accountId)), false, "no bill on the balance sheet");
      const notes = await prisma.appNotification.findMany({ where: { userId: owner.id, title: "Recurring expense paused" } });
      eq(notes.length, 3, "three notifications");
      ok(notes.every((n) => /^₦/.test(n.body) && !/[—–]/.test(n.body)), "amount first, no dashes");
    });
    await test("every rule moved to its next due date; the others stay active", async () => {
      const rows = await prisma.recurringExpense.findMany({ where: { id: { in: ids } } });
      for (const r of rows) eq(r.nextDue.toISOString(), "2001-02-01T09:00:00.000Z", r.id);
      eq(rows.filter((r) => r.active).length, 9);
    });
    await test("each bill has its BILL_CREATE audit row naming the rule", async () => {
      const rows = await prisma.auditLog.findMany({ where: { action: "BILL_CREATE", resourceId: { in: bills.map((b) => b.id) } } });
      eq(rows.length, bills.length);
      ok(rows.every((a) => ids.includes(a.metadata.recurringExpenseId) && a.actorType === "system"), "named");
    });
    await test("a second run at the same time finds nothing due", async () => {
      const again = await processRecurringExpenses({ now });
      eq(again.processed, 0);
      eq((await billsOf()).length, bills.length);
    });

    const owed = bills.reduce((s, b) => s + kob(b.originalAmount), 0);
    const ledgerTies = async (asOf, apWant, label) => {
      invalidateOwner(owner.id);
      for (const basis of ["paid", "sold"]) {
        const b = await booksFor(biz.id, { from: asOf, to: asOf, basis });
        const L = await loadLedger(biz.id, { basis });
        eq(ledger.unbalanced(L.entries).length, 0, `${label} ${basis}: every entry balances`);
        const pl = ledger.profitAndLoss(L.entries, L.chart, { from: asOf, to: asOf });
        eq(kob(pl.totalExpenses), kob(b.expenses.total), `${label} ${basis}: profit and loss = the books`);
        eq(ledger.trialBalance(L.entries, L.chart, asOf).balanced, true, `${label} ${basis}: trial balance`);
        if (basis === "sold") eq(-(ledger.sumByAccount(L.entries, { to: asOf }).get(AP.id) || 0), apWant, `${label}: Accounts Payable`);
      }
    };
    await test("the books: when paid, only the two expenses; when sold, the bills too; the ledger ties out, AP = the bills", async () => {
      const paid = await booksFor(biz.id, { from: day, to: day, basis: "paid" });
      const sold = await booksFor(biz.id, { from: day, to: day, basis: "sold" });
      eq(kob(paid.expenses.total), 700000, "paid view: 2,000 + 5,000");
      eq(kob(sold.expenses.total), 700000 + owed, "sold view: and every bill");
      await ledgerTies(day, owed, "run day");
    });
    await test("GET /bills lists them; a bill the runner made is paid off in cash, and AP drops by it", async () => {
      const list = await call("GET", `/bills?businessId=${biz.id}`, T);
      eq(list.status, 200, JSON.stringify(list.body));
      eq(list.body.bills.length, bills.length);
      const rent = bills.find((x) => x.originalAmount === 30000);
      const pay = await call("POST", `/bills/${rent.id}/payments`, T, { amount: 30000, method: "cash", date: "2001-01-03" });
      eq(pay.status, 201, JSON.stringify(pay.body));
      eq(pay.body.bill.status, "paid");
      eq(pay.body.bill.balance, 0);
      const paidNext = await booksFor(biz.id, { from: "2001-01-03", to: "2001-01-03", basis: "paid" });
      eq(kob(paidNext.expenses.total), 3000000, "paid view counts the payment on its day");
      await ledgerTies("2001-01-03", owed - 3000000, "after the payment");
    });
    await test("the next month: the active credit rules make their bills again, the paused ones nothing", async () => {
      const next = await processRecurringExpenses({ now: new Date("2001-02-02T00:05:00Z") });
      eq(next.processed, 9);
      eq(next.createdBills, 7);
      eq(next.pausedCreditRules, 0);
      eq(next.createdExpenses, 2);
    });
  } finally {
    server.close();
    await prisma.$disconnect();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

function ok(v, what) {
  assert.ok(v, what);
}
