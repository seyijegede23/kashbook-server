// Stock and the routes end to end (chart of accounts release 3, 2026-10-13):
// the real /sales, /inventory, /transactions and /sync routers over HTTP, the
// real auth middleware and permission gates, a real local Postgres. Covers
// sales with goods, service and typed lines (the stock taken at the average
// cost, the income account of each line), the refusals (not enough stock, an
// archived or another business's item, malformed lines), two phones selling
// the last unit, a retried create, deleting a sale (its goods come back),
// lines fixed once saved, a sale recorded from a bank transfer with lines and
// undone again, every inventory route (adding with opening stock, editing,
// counting, a new cost price, adjustments, the "Set up stock value" sheet,
// archiving, deleting, the stock history), who may do what and who sees what
// goods cost, the sync bundle's shapes per role, the retired sync inventory
// ops, the books lock date on every dated write, and, at the end, every
// item's quantity and stock value equal to the sums of its movements.
//
// Point it at a LOCAL scratch database (a clone of the migrated template):
//   node scratchpad/with-local-db.js kashbook_coa_e2e_a2r3 node scripts/stock-routes-e2e-test.js
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

// Every ledger the routes clear, recorded. Installed before any router is
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

const app = express();
app.use(express.json());
// As server.js does before every route.
app.use(require("../src/middleware/idGuard").idGuard);
app.use("/sales", require("../src/routes/sales"));
app.use("/inventory", require("../src/routes/inventory"));
app.use("/transactions", require("../src/routes/transactions"));
app.use("/sync", require("../src/routes/sync"));

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
    console.log(`  FAIL  ${name}\n        ${String(e && e.stack ? e.stack : e).split("\n").slice(0, 3).join("\n        ")}`);
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
const K = (n) => Math.round(n * 100);

(async () => {
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  BASE = `http://127.0.0.1:${server.address().port}`;
  console.log(`\nSTOCK ROUTES, END TO END\n${BASE}`);

  try {
    // ── People, businesses and charts ────────────────────────────────────────
    const mkUser = (data) => prisma.user.create({
      data: { password: "x", lastName: "T", businessName: "B", country: "NG", currency: "NGN", ...data },
    });
    const owner = await mkUser({ email: `stock-${tag}@t.local`, firstName: "Ada", accountType: "OWNER" });
    const rival = await mkUser({ email: `stock-rival-${tag}@t.local`, firstName: "Rival", accountType: "OWNER" });
    const biz = await prisma.business.create({ data: { userId: owner.id, name: `Stock ${tag}`, country: "NG", baseCurrency: "NGN" } });
    const biz2 = await prisma.business.create({ data: { userId: owner.id, name: `Stock two ${tag}`, country: "NG", baseCurrency: "NGN" } });
    const rivalBiz = await prisma.business.create({ data: { userId: rival.id, name: `Rival ${tag}`, country: "NG", baseCurrency: "NGN" } });
    for (const b of [biz, biz2, rivalBiz]) await ensureChart(b.id);
    const T = signToken({ userId: owner.id, tokenVersion: 0 });
    const tRival = signToken({ userId: rival.id, tokenVersion: 0 });
    const staffOf = async (employer, name, grants) => {
      const s = await mkUser({ email: `stock-${name}-${tag}@t.local`, firstName: name, accountType: "STAFF", employerId: employer.id });
      await prisma.staffPermission.create({ data: { userId: s.id, employerId: employer.id, grantedById: employer.id, ...grants } });
      return { user: s, token: signToken({ userId: s.id, tokenVersion: 0 }) };
    };
    const plain = await staffOf(owner, "plain", {});
    const reports = await staffOf(owner, "reports", { canViewReports: true });
    const bank = await staffOf(owner, "bank", { canViewBalance: true });
    const bankReports = await staffOf(owner, "bankrep", { canViewBalance: true, canViewReports: true });

    const chartOf = async (bizId) => {
      const list = await prisma.ledgerAccount.findMany({ where: { businessId: bizId } });
      return {
        sys: (k) => list.find((a) => a.systemKey === k),
        cat: (s) => list.find((a) => a.categorySlug === s),
      };
    };
    const A = await chartOf(biz.id);
    const salesAcc = A.sys(chart.SYS.SALES);
    const serviceIncome = A.sys(chart.SYS.SERVICE_INCOME);
    const discount = A.sys(chart.SYS.DISCOUNT);
    const rent = A.cat("rent");
    const consulting = await prisma.ledgerAccount.create({
      data: { businessId: biz.id, type: "income", name: `Consulting ${tag}`, nameKey: chart.nameKey(`Consulting ${tag}`) },
    });
    const otherIncome = await prisma.ledgerAccount.create({
      data: { businessId: biz.id, type: "other_income", name: `Side income ${tag}`, nameKey: chart.nameKey(`Side income ${tag}`) },
    });
    const rested = await prisma.ledgerAccount.create({
      data: { businessId: biz.id, type: "income", name: `Rested ${tag}`, nameKey: chart.nameKey(`Rested ${tag}`), inactiveAt: new Date() },
    });
    const rivalSales = (await chartOf(rivalBiz.id)).sys(chart.SYS.SALES);
    for (const [name, a] of Object.entries({ salesAcc, serviceIncome, discount, rent, rivalSales })) ok(a, `chart has ${name}`);

    const itemNow = (id) => prisma.inventoryItem.findUnique({ where: { id } });
    const movesOf = (itemId) => prisma.stockMovement.findMany({ where: { itemId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
    const newItem = async (body, token = T) => {
      const r = await POST("/inventory", token, { businessId: biz.id, ...body });
      status(r, 201, `new item ${body.name}`);
      return r.body;
    };
    const sell = (items, over = {}, token = T) => POST("/sales", token, {
      businessId: biz.id, amount: over.amount || 1000, paymentMethod: "cash", date: atNoon(0).toISOString(), items, ...over,
    });
    const setLock = (day, b = biz) => prisma.business.update({ where: { id: b.id }, data: { booksLockDate: day } });

    // ═════════════════════════════════════════════════════════════════════════
    section("adding products and services");
    let rice; // goods, 10 bags at 100
    let oil; // goods, 5 litres, no cost yet
    let soap; // goods, nothing in stock, cost 50
    let haircut; // a service, price varies
    let flour; // goods by the kg
    await test("goods with stock and a cost price: an opening movement at that cost", async () => {
      const before = cleared.length;
      rice = await newItem({ name: `Rice ${tag}`, quantity: 10, costPrice: 100, price: 150, unit: "bag", lowStockAlert: 3 });
      eq(rice.itemType, "goods");
      eq(rice.quantity, 10);
      eq(rice.stockValue, 1000);
      eq(rice.avgCost, 100);
      eq(rice.price, 150);
      eq(rice.unit, "bag");
      eq(rice.lowStockAlert, 3);
      eq(rice.incomeAccountId, null);
      eq(rice.archivedAt, null);
      ok(!("cost" in rice), "the old cost column never leaves the server");
      const moves = await movesOf(rice.id);
      eq(moves.length, 1);
      eq(moves[0].kind, "opening");
      eq(moves[0].sourceKey, `open:${rice.id}:1`);
      eq(moves[0].quantity, 10);
      eq(moves[0].value, 1000);
      eq(moves[0].createdById, owner.id);
      ok(cleared.slice(before).includes(biz.id), "the ledger was cleared");
      await waitFor(() => prisma.auditLog.findFirst({ where: { action: "STOCK_ADJUST", resourceId: rice.id } }), "the audit row");
    });
    await test("goods with stock and no cost price: opening stock at no value, cost unknown", async () => {
      oil = await newItem({ name: `Oil ${tag}`, quantity: 5, price: 900, unit: "litre" });
      eq(oil.quantity, 5);
      eq(oil.stockValue, 0);
      eq(oil.avgCost, null);
      const moves = await movesOf(oil.id);
      eq(moves.length, 1);
      eq(moves[0].kind, "opening");
      eq(moves[0].value, 0);
    });
    await test("goods with a cost price and no stock: the cost is kept, no movement", async () => {
      soap = await newItem({ name: `Soap ${tag}`, quantity: 0, costPrice: 50, price: 80 });
      eq(soap.quantity, 0);
      eq(soap.stockValue, 0);
      eq(soap.avgCost, 50);
      eq((await movesOf(soap.id)).length, 0);
    });
    await test("a fractional quantity (kg) is taken; more than three decimals is refused", async () => {
      flour = await newItem({ name: `Flour ${tag}`, quantity: 2.5, costPrice: 40, price: 60, unit: "kg" });
      eq(flour.quantity, 2.5);
      eq(flour.stockValue, 100);
      const r = await POST("/inventory", T, { businessId: biz.id, name: "Too fine", quantity: 1.2345 });
      refused(r, 400, "BAD_QUANTITY");
      eq(r.body.field, "quantity");
    });
    await test("a service: price may be 0, its own units, stock fields ignored, Service Income by default", async () => {
      haircut = await newItem({ name: `Haircut ${tag}`, itemType: "service", price: 0, unit: "session", quantity: 7, costPrice: 30, lowStockAlert: 2 });
      eq(haircut.itemType, "service");
      eq(haircut.price, 0);
      eq(haircut.unit, "session");
      eq(haircut.quantity, 0, "a service keeps no stock");
      eq(haircut.stockValue, 0);
      eq(haircut.avgCost, null, "a service carries no cost");
      eq((await movesOf(haircut.id)).length, 0);
      for (const unit of ["hour", "job", "day", "visit", "piece"]) {
        const s = await newItem({ name: `Service ${unit} ${tag}`, itemType: "service", price: 1000, unit });
        eq(s.unit, unit);
      }
      const bad = await POST("/inventory", T, { businessId: biz.id, name: "Bad unit", itemType: "service", unit: "kg", price: 5 });
      refused(bad, 400, "BAD_UNIT");
      eq(bad.body.field, "unit");
    });
    await test("what an item needs is refused when missing or wrong, with a code and the field", async () => {
      refused(await POST("/inventory", T, { name: "No business", price: 5 }), 400, "BUSINESS_REQUIRED");
      refused(await POST("/inventory", T, { businessId: biz.id, price: 5 }), 400, "BAD_NAME");
      const t = await POST("/inventory", T, { businessId: biz.id, name: "X", itemType: "bundle" });
      refused(t, 400, "BAD_ITEM_TYPE");
      eq(t.body.field, "itemType");
      refused(await POST("/inventory", T, { businessId: biz.id, name: "X", price: -1 }), 400, "BAD_PRICE");
      refused(await POST("/inventory", T, { businessId: biz.id, name: "X", price: 1.234 }), 400, "BAD_PRICE");
      refused(await POST("/inventory", T, { businessId: biz.id, name: "X", costPrice: -5, quantity: 1 }), 400, "BAD_COST");
      refused(await POST("/inventory", T, { businessId: biz.id, name: "X", costPrice: 1.005, quantity: 1 }), 400, "BAD_COST");
      refused(await POST("/inventory", T, { businessId: biz.id, name: "X", quantity: -1 }), 400, "BAD_QUANTITY");
      refused(await POST("/inventory", T, { businessId: biz.id, name: "X", lowStockAlert: 2.5 }), 400, "BAD_LOW_STOCK");
      refused(await POST("/inventory", T, { businessId: biz.id, name: "X", incomeAccountId: { not: "x" } }), 400, "BAD_ID");
      status(await POST("/inventory", T, { businessId: rivalBiz.id, name: "X" }), 403, "another owner's business");
      status(await POST("/inventory", tRival, { businessId: biz.id, name: "X" }), 403, "a rival into this business");
    });
    await test("an item's own income account: an income account of this chart only", async () => {
      const r = await POST("/inventory", T, { businessId: biz.id, name: `Advice ${tag}`, itemType: "service", unit: "hour", price: 5000, incomeAccountId: consulting.id });
      status(r, 201);
      eq(r.body.incomeAccountId, consulting.id);
      const e = await POST("/inventory", T, { businessId: biz.id, name: "X", incomeAccountId: rent.id });
      refused(e, 400, "ACCOUNT_NOT_ALLOWED", "an expense account");
      eq(e.body.field, "incomeAccountId");
      refused(await POST("/inventory", T, { businessId: biz.id, name: "X", incomeAccountId: discount.id }), 400, "ACCOUNT_NOT_ALLOWED", "Discount");
      refused(await POST("/inventory", T, { businessId: biz.id, name: "X", incomeAccountId: rested.id }), 400, "ACCOUNT_NOT_ALLOWED", "inactive");
      refused(await POST("/inventory", T, { businessId: biz.id, name: "X", incomeAccountId: rivalSales.id }), 400, "ACCOUNT_NOT_FOUND", "another chart's");
    });
    await test("a member adds items, but never stock or a cost price (403 OWNER_ONLY), and never sees costs", async () => {
      refused(await POST("/inventory", plain.token, { businessId: biz.id, name: "Staff stock", quantity: 3 }), 403, "OWNER_ONLY");
      refused(await POST("/inventory", plain.token, { businessId: biz.id, name: "Staff cost", costPrice: 10 }), 403, "OWNER_ONLY");
      const r = await POST("/inventory", plain.token, { businessId: biz.id, name: `Staff item ${tag}`, quantity: 0, price: 20 });
      status(r, 201);
      eq(r.body.stockValue, null);
      eq(r.body.avgCost, null);
      eq(r.body.userId, owner.id, "the owner's item");
      const s = await POST("/inventory", plain.token, { businessId: biz.id, name: `Staff service ${tag}`, itemType: "service", unit: "job", price: 0, quantity: 4, costPrice: 9 });
      status(s, 201, "a service ignores stock fields, so a member may send them");
    });
    await test("a barcode is still one product's per business (409 BARCODE_TAKEN)", async () => {
      await newItem({ name: `Barcoded ${tag}`, barcode: `BC-${tag}` });
      refused(await POST("/inventory", T, { businessId: biz.id, name: "Dup", barcode: `BC-${tag}` }), 409, "BARCODE_TAKEN");
      status(await POST("/inventory", T, { businessId: biz2.id, name: "Other biz", barcode: `BC-${tag}` }), 201, "another business may use it");
    });

    // ═════════════════════════════════════════════════════════════════════════
    section("reading items: who sees what stock cost");
    await test("the owner and a reports member see stockValue and avgCost; a plain member gets null", async () => {
      const o = await GET(`/inventory?businessId=${biz.id}`, T);
      status(o, 200);
      const ro = o.body.find((i) => i.id === rice.id);
      eq(ro.stockValue, 1000);
      eq(ro.avgCost, 100);
      ok(o.body.every((i) => !("cost" in i)), "no old cost column");
      const p = await GET(`/inventory?businessId=${biz.id}`, plain.token);
      status(p, 200);
      const rp = p.body.find((i) => i.id === rice.id);
      eq(rp.quantity, 10, "the quantity is everyone's");
      eq(rp.stockValue, null);
      eq(rp.avgCost, null);
      const r = await GET(`/inventory?businessId=${biz.id}`, reports.token);
      eq(r.body.find((i) => i.id === rice.id).stockValue, 1000);
      const rv = await GET(`/inventory?businessId=${biz.id}`, tRival);
      ok(!rv.body.some((i) => i.businessId === biz.id), "a rival sees none of them");
    });

    // ═════════════════════════════════════════════════════════════════════════
    section("selling goods, services and typed lines");
    let mixedSale;
    let advice;
    await test("one sale, three kinds of line: stock and costs right, each line's income account", async () => {
      advice = (await prisma.inventoryItem.findFirst({ where: { businessId: biz.id, name: `Advice ${tag}` } }));
      const before = cleared.length;
      const r = await sell([
        { itemId: rice.id, quantity: 3, rate: 150 },
        { itemId: haircut.id, quantity: 2, rate: 500 },
        { name: "Delivery", quantity: 1, rate: 300 },
        { itemId: advice.id, quantity: 1, rate: 5000 },
        { name: "Tip", quantity: 1, rate: 200, accountId: otherIncome.id },
      ], { amount: 6900, accountId: rent.id, notes: `mixed ${tag}` });
      status(r, 201);
      mixedSale = r.body;
      eq(mixedSale.amount, 6900, "the sale's amount is what was sent");
      eq(mixedSale.accountId, null, "a sale with lines counts as its lines' accounts");
      eq(mixedSale.items.length, 5);
      const [g, s, typed, adv, tip] = mixedSale.items;
      eq(g.itemType, "goods");
      eq(g.name, rice.name, "the item's name, kept on the line");
      eq(g.quantity, 3);
      eq(g.rate, 150);
      eq(g.amount, 450, "quantity times rate when no amount is sent");
      eq(g.accountId, salesAcc.id, "goods: Sales");
      eq(g.costAmount, 300, "3 at the average of 100");
      eq(g.unitCost, 100);
      eq(g.costKnown, true);
      eq(g.position, 0);
      eq(s.itemType, "service");
      eq(s.accountId, serviceIncome.id, "a service: Service Income");
      eq(s.costAmount, 0);
      eq(s.unitCost, null);
      eq(s.costKnown, null);
      eq(typed.itemType, "other");
      eq(typed.itemId, null);
      eq(typed.name, "Delivery");
      eq(typed.accountId, salesAcc.id, "a typed line: Sales");
      eq(adv.accountId, consulting.id, "the item's own income account");
      eq(tip.accountId, otherIncome.id, "the account sent with the line");
      eq(mixedSale.inventory.length, 1, "only the goods moved");
      eq(mixedSale.inventory[0].id, rice.id);
      eq(mixedSale.inventory[0].quantity, 7);
      eq(mixedSale.inventory[0].stockValue, 700);
      const item = await itemNow(rice.id);
      eq(item.quantity, 7);
      eq(item.stockValue, 700);
      eq(item.avgCost, 100, "the average stays");
      const lines = await prisma.saleItem.findMany({ where: { saleId: mixedSale.id } });
      eq(lines.length, 5);
      ok(lines.every((l) => l.businessId === biz.id));
      const move = await prisma.stockMovement.findUnique({ where: { businessId_sourceKey: { businessId: biz.id, sourceKey: `sale:${g.id}` } } });
      ok(move, "one movement for the goods line");
      eq(move.kind, "sale");
      eq(move.quantity, -3);
      eq(move.value, -300);
      eq(new Date(move.date).getTime(), new Date(mixedSale.date).getTime(), "dated the sale's day");
      eq(move.createdById, owner.id);
      eq(await prisma.stockMovement.count({ where: { sourceKey: { startsWith: "sale:" }, itemId: { in: [haircut.id, advice.id] } } }), 0, "services move nothing");
      ok(cleared.slice(before).includes(biz.id), "the ledger was cleared");
    });
    await test("goods with no cost yet leave at no cost (costKnown false)", async () => {
      const r = await sell([{ itemId: oil.id, quantity: 2, rate: 900 }], { amount: 1800 });
      status(r, 201);
      eq(r.body.items[0].costAmount, 0);
      eq(r.body.items[0].unitCost, null);
      eq(r.body.items[0].costKnown, false);
      eq((await itemNow(oil.id)).quantity, 3);
    });
    await test("fractional goods: 0.75 kg of flour, the line amount to the kobo", async () => {
      const r = await sell([{ itemId: flour.id, quantity: 0.75, rate: 99.99 }], { amount: 75 });
      status(r, 201);
      eq(r.body.items[0].quantity, 0.75);
      eq(r.body.items[0].amount, 74.99, "0.75 x 99.99 = 74.9925, to the kobo");
      eq(r.body.items[0].costAmount, 30, "0.75 of 2.5 kg worth 100");
      const f = await itemNow(flour.id);
      eq(f.quantity, 1.75);
      eq(f.stockValue, 70);
    });
    await test("a line's amount may be sent (a line discount), to the kobo", async () => {
      const r = await sell([{ itemId: rice.id, quantity: 1, rate: 150, amount: 120 }, { name: "Bag", quantity: 2, rate: "10.50" }], { amount: 141 });
      status(r, 201);
      eq(r.body.items[0].amount, 120);
      eq(r.body.items[1].amount, 21);
      eq(r.body.items[1].rate, 10.5);
      eq((await itemNow(rice.id)).quantity, 6);
    });
    await test("not enough stock: 409 NOT_ENOUGH_STOCK with the item, what is left and the line; nothing saved", async () => {
      const salesBefore = await prisma.sales.count({ where: { businessId: biz.id } });
      const r = await sell([{ itemId: flour.id, quantity: 0.5, rate: 60 }, { itemId: rice.id, quantity: 7, rate: 150 }], { notes: `too many ${tag}` });
      refused(r, 409, "NOT_ENOUGH_STOCK");
      eq(r.body.itemId, rice.id);
      eq(r.body.available, 6);
      eq(r.body.line, 1);
      eq(r.body.field, "items");
      eq(await prisma.sales.count({ where: { businessId: biz.id } }), salesBefore, "no sale");
      eq((await itemNow(flour.id)).quantity, 1.75, "the first line's goods stayed: one transaction");
      eq((await itemNow(rice.id)).quantity, 6);
    });
    await test("an archived item, another business's item, a missing one: refused, nothing saved", async () => {
      const arch = await newItem({ name: `Old stock ${tag}`, quantity: 2, costPrice: 10 });
      status(await POST(`/inventory/${arch.id}/archive`, T), 200);
      const a = await sell([{ itemId: arch.id, quantity: 1, rate: 10 }]);
      refused(a, 409, "ITEM_ARCHIVED");
      eq(a.body.line, 0);
      const rivalItem = await prisma.inventoryItem.create({ data: { userId: rival.id, businessId: rivalBiz.id, name: "Rival goods", price: 5, quantity: 0 } });
      const rv = await sell([{ itemId: rivalItem.id, quantity: 1, rate: 5 }]);
      refused(rv, 404, "ITEM_NOT_FOUND");
      eq(rv.body.itemId, rivalItem.id);
      const other = await POST("/inventory", T, { businessId: biz2.id, name: `Biz2 goods ${tag}`, quantity: 3, costPrice: 1 });
      refused(await sell([{ itemId: other.body.id, quantity: 1, rate: 5 }]), 404, "ITEM_NOT_FOUND", "the owner's other business");
      refused(await sell([{ itemId: "no-such-item", quantity: 1, rate: 5 }]), 404, "ITEM_NOT_FOUND");
      eq((await itemNow(other.body.id)).quantity, 3);
    });
    await test("malformed lines are refused with a code, the field and the line", async () => {
      refused(await sell("rice"), 400, "BAD_ITEMS");
      const many = Array.from({ length: 101 }, () => ({ name: "x", quantity: 1, rate: 1 }));
      const m = await sell(many);
      refused(m, 400, "TOO_MANY_ITEMS");
      eq(m.body.max, 100);
      const cases = [
        [[null], "BAD_ITEMS"],
        [[{ itemId: rice.id, quantity: 0, rate: 1 }], "BAD_QUANTITY"],
        [[{ itemId: rice.id, quantity: -1, rate: 1 }], "BAD_QUANTITY"],
        [[{ itemId: rice.id, quantity: 1.0001, rate: 1 }], "BAD_QUANTITY"],
        [[{ itemId: rice.id, quantity: "abc", rate: 1 }], "BAD_QUANTITY"],
        [[{ itemId: rice.id, quantity: 1, rate: -1 }], "BAD_RATE"],
        [[{ itemId: rice.id, quantity: 1, rate: 1.001 }], "BAD_RATE"],
        [[{ itemId: rice.id, quantity: 1 }], "BAD_RATE"],
        [[{ itemId: rice.id, quantity: 1, rate: 1, amount: -2 }], "BAD_ITEM_AMOUNT"],
        [[{ quantity: 1, rate: 1 }], "ITEM_NAME_REQUIRED"],
        [[{ name: "   ", quantity: 1, rate: 1 }], "ITEM_NAME_REQUIRED"],
        [[{ name: "x".repeat(201), quantity: 1, rate: 1 }], "ITEM_NAME_TOO_LONG"],
        [[{ itemId: { not: "x" }, quantity: 1, rate: 1 }], "BAD_ITEMS"],
        [[{ itemId: [rice.id], quantity: 1, rate: 1 }], "BAD_ITEMS"],
        [[{ name: "x", quantity: 1, rate: 1, accountId: { in: ["a"] } }], "BAD_ITEMS"],
      ];
      for (const [items, code] of cases) {
        const r = await sell([{ name: "ok", quantity: 1, rate: 1 }, ...items]);
        refused(r, 400, code, JSON.stringify(items).slice(0, 60));
        eq(r.body.field, "items");
        eq(r.body.line, 1, `${code} names the line`);
      }
      const acc = await sell([{ name: "x", quantity: 1, rate: 1, accountId: rent.id }]);
      refused(acc, 400, "ACCOUNT_NOT_ALLOWED");
      eq(acc.body.field, "items");
      eq(acc.body.line, 0);
      refused(await sell([{ name: "x", quantity: 1, rate: 1, accountId: discount.id }]), 400, "ACCOUNT_NOT_ALLOWED");
      refused(await sell([{ name: "x", quantity: 1, rate: 1, accountId: rivalSales.id }]), 400, "ACCOUNT_NOT_FOUND");
      const nb = await POST("/sales", T, { amount: 5, items: [{ name: "x", quantity: 1, rate: 5 }] });
      refused(nb, 400, "BUSINESS_REQUIRED", "lines need a business");
      eq((await itemNow(rice.id)).quantity, 6, "nothing moved");
    });
    await test("an empty list of lines is a sale without lines, its own account kept", async () => {
      const r = await sell([], { amount: 100, accountId: consulting.id });
      status(r, 201);
      eq(r.body.items.length, 0);
      eq(r.body.accountId, consulting.id);
      eq(r.body.inventory.length, 0);
      const plainSale = await POST("/sales", T, { businessId: biz.id, amount: 50 });
      status(plainSale, 201);
      ok(Array.isArray(plainSale.body.items) && plainSale.body.items.length === 0, "a sale without lines answers items: []");
    });
    await test("a member sells goods: saved with the true cost, answered without it", async () => {
      const r = await sell([{ itemId: rice.id, quantity: 1, rate: 150 }], { amount: 150 }, plain.token);
      status(r, 201);
      const line = r.body.items[0];
      eq(line.unitCost, null);
      eq(line.costAmount, 0);
      eq(line.costKnown, null);
      eq(r.body.inventory[0].stockValue, null);
      eq(r.body.inventory[0].avgCost, null);
      eq(r.body.inventory[0].quantity, 5);
      const row = await prisma.saleItem.findUnique({ where: { id: line.id } });
      eq(row.costAmount, 100, "the books keep the cost");
      eq(row.unitCost, 100);
      const rp = await sell([{ itemId: rice.id, quantity: 1, rate: 150 }], { amount: 150 }, reports.token);
      status(rp, 201);
      eq(rp.body.items[0].costAmount, 100, "a reports member sees it");
      eq(rp.body.inventory[0].stockValue, 400);
      const eqty = await sell([{ name: "x", quantity: 1, rate: 1, accountId: (await chartOf(biz.id)).sys(chart.SYS.OWNER_EQUITY).id }], {}, plain.token);
      status(eqty, 400, "an equity account is not income anyway");
    });
    await test("a credit sale with lines opens the customer's debt and takes the stock", async () => {
      const cust = await prisma.customer.create({ data: { userId: owner.id, businessId: biz.id, name: `Credit ${tag}` } });
      const r = await sell([{ itemId: flour.id, quantity: 0.25, rate: 60 }], { amount: 15, isCredit: true, paymentMethod: "credit", customerId: cust.id });
      status(r, 201);
      ok(r.body.debt, "the debt");
      eq(r.body.debt.amount, 15);
      eq(r.body.items.length, 1);
      eq((await itemNow(flour.id)).quantity, 1.5);
    });
    await test("a retried create (same clientRef) gets the first sale back, the stock taken once", async () => {
      const ref = `ref-${tag}`;
      const a = await sell([{ itemId: rice.id, quantity: 1, rate: 150 }], { amount: 150, clientRef: ref });
      status(a, 201);
      const b = await sell([{ itemId: rice.id, quantity: 1, rate: 150 }], { amount: 150, clientRef: ref });
      status(b, 200);
      eq(b.body.id, a.body.id);
      eq(b.body.items.length, 1);
      eq(b.body.items[0].id, a.body.items[0].id);
      eq(b.body.inventory[0].quantity, 3, "the item as it is now");
      eq((await itemNow(rice.id)).quantity, 3, "taken once");
    });
    await test("two phones sell the last unit at once: one wins, the other gets NOT_ENOUGH_STOCK", async () => {
      const last = await newItem({ name: `Last one ${tag}`, quantity: 1, costPrice: 70 });
      const [x, y] = await Promise.all([
        sell([{ itemId: last.id, quantity: 1, rate: 100 }], { amount: 100 }),
        sell([{ itemId: last.id, quantity: 1, rate: 100 }], { amount: 100 }, plain.token),
      ]);
      const codes = [x.status, y.status].sort();
      eq(codes.join(","), "201,409", `one wins: ${JSON.stringify([x.body, y.body]).slice(0, 200)}`);
      const loser = x.status === 409 ? x : y;
      eq(loser.body.code, "NOT_ENOUGH_STOCK");
      eq(loser.body.available, 0);
      const item = await itemNow(last.id);
      eq(item.quantity, 0);
      eq(item.stockValue, 0);
      eq(await prisma.stockMovement.count({ where: { itemId: last.id, kind: "sale" } }), 1);
      // Five at once for three units: three win.
      const three = await newItem({ name: `Three ${tag}`, quantity: 3, costPrice: 10 });
      const all = await Promise.all(Array.from({ length: 5 }, (_, i) => sell([{ itemId: three.id, quantity: 1, rate: 20 }], { amount: 20 }, i % 2 ? plain.token : T)));
      eq(all.filter((r) => r.status === 201).length, 3);
      eq(all.filter((r) => r.status === 409 && r.body.code === "NOT_ENOUGH_STOCK").length, 2);
      eq((await itemNow(three.id)).quantity, 0);
    });
    await test("the books lock date: a sale with lines on a locked day is refused, nothing moves", async () => {
      await setLock(lagosDay(-3));
      const r = await sell([{ itemId: flour.id, quantity: 0.5, rate: 60 }], { date: atNoon(-5).toISOString() });
      refused(r, 409, "BOOKS_LOCKED");
      eq(r.body.lockDate, lagosDay(-3));
      eq((await itemNow(flour.id)).quantity, 1.5);
      status(await sell([{ itemId: flour.id, quantity: 0.5, rate: 60 }], { amount: 30, date: atNoon(-2).toISOString() }), 201, "after the lock");
      eq((await itemNow(flour.id)).quantity, 1);
      await setLock(null);
    });

    // ═════════════════════════════════════════════════════════════════════════
    section("lines are fixed; deleting a sale puts its goods back");
    await test("PATCH refuses items (400 ITEMS_FIXED); the rest stays editable, answered with the lines", async () => {
      const r = await PATCH(`/sales/${mixedSale.id}`, T, { items: [{ name: "x", quantity: 1, rate: 1 }] });
      refused(r, 400, "ITEMS_FIXED");
      eq(r.body.field, "items");
      const u = await PATCH(`/sales/${mixedSale.id}`, T, { amount: 6800, notes: "edited", accountId: consulting.id });
      status(u, 200);
      eq(u.body.amount, 6800);
      eq(u.body.notes, "edited");
      eq(u.body.accountId, null, "a sale with lines takes no account of its own");
      eq(u.body.items.length, 5);
      eq(u.body.items[0].costAmount, 300);
      eq(await prisma.saleItem.count({ where: { saleId: mixedSale.id } }), 5);
    });
    await test("a new date moves its goods' movements with it", async () => {
      const r = await sell([{ itemId: flour.id, quantity: 0.25, rate: 60 }], { amount: 15 });
      status(r, 201);
      const when = atNoon(-1);
      status(await PATCH(`/sales/${r.body.id}`, T, { date: when.toISOString() }), 200);
      const move = await prisma.stockMovement.findFirst({ where: { sourceKey: `sale:${r.body.items[0].id}` } });
      eq(new Date(move.date).getTime(), when.getTime());
    });
    await test("DELETE puts the goods back, quantity and value, and answers the items", async () => {
      const before = await itemNow(rice.id);
      const lineId = mixedSale.items[0].id;
      const r = await DEL(`/sales/${mixedSale.id}`, T);
      status(r, 200);
      eq(r.body.message, "Deleted");
      const back = r.body.inventory.find((i) => i.id === rice.id);
      ok(back, "the item comes back in the answer");
      eq(back.quantity, before.quantity + 3);
      eq(back.stockValue, before.stockValue + 300);
      const now = await itemNow(rice.id);
      eq(now.quantity, before.quantity + 3);
      eq(now.stockValue, before.stockValue + 300);
      eq(await prisma.stockMovement.count({ where: { sourceKey: `sale:${lineId}` } }), 0, "its movement is gone");
      eq(await prisma.saleItem.count({ where: { saleId: mixedSale.id } }), 0, "its lines went with it");
    });
    await test("a member can't delete a sale; the lock date keeps a locked sale and its stock", async () => {
      const r = await sell([{ itemId: flour.id, quantity: 0.25, rate: 60 }], { amount: 15, date: atNoon(-4).toISOString() });
      status(r, 201);
      status(await DEL(`/sales/${r.body.id}`, plain.token), 403);
      await setLock(lagosDay(-2));
      const q = (await itemNow(flour.id)).quantity;
      refused(await DEL(`/sales/${r.body.id}`, T), 409, "BOOKS_LOCKED");
      eq((await itemNow(flour.id)).quantity, q, "the goods stay sold");
      refused(await PATCH(`/sales/${r.body.id}`, T, { notes: "x" }), 409, "BOOKS_LOCKED");
      await setLock(null);
      status(await DEL(`/sales/${r.body.id}`, T), 200);
      eq((await itemNow(flour.id)).quantity, q + 0.25);
    });
    await test("GET /sales carries each sale's lines, costs per role", async () => {
      const o = await GET(`/sales?businessId=${biz.id}`, T);
      status(o, 200);
      ok(o.body.every((s) => Array.isArray(s.items)), "items on every sale");
      const withGoods = o.body.find((s) => s.items.some((l) => l.itemType === "goods" && l.costAmount > 0));
      ok(withGoods, "an owner sees costs");
      const p = await GET(`/sales?businessId=${biz.id}`, plain.token);
      ok(p.body.every((s) => s.items.every((l) => l.costAmount === 0 && l.unitCost === null && l.costKnown === null)), "a plain member does not");
    });

    // ═════════════════════════════════════════════════════════════════════════
    section("a sale recorded from a bank transfer, with lines");
    const credit = (amount, offset = 0) => prisma.transaction.create({
      data: {
        businessId: biz.id, userId: owner.id, type: "income", amount, category: "transfer", paymentMethod: "bank",
        source: "anchor", currency: "NGN", date: atNoon(offset), reference: `stk_${tag}_${Math.random().toString(36).slice(2)}`,
        description: "Transfer received from TEST",
      },
    });
    await test("create-sale takes lines: goods out on the transfer's day, services none, costs per role", async () => {
      const tx = await credit(2000, -1);
      const before = await itemNow(flour.id);
      const r = await POST(`/transactions/${tx.id}/create-sale`, bank.token, {
        amount: 1960, accountId: rent.id,
        items: [{ itemId: flour.id, quantity: 0.5, rate: 60 }, { itemId: haircut.id, quantity: 1, rate: 1900 }],
      });
      status(r, 201);
      eq(r.body.sale.items.length, 2);
      eq(r.body.sale.accountId, null, "the lines carry the accounts");
      eq(r.body.sale.items[0].itemType, "goods");
      eq(r.body.sale.items[0].costAmount, 0, "a member without the reports sees no cost");
      eq(r.body.sale.items[1].accountId, serviceIncome.id);
      eq(r.body.inventory[0].id, flour.id);
      eq(r.body.inventory[0].stockValue, null);
      eq(r.body.remainder, 40);
      eq(r.body.transaction.matchedSaleId, r.body.sale.id);
      const line = await prisma.saleItem.findFirst({ where: { saleId: r.body.sale.id, itemType: "goods" } });
      ok(line.costAmount > 0, "the cost is saved");
      const move = await prisma.stockMovement.findFirst({ where: { sourceKey: `sale:${line.id}` } });
      eq(new Date(move.date).getTime(), tx.date.getTime(), "dated the transfer's day");
      eq((await itemNow(flour.id)).quantity, before.quantity - 0.5);
      // Undo: the sale goes, and its goods come back.
      const u = await call("DELETE", `/transactions/${tx.id}/match?deleteSale=true`, bankReports.token);
      status(u, 200);
      eq(u.body.saleDeleted, true);
      eq(u.body.inventory[0].id, flour.id);
      eq(u.body.inventory[0].quantity, before.quantity);
      eq(u.body.inventory[0].stockValue, before.stockValue, "a reports member sees the value");
      eq((await itemNow(flour.id)).quantity, before.quantity);
      eq(await prisma.stockMovement.count({ where: { sourceKey: `sale:${line.id}` } }), 0);
    });
    await test("create-sale with not enough stock is refused whole: the transfer stays unmatched", async () => {
      const tx = await credit(5000);
      const r = await POST(`/transactions/${tx.id}/create-sale`, T, { items: [{ itemId: rice.id, quantity: 999, rate: 5 }] });
      refused(r, 409, "NOT_ENOUGH_STOCK");
      eq(r.body.line, 0);
      const now = await prisma.transaction.findUnique({ where: { id: tx.id } });
      eq(now.matchedSaleId, null);
      refused(await POST(`/transactions/${tx.id}/create-sale`, T, { items: [{ quantity: 1, rate: 5 }] }), 400, "ITEM_NAME_REQUIRED");
      const ok2 = await POST(`/transactions/${tx.id}/create-sale`, reports.token, { items: [{ itemId: rice.id, quantity: 1, rate: 5 }] });
      status(ok2, 403, "create-sale needs the bank (canViewBalance)");
    });

    // ═════════════════════════════════════════════════════════════════════════
    section("editing items, counting and costing them");
    await test("itemType is fixed once used (409 TYPE_FIXED); free before", async () => {
      status(await sell([{ itemId: haircut.id, quantity: 1, rate: 500 }], { amount: 500 }), 201, "a haircut sold");
      refused(await PATCH(`/inventory/${rice.id}`, T, { itemType: "service" }), 409, "TYPE_FIXED", "goods with movements");
      refused(await PATCH(`/inventory/${haircut.id}`, T, { itemType: "goods" }), 409, "TYPE_FIXED", "a service that was sold");
      const fresh = await newItem({ name: `Fresh ${tag}`, price: 10 });
      const s = await PATCH(`/inventory/${fresh.id}`, T, { itemType: "service", unit: "hour" });
      status(s, 200);
      eq(s.body.itemType, "service");
      eq(s.body.unit, "hour");
      const g = await PATCH(`/inventory/${fresh.id}`, T, { itemType: "goods", unit: "pack" });
      status(g, 200);
      eq(g.body.itemType, "goods");
      refused(await PATCH(`/inventory/${fresh.id}`, T, { itemType: "thing" }), 400, "BAD_ITEM_TYPE");
      const costed = await newItem({ name: `Costed ${tag}`, costPrice: 12 });
      const cs = await PATCH(`/inventory/${costed.id}`, T, { itemType: "service", unit: "job" });
      status(cs, 200);
      eq(cs.body.itemType, "service");
      eq(cs.body.avgCost, 12, "the cost price is kept (a service ignores it)");
      await waitFor(() => prisma.auditLog.findFirst({ where: { action: "ITEM_TYPE_CHANGE", resourceId: costed.id } }), "the type change's audit row");
      refused(await PATCH(`/inventory/${haircut.id}`, T, { unit: "kg" }), 400, "BAD_UNIT", "a service's unit");
    });
    await test("incomeAccountId: set to an income account, cleared with null; refused otherwise", async () => {
      const r = await PATCH(`/inventory/${haircut.id}`, T, { incomeAccountId: consulting.id });
      status(r, 200);
      eq(r.body.incomeAccountId, consulting.id);
      const s = await sell([{ itemId: haircut.id, quantity: 1, rate: 100 }], { amount: 100 });
      eq(s.body.items[0].accountId, consulting.id, "its sales now count there");
      refused(await PATCH(`/inventory/${haircut.id}`, T, { incomeAccountId: rent.id }), 400, "ACCOUNT_NOT_ALLOWED");
      refused(await PATCH(`/inventory/${haircut.id}`, T, { incomeAccountId: rivalSales.id }), 400, "ACCOUNT_NOT_FOUND");
      const c = await PATCH(`/inventory/${haircut.id}`, T, { incomeAccountId: null });
      eq(c.body.incomeAccountId, null);
    });
    await test("the owner changes the quantity: a count, the difference an adjustment at the average", async () => {
      const before = await itemNow(rice.id);
      const target = before.quantity - 2;
      const r = await PATCH(`/inventory/${rice.id}`, T, { quantity: target, name: `Rice ${tag}` });
      status(r, 200);
      eq(r.body.quantity, target);
      eq(r.body.stockValue, before.stockValue - 200);
      const moves = await movesOf(rice.id);
      const m = moves[moves.length - 1];
      eq(m.kind, "adjustment");
      eq(m.reason, "counted");
      eq(m.quantity, -2);
      eq(m.value, -200);
      await waitFor(() => prisma.auditLog.findFirst({ where: { action: "STOCK_ADJUST", resourceId: rice.id, metadata: { path: ["reason"], equals: "counted" } } }), "the count's audit row");
      const up = await PATCH(`/inventory/${rice.id}`, T, { quantity: target + 1 });
      eq(up.body.quantity, target + 1);
      eq(up.body.stockValue, before.stockValue - 100, "found at the average cost");
    });
    await test("the owner changes the cost price: the stock on hand valued again (revalue)", async () => {
      const before = await itemNow(rice.id);
      const r = await PATCH(`/inventory/${rice.id}`, T, { costPrice: 120 });
      status(r, 200);
      eq(r.body.avgCost, 120);
      eq(r.body.stockValue, before.quantity * 120);
      const moves = await movesOf(rice.id);
      const m = moves[moves.length - 1];
      eq(m.kind, "revalue");
      eq(m.quantity, 0);
      eq(m.value, before.quantity * 120 - before.stockValue);
      await waitFor(() => prisma.auditLog.findFirst({ where: { action: "STOCK_VALUE_SET", resourceId: rice.id } }), "the audit row");
      const same = await PATCH(`/inventory/${rice.id}`, T, { costPrice: 120, quantity: before.quantity });
      status(same, 200);
      eq((await movesOf(rice.id)).length, moves.length, "the same cost and quantity move nothing");
    });
    await test("a cost price for stock that never had a value: opening_value", async () => {
      const r = await PATCH(`/inventory/${oil.id}`, T, { costPrice: 600 });
      status(r, 200);
      eq(r.body.avgCost, 600);
      eq(r.body.stockValue, 1800, "3 litres at 600");
      const m = (await movesOf(oil.id)).pop();
      eq(m.kind, "opening_value");
      eq(m.value, 1800);
    });
    await test("a new cost and a count together: the cost first, so goods found come in at it", async () => {
      const before = await itemNow(soap.id); // 0 in stock, cost 50
      eq(before.quantity, 0);
      const r = await PATCH(`/inventory/${soap.id}`, T, { costPrice: 60, quantity: 4 });
      status(r, 200);
      eq(r.body.quantity, 4);
      eq(r.body.avgCost, 60);
      eq(r.body.stockValue, 240);
    });
    await test("a member edits names and prices, never the quantity or the cost (403 OWNER_ONLY)", async () => {
      const cur = await itemNow(rice.id);
      refused(await PATCH(`/inventory/${rice.id}`, plain.token, { quantity: cur.quantity + 5 }), 403, "OWNER_ONLY");
      refused(await PATCH(`/inventory/${rice.id}`, plain.token, { costPrice: 1 }), 403, "OWNER_ONLY");
      refused(await PATCH(`/inventory/${rice.id}`, reports.token, { quantity: 0 }), 403, "OWNER_ONLY", "even with the reports");
      const r = await PATCH(`/inventory/${rice.id}`, plain.token, { price: 160, quantity: cur.quantity, costPrice: null });
      status(r, 200, "the item's own quantity sent back changes nothing");
      eq(r.body.price, 160);
      eq(r.body.stockValue, null);
      eq(r.body.avgCost, null);
      eq((await itemNow(rice.id)).quantity, cur.quantity);
      status(await PATCH(`/inventory/${rice.id}`, tRival, { price: 1 }), 403);
      status(await PATCH(`/inventory/no-such-item`, T, { price: 1 }), 404);
      refused(await PATCH(`/inventory/${rice.id}`, T, { quantity: -1 }), 400, "BAD_QUANTITY");
      refused(await PATCH(`/inventory/${rice.id}`, T, { name: "" }), 400, "BAD_NAME");
    });
    await test("a member switching an unused item to a service and back never wipes the owner's cost price; audited", async () => {
      const it = await newItem({ name: `Priced ${tag}`, costPrice: 45, price: 70 });
      eq(it.avgCost, 45);
      const toService = await PATCH(`/inventory/${it.id}`, plain.token, { itemType: "service", unit: "job" });
      status(toService, 200);
      eq(toService.body.avgCost, null, "the member still sees no cost");
      const back = await PATCH(`/inventory/${it.id}`, plain.token, { itemType: "goods", unit: "piece" });
      status(back, 200);
      eq(back.body.itemType, "goods");
      const now = await itemNow(it.id);
      eq(now.avgCost, 45, "the owner's cost price survives the round trip");
      eq(now.quantity, 0);
      eq(now.stockValue, 0);
      const rows = await waitFor(async () => {
        const list = await prisma.auditLog.findMany({ where: { action: "ITEM_TYPE_CHANGE", resourceId: it.id }, orderBy: { createdAt: "asc" } });
        return list.length >= 2 ? list : null;
      }, "two type-change audit rows");
      const toSvc = rows.find((r) => r.metadata.to === "service");
      ok(toSvc, "the switch to a service");
      eq(toSvc.actorId, plain.user.id, "the member is named");
      eq(toSvc.metadata.from, "goods");
      eq(toSvc.metadata.byStaff, true);
      ok(rows.some((r) => r.metadata.to === "goods" && r.metadata.from === "service"), "and back");
      // Restocked at the kept cost when counted in again by the owner.
      const counted = await PATCH(`/inventory/${it.id}`, T, { quantity: 2 });
      status(counted, 200);
      eq(counted.body.stockValue, 90, "found goods come in at the kept cost");
    });
    await test("a member without the reports can't probe the hidden cost: any cost price is 403, the right guess too", async () => {
      const cur = await itemNow(rice.id);
      ok(cur.avgCost > 0, "rice has a cost");
      const right = await PATCH(`/inventory/${rice.id}`, plain.token, { costPrice: cur.avgCost, price: 160 });
      refused(right, 403, "OWNER_ONLY", "the right guess");
      const wrong = await PATCH(`/inventory/${rice.id}`, plain.token, { costPrice: cur.avgCost + 1, price: 160 });
      refused(wrong, 403, "OWNER_ONLY", "a wrong guess");
      eq(JSON.stringify(right.body), JSON.stringify(wrong.body), "the two answers are the same");
      refused(await PATCH(`/inventory/${haircut.id}`, plain.token, { costPrice: 5 }), 403, "OWNER_ONLY", "even on a service");
      refused(await PATCH(`/inventory/${rice.id}`, bank.token, { costPrice: cur.avgCost }), 403, "OWNER_ONLY", "the bank alone is not the reports");
      status(await PATCH(`/inventory/${rice.id}`, plain.token, { costPrice: null, price: 160 }), 200, "no cost price sent");
      status(await PATCH(`/inventory/${rice.id}`, plain.token, { costPrice: "", price: 160 }), 200, "an empty cost price is none");
      // A member who sees costs may send the cost they see back; any other is the owner's.
      const same = await PATCH(`/inventory/${rice.id}`, reports.token, { costPrice: cur.avgCost, price: 160 });
      status(same, 200, "a reports member sends the cost back");
      eq(same.body.avgCost, cur.avgCost);
      refused(await PATCH(`/inventory/${rice.id}`, reports.token, { costPrice: cur.avgCost + 1 }), 403, "OWNER_ONLY");
      eq((await itemNow(rice.id)).avgCost, cur.avgCost, "the cost never moved");
      eq((await itemNow(rice.id)).stockValue, cur.stockValue);
    });
    await test("a service ignores a quantity or cost price sent with an edit", async () => {
      const r = await PATCH(`/inventory/${haircut.id}`, T, { quantity: 9, costPrice: 5, price: 700 });
      status(r, 200);
      eq(r.body.quantity, 0);
      eq(r.body.avgCost, null);
      eq(r.body.price, 700);
    });
    await test("the lock date: a count or a cost dated today is refused while today is locked", async () => {
      await setLock(lagosDay(0));
      refused(await PATCH(`/inventory/${rice.id}`, T, { quantity: 1 }), 409, "BOOKS_LOCKED");
      refused(await PATCH(`/inventory/${rice.id}`, T, { costPrice: 1 }), 409, "BOOKS_LOCKED");
      refused(await POST("/inventory", T, { businessId: biz.id, name: "Locked opening", quantity: 2 }), 409, "BOOKS_LOCKED");
      eq(await prisma.inventoryItem.count({ where: { name: "Locked opening" } }), 0, "nothing saved");
      status(await PATCH(`/inventory/${rice.id}`, T, { price: 170 }), 200, "a price is no dated record");
      await setLock(null);
    });

    // ═════════════════════════════════════════════════════════════════════════
    section("adjusting stock");
    await test("damaged goods out at the average; found goods in at it", async () => {
      const before = await itemNow(rice.id);
      const r = await POST(`/inventory/${rice.id}/adjust`, T, { quantity: -1, reason: "damaged", note: "wet bag" });
      status(r, 201);
      eq(r.body.movement.kind, "adjustment");
      eq(r.body.movement.reason, "damaged");
      eq(r.body.movement.quantity, -1);
      eq(r.body.movement.value, -120);
      eq(r.body.movement.note, "wet bag");
      eq(r.body.item.quantity, before.quantity - 1);
      eq(r.body.repeated, false);
      const f = await POST(`/inventory/${rice.id}/adjust`, T, { quantity: 2, reason: "other", date: atNoon(-1).toISOString() });
      status(f, 201);
      eq(f.body.movement.value, 240);
      eq(new Date(f.body.movement.date).getTime(), atNoon(-1).getTime(), "dated the day sent");
      await waitFor(() => prisma.auditLog.findFirst({ where: { action: "STOCK_ADJUST", resourceId: rice.id, metadata: { path: ["reason"], equals: "damaged" } } }), "the audit row");
    });
    await test("a counted quantity: the difference, reason counted", async () => {
      const r = await POST(`/inventory/${soap.id}/adjust`, T, { countedQuantity: 3 });
      status(r, 201);
      eq(r.body.movement.reason, "counted");
      eq(r.body.movement.quantity, -1);
      eq(r.body.item.quantity, 3);
      const same = await POST(`/inventory/${soap.id}/adjust`, T, { countedQuantity: 3 });
      status(same, 201);
      eq(same.body.movement, null, "no difference, no movement");
    });
    await test("a retried adjustment (same clientRef) is saved once", async () => {
      const ref = `adj-${tag}`;
      const a = await POST(`/inventory/${soap.id}/adjust`, T, { quantity: -1, reason: "used", clientRef: ref });
      status(a, 201);
      const b = await POST(`/inventory/${soap.id}/adjust`, T, { quantity: -1, reason: "used", clientRef: ref });
      status(b, 200);
      eq(b.body.repeated, true);
      eq(b.body.movement.id, a.body.movement.id);
      eq((await itemNow(soap.id)).quantity, 2);
    });
    await test("adjustments refused: both or neither, no reason, too many, a service, archived, a member, a bad date, a locked day", async () => {
      refused(await POST(`/inventory/${soap.id}/adjust`, T, { quantity: -1, countedQuantity: 2, reason: "lost" }), 400, "BAD_ADJUST");
      refused(await POST(`/inventory/${soap.id}/adjust`, T, { reason: "lost" }), 400, "BAD_ADJUST");
      refused(await POST(`/inventory/${soap.id}/adjust`, T, { quantity: -1 }), 400, "BAD_REASON");
      refused(await POST(`/inventory/${soap.id}/adjust`, T, { quantity: -1, reason: "stolen" }), 400, "BAD_REASON");
      refused(await POST(`/inventory/${soap.id}/adjust`, T, { quantity: 0, reason: "lost" }), 400, "BAD_QUANTITY", "zero is no adjustment");
      const many = await POST(`/inventory/${soap.id}/adjust`, T, { quantity: -50, reason: "lost" });
      refused(many, 409, "NOT_ENOUGH_STOCK");
      eq(many.body.available, 2);
      refused(await POST(`/inventory/${haircut.id}/adjust`, T, { quantity: 1, reason: "other" }), 400, "NOT_STOCKED");
      refused(await POST(`/inventory/${soap.id}/adjust`, plain.token, { quantity: -1, reason: "lost" }), 403, "OWNER_ONLY");
      refused(await POST(`/inventory/${soap.id}/adjust`, T, { quantity: -1, reason: "lost", date: "nope" }), 400, "BAD_DATE");
      refused(await POST(`/inventory/${soap.id}/adjust`, T, { quantity: -1, reason: "lost", date: { gte: 1 } }), 400, "BAD_DATE");
      await setLock(lagosDay(-1));
      const l = await POST(`/inventory/${soap.id}/adjust`, T, { quantity: -1, reason: "lost", date: atNoon(-2).toISOString() });
      refused(l, 409, "BOOKS_LOCKED");
      eq(l.body.lockDate, lagosDay(-1));
      status(await POST(`/inventory/${soap.id}/adjust`, T, { quantity: -1, reason: "lost" }), 201, "today is open");
      await setLock(null);
      status(await POST(`/inventory/${soap.id}/adjust`, tRival, { quantity: -1, reason: "lost" }), 403);
      eq((await itemNow(soap.id)).quantity, 1);
    });

    // ═════════════════════════════════════════════════════════════════════════
    section("setting up stock value");
    await test("goods with stock and no value: one save, opening_value for each; a member can't", async () => {
      const a = await newItem({ name: `Unvalued A ${tag}`, quantity: 4 });
      const b = await newItem({ name: `Unvalued B ${tag}`, quantity: 1.5, unit: "kg" });
      refused(await POST("/inventory/stock-value", plain.token, { businessId: biz.id, items: [{ itemId: a.id, unitCost: 10 }] }), 403, "OWNER_ONLY");
      const r = await POST("/inventory/stock-value", T, { businessId: biz.id, items: [{ itemId: a.id, unitCost: 25 }, { itemId: b.id, unitCost: "33.33" }] });
      status(r, 200);
      eq(r.body.items.length, 2);
      eq(r.body.items[0].stockValue, 100);
      eq(r.body.items[1].stockValue, 50, "1.5 x 33.33 = 49.995, to the kobo");
      eq(r.body.movements.length, 2);
      ok(r.body.movements.every((m) => m.kind === "opening_value"), "opening_value");
      await waitFor(() => prisma.auditLog.findFirst({ where: { action: "STOCK_VALUE_SET", resourceId: biz.id } }), "the audit row");
    });
    await test("all or nothing: a service, another business's item, a duplicate or a bad cost refuses the whole save", async () => {
      const a = await newItem({ name: `Unvalued C ${tag}`, quantity: 2 });
      const r = await POST("/inventory/stock-value", T, { businessId: biz.id, items: [{ itemId: a.id, unitCost: 5 }, { itemId: haircut.id, unitCost: 5 }] });
      refused(r, 400, "NOT_STOCKED");
      eq(r.body.line, 1);
      eq((await itemNow(a.id)).stockValue, 0, "nothing saved");
      const other = await POST("/inventory", T, { businessId: biz2.id, name: `Biz2 unvalued ${tag}`, quantity: 1 });
      refused(await POST("/inventory/stock-value", T, { businessId: biz.id, items: [{ itemId: other.body.id, unitCost: 5 }] }), 404, "ITEM_NOT_FOUND");
      refused(await POST("/inventory/stock-value", T, { businessId: biz.id, items: [{ itemId: a.id, unitCost: 5 }, { itemId: a.id, unitCost: 6 }] }), 400, "DUPLICATE_ITEM");
      refused(await POST("/inventory/stock-value", T, { businessId: biz.id, items: [{ itemId: a.id, unitCost: -5 }] }), 400, "BAD_COST");
      refused(await POST("/inventory/stock-value", T, { businessId: biz.id, items: [{ itemId: a.id }] }), 400, "BAD_COST");
      refused(await POST("/inventory/stock-value", T, { businessId: biz.id, items: [] }), 400, "BAD_ITEMS");
      refused(await POST("/inventory/stock-value", T, { businessId: biz.id, items: [{ itemId: { not: "x" }, unitCost: 1 }] }), 400, "BAD_ITEMS");
      status(await POST("/inventory/stock-value", T, { businessId: rivalBiz.id, items: [{ itemId: a.id, unitCost: 5 }] }), 403);
      await setLock(lagosDay(0));
      refused(await POST("/inventory/stock-value", T, { businessId: biz.id, items: [{ itemId: a.id, unitCost: 5 }] }), 409, "BOOKS_LOCKED");
      await setLock(null);
      eq((await itemNow(a.id)).stockValue, 0);
    });

    // ═════════════════════════════════════════════════════════════════════════
    section("the stock history");
    await test("newest first, each movement with its record, its value and who recorded it", async () => {
      const r = await GET(`/inventory/${rice.id}/movements`, T);
      status(r, 200);
      eq(r.body.item.id, rice.id);
      const list = r.body.movements;
      ok(list.length >= 6, "the item's movements");
      const times = list.map((m) => new Date(m.createdAt).getTime());
      ok(times.every((t, i) => i === 0 || times[i - 1] >= t), "newest first");
      const opening = list.find((m) => m.kind === "opening");
      eq(opening.source.type, "opening");
      eq(opening.value, 1000);
      eq(opening.createdByName, "Ada T");
      const sale = list.find((m) => m.kind === "sale");
      eq(sale.source.type, "sale");
      ok(sale.source.id, "the sale's id");
      ok(await prisma.sales.findUnique({ where: { id: sale.source.id } }), "a real sale");
      const adj = list.find((m) => m.kind === "adjustment");
      eq(adj.source.type, "adjustment");
      ok(list.some((m) => m.createdByName === "plain T"), "a member's sale names the member");
      const two = await GET(`/inventory/${rice.id}/movements?limit=2`, T);
      eq(two.body.movements.length, 2);
      eq(two.body.movements[0].id, list[0].id);
    });
    await test("the history is the reports': a reports member reads it, a plain member and a rival can't", async () => {
      const r = await GET(`/inventory/${rice.id}/movements`, reports.token);
      status(r, 200);
      ok(r.body.movements.some((m) => m.value !== 0), "with values");
      eq(r.body.item.stockValue, (await itemNow(rice.id)).stockValue);
      refused(await GET(`/inventory/${rice.id}/movements`, plain.token), 403, "PERMISSION_DENIED");
      status(await GET(`/inventory/${rice.id}/movements`, tRival), 403);
      status(await GET(`/inventory/no-such-item/movements`, T), 404);
    });

    // ═════════════════════════════════════════════════════════════════════════
    section("archiving and deleting");
    let gone;
    await test("archive: out of use, history kept; unarchive brings it back (owner only)", async () => {
      refused(await POST(`/inventory/${soap.id}/archive`, plain.token), 403, "OWNER_ONLY");
      const a = await POST(`/inventory/${soap.id}/archive`, T);
      status(a, 200);
      ok(a.body.archivedAt, "archivedAt");
      eq(a.body.stockValue, (await itemNow(soap.id)).stockValue, "its value stays");
      await waitFor(() => prisma.auditLog.findFirst({ where: { action: "ITEM_ARCHIVE", resourceId: soap.id } }), "the audit row");
      refused(await sell([{ itemId: soap.id, quantity: 1, rate: 80 }]), 409, "ITEM_ARCHIVED");
      refused(await POST(`/inventory/${soap.id}/adjust`, T, { quantity: -1, reason: "lost" }), 409, "ITEM_ARCHIVED");
      refused(await PATCH(`/inventory/${soap.id}`, T, { quantity: 0 }), 409, "ITEM_ARCHIVED");
      const again = await POST(`/inventory/${soap.id}/archive`, T);
      eq(again.body.archivedAt, a.body.archivedAt, "archiving twice keeps the first day");
      const u = await POST(`/inventory/${soap.id}/unarchive`, T);
      status(u, 200);
      eq(u.body.archivedAt, null);
      status(await sell([{ itemId: soap.id, quantity: 1, rate: 80 }], { amount: 80 }), 201, "sellable again");
      status(await POST(`/inventory/${soap.id}/archive`, tRival), 403);
    });
    await test("delete: only without history (409 ITEM_HAS_HISTORY), owner only; a sold service goes, its lines keep the name", async () => {
      refused(await DEL(`/inventory/${rice.id}`, T), 409, "ITEM_HAS_HISTORY");
      ok(await itemNow(rice.id), "still there");
      refused(await DEL(`/inventory/${rice.id}`, plain.token), 403, "OWNER_ONLY");
      gone = await newItem({ name: `Gone ${tag}`, price: 5 });
      status(await DEL(`/inventory/${gone.id}`, T), 200);
      eq(await itemNow(gone.id), null);
      const svc = await newItem({ name: `One-off ${tag}`, itemType: "service", unit: "job", price: 300 });
      const s = await sell([{ itemId: svc.id, quantity: 1, rate: 300 }], { amount: 300 });
      status(s, 201);
      status(await DEL(`/inventory/${svc.id}`, T), 200, "a service has no stock history");
      const line = await prisma.saleItem.findUnique({ where: { id: s.body.items[0].id } });
      eq(line.itemId, null);
      eq(line.name, `One-off ${tag}`);
      eq(line.itemType, "service");
      status(await DEL(`/inventory/${svc.id}`, T), 404, "already gone");
    });

    // ═════════════════════════════════════════════════════════════════════════
    section("the sync bundle");
    await test("the owner: sales with lines and costs, items with values, stockMoves the books count", async () => {
      const r = await GET(`/sync?businessId=${biz.id}`, T);
      status(r, 200);
      ok(r.body.sales.every((s) => Array.isArray(s.items)), "items on every sale");
      ok(r.body.sales.some((s) => s.items.some((l) => l.costAmount > 0)), "with costs");
      const ri = r.body.inventory.find((i) => i.id === rice.id);
      eq(ri.stockValue, (await itemNow(rice.id)).stockValue);
      ok(r.body.inventory.every((i) => !("cost" in i)), "no old cost column");
      ok(r.body.inventory.some((i) => i.id === soap.id), "items with their archivedAt");
      ok(Array.isArray(r.body.stockMoves), "stockMoves");
      const kinds = new Set(r.body.stockMoves.map((m) => m.kind));
      for (const k of ["adjustment", "revalue", "opening", "opening_value"]) ok(kinds.has(k), `has ${k}`);
      ok(!kinds.has("sale"), "a sale's movements come with its lines, not here");
      const m = r.body.stockMoves[0];
      eq(Object.keys(m).sort().join(","), "date,id,itemId,kind,quantity,reason,value");
      ok(r.body.stockMoves.every((x) => ["adjustment", "revalue", "opening", "opening_value"].includes(x.kind)));
      const own = await prisma.stockMovement.count({ where: { businessId: biz.id, kind: { in: ["adjustment", "revalue", "opening", "opening_value"] } } });
      eq(r.body.stockMoves.length, own, "all of them, this business's");
    });
    await test("a plain member: lines and items without costs, invoice line costs hidden, stockMoves null", async () => {
      const inv = await prisma.invoice.create({
        data: {
          businessId: biz.id, userId: owner.id, invoiceNumber: `INV-${tag}`, issueDate: lagosDay(0), status: "SENT", total: 100, subtotal: 100,
          items: { create: [{ name: "Rice", quantity: 1, rate: 100, amount: 100, itemId: rice.id, itemType: "goods", unitCost: 120, costAmount: 120 }] },
        },
      });
      const r = await GET(`/sync?businessId=${biz.id}`, plain.token);
      status(r, 200);
      ok(r.body.sales.length > 0);
      ok(r.body.sales.every((s) => s.items.every((l) => l.unitCost === null && l.costAmount === 0 && l.costKnown === null)), "no line costs");
      ok(r.body.inventory.every((i) => i.stockValue === null && i.avgCost === null), "no item values");
      eq(r.body.stockMoves, null);
      const pi = r.body.invoices.find((i) => i.id === inv.id);
      eq(pi.items[0].costAmount, 0);
      eq(pi.items[0].unitCost, null);
      eq(pi.items[0].itemId, rice.id, "the rest of the line stays");
      const rp = await GET(`/sync?businessId=${biz.id}`, reports.token);
      ok(Array.isArray(rp.body.stockMoves), "a reports member gets stockMoves");
      eq(rp.body.invoices.find((i) => i.id === inv.id).items[0].costAmount, 120);
      ok(rp.body.inventory.find((i) => i.id === rice.id).stockValue > 0);
      ok(rp.body.sales.some((s) => s.items.some((l) => l.costAmount > 0)));
      const pull = await GET(`/sync/pull?businessId=${biz.id}`, T);
      status(pull, 200);
      ok(pull.body.inventory.every((i) => !("cost" in i)));
      ok(pull.body.inventory.some((i) => i.stockValue > 0), "the owner's pull keeps values");
      await prisma.invoice.delete({ where: { id: inv.id } });
    });
    await test("an incremental pull carries the sale with its lines and the item it moved", async () => {
      const since = new Date(Date.now() - 1000).toISOString();
      await sleep(20);
      const s = await sell([{ itemId: rice.id, quantity: 1, rate: 80 }], { amount: 80 });
      status(s, 201);
      const r = await GET(`/sync?businessId=${biz.id}&since=${encodeURIComponent(since)}`, T);
      status(r, 200);
      const sale = r.body.sales.find((x) => x.id === s.body.id);
      ok(sale, "the sale");
      eq(sale.items.length, 1);
      ok(r.body.inventory.some((i) => i.id === rice.id), "the item it moved");
    });
    await test("the legacy POST /sync inventory ops are refused as unknown, nothing changes", async () => {
      const before = await itemNow(rice.id);
      const r = await POST("/sync", T, {
        queue: [
          { id: "o1", type: "add_inventory_item", data: { id: `legacy-${tag}`, businessId: biz.id, name: "Legacy", quantity: 5 } },
          { id: "o2", type: "update_inventory_item", data: { id: rice.id, quantity: 999 } },
          { id: "o3", type: "delete_inventory_item", data: { id: rice.id } },
        ],
      });
      status(r, 200);
      eq(r.body.processed.length, 0);
      eq(r.body.errors.length, 3);
      ok(r.body.errors.every((e) => e.code === "SYNC_OP_FAILED"), "each refused");
      const after = await itemNow(rice.id);
      eq(after.quantity, before.quantity);
      eq(await prisma.inventoryItem.count({ where: { id: `legacy-${tag}` } }), 0);
    });
    await test("an id that is not text is refused before any route (idGuard)", async () => {
      refused(await GET(`/inventory?businessId[not]=x`, T), 400, "BAD_ID");
      refused(await POST("/sales", T, { businessId: { not: "x" }, amount: 5 }), 400, "BAD_ID");
      refused(await POST("/inventory/stock-value", T, { businessId: { in: [biz.id] }, items: [] }), 400, "BAD_ID");
    });

    // ═════════════════════════════════════════════════════════════════════════
    section("every item is the sum of its movements");
    await test("quantity and stockValue equal the sums of each goods item's movements, to the kobo", async () => {
      const items = await prisma.inventoryItem.findMany({ where: { businessId: { in: [biz.id, biz2.id] } } });
      ok(items.length > 10);
      for (const it of items) {
        const moves = await prisma.stockMovement.findMany({ where: { itemId: it.id } });
        const q = moves.reduce((s, m) => s + Math.round(m.quantity * 1000), 0);
        const v = moves.reduce((s, m) => s + K(m.value), 0);
        eq(Math.round(it.quantity * 1000), q, `${it.name} quantity`);
        eq(K(it.stockValue), v, `${it.name} value`);
        if (it.itemType === "service") eq(moves.length, 0, `${it.name} is a service`);
      }
      // Every goods line's cost is its movement's value.
      const lines = await prisma.saleItem.findMany({ where: { businessId: biz.id, itemType: "goods", itemId: { not: null } } });
      for (const l of lines) {
        const m = await prisma.stockMovement.findUnique({ where: { businessId_sourceKey: { businessId: biz.id, sourceKey: `sale:${l.id}` } } });
        ok(m, `line ${l.id} has its movement`);
        eq(K(Math.abs(m.value)), K(l.costAmount), "the line's cost is what left");
        eq(Math.round(-m.quantity * 1000), Math.round(l.quantity * 1000));
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
