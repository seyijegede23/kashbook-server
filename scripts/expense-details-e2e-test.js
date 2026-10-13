// Zoho-style expenses end to end (2026-10-12): the expense routes over HTTP,
// real Postgres, real login tokens, with Cloudinary replaced by an in-memory
// store through the seam in utils/receiptStorage.js. Nothing leaves the
// machine, and the test checks the options every upload and removal gets.
//
// An itemized expense keeps its lines, their sum and the first line's
// category; the books count only its spending lines and the ledger ties out;
// an edit replaces the lines and keeps a linked transfer's matchedAmount equal
// to the new total, never above the transfer, and takes no paid-through
// account there; an older app's category edit; every refusal; an edit keeps
// the accounts the expense names already, even one made inactive since; a
// refused account names the field that sent it (a sale's too); account
// statements show each record's memo; a reference and
// a customer on an expense recorded from a transfer; receipts (five, then 409;
// a ten-minute link; removal, also with the expense; kept through a late
// failure; staff can't undo them away); accounts used only by a line (a merge
// reaches every phone's next pull; expense writes wait for it); the sync
// bundle, the list and a retried create. No response carries a storage key.
//
//   TEST_DATABASE_URL=postgresql://postgres:<pw>@localhost:5432/kashbook_coa_e2e \
//     node scripts/expense-details-e2e-test.js
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
// Cloudinary is never called: uploads and removals go to the store below. A
// link is signed locally (no request), with these made-up credentials.
delete process.env.CLOUDINARY_URL;
process.env.CLOUDINARY_CLOUD_NAME = "e2e-cloud";
process.env.CLOUDINARY_API_KEY = "e2e-key";
process.env.CLOUDINARY_API_SECRET = "e2e-secret";

const assert = require("assert");
const http = require("http");
const express = require("express");
const prisma = require("../src/utils/db");
const { signToken } = require("../src/utils/jwt");
const { booksFor } = require("../src/utils/booksData");
const { computeRawLedger } = require("../src/utils/ledgerBalance");
const { invalidateOwner } = require("../src/utils/ledgerData");
const receiptStorage = require("../src/utils/receiptStorage");

// The in-memory Cloudinary. Every call is kept, so a test can say what was
// uploaded with which options and what was removed.
const cloud = { stored: new Map(), uploads: [], destroyed: [], failNext: false };
receiptStorage.storage.upload = async (file, options) => {
  cloud.uploads.push({ file, options });
  if (cloud.failNext) {
    cloud.failNext = false;
    throw new Error("e2e: the store is down");
  }
  const publicId = `${options.folder}/${options.public_id}`;
  cloud.stored.set(publicId, options);
  return { public_id: publicId, resource_type: options.resource_type, type: options.type, secure_url: `https://e2e.invalid/${publicId}` };
};
receiptStorage.storage.destroy = async (publicId, options) => {
  cloud.destroyed.push({ publicId, options });
  cloud.stored.delete(publicId);
  return { result: "ok" };
};

const app = express();
// The production limit (server.js): a receipt travels as base64 in JSON.
app.use(express.json({ limit: "10mb" }));
// As server.js does: a successful write clears the owner's cached ledgers.
app.use((req, res, next) => {
  if (req.method !== "GET") res.on("finish", () => res.statusCode < 400 && req.user && invalidateOwner(req.user.accountType === "staff" ? req.user.employerId : req.user.id));
  next();
});
app.use("/ledger", require("../src/routes/ledger"));
app.use("/expenses", require("../src/routes/expenses"));
app.use("/sales", require("../src/routes/sales"));
app.use("/customers", require("../src/routes/customers"));
app.use("/transactions", require("../src/routes/transactions"));
app.use("/sync", require("../src/routes/sync"));
app.use("/recurring-expenses", require("../src/routes/recurringExpenses").router);

let BASE;
// Every response, for the check at the end that none carried a storage key.
const responses = [];
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
        responses.push({ method, path, text: d });
        resolve({ status: res.statusCode, body: j, headers: res.headers });
      });
    });
    r.on("error", (e) => resolve({ status: 0, body: { error: e.message }, headers: {} }));
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
const round2 = (n) => Math.round(n * 100) / 100;
// Removals run after the response (best effort); let them settle.
const settle = () => new Promise((r) => setImmediate(r));

// Files the upload guard accepts (or not), by their real bytes.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 9)]);
const PDF = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n", "latin1");
const PDF_WITH_SCRIPT = Buffer.from("%PDF-1.4\n1 0 obj << /OpenAction << /S /JavaScript /JS (app.alert(1)) >> >> endobj\n%%EOF\n", "latin1");
const uri = (mime, buf) => `data:${mime};base64,${buf.toString("base64")}`;

(async () => {
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  BASE = `http://127.0.0.1:${server.address().port}`;
  console.log(`\nZOHO-STYLE EXPENSES, END TO END\n${BASE}`);

  const mkUser = (data) => prisma.user.create({
    data: { password: "x", lastName: "T", businessName: "B", country: "NG", currency: "NGN", ...data },
  });
  const owner = await mkUser({ email: `exp-${tag}@t.local`, firstName: "Ada", accountType: "OWNER" });
  const rival = await mkUser({ email: `exp-rival-${tag}@t.local`, firstName: "Rival", accountType: "OWNER" });
  const biz = await prisma.business.create({ data: { userId: owner.id, name: `Exp ${tag}`, country: "NG", baseCurrency: "NGN" } });
  const biz2 = await prisma.business.create({ data: { userId: owner.id, name: `Exp second ${tag}`, country: "NG", baseCurrency: "NGN" } });
  const rivalBiz = await prisma.business.create({ data: { userId: rival.id, name: `Exp rival ${tag}`, country: "NG", baseCurrency: "NGN" } });
  const T = signToken({ userId: owner.id, tokenVersion: 0 });
  const TR = signToken({ userId: rival.id, tokenVersion: 0 });
  const staffWith = async (name, grants) => {
    const s = await mkUser({ email: `exp-${name}-${tag}@t.local`, firstName: name, accountType: "STAFF", employerId: owner.id });
    await prisma.staffPermission.create({ data: { userId: s.id, employerId: owner.id, grantedById: owner.id, ...grants } });
    return signToken({ userId: s.id, tokenVersion: 0 });
  };
  const tPlain = await staffWith("plain", {});
  const tBoth = await staffWith("both", { canViewReports: true, canViewBalance: true });
  const q = `businessId=${biz.id}`;
  const cust = await prisma.customer.create({ data: { userId: owner.id, businessId: biz.id, name: `Mrs Bello ${tag}` } });
  const looseCust = await prisma.customer.create({ data: { userId: owner.id, businessId: null, name: `No business ${tag}` } });
  const otherBizCust = await prisma.customer.create({ data: { userId: owner.id, businessId: biz2.id, name: `Second shop ${tag}` } });
  const rivalCust = await prisma.customer.create({ data: { userId: rival.id, businessId: rivalBiz.id, name: `Rival customer ${tag}` } });

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
  const views = ["paid", "sold"];
  const totals = async () => {
    const out = {};
    for (const basis of views) out[basis] = (await booksFor(biz.id, { from: today, to: today, basis })).expenses.total;
    return out;
  };
  // The ledger against the books rule, in both views, and the reports balance.
  const tiesOut = async () => {
    invalidateOwner(owner.id);
    for (const basis of views) {
      const pl = await call("GET", `/ledger/reports/profit-and-loss?${q}&basis=${basis}&from=${today}&to=${today}`, T);
      eq(pl.status, 200, JSON.stringify(pl.body));
      const b = await booksFor(biz.id, { from: today, to: today, basis });
      eq(Math.round(pl.body.totalExpenses * 100), Math.round(b.expenses.total * 100), `${basis} expenses`);
      eq(Math.round(pl.body.totalIncome * 100), Math.round(b.sales.total * 100), `${basis} income`);
    }
    eq((await call("GET", `/ledger/reports/balance-sheet?${q}`, T)).body.balanced, true, "balance sheet");
    eq((await call("GET", `/ledger/reports/trial-balance?${q}`, T)).body.balanced, true, "trial balance");
  };

  try {
    await refreshAccounts();
    const security = await call("POST", "/ledger/accounts", T, { businessId: biz.id, type: "expense", name: "Security Guard" });
    eq(security.status, 201, JSON.stringify(security.body));
    await refreshAccounts();
    const RENT = byName("Rent");
    const GEN = byName("Generators and Power Equipment");
    const GUARD = byName("Security Guard");

    section("An itemized expense");
    let split;
    let before;
    await test("it keeps its lines in order, their sum and the first line's category; an amount or account sent is ignored", async () => {
      before = await totals();
      const r = await call("POST", "/expenses", T, {
        businessId: biz.id, date: today, paymentMethod: "cash",
        // Ignored beside lines: Sales could never be an expense's account.
        amount: 1, accountId: bySys("sales").id, category: "anything",
        reference: "  INV-2231  ", customerId: cust.id,
        items: [
          { accountId: RENT.id, amount: 20000, description: " October rent " },
          { accountId: GEN.id, amount: "50000", description: "Generator" },
          { accountId: GUARD.id, amount: 3000.5 },
        ],
      });
      eq(r.status, 201, JSON.stringify(r.body));
      split = r.body;
      eq(split.amount, 73000.5, "the lines' sum");
      eq(split.accountId, null, "no account of its own");
      eq(split.category, "rent", "the first line's category, for older apps");
      eq(split.reference, "INV-2231");
      eq(split.customerId, cust.id);
      assert.deepStrictEqual(split.attachments, []);
      assert.deepStrictEqual(split.items.map((it) => it.position), [0, 1, 2]);
      assert.deepStrictEqual(split.items.map((it) => it.accountId), [RENT.id, GEN.id, GUARD.id]);
      assert.deepStrictEqual(split.items.map((it) => it.category), ["rent", "other", GUARD.categorySlug]);
      assert.deepStrictEqual(split.items.map((it) => it.description), ["October rent", "Generator", null]);
      assert.deepStrictEqual(split.items.map((it) => it.amount), [20000, 50000, 3000.5]);
      const rows = await prisma.expenseItem.findMany({ where: { expenseId: split.id }, orderBy: { position: "asc" } });
      eq(rows.length, 3, "stored lines");
      assert.deepStrictEqual(rows.map((x) => x.amount), [20000, 50000, 3000.5]);
    });
    await test("the books count its spending lines only, in both views (the generator is equipment)", async () => {
      const after = await totals();
      for (const basis of views) eq(round2(after[basis] - before[basis]), 23000.5, basis);
    });
    await test("the ledger ties out, and each line is an entry of its own", async () => {
      await tiesOut();
      // The business holds nothing else yet: profit and loss by account is
      // exactly the spending lines, in both views.
      for (const basis of views) {
        const pl = await call("GET", `/ledger/reports/profit-and-loss?${q}&basis=${basis}&from=${today}&to=${today}`, T);
        const byAccount = Object.fromEntries(pl.body.expenses.map((r) => [r.accountId, r.amount]));
        assert.deepStrictEqual(byAccount, { [RENT.id]: 20000, [GUARD.id]: 3000.5 }, `${basis}: rent and the guard, not the generator`);
      }
      const gen = split.items.find((it) => it.accountId === GEN.id);
      const st = await call("GET", `/ledger/accounts/${GEN.id}/transactions?${q}`, T);
      eq(st.body.lines.find((l) => l.id === `expense:${split.id}:${gen.id}`).amount, 50000, "equipment on the balance sheet");
      const cash = await call("GET", `/ledger/accounts/${bySys("cash").id}/transactions?${q}`, T);
      const mine = cash.body.lines.filter((l) => l.ref === split.id);
      eq(mine.length, 3, "three entries leave Cash at Hand");
      eq(round2(mine.reduce((s, l) => s + l.amount, 0)), -73000.5, "the whole amount");
    });

    section("Editing the lines of an expense recorded from a transfer");
    let debit;
    let fromTransfer;
    await test("a transfer recorded as an expense takes a reference and a customer", async () => {
      debit = await bankRow({ type: "expense", amount: 15000 });
      const r = await call("POST", `/transactions/${debit.id}/create-expense`, T, {
        category: "transport", reference: "  RCPT-77 ", customerId: cust.id,
      });
      eq(r.status, 201, JSON.stringify(r.body));
      fromTransfer = r.body.expense;
      eq(fromTransfer.reference, "RCPT-77");
      eq(fromTransfer.customerId, cust.id);
      assert.deepStrictEqual(fromTransfer.items, []);
      assert.deepStrictEqual(fromTransfer.attachments, []);
      eq(r.body.transaction.matchedAmount, 15000);
    });
    await test("new lines replace the old; the total follows them and so does the transfer's matchedAmount", async () => {
      const r = await call("PATCH", `/expenses/${fromTransfer.id}`, T, {
        amount: 999, items: [{ accountId: RENT.id, amount: 6000 }, { accountId: GEN.id, amount: 4000, description: "Spare generator" }],
      });
      eq(r.status, 200, JSON.stringify(r.body));
      eq(r.body.amount, 10000);
      eq(r.body.accountId, null);
      eq(r.body.category, "rent");
      eq(r.body.items.length, 2);
      eq((await prisma.transaction.findUnique({ where: { id: debit.id } })).matchedAmount, 10000);
      const more = await call("PATCH", `/expenses/${fromTransfer.id}`, T, {
        items: [{ accountId: GUARD.id, amount: 9000 }, { accountId: RENT.id, amount: 6000 }],
      });
      eq(more.status, 200, JSON.stringify(more.body));
      eq(more.body.amount, 15000, "up to the whole transfer");
      eq(more.body.category, GUARD.categorySlug);
      eq(await prisma.expenseItem.count({ where: { expenseId: fromTransfer.id } }), 2, "the old lines are gone");
      eq((await prisma.transaction.findUnique({ where: { id: debit.id } })).matchedAmount, 15000);
    });
    await test("lines above the transfer are refused, as on create-expense, and nothing changes", async () => {
      const r = await call("PATCH", `/expenses/${fromTransfer.id}`, T, {
        items: [{ accountId: GUARD.id, amount: 12000 }, { accountId: RENT.id, amount: 8000 }],
      });
      eq(r.status, 400, JSON.stringify(r.body));
      eq(r.body.code, "AMOUNT_EXCEEDS_TRANSFER");
      eq(r.body.field, "items");
      const row = await prisma.expense.findUnique({ where: { id: fromTransfer.id }, include: { items: { orderBy: { position: "asc" } } } });
      eq(row.amount, 15000, "the total stays");
      assert.deepStrictEqual(row.items.map((it) => it.amount), [9000, 6000], "the lines stay");
      eq((await prisma.transaction.findUnique({ where: { id: debit.id } })).matchedAmount, 15000);
    });
    await test("a change of lines alone moves the expense's updatedAt (incremental sync)", async () => {
      const was = (await prisma.expense.findUnique({ where: { id: fromTransfer.id } })).updatedAt;
      await new Promise((r) => setTimeout(r, 5));
      const r = await call("PATCH", `/expenses/${fromTransfer.id}`, T, {
        items: [{ accountId: GUARD.id, amount: 9000, description: "Night guard" }, { accountId: RENT.id, amount: 6000 }],
      });
      eq(r.status, 200);
      const now = (await prisma.expense.findUnique({ where: { id: fromTransfer.id } })).updatedAt;
      assert.ok(now > was, "updatedAt moved");
    });
    await test("while it has lines, a different amount, an account or another category is refused; the same ones pass", async () => {
      for (const body of [{ amount: 12000 }, { accountId: RENT.id }, { category: "fuel" }]) {
        const r = await call("PATCH", `/expenses/${fromTransfer.id}`, T, body);
        eq(r.status, 409, JSON.stringify(body));
        eq(r.body.code, "EXPENSE_ITEMIZED");
      }
      const same = await call("PATCH", `/expenses/${fromTransfer.id}`, T, { amount: 15000, category: GUARD.categorySlug, accountId: null, notes: "kept" });
      eq(same.status, 200, JSON.stringify(same.body));
      eq(same.body.notes, "kept");
      eq(same.body.items.length, 2, "the lines stay");
    });
    await test("an empty list makes it whole again, and then its amount and account apply", async () => {
      const r = await call("PATCH", `/expenses/${fromTransfer.id}`, T, { items: [], amount: 12000, accountId: RENT.id });
      eq(r.status, 200, JSON.stringify(r.body));
      assert.deepStrictEqual(r.body.items, []);
      eq(r.body.amount, 12000);
      eq(r.body.accountId, RENT.id);
      eq(r.body.category, "rent");
      eq(await prisma.expenseItem.count({ where: { expenseId: fromTransfer.id } }), 0);
      eq((await prisma.transaction.findUnique({ where: { id: debit.id } })).matchedAmount, 12000);
      // A whole amount above the transfer is refused the same way.
      const above = await call("PATCH", `/expenses/${fromTransfer.id}`, T, { amount: 15000.01 });
      eq(above.status, 400, JSON.stringify(above.body));
      eq(above.body.code, "AMOUNT_EXCEEDS_TRANSFER");
      eq(above.body.field, "amount");
      eq((await prisma.expense.findUnique({ where: { id: fromTransfer.id } })).amount, 12000);
      // Split again, and leave it split for the checks below.
      const again = await call("PATCH", `/expenses/${fromTransfer.id}`, T, { items: [{ accountId: RENT.id, amount: 9000 }, { accountId: GEN.id, amount: 1000 }] });
      eq(again.body.amount, 10000);
      eq((await prisma.transaction.findUnique({ where: { id: debit.id } })).matchedAmount, 10000);
    });
    await test("a reference and a customer change and clear on an edit", async () => {
      const set = await call("PATCH", `/expenses/${fromTransfer.id}`, T, { reference: " PO-5 ", customerId: looseCust.id });
      eq(set.status, 200, JSON.stringify(set.body));
      eq(set.body.reference, "PO-5");
      eq(set.body.customerId, looseCust.id, "a customer with no business yet is allowed");
      const cleared = await call("PATCH", `/expenses/${fromTransfer.id}`, T, { reference: "", customerId: null });
      eq(cleared.body.reference, null);
      eq(cleared.body.customerId, null);
      eq((await call("PATCH", `/expenses/${fromTransfer.id}`, T, { reference: "x".repeat(101) })).body.code, "REFERENCE_TOO_LONG");
      eq((await call("PATCH", `/expenses/${fromTransfer.id}`, T, { customerId: rivalCust.id })).body.code, "CUSTOMER_NOT_FOUND");
    });
    await test("an expense recorded from a transfer takes no paid-through account; clearing one passes", async () => {
      const r = await call("PATCH", `/expenses/${fromTransfer.id}`, T, { paidThroughAccountId: bySys("cash").id });
      eq(r.status, 409, JSON.stringify(r.body));
      eq(r.body.code, "LOCKED_BY_TRANSFER");
      eq((await prisma.expense.findUnique({ where: { id: fromTransfer.id } })).paidThroughAccountId, null);
      const cleared = await call("PATCH", `/expenses/${fromTransfer.id}`, T, { paidThroughAccountId: null, notes: "Paid by transfer" });
      eq(cleared.status, 200, JSON.stringify(cleared.body));
      eq(cleared.body.paidThroughAccountId, null);
    });
    await test("an older expense already above its transfer still takes an edit; a new total must fit", async () => {
      // Saved before the rule: ₦5,000 on a ₦3,000 transfer.
      const d = await bankRow({ type: "expense", amount: 3000 });
      const old = await prisma.expense.create({
        data: {
          userId: owner.id, businessId: biz.id, amount: 5000, category: "rent", paymentMethod: "transfer", date: new Date(),
          matchedTransactionId: d.id,
        },
      });
      await prisma.transaction.update({ where: { id: d.id }, data: { matchedExpenseId: old.id, matchedAmount: 3000 } });
      // The live app sends every field back on an edit, the amount unchanged.
      const notes = await call("PATCH", `/expenses/${old.id}`, T, { amount: 5000, category: "rent", notes: "Shop rent" });
      eq(notes.status, 200, JSON.stringify(notes.body));
      eq(notes.body.notes, "Shop rent");
      eq((await call("PATCH", `/expenses/${old.id}`, T, { amount: 4000 })).body.code, "AMOUNT_EXCEEDS_TRANSFER");
      const fits = await call("PATCH", `/expenses/${old.id}`, T, { amount: 3000 });
      eq(fits.status, 200, JSON.stringify(fits.body));
      eq((await prisma.transaction.findUnique({ where: { id: d.id } })).matchedAmount, 3000);
      eq((await call("DELETE", `/expenses/${old.id}`, T)).status, 200);
    });
    await test("an older app's other category on an expense that names an account moves it to that category", async () => {
      const x = await call("POST", "/expenses", T, { businessId: biz.id, date: today, amount: 900, accountId: RENT.id });
      eq(x.status, 201, JSON.stringify(x.body));
      eq(x.body.accountId, RENT.id);
      // The live app's edit: every field, a category, never an account.
      const r = await call("PATCH", `/expenses/${x.body.id}`, T, { amount: 900, category: "marketing", notes: "Flyers", paymentMethod: "cash", date: today });
      eq(r.status, 200, JSON.stringify(r.body));
      eq(r.body.category, "marketing");
      eq(r.body.accountId, null, "the old account goes, so the books follow the category");
      invalidateOwner(owner.id);
      const pl = await call("GET", `/ledger/reports/profit-and-loss?${q}&basis=paid&from=${today}&to=${today}`, T);
      eq(pl.body.expenses.find((e) => e.accountId === byName("Advertising and Marketing").id).amount, 900, "counted as marketing");
      // The same category sent back keeps the account the expense names.
      eq((await call("PATCH", `/expenses/${x.body.id}`, T, { accountId: GUARD.id })).body.accountId, GUARD.id);
      const same = await call("PATCH", `/expenses/${x.body.id}`, T, { amount: 900, category: GUARD.categorySlug, notes: "Guard" });
      eq(same.body.accountId, GUARD.id);
      eq((await call("DELETE", `/expenses/${x.body.id}`, T)).status, 200);
    });
    await test("the same for a recurring expense: another category with no account leaves its old account", async () => {
      const rule = await call("POST", "/recurring-expenses", T, {
        businessId: biz.id, amount: 15000, frequency: "monthly", accountId: RENT.id, startDate: "2099-01-01",
      });
      eq(rule.status, 201, JSON.stringify(rule.body));
      eq(rule.body.accountId, RENT.id);
      const kept = await call("PATCH", `/recurring-expenses/${rule.body.id}`, T, { category: "rent", amount: 15000 });
      eq(kept.body.accountId, RENT.id, "the same category keeps it");
      const moved = await call("PATCH", `/recurring-expenses/${rule.body.id}`, T, { category: "marketing", amount: 15000 });
      eq(moved.status, 200, JSON.stringify(moved.body));
      eq(moved.body.category, "marketing");
      eq(moved.body.accountId, null);
      await prisma.recurringExpense.delete({ where: { id: rule.body.id } });
    });
    await test("a recurring expense is never on credit (release 2: that is a bill), nor any method the app does not offer", async () => {
      const count0 = await prisma.recurringExpense.count({ where: { businessId: biz.id } });
      for (const paymentMethod of ["credit", "barter", "Credit"]) {
        const r = await call("POST", "/recurring-expenses", T, {
          businessId: biz.id, amount: 5000, frequency: "monthly", paymentMethod, startDate: "2099-01-01",
        });
        eq(r.status, 400, paymentMethod);
        eq(r.body.code, "BAD_METHOD");
        eq(r.body.field, "paymentMethod");
      }
      eq(await prisma.recurringExpense.count({ where: { businessId: biz.id } }), count0, "nothing saved");
      const rule = await call("POST", "/recurring-expenses", T, {
        businessId: biz.id, amount: 5000, frequency: "monthly", paymentMethod: "transfer", startDate: "2099-01-01",
      });
      eq(rule.status, 201, JSON.stringify(rule.body));
      const onCredit = await call("PATCH", `/recurring-expenses/${rule.body.id}`, T, { paymentMethod: "credit" });
      eq(onCredit.status, 400);
      eq(onCredit.body.code, "BAD_METHOD");
      eq((await prisma.recurringExpense.findUnique({ where: { id: rule.body.id } })).paymentMethod, "transfer", "unchanged");
      eq((await call("PATCH", `/recurring-expenses/${rule.body.id}`, T, { paymentMethod: "pos" })).body.paymentMethod, "pos");
      // An amount that is not above zero, or not a number, records nothing.
      for (const amount of [-5, 0, "abc", "-1"]) {
        const r = await call("POST", "/recurring-expenses", T, { businessId: biz.id, amount, frequency: "monthly", startDate: "2099-01-01" });
        eq(r.status, 400, `POST ${amount}`);
        eq(r.body.code, "BAD_AMOUNT");
        const p = await call("PATCH", `/recurring-expenses/${rule.body.id}`, T, { amount });
        eq(p.status, 400, `PATCH ${amount}`);
      }
      eq((await prisma.recurringExpense.findUnique({ where: { id: rule.body.id } })).amount, 5000, "the amount unchanged");
      eq((await call("PATCH", `/recurring-expenses/${rule.body.id}`, T, { amount: "7500" })).body.amount, 7500, "a numeric string is a number");
      await prisma.recurringExpense.delete({ where: { id: rule.body.id } });
    });
    await test("an expense is never put on credit (a bill instead); one saved on credit before bills may keep it", async () => {
      const count0 = await prisma.expense.count({ where: { businessId: biz.id } });
      const r = await call("POST", "/expenses", T, { businessId: biz.id, amount: 2500, category: "rent", paymentMethod: "credit", date: today });
      eq(r.status, 400, JSON.stringify(r.body));
      eq(r.body.code, "CREDIT_IS_A_BILL");
      eq(r.body.field, "paymentMethod");
      eq(await prisma.expense.count({ where: { businessId: biz.id } }), count0, "nothing saved");
      const cash = await call("POST", "/expenses", T, { businessId: biz.id, amount: 2500, category: "rent", paymentMethod: "cash", date: today });
      eq(cash.status, 201, JSON.stringify(cash.body));
      const moved = await call("PATCH", `/expenses/${cash.body.id}`, T, { paymentMethod: "credit" });
      eq(moved.status, 400);
      eq(moved.body.code, "CREDIT_IS_A_BILL");
      eq((await prisma.expense.findUnique({ where: { id: cash.body.id } })).paymentMethod, "cash", "unchanged");
      // One from before bills keeps its method through an edit of something else.
      const old = await prisma.expense.create({
        data: { userId: owner.id, businessId: biz.id, amount: 1800, category: "rent", paymentMethod: "credit", date: new Date() },
      });
      const kept = await call("PATCH", `/expenses/${old.id}`, T, { notes: "From before bills", paymentMethod: "credit" });
      eq(kept.status, 200, JSON.stringify(kept.body));
      eq((await call("PATCH", `/expenses/${old.id}`, T, { paymentMethod: "transfer" })).body.paymentMethod, "transfer");
      for (const id of [cash.body.id, old.id]) eq((await call("DELETE", `/expenses/${id}`, T)).status, 200);
    });
    await test("the books still tie out after the edits", tiesOut);

    section("Refusals");
    await test("each refusal names its code, its field and its line, and nothing is saved", async () => {
      const count0 = await prisma.expense.count({ where: { businessId: biz.id } });
      const rivalAcc = (await call("GET", `/ledger/accounts?businessId=${rivalBiz.id}`, TR)).body.accounts.find((a) => a.name === "Rent");
      const line = (over) => ({ accountId: RENT.id, amount: 100, ...over });
      const cases = [
        [{ items: [line(), line({ accountId: rivalAcc.id })] }, 400, "ACCOUNT_NOT_FOUND", 1],
        [{ items: [line({ accountId: bySys("sales").id })] }, 400, "ACCOUNT_NOT_ALLOWED", 0],
        [{ items: [line({ accountId: bySys("kashbook").id })] }, 400, "ACCOUNT_NOT_ALLOWED", 0],
        [{ items: [line(), line(), line({ accountId: undefined })] }, 400, "ITEM_ACCOUNT_REQUIRED", 2],
        [{ items: [line({ amount: 0 })] }, 400, "BAD_ITEM_AMOUNT", 0],
        [{ items: [line({ amount: -5 })] }, 400, "BAD_ITEM_AMOUNT", 0],
        [{ items: [line({ amount: 10.005 })] }, 400, "BAD_ITEM_AMOUNT", 0],
        // Specks that would round to ₦0 (the database refuses a line of 0).
        [{ items: [line({ amount: 1e-15 })] }, 400, "BAD_ITEM_AMOUNT", 0],
        [{ items: [line({ amount: 100 }), line({ amount: 4e-15 })] }, 400, "BAD_ITEM_AMOUNT", 1],
        [{ items: [line({ amount: "abc" })] }, 400, "BAD_ITEM_AMOUNT", 0],
        [{ items: [line({ amount: null })] }, 400, "BAD_ITEM_AMOUNT", 0],
        [{ items: [line({ description: "d".repeat(201) })] }, 400, "ITEM_DESCRIPTION_TOO_LONG", 0],
        [{ items: [line(), "rent"] }, 400, "BAD_ITEMS", 1],
        [{ items: Array.from({ length: 51 }, () => line()) }, 400, "TOO_MANY_ITEMS"],
        [{ amount: 100, items: "rent" }, 400, "BAD_ITEMS"],
        [{ items: [line()], reference: "r".repeat(101) }, 400, "REFERENCE_TOO_LONG"],
        [{ items: [line()], reference: { no: 1 } }, 400, "BAD_REFERENCE"],
        [{ items: [line()], customerId: rivalCust.id }, 400, "CUSTOMER_NOT_FOUND"],
        [{ items: [line()], customerId: otherBizCust.id }, 400, "CUSTOMER_NOT_FOUND"],
        [{ amount: 100, customerId: rivalCust.id }, 400, "CUSTOMER_NOT_FOUND"],
      ];
      for (const [body, status, code, lineNo] of cases) {
        const r = await call("POST", "/expenses", T, { businessId: biz.id, date: today, ...body });
        eq(r.status, status, `${code}: ${JSON.stringify(r.body)}`);
        eq(r.body.code, code);
        if (lineNo !== undefined) {
          eq(r.body.field, "items", code);
          eq(r.body.line, lineNo, `${code} line`);
        }
      }
      const noBusiness = await call("POST", "/expenses", T, { date: today, items: [line()] });
      eq(noBusiness.body.code, "BUSINESS_REQUIRED");
      eq(await prisma.expense.count({ where: { businessId: biz.id } }), count0, "nothing saved");
      const speck = await call("PATCH", `/expenses/${split.id}`, T, { items: [line(), line({ amount: 1e-15 })] });
      eq(speck.status, 400, JSON.stringify(speck.body));
      eq(speck.body.code, "BAD_ITEM_AMOUNT");
      eq(await prisma.expenseItem.count({ where: { expenseId: split.id } }), 3, "the lines stay");
    });
    await test("an inactive account is refused on a line", async () => {
      const prepaid = byName("Prepaid Expenses");
      eq((await call("PATCH", `/ledger/accounts/${prepaid.id}`, T, { inactive: true })).status, 200);
      const r = await call("POST", "/expenses", T, { businessId: biz.id, items: [{ accountId: prepaid.id, amount: 50 }] });
      eq(r.body.code, "ACCOUNT_NOT_ALLOWED");
      eq((await call("PATCH", `/ledger/accounts/${prepaid.id}`, T, { inactive: false })).status, 200);
    });
    await test("the edges pass: 50 lines, a 200-character description, a 100-character reference", async () => {
      const r = await call("POST", "/expenses", T, {
        businessId: biz.id, date: today, reference: ` ${"r".repeat(100)} `,
        items: Array.from({ length: 50 }, (_, i) => ({ accountId: i % 2 ? RENT.id : GUARD.id, amount: 0.01, description: i ? undefined : "d".repeat(200) })),
      });
      eq(r.status, 201, JSON.stringify(r.body).slice(0, 200));
      eq(r.body.items.length, 50);
      eq(r.body.amount, 0.5);
      eq(r.body.reference.length, 100);
      eq((await call("DELETE", `/expenses/${r.body.id}`, T)).status, 200);
    });
    await test("staff can't record or edit an expense, nor put one recorded from a transfer on the owner's equity", async () => {
      eq((await call("POST", "/expenses", tBoth, { businessId: biz.id, items: [{ accountId: RENT.id, amount: 10 }] })).status, 403);
      eq((await call("PATCH", `/expenses/${split.id}`, tBoth, { items: [{ accountId: RENT.id, amount: 10 }] })).status, 403);
      const d = await bankRow({ type: "expense", amount: 2500 });
      const r = await call("POST", `/transactions/${d.id}/create-expense`, tBoth, { accountId: bySys("drawings").id });
      eq(r.status, 403, JSON.stringify(r.body));
      eq(r.body.code, "OWNER_ONLY");
      eq((await prisma.transaction.findUnique({ where: { id: d.id } })).matchedExpenseId, null, "still unexplained");
      const ok = await call("POST", `/transactions/${d.id}/create-expense`, tBoth, { reference: "STAFF-1", customerId: cust.id });
      eq(ok.status, 201, JSON.stringify(ok.body));
      eq(ok.body.expense.reference, "STAFF-1");
    });
    await test("an expense recorded from a transfer refuses a long reference or a foreign customer, and the transfer stays free", async () => {
      const d = await bankRow({ type: "expense", amount: 3000 });
      const long = await call("POST", `/transactions/${d.id}/create-expense`, T, { reference: "x".repeat(101) });
      eq(long.status, 400);
      eq(long.body.code, "REFERENCE_TOO_LONG");
      eq(long.body.field, "reference");
      const foreign = await call("POST", `/transactions/${d.id}/create-expense`, T, { customerId: rivalCust.id });
      eq(foreign.body.code, "CUSTOMER_NOT_FOUND");
      eq((await prisma.transaction.findUnique({ where: { id: d.id } })).matchedExpenseId, null);
    });

    section("An edit keeps the accounts the expense names already");
    // A split expense with a line on an account the owner has since made
    // inactive. The app sends every line when any one changes, that one
    // untouched, so an account the expense names already is taken as it is
    // (routes/expenses.js accountsNamedBy): the expense still saves and the
    // line keeps counting where it did. Only an account new to the expense
    // must be one an expense may use now. In a business of its own, so
    // nothing else here moves.
    const keptBiz = await prisma.business.create({ data: { userId: owner.id, name: `Exp kept ${tag}`, country: "NG", baseCurrency: "NGN" } });
    const kq = `businessId=${keptBiz.id}`;
    for (const name of ["Diesel Runs", "Dispatch Riders"]) {
      const made = await call("POST", "/ledger/accounts", T, { businessId: keptBiz.id, type: "expense", name });
      eq(made.status, 201, `${name}: ${JSON.stringify(made.body)}`);
    }
    const keptChart = (await call("GET", `/ledger/accounts?${kq}`, T)).body.accounts;
    const DIESEL = keptChart.find((a) => a.name === "Diesel Runs");
    const RIDERS = keptChart.find((a) => a.name === "Dispatch Riders");
    const KRENT = keptChart.find((a) => a.name === "Rent");
    const setInactive = async (acc, inactive) =>
      eq((await call("PATCH", `/ledger/accounts/${acc.id}`, T, { inactive })).status, 200, `${acc.name} inactive: ${inactive}`);
    const keptMade = await call("POST", "/expenses", T, {
      businessId: keptBiz.id, date: today, paymentMethod: "cash",
      items: [{ accountId: DIESEL.id, amount: 1000 }, { accountId: KRENT.id, amount: 2000 }],
    });
    eq(keptMade.status, 201, JSON.stringify(keptMade.body));
    const kx = keptMade.body.id;
    await setInactive(DIESEL, true);
    await setInactive(RIDERS, true);
    const linesOf = (r) =>
      r.body && r.body.items ? r.body.items.map((i) => [i.accountId, i.amount, i.category, i.description, i.position]) : r.body;
    await test("editing only another line passes; the line on the inactive account keeps it and still counts there", async () => {
      const r = await call("PATCH", `/expenses/${kx}`, T, {
        items: [{ accountId: DIESEL.id, amount: 1000 }, { accountId: KRENT.id, amount: 2500, description: "  Shop rent  " }],
        amount: 3500, category: DIESEL.categorySlug,
      });
      eq(r.status, 200, JSON.stringify(r.body));
      eq(r.body.amount, 3500);
      eq(r.body.accountId, null);
      eq(r.body.category, DIESEL.categorySlug, "the first line's category");
      assert.deepStrictEqual(linesOf(r), [
        [DIESEL.id, 1000, DIESEL.categorySlug, null, 0],
        [KRENT.id, 2500, "rent", "Shop rent", 1],
      ]);
      const rows = await prisma.expenseItem.findMany({ where: { expenseId: kx }, orderBy: { position: "asc" } });
      assert.deepStrictEqual(rows.map((x) => [x.accountId, x.amount, x.category, x.description]), [
        [DIESEL.id, 1000, DIESEL.categorySlug, null],
        [KRENT.id, 2500, "rent", "Shop rent"],
      ]);
      invalidateOwner(owner.id);
      for (const basis of views) {
        const pl = await call("GET", `/ledger/reports/profit-and-loss?${kq}&basis=${basis}&from=${today}&to=${today}`, T);
        const byAccount = Object.fromEntries(pl.body.expenses.map((e) => [e.accountId, e.amount]));
        assert.deepStrictEqual(byAccount, { [DIESEL.id]: 1000, [KRENT.id]: 2500 }, `${basis}: each line on its own account`);
      }
    });
    await test("the same lines sent back pass, and a line's amount sent as text is read to the kobo", async () => {
      const r = await call("PATCH", `/expenses/${kx}`, T, {
        items: [{ accountId: DIESEL.id, amount: " 1000.50 " }, { accountId: KRENT.id, amount: 2500 }],
      });
      eq(r.status, 200, JSON.stringify(r.body));
      eq(r.body.amount, 3500.5);
      eq(r.body.items[0].amount, 1000.5);
    });
    await test("a line added on an active account passes, and another on the inactive account the expense names", async () => {
      const r = await call("PATCH", `/expenses/${kx}`, T, {
        items: [
          { accountId: DIESEL.id, amount: 1000 }, { accountId: KRENT.id, amount: 2500 },
          { accountId: KRENT.id, amount: 1 }, { accountId: DIESEL.id, amount: 2 },
        ],
      });
      eq(r.status, 200, JSON.stringify(r.body));
      eq(r.body.items.length, 4);
      eq(r.body.amount, 3503);
    });
    await test("an inactive account new to the expense is refused, before or after the kept line, naming its line; nothing changes", async () => {
      const was = await prisma.expenseItem.findMany({ where: { expenseId: kx }, orderBy: { position: "asc" } });
      const after = await call("PATCH", `/expenses/${kx}`, T, {
        items: [{ accountId: DIESEL.id, amount: 1000 }, { accountId: KRENT.id, amount: 2500 }, { accountId: RIDERS.id, amount: 5 }],
      });
      eq(after.status, 400, JSON.stringify(after.body));
      eq(after.body.code, "ACCOUNT_NOT_ALLOWED");
      eq(after.body.field, "items");
      eq(after.body.line, 2);
      const first = await call("PATCH", `/expenses/${kx}`, T, {
        items: [{ accountId: RIDERS.id, amount: 5 }, { accountId: DIESEL.id, amount: 1000 }],
      });
      eq(first.status, 400, JSON.stringify(first.body));
      eq(first.body.code, "ACCOUNT_NOT_ALLOWED");
      eq(first.body.field, "items");
      eq(first.body.line, 0);
      const now = await prisma.expenseItem.findMany({ where: { expenseId: kx }, orderBy: { position: "asc" } });
      assert.deepStrictEqual(now.map((x) => x.id), was.map((x) => x.id), "the lines stay");
    });
    await test("a malformed line on the kept account is still refused for its shape", async () => {
      for (const [line, code] of [
        [{ accountId: DIESEL.id, amount: "abc" }, "BAD_ITEM_AMOUNT"],
        [{ accountId: DIESEL.id, amount: 0 }, "BAD_ITEM_AMOUNT"],
        [{ accountId: DIESEL.id, amount: 10.005 }, "BAD_ITEM_AMOUNT"],
        [{ accountId: DIESEL.id, amount: 5, description: "d".repeat(201) }, "ITEM_DESCRIPTION_TOO_LONG"],
        [{ accountId: DIESEL.id, amount: 5, description: 7 }, "BAD_ITEMS"],
      ]) {
        const r = await call("PATCH", `/expenses/${kx}`, T, { items: [{ accountId: KRENT.id, amount: 1 }, line] });
        eq(r.status, 400, `${code}: ${JSON.stringify(r.body)}`);
        eq(r.body.code, code);
        eq(r.body.line, 1, `${code} line`);
      }
    });
    await test("another business's account is still refused on a line, naming its line", async () => {
      const rivalRent = (await call("GET", `/ledger/accounts?businessId=${rivalBiz.id}`, TR)).body.accounts.find((a) => a.name === "Rent");
      const r = await call("PATCH", `/expenses/${kx}`, T, {
        items: [{ accountId: DIESEL.id, amount: 1 }, { accountId: rivalRent.id, amount: 1 }],
      });
      eq(r.status, 400, JSON.stringify(r.body));
      eq(r.body.code, "ACCOUNT_NOT_FOUND");
      eq(r.body.field, "items");
      eq(r.body.line, 1);
    });
    await test("the split turned back into one account, the inactive one it names, passes", async () => {
      const r = await call("PATCH", `/expenses/${kx}`, T, { items: [], amount: 3500, accountId: DIESEL.id, category: DIESEL.categorySlug });
      eq(r.status, 200, JSON.stringify(r.body));
      assert.deepStrictEqual(r.body.items, []);
      eq(r.body.accountId, DIESEL.id);
      eq(r.body.amount, 3500);
      eq(r.body.category, DIESEL.categorySlug);
    });
    await test("a whole expense on its inactive account takes an edit naming it again", async () => {
      const r = await call("PATCH", `/expenses/${kx}`, T, { amount: 3600, accountId: DIESEL.id, notes: "again" });
      eq(r.status, 200, JSON.stringify(r.body));
      eq(r.body.accountId, DIESEL.id);
      eq(r.body.amount, 3600);
    });
    await test("a whole expense moved to another inactive account, new to it, is refused naming accountId", async () => {
      const r = await call("PATCH", `/expenses/${kx}`, T, { amount: 3600, accountId: RIDERS.id });
      eq(r.status, 400, JSON.stringify(r.body));
      eq(r.body.code, "ACCOUNT_NOT_ALLOWED");
      eq(r.body.field, "accountId");
      eq((await prisma.expense.findUnique({ where: { id: kx } })).accountId, DIESEL.id, "unchanged");
    });
    await test("splitting a whole expense whose own account is inactive passes", async () => {
      const r = await call("PATCH", `/expenses/${kx}`, T, {
        items: [{ accountId: DIESEL.id, amount: 1600 }, { accountId: KRENT.id, amount: 2000 }],
      });
      eq(r.status, 200, JSON.stringify(r.body));
      eq(r.body.accountId, null);
      eq(r.body.amount, 3600);
      assert.deepStrictEqual(r.body.items.map((i) => i.accountId), [DIESEL.id, KRENT.id]);
    });
    await test("while it has lines, the inactive account it names sent alone is the itemized refusal (409)", async () => {
      const r = await call("PATCH", `/expenses/${kx}`, T, { accountId: DIESEL.id });
      eq(r.status, 409, JSON.stringify(r.body));
      eq(r.body.code, "EXPENSE_ITEMIZED");
    });
    await test("once neither a line nor the expense names it, the inactive account is refused again", async () => {
      const drop = await call("PATCH", `/expenses/${kx}`, T, { items: [{ accountId: KRENT.id, amount: 3600 }] });
      eq(drop.status, 200, JSON.stringify(drop.body));
      const back = await call("PATCH", `/expenses/${kx}`, T, {
        items: [{ accountId: DIESEL.id, amount: 100 }, { accountId: KRENT.id, amount: 3500 }],
      });
      eq(back.status, 400, JSON.stringify(back.body));
      eq(back.body.code, "ACCOUNT_NOT_ALLOWED");
      eq(back.body.line, 0);
      const whole = await call("PATCH", `/expenses/${kx}`, T, { items: [], amount: 3600, accountId: DIESEL.id });
      eq(whole.status, 400, JSON.stringify(whole.body));
      eq(whole.body.code, "ACCOUNT_NOT_ALLOWED");
      eq(whole.body.field, "accountId");
    });
    await test("a new expense still refuses an inactive account, on a line or whole", async () => {
      const a = await call("POST", "/expenses", T, { businessId: keptBiz.id, items: [{ accountId: DIESEL.id, amount: 5 }] });
      eq(a.body.code, "ACCOUNT_NOT_ALLOWED");
      eq(a.body.line, 0);
      const b = await call("POST", "/expenses", T, { businessId: keptBiz.id, amount: 5, accountId: DIESEL.id });
      eq(b.body.code, "ACCOUNT_NOT_ALLOWED");
      eq(b.body.field, "accountId");
    });
    await test("an account made active again works everywhere again", async () => {
      await setInactive(DIESEL, false);
      const r = await call("PATCH", `/expenses/${kx}`, T, {
        items: [{ accountId: DIESEL.id, amount: 100 }, { accountId: KRENT.id, amount: 3500 }],
      });
      eq(r.status, 200, JSON.stringify(r.body));
    });

    section("A refused account names the field that sent it");
    // An app that sent a record with two accounts sends it again without the
    // one the server refused, instead of losing it (AppContext createRecord):
    // `field` says which one. A line of an itemized expense also says which
    // line (above).
    await test("a new expense names accountId or paidThroughAccountId, and nothing is saved", async () => {
      const count0 = await prisma.expense.count({ where: { businessId: biz.id } });
      const rivalCash = (await call("GET", `/ledger/accounts?businessId=${rivalBiz.id}`, TR)).body.accounts.find((a) => a.systemKey === "cash");
      const cases = [
        [{ accountId: bySys("sales").id }, "ACCOUNT_NOT_ALLOWED", "accountId"],
        [{ paidThroughAccountId: RENT.id }, "ACCOUNT_NOT_ALLOWED", "paidThroughAccountId"],
        [{ paidThroughAccountId: rivalCash.id }, "ACCOUNT_NOT_FOUND", "paidThroughAccountId"],
        // Both sent and only the money account refused: that one is named.
        [{ accountId: RENT.id, paidThroughAccountId: bySys("sales").id }, "ACCOUNT_NOT_ALLOWED", "paidThroughAccountId"],
        // Both refused: what the money was spent on is checked first.
        [{ accountId: bySys("sales").id, paidThroughAccountId: RENT.id }, "ACCOUNT_NOT_ALLOWED", "accountId"],
      ];
      for (const [body, code, field] of cases) {
        const r = await call("POST", "/expenses", T, { businessId: biz.id, date: today, amount: 100, ...body });
        eq(r.status, 400, `${field}: ${JSON.stringify(r.body)}`);
        eq(r.body.code, code, field);
        eq(r.body.field, field, code);
        eq(r.body.line, undefined, `${field}: no line`);
      }
      eq(await prisma.expense.count({ where: { businessId: biz.id } }), count0, "nothing saved");
    });
    await test("an expense edit names them the same way, and nothing changes", async () => {
      const x = await call("POST", "/expenses", T, { businessId: biz.id, date: today, amount: 700, accountId: RENT.id });
      eq(x.status, 201, JSON.stringify(x.body));
      const own = await call("PATCH", `/expenses/${x.body.id}`, T, { accountId: bySys("sales").id });
      eq(own.status, 400, JSON.stringify(own.body));
      eq(own.body.code, "ACCOUNT_NOT_ALLOWED");
      eq(own.body.field, "accountId");
      const money = await call("PATCH", `/expenses/${x.body.id}`, T, { accountId: GUARD.id, paidThroughAccountId: RENT.id });
      eq(money.status, 400, JSON.stringify(money.body));
      eq(money.body.code, "ACCOUNT_NOT_ALLOWED");
      eq(money.body.field, "paidThroughAccountId");
      eq((await prisma.expense.findUnique({ where: { id: x.body.id } })).accountId, RENT.id, "unchanged");
      eq((await call("DELETE", `/expenses/${x.body.id}`, T)).status, 200);
    });
    await test("a sale names accountId or depositAccountId, on create and on an edit, and nothing is saved", async () => {
      const count0 = await prisma.sales.count({ where: { businessId: biz.id } });
      const rivalSales = (await call("GET", `/ledger/accounts?businessId=${rivalBiz.id}`, TR)).body.accounts.find((a) => a.systemKey === "sales");
      const cases = [
        [{ accountId: RENT.id }, "ACCOUNT_NOT_ALLOWED", "accountId"],
        [{ accountId: rivalSales.id }, "ACCOUNT_NOT_FOUND", "accountId"],
        [{ depositAccountId: bySys("sales").id }, "ACCOUNT_NOT_ALLOWED", "depositAccountId"],
        // Both sent and only where the money went refused: that one is named.
        [{ accountId: bySys("sales").id, depositAccountId: RENT.id }, "ACCOUNT_NOT_ALLOWED", "depositAccountId"],
      ];
      for (const [body, code, field] of cases) {
        const r = await call("POST", "/sales", T, { businessId: biz.id, date: today, amount: 100, paymentMethod: "cash", ...body });
        eq(r.status, 400, `${field}: ${JSON.stringify(r.body)}`);
        eq(r.body.code, code, field);
        eq(r.body.field, field, code);
      }
      eq(await prisma.sales.count({ where: { businessId: biz.id } }), count0, "nothing saved");
      const s = await call("POST", "/sales", T, { businessId: biz.id, date: today, amount: 100, paymentMethod: "cash" });
      eq(s.status, 201, JSON.stringify(s.body));
      const own = await call("PATCH", `/sales/${s.body.id}`, T, { accountId: RENT.id });
      eq(own.status, 400, JSON.stringify(own.body));
      eq(own.body.field, "accountId");
      const into = await call("PATCH", `/sales/${s.body.id}`, T, { depositAccountId: bySys("sales").id });
      eq(into.status, 400, JSON.stringify(into.body));
      eq(into.body.field, "depositAccountId");
      const row = await prisma.sales.findUnique({ where: { id: s.body.id } });
      eq(row.accountId, null, "unchanged");
      eq(row.depositAccountId, null, "unchanged");
      eq((await call("DELETE", `/sales/${s.body.id}`, T)).status, 200);
    });

    section("Memos on account statements");
    // A statement line shows the record's own words: a sale's or an expense's
    // notes (each line of an itemized expense carries the expense's), and a
    // repayment's note, else its debt's (the fields utils/booksData.js reads
    // for them). In both views, in a business of its own; no total moves.
    const memoBiz = await prisma.business.create({ data: { userId: owner.id, name: `Exp memo ${tag}`, country: "NG", baseCurrency: "NGN" } });
    const mq = `businessId=${memoBiz.id}`;
    const memoChart = (await call("GET", `/ledger/accounts?${mq}`, T)).body.accounts;
    const mSales = memoChart.find((a) => a.systemKey === "sales");
    const mCash = memoChart.find((a) => a.systemKey === "cash");
    const mRent = memoChart.find((a) => a.seed === "rent");
    const mTransport = memoChart.find((a) => a.seed === "transport_delivery");
    const mEquipment = memoChart.find((a) => a.seed === "furniture_equipment");
    const memoRecords = {
      s1: await call("POST", "/sales", T, { businessId: memoBiz.id, amount: 5000, paymentMethod: "cash", notes: "2 bags of rice for Mama Tunde", date: today }),
      s2: await call("POST", "/sales", T, { businessId: memoBiz.id, amount: 3000, paymentMethod: "cash", date: today }),
      e1: await call("POST", "/expenses", T, { businessId: memoBiz.id, amount: 1200, category: "transport", paymentMethod: "cash", notes: "Keke to the market", date: today }),
      e2: await call("POST", "/expenses", T, {
        businessId: memoBiz.id, paymentMethod: "cash", notes: "Shop move", date: today,
        items: [{ accountId: mRent.id, amount: 2000, description: "Half month" }, { accountId: mTransport.id, amount: 800, description: "Van" }],
      }),
      e3: await call("POST", "/expenses", T, { businessId: memoBiz.id, amount: 9000, accountId: mEquipment.id, paymentMethod: "cash", notes: "New freezer", date: today }),
    };
    for (const [name, r] of Object.entries(memoRecords)) eq(r.status, 201, `${name}: ${JSON.stringify(r.body)}`);
    const { s1, s2, e1, e2, e3 } = Object.fromEntries(Object.entries(memoRecords).map(([k, r]) => [k, r.body]));
    const memoCust = await prisma.customer.create({ data: { userId: owner.id, businessId: memoBiz.id, name: `Mama Tunde ${tag}` } });
    const memoDebt = await call("POST", `/customers/${memoCust.id}/debts`, T, { amount: 4000, note: "Rice on credit", date: today });
    eq(memoDebt.status, 201, JSON.stringify(memoDebt.body));
    const debtId = (await prisma.debt.findFirst({ where: { customerId: memoCust.id } })).id;
    for (const body of [{ amount: 1500, note: "Paid half at the shop", method: "cash" }, { amount: 500, method: "cash" }]) {
      const p = await call("POST", `/customers/${memoCust.id}/debts/${debtId}/payment`, T, body);
      eq(p.status, 200, JSON.stringify(p.body));
    }
    const [payNoted, payBare] = await prisma.debtPayment.findMany({ where: { debtId }, orderBy: { amount: "desc" } });
    const statementOf = async (acc, basis) => {
      const st = await call("GET", `/ledger/accounts/${acc.id}/transactions?${mq}&basis=${basis}&from=${today}&to=${today}`, T);
      eq(st.status, 200, `${acc.name} (${basis}): ${JSON.stringify(st.body)}`);
      return st.body.lines;
    };
    const memoOf = (lines, id) => {
      const l = lines.find((x) => x.id === id);
      assert.ok(l, `no line ${id}`);
      return l.memo;
    };
    for (const basis of views) {
      await test(`a sale's notes are its memo on Sales and on Cash; one without notes has an empty memo (${basis})`, async () => {
        eq(memoOf(await statementOf(mSales, basis), `sale:${s1.id}`), "2 bags of rice for Mama Tunde", "Sales");
        eq(memoOf(await statementOf(mCash, basis), `sale:${s1.id}`), "2 bags of rice for Mama Tunde", "Cash");
        eq(memoOf(await statementOf(mSales, basis), `sale:${s2.id}`), "", "no notes");
      });
      await test(`an expense's notes are its memo on its account and on Cash, on every line of an itemized one (${basis})`, async () => {
        eq(memoOf(await statementOf(mTransport, basis), `expense:${e1.id}`), "Keke to the market", "its account");
        eq(memoOf(await statementOf(mCash, basis), `expense:${e1.id}`), "Keke to the market", "Cash");
        const [lineA, lineB] = e2.items;
        eq(memoOf(await statementOf(mRent, basis), `expense:${e2.id}:${lineA.id}`), "Shop move", "first line");
        eq(memoOf(await statementOf(mTransport, basis), `expense:${e2.id}:${lineB.id}`), "Shop move", "second line");
        eq(memoOf(await statementOf(mEquipment, basis), `expense:${e3.id}`), "New freezer", "equipment, on the balance sheet");
      });
      await test(`a repayment shows its own note, else its debt's (${basis})`, async () => {
        const lines = await statementOf(mCash, basis);
        eq(memoOf(lines, `dp:${payNoted.id}`), "Paid half at the shop", "its own");
        eq(memoOf(lines, `dp:${payBare.id}`), "Rice on credit", "the debt's");
      });
    }
    await test("the memos move no total: the profit and loss agrees with the books rule", async () => {
      invalidateOwner(owner.id);
      for (const basis of views) {
        const b = await booksFor(memoBiz.id, { from: today, to: today, basis });
        const pl = (await call("GET", `/ledger/reports/profit-and-loss?${mq}&basis=${basis}&from=${today}&to=${today}`, T)).body;
        eq(Math.round(pl.totalIncome * 100), Math.round(b.sales.total * 100), `${basis} income`);
        eq(Math.round(pl.totalExpenses * 100), Math.round(b.expenses.total * 100), `${basis} expenses`);
        // Sales of 5,000 and 3,000, plus the repayments of 2,000 (when paid)
        // or the 4,000 given on credit (when sold); spending of 1,200, 2,000
        // and 800 (the freezer is equipment, not spending).
        eq(b.sales.total, basis === "paid" ? 10000 : 12000, `${basis} sales`);
        eq(b.expenses.total, 4000, `${basis} spending`);
      }
    });

    section("Receipts");
    const add = (expenseId, file, name, token = T) => call("POST", `/expenses/${expenseId}/attachments`, token, { fileBase64: file, name });
    const storedOf = async (expenseId) => (await prisma.expense.findUnique({ where: { id: expenseId } })).attachments || [];
    let firstReceipt;
    await test("a receipt is kept with signed delivery for it and every version of it; the app sees its name, type and size", async () => {
      const r = await add(split.id, uri("image/png", PNG), "  Shop receipt.png  ");
      eq(r.status, 201, JSON.stringify(r.body));
      firstReceipt = r.body.attachment;
      assert.deepStrictEqual(Object.keys(firstReceipt).sort(), ["id", "mime", "name", "size", "uploadedAt"]);
      eq(firstReceipt.name, "Shop receipt.png");
      eq(firstReceipt.mime, "image/png");
      eq(firstReceipt.size, PNG.length);
      eq(r.body.attachments.length, 1);
      const o = cloud.uploads[cloud.uploads.length - 1].options;
      eq(o.folder, "kashbook/receipts");
      // "authenticated": a signature for the original AND for any resized or
      // transformed version ("private" signs only the original).
      eq(o.type, "authenticated");
      eq(o.access_mode, undefined, "access_mode is for the upload type only");
      eq(o.overwrite, false);
      eq(o.resource_type, "image");
      assert.match(o.public_id, /^receipt_[0-9a-f-]{36}$/, "a random public_id");
      const kept = await storedOf(split.id);
      eq(kept[0].publicId, `kashbook/receipts/${o.public_id}`, "the storage key stays on the server");
      eq(kept[0].resourceType, "image");
    });
    await test("a PDF is stored raw; a missing name is \"Receipt\"; a long one is cut to 120 characters", async () => {
      const r = await add(split.id, uri("application/pdf", PDF));
      eq(r.status, 201, JSON.stringify(r.body));
      eq(r.body.attachment.name, "Receipt");
      eq(r.body.attachment.mime, "application/pdf");
      eq(cloud.uploads[cloud.uploads.length - 1].options.resource_type, "raw");
      const j = await add(split.id, uri("image/jpeg", JPEG), "n".repeat(300));
      eq(j.body.attachment.name.length, 120);
      eq(j.body.attachments.length, 3);
    });
    await test("bad files are refused by the upload guard and never stored", async () => {
      const n0 = cloud.uploads.length;
      const cases = [
        [undefined, "UPLOAD_EMPTY"],
        ["https://example.com/receipt.png", "UPLOAD_NOT_DATA_URI"],
        [uri("text/html", Buffer.from("<b>hi</b>")), "UPLOAD_TYPE_NOT_ALLOWED"],
        [uri("image/png", Buffer.from("<svg onload=alert(1)></svg>")), "UPLOAD_CONTENT_MISMATCH"],
        [uri("application/pdf", PDF_WITH_SCRIPT), "UPLOAD_PDF_ACTIVE_CONTENT"],
      ];
      for (const [file, code] of cases) {
        const r = await add(split.id, file);
        eq(r.status, 400, code);
        eq(r.body.code, code);
      }
      eq(cloud.uploads.length, n0, "nothing reached the store");
      eq((await storedOf(split.id)).length, 3);
    });
    await test("a 7 MB photo fits under the server's 10 MB body limit", async () => {
      const big = Buffer.concat([JPEG, Buffer.alloc(7 * 1024 * 1024, 3)]);
      const r = await add(split.id, uri("image/jpeg", big), "Big photo.jpg");
      eq(r.status, 201, JSON.stringify(r.body));
      eq(r.body.attachment.size, big.length);
    });
    await test("five, then 409 TOO_MANY_ATTACHMENTS before anything is uploaded", async () => {
      eq((await add(split.id, uri("image/png", PNG), "Fifth")).status, 201);
      const n0 = cloud.uploads.length;
      const r = await add(split.id, uri("image/png", PNG), "Sixth");
      eq(r.status, 409);
      eq(r.body.code, "TOO_MANY_ATTACHMENTS");
      eq(cloud.uploads.length, n0, "the sixth never reached the store");
      eq((await storedOf(split.id)).length, 5);
    });
    await test("an edit returns the expense with its receipts, without their storage keys", async () => {
      const r = await call("PATCH", `/expenses/${split.id}`, T, { notes: "Receipts attached" });
      eq(r.status, 200, JSON.stringify(r.body));
      eq(r.body.attachments.length, 5);
      for (const a of r.body.attachments) assert.deepStrictEqual(Object.keys(a).sort(), ["id", "mime", "name", "size", "uploadedAt"]);
      eq(r.body.items.length, 3, "the lines stay");
    });
    await test("a signed link opens a receipt for ten minutes", async () => {
      const t0 = Math.floor(Date.now() / 1000);
      const r = await call("GET", `/expenses/${split.id}/attachments/${firstReceipt.id}/url`, T);
      eq(r.status, 200, JSON.stringify(r.body));
      assert.deepStrictEqual(Object.keys(r.body).sort(), ["expiresAt", "url"]);
      eq(r.headers["cache-control"], "private, no-store");
      const link = new URL(r.body.url);
      eq(`${link.origin}${link.pathname}`, "https://api.cloudinary.com/v1_1/e2e-cloud/image/download");
      eq(link.searchParams.get("type"), "authenticated");
      eq(link.searchParams.get("public_id"), (await storedOf(split.id))[0].publicId, "the asset it opens");
      assert.ok(link.searchParams.get("signature"), "signed");
      const exp = Number(link.searchParams.get("expires_at"));
      assert.ok(exp >= t0 + 595 && exp <= t0 + 605, `expires in ten minutes (${exp - t0}s)`);
      eq(r.body.expiresAt, new Date(exp * 1000).toISOString());
      const pdf = (await call("GET", `/expenses/${split.id}/attachments/${(await storedOf(split.id))[1].id}/url`, T)).body.url;
      eq(new URL(pdf).pathname, "/v1_1/e2e-cloud/raw/download", "a PDF is a raw asset");
      const none = await call("GET", `/expenses/${split.id}/attachments/00000000-0000-4000-8000-000000000001/url`, T);
      eq(none.status, 404);
      eq(none.body.code, "ATTACHMENT_NOT_FOUND");
    });
    await test("who may: the owner who may edit the expense; not staff, not another owner", async () => {
      const paths = [
        ["POST", `/expenses/${split.id}/attachments`, { fileBase64: uri("image/png", PNG) }],
        ["GET", `/expenses/${split.id}/attachments/${firstReceipt.id}/url`],
        ["DELETE", `/expenses/${split.id}/attachments/${firstReceipt.id}`],
      ];
      const n0 = cloud.uploads.length;
      // The same answers an edit gets (PATCH's own guards).
      const asEdit = {};
      for (const token of [tBoth, TR]) asEdit[token] = (await call("PATCH", `/expenses/${split.id}`, token, { notes: "x" })).body;
      assert.deepStrictEqual(asEdit[tBoth], { error: "Staff cannot edit expenses" });
      for (const token of [tBoth, tPlain, TR]) {
        for (const [method, path, body] of paths) {
          const r = await call(method, path, token, body);
          eq(r.status, 403, `${method} ${path}`);
          assert.deepStrictEqual(r.body, asEdit[token === TR ? TR : tBoth], `${method} ${path}`);
        }
      }
      eq((await call("GET", `/expenses/00000000-0000-4000-8000-000000000000/attachments/${firstReceipt.id}/url`, T)).status, 404);
      eq(cloud.uploads.length, n0);
      eq((await storedOf(split.id)).length, 5, "nothing removed");
    });
    let removedKey;
    await test("removing a receipt takes it off the expense and out of storage", async () => {
      removedKey = (await storedOf(split.id))[0].publicId;
      const r = await call("DELETE", `/expenses/${split.id}/attachments/${firstReceipt.id}`, T);
      eq(r.status, 200, JSON.stringify(r.body));
      eq(r.body.attachments.length, 4);
      await settle();
      const gone = cloud.destroyed.find((d) => d.publicId === removedKey);
      assert.ok(gone, "removed from storage");
      assert.deepStrictEqual(gone.options, { type: "authenticated", resource_type: "image", invalidate: true });
      eq((await storedOf(split.id)).length, 4);
      eq((await call("DELETE", `/expenses/${split.id}/attachments/${firstReceipt.id}`, T)).body.code, "ATTACHMENT_NOT_FOUND");
    });
    await test("two uploads at once onto the last free place: one is kept, the other refused and its file removed", async () => {
      const n0 = cloud.uploads.length;
      const [a, b] = await Promise.all([add(split.id, uri("image/png", PNG), "A"), add(split.id, uri("image/png", PNG), "B")]);
      assert.deepStrictEqual([a.status, b.status].sort(), [201, 409], JSON.stringify([a.body, b.body]));
      await settle();
      const tried = cloud.uploads.slice(n0).map((u) => `${u.options.folder}/${u.options.public_id}`);
      const kept = (await storedOf(split.id)).map((x) => x.publicId);
      eq(kept.length, 5);
      const loser = tried.filter((k) => !kept.includes(k));
      // Both may pass the first check (then one loses under the lock and its
      // file is removed), or one may already see five (and never upload).
      eq(loser.length, tried.length - 1, "one of them kept");
      for (const k of loser) assert.ok(cloud.destroyed.some((d) => d.publicId === k), "the refused file was removed");
    });
    await test("a failed upload saves nothing", async () => {
      const x = await call("POST", "/expenses", T, { businessId: biz.id, amount: 500, date: today });
      cloud.failNext = true;
      const r = await add(x.body.id, uri("image/png", PNG));
      eq(r.status, 502);
      eq(r.body.code, "UPLOAD_FAILED");
      eq((await storedOf(x.body.id)).length, 0);
      eq((await call("DELETE", `/expenses/${x.body.id}`, T)).status, 200);
    });
    await test("a receipt saved before a late failure keeps its file (the lock's COMMIT lost after the save)", async () => {
      const x = await call("POST", "/expenses", T, { businessId: biz.id, amount: 500, date: today });
      eq(x.status, 201, JSON.stringify(x.body));
      const real = prisma.withBusinessLock;
      prisma.withBusinessLock = async (key, fn) => {
        await real(key, fn);
        throw new Error("e2e: the lock's COMMIT was lost after the save");
      };
      let r;
      try {
        r = await add(x.body.id, uri("image/png", PNG), "Late");
      } finally {
        prisma.withBusinessLock = real;
      }
      eq(r.status, 500, JSON.stringify(r.body));
      await settle();
      const kept = await storedOf(x.body.id);
      eq(kept.length, 1, "the receipt is on the expense");
      eq(cloud.destroyed.some((d) => d.publicId === kept[0].publicId), false, "and its file stays");
      eq((await call("DELETE", `/expenses/${x.body.id}`, T)).status, 200);
    });

    section("Accounts used only by a line");
    await test("such an account can't be deleted; a merge moves the line; the books still tie out", async () => {
      const a = await call("POST", "/ledger/accounts", T, { businessId: biz.id, type: "expense", name: "Generator Parts" });
      const b = await call("POST", "/ledger/accounts", T, { businessId: biz.id, type: "expense", name: "Gen Spares" });
      eq(b.status, 201, JSON.stringify(b.body));
      const x = await call("POST", "/expenses", T, {
        businessId: biz.id, date: today, items: [{ accountId: RENT.id, amount: 1000 }, { accountId: b.body.id, amount: 500 }],
      });
      eq(x.status, 201, JSON.stringify(x.body));
      const del = await call("DELETE", `/ledger/accounts/${b.body.id}`, T);
      eq(del.status, 409);
      eq(del.body.code, "ACCOUNT_IN_USE");
      eq(del.body.used, 1, "the line");
      // What another phone last pulled, for the incremental pull below.
      const last = (await call("GET", `/sync?${q}`, T)).body.syncedAt;
      await new Promise((r) => setTimeout(r, 5));
      eq((await call("POST", `/ledger/accounts/${b.body.id}/merge`, T, { intoId: a.body.id })).status, 200);
      const line = await prisma.expenseItem.findFirst({ where: { expenseId: x.body.id, position: 1 } });
      eq(line.accountId, a.body.id, "the line moved");
      eq((await prisma.expense.findUnique({ where: { id: x.body.id } })).accountId, null, "the expense still names none");
      eq(await prisma.ledgerAccount.count({ where: { id: b.body.id } }), 0, "merged away");
      eq((await call("DELETE", `/ledger/accounts/${a.body.id}`, T)).body.code, "ACCOUNT_IN_USE");
      // The other phone's next pull carries the expense with its line moved,
      // although only the line changed.
      const since = await call("GET", `/sync?${q}&since=${encodeURIComponent(last)}`, T);
      eq(since.status, 200);
      const pulled = since.body.expenses.find((e) => e.id === x.body.id);
      assert.ok(pulled, "the expense is in the incremental pull");
      assert.deepStrictEqual(pulled.items.map((it) => it.accountId), [RENT.id, a.body.id]);
      await tiesOut();
    });
    await test("a merge sends invoices and customers whose lines or payments moved to every phone", async () => {
      const inA = await call("POST", "/ledger/accounts", T, { businessId: biz.id, type: "income", name: "Tailoring" });
      const inB = await call("POST", "/ledger/accounts", T, { businessId: biz.id, type: "income", name: "Tailoring Fees" });
      const bankA = await call("POST", "/ledger/accounts", T, { businessId: biz.id, type: "bank", name: "GTB Current" });
      const bankB = await call("POST", "/ledger/accounts", T, { businessId: biz.id, type: "bank", name: "GTB Main" });
      for (const r of [inA, inB, bankA, bankB]) eq(r.status, 201, JSON.stringify(r.body));
      const inv = await prisma.invoice.create({
        data: {
          businessId: biz.id, userId: owner.id, invoiceNumber: `INV-M-${tag}`, issueDate: today, status: "DRAFT",
          items: { create: [{ name: "Agbada", amount: 25000, rate: 25000, accountId: inB.body.id }] },
        },
      });
      const debt = await prisma.debt.create({
        data: {
          customerId: cust.id, amount: 1000, paidAmount: 400, date: new Date(),
          payments: { create: [{ amount: 400, date: new Date(), method: "transfer", depositAccountId: bankB.body.id }] },
        },
      });
      const last = (await call("GET", `/sync?${q}`, T)).body.syncedAt;
      await new Promise((r) => setTimeout(r, 5));
      eq((await call("POST", `/ledger/accounts/${inB.body.id}/merge`, T, { intoId: inA.body.id })).status, 200);
      eq((await call("POST", `/ledger/accounts/${bankB.body.id}/merge`, T, { intoId: bankA.body.id })).status, 200);
      const since = (await call("GET", `/sync?${q}&since=${encodeURIComponent(last)}`, T)).body;
      const pulledInv = since.invoices.find((i) => i.id === inv.id);
      assert.ok(pulledInv, "the invoice is in the incremental pull");
      eq(pulledInv.items[0].accountId, inA.body.id);
      const pulledCust = since.customers.find((c) => c.id === cust.id);
      assert.ok(pulledCust, "the customer is in the incremental pull");
      eq(pulledCust.debts.find((d) => d.id === debt.id).payments[0].depositAccountId, bankA.body.id);
      await tiesOut();
    });
    await test("expense writes, account merges and deletes take the same business lock", async () => {
      // Holds the business lock, as a merge does while it moves records, until
      // released; `has` settles once it holds it.
      const hold = () => {
        let held;
        let release;
        const has = new Promise((r) => (held = r));
        const done = prisma.withBusinessLock(biz.id, () => {
          held();
          return new Promise((r) => (release = r));
        });
        return { has, done, release: () => release() };
      };
      // A request sent while the lock is held answers only once it is released.
      const waits = async (what, send) => {
        const h = hold();
        await h.has;
        let answered = false;
        const pending = send().then((r) => {
          answered = true;
          return r;
        });
        await new Promise((r) => setTimeout(r, 300));
        eq(answered, false, `${what} waits for the lock`);
        h.release();
        await h.done;
        return pending;
      };
      const x = await waits("a new expense", () => call("POST", "/expenses", T, { businessId: biz.id, date: today, items: [{ accountId: RENT.id, amount: 10 }] }));
      eq(x.status, 201, JSON.stringify(x.body));
      const edit = await waits("an edit", () => call("PATCH", `/expenses/${x.body.id}`, T, { items: [{ accountId: RENT.id, amount: 20 }] }));
      eq(edit.status, 200, JSON.stringify(edit.body));
      eq((await call("DELETE", `/expenses/${x.body.id}`, T)).status, 200);
      const a = await call("POST", "/ledger/accounts", T, { businessId: biz.id, type: "expense", name: "Lock Test A" });
      const b = await call("POST", "/ledger/accounts", T, { businessId: biz.id, type: "expense", name: "Lock Test B" });
      eq((await waits("a merge", () => call("POST", `/ledger/accounts/${b.body.id}/merge`, T, { intoId: a.body.id }))).status, 200);
      eq((await waits("a delete", () => call("DELETE", `/ledger/accounts/${a.body.id}`, T))).status, 204);
    });

    section("The sync bundle, the list and a retried create");
    const noKeys = (text, where) => {
      assert.ok(!text.includes("publicId") && !text.includes("resourceType"), `${where}: no storage key field`);
      for (const k of cloud.uploads.map((u) => `${u.options.folder}/${u.options.public_id}`)) {
        assert.ok(!text.includes(k), `${where}: no storage key`);
      }
    };
    await test("the sync bundle carries the lines in order and receipts without storage keys (owner and staff)", async () => {
      for (const token of [T, tPlain]) {
        const s = await call("GET", `/sync?${q}`, token);
        eq(s.status, 200);
        const x = s.body.expenses.find((e) => e.id === split.id);
        assert.deepStrictEqual(x.items.map((it) => it.position), [0, 1, 2]);
        assert.deepStrictEqual(x.items.map((it) => it.accountId), [RENT.id, GEN.id, GUARD.id]);
        eq(x.attachments.length, 5);
        for (const a of x.attachments) assert.deepStrictEqual(Object.keys(a).sort(), ["id", "mime", "name", "size", "uploadedAt"]);
        noKeys(JSON.stringify(s.body), "sync");
      }
    });
    await test("GET /expenses carries the same", async () => {
      const l = await call("GET", `/expenses?${q}&from=${today}&to=${today}T23:59:59.999Z`, T);
      eq(l.status, 200);
      const x = l.body.find((e) => e.id === split.id);
      eq(x.items.length, 3);
      eq(x.attachments.length, 5);
      noKeys(JSON.stringify(l.body), "list");
    });
    await test("a retried create returns the first expense, lines and all", async () => {
      const body = {
        businessId: biz.id, date: today, clientRef: `retry-${tag}`,
        items: [{ accountId: RENT.id, amount: 700 }, { accountId: GEN.id, amount: 300 }, { accountId: GUARD.id, amount: 100 }],
      };
      const a = await call("POST", "/expenses", T, body);
      const b = await call("POST", "/expenses", T, body);
      eq(a.status, 201, JSON.stringify(a.body));
      eq(b.status, 200);
      eq(b.body.id, a.body.id);
      assert.deepStrictEqual(b.body.items.map((it) => it.id), a.body.items.map((it) => it.id));
      assert.deepStrictEqual(b.body.items.map((it) => it.position), [0, 1, 2]);
      assert.deepStrictEqual(b.body.attachments, []);
      eq(await prisma.expense.count({ where: { businessId: biz.id, clientRef: `retry-${tag}` } }), 1);
    });

    section("Deleting");
    await test("deleting an expense deletes its lines and removes its receipts from storage", async () => {
      const keys = (await storedOf(split.id)).map((a) => a.publicId);
      eq(keys.length, 5);
      eq((await call("DELETE", `/expenses/${split.id}`, T)).status, 200);
      await settle();
      eq(await prisma.expenseItem.count({ where: { expenseId: split.id } }), 0, "lines");
      for (const k of keys) {
        const d = cloud.destroyed.find((x) => x.publicId === k);
        assert.ok(d, `receipt ${k} removed`);
        eq(d.options.type, "authenticated");
      }
      eq(cloud.destroyed.find((x) => x.publicId === keys[0]).options.resource_type, "raw", "the PDF as raw");
    });
    await test("staff with bank access can't undo a recorded transfer whose expense has receipts; without receipts they can", async () => {
      const d = await bankRow({ type: "expense", amount: 4000 });
      const made = await call("POST", `/transactions/${d.id}/create-expense`, T, {});
      eq(made.status, 201, JSON.stringify(made.body));
      eq((await add(made.body.expense.id, uri("image/png", PNG), "Fuel")).status, 201);
      const n0 = cloud.destroyed.length;
      const s = await call("DELETE", `/transactions/${d.id}/match?deleteExpense=true`, tBoth);
      eq(s.status, 403, JSON.stringify(s.body));
      eq(s.body.code, "OWNER_ONLY");
      await settle();
      eq(cloud.destroyed.length, n0, "no receipt left storage");
      eq((await storedOf(made.body.expense.id)).length, 1, "the expense keeps its receipt");
      eq((await prisma.transaction.findUnique({ where: { id: d.id } })).matchedExpenseId, made.body.expense.id, "still recorded");
      // The owner may.
      eq((await call("DELETE", `/transactions/${d.id}/match?deleteExpense=true`, T)).status, 200);
      // Staff may still undo an expense with no receipts (one they recorded).
      const d2 = await bankRow({ type: "expense", amount: 1500 });
      const m2 = await call("POST", `/transactions/${d2.id}/create-expense`, tBoth, {});
      eq(m2.status, 201, JSON.stringify(m2.body));
      const u2 = await call("DELETE", `/transactions/${d2.id}/match?deleteExpense=true`, tBoth);
      eq(u2.status, 200, JSON.stringify(u2.body));
      eq(u2.body.expenseDeleted, true);
    });
    await test("undoing a recorded transfer with deleteExpense removes the expense's receipts too", async () => {
      const d = await bankRow({ type: "expense", amount: 4000 });
      const made = await call("POST", `/transactions/${d.id}/create-expense`, T, {});
      eq(made.status, 201, JSON.stringify(made.body));
      eq((await add(made.body.expense.id, uri("image/png", PNG), "Fuel")).status, 201);
      const key = (await storedOf(made.body.expense.id))[0].publicId;
      const u = await call("DELETE", `/transactions/${d.id}/match?deleteExpense=true`, T);
      eq(u.status, 200, JSON.stringify(u.body));
      eq(u.body.expenseDeleted, true);
      await settle();
      assert.ok(cloud.destroyed.some((x) => x.publicId === key), "removed from storage");
      eq((await prisma.transaction.findUnique({ where: { id: d.id } })).matchedExpenseId, null);
    });

    section("Everything together");
    await test("the books tie out; the KashBook Account equals the bank ledger", async () => {
      await tiesOut();
      const r = await call("GET", `/ledger/balances?${q}`, T);
      const kb = r.body.balances.find((x) => x.accountId === bySys("kashbook").id).balance;
      eq(Math.round(kb * 100), Math.round((await computeRawLedger(biz.id, "NGN")) * 100));
    });
    await test("no response carried a storage key; only a signed link names its asset", async () => {
      assert.ok(cloud.uploads.length >= 8, "receipts were uploaded");
      let links = 0;
      for (const r of responses) {
        const j = (() => { try { return JSON.parse(r.text); } catch { return null; } })();
        // A signed link names its asset inside its signed query (Cloudinary's
        // download API); the response carries nothing else.
        if (/\/attachments\/[^/]+\/url$/.test(r.path) && j && j.url) {
          assert.deepStrictEqual(Object.keys(j).sort(), ["expiresAt", "url"]);
          links++;
          continue;
        }
        noKeys(r.text, `${r.method} ${r.path}`);
      }
      assert.ok(links >= 2, "the links were checked");
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
