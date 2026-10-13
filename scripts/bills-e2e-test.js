// Bills end to end (chart of accounts release 2, 2026-10-13): the real /bills
// and /sync routers over HTTP, the real auth middleware and permission gates,
// a real local Postgres. Covers adding, editing and deleting bills; payments in
// cash and from the KashBook account (the debit link: which debit may be
// named, the amount it carries, freeing it again, two payments racing for one
// debit); overpayment refusals, also under concurrent payments; who may do
// what (owner, staff with and without canManagePayables and canViewBalance,
// another owner); the books lock date on every write; a payable from before
// bills (converted, and not yet converted); the sync bundle's bills key and
// the retired payable doors; Insights' "Who do I owe?"; the ledger cache
// cleared and an audit row on every write. A last section checks that the
// transaction routes never explain a debit a bill payment already carries.
//
// Point it at a LOCAL scratch database (a clone of the migrated template):
//   node scratchpad/with-local-db.js kashbook_coa_e2e_a1 node scripts/bills-e2e-test.js
const url = process.env.TEST_DATABASE_URL;
if (!url) {
  console.error("TEST_DATABASE_URL is required (a local scratch database).");
  process.exit(1);
}
if (!["localhost", "127.0.0.1"].includes(new URL(url).hostname)) {
  console.error("Refusing: local databases only.");
  process.exit(1);
}
process.env.DATABASE_URL = url;
process.env.JWT_SECRET = "e2e-only-secret-0123456789abcdef0123456789abcdef";
process.env.NODE_ENV = "test";

const assert = require("assert");
const http = require("http");
const express = require("express");
const prisma = require("../src/utils/db");
const { signToken } = require("../src/utils/jwt");
const chart = require("../src/utils/chart");

// Every ledger the bill routes clear, recorded. Installed before any router is
// loaded, because the routers take the function when they are required.
const ledgerData = require("../src/utils/ledgerData");
const cleared = [];
{
  const real = ledgerData.invalidateLedger;
  ledgerData.invalidateLedger = (businessId) => {
    cleared.push(businessId);
    return real(businessId);
  };
}
const { ensureChart } = ledgerData;
const { answerQuestion } = require("../src/utils/insightsEngine");

const app = express();
app.use(express.json());
// As server.js does before every route.
app.use(require("../src/middleware/idGuard").idGuard);
app.use("/bills", require("../src/routes/bills"));
app.use("/sync", require("../src/routes/sync"));
// The transaction routes are another builder's file: loaded on their own, so
// a problem there fails only the section that uses them.
let txRouterError = null;
try {
  app.use("/transactions", require("../src/routes/transactions"));
} catch (e) {
  txRouterError = e;
}

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
const GET = (p, t) => call("GET", p, t);
const POST = (p, t, b) => call("POST", p, t, b === undefined ? {} : b);
const PATCH = (p, t, b) => call("PATCH", p, t, b === undefined ? {} : b);
const DEL = (p, t) => call("DELETE", p, t);

let passed = 0;
let failed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (e) {
    failed++;
    failures.push(name);
    console.log(`  FAIL  ${name}\n        ${String(e.message).split("\n")[0]}`);
  }
}
const eq = (a, b, what = "") => assert.strictEqual(a, b, `${what} ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
const ok = (v, what) => assert.ok(v, what);
const section = (s) => console.log(`\n── ${s}`);
const status = (r, want, what = "") => assert.strictEqual(r.status, want, `${what} status ${r.status}: ${JSON.stringify(r.body)}`);
const refused = (r, want, code, what = "") => {
  status(r, want, what);
  eq(r.body && r.body.code, code, `${what} code`);
};

const tag = Date.now().toString(36);
const DAY = 86400000;
// A Lagos calendar day, `offset` days from today, and noon Lagos on it.
const lagosDay = (offset = 0) => new Date(Date.now() + 3600000 + offset * DAY).toISOString().slice(0, 10);
const atNoon = (offset = 0) => new Date(`${lagosDay(offset)}T12:00:00+01:00`);
const dayOfDate = (d) => new Date(new Date(d).getTime() + 3600000).toISOString().slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, what, ms = 2000) {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

(async () => {
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  BASE = `http://127.0.0.1:${server.address().port}`;
  console.log(`\nBILLS, END TO END\n${BASE}`);

  try {
    // ── People, businesses and charts ────────────────────────────────────────
    const mkUser = (data) => prisma.user.create({
      data: { password: "x", lastName: "T", businessName: "B", country: "NG", currency: "NGN", ...data },
    });
    const owner = await mkUser({ email: `bills-${tag}@t.local`, firstName: "Ada", accountType: "OWNER" });
    const rival = await mkUser({ email: `bills-rival-${tag}@t.local`, firstName: "Rival", accountType: "OWNER" });
    const biz = await prisma.business.create({ data: { userId: owner.id, name: `Bills ${tag}`, country: "NG", baseCurrency: "NGN" } });
    const biz2 = await prisma.business.create({ data: { userId: owner.id, name: `Bills two ${tag}`, country: "NG", baseCurrency: "NGN" } });
    const rivalBiz = await prisma.business.create({ data: { userId: rival.id, name: `Rival ${tag}`, country: "NG", baseCurrency: "NGN" } });
    for (const b of [biz, biz2, rivalBiz]) await ensureChart(b.id);
    const T = signToken({ userId: owner.id, tokenVersion: 0 });
    const tRival = signToken({ userId: rival.id, tokenVersion: 0 });
    const staffOf = async (employer, name, grants) => {
      const s = await mkUser({ email: `bills-${name}-${tag}@t.local`, firstName: name, accountType: "STAFF", employerId: employer.id });
      await prisma.staffPermission.create({ data: { userId: s.id, employerId: employer.id, grantedById: employer.id, ...grants } });
      return { user: s, token: signToken({ userId: s.id, tokenVersion: 0 }) };
    };
    const plain = await staffOf(owner, "plain", {});
    const reports = await staffOf(owner, "reports", { canViewReports: true, canViewBalance: true });
    const payables = await staffOf(owner, "payables", { canManagePayables: true });
    const payBank = await staffOf(owner, "paybank", { canManagePayables: true, canViewBalance: true });
    const rivalStaff = await staffOf(rival, "rivalstaff", { canManagePayables: true, canViewBalance: true });

    const chartOf = async (bizId) => {
      const list = await prisma.ledgerAccount.findMany({ where: { businessId: bizId } });
      return {
        sys: (k) => list.find((a) => a.systemKey === k),
        cat: (s) => list.find((a) => a.categorySlug === s),
        seed: (s) => list.find((a) => a.seed === s),
      };
    };
    const A = await chartOf(biz.id);
    const rent = A.cat("rent");
    const utility = A.cat("utility");
    const cogs = A.sys(chart.SYS.COGS);
    const loans = A.sys(chart.SYS.LOANS);
    const vat = A.sys(chart.SYS.VAT);
    const cash = A.sys(chart.SYS.CASH);
    const otherBank = A.sys(chart.SYS.OTHER_BANK);
    const pos = A.sys(chart.SYS.POS);
    const sales = A.sys(chart.SYS.SALES);
    const kashbook = A.sys(chart.SYS.KASHBOOK);
    const ap = A.sys(chart.SYS.AP);
    const suspense = A.sys(chart.SYS.SUSPENSE);
    const drawings = A.sys(chart.SYS.DRAWINGS);
    const furniture = A.seed("furniture_equipment");
    const rested = await prisma.ledgerAccount.create({
      data: { businessId: biz.id, type: "expense", name: `Rested ${tag}`, nameKey: chart.nameKey(`Rested ${tag}`), inactiveAt: new Date() },
    });
    const rivalRent = (await chartOf(rivalBiz.id)).cat("rent");
    for (const [name, a] of Object.entries({ rent, utility, cogs, loans, vat, cash, otherBank, pos, sales, kashbook, ap, suspense, drawings, furniture, rivalRent })) {
      ok(a, `chart has ${name}`);
    }

    const debit = (bizId, amount, offset = 0, over = {}) => prisma.transaction.create({
      data: {
        businessId: bizId, userId: owner.id, type: "expense", amount, paymentMethod: "bank", category: "transfer",
        source: "anchor", currency: "NGN", date: atNoon(offset), description: "e2e debit", ...over,
      },
    });
    const txNow = (id) => prisma.transaction.findUnique({ where: { id } });
    const billNow = (id) => prisma.businessDebt.findUnique({ where: { id }, include: { payments: true } });
    const newBill = async (over = {}, token = T) => {
      const r = await POST("/bills", token, {
        businessId: biz.id, vendorName: "Mama Nkechi Supplies", accountId: cogs.id, amount: 10000, billDate: lagosDay(0), ...over,
      });
      status(r, 201, "new bill");
      return r.body.bill;
    };
    const pay = (billId, body, token = T) => POST(`/bills/${billId}/payments`, token, body);

    // ═════════════════════════════════════════════════════════════════════════
    section("adding a bill");
    let rentBill;
    await test("the owner adds a bill: every field kept, nothing paid yet", async () => {
      const before = cleared.length;
      const r = await POST("/bills", T, {
        businessId: biz.id, vendorName: "  Landlord Ltd  ", accountId: rent.id, amount: "50000.5", billDate: lagosDay(-1),
        dueDate: lagosDay(7), billNumber: "INV-778", note: "October rent",
      });
      status(r, 201);
      rentBill = r.body.bill;
      eq(rentBill.vendorName, "Landlord Ltd");
      eq(rentBill.name, "Landlord Ltd", "the column keeps the vendor");
      eq(rentBill.amount, 50000.5);
      eq(rentBill.originalAmount, 50000.5);
      eq(rentBill.balance, 50000.5);
      eq(rentBill.remainingAmount, 50000.5);
      eq(rentBill.amountPaid, 0);
      eq(rentBill.status, "unpaid");
      eq(rentBill.accountId, rent.id);
      eq(rentBill.type, "rent", "the legacy type is the account's category");
      eq(rentBill.businessId, biz.id);
      eq(rentBill.userId, owner.id);
      eq(rentBill.createdById, owner.id);
      eq(rentBill.billNumber, "INV-778");
      eq(rentBill.note, "October rent");
      eq(rentBill.estimated, false);
      eq(rentBill.receivedViaAccountId, null);
      eq(dayOfDate(rentBill.billDate), lagosDay(-1), "bill date lands on the Lagos day sent");
      eq(dayOfDate(rentBill.dueDate), lagosDay(7));
      ok(Array.isArray(rentBill.payments) && rentBill.payments.length === 0, "no payments");
      ok(cleared.slice(before).includes(biz.id), "the business's ledger was cleared");
      await waitFor(() => prisma.auditLog.findFirst({ where: { action: "BILL_CREATE", resourceType: "bill", resourceId: rentBill.id } }), "the audit row");
    });
    await test("a bill with no date is dated today", async () => {
      const r = await POST("/bills", T, { businessId: biz.id, vendorName: "No Date", accountId: utility.id, amount: 100 });
      status(r, 201);
      eq(dayOfDate(r.body.bill.billDate), lagosDay(0));
      eq(r.body.bill.dueDate, null);
    });
    await test("what a bill needs is refused when missing or wrong", async () => {
      refused(await POST("/bills", T, { vendorName: "X", accountId: rent.id, amount: 5 }), 400, "BUSINESS_REQUIRED");
      refused(await POST("/bills", T, { businessId: biz.id, accountId: rent.id, amount: 5 }), 400, "VENDOR_REQUIRED");
      refused(await POST("/bills", T, { businessId: biz.id, vendorName: "   ", accountId: rent.id, amount: 5 }), 400, "VENDOR_REQUIRED");
      for (const amount of [0, -5, "abc", "", null, "1,000", 1e15, true]) {
        const r = await POST("/bills", T, { businessId: biz.id, vendorName: "X", accountId: rent.id, amount });
        refused(r, 400, "BAD_AMOUNT", `amount ${JSON.stringify(amount)}`);
        eq(r.body.field, "amount");
      }
      const noAcc = await POST("/bills", T, { businessId: biz.id, vendorName: "X", amount: 5 });
      refused(noAcc, 400, "ACCOUNT_REQUIRED");
      eq(noAcc.body.field, "accountId");
      for (const billDate of ["not a date", "1999-12-31", "2400-01-01", { y: 1 }]) {
        refused(await POST("/bills", T, { businessId: biz.id, vendorName: "X", accountId: rent.id, amount: 5, billDate }), 400, "BAD_DATE", `billDate ${JSON.stringify(billDate)}`);
      }
      refused(await POST("/bills", T, { businessId: biz.id, vendorName: "X", accountId: rent.id, amount: 5, dueDate: "nope" }), 400, "BAD_DATE");
    });
    await test("a bill is for spending or a liability, never income, a controlled, rested, asset or another chart's account", async () => {
      for (const [name, a] of Object.entries({ sales, kashbook, ap, suspense, furniture, rested, drawings })) {
        const r = await POST("/bills", T, { businessId: biz.id, vendorName: "X", accountId: a.id, amount: 5 });
        refused(r, 400, "ACCOUNT_NOT_ALLOWED", name);
        eq(r.body.field, "accountId", name);
      }
      refused(await POST("/bills", T, { businessId: biz.id, vendorName: "X", accountId: rivalRent.id, amount: 5 }), 400, "ACCOUNT_NOT_FOUND");
      refused(await POST("/bills", T, { businessId: biz.id, vendorName: "X", accountId: "no-such-account", amount: 5 }), 400, "ACCOUNT_NOT_FOUND");
      // VAT Payable is a liability the owner may owe and bill.
      status(await POST("/bills", T, { businessId: biz.id, vendorName: "FIRS", accountId: vat.id, amount: 5 }), 201, "VAT Payable");
    });
    let loanBill;
    await test("a loan bill keeps where the money went; any other bill does not", async () => {
      const r = await POST("/bills", T, {
        businessId: biz.id, vendorName: "Cooperative", accountId: loans.id, amount: 200000, receivedViaAccountId: cash.id,
      });
      status(r, 201);
      loanBill = r.body.bill;
      eq(loanBill.receivedViaAccountId, cash.id);
      eq(loanBill.type, "loan");
      const e = await POST("/bills", T, { businessId: biz.id, vendorName: "Shop", accountId: utility.id, amount: 5, receivedViaAccountId: cash.id });
      status(e, 201);
      eq(e.body.bill.receivedViaAccountId, null, "spending has no money received");
      const bad = await POST("/bills", T, { businessId: biz.id, vendorName: "Coop", accountId: loans.id, amount: 5, receivedViaAccountId: kashbook.id });
      refused(bad, 400, "ACCOUNT_NOT_ALLOWED");
      eq(bad.body.field, "receivedViaAccountId");
      refused(await POST("/bills", T, { businessId: biz.id, vendorName: "Coop", accountId: loans.id, amount: 5, receivedViaAccountId: rent.id }), 400, "ACCOUNT_NOT_ALLOWED");
    });
    await test("a bill is only added to the caller's own business", async () => {
      status(await POST("/bills", T, { businessId: rivalBiz.id, vendorName: "X", accountId: rivalRent.id, amount: 5 }), 403);
      status(await POST("/bills", tRival, { businessId: biz.id, vendorName: "X", accountId: rent.id, amount: 5 }), 403);
      eq(await prisma.businessDebt.count({ where: { businessId: rivalBiz.id } }), 0);
    });
    await test("an id that is not text is refused before any route (idGuard)", async () => {
      refused(await GET(`/bills?businessId[not]=x`, T), 400, "BAD_ID");
      refused(await POST("/bills", T, { businessId: { not: "x" }, vendorName: "X", accountId: rent.id, amount: 5 }), 400, "BAD_ID");
      refused(await POST(`/bills/${rentBill.id}/payments`, T, { amount: 5, method: "bank", transactionId: { not: null } }), 400, "BAD_ID");
    });

    // ═════════════════════════════════════════════════════════════════════════
    section("reading bills");
    await test("GET lists this business's bills with their payments, newest bill date first", async () => {
      const r = await GET(`/bills?businessId=${biz.id}`, T);
      status(r, 200);
      ok(Array.isArray(r.body.bills), "bills");
      ok(r.body.bills.some((b) => b.id === rentBill.id), "the rent bill");
      ok(r.body.bills.every((b) => b.businessId === biz.id && Array.isArray(b.payments)), "one business, payments on each");
      const days = r.body.bills.map((b) => new Date(b.billDate).getTime());
      ok(days.every((d, i) => i === 0 || days[i - 1] >= d), "newest first");
      refused(await GET(`/bills`, T), 400, "BUSINESS_REQUIRED");
    });
    await test("GET /bills/:id returns the bill; another owner gets nothing", async () => {
      const r = await GET(`/bills/${rentBill.id}`, T);
      status(r, 200);
      eq(r.body.bill.id, rentBill.id);
      status(await GET(`/bills?businessId=${biz.id}`, tRival), 403);
      refused(await GET(`/bills/${rentBill.id}`, tRival), 404, "BILL_NOT_FOUND");
      refused(await GET(`/bills/no-such-bill`, T), 404, "BILL_NOT_FOUND");
    });

    // ═════════════════════════════════════════════════════════════════════════
    section("editing a bill");
    await test("only the fields sent change; the ledger is cleared and the edit audited", async () => {
      const before = cleared.length;
      const r = await PATCH(`/bills/${rentBill.id}`, T, { vendorName: "Landlord Limited", note: "Rent, October", billNumber: "INV-779", dueDate: lagosDay(10) });
      status(r, 200);
      eq(r.body.bill.vendorName, "Landlord Limited");
      eq(r.body.bill.note, "Rent, October");
      eq(r.body.bill.billNumber, "INV-779");
      eq(dayOfDate(r.body.bill.dueDate), lagosDay(10));
      eq(r.body.bill.amount, 50000.5, "the amount is untouched");
      eq(r.body.bill.accountId, rent.id, "the account is untouched");
      ok(cleared.slice(before).includes(biz.id), "ledger cleared");
      await waitFor(() => prisma.auditLog.findFirst({ where: { action: "BILL_UPDATE", resourceId: rentBill.id } }), "the audit row");
      const cleared0 = await PATCH(`/bills/${rentBill.id}`, T, { dueDate: null, billNumber: "" });
      status(cleared0, 200);
      eq(cleared0.body.bill.dueDate, null, "a due date can be cleared");
      eq(cleared0.body.bill.billNumber, null);
    });
    await test("an edit that changes nothing writes nothing", async () => {
      const row = await billNow(rentBill.id);
      const before = cleared.length;
      const r = await PATCH(`/bills/${rentBill.id}`, T, { vendorName: row.name, amount: row.originalAmount });
      status(r, 200);
      eq(new Date(r.body.bill.updatedAt).getTime(), row.updatedAt.getTime(), "updatedAt unchanged");
      eq(cleared.length, before, "no ledger cleared");
    });
    await test("a new account, amount and date are kept; the legacy type follows the account", async () => {
      const r = await PATCH(`/bills/${rentBill.id}`, T, { accountId: utility.id, amount: 60000, billDate: lagosDay(-1) });
      status(r, 200);
      eq(r.body.bill.accountId, utility.id);
      eq(r.body.bill.type, "utility");
      eq(r.body.bill.amount, 60000);
      eq(r.body.bill.balance, 60000);
      const back = await PATCH(`/bills/${rentBill.id}`, T, { accountId: rent.id, amount: 50000 });
      status(back, 200);
      eq(back.body.bill.type, "rent");
    });
    await test("a bill always names an account, of the bill kind", async () => {
      refused(await PATCH(`/bills/${rentBill.id}`, T, { accountId: null }), 400, "ACCOUNT_REQUIRED");
      refused(await PATCH(`/bills/${rentBill.id}`, T, { accountId: sales.id }), 400, "ACCOUNT_NOT_ALLOWED");
      refused(await PATCH(`/bills/${rentBill.id}`, T, { vendorName: "" }), 400, "VENDOR_REQUIRED");
      refused(await PATCH(`/bills/${rentBill.id}`, T, { billDate: null }), 400, "BAD_DATE");
      refused(await PATCH(`/bills/${rentBill.id}`, T, { amount: 0 }), 400, "BAD_AMOUNT");
    });
    await test("an account the owner rested since is kept on an edit of other fields", async () => {
      const acc = await prisma.ledgerAccount.create({
        data: { businessId: biz.id, type: "expense", name: `Generator Hire ${tag}`, nameKey: chart.nameKey(`Generator Hire ${tag}`) },
      });
      const b = await newBill({ accountId: acc.id });
      await prisma.ledgerAccount.update({ where: { id: acc.id }, data: { inactiveAt: new Date() } });
      const r = await PATCH(`/bills/${b.id}`, T, { accountId: acc.id, note: "still hired" });
      status(r, 200);
      eq(r.body.bill.accountId, acc.id);
      eq(r.body.bill.note, "still hired");
    });
    await test("moving a loan bill to spending lets go of where the money went", async () => {
      const r = await PATCH(`/bills/${loanBill.id}`, T, { receivedViaAccountId: otherBank.id });
      status(r, 200);
      eq(r.body.bill.receivedViaAccountId, otherBank.id);
      const s = await PATCH(`/bills/${loanBill.id}`, T, { accountId: utility.id });
      status(s, 200);
      eq(s.body.bill.receivedViaAccountId, null);
      const back = await PATCH(`/bills/${loanBill.id}`, T, { accountId: loans.id, receivedViaAccountId: cash.id });
      status(back, 200);
      eq(back.body.bill.receivedViaAccountId, cash.id);
    });
    await test("another owner can't edit the bill", async () => {
      refused(await PATCH(`/bills/${rentBill.id}`, tRival, { note: "mine now" }), 404, "BILL_NOT_FOUND");
      eq((await billNow(rentBill.id)).note, "Rent, October");
    });

    // ═════════════════════════════════════════════════════════════════════════
    section("paying in cash and from other accounts");
    await test("a payment lowers what is owed; the bill is part paid", async () => {
      const before = cleared.length;
      const r = await pay(rentBill.id, { amount: 20000, method: "cash", paidThroughAccountId: cash.id, date: lagosDay(0), note: "first part" });
      status(r, 201);
      eq(r.body.bill.balance, 30000);
      eq(r.body.bill.amountPaid, 20000);
      eq(r.body.bill.status, "partial");
      eq(r.body.payment.amount, 20000);
      eq(r.body.payment.method, "cash");
      eq(r.body.payment.paidThroughAccountId, cash.id);
      eq(r.body.payment.transactionId, null);
      eq(r.body.payment.outsideBooks, false);
      eq(r.body.payment.estimated, false);
      eq(r.body.payment.createdById, owner.id);
      eq(r.body.payment.note, "first part");
      eq(r.body.transaction, null);
      eq(r.body.bill.payments.length, 1);
      eq(dayOfDate(r.body.payment.date), lagosDay(0));
      ok(cleared.slice(before).includes(biz.id), "ledger cleared");
      await waitFor(() => prisma.auditLog.findFirst({ where: { action: "BILL_PAYMENT", resourceId: rentBill.id } }), "the audit row");
    });
    await test("no method is cash; a transfer may say which account paid", async () => {
      const b = await newBill({ amount: 3000 });
      const r = await pay(b.id, { amount: 1000 });
      status(r, 201);
      eq(r.body.payment.method, "cash");
      eq(r.body.payment.paidThroughAccountId, null);
      const t = await pay(b.id, { amount: 1000, method: "Transfer", paidThroughAccountId: otherBank.id });
      status(t, 201);
      eq(t.body.payment.method, "transfer");
      eq(t.body.payment.paidThroughAccountId, otherBank.id);
      const p = await pay(b.id, { amount: 1000, method: "pos", paidThroughAccountId: pos.id });
      status(p, 201);
      eq(p.body.bill.status, "paid");
      eq(p.body.bill.balance, 0);
    });
    await test("a payment is refused for a bad method, amount, account or date", async () => {
      refused(await pay(rentBill.id, { amount: 10, method: "card" }), 400, "BAD_METHOD");
      refused(await pay(rentBill.id, { amount: 10, method: "credit" }), 400, "BAD_METHOD");
      refused(await pay(rentBill.id, { amount: -10 }), 400, "BAD_AMOUNT");
      refused(await pay(rentBill.id, { amount: 10, paidThroughAccountId: rent.id }), 400, "ACCOUNT_NOT_ALLOWED");
      refused(await pay(rentBill.id, { amount: 10, paidThroughAccountId: kashbook.id }), 400, "ACCOUNT_NOT_ALLOWED");
      refused(await pay(rentBill.id, { amount: 10, date: "2400-01-01" }), 400, "BAD_DATE");
      eq((await billNow(rentBill.id)).payments.length, 1, "nothing recorded");
    });
    await test("a transfer named on a cash payment is not linked", async () => {
      const d = await debit(biz.id, 700, 0);
      const b = await newBill({ amount: 700 });
      const r = await pay(b.id, { amount: 700, method: "cash", transactionId: d.id });
      status(r, 201);
      eq(r.body.payment.transactionId, null);
      eq((await txNow(d.id)).matchedBillId, null, "the debit stays free");
    });

    // ═════════════════════════════════════════════════════════════════════════
    section("overpayment");
    await test("more than the bill owes is refused, with what it owes", async () => {
      const r = await pay(rentBill.id, { amount: 30000.01 });
      refused(r, 400, "EXCEEDS_BALANCE");
      eq(r.body.balance, 30000);
      eq(r.body.field, "amount");
    });
    await test("paying the rest exactly settles it; then nothing more is taken", async () => {
      const b = await newBill({ amount: 999.99 });
      status(await pay(b.id, { amount: 333.33 }), 201);
      const r = await pay(b.id, { amount: 666.66 });
      status(r, 201);
      eq(r.body.bill.status, "paid");
      eq(r.body.bill.balance, 0);
      refused(await pay(b.id, { amount: 0.01 }), 400, "PAID_IN_FULL");
    });
    await test("the amount is never below what is paid", async () => {
      const r = await PATCH(`/bills/${rentBill.id}`, T, { amount: 19999.99 });
      refused(r, 409, "AMOUNT_BELOW_PAID");
      eq(r.body.paid, 20000);
      eq((await billNow(rentBill.id)).originalAmount, 50000);
      const exact = await newBill({ amount: 500 });
      status(await pay(exact.id, { amount: 200 }), 201);
      const down = await PATCH(`/bills/${exact.id}`, T, { amount: 200 });
      status(down, 200);
      eq(down.body.bill.status, "paid");
      eq(down.body.bill.balance, 0);
      const up = await PATCH(`/bills/${exact.id}`, T, { amount: 300 });
      eq(up.body.bill.status, "partial");
      eq(up.body.bill.balance, 100);
    });
    await test("payments racing on one bill never pay more than it owes", async () => {
      const b = await newBill({ amount: 10000 });
      const rs = await Promise.all([1, 2, 3, 4, 5].map(() => pay(b.id, { amount: 4000 })));
      eq(rs.filter((r) => r.status === 201).length, 2, "two fit");
      ok(rs.filter((r) => r.status !== 201).every((r) => r.status === 400 && r.body.code === "EXCEEDS_BALANCE"), "the rest are refused");
      const row = await billNow(b.id);
      eq(row.payments.length, 2);
      eq(row.remainingAmount, 2000);
      eq(row.status, "partial");
    });

    // ═════════════════════════════════════════════════════════════════════════
    section("paying from the KashBook account (the debit link)");
    const bankBill = await newBill({ vendorName: "Dangote Depot", amount: 40000, billDate: lagosDay(-6) });
    await test("a KashBook payment must name the debit", async () => {
      const r = await pay(bankBill.id, { amount: 100, method: "bank" });
      refused(r, 400, "TRANSACTION_REQUIRED");
      eq(r.body.field, "transactionId");
    });
    await test("only this business's unexplained money out may be named", async () => {
      const theirs = await debit(rivalBiz.id, 5000, -1);
      const otherBiz = await debit(biz2.id, 5000, -1);
      const credit = await debit(biz.id, 5000, -1, { type: "income" });
      const refund = await debit(biz.id, 5000, -1, { purpose: "customer_refund" });
      const filed = await debit(biz.id, 5000, -1, { accountId: rent.id, purpose: "account" });
      const expensed = await debit(biz.id, 5000, -1);
      const exp = await prisma.expense.create({
        data: { userId: owner.id, businessId: biz.id, category: "rent", amount: 5000, paymentMethod: "transfer", date: atNoon(-1), matchedTransactionId: expensed.id },
      });
      await prisma.transaction.update({ where: { id: expensed.id }, data: { matchedExpenseId: exp.id, matchedAmount: 5000 } });
      const euro = await debit(biz.id, 5000, -1, { currency: "EUR" });
      refused(await pay(bankBill.id, { amount: 100, method: "bank", transactionId: theirs.id }), 404, "TRANSACTION_NOT_FOUND", "another owner's debit");
      refused(await pay(bankBill.id, { amount: 100, method: "bank", transactionId: otherBiz.id }), 404, "TRANSACTION_NOT_FOUND", "the owner's other business");
      refused(await pay(bankBill.id, { amount: 100, method: "bank", transactionId: "no-such-row" }), 404, "TRANSACTION_NOT_FOUND");
      refused(await pay(bankBill.id, { amount: 100, method: "bank", transactionId: credit.id }), 400, "NOT_OUTGOING", "money in");
      refused(await pay(bankBill.id, { amount: 100, method: "bank", transactionId: refund.id }), 409, "TRANSACTION_TAKEN", "a refund");
      refused(await pay(bankBill.id, { amount: 100, method: "bank", transactionId: filed.id }), 409, "TRANSACTION_TAKEN", "explained with an account");
      refused(await pay(bankBill.id, { amount: 100, method: "bank", transactionId: expensed.id }), 409, "TRANSACTION_TAKEN", "recorded as an expense");
      refused(await pay(bankBill.id, { amount: 100, method: "bank", transactionId: euro.id }), 409, "CURRENCY_MISMATCH", "another currency");
      eq((await billNow(bankBill.id)).payments.length, 0, "nothing recorded");
      for (const t of [theirs, otherBiz, credit, refund, filed, euro]) eq((await txNow(t.id)).matchedBillId, null, "no row was linked");
      eq((await txNow(expensed.id)).matchedAmount, 5000, "the expense's link is untouched");
    });
    await test("a payment can't be more than the debit", async () => {
      const d = await debit(biz.id, 3000, -2);
      const r = await pay(bankBill.id, { amount: 3000.01, method: "bank", transactionId: d.id });
      refused(r, 400, "EXCEEDS_TRANSFER");
      eq(r.body.transferAmount, 3000);
      eq((await txNow(d.id)).matchedBillId, null);
    });
    let linkedDebit;
    let bankPayment;
    await test("a KashBook payment is dated when the money left; the debit carries the bill and the amount", async () => {
      linkedDebit = await debit(biz.id, 15000, -3);
      const r = await pay(bankBill.id, { amount: 12000, method: "bank", transactionId: linkedDebit.id, date: lagosDay(0), paidThroughAccountId: cash.id });
      status(r, 201);
      bankPayment = r.body.payment;
      eq(bankPayment.method, "bank");
      eq(bankPayment.transactionId, linkedDebit.id);
      eq(bankPayment.paidThroughAccountId, null, "a KashBook payment is paid through the debit, not a picked account");
      eq(new Date(bankPayment.date).getTime(), linkedDebit.date.getTime(), "dated with the debit, not the date sent");
      eq(r.body.bill.balance, 28000);
      const tx = await txNow(linkedDebit.id);
      eq(tx.matchedBillId, bankBill.id);
      eq(tx.matchedAmount, 12000, "the payment, the rest of the debit still counts on its own");
      ok(tx.updatedAt.getTime() > linkedDebit.updatedAt.getTime(), "the bank row moved, so a pull carries it");
      eq(r.body.transaction.id, linkedDebit.id);
      eq(r.body.transaction.matchedBillId, bankBill.id);
    });
    await test("a debit pays one bill payment only", async () => {
      const other = await newBill({ amount: 5000 });
      refused(await pay(other.id, { amount: 1000, method: "bank", transactionId: linkedDebit.id }), 409, "TRANSACTION_TAKEN");
      refused(await pay(bankBill.id, { amount: 1000, method: "bank", transactionId: linkedDebit.id }), 409, "TRANSACTION_TAKEN");
      eq((await txNow(linkedDebit.id)).matchedAmount, 12000);
    });
    await test("two bills racing for one debit: exactly one gets it", async () => {
      const d = await debit(biz.id, 8000, -1);
      const b1 = await newBill({ amount: 8000 });
      const b2 = await newBill({ amount: 8000 });
      const rs = await Promise.all([b1, b2].map((b) => pay(b.id, { amount: 8000, method: "bank", transactionId: d.id })));
      eq(rs.filter((r) => r.status === 201).length, 1, "one link");
      const lost = rs.find((r) => r.status !== 201);
      refused(lost, 409, "TRANSACTION_TAKEN");
      const tx = await txNow(d.id);
      const winner = rs.find((r) => r.status === 201).body.bill.id;
      eq(tx.matchedBillId, winner);
      eq(await prisma.billPayment.count({ where: { transactionId: d.id } }), 1, "one payment names it");
    });

    // ═════════════════════════════════════════════════════════════════════════
    section("taking a payment back (owner only)");
    await test("staff can't take a payment back, even with the grants", async () => {
      refused(await DEL(`/bills/${bankBill.id}/payments/${bankPayment.id}`, payBank.token), 403, "OWNER_ONLY");
      eq((await txNow(linkedDebit.id)).matchedBillId, bankBill.id);
    });
    await test("the owner takes a KashBook payment back: the bill owes it again and the debit is free", async () => {
      const r = await DEL(`/bills/${bankBill.id}/payments/${bankPayment.id}`, T);
      status(r, 200);
      eq(r.body.bill.balance, 40000);
      eq(r.body.bill.status, "unpaid");
      eq(r.body.bill.payments.length, 0);
      eq(r.body.transaction.id, linkedDebit.id);
      const tx = await txNow(linkedDebit.id);
      eq(tx.matchedBillId, null);
      eq(tx.matchedAmount, null);
      await waitFor(() => prisma.auditLog.findFirst({ where: { action: "BILL_PAYMENT_DELETE", resourceId: bankBill.id } }), "the audit row");
      refused(await DEL(`/bills/${bankBill.id}/payments/${bankPayment.id}`, T), 404, "PAYMENT_NOT_FOUND");
    });
    await test("a freed debit can pay again", async () => {
      const r = await pay(bankBill.id, { amount: 15000, method: "bank", transactionId: linkedDebit.id });
      status(r, 201);
      bankPayment = r.body.payment;
      eq((await txNow(linkedDebit.id)).matchedAmount, 15000);
    });
    await test("a payment is taken back only through its own bill", async () => {
      refused(await DEL(`/bills/${rentBill.id}/payments/${bankPayment.id}`, T), 404, "PAYMENT_NOT_FOUND");
      refused(await DEL(`/bills/${bankBill.id}/payments/${bankPayment.id}`, tRival), 404, "BILL_NOT_FOUND");
      eq((await txNow(linkedDebit.id)).matchedBillId, bankBill.id);
    });

    // ═════════════════════════════════════════════════════════════════════════
    section("deleting a bill (owner only)");
    await test("staff can't delete a bill", async () => {
      refused(await DEL(`/bills/${bankBill.id}`, payBank.token), 403, "OWNER_ONLY");
      refused(await DEL(`/bills/${bankBill.id}`, plain.token), 403, "OWNER_ONLY");
      ok(await billNow(bankBill.id), "still there");
    });
    await test("another owner can't delete it", async () => {
      refused(await DEL(`/bills/${bankBill.id}`, tRival), 404, "BILL_NOT_FOUND");
    });
    await test("the owner deletes a bill: its payments go and every debit they named is freed", async () => {
      status(await pay(bankBill.id, { amount: 1000, method: "cash" }), 201);
      const before = cleared.length;
      const r = await DEL(`/bills/${bankBill.id}`, T);
      status(r, 200);
      eq(r.body.deleted, bankBill.id);
      eq(r.body.transactions.length, 1);
      eq(r.body.transactions[0].id, linkedDebit.id);
      eq(r.body.transactions[0].matchedBillId, null);
      eq(await billNow(bankBill.id), null);
      eq(await prisma.billPayment.count({ where: { billId: bankBill.id } }), 0, "payments went with it");
      const tx = await txNow(linkedDebit.id);
      eq(tx.matchedBillId, null);
      eq(tx.matchedAmount, null);
      ok(cleared.slice(before).includes(biz.id), "ledger cleared");
      await waitFor(() => prisma.auditLog.findFirst({ where: { action: "BILL_DELETE", resourceId: bankBill.id } }), "the audit row");
      refused(await DEL(`/bills/${bankBill.id}`, T), 404, "BILL_NOT_FOUND");
    });

    // ═════════════════════════════════════════════════════════════════════════
    section("staff");
    await test("staff without canManagePayables are refused every bill door", async () => {
      for (const s of [plain, reports]) {
        const r = await GET(`/bills?businessId=${biz.id}`, s.token);
        refused(r, 403, "PERMISSION_DENIED");
        eq(r.body.permission, "canManagePayables");
        refused(await GET(`/bills/${rentBill.id}`, s.token), 403, "PERMISSION_DENIED");
        refused(await POST("/bills", s.token, { businessId: biz.id, vendorName: "X", accountId: rent.id, amount: 5 }), 403, "PERMISSION_DENIED");
        refused(await PATCH(`/bills/${rentBill.id}`, s.token, { note: "x" }), 403, "PERMISSION_DENIED");
        refused(await pay(rentBill.id, { amount: 1 }, s.token), 403, "PERMISSION_DENIED");
      }
      eq((await billNow(rentBill.id)).payments.length, 1, "nothing paid");
    });
    let staffBill;
    await test("staff with canManagePayables read, add, edit and pay in cash", async () => {
      status(await GET(`/bills?businessId=${biz.id}`, payables.token), 200);
      const r = await POST("/bills", payables.token, { businessId: biz.id, vendorName: "Staff Vendor", accountId: utility.id, amount: 4000 });
      status(r, 201);
      staffBill = r.body.bill;
      eq(staffBill.userId, owner.id, "the bill is the owner's");
      eq(staffBill.createdById, payables.user.id, "and says who added it");
      status(await PATCH(`/bills/${staffBill.id}`, payables.token, { note: "edited by staff" }), 200);
      const p = await pay(staffBill.id, { amount: 1000, method: "cash", paidThroughAccountId: cash.id }, payables.token);
      status(p, 201);
      eq(p.body.payment.createdById, payables.user.id);
    });
    await test("a KashBook payment by staff also needs canViewBalance", async () => {
      const d = await debit(biz.id, 2000, 0);
      const r = await pay(staffBill.id, { amount: 2000, method: "bank", transactionId: d.id }, payables.token);
      refused(r, 403, "PERMISSION_DENIED");
      eq(r.body.permission, "canViewBalance");
      eq((await txNow(d.id)).matchedBillId, null);
      const r2 = await pay(staffBill.id, { amount: 2000, method: "bank", transactionId: d.id }, payBank.token);
      status(r2, 201);
      eq((await txNow(d.id)).matchedBillId, staffBill.id);
    });
    await test("staff never delete a bill or a payment", async () => {
      refused(await DEL(`/bills/${staffBill.id}`, payables.token), 403, "OWNER_ONLY");
      const pid = (await billNow(staffBill.id)).payments[0].id;
      refused(await DEL(`/bills/${staffBill.id}/payments/${pid}`, payables.token), 403, "OWNER_ONLY");
    });
    await test("another owner's staff reach nothing of this business", async () => {
      status(await GET(`/bills?businessId=${biz.id}`, rivalStaff.token), 403);
      refused(await GET(`/bills/${staffBill.id}`, rivalStaff.token), 404, "BILL_NOT_FOUND");
      refused(await PATCH(`/bills/${staffBill.id}`, rivalStaff.token, { note: "x" }), 404, "BILL_NOT_FOUND");
      refused(await pay(staffBill.id, { amount: 1 }, rivalStaff.token), 404, "BILL_NOT_FOUND");
      // Their own bill can't take this business's debit either.
      const theirBill = await POST("/bills", rivalStaff.token, { businessId: rivalBiz.id, vendorName: "X", accountId: rivalRent.id, amount: 500 });
      status(theirBill, 201);
      const d = await debit(biz.id, 500, 0);
      refused(await pay(theirBill.body.bill.id, { amount: 500, method: "bank", transactionId: d.id }, rivalStaff.token), 404, "TRANSACTION_NOT_FOUND");
      eq((await txNow(d.id)).matchedBillId, null);
    });

    // ═════════════════════════════════════════════════════════════════════════
    section("a payable from before bills");
    await test("a converted one (an estimated payment kept outside the books) is paid like any bill", async () => {
      const legacy = await prisma.businessDebt.create({
        data: {
          userId: owner.id, businessId: biz.id, name: "Old Supplier", type: "supplier", originalAmount: 10000, remainingAmount: 4000,
          status: "partial", billDate: atNoon(-20), accountId: cogs.id, estimated: true,
          payments: { create: [{ amount: 6000, date: atNoon(-15), method: "other", estimated: true, outsideBooks: true }] },
        },
      });
      const r = await pay(legacy.id, { amount: 4000 });
      status(r, 201);
      eq(r.body.bill.status, "paid");
      eq(r.body.bill.estimated, true);
      // Taking back the estimated part: the bill owes it again.
      const est = r.body.bill.payments.find((p) => p.outsideBooks);
      const d = await DEL(`/bills/${legacy.id}/payments/${est.id}`, T);
      status(d, 200);
      eq(d.body.bill.balance, 6000);
      eq(d.body.bill.status, "partial");
    });
    await test("one not converted yet moves no money, but its words can change", async () => {
      const raw = await prisma.businessDebt.create({
        data: { userId: owner.id, businessId: biz.id, name: "Unconverted", originalAmount: 9000, remainingAmount: 5000, status: "partial", accountId: cogs.id },
      });
      refused(await pay(raw.id, { amount: 100 }), 409, "BILL_NOT_CONVERTED");
      refused(await PATCH(`/bills/${raw.id}`, T, { amount: 9500 }), 409, "BILL_NOT_CONVERTED");
      const n = await PATCH(`/bills/${raw.id}`, T, { note: "converted soon" });
      status(n, 200);
      eq(n.body.bill.remainingAmount, 5000, "what was paid stays as it was");
    });
    await test("a bill whose business was deleted is in no business", async () => {
      const orphan = await prisma.businessDebt.create({
        data: { userId: owner.id, businessId: null, name: "Orphan", originalAmount: 100, remainingAmount: 100, accountId: null },
      });
      refused(await GET(`/bills/${orphan.id}`, T), 404, "BILL_NOT_FOUND");
      refused(await pay(orphan.id, { amount: 1 }), 404, "BILL_NOT_FOUND");
      refused(await DEL(`/bills/${orphan.id}`, T), 404, "BILL_NOT_FOUND");
    });

    // ═════════════════════════════════════════════════════════════════════════
    section("the books lock date");
    // Made before the lock: a bill on a locked day, a bill on an open day
    // with a payment on a locked day, and a KashBook debit on a locked day.
    const lockDate = lagosDay(-2);
    const lockedBill = await newBill({ vendorName: "Locked Vendor", amount: 9000, billDate: lagosDay(-5) });
    const openBill = await newBill({ vendorName: "Open Vendor", amount: 9000, billDate: lagosDay(-1) });
    const lockedPay = await pay(openBill.id, { amount: 1000, date: lagosDay(-4) });
    status(lockedPay, 201, "payment before the lock");
    const lockedDebit = await debit(biz.id, 700, -4);
    const lockedBankBill = await newBill({ vendorName: "Bank Locked", amount: 700, billDate: lagosDay(-1) });
    await prisma.business.update({ where: { id: biz.id }, data: { booksLockDate: lockDate } });
    const isLocked = (r, what) => {
      refused(r, 409, "BOOKS_LOCKED", what);
      eq(r.body.lockDate, lockDate, `${what} lockDate`);
    };
    await test("no bill is added on or before the lock date", async () => {
      isLocked(await POST("/bills", T, { businessId: biz.id, vendorName: "X", accountId: rent.id, amount: 5, billDate: lagosDay(-3) }), "before");
      isLocked(await POST("/bills", T, { businessId: biz.id, vendorName: "X", accountId: rent.id, amount: 5, billDate: lockDate }), "on");
      status(await POST("/bills", T, { businessId: biz.id, vendorName: "X", accountId: rent.id, amount: 5, billDate: lagosDay(-1) }), 201, "after");
    });
    await test("a locked bill can't be edited or deleted, nor an open one moved into the lock", async () => {
      isLocked(await PATCH(`/bills/${lockedBill.id}`, T, { note: "x" }), "edit");
      isLocked(await PATCH(`/bills/${lockedBill.id}`, T, { billDate: lagosDay(0) }), "move out");
      isLocked(await DEL(`/bills/${lockedBill.id}`, T), "delete");
      isLocked(await PATCH(`/bills/${openBill.id}`, T, { billDate: lagosDay(-3) }), "move in");
      ok(await billNow(lockedBill.id), "still there");
    });
    await test("an edit that would change nothing is no edit, locked or not", async () => {
      // A spending bill keeps no "money received into": sending one changes nothing.
      const r = await PATCH(`/bills/${lockedBill.id}`, T, { receivedViaAccountId: cash.id, note: (await billNow(lockedBill.id)).note });
      status(r, 200);
      eq(r.body.bill.receivedViaAccountId, null);
      const lockedLoan = await prisma.businessDebt.create({
        data: { userId: owner.id, businessId: biz.id, name: "Locked Loan", originalAmount: 100, remainingAmount: 100, billDate: atNoon(-6), accountId: loans.id, type: "loan" },
      });
      isLocked(await PATCH(`/bills/${lockedLoan.id}`, T, { receivedViaAccountId: cash.id }), "a loan's money received into");
    });
    await test("a new account on an open bill is refused while a payment counts on a locked day", async () => {
      isLocked(await PATCH(`/bills/${openBill.id}`, T, { accountId: rent.id }), "account");
      status(await PATCH(`/bills/${openBill.id}`, T, { note: "words only" }), 200, "a note is fine");
      isLocked(await DEL(`/bills/${openBill.id}`, T), "delete with a locked payment");
    });
    await test("paying a locked bill today is fine; a payment on a locked day is not", async () => {
      status(await pay(lockedBill.id, { amount: 500, date: lagosDay(0) }), 201, "today");
      isLocked(await pay(lockedBill.id, { amount: 500, date: lagosDay(-3) }), "back-dated");
      isLocked(await pay(lockedBankBill.id, { amount: 700, method: "bank", transactionId: lockedDebit.id }), "a debit on a locked day");
      eq((await txNow(lockedDebit.id)).matchedBillId, null, "the debit stays free");
    });
    await test("a payment on a locked day can't be taken back; one on an open day can", async () => {
      isLocked(await DEL(`/bills/${openBill.id}/payments/${lockedPay.body.payment.id}`, T), "locked payment");
      const open = await pay(openBill.id, { amount: 100, date: lagosDay(0) });
      status(await DEL(`/bills/${openBill.id}/payments/${open.body.payment.id}`, T), 200);
    });
    await test("the estimated payment of a bill from before bills is guarded by the bill's own day", async () => {
      const legacy = await prisma.businessDebt.create({
        data: {
          userId: owner.id, businessId: biz.id, name: "Old Locked", originalAmount: 1000, remainingAmount: 400, status: "partial",
          billDate: atNoon(-9), accountId: cogs.id, estimated: true,
          payments: { create: [{ amount: 600, date: atNoon(0), method: "other", estimated: true, outsideBooks: true }] },
        },
        include: { payments: true },
      });
      isLocked(await DEL(`/bills/${legacy.id}/payments/${legacy.payments[0].id}`, T), "estimated payment");
    });
    await test("staff are held to the same lock", async () => {
      isLocked(await POST("/bills", payables.token, { businessId: biz.id, vendorName: "X", accountId: rent.id, amount: 5, billDate: lagosDay(-3) }), "staff add");
      isLocked(await PATCH(`/bills/${lockedBill.id}`, payables.token, { note: "x" }), "staff edit");
    });
    await test("the legacy sync queue is held to the lock too", async () => {
      const customer = await prisma.customer.create({ data: { userId: owner.id, businessId: biz.id, name: `Locked Customer ${tag}` } });
      const debt = await prisma.debt.create({ data: { customerId: customer.id, amount: 1000, date: atNoon(-1) } });
      const manual = await prisma.transaction.create({
        data: { businessId: biz.id, userId: owner.id, type: "expense", amount: 50, date: atNoon(-3), paymentMethod: "cash" },
      });
      const r = await POST("/sync", T, {
        queue: [
          { id: "op-tx", type: "add_transaction", data: { id: `sync-tx-${tag}`, businessId: biz.id, type: "expense", amount: 10, date: lagosDay(-3) } },
          { id: "op-debt", type: "add_debt", data: { id: `sync-debt-${tag}`, customerId: customer.id, amount: 10, date: lagosDay(-3) } },
          { id: "op-pay", type: "record_payment", data: { id: `sync-pay-${tag}`, customerId: customer.id, debtId: debt.id, amount: 10, date: lagosDay(-3) } },
          { id: "op-del", type: "delete_transaction", data: { id: manual.id } },
          { id: "op-ok", type: "record_payment", data: { id: `sync-pay-ok-${tag}`, customerId: customer.id, debtId: debt.id, amount: 10, date: lagosDay(0) } },
        ],
      });
      status(r, 200);
      const codes = Object.fromEntries(r.body.errors.map((e) => [e.id, e.code]));
      eq(codes["op-tx"], "BOOKS_LOCKED");
      eq(codes["op-debt"], "BOOKS_LOCKED");
      eq(codes["op-pay"], "BOOKS_LOCKED");
      eq(codes["op-del"], "BOOKS_LOCKED");
      ok(r.body.processed.includes("op-ok"), "an open day goes through");
      eq(await prisma.transaction.count({ where: { id: `sync-tx-${tag}` } }), 0);
      eq(await prisma.debt.count({ where: { id: `sync-debt-${tag}` } }), 0);
      eq(await prisma.debtPayment.count({ where: { id: `sync-pay-${tag}` } }), 0);
      eq(await prisma.debtPayment.count({ where: { id: `sync-pay-ok-${tag}` } }), 1);
      ok(await txNow(manual.id), "the manual row is still there");
    });
    await test("with the lock lifted, the refused changes go through", async () => {
      await prisma.business.update({ where: { id: biz.id }, data: { booksLockDate: null } });
      status(await PATCH(`/bills/${openBill.id}`, T, { accountId: rent.id }), 200);
      status(await pay(lockedBankBill.id, { amount: 700, method: "bank", transactionId: lockedDebit.id }), 201);
      status(await DEL(`/bills/${lockedBill.id}`, T), 200);
    });

    // ═════════════════════════════════════════════════════════════════════════
    section("the sync bundle");
    await test("the owner's pull carries bills with their payments, in the routes' shape; debts are gone", async () => {
      const r = await GET(`/sync?businessId=${biz.id}`, T);
      status(r, 200);
      ok(Array.isArray(r.body.bills), "bills");
      eq(r.body.debts, undefined, "the old debts key is retired");
      const b = r.body.bills.find((x) => x.id === rentBill.id);
      ok(b, "the rent bill");
      eq(b.vendorName, "Landlord Limited");
      eq(b.amount, 50000);
      eq(b.balance, 30000);
      eq(b.payments.length, 1);
      eq(b.payments[0].amount, 20000);
      ok(r.body.bills.every((x) => x.businessId === biz.id), "this business only");
    });
    await test("staff: whole bills only with canManagePayables; with the bank or the reports, only what the books read", async () => {
      eq((await GET(`/sync?businessId=${biz.id}`, plain.token)).body.bills.length, 0);
      const whole = (await GET(`/sync?businessId=${biz.id}`, payables.token)).body.bills.find((x) => x.id === rentBill.id);
      ok(whole, "granted");
      eq(whole.vendorName, "Landlord Limited");
      const forBooks = (await GET(`/sync?businessId=${biz.id}`, reports.token)).body.bills;
      const b = forBooks.find((x) => x.id === rentBill.id);
      ok(b, "the rent bill, for the books");
      // What the books read, as the whole bill has it.
      for (const k of ["accountId", "billDate", "amount", "balance", "estimated"]) eq(b[k], whole[k], k);
      assert.deepStrictEqual(b.payments.map((p) => [p.id, p.amount, p.date, p.method, p.transactionId, p.outsideBooks]),
        whole.payments.map((p) => [p.id, p.amount, p.date, p.method, p.transactionId, p.outsideBooks]));
      // Nothing of the Bills screen: no supplier, number, notes or people.
      eq(b.vendorName, "");
      eq(b.name, "");
      eq(b.billNumber, null);
      eq(b.note, null);
      for (const k of ["userId", "createdById", "type", "reminderEnabled"]) eq(b[k], undefined, k);
      ok(b.payments.every((p) => p.note === null && p.createdById === undefined), "payments without notes or people");
    });
    await test("staff with the reports but not the bank: a payment from the KashBook account reads as a transfer, without its debit", async () => {
      const reportsOnly = await staffOf(owner, "reportsonly", { canViewReports: true });
      const d = await debit(biz.id, 3000, 0);
      const b = await newBill({ vendorName: "Hidden Debit Ltd", amount: 3000 });
      status(await pay(b.id, { amount: 3000, method: "bank", transactionId: d.id }), 201);
      const pull = await GET(`/sync?businessId=${biz.id}`, reportsOnly.token);
      eq(pull.body.bankWithheld, true);
      const got = pull.body.bills.find((x) => x.id === b.id);
      ok(got, "the bill, for the books");
      eq(got.payments.length, 1);
      eq(got.payments[0].transactionId, null);
      eq(got.payments[0].method, "transfer");
      eq(got.payments[0].amount, 3000);
      eq(JSON.stringify(pull.body).includes(d.id), false, "the debit's id nowhere in the bundle");
      eq(JSON.stringify(pull.body).includes("Hidden Debit"), false, "nor the supplier");
      // A member who sees the bank rows gets the link, as the owner does.
      const withBank = (await GET(`/sync?businessId=${biz.id}`, reports.token)).body.bills.find((x) => x.id === b.id);
      eq(withBank.payments[0].transactionId, d.id);
      eq(withBank.payments[0].method, "bank");
      // Staff with bills but not the bank: the whole bill, its payment from
      // the KashBook account as such, but no debit id (routes and sync).
      const viaRoute = (await GET(`/bills/${b.id}`, payables.token)).body.bill;
      const viaList = (await GET(`/bills?businessId=${biz.id}`, payables.token)).body.bills.find((x) => x.id === b.id);
      const viaSync = (await GET(`/sync?businessId=${biz.id}`, payables.token)).body.bills.find((x) => x.id === b.id);
      for (const [where, got] of [["route", viaRoute], ["list", viaList], ["sync", viaSync]]) {
        eq(got.vendorName, "Hidden Debit Ltd", `${where}: the bill is theirs to read`);
        eq(got.payments[0].method, "bank", `${where}: paid from the KashBook account`);
        eq(got.payments[0].amount, 3000, where);
        eq(got.payments[0].transactionId, null, `${where}: no debit id`);
      }
      eq((await GET(`/bills/${b.id}`, payBank.token)).body.bill.payments[0].transactionId, d.id, "bills + bank staff get it");
      eq((await GET(`/bills/${b.id}`, T)).body.bill.payments[0].transactionId, d.id, "the owner gets it");
    });
    await test("published adjustments go to members with the reports, whole on every pull; drafts never", async () => {
      const line = (accountId, debit, credit, position) => ({ accountId, debit, credit, position });
      const posted = await prisma.manualJournal.create({
        data: {
          businessId: biz.id, number: `MJ-S${tag}`.slice(0, 20), date: new Date(`${lagosDay(0)}T00:00:00Z`), status: "published",
          lines: { create: [line(rent.id, 1200, 0, 0), line(cash.id, 0, 1200, 1)] },
        },
      });
      const draft = await prisma.manualJournal.create({
        data: {
          businessId: biz.id, number: `MJ-D${tag}`.slice(0, 20), date: new Date(`${lagosDay(0)}T00:00:00Z`), status: "draft",
          lines: { create: [line(rent.id, 900, 0, 0), line(cash.id, 0, 900, 1)] },
        },
      });
      try {
        const first = await GET(`/sync?businessId=${biz.id}`, T);
        const mine = first.body.journals.find((j) => j.id === posted.id);
        ok(mine, "the published one");
        assert.deepStrictEqual(mine.lines.map((l) => [l.accountId, l.debit, l.credit]), [[rent.id, 1200, 0], [cash.id, 0, 1200]]);
        ok(!first.body.journals.some((j) => j.id === draft.id), "no draft");
        // An incremental pull still carries every published one.
        const later = await GET(`/sync?businessId=${biz.id}&since=${encodeURIComponent(first.body.syncedAt)}`, T);
        ok(later.body.journals.some((j) => j.id === posted.id), "whole on an incremental pull");
        ok((await GET(`/sync?businessId=${biz.id}`, reports.token)).body.journals.some((j) => j.id === posted.id), "reports staff");
        eq((await GET(`/sync?businessId=${biz.id}`, plain.token)).body.journals, null, "not the plain staff's");
        eq((await GET(`/sync?businessId=${biz.id}`, payables.token)).body.journals, null, "bills alone do not open them");
      } finally {
        await prisma.manualJournal.deleteMany({ where: { id: { in: [posted.id, draft.id] } } });
      }
    });
    await test("an incremental pull carries a bill whose payments changed", async () => {
      const first = await GET(`/sync?businessId=${biz.id}`, T);
      const since = first.body.syncedAt;
      await sleep(20);
      const p = await pay(rentBill.id, { amount: 500 });
      status(p, 201);
      const next = await GET(`/sync?businessId=${biz.id}&since=${encodeURIComponent(since)}`, T);
      const b = next.body.bills.find((x) => x.id === rentBill.id);
      ok(b, "the bill came");
      eq(b.payments.length, 2);
      eq(b.balance, 29500);
      const since2 = next.body.syncedAt;
      await sleep(20);
      status(await DEL(`/bills/${rentBill.id}/payments/${p.body.payment.id}`, T), 200);
      const third = await GET(`/sync?businessId=${biz.id}&since=${encodeURIComponent(since2)}`, T);
      const b2 = third.body.bills.find((x) => x.id === rentBill.id);
      ok(b2, "the bill came again");
      eq(b2.payments.length, 1);
      eq(b2.balance, 30000);
    });
    await test("the legacy payable doors are closed", async () => {
      const pull = await GET(`/sync/pull?businessId=${biz.id}`, T);
      status(pull, 200);
      eq(pull.body.payables, undefined, "no payables key");
      const before = await prisma.payable.count();
      const q = await POST("/sync", T, {
        queue: [{ id: "op-payable", type: "add_payable", data: { id: `payable-${tag}`, businessId: biz.id, creditorName: "X", amount: 5, date: lagosDay(0) } }],
      });
      status(q, 200);
      eq(q.body.processed.length, 0);
      eq(q.body.errors[0].code, "SYNC_OP_FAILED", "an unknown op");
      eq(await prisma.payable.count(), before, "nothing written");
    });

    // ═════════════════════════════════════════════════════════════════════════
    section("Insights: who do I owe?");
    await test("open bills by vendor, largest first, with the overdue ones", async () => {
      const B = await prisma.business.create({ data: { userId: owner.id, name: `Owe ${tag}`, country: "NG", baseCurrency: "NGN" } });
      await ensureChart(B.id);
      const bc = await chartOf(B.id);
      const mk = (name, original, remaining, due, status) => prisma.businessDebt.create({
        data: {
          userId: owner.id, businessId: B.id, name, originalAmount: original, remainingAmount: remaining,
          status: status || (remaining < original ? "partial" : "unpaid"), dueDate: due, accountId: bc.cat("rent").id,
        },
      });
      await mk("Landlord", 100000, 100000, atNoon(-3));
      await mk("landlord ", 5000, 2500, atNoon(5));
      await mk("Diesel Man", 30000, 30000, null);
      await mk("Paid Off", 9000, 0, atNoon(-30), "paid");
      const r = await answerQuestion("who do i owe", B, null, { canManagePayables: true });
      eq(r.intent, "payables");
      eq(r.data.total, 132500);
      eq(r.data.count, 3);
      eq(r.data.overdue, 1);
      eq(r.data.vendors[0].name, "Landlord");
      eq(r.data.vendors[0].owed, 102500);
      eq(r.data.vendors[0].bills, 2);
      eq(r.data.vendors[1].name, "Diesel Man");
      ok(/₦132,500/.test(r.answer) && /Landlord/.test(r.answer) && /1 is overdue/.test(r.answer), r.answer);
      ok(!/Paid Off/.test(r.answer), "a paid bill is left out");
    });
    await test("an asker without canManagePayables gets no vendor and no figure, and that is the default", async () => {
      for (const opts of [{ canManagePayables: false }, {}, undefined]) {
        const r = await answerQuestion("how much do i owe", biz, null, opts);
        eq(r.intent, "payables");
        eq(r.data, undefined);
        ok(!/\d/.test(r.answer), r.answer);
      }
    });
    await test("nothing open: nobody is owed", async () => {
      const B = await prisma.business.create({ data: { userId: owner.id, name: `Owe none ${tag}`, country: "NG", baseCurrency: "NGN" } });
      const r = await answerQuestion("who do i owe", B, null, { canManagePayables: true });
      ok(/don't owe anyone/.test(r.answer), r.answer);
    });

    // ═════════════════════════════════════════════════════════════════════════
    section("bookkeeping");
    await test("every bill and payment left the database consistent", async () => {
      const all = await prisma.businessDebt.findMany({
        where: { businessId: biz.id, OR: [{ estimated: false }, { payments: { some: {} } }] },
        include: { payments: true },
      });
      for (const bill of all) {
        if (bill.name === "Unconverted") continue;
        const paidK = bill.payments.reduce((s, p) => s + Math.round(p.amount * 100), 0);
        eq(Math.round(bill.originalAmount * 100) - Math.round(bill.remainingAmount * 100), paidK, `${bill.name}: what is paid is its payments`);
        const want = paidK >= Math.round(bill.originalAmount * 100) ? "paid" : paidK > 0 ? "partial" : "unpaid";
        eq(bill.status, want, `${bill.name}: status`);
        for (const p of bill.payments.filter((x) => x.transactionId)) {
          const tx = await txNow(p.transactionId);
          eq(tx.matchedBillId, bill.id, `${bill.name}: its debit names it`);
          eq(tx.matchedAmount, p.amount, `${bill.name}: and carries the payment`);
        }
      }
      const linked = await prisma.transaction.findMany({ where: { businessId: biz.id, matchedBillId: { not: null } } });
      for (const tx of linked) {
        eq(await prisma.billPayment.count({ where: { transactionId: tx.id, billId: tx.matchedBillId } }), 1, `debit ${tx.id} has its payment`);
      }
    });

    // ═════════════════════════════════════════════════════════════════════════
    // Last, so a gap there leaves the checks above alone. These are the
    // transaction routes' (routes/transactions.js) side of the debit link.
    section("the transaction routes and a debit a bill payment carries");
    if (txRouterError) {
      await test("routes/transactions.js loads", async () => { throw txRouterError; });
    } else {
      const b = await newBill({ amount: 5000 });
      const d = await debit(biz.id, 5000, 0);
      status(await pay(b.id, { amount: 3000, method: "bank", transactionId: d.id }), 201, "linked");
      await test("create-expense refuses a debit a bill payment carries (it would count twice)", async () => {
        const r = await POST(`/transactions/${d.id}/create-expense`, T, { category: "rent" });
        status(r, 409, "create-expense");
        const tx = await txNow(d.id);
        eq(tx.matchedExpenseId, null);
        eq(tx.matchedAmount, 3000);
      });
      await test("categorize refuses a debit a bill payment carries", async () => {
        const r = await POST(`/transactions/${d.id}/categorize`, T, { accountId: rent.id });
        status(r, 409, "categorize");
        eq((await txNow(d.id)).accountId, null);
      });
    }
  } finally {
    server.close();
    await prisma.$disconnect();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failures.length) console.log(`failed:\n  - ${failures.join("\n  - ")}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
