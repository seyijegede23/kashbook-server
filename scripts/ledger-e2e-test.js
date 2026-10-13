// The chart of accounts end to end (release 1, 2026-10-11): real routers over
// HTTP, real Postgres, real login tokens. The chart is set up once and only
// grows; accounts on expenses, sales and bank rows change what the books
// count; the KashBook Account equals the bank ledger; the reports balance and
// tie out to the books rule; an expense deleted after being recorded from a
// transfer frees it; opening balances; who may see and change what. Itemized
// expenses (2026-10-12, lines written straight to the database here; the
// expense routes have their own e2e): counted line by line, carried by the
// sync bundle without receipt storage keys, broken down by Insights as the
// ledger books them, and kept by account usage, merge and delete. Integration
// fixes (2026-10-12): the starting balances' difference counts every account,
// an account holding a starting balance can't rest, the ledger cache never
// keeps a build a write overtook, and a record changed during a pull reaches
// the next one. Review fixes (2026-10-12): a deleted or merged category
// account stays gone, its category going to the account it merged into;
// Retained Earnings holds past years' profit, with a line a year on its
// statement; the Accounting home's You owe leaves unexplained transfers out
// and its Owed to you is Reports' figure. Release 1.1 (2026-10-13): whatever
// an older app sends, a category merged into another account counts there (a
// chain of merges too), and the category of a deleted account, or of one made
// another kind, makes no account again until the owner makes one on purpose.
// Release 2 (2026-10-13; bills, payments and journals written straight to
// the database here, their routes have their own e2e): the general ledger
// lists every entry of a period in reading order, balanced, without moving
// anything in the shared cached ledger; You owe counts the open bills; a
// bill, a payment or a journal line keeps its account in use, and a merge
// moves them (never into an account the engine keeps, and a line written
// meanwhile fails it cleanly); starting balances never land on or leave a
// locked day; the backfill, one owner at a time.
//
//   TEST_DATABASE_URL=postgresql://postgres:<pw>@localhost:5432/kashbook_coa_e2e \
//     node scripts/ledger-e2e-test.js
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
const { booksFor, lagosStart, lagosEnd, receivablesFor } = require("../src/utils/booksData");
const { computeRawLedger } = require("../src/utils/ledgerBalance");
const { ensureChart, invalidateOwner, invalidateLedger, loadLedger } = require("../src/utils/ledgerData");
const { spendingByAccount } = require("../src/utils/insightsEngine");
const chart = require("../src/utils/chart");

const app = express();
app.use(express.json());
// As server.js does: a successful write clears the owner's cached ledgers.
app.use((req, res, next) => {
  if (req.method !== "GET") res.on("finish", () => res.statusCode < 400 && req.user && invalidateOwner(req.user.accountType === "staff" ? req.user.employerId : req.user.id));
  next();
});
app.use("/ledger", require("../src/routes/ledger"));
app.use("/sales", require("../src/routes/sales"));
app.use("/expenses", require("../src/routes/expenses"));
app.use("/transactions", require("../src/routes/transactions"));
app.use("/sync", require("../src/routes/sync"));
// An older app puts its custom categories back with the business (PATCH /businesses/:id).
app.use("/businesses", require("../src/routes/businesses"));

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
        try { j = JSON.parse(d); } catch { /* empty */ }
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
const section = (s) => console.log(`\n── ${s}`);
const tag = Date.now().toString(36);
const today = new Date(Date.now() + 3600000).toISOString().slice(0, 10);

(async () => {
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  BASE = `http://127.0.0.1:${server.address().port}`;
  console.log(`\nCHART OF ACCOUNTS — END TO END\n${BASE}`);

  const mkUser = (data) => prisma.user.create({
    data: { password: "x", lastName: "T", businessName: "B", country: "NG", currency: "NGN", ...data },
  });
  const owner = await mkUser({ email: `coa-${tag}@t.local`, firstName: "Ada", accountType: "OWNER" });
  const rival = await mkUser({ email: `coa-rival-${tag}@t.local`, firstName: "Rival", accountType: "OWNER" });
  const biz = await prisma.business.create({ data: { userId: owner.id, name: `Coa ${tag}`, country: "NG", baseCurrency: "NGN" } });
  const rivalBiz = await prisma.business.create({ data: { userId: rival.id, name: `Rival ${tag}`, country: "NG", baseCurrency: "NGN" } });
  const T = signToken({ userId: owner.id, tokenVersion: 0 });
  const staffWith = async (name, grants) => {
    const s = await mkUser({ email: `coa-${name}-${tag}@t.local`, firstName: name, accountType: "STAFF", employerId: owner.id });
    await prisma.staffPermission.create({ data: { userId: s.id, employerId: owner.id, grantedById: owner.id, ...grants } });
    return signToken({ userId: s.id, tokenVersion: 0 });
  };
  const tPlain = await staffWith("plain", {});
  const tReports = await staffWith("reports", { canViewReports: true });
  const tBoth = await staffWith("both", { canViewReports: true, canViewBalance: true });
  const q = `businessId=${biz.id}`;
  let accounts = [];
  const byName = (name) => accounts.find((a) => a.name === name);
  const bySys = (k) => accounts.find((a) => a.systemKey === k);
  const refreshAccounts = async () => {
    const r = await call("GET", `/ledger/accounts?${q}`, T);
    accounts = r.body.accounts;
    return r;
  };
  const bankRow = (data) => prisma.transaction.create({
    data: {
      businessId: biz.id, date: new Date(), paymentMethod: "bank", category: "transfer", source: "anchor", currency: "NGN",
      description: "test", ...data,
    },
  });

  try {
    section("The chart is set up once, and only grows");
    await test("the first look seeds Zoho's default chart, adapted for a Nigerian shop", async () => {
      const r = await refreshAccounts();
      eq(r.status, 200, JSON.stringify(r.body));
      eq(accounts.length, chart.DEFAULT_CHART.length, "seeded accounts");
      for (const k of Object.values(chart.SYS)) assert.ok(bySys(k), `system account ${k}`);
      eq(byName("Rent").categorySlug, "rent");
      eq(bySys("kashbook").controlled, true, "the KashBook Account is controlled");
    });
    await test("five set-ups at once leave one chart", async () => {
      await Promise.all([1, 2, 3, 4, 5].map(() => ensureChart(biz.id)));
      eq(await prisma.ledgerAccount.count({ where: { businessId: biz.id } }), chart.DEFAULT_CHART.length);
    });
    await test("a custom category and an older free-text category get their own accounts", async () => {
      await prisma.customCategory.create({ data: { businessId: biz.id, label: "Hair products", value: "hair-products" } });
      await prisma.expense.create({ data: { userId: owner.id, businessId: biz.id, category: "Diesel", amount: 100, date: new Date() } });
      await prisma.expense.create({ data: { userId: owner.id, businessId: biz.id, category: "ọjà-items", amount: 100, date: new Date() } });
      await refreshAccounts();
      assert.ok(byName("Hair products"), "custom category account");
      eq(byName("Hair products").categorySlug, "hair-products");
      assert.ok(byName("Ọjà Items"), "free-text category account");
      assert.ok(!byName("Diesel"), "diesel is an alias of Fuel and Generator");
    });
    await test("a deleted default does not come back", async () => {
      const lodging = byName("Lodging");
      eq((await call("DELETE", `/ledger/accounts/${lodging.id}`, T)).status, 204);
      await ensureChart(biz.id);
      await refreshAccounts();
      assert.ok(!byName("Lodging"), "stayed deleted");
    });

    section("The owner's changes");
    await test("a new account: types the system keeps are refused, names and codes are unique", async () => {
      eq((await call("POST", "/ledger/accounts", T, { businessId: biz.id, type: "accounts_receivable", name: "AR 2" })).body.code, "BAD_TYPE");
      eq((await call("POST", "/ledger/accounts", T, { businessId: biz.id, type: "expense", name: "rent" })).status, 409, "name taken (any case)");
      const r = await call("POST", "/ledger/accounts", T, { businessId: biz.id, type: "expense", name: "Shop Security", code: "6801" });
      eq(r.status, 201, JSON.stringify(r.body));
      eq(r.body.categorySlug, "shop-security");
      eq((await call("POST", "/ledger/accounts", T, { businessId: biz.id, type: "fixed_asset", name: "Freezer", code: "6801" })).body.code, "CODE_TAKEN");
      await refreshAccounts();
    });
    await test("system accounts can be renamed, never deactivated or deleted", async () => {
      const rent = byName("Rent");
      eq((await call("PATCH", `/ledger/accounts/${bySys("sales").id}`, T, { name: "Shop Sales" })).status, 200);
      eq((await call("PATCH", `/ledger/accounts/${bySys("sales").id}`, T, { inactive: true })).body.code, "SYSTEM_ACCOUNT");
      eq((await call("DELETE", `/ledger/accounts/${bySys("sales").id}`, T)).body.code, "SYSTEM_ACCOUNT");
      eq((await call("PATCH", `/ledger/accounts/${rent.id}`, T, { inactive: true })).status, 200, "a category account may rest");
      eq((await call("PATCH", `/ledger/accounts/${rent.id}`, T, { inactive: false })).status, 200);
      await call("PATCH", `/ledger/accounts/${bySys("sales").id}`, T, { name: "Sales" });
      await refreshAccounts();
    });
    await test("staff can read the chart but never change it", async () => {
      eq((await call("GET", `/ledger/accounts?${q}`, tPlain)).status, 200);
      eq((await call("POST", "/ledger/accounts", tBoth, { businessId: biz.id, type: "expense", name: "Staff One" })).body.code, "OWNER_ONLY");
    });
    await test("another owner's chart is not reachable", async () => {
      eq((await call("GET", `/ledger/accounts?businessId=${rivalBiz.id}`, T)).status, 404);
    });

    section("Accounts on records change what the books count");
    let furnitureExpense;
    await test("an expense on equipment is not spending; on Rent it is", async () => {
      const before = (await booksFor(biz.id, { from: today, to: today })).expenses.total;
      const f = await call("POST", "/expenses", T, { businessId: biz.id, amount: 85000, accountId: byName("Furniture and Equipment").id, date: today });
      eq(f.status, 201, JSON.stringify(f.body));
      furnitureExpense = f.body;
      const r = await call("POST", "/expenses", T, { businessId: biz.id, amount: 20000, accountId: byName("Rent").id, date: today, category: "anything" });
      eq(r.body.category, "rent", "the account's category, for older apps");
      const after = (await booksFor(biz.id, { from: today, to: today })).expenses.total;
      eq(Math.round((after - before) * 100) / 100, 20000);
    });
    await test("an expense can't name an income account or another business's account", async () => {
      eq((await call("POST", "/expenses", T, { businessId: biz.id, amount: 10, accountId: bySys("sales").id })).body.code, "ACCOUNT_NOT_ALLOWED");
      const rivalAcc = (await call("GET", `/ledger/accounts?businessId=${rivalBiz.id}`, signToken({ userId: rival.id, tokenVersion: 0 }))).body.accounts[0];
      eq((await call("POST", "/expenses", T, { businessId: biz.id, amount: 10, accountId: rivalAcc.id })).body.code, "ACCOUNT_NOT_FOUND");
    });
    await test("a retried create returns the first record (sales and expenses)", async () => {
      const body = { businessId: biz.id, amount: 3000, clientRef: `retry-${tag}`, date: today };
      const a = await call("POST", "/sales", T, body);
      const b = await call("POST", "/sales", T, body);
      eq(a.status, 201);
      eq(b.status, 200);
      eq(b.body.id, a.body.id);
      const e1 = await call("POST", "/expenses", T, { ...body, clientRef: `retry-e-${tag}` });
      const e2 = await call("POST", "/expenses", T, { ...body, clientRef: `retry-e-${tag}` });
      eq(e2.body.id, e1.body.id);
    });

    section("Bank rows explained with any account");
    let ownerMoney;
    let drawings;
    let interest;
    await test("a credit called the owner's money counts nowhere; drawings neither; interest is income without VAT", async () => {
      ownerMoney = await bankRow({ type: "income", amount: 500000 });
      drawings = await bankRow({ type: "expense", amount: 40000, fee: 53.75 });
      interest = await bankRow({ type: "income", amount: 1200 });
      const before = await booksFor(biz.id, { from: today, to: today });
      const a = await call("POST", `/transactions/${ownerMoney.id}/categorize`, tBoth, { accountId: bySys("owner_equity").id });
      eq(a.body.code, "OWNER_ONLY", "the owner's own money is the owner's to say");
      eq((await call("POST", `/transactions/${ownerMoney.id}/categorize`, T, { accountId: bySys("owner_equity").id })).body.transaction.purpose, "owner_money");
      eq((await call("POST", `/transactions/${drawings.id}/categorize`, T, { accountId: bySys("drawings").id })).body.transaction.purpose, "account");
      const i = await call("POST", `/transactions/${interest.id}/categorize`, T, { accountId: byName("Interest Income").id });
      eq(i.body.transaction.purpose, null, "income stays counted");
      const after = await booksFor(biz.id, { from: today, to: today });
      eq(Math.round((after.sales.total - before.sales.total) * 100) / 100, -500000, "the owner's money left sales");
      eq(Math.round((after.expenses.total - before.expenses.total) * 100) / 100, -40000, "drawings left spending (its fee did not)");
    });
    await test("a debit can't be called income", async () => {
      eq((await call("POST", `/transactions/${drawings.id}/categorize`, T, { accountId: bySys("sales").id })).body.code, "ACCOUNT_NOT_ALLOWED");
    });

    section("An expense recorded from a transfer, then deleted");
    await test("the transfer is freed and counts again", async () => {
      const debit = await bankRow({ type: "expense", amount: 15000 });
      const made = await call("POST", `/transactions/${debit.id}/create-expense`, T, { category: "transport" });
      eq(made.status, 201, JSON.stringify(made.body));
      const mid = await booksFor(biz.id, { from: today, to: today });
      eq((await call("DELETE", `/expenses/${made.body.expense.id}`, T)).status, 200);
      const freed = await prisma.transaction.findUnique({ where: { id: debit.id } });
      eq(freed.matchedExpenseId, null, "unmatched");
      eq(freed.matchedAmount, null);
      const after = await booksFor(biz.id, { from: today, to: today });
      eq(after.expenses.total, mid.expenses.total, "the money still counts once, now on the transfer");
    });

    section("Itemized expenses");
    // Written as routes/expenses.js saves one: the amount is the lines' sum, no
    // account of its own, the first line's category. Lines are inserted out of
    // order to show that everything reads them by position.
    const itemized = (data, lines) => prisma.expense.create({
      data: {
        userId: owner.id, businessId: biz.id, paymentMethod: "cash", date: new Date(), accountId: null,
        amount: lines.reduce((s, l) => s + Math.round(l.amount * 100), 0) / 100,
        category: [...lines].sort((a, b) => a.position - b.position)[0].category,
        ...data,
        items: { create: lines },
      },
      include: { items: true },
    });
    let split;
    await test("an itemized expense counts its spending lines only; the generator is not spending", async () => {
      const views = ["paid", "sold"];
      const before = {};
      for (const basis of views) before[basis] = (await booksFor(biz.id, { from: today, to: today, basis })).expenses.total;
      split = await itemized({ reference: "INV-2231" }, [
        { accountId: byName("Shop Security").id, category: "shop-security", amount: 3000, position: 2 },
        { accountId: byName("Rent").id, category: "rent", amount: 20000, position: 0, description: "October rent" },
        { accountId: byName("Generators and Power Equipment").id, category: "other", amount: 50000, position: 1, description: "Generator" },
      ]);
      invalidateOwner(owner.id);
      eq(split.amount, 73000);
      eq(split.category, "rent", "the first line's category, for older apps");
      for (const basis of views) {
        const after = (await booksFor(biz.id, { from: today, to: today, basis })).expenses.total;
        eq(Math.round((after - before[basis]) * 100) / 100, 23000, `${basis}: rent and security, not the generator`);
      }
    });
    await test("each line is an entry of its own; the whole amount leaves Cash at Hand", async () => {
      const gen = split.items.find((it) => it.description === "Generator");
      const st = await call("GET", `/ledger/accounts/${byName("Generators and Power Equipment").id}/transactions?${q}`, T);
      eq(st.status, 200, JSON.stringify(st.body));
      eq(st.body.lines.find((l) => l.id === `expense:${split.id}:${gen.id}`).amount, 50000);
      const cash = await call("GET", `/ledger/accounts/${bySys("cash").id}/transactions?${q}`, T);
      const mine = cash.body.lines.filter((l) => l.ref === split.id);
      eq(mine.length, 3, "three entries");
      eq(mine.reduce((s, l) => s + l.amount, 0), -73000, "the whole amount");
      eq(mine.some((l) => l.id === `expense:${split.id}`), false, "no entry for the expense as a whole");
    });
    await test("the sync bundle carries the lines in their order, and receipts without their storage keys", async () => {
      const withReceipt = await itemized({
        attachments: [{
          id: "r1", name: "Receipt", mime: "image/jpeg", size: 2048, uploadedAt: new Date().toISOString(),
          publicId: `kashbook/receipts/never-sent-${tag}`, resourceType: "image",
        }],
      }, [{ accountId: byName("Rent").id, category: "rent", amount: 100, position: 0 }]);
      invalidateOwner(owner.id);
      for (const token of [T, tPlain]) {
        const s = await call("GET", `/sync?${q}`, token);
        eq(s.status, 200);
        const x = s.body.expenses.find((e) => e.id === split.id);
        assert.deepStrictEqual(x.items.map((it) => it.position), [0, 1, 2]);
        assert.deepStrictEqual(x.items.map((it) => it.description), ["October rent", "Generator", null]);
        eq(x.reference, "INV-2231");
        assert.deepStrictEqual(x.attachments, [], "no receipts: an empty list");
        const r = s.body.expenses.find((e) => e.id === withReceipt.id);
        assert.deepStrictEqual(Object.keys(r.attachments[0]).sort(), ["id", "mime", "name", "size", "uploadedAt"]);
        const raw = JSON.stringify(s.body);
        assert.ok(!raw.includes("publicId") && !raw.includes("resourceType") && !raw.includes("never-sent"), "no storage key anywhere");
        assert.deepStrictEqual(s.body.expenses.find((e) => e.id === furnitureExpense.id).items, [], "a whole expense has no lines");
      }
    });

    section("The ledger ties out");
    await test("the KashBook Account equals the bank ledger", async () => {
      const r = await call("GET", `/ledger/balances?${q}`, T);
      eq(r.status, 200, JSON.stringify(r.body));
      const kb = r.body.balances.find((b) => b.accountId === bySys("kashbook").id).balance;
      eq(Math.round(kb * 100), Math.round((await computeRawLedger(biz.id, "NGN")) * 100));
    });
    await test("profit and loss by account equals the books rule", async () => {
      for (const basis of ["paid", "sold"]) {
        const pl = await call("GET", `/ledger/reports/profit-and-loss?${q}&basis=${basis}&from=${today}&to=${today}`, T);
        const b = await booksFor(biz.id, { from: today, to: today, basis });
        eq(Math.round(pl.body.totalIncome * 100), Math.round(b.sales.total * 100), `${basis} income`);
        eq(Math.round(pl.body.totalExpenses * 100), Math.round(b.expenses.total * 100), `${basis} expenses`);
      }
    });
    await test("the balance sheet and the trial balance balance", async () => {
      const bs = await call("GET", `/ledger/reports/balance-sheet?${q}`, T);
      eq(bs.body.balanced, true, JSON.stringify(bs.body.totals));
      const tb = await call("GET", `/ledger/reports/trial-balance?${q}`, T);
      eq(tb.body.balanced, true);
    });
    await test("an account's statement runs to its balance", async () => {
      const furniture = byName("Furniture and Equipment");
      const st = await call("GET", `/ledger/accounts/${furniture.id}/transactions?${q}`, T);
      eq(st.status, 200);
      eq(st.body.closing, 85000);
      eq(st.body.lines.find((l) => l.id === `expense:${furnitureExpense.id}`).amount, 85000);
    });

    section("Opening balances");
    await test("starting cash sets Cash at Hand without touching profit", async () => {
      const cash = bySys("cash");
      const before = await call("GET", `/ledger/reports/profit-and-loss?${q}&basis=paid`, T);
      const put = await call("PUT", "/ledger/opening-balances", T, { businessId: biz.id, date: "2026-01-01", lines: [{ accountId: cash.id, debit: 25000, credit: 0 }] });
      eq(put.status, 200, JSON.stringify(put.body));
      const st = await call("GET", `/ledger/accounts/${cash.id}/transactions?${q}&from=2026-01-01&to=2026-01-01`, T);
      eq(st.body.closing, 25000, "cash at the start of the books");
      const after = await call("GET", `/ledger/reports/profit-and-loss?${q}&basis=paid`, T);
      eq(after.body.profit, before.body.profit, "profit untouched");
      eq((await call("GET", `/ledger/reports/balance-sheet?${q}`, T)).body.balanced, true);
    });
    await test("the KashBook Account, a future day and staff are refused", async () => {
      eq((await call("PUT", "/ledger/opening-balances", T, { businessId: biz.id, date: "2026-01-01", lines: [{ accountId: bySys("kashbook").id, debit: 5, credit: 0 }] })).body.code, "ACCOUNT_NOT_ALLOWED");
      eq((await call("PUT", "/ledger/opening-balances", T, { businessId: biz.id, date: "2999-01-01", lines: [] })).body.code, "BAD_DATE");
      eq((await call("PUT", "/ledger/opening-balances", tBoth, { businessId: biz.id, date: "2026-01-01", lines: [] })).body.code, "OWNER_ONLY");
    });
    await test("any amount in naira and kobo is taken (₦2,500.55, ₦1,234,567.89); a third decimal is refused", async () => {
      const cash = bySys("cash");
      const prepaid = byName("Prepaid Expenses");
      const put = await call("PUT", "/ledger/opening-balances", T, {
        businessId: biz.id, date: "2026-01-01",
        lines: [{ accountId: cash.id, debit: 2500.55, credit: 0 }, { accountId: prepaid.id, debit: "1234567.89", credit: 0 }],
      });
      eq(put.status, 200, JSON.stringify(put.body));
      const stored = new Map((await prisma.openingBalance.findMany({ where: { businessId: biz.id } })).map((o) => [o.accountId, o.debit]));
      eq(stored.get(cash.id), 2500.55);
      eq(stored.get(prepaid.id), 1234567.89);
      const st = await call("GET", `/ledger/accounts/${cash.id}/transactions?${q}&from=2026-01-01&to=2026-01-01`, T);
      eq(st.body.closing, 2500.55, "cash at the start of the books, to the kobo");
      const third = await call("PUT", "/ledger/opening-balances", T, { businessId: biz.id, date: "2026-01-01", lines: [{ accountId: cash.id, debit: 10.005, credit: 0 }] });
      eq(third.body.code, "BAD_AMOUNT");
      // Back to the starting cash the checks above set.
      eq((await call("PUT", "/ledger/opening-balances", T, { businessId: biz.id, date: "2026-01-01", lines: [{ accountId: cash.id, debit: 25000, credit: 0 }] })).status, 200);
    });
    // The starting cash the checks above set, put back after each check below.
    const startingCash = () => ({ businessId: biz.id, date: "2026-01-01", lines: [{ accountId: bySys("cash").id, debit: 25000, credit: 0 }] });
    await test("starting balances on several accounts: the difference is every account's, not the first one's", async () => {
      try {
        const put = await call("PUT", "/ledger/opening-balances", T, {
          businessId: biz.id, date: "2026-01-01",
          lines: [
            { accountId: bySys("cash").id, debit: 25000, credit: 0 },
            { accountId: byName("Prepaid Expenses").id, debit: 1000, credit: 0 },
            { accountId: bySys("loans").id, debit: 0, credit: 5000 },
          ],
        });
        eq(put.status, 200, JSON.stringify(put.body));
        // Nothing in these books is dated before the day they start, so each
        // account's whole starting balance goes to the difference: 25,000 and
        // 1,000 owned, 5,000 owed.
        eq(put.body.adjustment, 21000, "on saving");
        eq((await call("GET", `/ledger/opening-balances?${q}`, T)).body.adjustment, 21000, "read back");
        const held = (await call("GET", `/ledger/balances?${q}`, T)).body.balances.find((b) => b.accountId === bySys("opening_balance_adj").id);
        eq(held.balance, 21000, "what Opening Balance Adjustments holds");
        eq((await call("GET", `/ledger/reports/balance-sheet?${q}`, T)).body.balanced, true);
      } finally {
        await call("PUT", "/ledger/opening-balances", T, startingCash());
      }
    });
    await test("an account holding a starting balance can't rest until the balance is cleared", async () => {
      const prepaid = byName("Prepaid Expenses");
      const both = {
        businessId: biz.id, date: "2026-01-01",
        lines: [{ accountId: bySys("cash").id, debit: 25000, credit: 0 }, { accountId: prepaid.id, debit: 1000, credit: 0 }],
      };
      try {
        eq((await call("PUT", "/ledger/opening-balances", T, both)).status, 200);
        const off = await call("PATCH", `/ledger/accounts/${prepaid.id}`, T, { inactive: true });
        eq(off.status, 409, JSON.stringify(off.body));
        eq(off.body.code, "IN_USE_OPENING");
        eq(off.body.error, "This account has a starting balance. Clear it in Starting balances first.");
        eq((await prisma.ledgerAccount.findUnique({ where: { id: prepaid.id } })).inactiveAt, null, "still active");
        eq((await call("PUT", "/ledger/opening-balances", T, both)).status, 200, "starting balances still save");
        eq((await call("PATCH", `/ledger/accounts/${prepaid.id}`, T, { description: "Rent paid ahead", inactive: false })).status, 200, "other changes go through");
        eq((await call("PUT", "/ledger/opening-balances", T, startingCash())).status, 200, "cleared");
        eq((await call("PATCH", `/ledger/accounts/${prepaid.id}`, T, { inactive: true })).status, 200, "cleared, it may rest");
      } finally {
        // The account active again, and the starting cash alone.
        await prisma.ledgerAccount.update({ where: { id: prepaid.id }, data: { inactiveAt: null, description: null } });
        await call("PUT", "/ledger/opening-balances", T, startingCash());
      }
    });

    section("The ledger cache");
    await test("a build a write overtakes goes to its caller but is not kept; the next build is", async () => {
      const sold = { basis: "sold" };
      invalidateLedger(biz.id);
      const first = await loadLedger(biz.id, sold);
      assert.strictEqual(await loadLedger(biz.id, sold), first, "a build nothing changed under is kept");
      // A write's invalidation lands while a build is still reading the
      // records (loadLedger is waiting on the database as soon as it is called).
      invalidateLedger(biz.id);
      const building = loadLedger(biz.id, sold);
      invalidateLedger(biz.id);
      const overtaken = await building;
      assert.ok(overtaken && Array.isArray(overtaken.entries), "its caller still gets it");
      const next = await loadLedger(biz.id, sold);
      assert.notStrictEqual(next, overtaken, "the overtaken build was not kept");
      assert.strictEqual(await loadLedger(biz.id, sold), next, "the build after it is");
      // The same across the owner-wide clear server.js makes after any write.
      invalidateOwner(owner.id);
      const building2 = loadLedger(biz.id, { basis: "paid" });
      invalidateOwner(owner.id);
      const overtaken2 = await building2;
      assert.notStrictEqual(await loadLedger(biz.id, { basis: "paid" }), overtaken2, "nor across an owner-wide clear");
    });

    section("Who may see what");
    await test("reports need the Reports permission; anything showing the bank needs bank access too", async () => {
      eq((await call("GET", `/ledger/balances?${q}`, tPlain)).status, 403);
      eq((await call("GET", `/ledger/balances?${q}`, tReports)).body.permission, "canViewBalance");
      eq((await call("GET", `/ledger/reports/profit-and-loss?${q}`, tReports)).status, 200, "profit and loss");
      eq((await call("GET", `/ledger/reports/balance-sheet?${q}`, tBoth)).status, 200);
      eq((await call("GET", `/ledger/cash?${q}`, tPlain)).status, 403, "cash at hand is a balance");
    });
    await test("the sync bundle carries the chart for every member", async () => {
      const s = await call("GET", `/sync?${q}`, tPlain);
      eq(s.status, 200);
      eq(s.body.accounts.length, accounts.length);
    });

    section("Incremental sync");
    await test("a record changed after its table is read, before the pull answers, comes with the next pull", async () => {
      const made = await call("POST", "/sales", T, { businessId: biz.id, amount: 1500, date: today });
      eq(made.status, 201, JSON.stringify(made.body));
      const full = await call("GET", `/sync?${q}`, T);
      eq(full.status, 200);
      // The sale changes once the next pull has read the sales table, a few
      // milliseconds on, so its stamp is later than anything before that read.
      const note = `changed mid-pull ${tag}`;
      const real = prisma.sales.findMany;
      let hooked = false;
      prisma.sales.findMany = async (...args) => {
        prisma.sales.findMany = real;
        hooked = true;
        const rows = await real.apply(prisma.sales, args);
        await new Promise((r) => setTimeout(r, 5));
        await prisma.sales.update({ where: { id: made.body.id }, data: { notes: note } });
        return rows;
      };
      let mid;
      try {
        mid = await call("GET", `/sync?${q}&since=${encodeURIComponent(full.body.syncedAt)}`, T);
      } finally {
        prisma.sales.findMany = real;
      }
      eq(mid.status, 200, JSON.stringify(mid.body));
      assert.ok(hooked, "the pull read the sales table");
      assert.ok(!mid.body.sales.some((s) => s.notes === note), "read before the change");
      const next = await call("GET", `/sync?${q}&since=${encodeURIComponent(mid.body.syncedAt)}`, T);
      eq(next.status, 200);
      eq((next.body.sales.find((s) => s.id === made.body.id) || {}).notes, note, "the change reaches the next pull");
    });

    section("Merging two accounts");
    await test("records reaching an account by category move with the merge", async () => {
      const a = await call("POST", "/ledger/accounts", T, { businessId: biz.id, type: "expense", name: "Generator Repairs" });
      const b = await call("POST", "/ledger/accounts", T, { businessId: biz.id, type: "expense", name: "Gen Repairs" });
      const e = await prisma.expense.create({ data: { userId: owner.id, businessId: biz.id, category: b.body.categorySlug, amount: 700, date: new Date() } });
      const m = await call("POST", `/ledger/accounts/${b.body.id}/merge`, T, { intoId: a.body.id });
      eq(m.status, 200, JSON.stringify(m.body));
      eq((await prisma.expense.findUnique({ where: { id: e.id } })).accountId, a.body.id);
      eq(await prisma.ledgerAccount.count({ where: { id: b.body.id } }), 0);
    });

    section("Itemized expenses: Insights, accounts in use, merge and delete");
    await test("Insights' spending by account is the ledger's profit and loss by account", async () => {
      invalidateOwner(owner.id);
      const range = { start: lagosStart(today), end: new Date(lagosEnd(today).getTime() + 1) };
      const kobo = (rows) => new Map(rows.filter((r) => Math.round(r.amount * 100)).map((r) => [r.accountId, Math.round(r.amount * 100)]));
      const got = kobo(await spendingByAccount(biz.id, range));
      const pl = await call("GET", `/ledger/reports/profit-and-loss?${q}&basis=paid&from=${today}&to=${today}`, T);
      const want = kobo(pl.body.expenses);
      assert.deepStrictEqual([...got.entries()].sort(), [...want.entries()].sort());
      eq(got.get(byName("Shop Security").id), 300000, "a line counts in its own account");
      eq(got.has(byName("Generators and Power Equipment").id), false, "equipment is not spending");
      eq(got.get(bySys("bank_charges").id), 5375, "the transfer fee");
    });
    await test("an account used only by a line is in use: it can't be deleted, it can be merged", async () => {
      const a = await call("POST", "/ledger/accounts", T, { businessId: biz.id, type: "expense", name: "Generator Parts" });
      const b = await call("POST", "/ledger/accounts", T, { businessId: biz.id, type: "expense", name: "Gen Spares" });
      eq(b.status, 201, JSON.stringify(b.body));
      const x = await itemized({}, [
        { accountId: byName("Rent").id, category: "rent", amount: 1000, position: 0 },
        { accountId: b.body.id, category: b.body.categorySlug, amount: 500, position: 1 },
      ]);
      const del = await call("DELETE", `/ledger/accounts/${b.body.id}`, T);
      eq(del.status, 409);
      eq(del.body.code, "ACCOUNT_IN_USE");
      eq(del.body.used, 1, "the line");
      const m = await call("POST", `/ledger/accounts/${b.body.id}/merge`, T, { intoId: a.body.id });
      eq(m.status, 200, JSON.stringify(m.body));
      eq((await prisma.expenseItem.findUnique({ where: { id: x.items.find((it) => it.position === 1).id } })).accountId, a.body.id, "the line moved");
      eq(await prisma.ledgerAccount.count({ where: { id: b.body.id } }), 0, "merged away");
      eq((await call("DELETE", `/ledger/accounts/${a.body.id}`, T)).body.code, "ACCOUNT_IN_USE", "the account it moved to is in use now");
    });
    await test("lines reach an account by category too; the itemized expense itself never names one", async () => {
      const c = await call("POST", "/ledger/accounts", T, { businessId: biz.id, type: "expense", name: "Water Supply" });
      const d = await call("POST", "/ledger/accounts", T, { businessId: biz.id, type: "expense", name: "Water Bills" });
      // The first line is on the account, so the expense's own category is its
      // slug; the second line has lost its account and keeps only the slug.
      const x = await itemized({}, [
        { accountId: c.body.id, category: c.body.categorySlug, amount: 600, position: 0 },
        { accountId: null, category: c.body.categorySlug, amount: 300, position: 1 },
      ]);
      eq(x.category, c.body.categorySlug);
      eq((await call("DELETE", `/ledger/accounts/${c.body.id}`, T)).body.used, 2, "two lines; not the expense as well");
      eq((await call("POST", `/ledger/accounts/${c.body.id}/merge`, T, { intoId: d.body.id })).status, 200);
      const after = await prisma.expense.findUnique({ where: { id: x.id }, include: { items: { orderBy: { position: "asc" } } } });
      eq(after.accountId, null, "the expense names no account");
      assert.deepStrictEqual(after.items.map((it) => it.accountId), [d.body.id, d.body.id], "both lines moved");
    });
    await test("after the merges the books still tie out, in both views", async () => {
      for (const basis of ["paid", "sold"]) {
        const pl = await call("GET", `/ledger/reports/profit-and-loss?${q}&basis=${basis}&from=${today}&to=${today}`, T);
        const b = await booksFor(biz.id, { from: today, to: today, basis });
        eq(Math.round(pl.body.totalExpenses * 100), Math.round(b.expenses.total * 100), `${basis} expenses`);
      }
      eq((await call("GET", `/ledger/reports/balance-sheet?${q}`, T)).body.balanced, true);
    });
    await test("deleting an expense deletes its lines", async () => {
      const x = await itemized({}, [{ accountId: byName("Rent").id, category: "rent", amount: 250, position: 0 }]);
      eq((await call("DELETE", `/expenses/${x.id}`, T)).status, 200);
      eq(await prisma.expenseItem.count({ where: { expenseId: x.id } }), 0);
    });
    await test("the database keeps lines above zero and receipts a list; a deleted customer leaves the expense", async () => {
      await assert.rejects(prisma.expenseItem.create({ data: { expenseId: split.id, amount: 0 } }), /ExpenseItem_amount_check|check constraint/i);
      await assert.rejects(
        prisma.expense.create({ data: { userId: owner.id, businessId: biz.id, amount: 1, date: new Date(), attachments: { id: "x" } } }),
        /Expense_attachments_check|check constraint/i,
      );
      const cust = await prisma.customer.create({ data: { userId: owner.id, businessId: biz.id, name: `Cost ${tag}` } });
      const x = await prisma.expense.create({ data: { userId: owner.id, businessId: biz.id, amount: 400, date: new Date(), customerId: cust.id } });
      await prisma.customer.delete({ where: { id: cust.id } });
      eq((await prisma.expense.findUnique({ where: { id: x.id } })).customerId, null);
    });

    section("A deleted or merged category account stays gone");
    // An older app version adds a category as a custom category, and the
    // chart's set-up gives each category the books still read an account. So
    // an account deleted or merged away takes its custom categories along, and
    // a merge hands its category on, or the next look at the chart makes it again.
    const slugged = (slug) => accounts.filter((a) => a.categorySlug === slug);
    const customCount = (value) => prisma.customCategory.count({ where: { businessId: biz.id, value } });
    await test("deleted: the older app's custom category goes with its account, which stays gone", async () => {
      await prisma.customCategory.create({ data: { businessId: biz.id, label: "Food Stuff", value: "food-stuff" } });
      await refreshAccounts();
      const food = byName("Food Stuff");
      assert.ok(food, "the custom category's account");
      eq((await call("DELETE", `/ledger/accounts/${food.id}`, T)).status, 204);
      eq(await customCount("food-stuff"), 0, "the custom category went with it");
      // A custom category under an older name of a default's category.
      await prisma.customCategory.create({ data: { businessId: biz.id, label: "Electricity", value: "electricity" } });
      const power = byName("Electricity and Utilities");
      eq(power.categorySlug, "utility");
      eq((await call("DELETE", `/ledger/accounts/${power.id}`, T)).status, 204);
      eq(await customCount("electricity"), 0, "the older name went with it");
      await refreshAccounts();
      eq(slugged("food-stuff").length, 0, "Food Stuff not made again");
      eq(slugged("utility").length, 0, "nor an account for electricity");
    });
    await test("merged into an account that stands for no category: it takes the category, so an older app's expense lands there", async () => {
      await prisma.customCategory.create({ data: { businessId: biz.id, label: "Snacks", value: "snacks" } });
      await refreshAccounts();
      const snacks = byName("Snacks");
      const meals = byName("Meals and Entertainment");
      eq(meals.categorySlug, null, "Meals stands for no category");
      const moved = await call("POST", "/expenses", T, { businessId: biz.id, amount: 500, category: "snacks", date: today });
      eq(moved.body.accountId, null, "an older app names no account");
      const m = await call("POST", `/ledger/accounts/${snacks.id}/merge`, T, { intoId: meals.id });
      eq(m.status, 200, JSON.stringify(m.body));
      eq(m.body.into.categorySlug, "snacks", "Meals stands for snacks now");
      eq(await customCount("snacks"), 0, "the custom category went with it");
      const later = await call("POST", "/expenses", T, { businessId: biz.id, amount: 300, category: "Snacks", date: today });
      eq(later.status, 201, JSON.stringify(later.body));
      await refreshAccounts();
      assert.deepStrictEqual(slugged("snacks").map((a) => a.id), [meals.id], "one account for snacks: Meals");
      eq(byName("Snacks"), undefined, "Snacks stayed gone");
      const st = await call("GET", `/ledger/accounts/${meals.id}/transactions?${q}`, T);
      for (const x of [moved.body, later.body]) assert.ok(st.body.lines.some((l) => l.id === `expense:${x.id}`), `the ₦${x.amount} expense is on Meals`);
    });
    await test("merged into an account with a category of its own: what moved carries that one, and the merged account stays gone", async () => {
      await prisma.customCategory.create({ data: { businessId: biz.id, label: "Fumigation", value: "fumigation" } });
      await refreshAccounts();
      const fum = byName("Fumigation");
      const pest = (await call("POST", "/ledger/accounts", T, { businessId: biz.id, type: "expense", name: "Pest Control" })).body;
      eq(pest.categorySlug, "pest-control");
      // What reaches Fumigation: an older app's expense, an expense on it, an
      // itemized expense's first line, a recurring expense with no account,
      // and one on Loans (its older auto-debits read the category, so it is
      // a use too). Never due, so the auto-debit run below leaves them be.
      const oldApp = await prisma.expense.create({ data: { userId: owner.id, businessId: biz.id, category: "fumigation", amount: 100, date: new Date() } });
      const onIt = (await call("POST", "/expenses", T, { businessId: biz.id, amount: 200, accountId: fum.id, date: today })).body;
      eq(onIt.category, "fumigation");
      const x = await itemized({}, [
        { accountId: null, category: "fumigation", amount: 50, position: 0 },
        { accountId: byName("Rent").id, category: "rent", amount: 70, position: 1 },
      ]);
      const rule = (accountId) => prisma.recurringExpense.create({
        data: { userId: owner.id, businessId: biz.id, category: "fumigation", amount: 10, nextDue: new Date("2999-01-01"), active: false, accountId },
      });
      const ruleNone = await rule(null);
      const ruleLoan = await rule(bySys("loans").id);
      const del = await call("DELETE", `/ledger/accounts/${fum.id}`, T);
      eq(del.body.code, "ACCOUNT_IN_USE");
      eq(del.body.used, 5, "four records and the recurring expense on Loans");
      const m = await call("POST", `/ledger/accounts/${fum.id}/merge`, T, { intoId: pest.id });
      eq(m.status, 200, JSON.stringify(m.body));
      eq(m.body.into.categorySlug, "pest-control", "Pest Control keeps its own");
      const ex = (id) => prisma.expense.findUnique({ where: { id }, include: { items: { orderBy: { position: "asc" } } } });
      const [a, b, c] = await Promise.all([ex(oldApp.id), ex(onIt.id), ex(x.id)]);
      assert.deepStrictEqual([a.accountId, a.category], [pest.id, "pest-control"], "the older app's expense");
      assert.deepStrictEqual([b.accountId, b.category], [pest.id, "pest-control"], "the expense on the account");
      assert.deepStrictEqual([c.accountId, c.category, c.items[0].accountId, c.items[0].category], [null, "pest-control", pest.id, "pest-control"], "the itemized expense, by its first line");
      const rules = new Map((await prisma.recurringExpense.findMany({ where: { id: { in: [ruleNone.id, ruleLoan.id] } } })).map((r) => [r.id, r]));
      assert.deepStrictEqual([rules.get(ruleNone.id).accountId, rules.get(ruleNone.id).category], [pest.id, "pest-control"], "the recurring expense");
      assert.deepStrictEqual([rules.get(ruleLoan.id).accountId, rules.get(ruleLoan.id).category], [bySys("loans").id, "pest-control"], "still on Loans, its auto-debits now read Pest Control");
      eq(await customCount("fumigation"), 0, "the custom category went with it");
      await refreshAccounts();
      eq(slugged("fumigation").length, 0, "Fumigation stayed gone");
      for (const basis of ["paid", "sold"]) {
        const pl = await call("GET", `/ledger/reports/profit-and-loss?${q}&basis=${basis}&from=${today}&to=${today}`, T);
        eq(Math.round(pl.body.totalExpenses * 100), Math.round((await booksFor(biz.id, { from: today, to: today, basis })).expenses.total * 100), `${basis}: the books still tie out`);
      }
    });

    section("A scheduled auto-debit names its rule's account");
    await test("one for a loan lands on Loans and is not spending; one for rent is; the books tie out", async () => {
      // A business of its own with a bank account, so the figures above stay.
      const bank = await prisma.business.create({
        data: { userId: owner.id, name: `Coa bank ${tag}`, country: "NG", baseCurrency: "NGN", anchorAccountId: `e2e-anchor-${tag}` },
      });
      const bq = `businessId=${bank.id}`;
      const chartOf = (await call("GET", `/ledger/accounts?${bq}`, T)).body.accounts;
      const LOANS = chartOf.find((a) => a.systemKey === "loans");
      const RENT = chartOf.find((a) => a.name === "Rent");
      const KASHBOOK = chartOf.find((a) => a.systemKey === "kashbook");
      // The bank is stubbed: nothing leaves the machine, every call is kept.
      const anchor = require("../src/utils/anchor");
      const real = { ...anchor };
      const sent = [];
      Object.assign(anchor, {
        getAccountBalance: async () => ({ balance: 10_000_000, available: 10_000_000 }),
        getBanks: async () => [{ code: "058", id: "bank-058", name: "GTBank" }],
        createCounterparty: async () => ({ counterpartyId: "cp-e2e" }),
        createTransfer: async (args) => { sent.push(args); return { transferId: `tf-${sent.length}` }; },
        createBookTransfer: async (args) => { sent.push(args); return { transferId: `bk-${sent.length}` }; },
      });
      const amlWas = process.env.AML_ENABLED;
      process.env.AML_ENABLED = "false";
      // Due long ago, so the run takes these two and nothing another test left.
      const due = new Date("2001-01-01T09:00:00Z");
      const payee = `9${String(Date.now()).slice(-9)}`;
      const rule = (accountId, amount, name) => prisma.recurringExpense.create({
        data: {
          userId: owner.id, businessId: bank.id, category: "other", amount, frequency: "monthly", nextDue: due, accountId,
          autoSend: true, payeeAccountNumber: payee, payeeBankCode: "058", payeeBankName: "GTBank", payeeAccountName: name,
        },
      });
      const rules = [];
      try {
        rules.push(await rule(LOANS.id, 30000, "LENDER LTD"), await rule(RENT.id, 20000, "LANDLORD"));
        const [loanRule, rentRule] = rules;
        const { processRecurringExpenses } = require("../src/utils/recurringExpenseRunner");
        const run = await processRecurringExpenses({ now: new Date("2001-01-02T00:00:00Z") });
        eq(run.autoDebited, 2, JSON.stringify(run));
        eq(sent.filter((c) => c.counterpartyId).length, 2, "two transfers");
        const rows = await prisma.transaction.findMany({ where: { businessId: bank.id } });
        const loanRow = rows.find((t) => t.reference.startsWith(`kashbook_rec_${loanRule.id}_`));
        const rentRow = rows.find((t) => t.reference.startsWith(`kashbook_rec_${rentRule.id}_`));
        eq(loanRow.accountId, LOANS.id, "the loan's row names the loan");
        eq(loanRow.purpose, "account", "not trade, as a debit explained with a balance-sheet account");
        eq(rentRow.accountId, RENT.id);
        eq(rentRow.purpose, null, "spending stays spending");
        invalidateOwner(owner.id);
        const fees = Math.round((loanRow.fee + rentRow.fee) * 100);
        for (const basis of ["paid", "sold"]) {
          const b = await booksFor(bank.id, { from: today, to: today, basis });
          eq(Math.round(b.expenses.total * 100), 2000000 + fees, `${basis}: the rent and both fees, not the loan`);
          const pl = await call("GET", `/ledger/reports/profit-and-loss?${bq}&basis=${basis}&from=${today}&to=${today}`, T);
          eq(Math.round(pl.body.totalExpenses * 100), Math.round(b.expenses.total * 100), `${basis}: profit and loss = the books`);
          eq(pl.body.expenses.some((e) => e.accountId === LOANS.id), false, `${basis}: a loan repaid is not spending`);
        }
        const bal = (await call("GET", `/ledger/balances?${bq}`, T)).body.balances;
        eq(bal.find((x) => x.accountId === LOANS.id).balance, -30000, "the loan repaid, on the balance sheet");
        eq(Math.round(bal.find((x) => x.accountId === KASHBOOK.id).balance * 100), Math.round((await computeRawLedger(bank.id, "NGN")) * 100));
        const range = { start: lagosStart(today), end: new Date(lagosEnd(today).getTime() + 1) };
        const spend = await spendingByAccount(bank.id, range);
        eq(spend.some((g) => g.accountId === LOANS.id), false, "Insights: not spending");
        eq(spend.find((g) => g.accountId === RENT.id).amount, 20000, "Insights: the rent");
      } finally {
        Object.assign(anchor, real);
        if (amlWas === undefined) delete process.env.AML_ENABLED;
        else process.env.AML_ENABLED = amlWas;
        // Never due again.
        if (rules.length) await prisma.recurringExpense.updateMany({ where: { id: { in: rules.map((r) => r.id) } }, data: { active: false } });
      }
    });

    section("Retained Earnings and the Accounting home");
    // Businesses of their own, with records written straight to the database
    // on fixed days, so every figure is known.
    const ownBusiness = async (name, data = {}) => {
      const b = await prisma.business.create({ data: { userId: owner.id, name: `${name} ${tag}`, country: "NG", baseCurrency: "NGN", ...data } });
      const list = (await call("GET", `/ledger/accounts?businessId=${b.id}`, T)).body.accounts;
      return { b, bq: `businessId=${b.id}`, list, RE: list.find((a) => a.systemKey === chart.SYS.RETAINED) };
    };
    const at = (day) => new Date(`${day}T10:00:00.000Z`);
    const kob = (n) => Math.round(Number(n) * 100);
    const statement = (RE, bq, query) => call("GET", `/ledger/accounts/${RE.id}/transactions?${bq}&${query}`, T);
    const yearLines = (st) => st.body.lines.map((l) => `${l.day}:${l.amount}:${l.memo}:${l.kind}`).join(" ");
    // At each day, in both views: Retained Earnings in /balances is the balance
    // sheet's (plus `extra`, what was moved onto it) and its statement's
    // closing from each period start, the statement adds up, and the groups
    // reconcile: what you own = what you owe + your stake + money in less money out.
    async function tiesOut({ bq, list, RE }, days, { periods = [""], extra = () => 0, realDays = true } = {}) {
      const classOf = new Map(list.map((a) => [a.id, a.class]));
      for (const basis of ["sold", "paid"]) {
        for (const day of days) {
          const [bal, bs] = await Promise.all([
            call("GET", `/ledger/balances?${bq}&asOf=${day}&basis=${basis}`, T),
            call("GET", `/ledger/reports/balance-sheet?${bq}&asOf=${day}&basis=${basis}`, T),
          ]);
          eq(bal.status, 200, JSON.stringify(bal.body));
          const re = kob(bal.body.balances.find((x) => x.accountId === RE.id).balance);
          // With a day that is no date (an odd invoice issue day) the balance
          // sheet splits past and this year's profit by a day of its own.
          if (realDays) eq(re, kob(bs.body.retainedEarnings) + kob(extra(day)), `${basis} ${day}: the balance sheet's`);
          const t = { asset: 0, liability: 0, equity: 0, income: 0, expense: 0 };
          for (const x of bal.body.balances) t[classOf.get(x.accountId)] += kob(x.balance);
          eq(t.asset, t.liability + t.equity + t.income - t.expense, `${basis} ${day}: own = owe + stake + in less out`);
          eq(bs.body.balanced, true, `${basis} ${day}: the balance sheet balances`);
          for (const from of periods) {
            if (from > day) continue;
            const st = await statement(RE, bq, `to=${day}&basis=${basis}${from ? `&from=${from}` : ""}`);
            eq(kob(st.body.closing), re, `${basis} ${day} from ${from || "the start"}: the statement's closing`);
            eq(kob(st.body.opening) + st.body.lines.reduce((s, l) => s + kob(l.amount), 0), kob(st.body.closing), `${basis} ${day}: the statement adds up`);
          }
        }
      }
    }

    await test("Retained Earnings holds every past year's profit, as the balance sheet does, with a line a year on its statement", async () => {
      const B = await ownBusiness("Retained");
      const drawings = B.list.find((a) => a.systemKey === chart.SYS.DRAWINGS);
      // 2025: ₦100,000 of sales, ₦30,000 of rent on credit. 2026: ₦10,000 of
      // sales and ₦20,000 of drawings on credit.
      await prisma.sales.create({ data: { userId: owner.id, businessId: B.b.id, amount: 100000, paymentMethod: "cash", date: at("2025-06-01") } });
      await prisma.expense.create({ data: { userId: owner.id, businessId: B.b.id, amount: 30000, category: "rent", paymentMethod: "credit", date: at("2025-07-01") } });
      await prisma.sales.create({ data: { userId: owner.id, businessId: B.b.id, amount: 10000, paymentMethod: "cash", date: at("2026-02-01") } });
      await prisma.expense.create({ data: { userId: owner.id, businessId: B.b.id, amount: 20000, accountId: drawings.id, paymentMethod: "credit", date: at("2026-03-01") } });
      invalidateOwner(owner.id);
      for (const basis of ["sold", "paid"]) {
        const re = (await call("GET", `/ledger/balances?${B.bq}&asOf=2026-10-12&basis=${basis}`, T)).body.balances.find((x) => x.accountId === B.RE.id);
        assert.deepStrictEqual([re.balance, re.period], [70000, "balance"], `${basis}: 2025's profit`);
        const st = await statement(B.RE, B.bq, `to=2027-01-05&basis=${basis}`);
        eq(yearLines(st), "2026-01-01:70000:2025:year_profit 2027-01-01:10000:2026:year_profit", basis);
        eq(st.body.lines.every((l) => l.ref === null), true, `${basis}: no record behind a year's line`);
        eq(st.body.closing, 80000, `${basis}: 2025 and 2026`);
      }
      await tiesOut(B, ["2025-12-31", "2026-01-01", "2026-10-12", "2027-01-01"], { periods: ["", "2026-01-01", "2026-10-01"] });
    });
    await test("the Accounting home: You owe leaves out transfers nobody has explained; Owed to you is Reports' figure", async () => {
      const summary = async (B) => {
        invalidateOwner(owner.id);
        const s = await call("GET", `/ledger/summary?${B.bq}`, T);
        eq(s.status, 200, JSON.stringify(s.body));
        return s.body;
      };
      const credit = await ownBusiness("Home credit");
      await prisma.transaction.create({
        data: { businessId: credit.b.id, type: "income", amount: 50000, date: new Date(), paymentMethod: "bank", category: "transfer", source: "anchor", currency: "NGN", description: "test" },
      });
      let s = await summary(credit);
      assert.deepStrictEqual([s.cashAndBank, s.youOwe, s.unexplained, s.profitThisYear, s.owedToYou], [50000, 0, 50000, 50000, 0], "one transfer nobody has explained");
      await prisma.expense.create({ data: { userId: owner.id, businessId: credit.b.id, amount: 7000, category: "rent", paymentMethod: "credit", date: new Date() } });
      s = await summary(credit);
      assert.deepStrictEqual([s.youOwe, s.unexplained], [7000, 50000], "a supplier's bill still counts");
      let docs0 = 0;
      const doc = (B, type, total) => prisma.invoice.create({
        data: { businessId: B.b.id, userId: owner.id, invoiceNumber: `H-${tag}-${++docs0}`, type, status: "SENT", issueDate: today, subtotal: total, total },
      });
      const docs = await ownBusiness("Home invoices");
      await doc(docs, "invoice", 10000);
      await doc(docs, "credit_note", 2000);
      s = await summary(docs);
      eq(s.owedToYou, (await receivablesFor(docs.b.id)).owedToYou, "Reports' figure");
      assert.deepStrictEqual([s.owedToYou, s.youOweCustomers, s.youOwe], [10000, 2000, 2000], "an open invoice and a credit note not used yet");
      const note = await ownBusiness("Home note");
      await doc(note, "credit_note", 2000);
      s = await summary(note);
      assert.deepStrictEqual([s.owedToYou, s.youOwe], [0, 2000], "a credit note alone: owed to you never below zero");
      const sale = await ownBusiness("Home sale");
      await prisma.sales.create({ data: { userId: owner.id, businessId: sale.b.id, amount: 5000, paymentMethod: "credit", isCredit: true, date: new Date() } });
      s = await summary(sale);
      eq(s.owedToYou, (await receivablesFor(sale.b.id)).owedToYou, "Reports' figure");
      assert.deepStrictEqual([s.owedToYou, s.youOwe], [0, 0], "a credit sale no debt tracks");
    });
    await test("a financial year from April: a line a year on 1 April, named 2024/25, 2025/26 and 2026/27", async () => {
      const B = await ownBusiness("April", { fiscalYearStartMonth: 4 });
      await prisma.sales.create({ data: { userId: owner.id, businessId: B.b.id, amount: 1000, paymentMethod: "cash", date: at("2025-03-15") } });
      await prisma.sales.create({ data: { userId: owner.id, businessId: B.b.id, amount: 5000, paymentMethod: "cash", date: at("2025-04-01") } });
      await prisma.expense.create({ data: { userId: owner.id, businessId: B.b.id, amount: 1500, category: "rent", paymentMethod: "cash", date: at("2026-03-31") } });
      await prisma.sales.create({ data: { userId: owner.id, businessId: B.b.id, amount: 700, paymentMethod: "cash", date: at("2026-04-01") } });
      invalidateOwner(owner.id);
      eq(yearLines(await statement(B.RE, B.bq, "to=2027-05-05")),
        "2025-04-01:1000:2024/25:year_profit 2026-04-01:3500:2025/26:year_profit 2027-04-01:700:2026/27:year_profit");
      await tiesOut(B, ["2025-03-31", "2025-04-01", "2026-03-31", "2027-05-05"], { periods: ["", "2025-04-01", "2026-04-01"] });
    });
    await test("invoice issue days that are not dates: the groups still reconcile and the statement agrees", async () => {
      const B = await ownBusiness("Odd days");
      for (const [issueDate, total] of [["2025-6-1", 4000], ["15/06/2025", 300], ["2026-10-01T09:00:00.000Z", 20]]) {
        await prisma.invoice.create({
          data: { businessId: B.b.id, userId: owner.id, invoiceNumber: `O-${tag}-${total}`, type: "invoice", status: "SENT", issueDate, subtotal: total, total },
        });
      }
      await prisma.sales.create({ data: { userId: owner.id, businessId: B.b.id, amount: 9000, paymentMethod: "cash", date: at("2025-02-02") } });
      invalidateOwner(owner.id);
      await tiesOut(B, ["2025-12-31", "2026-10-12", "2027-01-05"], { periods: ["", "2026-01-01"], realDays: false });
    });
    await test("an account merged into Retained Earnings: its statement holds what moved beside each year's profit", async () => {
      const B = await ownBusiness("Merged profits");
      const custom = await call("POST", "/ledger/accounts", T, { businessId: B.b.id, type: "equity", name: "Old Profits" });
      eq(custom.status, 201, JSON.stringify(custom.body));
      await prisma.transaction.create({
        data: { businessId: B.b.id, type: "income", amount: 2500, date: at("2025-08-08"), paymentMethod: "bank", category: "transfer", source: "anchor", currency: "NGN", description: "test", accountId: custom.body.id, purpose: "account" },
      });
      await prisma.sales.create({ data: { userId: owner.id, businessId: B.b.id, amount: 6000, paymentMethod: "cash", date: at("2025-05-05") } });
      eq((await call("POST", `/ledger/accounts/${custom.body.id}/merge`, T, { intoId: B.RE.id })).status, 200);
      const st = await statement(B.RE, B.bq, "to=2026-10-12");
      eq(st.body.lines.map((l) => `${l.day}:${l.amount}:${l.kind}`).join(" "), "2025-08-08:2500:bank_in 2026-01-01:6000:year_profit");
      eq(st.body.closing, 8500);
      await tiesOut(B, ["2025-08-08", "2026-10-12"], { periods: ["", "2026-01-01"], extra: (day) => (day >= "2025-08-08" ? 2500 : 0) });
    });

    section("A merged or deleted category stays gone, whatever an older app sends (release 1.1)");
    // deepStrictEqual that says what it got.
    const same = (a, b, what = "") => assert.deepStrictEqual(a, b, `${what} ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
    // A phone on an older app version knows only categories. It keeps sending
    // the category of an account the owner merged away or deleted: on an
    // expense, and in the custom categories it puts back with the business.
    // Each check runs in a business of its own.
    const chartNow = async (B) => {
      const r = await call("GET", `/ledger/accounts?${B.bq}`, T);
      eq(r.status, 200, JSON.stringify(r.body));
      return r.body.accounts;
    };
    const newAccount = async (B, name, type = "expense") => {
      const r = await call("POST", "/ledger/accounts", T, { businessId: B.b.id, type, name });
      eq(r.status, 201, JSON.stringify(r.body));
      return r.body;
    };
    const merge = async (from, into) => {
      const r = await call("POST", `/ledger/accounts/${from.id}/merge`, T, { intoId: into.id });
      eq(r.status, 200, JSON.stringify(r.body));
      return r.body.into;
    };
    // An expense as an older app saves it: a category, no account.
    const oldAppExpense = async (B, category, amount) => {
      const r = await call("POST", "/expenses", T, { businessId: B.b.id, amount, category, date: today });
      eq(r.status, 201, JSON.stringify(r.body));
      eq(r.body.accountId, null, "an older app names no account");
      return r.body;
    };
    // The custom categories as an older app puts them back: the whole list it
    // keeps, each value made from its label as that app makes it.
    const putCategories = async (B, labels) => {
      const customCategories = labels.map((label) => ({ label, value: label.toLowerCase().replace(/\s+/g, "-"), icon: "pricetag-outline" }));
      const r = await call("PATCH", `/businesses/${B.b.id}`, T, { customCategories });
      eq(r.status, 200, JSON.stringify(r.body));
    };
    const debitIn = (B, amount) => prisma.transaction.create({
      data: { businessId: B.b.id, type: "expense", amount, date: new Date(), paymentMethod: "bank", category: "transfer", source: "anchor", currency: "NGN", description: "test" },
    });
    // What an account spent today ("when paid", by account), and whether an
    // expense is on its statement.
    const spentOn = async (B, account) => {
      const pl = await call("GET", `/ledger/reports/profit-and-loss?${B.bq}&basis=paid&from=${today}&to=${today}`, T);
      eq(pl.status, 200, JSON.stringify(pl.body));
      return (pl.body.expenses.find((r) => r.accountId === account.id) || { amount: 0 }).amount;
    };
    const onStatement = async (B, account, x) => {
      const st = await call("GET", `/ledger/accounts/${account.id}/transactions?${B.bq}`, T);
      eq(st.status, 200, JSON.stringify(st.body));
      return st.body.lines.some((l) => l.id === `expense:${x.id}`);
    };
    // The names of the accounts that stand for a category, by their own or a merged one.
    const standsFor = (list, slug) => list.filter((a) => a.categorySlug === slug || (a.aliasSlugs || []).includes(slug)).map((a) => a.name);
    const retiredOf = async (B) => [...(await prisma.business.findUnique({ where: { id: B.b.id } })).retiredCategorySlugs].sort();
    const todayRange = { start: lagosStart(today), end: new Date(lagosEnd(today).getTime() + 1) };
    const tiesOutToday = async (B) => {
      for (const basis of ["paid", "sold"]) {
        const pl = await call("GET", `/ledger/reports/profit-and-loss?${B.bq}&basis=${basis}&from=${today}&to=${today}`, T);
        const b = await booksFor(B.b.id, { from: today, to: today, basis });
        eq(Math.round(pl.body.totalExpenses * 100), Math.round(b.expenses.total * 100), `${basis}: profit and loss = the books`);
      }
    };

    await test("merged into an account with a category of its own: an older app's expense in the old category counts there, and the old account never comes back", async () => {
      const B = await ownBusiness("Alias merge");
      const other = B.list.find((a) => a.systemKey === chart.SYS.OTHER_EXPENSES);
      const fum = await newAccount(B, "Fumigation");
      const pest = await newAccount(B, "Pest Control");
      same([fum.categorySlug, pest.categorySlug], ["fumigation", "pest-control"], "each with a category of its own");
      const into = await merge(fum, pest);
      const x = await oldAppExpense(B, "fumigation", 4321);
      eq(await spentOn(B, pest), 4321, "profit and loss by account: on Pest Control");
      eq(await spentOn(B, other), 0, "not in Other Expenses");
      assert.ok(await onStatement(B, pest, x), "on Pest Control's statement");
      const spend = await spendingByAccount(B.b.id, todayRange);
      eq((spend.find((g) => g.accountId === pest.id) || {}).amount, 4321, "Insights: on Pest Control");
      same(standsFor(await chartNow(B), "fumigation"), ["Pest Control"], "the chart makes no account for it");
      await putCategories(B, ["Fumigation"]);
      let list = await chartNow(B);
      same(standsFor(list, "fumigation"), ["Pest Control"], "nor for the custom category put back");
      eq(list.some((a) => a.name === "Fumigation"), false, "Fumigation stayed gone");
      eq(into.categorySlug, "pest-control", "Pest Control keeps its own category");
      same(into.aliasSlugs, ["fumigation"], "and stands for Fumigation's");
      const synced = await call("GET", `/sync?${B.bq}`, T);
      same(synced.body.accounts.find((a) => a.id === pest.id).aliasSlugs, ["fumigation"], "the app is sent it");
      // The expense in the old category is a use of Pest Control.
      const del = await call("DELETE", `/ledger/accounts/${pest.id}`, T);
      eq(del.body.code, "ACCOUNT_IN_USE", JSON.stringify(del.body));
      eq(del.body.used, 1, "the older app's expense");
      // Staff recording a transfer under the old category: on Pest Control too.
      const debit = await debitIn(B, 900);
      const s = await call("POST", `/transactions/${debit.id}/create-expense`, tBoth, { category: "fumigation" });
      eq(s.status, 201, JSON.stringify(s.body));
      eq(s.body.expense.category, "pest-control", "staff file it under the account that stands for it");
      eq(await spentOn(B, pest), 5221, "both on Pest Control");
      // An account the owner names Fumigation now: the category stays Pest Control's.
      const again = await newAccount(B, "Fumigation");
      eq(again.categorySlug, "fumigation-2", "a category another account stands for is taken");
      await oldAppExpense(B, "fumigation", 1000);
      eq(await spentOn(B, pest), 6221, "the old category still counts on Pest Control");
      eq(await spentOn(B, again), 0, "not on the new account");
      list = await chartNow(B);
      same(standsFor(list, "fumigation"), ["Pest Control"]);
      await tiesOutToday(B);
    });
    await test("merged into an account with no category of its own, it takes the category and those merged into it; a chain A into B into C: C stands for all three", async () => {
      const B = await ownBusiness("Alias chain");
      const lamp = await newAccount(B, "Lamp Oil");
      const kero = await newAccount(B, "Kerosene");
      const light = await newAccount(B, "Lighting");
      const jan = B.list.find((a) => a.name === "Janitorial");
      eq(jan.categorySlug, null, "Janitorial stands for no category");
      const toKero = await merge(lamp, kero);
      // Saved between the merges, in a category merged into Kerosene: each
      // merge after it moves it on.
      const mid = await oldAppExpense(B, "lamp-oil", 50);
      const toJan = await merge(kero, jan);
      const toLight = await merge(jan, light);
      const xs = [await oldAppExpense(B, "Lighting", 100), await oldAppExpense(B, "kerosene", 200), await oldAppExpense(B, "Lamp-Oil", 400)];
      eq(await spentOn(B, light), 750, "all three categories on Lighting");
      for (const x of [mid, ...xs]) assert.ok(await onStatement(B, light, x), `the ${x.category} expense is on Lighting's statement`);
      const moved = await prisma.expense.findUnique({ where: { id: mid.id } });
      same([moved.accountId, moved.category], [light.id, "lighting"], "the expense in a merged category moved with the merges");
      await putCategories(B, ["Kerosene", "Lamp Oil"]);
      const list = await chartNow(B);
      for (const slug of ["lighting", "kerosene", "lamp-oil"]) same(standsFor(list, slug), ["Lighting"], `${slug}: Lighting alone`);
      for (const name of ["Lamp Oil", "Kerosene", "Janitorial"]) eq(list.some((a) => a.name === name), false, `${name} stayed gone`);
      same([toKero.categorySlug, toKero.aliasSlugs], ["kerosene", ["lamp-oil"]], "Kerosene stands for Lamp Oil's too");
      same([toJan.categorySlug, toJan.aliasSlugs], ["kerosene", ["lamp-oil"]], "Janitorial takes Kerosene's, and Lamp Oil's with it");
      same([toLight.categorySlug, [...toLight.aliasSlugs].sort()], ["lighting", ["kerosene", "lamp-oil"]], "Lighting stands for all three");
      eq((await call("DELETE", `/ledger/accounts/${light.id}`, T)).body.used, 4, "an expense in any of the three is a use, and the one that moved");
      await tiesOutToday(B);
    });
    await test("deleted: an older app's expense in its category counts in Other Expenses and makes nothing, even with the category put back; made again by the owner, it takes the category back", async () => {
      const B = await ownBusiness("Retired");
      const other = B.list.find((a) => a.systemKey === chart.SYS.OTHER_EXPENSES);
      await putCategories(B, ["Snacks"]);
      const snacks = (await chartNow(B)).find((a) => a.name === "Snacks");
      assert.ok(snacks, "the older app's custom category made the account");
      eq(snacks.categorySlug, "snacks");
      eq((await call("DELETE", `/ledger/accounts/${snacks.id}`, T)).status, 204, "unused, so it may go");
      const x = await oldAppExpense(B, "snacks", 2500);
      eq(await spentOn(B, other), 2500, "in Other Expenses");
      same(standsFor(await chartNow(B), "snacks"), [], "the chart makes no account for it");
      await putCategories(B, ["Snacks"]);
      const list = await chartNow(B);
      same(standsFor(list, "snacks"), [], "nor for the custom category put back");
      eq(list.some((a) => a.name === "Snacks"), false, "Snacks stayed gone");
      eq(await spentOn(B, other), 2500, "still in Other Expenses");
      assert.ok(await onStatement(B, other, x), "on Other Expenses' statement");
      same(await retiredOf(B), ["snacks"], "its category is retired");
      // The owner makes Snacks again, on purpose.
      const again = await newAccount(B, "Snacks");
      eq(again.categorySlug, "snacks", "it takes the category back");
      same(await retiredOf(B), [], "which is no longer retired");
      eq(await spentOn(B, again), 2500, "the older app's expense lands in it");
      eq(await spentOn(B, other), 0, "and leaves Other Expenses");
      assert.ok(await onStatement(B, again, x), "on the new account's statement");
      same(standsFor(await chartNow(B), "snacks"), ["Snacks"], "one account for it");
      await tiesOutToday(B);
    });
    await test("made another kind of account while unused: its category and those merged into it are retired; an expense account again, it takes its own back", async () => {
      const B = await ownBusiness("Kind change");
      const other = B.list.find((a) => a.systemKey === chart.SYS.OTHER_EXPENSES);
      const gas = await newAccount(B, "Gas Cylinders");
      const propane = await newAccount(B, "Propane");
      await merge(propane, gas);
      await putCategories(B, ["Gas Cylinders", "Propane"]);
      const p = await call("PATCH", `/ledger/accounts/${gas.id}`, T, { type: "fixed_asset" });
      eq(p.status, 200, JSON.stringify(p.body));
      eq(p.body.categorySlug, null, "an asset stands for no category");
      const customLeft = await prisma.customCategory.count({ where: { businessId: B.b.id } });
      await oldAppExpense(B, "gas-cylinders", 300);
      await oldAppExpense(B, "propane", 50);
      eq(await spentOn(B, other), 350, "both in Other Expenses");
      await putCategories(B, ["Gas Cylinders", "Propane"]);
      const list = await chartNow(B);
      for (const slug of ["gas-cylinders", "propane"]) same(standsFor(list, slug), [], `no account for ${slug}`);
      eq(list.filter((a) => a.class === "expense" && /^(gas cylinders|propane)/i.test(a.name)).length, 0, "no expense account by either name");
      eq(await spentOn(B, other), 350, "still in Other Expenses");
      same(p.body.aliasSlugs, [], "nor does the asset keep Propane's");
      same(await retiredOf(B), ["gas-cylinders", "propane"], "both retired");
      eq(customLeft, 0, "the older app's custom categories went with them, as on a delete");
      // An expense account again (it is still unused): its own category comes
      // back to it; Propane's stays retired.
      const back = await call("PATCH", `/ledger/accounts/${gas.id}`, T, { type: "expense" });
      eq(back.status, 200, JSON.stringify(back.body));
      eq(back.body.categorySlug, "gas-cylinders");
      same(await retiredOf(B), ["propane"]);
      eq(await spentOn(B, gas), 300, "the older app's expense lands in it again");
      eq(await spentOn(B, other), 50, "Propane's stays in Other Expenses");
      same(standsFor(await chartNow(B), "propane"), [], "and makes no account");
      await tiesOutToday(B);
    });

    section("Release 2: the general ledger");
    const glOf = (B, query, token = T) => call("GET", `/ledger/reports/general-ledger?${B.bq}${query ? `&${query}` : ""}`, token);
    const sysIn = (B, key) => B.list.find((a) => a.systemKey === key);
    const slugIn = (B, slug) => B.list.find((a) => a.categorySlug === slug);
    // Every entry's debits equal its credits, and `amount`, to the kobo; and
    // the totals are what the entries come to.
    const glBalanced = (body) => {
      let all = 0;
      for (const e of body.entries) {
        const dr = e.lines.reduce((s, l) => s + kob(l.debit), 0);
        const cr = e.lines.reduce((s, l) => s + kob(l.credit), 0);
        eq(dr, cr, `${e.id} balances`);
        eq(dr, kob(e.amount), `${e.id} amount`);
        for (const l of e.lines) eq((kob(l.debit) > 0) !== (kob(l.credit) > 0), true, `${e.id}: a line is a debit or a credit`);
        all += dr;
      }
      same([kob(body.totals.debit), kob(body.totals.credit)], [all, all], "the totals");
    };
    let GL;
    await test("every entry of the period by day, a day's opening first, each balanced; the shared cached ledger is left as it was", async () => {
      GL = await ownBusiness("General ledger");
      const rent = slugIn(GL, "rent");
      // Built sales, then expenses, then bank rows: read by day.
      const sale = await prisma.sales.create({ data: { userId: owner.id, businessId: GL.b.id, amount: 10000, paymentMethod: "cash", date: at("2026-03-02") } });
      const exp = await prisma.expense.create({ data: { userId: owner.id, businessId: GL.b.id, amount: 2000, category: "rent", accountId: rent.id, paymentMethod: "cash", date: at("2026-03-01") } });
      const tx = await prisma.transaction.create({
        data: { businessId: GL.b.id, type: "income", amount: 5000, date: at("2026-03-03"), paymentMethod: "bank", category: "transfer", source: "anchor", currency: "NGN", description: "test" },
      });
      const put = await call("PUT", "/ledger/opening-balances", T, { businessId: GL.b.id, date: "2026-03-01", lines: [{ accountId: sysIn(GL, "cash").id, debit: 1000, credit: 0 }] });
      eq(put.status, 200, JSON.stringify(put.body));
      invalidateOwner(owner.id);
      const cached = await loadLedger(GL.b.id, { basis: "sold" });
      const frozen = JSON.stringify(cached.entries);
      const r = await glOf(GL, "to=2026-03-03");
      eq(r.status, 200, JSON.stringify(r.body));
      same([r.body.basis, r.body.from, r.body.to], ["sold", "", "2026-03-03"], "when sold by default, from the start");
      same(r.body.entries.map((e) => `${e.day} ${e.kind} ${e.ref}`), [
        "2026-03-01 opening null", `2026-03-01 expense ${exp.id}`, `2026-03-02 sale ${sale.id}`, `2026-03-03 bank_in ${tx.id}`,
      ]);
      glBalanced(r.body);
      same(kob(r.body.totals.debit), kob(1000 + 2000 + 10000 + 5000));
      const ids = new Set(GL.list.map((a) => a.id));
      eq(r.body.entries.every((e) => e.lines.every((l) => ids.has(l.accountId))), true, "lines name accounts of this chart");
      const ex = r.body.entries[1];
      same(ex.lines, [{ accountId: rent.id, debit: 2000, credit: 0 }, { accountId: sysIn(GL, "cash").id, debit: 0, credit: 2000 }], "the expense's lines");
      assert.strictEqual(await loadLedger(GL.b.id, { basis: "sold" }), cached, "still the cached build");
      eq(JSON.stringify(cached.entries), frozen, "in its own order, unchanged");
      const one = await glOf(GL, "from=2026-03-02&to=2026-03-02");
      same(one.body.entries.map((e) => e.ref), [sale.id], "one day");
      eq((await glOf(GL, "from=2026-03-04&to=2026-03-03")).body.entries.length, 0, "an empty period");
    });
    await test("its lines add up to the trial balance, in both views; an invoice is an entry when sold, not when paid", async () => {
      const doc = await prisma.invoice.create({
        data: { businessId: GL.b.id, userId: owner.id, invoiceNumber: `GL-${tag}`, type: "invoice", status: "SENT", issueDate: "2026-03-04", subtotal: 3000, total: 3000 },
      });
      invalidateOwner(owner.id);
      for (const basis of ["sold", "paid"]) {
        const r = await glOf(GL, `basis=${basis}&to=2026-03-31`);
        eq(r.status, 200, JSON.stringify(r.body));
        eq(r.body.basis, basis);
        glBalanced(r.body);
        const sums = new Map();
        for (const e of r.body.entries) for (const l of e.lines) sums.set(l.accountId, (sums.get(l.accountId) || 0) + kob(l.debit) - kob(l.credit));
        const tb = await call("GET", `/ledger/reports/trial-balance?${GL.bq}&basis=${basis}&asOf=2026-03-31`, T);
        const want = new Map(tb.body.rows.map((row) => [row.accountId, kob(row.debit) - kob(row.credit)]));
        same([...sums].filter(([, k]) => k).sort(), [...want].sort(), `${basis}: the trial balance`);
        eq(r.body.entries.some((e) => e.ref === doc.id), basis === "sold", `${basis}: the invoice`);
      }
    });
    await test("published journals are entries as written; a draft is not; a bill and its payment, by view", async () => {
      const prepaid = GL.list.find((a) => a.name === "Prepaid Expenses");
      const cash = sysIn(GL, "cash");
      const rent = slugIn(GL, "rent");
      const journal = (status, n) => prisma.manualJournal.create({
        data: {
          businessId: GL.b.id, number: `MJ-${tag}-${n}`, status, date: at("2026-03-05"), note: "Rent paid ahead",
          lines: { create: [{ accountId: prepaid.id, debit: 500, position: 0 }, { accountId: cash.id, credit: 500, position: 1 }] },
        },
      });
      const pub = await journal("published", 1);
      const draft = await journal("draft", 2);
      const bill = await prisma.businessDebt.create({
        data: {
          userId: owner.id, businessId: GL.b.id, name: "Landlord", originalAmount: 4000, remainingAmount: 2500, status: "partial",
          accountId: rent.id, billDate: at("2026-03-06"), payments: { create: [{ amount: 1500, method: "cash", date: at("2026-03-07") }] },
        },
      });
      invalidateOwner(owner.id);
      const lines = (e) => e.lines.map((l) => `${l.accountId}:${l.debit}:${l.credit}`).sort();
      for (const basis of ["sold", "paid"]) {
        const r = await glOf(GL, `basis=${basis}&from=2026-03-05&to=2026-03-31`);
        eq(r.status, 200, JSON.stringify(r.body));
        glBalanced(r.body);
        const mj = r.body.entries.filter((e) => e.ref === pub.id);
        eq(mj.length, 1, `${basis}: the published journal`);
        same([mj[0].day, lines(mj[0])], ["2026-03-05", [`${cash.id}:0:500`, `${prepaid.id}:500:0`].sort()], `${basis}: its lines`);
        eq(r.body.entries.some((e) => e.ref === draft.id), false, `${basis}: no draft`);
        const forBill = r.body.entries.filter((e) => e.ref === bill.id).map((e) => `${e.day} ${lines(e).join(" ")}`);
        const ap = sysIn(GL, "ap");
        same(forBill, basis === "sold"
          ? [`2026-03-06 ${[`${ap.id}:0:4000`, `${rent.id}:4000:0`].sort().join(" ")}`, `2026-03-07 ${[`${ap.id}:1500:0`, `${cash.id}:0:1500`].sort().join(" ")}`]
          : [`2026-03-07 ${[`${cash.id}:0:1500`, `${rent.id}:1500:0`].sort().join(" ")}`],
        `${basis}: the bill`);
      }
    });
    await test("who may read it: the Reports permission and bank access; never another owner's business", async () => {
      eq((await glOf(GL, "", tPlain)).status, 403);
      const r = await glOf(GL, "", tReports);
      same([r.status, r.body.permission], [403, "canViewBalance"]);
      eq((await glOf(GL, "", tBoth)).status, 200);
      eq((await call("GET", `/ledger/reports/general-ledger?businessId=${rivalBiz.id}`, T)).status, 404);
    });
    await test("a bill's words (its supplier, its notes) only for those who may open bills; everyone else gets its entries without them", async () => {
      const tBills = await staffWith("glbills", { canViewReports: true, canViewBalance: true, canManagePayables: true });
      const BILL_KINDS = new Set(["bill", "bill_payment"]);
      const memos = (list) => list.filter((e) => BILL_KINDS.has(e.kind)).map((e) => e.memo);
      const range = "basis=sold&from=2026-03-05&to=2026-03-31";
      const own = await glOf(GL, range);
      const both = await glOf(GL, range, tBoth);
      const bills = await glOf(GL, range, tBills);
      eq(both.status, 200, JSON.stringify(both.body));
      const mine = memos(own.body.entries);
      eq(mine.length >= 2 && mine.every((m) => m === "Landlord"), true, JSON.stringify(mine));
      same(memos(bills.body.entries), mine, "staff with bills read them");
      same(memos(both.body.entries), mine.map(() => ""), "staff without bills get none");
      // Everything else is the owner's answer: the entries, their amounts and
      // lines, and every other memo (an adjustment keeps its note).
      const shape = (body) => body.entries.map((e) => [e.id, e.kind, e.amount, e.lines, BILL_KINDS.has(e.kind) ? "" : e.memo]);
      same(shape(both.body), shape(own.body), "the same entries");
      eq(both.body.entries.some((e) => e.kind === "journal" && e.memo === "Rent paid ahead"), true, "a journal keeps its note");
      eq(JSON.stringify(both.body).includes("Landlord"), false, "nowhere in the general ledger");
      // An account's statement too: Accounts Payable lists every bill.
      const apUrl = `/ledger/accounts/${sysIn(GL, "ap").id}/transactions?${GL.bq}&from=2026-03-01&to=2026-03-31`;
      const stOwn = await call("GET", apUrl, T);
      const stBoth = await call("GET", apUrl, tBoth);
      eq(stBoth.status, 200, JSON.stringify(stBoth.body));
      eq(memos(stOwn.body.lines).includes("Landlord"), true, "the owner reads the supplier");
      same(memos(stBoth.body.lines), memos(stOwn.body.lines).map(() => ""), "staff without bills do not");
      eq(JSON.stringify(stBoth.body).includes("Landlord"), false, "nowhere in the statement");
      // The cached ledger the owner shares keeps its words.
      eq(memos((await glOf(GL, range)).body.entries).every((m) => m === "Landlord"), true, "the owner's answer afterwards");
    });

    section("Release 2: You owe counts the bills");
    await test("an open bill is owed until it is paid; an estimated bill only its part not paid before bills; a loan, where its money went", async () => {
      const B = await ownBusiness("Owe bills");
      const [RENT, CASH, LOANS, AP] = [slugIn(B, "rent"), sysIn(B, "cash"), sysIn(B, "loans"), sysIn(B, "ap")];
      const home = async () => {
        invalidateOwner(owner.id);
        const s = await call("GET", `/ledger/summary?${B.bq}`, T);
        eq(s.status, 200, JSON.stringify(s.body));
        return [s.body.youOwe, s.body.profitThisYear, s.body.cashAndBank];
      };
      same(await home(), [0, 0, 0], "nothing yet");
      const bill = await prisma.businessDebt.create({
        data: { userId: owner.id, businessId: B.b.id, name: "Landlord", originalAmount: 10000, remainingAmount: 10000, accountId: RENT.id, billDate: new Date() },
      });
      same(await home(), [10000, 0, 0], "owed from its bill date, not spending when paid until it is paid");
      await prisma.billPayment.create({ data: { billId: bill.id, amount: 4000, method: "cash", date: new Date() } });
      same(await home(), [6000, -4000, -4000], "paid from cash: spending when paid");
      await prisma.businessDebt.create({
        data: {
          userId: owner.id, businessId: B.b.id, name: "Old supplier", originalAmount: 5000, remainingAmount: 3000, accountId: RENT.id,
          billDate: new Date(), estimated: true,
          payments: { create: [{ amount: 2000, method: "other", estimated: true, outsideBooks: true, date: new Date() }] },
        },
      });
      same(await home(), [9000, -4000, -4000], "what was paid before bills counts nowhere");
      await prisma.businessDebt.create({
        data: {
          userId: owner.id, businessId: B.b.id, name: "Lender", type: "loan", originalAmount: 100000, remainingAmount: 100000,
          accountId: LOANS.id, receivedViaAccountId: CASH.id, billDate: new Date(),
        },
      });
      same(await home(), [109000, -4000, 96000], "a loan: owed, its money in cash, never profit");
      const bal = (await call("GET", `/ledger/balances?${B.bq}`, T)).body.balances;
      same([bal.find((x) => x.accountId === AP.id).balance, bal.find((x) => x.accountId === LOANS.id).balance], [9000, 100000], "Accounts Payable and Loans");
      eq((await call("GET", `/ledger/reports/balance-sheet?${B.bq}`, T)).body.balanced, true);
      for (const basis of ["paid", "sold"]) {
        const pl = await call("GET", `/ledger/reports/profit-and-loss?${B.bq}&basis=${basis}&from=${today}&to=${today}`, T);
        const b = await booksFor(B.b.id, { from: today, to: today, basis });
        eq(kob(pl.body.totalExpenses), kob(b.expenses.total), `${basis}: profit and loss = the books`);
      }
    });

    section("Release 2: what uses an account");
    let U;
    const uses = {};
    await test("an account a bill, its loan's money, a payment or a journal line names is in use: never deleted, its type kept", async () => {
      U = await ownBusiness("Uses");
      Object.assign(uses, {
        hire: await newAccount(U, "Generator Hire"),
        hire2: await newAccount(U, "Generator Rental"),
        petty: await newAccount(U, "Petty Cash", "cash"),
        loanFloat: await newAccount(U, "Loan Float", "cash"),
        drawer: await newAccount(U, "Cash Drawer", "cash"),
        lender: await newAccount(U, "Lender Loan", "long_term_liability"),
        lender2: await newAccount(U, "Bank Loan", "long_term_liability"),
        misc: await newAccount(U, "Misc Adjust", "other_current_asset"),
      });
      uses.bill = await prisma.businessDebt.create({
        data: {
          userId: owner.id, businessId: U.b.id, name: "Hire co", originalAmount: 900, remainingAmount: 800, accountId: uses.hire.id,
          payments: { create: [{ amount: 100, method: "cash", paidThroughAccountId: uses.drawer.id }] },
        },
      });
      uses.loan = await prisma.businessDebt.create({
        data: { userId: owner.id, businessId: U.b.id, name: "Bank", originalAmount: 50000, remainingAmount: 50000, accountId: uses.lender.id, receivedViaAccountId: uses.loanFloat.id },
      });
      uses.journal = await prisma.manualJournal.create({
        data: {
          businessId: U.b.id, number: `MJ-${tag}-U`, status: "draft",
          lines: { create: [{ accountId: uses.misc.id, debit: 50, position: 0 }, { accountId: uses.drawer.id, credit: 50, position: 1 }] },
        },
      });
      for (const [acc, used] of [[uses.hire, 1], [uses.lender, 1], [uses.loanFloat, 1], [uses.drawer, 2], [uses.misc, 1]]) {
        const d = await call("DELETE", `/ledger/accounts/${acc.id}`, T);
        same([d.status, d.body.code, d.body.used], [409, "ACCOUNT_IN_USE", used], acc.name);
      }
      eq((await call("PATCH", `/ledger/accounts/${uses.hire.id}`, T, { type: "other_expense" })).body.code, "TYPE_LOCKED", "a bill's account");
      eq((await call("PATCH", `/ledger/accounts/${uses.misc.id}`, T, { type: "fixed_asset" })).body.code, "TYPE_LOCKED", "a draft journal's account");
      eq(await prisma.ledgerAccount.count({ where: { id: { in: [uses.hire.id, uses.lender.id, uses.loanFloat.id, uses.drawer.id, uses.misc.id] } } }), 5);
    });
    await test("a merge moves bills, payments and journal lines, and touches the bills and journals so phones pick them up", async () => {
      const loan0 = await prisma.businessDebt.findUnique({ where: { id: uses.loan.id } });
      const journal0 = await prisma.manualJournal.findUnique({ where: { id: uses.journal.id } });
      await new Promise((r) => setTimeout(r, 15));
      await merge(uses.hire, uses.hire2);
      await merge(uses.lender, uses.lender2);
      await merge(uses.loanFloat, uses.petty);
      // Read between the merges: the next one moves only the bill's payment.
      const bill0 = await prisma.businessDebt.findUnique({ where: { id: uses.bill.id } });
      await new Promise((r) => setTimeout(r, 15));
      await merge(uses.drawer, uses.petty);
      const bill = await prisma.businessDebt.findUnique({ where: { id: uses.bill.id }, include: { payments: true } });
      same([bill.accountId, bill.payments[0].paidThroughAccountId], [uses.hire2.id, uses.petty.id], "the bill and its payment");
      const loan = await prisma.businessDebt.findUnique({ where: { id: uses.loan.id } });
      same([loan.accountId, loan.receivedViaAccountId], [uses.lender2.id, uses.petty.id], "the loan");
      const lines = await prisma.manualJournalLine.findMany({ where: { journalId: uses.journal.id }, orderBy: { position: "asc" } });
      same(lines.map((l) => l.accountId), [uses.misc.id, uses.petty.id], "the journal line");
      const journal = await prisma.manualJournal.findUnique({ where: { id: uses.journal.id } });
      same([bill.updatedAt > bill0.updatedAt, loan.updatedAt > loan0.updatedAt, journal.updatedAt > journal0.updatedAt], [true, true, true],
        "touched: the bill whose payment moved, the loan, the journal whose line moved");
      eq(await prisma.ledgerAccount.count({ where: { id: { in: [uses.hire.id, uses.lender.id, uses.loanFloat.id, uses.drawer.id] } } }), 0, "merged away");
      const d = await call("DELETE", `/ledger/accounts/${uses.petty.id}`, T);
      same([d.body.code, d.body.used], ["ACCOUNT_IN_USE", 3], "the loan's money, the payment and the journal line, all on it now");
    });
    await test("never into an account KashBook keeps in step with its records; nothing moves", async () => {
      const float = await newAccount(U, "Float", "cash");
      const owed = await newAccount(U, "Supplier Credit", "other_current_liability");
      await prisma.businessDebt.create({ data: { userId: owner.id, businessId: U.b.id, name: "Credit", originalAmount: 10, remainingAmount: 10, accountId: owed.id } });
      for (const [from, key] of [[float, "kashbook"], [float, "bank_match"], [float, "ar"], [float, "legacy"], [owed, "ap"], [owed, "suspense"]]) {
        const r = await call("POST", `/ledger/accounts/${from.id}/merge`, T, { intoId: sysIn(U, key).id });
        same([r.status, r.body.code], [400, "BAD_TARGET"], key);
      }
      eq(await prisma.ledgerAccount.count({ where: { id: { in: [float.id, owed.id] } } }), 2, "both still there");
      eq((await prisma.businessDebt.count({ where: { accountId: owed.id } })), 1, "the bill still on its account");
    });
    await test("a journal line written after the count still keeps its account: the delete is refused as it commits", async () => {
      const acc = await newAccount(U, "Late Account", "other_current_asset");
      await prisma.manualJournal.create({
        data: {
          businessId: U.b.id, number: `MJ-${tag}-L`,
          lines: { create: [{ accountId: acc.id, debit: 10, position: 0 }, { accountId: sysIn(U, "cash").id, credit: 10, position: 1 }] },
        },
      });
      // The count misses it once, as if the line were written just after.
      const real = prisma.manualJournalLine.count;
      let missed = false;
      prisma.manualJournalLine.count = async (...args) => {
        if (!missed) {
          missed = true;
          return 0;
        }
        return real.apply(prisma.manualJournalLine, args);
      };
      let d;
      try {
        d = await call("DELETE", `/ledger/accounts/${acc.id}`, T);
      } finally {
        prisma.manualJournalLine.count = real;
      }
      eq(missed, true, "the count was asked");
      same([d.status, d.body.code, d.body.used], [409, "ACCOUNT_IN_USE", 1], JSON.stringify(d.body));
      eq(await prisma.ledgerAccount.count({ where: { id: acc.id } }), 1, "still there");
    });
    await test("a journal line written on an account while it is merged away: nothing moves, and the merge can be tried again", async () => {
      const a = await newAccount(U, "Old Till", "cash");
      const b = await newAccount(U, "New Till", "cash");
      const j = await prisma.manualJournal.create({
        data: {
          businessId: U.b.id, number: `MJ-${tag}-M`,
          lines: { create: [{ accountId: b.id, debit: 10, position: 0 }, { accountId: sysIn(U, "cash").id, credit: 10, position: 1 }] },
        },
      });
      const real = prisma.$transaction;
      let hooked = false;
      prisma.$transaction = function hookedTransaction(fn, ...rest) {
        if (hooked || typeof fn !== "function") return real.call(this, fn, ...rest);
        hooked = true;
        return real.call(this, async (px) => {
          const out = await fn(px);
          // Another write names the account the merge is taking away.
          await px.manualJournalLine.create({ data: { journalId: j.id, accountId: a.id, debit: 5, position: 9 } });
          return out;
        }, ...rest);
      };
      let m;
      try {
        m = await call("POST", `/ledger/accounts/${a.id}/merge`, T, { intoId: b.id });
      } finally {
        prisma.$transaction = real;
      }
      eq(hooked, true, "the merge's transaction");
      same([m.status, m.body.code], [409, "ACCOUNT_CHANGED"], JSON.stringify(m.body));
      eq(await prisma.ledgerAccount.count({ where: { id: a.id } }), 1, "nothing moved");
      eq(await prisma.manualJournalLine.count({ where: { journalId: j.id } }), 2, "the line went with it");
      eq((await call("POST", `/ledger/accounts/${a.id}/merge`, T, { intoId: b.id })).status, 200, "tried again");
    });

    section("Release 2: starting balances and the lock date");
    await test("never on or before the lock date, nor moved or cleared off a locked day; after it, saved", async () => {
      const B = await ownBusiness("Locked opening");
      const CASH = sysIn(B, "cash");
      const put = (date, debit = 1000) => call("PUT", "/ledger/opening-balances", T, {
        businessId: B.b.id, date, lines: debit ? [{ accountId: CASH.id, debit, credit: 0 }] : [],
      });
      const lock = (day) => prisma.business.update({ where: { id: B.b.id }, data: { booksLockDate: day } });
      await lock("2026-06-30");
      let r = await put("2026-06-30");
      same([r.status, r.body.code, r.body.lockDate], [409, "BOOKS_LOCKED", "2026-06-30"], JSON.stringify(r.body));
      eq(r.body.error, "The books are locked up to 2026-06-30. Nothing dated on or before that day can be added, changed or removed.");
      eq((await put("2026-01-01")).body.code, "BOOKS_LOCKED", "well before it");
      same([(await prisma.business.findUnique({ where: { id: B.b.id } })).openingBalanceDate, await prisma.openingBalance.count({ where: { businessId: B.b.id } })], [null, 0], "nothing saved");
      eq((await put("2026-07-01")).status, 200, "the day after it");
      await lock("2026-07-15");
      eq((await put("2026-08-01")).body.code, "BOOKS_LOCKED", "moved off a locked day");
      eq((await put("2026-07-01", 2000)).body.code, "BOOKS_LOCKED", "changed on it");
      eq((await put("2026-07-01", 0)).body.code, "BOOKS_LOCKED", "cleared");
      const g = await call("GET", `/ledger/opening-balances?${B.bq}`, T);
      same([g.status, g.body.date, g.body.lines.map((l) => l.debit)], [200, "2026-07-01", [1000]], "as saved, and still read");
      await lock(null);
      eq((await put("2026-08-01", 3000)).status, 200, "unlocked");
      eq((await call("PUT", "/ledger/opening-balances", T, { businessId: B.b.id, date: "2026-08-01", lines: [{ debit: 5, credit: 0 }] })).body.code, "ACCOUNT_REQUIRED", "a balance with no account");
    });

    section("Release 2: the backfill, one owner at a time");
    await test("a payable becomes an estimated bill, an expense on credit an unpaid bill, a customer gets a business; a dry run writes nothing; a second run changes nothing", async () => {
      const { backfillR2 } = require("./backfill-r2");
      const o = await mkUser({ email: `coa-bf-${tag}@t.local`, firstName: "Bf", accountType: "OWNER" });
      const ob = await prisma.business.create({ data: { userId: o.id, name: `Bf ${tag}`, country: "NG", baseCurrency: "NGN" } });
      const oT = signToken({ userId: o.id, tokenVersion: 0 });
      const list = (await call("GET", `/ledger/accounts?businessId=${ob.id}`, oT)).body.accounts;
      const rent = list.find((a) => a.categorySlug === "rent");
      const cust = await prisma.customer.create({ data: { userId: o.id, name: `Bf ${tag}` } });
      const payable = await prisma.businessDebt.create({
        data: { userId: o.id, businessId: ob.id, name: "Landlord", type: "rent", originalAmount: 10000, remainingAmount: 4000, status: "partial" },
      });
      const onCredit = await prisma.expense.create({
        data: { userId: o.id, businessId: ob.id, amount: 3000, category: "rent", paymentMethod: "credit", date: at("2026-09-09"), notes: "Shop rent" },
      });
      const state = async () => JSON.stringify([
        await prisma.customer.findMany({ where: { userId: o.id }, select: { id: true, businessId: true } }),
        await prisma.businessDebt.findMany({ where: { userId: o.id }, orderBy: { id: "asc" }, include: { payments: true } }),
        await prisma.expense.findMany({ where: { userId: o.id }, select: { id: true } }),
      ]);
      const log = () => {};
      const s0 = await state();
      const dry = await backfillR2({ dryRun: true, ownerId: o.id, log });
      eq(await state(), s0, "the dry run wrote nothing");
      same([dry.customers.assigned, dry.payables.converted, dry.creditExpenses.converted, dry.creditExpenses.bills], [1, 1, 1, 1]);
      const run = await backfillR2({ ownerId: o.id, log });
      same([run.customers.assigned, run.payables.converted, run.payables.paidOutside, run.creditExpenses.bills], [1, 1, 1, 1]);
      eq((await prisma.customer.findUnique({ where: { id: cust.id } })).businessId, ob.id, "the owner's only business");
      const p = await prisma.businessDebt.findUnique({ where: { id: payable.id }, include: { payments: true } });
      same([p.accountId, p.estimated, p.remainingAmount, p.payments.map((x) => [x.amount, x.outsideBooks, x.estimated, x.method])],
        [rent.id, true, 4000, [[6000, true, true, "other"]]], "the payable");
      eq(await prisma.expense.count({ where: { id: onCredit.id } }), 0, "the expense went");
      const made = await prisma.businessDebt.findFirst({ where: { userId: o.id, id: { not: payable.id } } });
      same([made.name, made.accountId, made.originalAmount, made.status, made.estimated, made.billDate.toISOString()],
        ["Shop rent", rent.id, 3000, "unpaid", false, onCredit.date.toISOString()], "its bill");
      const s1 = await state();
      const again = await backfillR2({ ownerId: o.id, log });
      eq(await state(), s1, "the second run wrote nothing");
      same([again.customers.assigned, again.payables.converted, again.creditExpenses.converted], [0, 0, 0]);
      invalidateOwner(o.id);
      const home = await call("GET", `/ledger/summary?businessId=${ob.id}`, oT);
      eq(home.body.youOwe, 4000 + 3000, "You owe: what the payable still owes and the bill the expense became");
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
