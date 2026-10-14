// Items like Zoho, end to end (2026-10-14): the real /inventory,
// /item-groups, /sales, /transactions, /invoices, /bills, /sync and /ledger
// routers over HTTP, the real auth middleware and permission gates, a real
// local Postgres. Covers the item's new fields (sales and purchase
// information, more information, returnable, whether stock is counted) and
// their checks; who sees the purchase information; goods whose stock is not
// counted (sold past nothing with no movement and no cost, never moved by an
// invoice, refused by restocks, adjustments, the stock value sheet and a
// credit note's restock, never low); tracking and type fixed once used; the
// returnable gate on credit notes; items with variants (made with opening
// stock, refusals, shared fields, renames, new options and variants, options
// in use, archive, delete); the sync bundle's new shapes; and, at the end, the
// books rule equal to the ledger's profit and loss with Inventory Asset equal
// to the stock at cost.
//
// Point it at a LOCAL scratch database (a clone of the migrated template):
//   node scratchpad/with-local-db.js postgres node scratchpad/clone-local-db.js kashbook_coa_e2e kashbook_coa_e2e_items
//   node scratchpad/with-local-db.js kashbook_coa_e2e_items node scripts/items-e2e-test.js
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
const fs = require("fs");
const path = require("path");
const http = require("http");
const express = require("express");
const prisma = require("../src/utils/db");
const { signToken } = require("../src/utils/jwt");
const chart = require("../src/utils/chart");
const { ensureChart } = require("../src/utils/ledgerData");
const { booksFor } = require("../src/utils/booksData");
const { answerQuestion, generateInsightCards } = require("../src/utils/insightsEngine");

const app = express();
app.use(express.json({ limit: "2mb" }));
// As server.js does before every route.
app.use(require("../src/middleware/idGuard").idGuard);
app.use("/inventory", require("../src/routes/inventory"));
app.use("/item-groups", require("../src/routes/itemGroups"));
app.use("/sales", require("../src/routes/sales"));
app.use("/transactions", require("../src/routes/transactions"));
app.use("/invoices", require("../src/routes/invoices"));
app.use("/bills", require("../src/routes/bills"));
app.use("/sync", require("../src/routes/sync"));
app.use("/ledger", require("../src/routes/ledger"));

let BASE;
const call = (method, p, token, body) =>
  new Promise((resolve) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const r = http.request(`${BASE}${p}`, {
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
const PUT = (p, t, b) => call("PUT", p, t, b === undefined ? {} : b);
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
    console.log(`  FAIL  ${name}\n        ${String(e && e.stack ? e.stack : e).split("\n").slice(0, 3).join("\n        ")}`);
  }
}
const eq = (a, b, what = "") => assert.strictEqual(a, b, `${what} ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
const deq = (a, b, what = "") => assert.deepStrictEqual(a, b, `${what} ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
const ok = (v, what) => assert.ok(v, what);
const section = (s) => console.log(`\n── ${s}`);
const status = (r, want, what = "") => assert.strictEqual(r.status, want, `${what} status ${r.status}: ${JSON.stringify(r.body)}`);
const refused = (r, want, code, what = "") => {
  status(r, want, what);
  eq(r.body && r.body.code, code, `${what} code`);
};

const tag = Date.now().toString(36);
const DAY = 86400000;
const lagosDay = (offset = 0) => new Date(Date.now() + 3600000 + offset * DAY).toISOString().slice(0, 10);
const atNoon = (offset = 0) => new Date(`${lagosDay(offset)}T12:00:00+01:00`);
const today = lagosDay(0);
const kobo = (n) => Math.round(Number(n) * 100);
const milli = (n) => Math.round(Number(n) * 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, what, ms = 3000) {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}
const PURCHASE = ["purchasePrice", "purchaseDescription", "purchaseAccountId", "preferredSupplier"];

(async () => {
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  BASE = `http://127.0.0.1:${server.address().port}`;
  console.log(`\nITEMS LIKE ZOHO, END TO END\n${BASE}`);

  try {
    // ── People, businesses and charts ────────────────────────────────────────
    const mkUser = (data) => prisma.user.create({
      data: { password: "x", lastName: "T", businessName: "B", country: "NG", currency: "NGN", ...data },
    });
    const owner = await mkUser({ email: `items-${tag}@t.local`, firstName: "Ada", accountType: "OWNER", expoPushToken: `ExponentPushToken[${tag}]` });
    const rival = await mkUser({ email: `items-rival-${tag}@t.local`, firstName: "Rival", accountType: "OWNER" });
    const mkBiz = async (userId, name) => {
      const b = await prisma.business.create({ data: { userId, name: `${name} ${tag}`, country: "NG", baseCurrency: "NGN" } });
      await ensureChart(b.id);
      return b;
    };
    const biz = await mkBiz(owner.id, "Items");
    const rivalBiz = await mkBiz(rival.id, "Rival");
    const T = signToken({ userId: owner.id, tokenVersion: 0 });
    const staffOf = async (name, grants) => {
      const s = await mkUser({ email: `items-${name}-${tag}@t.local`, firstName: name, accountType: "STAFF", employerId: owner.id });
      await prisma.staffPermission.create({ data: { userId: s.id, employerId: owner.id, grantedById: owner.id, ...grants } });
      return { user: s, token: signToken({ userId: s.id, tokenVersion: 0 }) };
    };
    const plain = await staffOf("plain", {});
    const reports = await staffOf("reports", { canViewReports: true });
    const bank = await staffOf("bank", { canViewBalance: true });

    const accounts = await prisma.ledgerAccount.findMany({ where: { businessId: biz.id } });
    const sys = (k) => accounts.find((a) => a.systemKey === k);
    const rent = accounts.find((a) => a.categorySlug === "rent");
    const cogs = sys(chart.SYS.COGS);
    const costOfServices = sys(chart.SYS.COST_OF_SERVICES);
    const salesAcc = sys(chart.SYS.SALES);
    const stockAcc = sys(chart.SYS.STOCK);
    const rivalRent = (await prisma.ledgerAccount.findMany({ where: { businessId: rivalBiz.id } })).find((a) => a.categorySlug === "rent");
    for (const [n, a] of Object.entries({ rent, cogs, costOfServices, salesAcc, stockAcc, rivalRent })) ok(a, `chart has ${n}`);

    const itemNow = (id) => prisma.inventoryItem.findUnique({ where: { id } });
    const movesOf = (itemId) => prisma.stockMovement.findMany({ where: { itemId } });
    const newItem = async (body, token = T) => {
      const r = await POST("/inventory", token, { businessId: biz.id, ...body });
      status(r, 201, `new item ${body.name}`);
      return r.body;
    };
    const sell = (items, over = {}, token = T) => POST("/sales", token, {
      businessId: biz.id, amount: over.amount || 1000, paymentMethod: "cash", date: atNoon(0).toISOString(), items, ...over,
    });
    const line = (it, quantity, rate = 300, extra = {}) => ({ name: it.name, quantity, rate, itemId: it.id, ...extra });
    const newInvoice = (items, extra = {}, token = T) => POST("/invoices", token, { businessId: biz.id, issueDate: today, items, ...extra });
    const newCredit = (items, extra = {}) => newInvoice(items, { type: "credit_note", ...extra });

    // ═════════════════════════════════════════════════════════════════════════
    section("the new fields: as sent, defaults, light checks");
    let kettle; // counted goods with every field, 4 at 3000, returnable
    await test("goods with every new field come back as sent; codes lose their spaces and dashes", async () => {
      kettle = await newItem({
        name: `Kettle ${tag}`, price: 5000, quantity: 4, costPrice: 3000, returnable: true, description: "Electric kettle, 1.7 litres",
        purchasePrice: 3100, purchaseDescription: "Carton of one", preferredSupplier: "Ade Wholesale",
        brand: "Binatone", manufacturer: "Binatone Ltd", weight: 1.2, weightUnit: "kg", length: 20, width: 15, height: 25, dimensionUnit: "cm",
        upc: "0 36000 29145 2", ean: "4006381333931", isbn: "0-306-40615-x", mpn: "KT-200",
      });
      eq(kettle.trackInventory, true);
      eq(kettle.returnable, true);
      eq(kettle.quantity, 4);
      eq(kettle.stockValue, 12000);
      eq(kettle.description, "Electric kettle, 1.7 litres");
      eq(kettle.purchasePrice, 3100);
      eq(kettle.purchaseDescription, "Carton of one");
      eq(kettle.purchaseAccountId, null, "counted goods' cost goes to Cost of Goods Sold, none kept");
      eq(kettle.preferredSupplier, "Ade Wholesale");
      eq(kettle.brand, "Binatone");
      eq(kettle.manufacturer, "Binatone Ltd");
      eq(kettle.weight, 1.2);
      eq(kettle.weightUnit, "kg");
      eq(kettle.length, 20);
      eq(kettle.width, 15);
      eq(kettle.height, 25);
      eq(kettle.dimensionUnit, "cm");
      eq(kettle.upc, "036000291452");
      eq(kettle.ean, "4006381333931");
      eq(kettle.isbn, "030640615X");
      eq(kettle.mpn, "KT-200");
      eq(kettle.groupId, null);
      ok(!("cost" in kettle), "the old cost column stays home");
    });
    await test("defaults: goods are counted and not returnable; a weight or a size alone is in kg or cm", async () => {
      const it = await newItem({ name: `Plain ${tag}`, price: 10, weight: 2, length: 3 });
      eq(it.trackInventory, true);
      eq(it.returnable, false, "new goods are not returnable unless the owner says so");
      eq(it.weightUnit, "kg");
      eq(it.dimensionUnit, "cm");
      for (const k of PURCHASE) eq(it[k], null, k);
      eq(it.brand, null);
    });
    await test("a service is never counted nor returnable, whatever is sent", async () => {
      const s = await newItem({ name: `Repair ${tag}`, itemType: "service", unit: "job", price: 0, trackInventory: true, returnable: true });
      eq(s.trackInventory, false);
      eq(s.returnable, false);
    });
    await test("light checks: 400 BAD_CODE or BAD_DETAIL (and the rest) naming the field", async () => {
      const cases = [
        [{ upc: "12345678901" }, "BAD_CODE", "upc"],
        [{ upc: "12345678901A" }, "BAD_CODE", "upc"],
        [{ ean: "123456789" }, "BAD_CODE", "ean"],
        [{ isbn: "12345" }, "BAD_CODE", "isbn"],
        [{ isbn: "123456789012X" }, "BAD_CODE", "isbn"],
        [{ mpn: "x".repeat(41) }, "BAD_CODE", "mpn"],
        [{ weight: 0 }, "BAD_DETAIL", "weight"],
        [{ weight: -1 }, "BAD_DETAIL", "weight"],
        [{ weight: 1, weightUnit: "stone" }, "BAD_DETAIL", "weightUnit"],
        [{ height: "tall" }, "BAD_DETAIL", "height"],
        [{ length: 2, dimensionUnit: "ft" }, "BAD_DETAIL", "dimensionUnit"],
        [{ brand: "b".repeat(81) }, "BAD_DETAIL", "brand"],
        [{ manufacturer: 7 }, "BAD_DETAIL", "manufacturer"],
        [{ preferredSupplier: "s".repeat(121) }, "BAD_DETAIL", "preferredSupplier"],
        [{ trackInventory: "yes" }, "BAD_DETAIL", "trackInventory"],
        [{ returnable: 1 }, "BAD_DETAIL", "returnable"],
        [{ purchasePrice: -1 }, "BAD_COST", "purchasePrice"],
        [{ purchasePrice: 1.005 }, "BAD_COST", "purchasePrice"],
        [{ purchaseDescription: "d".repeat(501) }, "BAD_DESCRIPTION", "purchaseDescription"],
      ];
      for (const [body, code, field] of cases) {
        const r = await POST("/inventory", T, { businessId: biz.id, name: `Bad ${tag}`, ...body });
        refused(r, 400, code, JSON.stringify(body));
        eq(r.body.field, field, JSON.stringify(body));
      }
      eq(await prisma.inventoryItem.count({ where: { name: `Bad ${tag}` } }), 0, "nothing saved");
    });
    await test("purchase account: a cost or spending account of this chart; counted goods keep none", async () => {
      const loose = await newItem({ name: `Loose sugar ${tag}`, trackInventory: false, purchaseAccountId: rent.id });
      eq(loose.purchaseAccountId, rent.id);
      const svc = await newItem({ name: `Install ${tag}`, itemType: "service", unit: "job", purchaseAccountId: costOfServices.id });
      eq(svc.purchaseAccountId, costOfServices.id);
      const counted = await newItem({ name: `Counted ${tag}`, purchaseAccountId: cogs.id });
      eq(counted.purchaseAccountId, null);
      const inc = await POST("/inventory", T, { businessId: biz.id, name: "X", trackInventory: false, purchaseAccountId: salesAcc.id });
      refused(inc, 400, "ACCOUNT_NOT_ALLOWED", "an income account");
      eq(inc.body.field, "purchaseAccountId");
      refused(await POST("/inventory", T, { businessId: biz.id, name: "X", trackInventory: false, purchaseAccountId: stockAcc.id }), 400, "ACCOUNT_NOT_ALLOWED", "Inventory Asset");
      refused(await POST("/inventory", T, { businessId: biz.id, name: "X", trackInventory: false, purchaseAccountId: rivalRent.id }), 400, "ACCOUNT_NOT_FOUND", "another chart's");
      const p = await PATCH(`/inventory/${loose.id}`, T, { purchaseAccountId: cogs.id });
      eq(p.body.purchaseAccountId, cogs.id);
    });
    await test("PATCH changes and clears them", async () => {
      const r = await PATCH(`/inventory/${kettle.id}`, T, { brand: "Philips", weight: null, upc: "", mpn: null, ean: "96385074" });
      status(r, 200);
      eq(r.body.brand, "Philips");
      eq(r.body.weight, null);
      eq(r.body.upc, null);
      eq(r.body.mpn, null);
      eq(r.body.ean, "96385074");
      eq(r.body.manufacturer, "Binatone Ltd", "what was not sent stays");
      refused(await PATCH(`/inventory/${kettle.id}`, T, { isbn: "9" }), 400, "BAD_CODE");
    });

    // ═════════════════════════════════════════════════════════════════════════
    section("who sees the purchase information");
    await test("a member without the reports gets it null on every door; with them, as it is", async () => {
      const p = (await GET(`/inventory?businessId=${biz.id}`, plain.token)).body.find((i) => i.id === kettle.id);
      for (const k of PURCHASE) eq(p[k], null, `plain ${k}`);
      eq(p.brand, "Philips", "more information is everyone's");
      eq(p.stockValue, null);
      const r = (await GET(`/inventory?businessId=${biz.id}`, reports.token)).body.find((i) => i.id === kettle.id);
      eq(r.purchasePrice, 3100);
      eq(r.preferredSupplier, "Ade Wholesale");
      const sp = (await GET(`/sync?businessId=${biz.id}`, plain.token)).body.inventory.find((i) => i.id === kettle.id);
      for (const k of PURCHASE) eq(sp[k], null, `sync ${k}`);
      const sr = (await GET(`/sync?businessId=${biz.id}`, reports.token)).body.inventory.find((i) => i.id === kettle.id);
      eq(sr.purchaseDescription, "Carton of one");
      const sold = await sell([{ itemId: kettle.id, quantity: 1, rate: 5000 }], { amount: 5000 }, plain.token);
      status(sold, 201);
      const back = sold.body.inventory.find((i) => i.id === kettle.id);
      eq(back.purchasePrice, null, "a sale's reply hides it too");
      eq(back.quantity, 3);
    });
    await test("a member never sets it (403 OWNER_ONLY); one who sees it may send it back unchanged", async () => {
      refused(await POST("/inventory", plain.token, { businessId: biz.id, name: "S1", purchasePrice: 10 }), 403, "OWNER_ONLY");
      refused(await POST("/inventory", reports.token, { businessId: biz.id, name: "S2", preferredSupplier: "Me" }), 403, "OWNER_ONLY");
      status(await POST("/inventory", plain.token, { businessId: biz.id, name: `Staff blank ${tag}`, purchasePrice: null, preferredSupplier: "" }), 201, "blank is nothing");
      refused(await PATCH(`/inventory/${kettle.id}`, plain.token, { purchasePrice: 3100 }), 403, "OWNER_ONLY", "even the right guess");
      const blank = await PATCH(`/inventory/${kettle.id}`, plain.token, { purchasePrice: null, preferredSupplier: null, price: 5100 });
      status(blank, 200, "the nulls it sees, sent back");
      eq((await itemNow(kettle.id)).purchasePrice, 3100, "unchanged");
      eq((await itemNow(kettle.id)).preferredSupplier, "Ade Wholesale");
      status(await PATCH(`/inventory/${kettle.id}`, reports.token, { purchasePrice: 3100, preferredSupplier: "Ade Wholesale", price: 5000 }), 200, "its own view back");
      refused(await PATCH(`/inventory/${kettle.id}`, reports.token, { purchasePrice: 3200 }), 403, "OWNER_ONLY");
      refused(await PATCH(`/inventory/${kettle.id}`, reports.token, { purchaseDescription: null }), 403, "OWNER_ONLY", "clearing is a change");
    });

    // ═════════════════════════════════════════════════════════════════════════
    section("goods whose stock is not counted");
    let bread; // not counted, price 500
    await test("no stock, no value, no cost of one unit; a quantity or a cost price is refused (400 NOT_STOCKED)", async () => {
      const q = await POST("/inventory", T, { businessId: biz.id, name: "X", trackInventory: false, quantity: 3 });
      refused(q, 400, "NOT_STOCKED");
      eq(q.body.field, "quantity");
      const c = await POST("/inventory", T, { businessId: biz.id, name: "X", trackInventory: false, costPrice: 50 });
      refused(c, 400, "NOT_STOCKED");
      eq(c.body.field, "costPrice");
      bread = await newItem({ name: `Bread ${tag}`, trackInventory: false, price: 500, lowStockAlert: 5, returnable: true, purchasePrice: 300, quantity: 0 });
      eq(bread.trackInventory, false);
      eq(bread.quantity, 0);
      eq(bread.stockValue, 0);
      eq(bread.avgCost, null);
      eq(bread.returnable, false, "only counted goods are returnable");
      eq(bread.purchasePrice, 300);
    });
    await test("they sell past nothing, with no movement and no cost; the line says tracked false", async () => {
      const r = await sell([{ itemId: bread.id, quantity: 7, rate: 500 }, { itemId: kettle.id, quantity: 1, rate: 5000 }], { amount: 8500 });
      status(r, 201);
      const b = r.body.items.find((l) => l.itemId === bread.id);
      eq(b.itemType, "goods");
      eq(b.tracked, false);
      eq(b.costAmount, 0);
      eq(b.unitCost, null);
      eq(b.costKnown, null, "no cost to know");
      const k = r.body.items.find((l) => l.itemId === kettle.id);
      eq(k.tracked, true);
      eq(k.costKnown, true);
      eq(k.costAmount, 3000);
      ok(!r.body.inventory.some((i) => i.id === bread.id), "the reply carries only the stock that moved");
      eq((await movesOf(bread.id)).length, 0);
      eq((await itemNow(bread.id)).quantity, 0);
      const row = await prisma.saleItem.findUnique({ where: { id: b.id } });
      eq(row.tracked, false, "kept on the line");
    });
    await test("a sale recorded from a bank transfer takes them the same way", async () => {
      const tx = await prisma.transaction.create({
        data: {
          businessId: biz.id, userId: owner.id, type: "income", amount: 1000, category: "transfer", paymentMethod: "bank",
          source: "anchor", currency: "NGN", date: atNoon(0), reference: `itm_${tag}_${Math.random().toString(36).slice(2)}`,
          description: "Transfer received from TEST",
        },
      });
      const r = await POST(`/transactions/${tx.id}/create-sale`, bank.token, { amount: 1000, items: [{ itemId: bread.id, quantity: 2, rate: 500 }] });
      status(r, 201);
      eq(r.body.sale.items[0].tracked, false);
      eq(r.body.sale.items[0].costAmount, 0);
      eq(r.body.inventory.length, 0);
      eq((await movesOf(bread.id)).length, 0);
    });
    let inv; // issued: 3 bread, 1 kettle
    await test("an invoice never moves them: issue, edit, void", async () => {
      const r = await newInvoice([line(bread, 3, 500), line(kettle, 1, 5000)], { status: "SENT" });
      status(r, 201);
      inv = r.body;
      const b = inv.items.find((l) => l.itemId === bread.id);
      eq(b.tracked, false);
      eq(b.costAmount, 0);
      eq(b.unitCost, null);
      eq(inv.items.find((l) => l.itemId === kettle.id).tracked, true);
      eq(inv.items.find((l) => l.itemId === kettle.id).costAmount, 3000);
      eq((await movesOf(bread.id)).length, 0);
      eq((await itemNow(kettle.id)).quantity, 1);
      const e = await PUT(`/invoices/${inv.id}`, T, { issueDate: today, items: [line(bread, 9, 500), line(kettle, 1, 5000)], notes: "more bread" });
      status(e, 200);
      eq(e.body.items.find((l) => l.itemId === bread.id).tracked, false);
      eq((await movesOf(bread.id)).length, 0);
      eq((await itemNow(kettle.id)).quantity, 1, "the kettle's line kept its movement");
      status(await PATCH(`/invoices/${inv.id}/status`, T, { status: "VOID" }), 200);
      eq((await itemNow(kettle.id)).quantity, 2, "voiding puts the kettle back");
      eq((await movesOf(bread.id)).length, 0);
    });
    await test("a payment that sends a draft moves only counted goods", async () => {
      const d = await newInvoice([line(bread, 2, 500)]);
      status(d, 201);
      const p = await POST(`/invoices/${d.body.id}/payments`, T, { amount: 1000, method: "cash" });
      status(p, 201);
      eq(p.body.status, "PAID");
      eq((await movesOf(bread.id)).length, 0);
    });
    await test("restocks, adjustments, counts, the stock value sheet and cost prices refuse them (400 NOT_STOCKED)", async () => {
      const b = await POST("/bills", T, {
        businessId: biz.id, vendorName: "Bakery", billDate: today,
        items: [{ itemId: kettle.id, quantity: 1, unitCost: 3000 }, { itemId: bread.id, quantity: 10, unitCost: 300 }],
      });
      refused(b, 400, "NOT_STOCKED", "a restock");
      eq(b.body.line, 1);
      eq(b.body.itemId, bread.id);
      eq(await prisma.businessDebt.count({ where: { businessId: biz.id, name: "Bakery" } }), 0, "no bill");
      eq((await itemNow(kettle.id)).quantity, 2, "nothing moved");
      refused(await POST(`/inventory/${bread.id}/adjust`, T, { quantity: 2, reason: "other" }), 400, "NOT_STOCKED", "found");
      refused(await POST(`/inventory/${bread.id}/adjust`, T, { quantity: -1, reason: "damaged" }), 400, "NOT_STOCKED", "damaged");
      refused(await POST(`/inventory/${bread.id}/adjust`, T, { countedQuantity: 3 }), 400, "NOT_STOCKED", "counted");
      const sv = await POST("/inventory/stock-value", T, { businessId: biz.id, items: [{ itemId: bread.id, unitCost: 20 }] });
      refused(sv, 400, "NOT_STOCKED", "the stock value sheet");
      eq(sv.body.line, 0);
      refused(await PATCH(`/inventory/${bread.id}`, T, { quantity: 4 }), 400, "NOT_STOCKED", "a count");
      refused(await PATCH(`/inventory/${bread.id}`, T, { costPrice: 20 }), 400, "NOT_STOCKED", "a cost price");
      const same = await PATCH(`/inventory/${bread.id}`, T, { quantity: 0, price: 520, costPrice: null });
      status(same, 200, "its own nothing sent back");
      eq(same.body.price, 520);
      eq((await movesOf(bread.id)).length, 0);
    });
    await test("a credit note never puts them back (400 NOT_STOCKED, the line named)", async () => {
      const r = await newCredit([line(kettle, 1, 5000, { restock: true }), line(bread, 1, 500, { restock: true })], { status: "SENT" });
      refused(r, 400, "NOT_STOCKED");
      eq(r.body.line, 1);
      eq(r.body.itemId, bread.id);
      eq(r.body.field, "items");
      const fine = await newCredit([line(bread, 1, 500)], { status: "SENT" });
      status(fine, 201, "credited without going back into stock");
      eq(fine.body.items[0].restock, false);
      eq(fine.body.items[0].tracked, false);
    });
    await test("never low on stock: the hourly alert and Insights leave them out", async () => {
      const src = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
      const m = /(async function sendLowStockAlerts\(\) \{[\s\S]*?\r?\n\})\r?\n\/\/ End of sendLowStockAlerts\./.exec(src);
      ok(m, "sendLowStockAlerts found in server.js");
      const pushes = [];
      const run = new Function("prisma", "fetch", "console", `return (${m[1]});`)(
        prisma, async (u, o) => { pushes.push(JSON.parse(o.body)); return { ok: true }; }, { log: () => {}, error: console.error },
      );
      const lowCounted = await newItem({ name: `Low counted ${tag}`, quantity: 1, costPrice: 10, lowStockAlert: 3 });
      await run();
      ok((await itemNow(lowCounted.id)).lowStockNotifiedAt, "counted goods at their level are alerted");
      eq((await itemNow(bread.id)).lowStockNotifiedAt, null, "goods not counted never");
      ok(!pushes.some((p) => p.body.includes(bread.name)), "no push for them");
      const fakeBiz = { id: biz.id, baseCurrency: "NGN" };
      const a = await answerQuestion("what is low on stock", fakeBiz);
      eq(a.intent, "stock");
      ok(!a.data.low.some((l) => l.name === bread.name), JSON.stringify(a.data.low));
      ok(a.data.low.some((l) => l.name === lowCounted.name), "the counted one is");
      const cards = await generateInsightCards(fakeBiz);
      const lowCard = cards.find((c) => c.icon === "cube");
      ok(lowCard && !lowCard.body.includes(bread.name), JSON.stringify(cards));
    });

    // ═════════════════════════════════════════════════════════════════════════
    section("tracking and type are fixed once used");
    await test("goods sold, invoiced or quoted keep their tracking and type (409 TRACKING_FIXED, TYPE_FIXED)", async () => {
      refused(await PATCH(`/inventory/${bread.id}`, T, { trackInventory: true }), 409, "TRACKING_FIXED", "bread was sold");
      refused(await PATCH(`/inventory/${bread.id}`, T, { itemType: "service", unit: "job" }), 409, "TYPE_FIXED");
      refused(await PATCH(`/inventory/${kettle.id}`, T, { trackInventory: false }), 409, "TRACKING_FIXED", "the kettle moved");
      const quoted = await newItem({ name: `Quoted ${tag}`, trackInventory: false });
      status(await newInvoice([line(quoted, 1, 100)], { type: "quote" }), 201);
      refused(await PATCH(`/inventory/${quoted.id}`, T, { trackInventory: true }), 409, "TRACKING_FIXED", "a quote line is use");
      status(await PATCH(`/inventory/${bread.id}`, T, { trackInventory: false, name: `Bread ${tag}` }), 200, "the same tracking sent back");
    });
    await test("while unused, tracking turns off and on; off drops the cost of one unit and returnable", async () => {
      const y = await newItem({ name: `Yam ${tag}`, costPrice: 40, returnable: true });
      eq(y.avgCost, 40);
      const off = await PATCH(`/inventory/${y.id}`, T, { trackInventory: false });
      status(off, 200);
      eq(off.body.trackInventory, false);
      eq(off.body.avgCost, null);
      eq(off.body.returnable, false);
      await waitFor(() => prisma.auditLog.findFirst({ where: { action: "ITEM_TRACKING_CHANGE", resourceId: y.id } }), "the audit row");
      const on = await PATCH(`/inventory/${y.id}`, T, { trackInventory: true, quantity: 2, costPrice: 10 });
      status(on, 200);
      eq(on.body.trackInventory, true);
      eq(on.body.quantity, 2);
      eq(on.body.stockValue, 20);
      const s = await newItem({ name: `Was a service ${tag}`, itemType: "service", unit: "job" });
      const g = await PATCH(`/inventory/${s.id}`, T, { itemType: "goods", unit: "piece" });
      eq(g.body.trackInventory, true, "a service turned goods is counted");
      const g2 = await PATCH(`/inventory/${g.body.id}`, T, { itemType: "service", unit: "job" });
      eq(g2.body.trackInventory, false);
      const g3 = await PATCH(`/inventory/${g.body.id}`, T, { itemType: "goods", unit: "piece", trackInventory: false });
      eq(g3.body.trackInventory, false, "or not, when the owner says");
    });

    await test("an item holding stock from before release 3, with no movement, is used (409, never a 500)", async () => {
      // In a business of its own: its stock is explained by no movement.
      const oldBiz = await mkBiz(owner.id, "Old shop");
      const legacy = await prisma.inventoryItem.create({
        data: { userId: owner.id, businessId: oldBiz.id, name: `Legacy ${tag}`, price: 100, quantity: 3 },
      });
      eq((await movesOf(legacy.id)).length, 0);
      refused(await PATCH(`/inventory/${legacy.id}`, T, { trackInventory: false }), 409, "TRACKING_FIXED");
      refused(await PATCH(`/inventory/${legacy.id}`, T, { itemType: "service", unit: "job" }), 409, "TYPE_FIXED");
      eq((await itemNow(legacy.id)).quantity, 3);
    });
    await test("a member never changes an item's tracking, nor its type when that drops the owner's (403 OWNER_ONLY)", async () => {
      const counted = await newItem({ name: `Counted soap ${tag}`, costPrice: 25 });
      refused(await PATCH(`/inventory/${counted.id}`, plain.token, { trackInventory: false }), 403, "OWNER_ONLY", "off");
      eq((await itemNow(counted.id)).avgCost, 25, "the owner's cost stays");
      const loose = await newItem({ name: `Loose soap ${tag}`, trackInventory: false });
      refused(await PATCH(`/inventory/${loose.id}`, reports.token, { trackInventory: true }), 403, "OWNER_ONLY", "on");
      status(await PATCH(`/inventory/${loose.id}`, plain.token, { trackInventory: false, price: 30 }), 200, "the same tracking sent back");
      status(await POST("/inventory", plain.token, { businessId: biz.id, name: `Staff loose ${tag}`, trackInventory: false }), 201, "chosen on create");
      // A service with a purchase account, turned goods (counted): the
      // account would go.
      const svc = await newItem({ name: `Fitting ${tag}`, itemType: "service", unit: "job", purchaseAccountId: costOfServices.id });
      refused(await PATCH(`/inventory/${svc.id}`, plain.token, { itemType: "goods", unit: "piece" }), 403, "OWNER_ONLY", "drops the purchase account");
      // Goods with a cost made a service keep it; made goods not counted, it
      // would go.
      const costed = await newItem({ name: `Costed box ${tag}`, costPrice: 12 });
      status(await PATCH(`/inventory/${costed.id}`, plain.token, { itemType: "service", unit: "job" }), 200, "a service keeps the cost");
      refused(await PATCH(`/inventory/${costed.id}`, plain.token, { itemType: "goods", unit: "piece", trackInventory: false }), 403, "OWNER_ONLY", "drops the cost");
      eq((await itemNow(costed.id)).avgCost, 12);
      // The owner may, and the audit row keeps what went.
      const own = await PATCH(`/inventory/${svc.id}`, T, { itemType: "goods", unit: "piece" });
      status(own, 200);
      eq(own.body.purchaseAccountId, null);
      const row = await waitFor(() => prisma.auditLog.findFirst({ where: { action: "ITEM_TYPE_CHANGE", resourceId: svc.id } }), "the audit row");
      eq(row.metadata.dropped.purchaseAccountId, costOfServices.id);
      const off = await PATCH(`/inventory/${counted.id}`, T, { trackInventory: false });
      status(off, 200);
      const trow = await waitFor(() => prisma.auditLog.findFirst({ where: { action: "ITEM_TRACKING_CHANGE", resourceId: counted.id } }), "the audit row");
      eq(trow.metadata.dropped.avgCost, 25);
    });
    await test("a photo is an https address of at most 2048 characters (400 BAD_IMAGE); one saved before stays", async () => {
      const good = "https://res.cloudinary.com/demo/image/upload/v1/kettle.jpg";
      for (const image of ["http://example.com/a.jpg", "file:///data/user/0/a.jpg", "data:image/png;base64,AAAA", `https://res.cloudinary.com/${"a".repeat(2100)}.jpg`, "https:// spaced.jpg", 12]) {
        const r = await POST("/inventory", T, { businessId: biz.id, name: `Photo ${tag}`, image });
        refused(r, 400, "BAD_IMAGE", String(image).slice(0, 40));
        eq(r.body.field, "image");
      }
      refused(await POST("/inventory", T, { businessId: biz.id, name: `Photo ${tag}`, imageUrl: "http://example.com/a.jpg" }), 400, "BAD_IMAGE", "the older name too");
      const it = await newItem({ name: `Photo ${tag}`, image: good });
      eq(it.image, good);
      await prisma.inventoryItem.update({ where: { id: it.id }, data: { image: "file:///old/photo.jpg" } });
      const back = await PATCH(`/inventory/${it.id}`, T, { image: "file:///old/photo.jpg", price: 5 });
      status(back, 200, "the photo it has, sent back");
      eq(back.body.image, "file:///old/photo.jpg", "existing rows untouched");
      refused(await PATCH(`/inventory/${it.id}`, T, { image: "file:///new/photo.jpg" }), 400, "BAD_IMAGE");
      eq((await PATCH(`/inventory/${it.id}`, T, { image: null })).body.image, null, "cleared");
      const g = await POST("/item-groups", T, {
        businessId: biz.id, name: `Photo group ${tag}`, image: "http://example.com/g.jpg",
        attributes: [{ name: "Size", options: ["One"] }], variants: [{ values: ["One"], price: 1 }],
      });
      refused(g, 400, "BAD_IMAGE", "a group's photo");
      const v = await POST("/item-groups", T, {
        businessId: biz.id, name: `Photo group ${tag}`, image: good,
        attributes: [{ name: "Size", options: ["One", "Two"] }],
        variants: [{ values: ["One"], price: 1, image: good }, { values: ["Two"], price: 1, image: "ftp://example.com/v.jpg" }],
      });
      refused(v, 400, "BAD_IMAGE", "a variant's photo");
      eq(v.body.variant, 1);
      eq(v.body.field, "image");
    });

    // ═════════════════════════════════════════════════════════════════════════
    section("the returnable gate on credit notes");
    await test("goods go back on a credit note only when returnable (400 NOT_RETURNABLE, the line named)", async () => {
      const cup = await newItem({ name: `Cup ${tag}`, quantity: 5, costPrice: 100 });
      eq(cup.returnable, false);
      const no = await newCredit([line(kettle, 1, 5000), line(cup, 2, 150, { restock: true })], { status: "SENT" });
      refused(no, 400, "NOT_RETURNABLE");
      eq(no.body.line, 1);
      eq(no.body.itemId, cup.id);
      eq(no.body.field, "items");
      status(await newCredit([line(cup, 2, 150)], { status: "SENT" }), 201, "credited, not back in stock");
      eq((await itemNow(cup.id)).quantity, 5);
      eq((await PATCH(`/inventory/${cup.id}`, T, { returnable: true })).body.returnable, true);
      const yes = await newCredit([line(cup, 2, 150, { restock: true })], { status: "SENT" });
      status(yes, 201);
      eq((await itemNow(cup.id)).quantity, 7);
      await PATCH(`/inventory/${cup.id}`, T, { returnable: false });
      const kept = await PUT(`/invoices/${yes.body.id}`, T, { issueDate: today, items: [line(cup, 2, 150, { restock: true })], notes: "kept" });
      status(kept, 200, "a restock line the credit note has already stays");
      eq((await itemNow(cup.id)).quantity, 7);
      refused(await PUT(`/invoices/${yes.body.id}`, T, { issueDate: today, items: [line(cup, 3, 150, { restock: true })] }), 400, "NOT_RETURNABLE", "a new one is refused");
      eq((await itemNow(cup.id)).quantity, 7);
      eq((await PATCH(`/inventory/${bread.id}`, T, { returnable: true })).body.returnable, false, "goods not counted stay not returnable");
    });

    // ═════════════════════════════════════════════════════════════════════════
    section("items with variants");
    const shirtName = `Shirt ${tag}`;
    const ATTRS = [{ name: "Size", options: ["S", "M", "L"] }, { name: "Colour", options: ["Red", "Blue"] }];
    let shirt; // { group, items }
    const variantOf = (reply, ...values) => reply.items.find((i) => JSON.stringify(i.variantValues) === JSON.stringify(values));
    await test("a group and one item per combination, with opening stock as movements", async () => {
      const r = await POST("/item-groups", T, {
        businessId: biz.id, name: shirtName, unit: "piece", brand: "Ankara Co", manufacturer: "Aba Mills", description: "Cotton shirt",
        returnable: true, preferredSupplier: "Kano Textiles", purchaseDescription: "Bale of 20",
        attributes: ATTRS,
        variants: [
          { values: ["S", "Red"], price: 4000, purchasePrice: 2500, quantity: 5, costPrice: 2400, barcode: `SH-${tag}-1`, weight: 0.3 },
          { values: ["m", "blue"], price: 4500, quantity: 3, costPrice: 2600 },
          { values: ["L", "Red"], price: 5000, name: `Big red ${tag}` },
          { values: ["S", "Blue"], price: 4000, quantity: 2, lowStockAlert: 1 },
        ],
      });
      status(r, 201);
      shirt = r.body;
      const g = shirt.group;
      eq(g.name, shirtName);
      eq(g.itemType, "goods");
      eq(g.trackInventory, true);
      eq(g.returnable, true);
      eq(g.preferredSupplier, "Kano Textiles");
      eq(g.variantCount, 4);
      deq(g.attributes, ATTRS);
      eq(shirt.items.length, 4);
      deq(shirt.items.map((i) => i.variantValues), [["S", "Red"], ["S", "Blue"], ["M", "Blue"], ["L", "Red"]], "in the options' order");
      for (const it of shirt.items) {
        eq(it.groupId, g.id);
        eq(it.brand, "Ankara Co");
        eq(it.manufacturer, "Aba Mills");
        eq(it.description, "Cotton shirt");
        eq(it.returnable, true);
        eq(it.trackInventory, true);
        eq(it.unit, "piece");
        eq(it.preferredSupplier, "Kano Textiles");
        eq(it.purchaseDescription, "Bale of 20");
      }
      const sRed = variantOf(shirt, "S", "Red");
      eq(sRed.name, `${shirtName} - S / Red`);
      eq(sRed.purchasePrice, 2500);
      eq(sRed.barcode, `SH-${tag}-1`);
      eq(sRed.weight, 0.3);
      eq(sRed.weightUnit, "kg");
      eq(sRed.quantity, 5);
      eq(sRed.stockValue, 12000);
      eq(sRed.avgCost, 2400);
      const mBlue = variantOf(shirt, "M", "Blue");
      eq(mBlue.name, `${shirtName} - M / Blue`, "the group's spelling");
      eq(mBlue.variantKey, "m\u001fblue");
      eq(mBlue.stockValue, 7800);
      eq(variantOf(shirt, "L", "Red").name, `Big red ${tag}`);
      eq(variantOf(shirt, "L", "Red").quantity, 0);
      const sBlue = variantOf(shirt, "S", "Blue");
      eq(sBlue.quantity, 2);
      eq(sBlue.stockValue, 0, "opening stock with no cost");
      eq(sBlue.lowStockAlert, 1);
      const moves = await prisma.stockMovement.findMany({ where: { itemId: { in: shirt.items.map((i) => i.id) } } });
      eq(moves.length, 3);
      ok(moves.every((m) => m.kind === "opening"));
      eq(kobo(moves.reduce((s, m) => s + m.value, 0)), kobo(shirt.items.reduce((s, i) => s + i.stockValue, 0)), "movements are the stock value");
      await waitFor(() => prisma.auditLog.findFirst({ where: { action: "ITEM_GROUP_CREATE", resourceId: g.id } }), "the audit row");
    });
    await test("a retry with the same clientRef gets the same group back (200)", async () => {
      const body = {
        businessId: biz.id, name: `Cap ${tag}`, clientRef: `cap-${tag}`,
        attributes: [{ name: "Colour", options: ["Black"] }], variants: [{ values: ["Black"], price: 900 }],
      };
      const a = await POST("/item-groups", T, body);
      status(a, 201);
      const b = await POST("/item-groups", T, body);
      status(b, 200);
      eq(b.body.group.id, a.body.group.id);
      eq(await prisma.itemGroup.count({ where: { businessId: biz.id, name: `Cap ${tag}` } }), 1);
      refused(await POST("/item-groups", T, { ...body, clientRef: `cap2-${tag}` }), 409, "GROUP_NAME_TAKEN", "another create, the same name");
    });
    await test("two identical creates at once: one makes the group, the other gets it back (201 and 200)", async () => {
      const body = {
        businessId: biz.id, name: `Hat ${tag}`, clientRef: `hat-${tag}`,
        attributes: [{ name: "Colour", options: ["White"] }], variants: [{ values: ["White"], price: 700 }],
      };
      const [a, b] = await Promise.all([POST("/item-groups", T, body), POST("/item-groups", T, body)]);
      deq([a.status, b.status].sort(), [200, 201], JSON.stringify([a.body, b.body]));
      eq(a.body.group.id, b.body.group.id);
      eq(b.body.items.length, 1, "the reply carries the items too");
      eq(await prisma.itemGroup.count({ where: { businessId: biz.id, name: `Hat ${tag}` } }), 1);
    });
    await test("refused: a combination twice, an option not offered, bad attributes, a taken name or barcode, too many", async () => {
      const base = { businessId: biz.id, name: `Gown ${tag}`, attributes: ATTRS };
      const dup = await POST("/item-groups", T, { ...base, variants: [{ values: ["S", "Red"], price: 1 }, { values: ["s", "RED"], price: 1 }] });
      refused(dup, 400, "DUPLICATE_VARIANT");
      eq(dup.body.variant, 1);
      const off = await POST("/item-groups", T, { ...base, variants: [{ values: ["XL", "Red"], price: 1 }] });
      refused(off, 400, "BAD_VARIANTS");
      eq(off.body.variant, 0);
      eq(off.body.attribute, 0);
      refused(await POST("/item-groups", T, { ...base, variants: [{ values: ["S"], price: 1 }] }), 400, "BAD_VARIANTS", "one value for two attributes");
      refused(await POST("/item-groups", T, { ...base, variants: [] }), 400, "BAD_VARIANTS", "no variants");
      const four = [1, 2, 3, 4].map((n) => ({ name: `A${n}`, options: ["x"] }));
      refused(await POST("/item-groups", T, { ...base, attributes: four, variants: [{ values: ["x", "x", "x", "x"], price: 1 }] }), 400, "BAD_ATTRIBUTES", "four attributes");
      refused(await POST("/item-groups", T, { ...base, attributes: [{ name: "Size", options: ["S", "s"] }], variants: [{ values: ["S"], price: 1 }] }), 400, "BAD_ATTRIBUTES", "an option twice");
      refused(await POST("/item-groups", T, { ...base, attributes: [{ name: "Size", options: [] }], variants: [] }), 400, "BAD_ATTRIBUTES", "no options");
      refused(await POST("/item-groups", T, { ...base, name: shirtName.toUpperCase(), variants: [{ values: ["S", "Red"], price: 1 }] }), 409, "GROUP_NAME_TAKEN");
      const bc = await POST("/item-groups", T, { ...base, variants: [{ values: ["S", "Red"], price: 1, barcode: `SH-${tag}-1` }] });
      refused(bc, 409, "BARCODE_TAKEN");
      eq(bc.body.variant, 0);
      const opts = Array.from({ length: 11 }, (_, i) => `o${i}`);
      const many = [];
      for (const a of opts) for (const b of opts) if (many.length < 101) many.push({ values: [a, b], price: 1 });
      refused(await POST("/item-groups", T, { ...base, attributes: [{ name: "P", options: opts }, { name: "Q", options: opts }], variants: many }), 400, "BAD_VARIANTS", "101 variants");
      const loose = await POST("/item-groups", T, { ...base, trackInventory: false, variants: [{ values: ["S", "Red"], price: 1, quantity: 2 }] });
      refused(loose, 400, "NOT_STOCKED", "opening stock for goods not counted");
      eq(loose.body.variant, 0);
      refused(await POST("/item-groups", T, { ...base, itemType: "service", unit: "kg", variants: [{ values: ["S", "Red"], price: 1 }] }), 400, "BAD_UNIT");
      eq(await prisma.itemGroup.count({ where: { name: `Gown ${tag}` } }), 0, "nothing saved");
      eq(await prisma.inventoryItem.count({ where: { name: { startsWith: `Gown ${tag}` } } }), 0);
    });
    await test("a member makes groups, never with stock, a cost price or purchase information (403 OWNER_ONLY)", async () => {
      const base = { businessId: biz.id, name: `Staff socks ${tag}`, attributes: [{ name: "Size", options: ["One"] }] };
      refused(await POST("/item-groups", plain.token, { ...base, variants: [{ values: ["One"], price: 300, quantity: 2 }] }), 403, "OWNER_ONLY", "stock");
      refused(await POST("/item-groups", plain.token, { ...base, variants: [{ values: ["One"], price: 300, costPrice: 100 }] }), 403, "OWNER_ONLY", "cost");
      refused(await POST("/item-groups", plain.token, { ...base, variants: [{ values: ["One"], price: 300, purchasePrice: 100 }] }), 403, "OWNER_ONLY", "purchase price");
      refused(await POST("/item-groups", plain.token, { ...base, preferredSupplier: "X", variants: [{ values: ["One"], price: 300 }] }), 403, "OWNER_ONLY", "supplier");
      const r = await POST("/item-groups", plain.token, { ...base, variants: [{ values: ["One"], price: 300 }] });
      status(r, 201);
      eq(r.body.group.userId, owner.id, "the owner's group");
      eq(r.body.items[0].userId, owner.id);
    });
    await test("the purchase information of groups: hidden from a member without the reports (GET, sync)", async () => {
      const p = (await GET(`/item-groups?businessId=${biz.id}`, plain.token)).body.find((g) => g.id === shirt.group.id);
      eq(p.preferredSupplier, null);
      eq(p.purchaseDescription, null);
      eq(p.variantCount, 4);
      eq(p.brand, "Ankara Co");
      const r = (await GET(`/item-groups?businessId=${biz.id}`, reports.token)).body.find((g) => g.id === shirt.group.id);
      eq(r.preferredSupplier, "Kano Textiles");
      const one = await GET(`/item-groups/${shirt.group.id}`, plain.token);
      status(one, 200);
      eq(one.body.items.length, 4);
      ok(one.body.items.every((i) => i.purchasePrice === null && i.stockValue === null));
      const s = await GET(`/sync?businessId=${biz.id}`, plain.token);
      const sg = s.body.itemGroups.find((g) => g.id === shirt.group.id);
      ok(sg, "itemGroups in the sync bundle");
      eq(sg.variantCount, 4);
      eq(sg.preferredSupplier, null);
      status(await GET(`/item-groups/${shirt.group.id}`, signToken({ userId: rival.id, tokenVersion: 0 })), 403, "a rival");
      ok(!(await GET(`/item-groups?businessId=${biz.id}`, signToken({ userId: rival.id, tokenVersion: 0 }))).body.length, "a rival lists none");
    });
    await test("shared fields go to every variant; a variant's own edit of one is refused (400 GROUP_FIELD)", async () => {
      const r = await PATCH(`/item-groups/${shirt.group.id}`, T, { brand: "Adire", description: "Hand-dyed", unit: "pack", returnable: false });
      status(r, 200);
      eq(r.body.group.brand, "Adire");
      ok(r.body.items.every((i) => i.brand === "Adire" && i.description === "Hand-dyed" && i.unit === "pack" && i.returnable === false), "every variant");
      const v = variantOf(shirt, "S", "Red");
      const bad = await PATCH(`/inventory/${v.id}`, T, { brand: "Other" });
      refused(bad, 400, "GROUP_FIELD");
      eq(bad.body.field, "brand");
      refused(await PATCH(`/inventory/${v.id}`, T, { trackInventory: false }), 400, "GROUP_FIELD");
      refused(await PATCH(`/inventory/${v.id}`, T, { incomeAccountId: salesAcc.id }), 400, "GROUP_FIELD");
      const own = await PATCH(`/inventory/${v.id}`, T, { brand: "Adire", unit: "pack", price: 4100, upc: "036000291452" });
      status(own, 200, "the shared values sent back, and its own");
      eq(own.body.price, 4100);
      eq(own.body.upc, "036000291452");
      await PATCH(`/item-groups/${shirt.group.id}`, T, { returnable: true });
      await waitFor(() => prisma.auditLog.findFirst({ where: { action: "ITEM_GROUP_UPDATE", resourceId: shirt.group.id } }), "the audit row");
    });
    await test("a member without the reports gets one answer on a variant whatever the hidden purchase information is", async () => {
      const v = variantOf(shirt, "S", "Blue"); // its group's supplier is Kano Textiles, purchase description Bale of 20
      const noSupplier = (await POST("/item-groups", T, {
        businessId: biz.id, name: `Scarf ${tag}`, attributes: [{ name: "Colour", options: ["Grey"] }], variants: [{ values: ["Grey"], price: 1200 }],
      })).body.items[0];
      for (const [field, right, wrong] of [
        ["preferredSupplier", "Kano Textiles", "Somebody else"],
        ["purchaseDescription", "Bale of 20", "A box"],
        ["purchaseAccountId", null, rent.id],
      ]) {
        const answers = [];
        for (const item of [v, noSupplier]) {
          for (const guess of [right, wrong]) {
            if (guess === null) continue;
            const r = await PATCH(`/inventory/${item.id}`, plain.token, { [field]: guess });
            answers.push(`${r.status} ${r.body.code}`);
          }
          const n = await PATCH(`/inventory/${item.id}`, plain.token, { [field]: null, price: item.price });
          answers.push(`null ${n.status}`);
        }
        const guesses = answers.filter((a) => !a.startsWith("null"));
        ok(guesses.every((a) => a === "403 OWNER_ONLY"), `${field} guesses: ${answers.join(", ")}`);
        ok(answers.filter((a) => a.startsWith("null")).every((a) => a === "null 200"), `${field} nulls: ${answers.join(", ")}`);
      }
      eq((await itemNow(v.id)).preferredSupplier, "Kano Textiles", "nothing changed");
      eq((await itemNow(v.id)).purchaseDescription, "Bale of 20");
    });
    await test("renaming the group renames the variants with the automatic name, never a renamed one", async () => {
      const mBlue = variantOf(shirt, "M", "Blue");
      status(await PATCH(`/inventory/${mBlue.id}`, T, { name: `Navy M ${tag}` }), 200);
      const r = await PATCH(`/item-groups/${shirt.group.id}`, T, { name: `Tunic ${tag}` });
      status(r, 200);
      eq(variantOf(r.body, "S", "Red").name, `Tunic ${tag} - S / Red`);
      eq(variantOf(r.body, "S", "Blue").name, `Tunic ${tag} - S / Blue`);
      eq(variantOf(r.body, "M", "Blue").name, `Navy M ${tag}`);
      eq(variantOf(r.body, "L", "Red").name, `Big red ${tag}`);
      shirt = r.body;
    });
    await test("options are only added, then new variants; an option in use stays (409 OPTION_IN_USE)", async () => {
      const grown = [{ name: "Size", options: ["S", "M", "L", "XL"] }, { name: "Colour", options: ["Red", "Blue", "Green"] }];
      const r = await PATCH(`/item-groups/${shirt.group.id}`, T, { attributes: grown });
      status(r, 200);
      deq(r.body.group.attributes, grown);
      const add = await POST(`/item-groups/${shirt.group.id}/variants`, T, { variants: [{ values: ["XL", "Green"], price: 6000, quantity: 1, costPrice: 3000 }] });
      status(add, 201);
      eq(add.body.group.variantCount, 5);
      const xl = variantOf(add.body, "XL", "Green");
      eq(xl.name, `Tunic ${tag} - XL / Green`);
      eq(xl.stockValue, 3000);
      eq(xl.brand, "Adire", "the shared fields as they are now");
      eq(add.body.items[add.body.items.length - 1].id, xl.id, "last in the options' order");
      const again = await POST(`/item-groups/${shirt.group.id}/variants`, T, { variants: [{ values: ["S", "Red"], price: 1 }] });
      refused(again, 409, "DUPLICATE_VARIANT");
      eq(again.body.variant, 0);
      const gone = await PATCH(`/item-groups/${shirt.group.id}`, T, { attributes: [{ name: "Size", options: ["M", "L", "XL"] }, grown[1]] });
      refused(gone, 409, "OPTION_IN_USE");
      eq(gone.body.attribute, 0);
      eq(gone.body.option, "S");
      refused(await PATCH(`/item-groups/${shirt.group.id}`, T, { attributes: [{ name: "Size", options: ["s", "M", "L", "XL"] }, grown[1]] }), 409, "OPTION_IN_USE", "respelled");
      const fewer = await PATCH(`/item-groups/${shirt.group.id}`, T, { attributes: [grown[0], { name: "Color", options: ["Red", "Blue", "Green"] }] });
      status(fewer, 200, "an attribute renamed");
      refused(await PATCH(`/item-groups/${shirt.group.id}`, T, { attributes: [...grown, { name: "Fit", options: ["Slim"] }] }), 400, "BAD_ATTRIBUTES", "a new attribute");
      const unused = await PATCH(`/item-groups/${shirt.group.id}`, T, { attributes: [grown[0], { name: "Color", options: ["Red", "Blue", "Green", "Gold"] }] });
      status(unused, 200);
      const dropGold = await PATCH(`/item-groups/${shirt.group.id}`, T, { attributes: [grown[0], { name: "Color", options: ["Red", "Blue", "Green"] }] });
      status(dropGold, 200, "an unused option may go");
      shirt = dropGold.body;
    });
    await test("a variant is an item: sold, invoiced, restocked like any other", async () => {
      const sRed = variantOf(shirt, "S", "Red");
      const s = await sell([{ itemId: sRed.id, quantity: 2, rate: 4100 }], { amount: 8200 });
      status(s, 201);
      eq(s.body.items[0].costAmount, 4800);
      eq((await itemNow(sRed.id)).quantity, 3);
      const xl = variantOf(shirt, "XL", "Green");
      status(await POST("/bills", T, { businessId: biz.id, vendorName: "Kano Textiles", billDate: today, items: [{ itemId: xl.id, quantity: 3, unitCost: 3000 }] }), 201, "restock");
      eq((await itemNow(xl.id)).quantity, 4);
      status(await newInvoice([line(sRed, 1, 4100)], { status: "SENT" }), 201);
      eq((await itemNow(sRed.id)).quantity, 2);
    });
    await test("type and tracking are fixed once a variant is used (409); free before, and off drops costs", async () => {
      refused(await PATCH(`/item-groups/${shirt.group.id}`, T, { trackInventory: false }), 409, "TRACKING_FIXED");
      refused(await PATCH(`/item-groups/${shirt.group.id}`, T, { itemType: "service", unit: "job" }), 409, "TYPE_FIXED");
      const fresh = await POST("/item-groups", T, {
        businessId: biz.id, name: `Belt ${tag}`, returnable: true, attributes: [{ name: "Length", options: ["90", 100] }],
        variants: [{ values: ["90"], price: 1500, costPrice: 700 }, { values: ["100"], price: 1600 }],
      });
      status(fresh, 201);
      eq(variantOf(fresh.body, "90").avgCost, 700);
      eq(variantOf(fresh.body, "100").name, `Belt ${tag} - 100`, "a number is an option too");
      const off = await PATCH(`/item-groups/${fresh.body.group.id}`, T, { trackInventory: false });
      status(off, 200);
      eq(off.body.group.trackInventory, false);
      eq(off.body.group.returnable, false);
      ok(off.body.items.every((i) => i.trackInventory === false && i.avgCost === null && i.returnable === false), JSON.stringify(off.body.items));
      const svc = await PATCH(`/item-groups/${fresh.body.group.id}`, T, { itemType: "service", unit: "job" });
      status(svc, 200);
      ok(svc.body.items.every((i) => i.itemType === "service" && i.unit === "job"));
      const audits = await prisma.auditLog.findMany({ where: { action: "ITEM_GROUP_UPDATE", resourceId: fresh.body.group.id } });
      const withDrop = audits.find((a) => a.metadata && a.metadata.dropped);
      ok(withDrop, "the owner's change says what it dropped");
      deq(withDrop.metadata.dropped.avgCosts, [{ itemId: variantOf(fresh.body, "90").id, avgCost: 700 }]);
    });
    await test("a member never changes a group's tracking, nor its type when that drops the owner's (403 OWNER_ONLY)", async () => {
      const g = await POST("/item-groups", T, {
        businessId: biz.id, name: `Wrap ${tag}`, attributes: [{ name: "Size", options: ["One"] }],
        variants: [{ values: ["One"], price: 800, costPrice: 300 }],
      });
      status(g, 201);
      refused(await PATCH(`/item-groups/${g.body.group.id}`, plain.token, { trackInventory: false }), 403, "OWNER_ONLY", "tracking");
      status(await PATCH(`/item-groups/${g.body.group.id}`, plain.token, { trackInventory: true, brand: "Kente" }), 200, "the same tracking sent back");
      eq((await itemNow(g.body.items[0].id)).avgCost, 300, "the owner's cost stays");
      const s = await POST("/item-groups", T, {
        businessId: biz.id, name: `Tailoring ${tag}`, itemType: "service", unit: "job", purchaseAccountId: costOfServices.id,
        attributes: [{ name: "Kind", options: ["Hem"] }], variants: [{ values: ["Hem"], price: 1500 }],
      });
      status(s, 201);
      refused(await PATCH(`/item-groups/${s.body.group.id}`, plain.token, { itemType: "goods", unit: "piece" }), 403, "OWNER_ONLY", "a type change dropping the purchase account");
      eq((await prisma.itemGroup.findUnique({ where: { id: s.body.group.id } })).purchaseAccountId, costOfServices.id);
      const plainSvc = await POST("/item-groups", T, {
        businessId: biz.id, name: `Ironing ${tag}`, itemType: "service", unit: "job",
        attributes: [{ name: "Kind", options: ["Shirt"] }], variants: [{ values: ["Shirt"], price: 300 }],
      });
      status(await PATCH(`/item-groups/${plainSvc.body.group.id}`, plain.token, { itemType: "goods", unit: "piece" }), 200, "nothing of the owner's to drop");
    });
    await test("archiving takes the group and every variant; bringing it back returns them", async () => {
      refused(await POST(`/item-groups/${shirt.group.id}/archive`, plain.token), 403, "OWNER_ONLY");
      const a = await POST(`/item-groups/${shirt.group.id}/archive`, T);
      status(a, 200);
      ok(a.body.group.archivedAt, "the group");
      ok(a.body.items.every((i) => i.archivedAt), "every variant");
      eq(a.body.group.variantCount, 0);
      refused(await POST(`/item-groups/${shirt.group.id}/variants`, T, { variants: [{ values: ["L", "Blue"], price: 1 }] }), 409, "ITEM_ARCHIVED");
      refused(await sell([{ itemId: a.body.items[0].id, quantity: 1, rate: 1 }], { amount: 1 }), 409, "ITEM_ARCHIVED");
      const one = await POST(`/inventory/${a.body.items[0].id}/unarchive`, T);
      refused(one, 409, "GROUP_ARCHIVED", "one variant of an archived group");
      eq(one.body.field, undefined);
      ok((await itemNow(a.body.items[0].id)).archivedAt, "still archived");
      const twin = await POST("/item-groups", T, { businessId: biz.id, name: `Tunic ${tag}`, attributes: [{ name: "Size", options: ["One"] }], variants: [{ values: ["One"], price: 1 }] });
      status(twin, 201, "an archived group's name is free");
      refused(await POST(`/item-groups/${shirt.group.id}/unarchive`, T), 409, "GROUP_NAME_TAKEN", "while another live group has it");
      status(await PATCH(`/item-groups/${twin.body.group.id}`, T, { name: `Tunic two ${tag}` }), 200);
      const u = await POST(`/item-groups/${shirt.group.id}/unarchive`, T);
      status(u, 200);
      eq(u.body.group.archivedAt, null);
      ok(u.body.items.every((i) => !i.archivedAt));
      eq(u.body.group.variantCount, 5);
      await waitFor(() => prisma.auditLog.findFirst({ where: { action: "ITEM_GROUP_ARCHIVE", resourceId: shirt.group.id } }), "the audit row");
    });
    await test("deleting: refused with history (409 ITEM_HAS_HISTORY); with none, the group and its variants go", async () => {
      refused(await DEL(`/item-groups/${shirt.group.id}`, plain.token), 403, "OWNER_ONLY");
      const h = await DEL(`/item-groups/${shirt.group.id}`, T);
      refused(h, 409, "ITEM_HAS_HISTORY");
      ok(shirt.items.some((i) => i.id === h.body.itemId), "names a variant");
      const loose = await POST("/item-groups", T, {
        businessId: biz.id, name: `Loose rice ${tag}`, trackInventory: false, attributes: [{ name: "Bag", options: ["5kg", "10kg"] }],
        variants: [{ values: ["5kg"], price: 4000 }, { values: ["10kg"], price: 7500 }],
      });
      status(loose, 201);
      const sold = await sell([{ itemId: loose.body.items[0].id, quantity: 3, rate: 4000 }], { amount: 12000 });
      status(sold, 201, "goods not counted, sold");
      const d = await DEL(`/item-groups/${loose.body.group.id}`, T);
      status(d, 200);
      eq(d.body.itemIds.length, 2);
      eq(await prisma.itemGroup.count({ where: { id: loose.body.group.id } }), 0);
      eq(await prisma.inventoryItem.count({ where: { id: { in: d.body.itemIds } } }), 0);
      const lineRow = await prisma.saleItem.findUnique({ where: { id: sold.body.items[0].id } });
      eq(lineRow.itemId, null, "the sale line keeps its name");
      eq(lineRow.name, loose.body.items[0].name);
      await waitFor(() => prisma.auditLog.findFirst({ where: { action: "ITEM_GROUP_DELETE", resourceId: loose.body.group.id } }), "the audit row");
      status(await DEL(`/item-groups/${loose.body.group.id}`, T), 404);
    });
    await test("a variant archived or deleted on its own leaves the group, which the next sync brings again", async () => {
      const before = (await prisma.itemGroup.findUnique({ where: { id: shirt.group.id } })).updatedAt;
      await sleep(5);
      const lRed = variantOf(shirt, "L", "Red");
      status(await DEL(`/inventory/${lRed.id}`, T), 200, "no history");
      const g = await GET(`/item-groups/${shirt.group.id}`, T);
      eq(g.body.group.variantCount, 4);
      ok(new Date(g.body.group.updatedAt) > before, "stamped");
      const sync = await GET(`/sync?businessId=${biz.id}&since=${encodeURIComponent(before.toISOString())}`, T);
      ok(sync.body.itemGroups.some((x) => x.id === shirt.group.id), "an incremental pull carries it");
    });

    // ═════════════════════════════════════════════════════════════════════════
    section("accounts the items name");
    await test("an account an item or a group buys through is in use; a merge moves them with it", async () => {
      const name = `Bakery supplies ${tag}`;
      const supplies = await prisma.ledgerAccount.create({ data: { businessId: biz.id, type: "expense", name, nameKey: chart.nameKey(name) } });
      const flourItem = await newItem({ name: `Flour ${tag}`, trackInventory: false, purchaseAccountId: supplies.id });
      const g = await POST("/item-groups", T, {
        businessId: biz.id, name: `Cake ${tag}`, trackInventory: false, purchaseAccountId: supplies.id,
        attributes: [{ name: "Size", options: ["Small"] }], variants: [{ values: ["Small"], price: 2000 }],
      });
      status(g, 201);
      eq(g.body.items[0].purchaseAccountId, supplies.id, "the variant has the group's");
      refused(await DEL(`/ledger/accounts/${supplies.id}`, T), 409, "ACCOUNT_IN_USE");
      status(await POST(`/ledger/accounts/${supplies.id}/merge`, T, { intoId: rent.id }), 200);
      eq((await itemNow(flourItem.id)).purchaseAccountId, rent.id);
      eq((await prisma.itemGroup.findUnique({ where: { id: g.body.group.id } })).purchaseAccountId, rent.id);
      eq((await itemNow(g.body.items[0].id)).purchaseAccountId, rent.id);
    });

    // ═════════════════════════════════════════════════════════════════════════
    section("the sync bundle and the books");
    await test("sync: sale and invoice lines carry tracked", async () => {
      const s = await GET(`/sync?businessId=${biz.id}`, T);
      status(s, 200);
      const lines = s.body.sales.flatMap((x) => x.items);
      ok(lines.some((l) => l.itemId === bread.id && l.tracked === false), "a bread sale line");
      ok(lines.some((l) => l.itemId === kettle.id && l.tracked === true));
      const invLines = s.body.invoices.flatMap((x) => x.items);
      ok(invLines.some((l) => l.itemId === bread.id && l.tracked === false), "a bread invoice line");
      // A line's copy is always its item's, since tracking is fixed once used.
      const counted = new Map(s.body.inventory.map((i) => [i.id, i.trackInventory]));
      for (const l of [...lines, ...invLines].filter((x) => x.itemType === "goods" && x.itemId)) {
        eq(l.tracked, counted.get(l.itemId), `${l.name} tracked`);
      }
    });
    await test("the books rule equals the ledger's profit and loss (both views); Inventory Asset is the stock at cost", async () => {
      const q = `businessId=${biz.id}`;
      for (const basis of ["sold", "paid"]) {
        const pl = await GET(`/ledger/reports/profit-and-loss?${q}&basis=${basis}&from=${today}&to=${today}`, T);
        status(pl, 200, `${basis} P&L`);
        const b = await booksFor(biz.id, { from: today, to: today, basis });
        eq(kobo(pl.body.totalIncome), kobo(b.sales.total), `${basis} income`);
        eq(kobo(pl.body.totalExpenses), kobo(b.expenses.total), `${basis} expenses`);
        ok(b.sales.total > 0, "there are sales");
      }
      const sold = await booksFor(biz.id, { from: today, to: today, basis: "sold" });
      const cogsLine = sold.expenses.lines.cogs && sold.expenses.lines.cogs.gross;
      const costed = await prisma.saleItem.aggregate({ where: { businessId: biz.id }, _sum: { costAmount: true } });
      const breadCost = await prisma.saleItem.aggregate({ where: { businessId: biz.id, itemId: bread.id }, _sum: { costAmount: true } });
      eq(breadCost._sum.costAmount, 0, "goods not counted carried no cost");
      ok(cogsLine >= costed._sum.costAmount, "the cost of the goods sold counted");
      const bs = await GET(`/ledger/reports/balance-sheet?${q}`, T);
      eq(bs.body.balanced, true, JSON.stringify(bs.body.totals));
      const bal = await GET(`/ledger/balances?${q}`, T);
      status(bal, 200);
      const inv = bal.body.balances.find((x) => x.accountId === stockAcc.id);
      const items = await prisma.inventoryItem.findMany({ where: { businessId: biz.id } });
      eq(kobo(inv ? inv.balance : 0), kobo(items.reduce((s, i) => s + i.stockValue, 0)), "Inventory Asset");
    });
    await test("every item holds what its movements add up to; goods not counted hold nothing", async () => {
      const items = await prisma.inventoryItem.findMany({ where: { businessId: biz.id } });
      for (const it of items) {
        const sum = await prisma.stockMovement.aggregate({ where: { itemId: it.id }, _sum: { quantity: true, value: true } });
        eq(milli(sum._sum.quantity || 0), milli(it.quantity), `${it.name} quantity`);
        eq(kobo(sum._sum.value || 0), kobo(it.stockValue), `${it.name} value`);
        if (!it.trackInventory) {
          eq(it.quantity, 0, `${it.name} holds no stock`);
          if (it.itemType === "goods") eq(it.avgCost, null, `${it.name} has no cost`);
        }
      }
    });
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
