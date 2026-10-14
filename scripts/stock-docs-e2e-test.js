// Stock and the documents end to end (chart of accounts release 3,
// 2026-10-13): the real /invoices, /bills and /businesses routers over HTTP,
// the real auth middleware, a real local Postgres. Covers invoices taking
// goods out of stock when issued (sent, or paid as a draft) and putting them
// back when voided, deleted or redrafted, an edit of an issued invoice moving
// its lines again in one transaction (a refusal leaves everything), quotes
// and their conversion, credit notes putting goods back (restock) and taking
// them out again, the refusals (not enough stock, an archived, unknown or
// another business's item, a bad quantity, a locked day), who sees what goods
// cost; restock bills (their lines, the amount they come to, paid now in
// cash or from the KashBook account, paid later, edited, moved to another
// day, deleted, and refused once their goods are sold); what a business
// sells; the low-stock cron's own code run against the database; the
// release 3 backfill (dry run, run, run again); Insights' best sellers, stock
// and gross profit; and, at the end, every item's quantity and stock value
// equal to the sums of its movements.
//
// Point it at a LOCAL scratch database (a clone of the migrated template):
//   node scratchpad/with-local-db.js kashbook_coa_e2e_a3r3 node scripts/stock-docs-e2e-test.js
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
const stock = require("../src/utils/stock");
const { ensureChart } = require("../src/utils/ledgerData");
const { booksFor } = require("../src/utils/booksData");
const { answerQuestion, generateInsightCards } = require("../src/utils/insightsEngine");
const { backfillR3 } = require("./backfill-r3");

const app = express();
app.use(express.json());
app.use(require("../src/middleware/idGuard").idGuard);
app.use("/invoices", require("../src/routes/invoices"));
app.use("/bills", require("../src/routes/bills"));
let bizRouterError = null;
try {
  app.use("/businesses", require("../src/routes/businesses"));
} catch (e) {
  bizRouterError = e;
}

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
const lagosDay = (offset = 0) => new Date(Date.now() + 3600000 + offset * DAY).toISOString().slice(0, 10);
const atNoon = (offset = 0) => new Date(`${lagosDay(offset)}T12:00:00+01:00`);
const kobo = (n) => Math.round(Number(n) * 100);
const milli = (n) => Math.round(Number(n) * 1000);

(async () => {
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  BASE = `http://127.0.0.1:${server.address().port}`;
  console.log(`\nSTOCK AND DOCUMENTS, END TO END\n${BASE}`);

  try {
    // ── People, businesses, charts and items ─────────────────────────────────
    const mkUser = (data) => prisma.user.create({
      data: { password: "x", lastName: "T", businessName: "B", country: "NG", currency: "NGN", ...data },
    });
    const owner = await mkUser({ email: `stockdocs-${tag}@t.local`, firstName: "Ada", accountType: "OWNER" });
    const rival = await mkUser({ email: `stockdocs-rival-${tag}@t.local`, firstName: "Rival", accountType: "OWNER" });
    const mkBiz = async (userId, name) => {
      const b = await prisma.business.create({ data: { userId, name: `${name} ${tag}`, country: "NG", baseCurrency: "NGN" } });
      await ensureChart(b.id);
      return b;
    };
    const biz = await mkBiz(owner.id, "Stock docs");
    const rivalBiz = await mkBiz(rival.id, "Rival");
    const T = signToken({ userId: owner.id, tokenVersion: 0 });
    const staffOf = async (name, grants) => {
      const s = await mkUser({ email: `stockdocs-${name}-${tag}@t.local`, firstName: name, accountType: "STAFF", employerId: owner.id });
      await prisma.staffPermission.create({ data: { userId: s.id, employerId: owner.id, grantedById: owner.id, ...grants } });
      return { user: s, token: signToken({ userId: s.id, tokenVersion: 0 }) };
    };
    const plain = await staffOf("plain", {});
    const reports = await staffOf("reports", { canViewReports: true });
    const payables = await staffOf("payables", { canManagePayables: true });
    const payBank = await staffOf("paybank", { canManagePayables: true, canViewBalance: true, canViewReports: true });

    const accountsOf = async (bizId) => prisma.ledgerAccount.findMany({ where: { businessId: bizId } });
    const sysOf = async (bizId, key) => (await accountsOf(bizId)).find((a) => a.systemKey === key);
    const stockAccount = await sysOf(biz.id, chart.SYS.STOCK);
    const serviceIncome = await sysOf(biz.id, chart.SYS.SERVICE_INCOME);
    const rentAccount = (await accountsOf(biz.id)).find((a) => a.categorySlug === "rent");
    const cashAccount = await sysOf(biz.id, chart.SYS.CASH);
    ok(stockAccount && serviceIncome && rentAccount && cashAccount, "the chart has Inventory Asset, Service Income, Rent and Cash");

    // An item, with opening stock at a cost through the stock engine.
    const mkItem = async (bizRow, name, { qty = 0, cost = null, itemType = "goods", lowStockAlert = 5, archived = false, userId } = {}) => {
      const it = await prisma.inventoryItem.create({
        data: {
          userId: userId || bizRow.userId, businessId: bizRow.id, name: `${name} ${tag}`, price: 500, quantity: 0,
          lowStockAlert, itemType,
        },
      });
      if (qty > 0) {
        await stock.putIn(prisma, {
          businessId: bizRow.id, itemId: it.id, quantity: qty, ...(cost != null ? { unitCost: cost } : {}),
          date: new Date(), sourceKey: `open:${it.id}:1`, kind: "opening",
        });
      }
      if (archived) await prisma.inventoryItem.update({ where: { id: it.id }, data: { archivedAt: new Date() } });
      return prisma.inventoryItem.findUnique({ where: { id: it.id } });
    };
    const item = (id) => prisma.inventoryItem.findUnique({ where: { id } });
    const movesOf = (keys) => prisma.stockMovement.findMany({ where: { sourceKey: { in: keys } } });
    const invoiceOf = (id) => prisma.invoice.findUnique({ where: { id }, include: { items: true } });
    const hold = async (id, qty, value, what = "") => {
      const it = await item(id);
      eq(milli(it.quantity), milli(qty), `${what} quantity`);
      eq(kobo(it.stockValue), kobo(value), `${what} stock value`);
    };

    const rice = await mkItem(biz, "Rice", { qty: 10, cost: 100 });
    const beans = await mkItem(biz, "Beans", { qty: 5 }); // no cost known
    const haircut = await mkItem(biz, "Haircut", { itemType: "service" });
    const oldStock = await mkItem(biz, "Old stock", { qty: 4, cost: 50, archived: true });
    const rivalItem = await mkItem(rivalBiz, "Rival rice", { qty: 10, cost: 100 });

    const today = lagosDay(0);
    const line = (it, quantity, rate = 300, extra = {}) => ({ name: it.name, quantity, rate, itemId: it.id, ...extra });
    const newInvoice = (items, extra = {}) => POST("/invoices", T, { businessId: biz.id, issueDate: today, items, ...extra });

    // ═════════════════════════════════════════════════════════════════════════
    section("invoice lines name an item");
    let draft;
    await test("a draft keeps each line's item and type and moves nothing", async () => {
      const r = await newInvoice([line(rice, 3), line(haircut, 1, 2000), { name: "Delivery", quantity: 1, rate: 500 }]);
      status(r, 201, "create");
      draft = r.body;
      eq(draft.status, "DRAFT");
      eq(Array.isArray(draft.inventory) && draft.inventory.length, 0, "nothing moved");
      const byName = (n) => draft.items.find((i) => i.name === n);
      eq(byName(rice.name).itemId, rice.id);
      eq(byName(rice.name).itemType, "goods");
      eq(byName(rice.name).costAmount, 0);
      eq(byName(haircut.name).itemType, "service");
      eq(byName("Delivery").itemType, "other");
      eq(byName("Delivery").itemId, null);
      await hold(rice.id, 10, 1000, "rice");
    });
    await test("a service line with no account counts as Service Income; goods and typed lines stay Sales (null)", async () => {
      const byName = (n) => draft.items.find((i) => i.name === n);
      eq(byName(haircut.name).accountId, serviceIncome.id);
      eq(byName(rice.name).accountId, null);
      eq(byName("Delivery").accountId, null);
    });

    let riceLine;
    await test("sending the draft takes the goods out at the average cost and keeps the cost on the line", async () => {
      const r = await PATCH(`/invoices/${draft.id}/status`, T, { status: "SENT" });
      status(r, 200, "send");
      eq(r.body.status, "SENT");
      await hold(rice.id, 7, 700, "rice");
      const inv = await invoiceOf(draft.id);
      riceLine = inv.items.find((i) => i.itemId === rice.id);
      eq(riceLine.costAmount, 300, "line cost");
      eq(riceLine.unitCost, 100, "unit cost");
      const [m] = await movesOf([`inv:${riceLine.id}`]);
      ok(m, "one movement for the line");
      eq(m.kind, "invoice");
      eq(m.quantity, -3);
      eq(m.value, -300);
      eq(m.date.toISOString(), `${today}T00:00:00.000Z`, "dated on the issue day");
      ok(r.body.inventory.some((i) => i.id === rice.id && i.quantity === 7), "the reply carries the item as it now is");
      const service = inv.items.find((i) => i.itemId === haircut.id);
      eq(service.costAmount, 0, "a service has no cost");
      eq((await movesOf([`inv:${service.id}`])).length, 0, "and moves no stock");
    });

    await test("an edit of an issued invoice moves its lines again, in one transaction", async () => {
      const r = await PUT(`/invoices/${draft.id}`, T, {
        issueDate: today, items: [line(rice, 4), line(haircut, 1, 2000, { accountId: serviceIncome.id })],
      });
      status(r, 200, "edit");
      await hold(rice.id, 6, 600, "rice");
      eq((await movesOf([`inv:${riceLine.id}`])).length, 0, "the old line's movement is gone");
      const inv = await invoiceOf(draft.id);
      riceLine = inv.items.find((i) => i.itemId === rice.id);
      eq(riceLine.costAmount, 400);
      eq((await movesOf([`inv:${riceLine.id}`]))[0].quantity, -4);
    });

    await test("an edit asking for more than is in stock is refused whole (409 NOT_ENOUGH_STOCK)", async () => {
      const r = await PUT(`/invoices/${draft.id}`, T, { issueDate: today, items: [line(rice, 50)], notes: "too many" });
      refused(r, 409, "NOT_ENOUGH_STOCK");
      eq(r.body.itemId, rice.id);
      eq(r.body.available, 10, "what is available counts the goods the edit gave back");
      await hold(rice.id, 6, 600, "rice");
      const inv = await invoiceOf(draft.id);
      eq(inv.items.length, 2, "the lines are as they were");
      eq(inv.items.find((i) => i.itemId === rice.id).id, riceLine.id);
      eq(inv.notes, null, "nothing else saved");
    });

    await test("back to draft puts the goods back and clears the line's cost", async () => {
      const r = await PATCH(`/invoices/${draft.id}/status`, T, { status: "DRAFT" });
      status(r, 200);
      await hold(rice.id, 10, 1000, "rice");
      const inv = await invoiceOf(draft.id);
      eq(inv.items.find((i) => i.itemId === rice.id).costAmount, 0);
      eq((await movesOf([`inv:${riceLine.id}`])).length, 0);
    });

    await test("sending again takes them out again; voiding puts them back", async () => {
      status(await PATCH(`/invoices/${draft.id}/status`, T, { status: "SENT" }), 200, "send");
      await hold(rice.id, 6, 600, "rice after send");
      const v = await PATCH(`/invoices/${draft.id}/status`, T, { status: "VOID" });
      status(v, 200, "void");
      eq(v.body.status, "VOID");
      await hold(rice.id, 10, 1000, "rice after void");
      eq(v.body.inventory.find((i) => i.id === rice.id).quantity, 10);
    });

    await test("SENT on a sent invoice changes nothing and moves nothing", async () => {
      const r = await newInvoice([line(rice, 1)], { status: "SENT" });
      status(r, 201);
      await hold(rice.id, 9, 900);
      const again = await PATCH(`/invoices/${r.body.id}/status`, T, { status: "SENT" });
      status(again, 200);
      await hold(rice.id, 9, 900, "still");
      status(await DEL(`/invoices/${r.body.id}`, T), 200, "delete");
      await hold(rice.id, 10, 1000, "back");
    });

    await test("an invoice created sent takes goods out; one of unknown cost has no cost; deleting it puts them back", async () => {
      const r = await newInvoice([line(rice, 2), line(beans, 1)], { status: "SENT" });
      status(r, 201);
      await hold(rice.id, 8, 800, "rice");
      await hold(beans.id, 4, 0, "beans");
      const b = r.body.items.find((i) => i.itemId === beans.id);
      eq(b.costAmount, 0, "unknown cost: 0");
      eq(b.unitCost, null, "and no unit cost");
      eq(r.body.inventory.length, 2, "both items in the reply");
      const d = await DEL(`/invoices/${r.body.id}`, T);
      status(d, 200, "delete");
      eq(d.body.ok, true);
      ok(d.body.inventory.some((i) => i.id === rice.id), "the reply carries the items");
      await hold(rice.id, 10, 1000, "rice back");
      await hold(beans.id, 5, 0, "beans back");
      eq(await prisma.stockMovement.count({ where: { sourceKey: { in: r.body.items.map((i) => `inv:${i.id}`) } } }), 0);
    });

    await test("creating a sent invoice with too little stock leaves no invoice and uses no number", async () => {
      const before = await prisma.business.findUnique({ where: { id: biz.id }, select: { invoiceCounter: true } });
      const count = await prisma.invoice.count({ where: { businessId: biz.id } });
      const r = await newInvoice([line(rice, 11)], { status: "SENT" });
      refused(r, 409, "NOT_ENOUGH_STOCK");
      eq(r.body.available, 10);
      const after = await prisma.business.findUnique({ where: { id: biz.id }, select: { invoiceCounter: true } });
      eq(after.invoiceCounter, before.invoiceCounter, "the number was not used");
      eq(await prisma.invoice.count({ where: { businessId: biz.id } }), count, "no invoice");
      await hold(rice.id, 10, 1000);
    });

    await test("a goods line's quantity has at most three decimals (400 BAD_QUANTITY { line })", async () => {
      const r = await newInvoice([{ name: "x", quantity: 1, rate: 1 }, line(rice, 1.2345)]);
      refused(r, 400, "BAD_QUANTITY");
      eq(r.body.line, 1);
      status(await newInvoice([line(rice, 1.5)]), 201, "1.5 is fine");
    });

    await test("an unknown item, or another business's, is refused (404 ITEM_NOT_FOUND { itemId, line })", async () => {
      const r = await newInvoice([line(rivalItem, 1)]);
      refused(r, 404, "ITEM_NOT_FOUND");
      eq(r.body.itemId, rivalItem.id);
      eq(r.body.line, 0);
      refused(await newInvoice([{ name: "x", quantity: 1, rate: 1, itemId: "no-such-item" }]), 404, "ITEM_NOT_FOUND", "unknown");
      await hold(rivalItem.id, 10, 1000, "the rival's stock");
    });

    await test("an archived item stays on a draft but is refused when sent (409 ITEM_ARCHIVED)", async () => {
      const r = await newInvoice([line(oldStock, 1)]);
      status(r, 201, "draft");
      refused(await PATCH(`/invoices/${r.body.id}/status`, T, { status: "SENT" }), 409, "ITEM_ARCHIVED");
      eq((await invoiceOf(r.body.id)).status, "DRAFT", "still a draft");
      await hold(oldStock.id, 4, 200);
    });

    await test("a payment on a draft sends it, and its goods leave stock", async () => {
      const r = await newInvoice([line(rice, 2, 300)]);
      status(r, 201);
      const p = await POST(`/invoices/${r.body.id}/payments`, T, { amount: 100, method: "cash" });
      status(p, 201, "pay");
      eq(p.body.status, "PARTIAL");
      await hold(rice.id, 8, 800);
      ok(p.body.inventory.some((i) => i.id === rice.id), "the reply carries the item");
      // A second payment moves nothing more.
      status(await POST(`/invoices/${r.body.id}/payments`, T, { amount: 100, method: "cash" }), 201);
      await hold(rice.id, 8, 800, "still");
    });

    await test("the books lock: sending (or paying) a draft dated on a locked day is refused and moves nothing", async () => {
      const r = await POST("/invoices", T, { businessId: biz.id, issueDate: lagosDay(-5), items: [line(rice, 1)] });
      status(r, 201);
      await prisma.business.update({ where: { id: biz.id }, data: { booksLockDate: lagosDay(-3) } });
      try {
        refused(await PATCH(`/invoices/${r.body.id}/status`, T, { status: "SENT" }), 409, "BOOKS_LOCKED", "send");
        refused(await POST(`/invoices/${r.body.id}/payments`, T, { amount: 50, method: "cash" }), 409, "BOOKS_LOCKED", "pay");
        await hold(rice.id, 8, 800);
        eq((await invoiceOf(r.body.id)).status, "DRAFT");
      } finally {
        await prisma.business.update({ where: { id: biz.id }, data: { booksLockDate: null } });
      }
    });

    await test("costs go only to the owner and staff with the reports", async () => {
      const r = await newInvoice([line(rice, 1)], { status: "SENT" });
      status(r, 201);
      const own = r.body.items[0];
      eq(own.costAmount, 100, "the owner sees the cost");
      const seenPlain = await GET(`/invoices/${r.body.id}`, plain.token);
      status(seenPlain, 200, "plain staff");
      eq(seenPlain.body.items[0].costAmount, 0, "plain staff: no cost");
      eq(seenPlain.body.items[0].unitCost, null);
      const seenReports = await GET(`/invoices/${r.body.id}`, reports.token);
      eq(seenReports.body.items[0].costAmount, 100, "staff with the reports see it");
      const list = await GET(`/invoices?businessId=${biz.id}`, plain.token);
      ok(list.body.every((inv) => inv.items.every((i) => i.costAmount === 0 && i.unitCost == null)), "nor in the list");
      const v = await PATCH(`/invoices/${r.body.id}/status`, plain.token, { status: "VOID" });
      status(v, 200, "plain staff void");
      const row = v.body.inventory.find((i) => i.id === rice.id);
      eq(row.stockValue, null, "an item's stock value is hidden from them");
      eq(row.avgCost, null);
      eq(row.quantity, 8, "its quantity is not");
      await hold(rice.id, 8, 800);
    });

    // ═════════════════════════════════════════════════════════════════════════
    section("quotes");
    await test("a quote never moves stock; converting it makes a draft; sending that does", async () => {
      const q = await newInvoice([line(rice, 2)], { type: "quote", status: "SENT" });
      status(q, 201, "quote");
      await hold(rice.id, 8, 800, "after the quote");
      const c = await POST(`/invoices/${q.body.id}/convert-to-invoice`, T, {});
      status(c, 200, "convert");
      eq(c.body.type, "invoice");
      eq(c.body.status, "DRAFT");
      eq(c.body.items[0].itemId, rice.id, "the line keeps its item");
      await hold(rice.id, 8, 800, "after converting");
      status(await PATCH(`/invoices/${q.body.id}/status`, T, { status: "SENT" }), 200, "send");
      await hold(rice.id, 6, 600, "after sending");
      status(await PATCH(`/invoices/${q.body.id}/status`, T, { status: "VOID" }), 200, "void");
      await hold(rice.id, 8, 800, "after voiding");
    });

    // ═════════════════════════════════════════════════════════════════════════
    section("credit notes");
    const newCredit = (items, extra = {}) => newInvoice(items, { type: "credit_note", ...extra });
    let cn;
    await test("an issued credit note puts restocked goods back at the average cost", async () => {
      const r = await newCredit([line(rice, 2, 300, { restock: true }), line(beans, 1, 300), line(haircut, 1, 100, { restock: true })], { status: "SENT" });
      status(r, 201);
      cn = r.body;
      const riceL = cn.items.find((i) => i.itemId === rice.id);
      eq(riceL.restock, true);
      eq(riceL.costAmount, 200, "the cost that came back");
      eq(riceL.unitCost, 100);
      eq(cn.items.find((i) => i.itemId === beans.id).restock, false, "a line not marked stays out");
      eq(cn.items.find((i) => i.itemId === haircut.id).restock, false, "a service never restocks");
      eq(cn.items.find((i) => i.itemId === haircut.id).accountId, null, "a credit note's line with no account stays Sales Returns");
      await hold(rice.id, 10, 1000, "rice");
      await hold(beans.id, 5, 0, "beans");
      const [m] = await movesOf([`inv:${riceL.id}`]);
      eq(m.kind, "credit_note");
      eq(m.value, 200);
    });
    await test("voiding it takes them out again", async () => {
      status(await PATCH(`/invoices/${cn.id}/status`, T, { status: "VOID" }), 200);
      await hold(rice.id, 8, 800);
    });
    await test("a draft credit note moves nothing; deleting an issued one takes its goods out", async () => {
      const r = await newCredit([line(rice, 1, 300, { restock: true })]);
      status(r, 201);
      await hold(rice.id, 8, 800, "draft");
      status(await PATCH(`/invoices/${r.body.id}/status`, T, { status: "SENT" }), 200);
      await hold(rice.id, 9, 900, "sent");
      status(await DEL(`/invoices/${r.body.id}`, T), 200);
      await hold(rice.id, 8, 800, "deleted");
    });
    await test("an edit puts the new lines' goods back before taking the old ones out", async () => {
      const salt = await mkItem(biz, "Salt", { qty: 2, cost: 40 });
      const r = await newCredit([line(salt, 2, 100, { restock: true })], { status: "SENT" });
      status(r, 201);
      await hold(salt.id, 4, 160, "returned");
      // Sell all four, so taking the return out alone would leave less than nothing.
      const sold = await newInvoice([line(salt, 4, 100)], { status: "SENT" });
      status(sold, 201);
      await hold(salt.id, 0, 0, "sold out");
      // Three come back instead of two: the three go in before the two come out.
      const e = await PUT(`/invoices/${r.body.id}`, T, { issueDate: today, items: [line(salt, 3, 120, { restock: true })], notes: "one more" });
      status(e, 200, "one more returned");
      await hold(salt.id, 1, 40, "one on the shelf");
      // Taking the return out with nothing to replace it is refused.
      refused(await PATCH(`/invoices/${r.body.id}/status`, T, { status: "VOID" }), 409, "STOCK_ALREADY_SOLD", "void");
      refused(await DEL(`/invoices/${r.body.id}`, T), 409, "STOCK_ALREADY_SOLD", "delete");
      eq((await invoiceOf(r.body.id)).status, "SENT");
      status(await PATCH(`/invoices/${sold.body.id}/status`, T, { status: "VOID" }), 200, "void the sale");
      status(await PATCH(`/invoices/${r.body.id}/status`, T, { status: "VOID" }), 200, "then the return");
      await hold(salt.id, 2, 80, "as at the start");
    });

    // ═════════════════════════════════════════════════════════════════════════
    section("an edit keeps the stock movements of the lines it leaves as they were");
    {
      const maize = await mkItem(biz, "Maize", { qty: 10, cost: 100 });
      const maizeLine = async (invoiceId) => (await invoiceOf(invoiceId)).items.find((i) => i.itemId === maize.id);
      let sale;
      let kept;
      await test("an invoice issued on an earlier day, then a dearer restock", async () => {
        sale = await POST("/invoices", T, { businessId: biz.id, issueDate: lagosDay(-3), status: "SENT", items: [line(maize, 4, 300)] });
        status(sale, 201);
        kept = await maizeLine(sale.body.id);
        eq(kept.costAmount, 400);
        await hold(maize.id, 6, 600, "after the sale");
        status(await POST("/bills", T, { businessId: biz.id, vendorName: "Farm", billDate: today, items: [{ itemId: maize.id, quantity: 10, unitCost: 200 }] }), 201, "restock");
        await hold(maize.id, 16, 2600, "after the restock");
      });
      await test("an edit of the notes alone (every line sent back) keeps the line's cost and the stock as they are", async () => {
        const [before] = await movesOf([`inv:${kept.id}`]);
        const r = await PUT(`/invoices/${sale.body.id}`, T, { issueDate: lagosDay(-3), items: [line(maize, 4, 300)], notes: "thanks" });
        status(r, 200);
        const now = await maizeLine(sale.body.id);
        ok(now.id !== kept.id, "the line is a new row");
        eq(now.costAmount, 400, "the cost it was sold at");
        eq(now.unitCost, 100);
        await hold(maize.id, 16, 2600, "nothing moved");
        eq((await movesOf([`inv:${kept.id}`])).length, 0, "the old key is gone");
        const [m] = await movesOf([`inv:${now.id}`]);
        eq(m.id, before.id, "the same movement, under the new line");
        eq(m.date.toISOString(), `${lagosDay(-3)}T00:00:00.000Z`, "still on its day");
        eq(r.body.inventory.length, 0, "no item changed");
        kept = now;
      });
      await test("a new issue day moves the movement to it and keeps the cost", async () => {
        const r = await PUT(`/invoices/${sale.body.id}`, T, { issueDate: lagosDay(-2), items: [line(maize, 4, 300)] });
        status(r, 200);
        const now = await maizeLine(sale.body.id);
        eq(now.costAmount, 400);
        const [m] = await movesOf([`inv:${now.id}`]);
        eq(m.date.toISOString(), `${lagosDay(-2)}T00:00:00.000Z`);
        await hold(maize.id, 16, 2600);
        kept = now;
      });
      await test("another line added moves only itself; the kept line keeps its cost", async () => {
        const r = await PUT(`/invoices/${sale.body.id}`, T, { issueDate: lagosDay(-2), items: [line(maize, 4, 300), line(rice, 1, 300)] });
        status(r, 200);
        eq((await maizeLine(sale.body.id)).costAmount, 400);
        await hold(maize.id, 16, 2600, "maize untouched");
        eq(r.body.inventory.map((i) => i.id).join(), rice.id, "only the rice moved");
        // Taken back off, the rice returns.
        status(await PUT(`/invoices/${sale.body.id}`, T, { issueDate: lagosDay(-2), items: [line(maize, 4, 300)] }), 200);
        eq((await maizeLine(sale.body.id)).costAmount, 400);
      });
      await test("a line that changed moves again at the average cost now", async () => {
        const r = await PUT(`/invoices/${sale.body.id}`, T, { issueDate: lagosDay(-2), items: [line(maize, 5, 300)] });
        status(r, 200);
        // The 4 come back (16 + 4 = 20, worth 3000), then 5 go at 150.
        eq((await maizeLine(sale.body.id)).costAmount, 750);
        await hold(maize.id, 15, 2250);
      });
      await test("a credit note's unchanged return keeps its cost when the average has moved", async () => {
        const cnr = await newCredit([line(maize, 1, 300, { restock: true })], { status: "SENT" });
        status(cnr, 201);
        const back = cnr.body.items[0];
        eq(back.costAmount, 150);
        await hold(maize.id, 16, 2400);
        status(await POST("/bills", T, { businessId: biz.id, vendorName: "Farm", billDate: today, items: [{ itemId: maize.id, quantity: 4, unitCost: 400 }] }), 201);
        await hold(maize.id, 20, 4000, "average now 200");
        const r = await PUT(`/invoices/${cnr.body.id}`, T, { issueDate: today, items: [line(maize, 1, 300, { restock: true })], notes: "kept" });
        status(r, 200);
        eq(r.body.items[0].costAmount, 150, "the cost it came back at");
        await hold(maize.id, 20, 4000, "nothing moved");
      });

      await test("the lock: credit applied to an invoice with goods is a day its edit touches", async () => {
        const who = `Lock buyer ${tag}`;
        const tomorrow = lagosDay(1);
        const goodsInv = await POST("/invoices", T, { businessId: biz.id, customerName: who, issueDate: tomorrow, status: "SENT", items: [line(maize, 1, 1000)] });
        const plainInv = await POST("/invoices", T, { businessId: biz.id, customerName: who, issueDate: tomorrow, status: "SENT", items: [{ name: "Advice", quantity: 1, rate: 1000 }] });
        const cnote = await newCredit([{ name: "Goodwill", quantity: 1, rate: 200 }], { customerName: who, issueDate: tomorrow, status: "SENT" });
        for (const x of [goodsInv, plainInv, cnote]) status(x, 201, "document");
        status(await POST(`/invoices/${cnote.body.id}/apply-credit`, T, { invoiceId: goodsInv.body.id, amount: 100 }), 201, "apply to the goods invoice");
        status(await POST(`/invoices/${cnote.body.id}/apply-credit`, T, { invoiceId: plainInv.body.id, amount: 100 }), 201, "apply to the other");
        await prisma.business.update({ where: { id: biz.id }, data: { booksLockDate: today } });
        try {
          const g = await PUT(`/invoices/${goodsInv.body.id}`, T, { issueDate: tomorrow, items: [line(maize, 1, 1000)], notes: "late" });
          refused(g, 409, "BOOKS_LOCKED", "the goods invoice");
          const p = await PUT(`/invoices/${plainInv.body.id}`, T, { issueDate: tomorrow, items: [{ name: "Advice", quantity: 1, rate: 1000 }], notes: "late" });
          status(p, 200, "an invoice without goods: credit applied counts nowhere, as before");
        } finally {
          await prisma.business.update({ where: { id: biz.id }, data: { booksLockDate: null } });
        }
      });
    }

    // ═════════════════════════════════════════════════════════════════════════
    section("who may put goods back from a credit note");
    await test("staff without bills cannot send a restock line (403 PERMISSION_DENIED { permission, field, line })", async () => {
      const r = await POST("/invoices", plain.token, {
        businessId: biz.id, issueDate: today, type: "credit_note", status: "SENT",
        items: [{ name: "Note", quantity: 1, rate: 10 }, line(rice, 1, 300, { restock: true })],
      });
      refused(r, 403, "PERMISSION_DENIED");
      eq(r.body.permission, "canManagePayables");
      eq(r.body.field, "items");
      eq(r.body.line, 1);
      const without = await POST("/invoices", plain.token, {
        businessId: biz.id, issueDate: today, type: "credit_note", status: "SENT", items: [line(rice, 1, 300)],
      });
      status(without, 201, "the credit note without restock is fine");
      eq(without.body.items[0].restock, false);
      status(await DEL(`/invoices/${without.body.id}`, T), 200);
    });
    await test("staff with bills may; others may send back an owner's return as it was, never change it", async () => {
      const before = await item(rice.id);
      const ok1 = await POST("/invoices", payables.token, {
        businessId: biz.id, issueDate: today, type: "credit_note", status: "SENT", items: [line(rice, 1, 300, { restock: true })],
      });
      status(ok1, 201, "payables staff");
      eq(ok1.body.items[0].restock, true);
      await hold(rice.id, before.quantity + 1, before.stockValue + 100, "one back at the average cost");
      const own = await newCredit([line(rice, 2, 300, { restock: true })]);
      status(own, 201, "the owner's draft return");
      status(await PUT(`/invoices/${own.body.id}`, plain.token, { issueDate: today, items: [line(rice, 2, 300, { restock: true })], notes: "seen" }), 200, "sent back as it was");
      refused(await PUT(`/invoices/${own.body.id}`, plain.token, { issueDate: today, items: [line(rice, 3, 300, { restock: true })] }), 403, "PERMISSION_DENIED", "more");
      refused(
        await PUT(`/invoices/${own.body.id}`, plain.token, { issueDate: today, items: [line(rice, 2, 300, { restock: true }), line(beans, 1, 10, { restock: true })] }),
        403, "PERMISSION_DENIED", "another item",
      );
      status(await PUT(`/invoices/${own.body.id}`, plain.token, { issueDate: today, items: [line(rice, 2, 300)] }), 200, "taking the restock off is fine");
      for (const id of [ok1.body.id, own.body.id]) status(await DEL(`/invoices/${id}`, T), 200);
      await hold(rice.id, before.quantity, before.stockValue, "as before");
    });

    // ═════════════════════════════════════════════════════════════════════════
    section("restock bills");
    const newBill = (body, token = T) => POST("/bills", token, { businessId: biz.id, vendorName: "Supplier", billDate: today, ...body });
    let restock;
    await test("a restock is on Inventory Asset, its amount what its lines come to, its goods in stock at that value", async () => {
      const r = await newBill({ accountId: rentAccount.id, items: [{ itemId: rice.id, quantity: 10, unitCost: 120 }, { itemId: beans.id, quantity: 2.5, unitCost: 33.333 }] });
      status(r, 201, "create");
      restock = r.body.bill;
      eq(restock.accountId, stockAccount.id, "the account sent is not used");
      eq(kobo(restock.amount), 120000 + kobo(stock.lineCost(2.5, 33.333)), "the lines' amount");
      eq(restock.items.length, 2);
      eq(restock.items[0].itemId, rice.id);
      eq(restock.items[0].amount, 1200);
      eq(restock.items[1].amount, 83.33);
      eq(restock.status, "unpaid");
      eq(r.body.payment, null);
      await hold(rice.id, 18, 2000, "rice");
      await hold(beans.id, 7.5, 83.33, "beans");
      eq((await item(rice.id)).avgCost, 2000 / 18, "the new average");
      const ms = await movesOf(restock.items.map((i) => `bill:${i.id}`));
      eq(ms.length, 2);
      ok(ms.every((m) => m.kind === "purchase" && m.date.toISOString() === `${today}T00:00:00.000Z`), "purchases on the bill's day");
      eq(r.body.inventory.length, 2);
      const one = await GET(`/bills/${restock.id}`, T);
      eq(one.body.bill.items.length, 2, "GET carries the lines");
      const list = await GET(`/bills?businessId=${biz.id}`, T);
      eq(list.body.bills.find((b) => b.id === restock.id).items.length, 2, "and the list");
    });
    await test("an amount that is not the lines' is refused (400 AMOUNT_MISMATCH { amount })", async () => {
      const r = await newBill({ amount: 999, items: [{ itemId: rice.id, quantity: 1, unitCost: 100 }] });
      refused(r, 400, "AMOUNT_MISMATCH");
      eq(r.body.amount, 100);
      status(await newBill({ amount: 100, items: [{ itemId: rice.id, quantity: 1, unitCost: 100 }] }), 201, "the right amount is fine");
      await hold(rice.id, 19, 2100);
    });
    await test("lines are goods of this business: a service, an archived or a rival's item is refused and nothing is saved", async () => {
      const bills = await prisma.businessDebt.count({ where: { businessId: biz.id } });
      const s = await newBill({ items: [{ itemId: rice.id, quantity: 1, unitCost: 1 }, { itemId: haircut.id, quantity: 1, unitCost: 1 }] });
      refused(s, 400, "NOT_STOCKED", "service");
      eq(s.body.line, 1);
      refused(await newBill({ items: [{ itemId: oldStock.id, quantity: 1, unitCost: 1 }] }), 409, "ITEM_ARCHIVED", "archived");
      refused(await newBill({ items: [{ itemId: rivalItem.id, quantity: 1, unitCost: 1 }] }), 404, "ITEM_NOT_FOUND", "rival");
      refused(await newBill({ items: [] }), 400, "BAD_ITEMS", "no lines");
      refused(await newBill({ items: [{ itemId: rice.id, quantity: 0, unitCost: 1 }] }), 400, "BAD_QUANTITY", "zero");
      refused(await newBill({ items: [{ itemId: rice.id, quantity: 1, unitCost: -1 }] }), 400, "BAD_COST", "negative cost");
      refused(await newBill({ items: [{ itemId: rice.id, quantity: 1, unitCost: 0 }] }), 400, "BAD_AMOUNT", "nothing to pay");
      eq(await prisma.businessDebt.count({ where: { businessId: biz.id } }), bills, "no bill saved");
      await hold(rice.id, 19, 2100);
    });
    await test("paid now in cash: one payment of the whole amount on the bill's day", async () => {
      const r = await newBill({ billDate: lagosDay(-1), items: [{ itemId: rice.id, quantity: 1, unitCost: 100 }], payNow: { method: "cash", paidThroughAccountId: cashAccount.id } });
      status(r, 201);
      eq(r.body.bill.status, "paid");
      eq(r.body.bill.balance, 0);
      eq(r.body.payment.amount, 100);
      eq(r.body.payment.method, "cash");
      eq(r.body.payment.paidThroughAccountId, cashAccount.id);
      eq(new Date(r.body.payment.date).toISOString(), `${lagosDay(-1)}T00:00:00.000Z`, "on the bill's day");
      await hold(rice.id, 20, 2200);
    });
    const debit = (amount, over = {}) => prisma.transaction.create({
      data: {
        businessId: biz.id, userId: owner.id, type: "expense", amount, paymentMethod: "bank", category: "transfer",
        source: "anchor", currency: "NGN", date: atNoon(0), description: "e2e debit", ...over,
      },
    });
    await test("paid now from the KashBook account: the debit carries the bill", async () => {
      const d = await debit(300);
      const r = await newBill({ items: [{ itemId: rice.id, quantity: 2, unitCost: 150 }], payNow: { method: "bank", transactionId: d.id } });
      status(r, 201);
      eq(r.body.bill.status, "paid");
      eq(r.body.payment.transactionId, d.id);
      eq(r.body.transaction.matchedBillId, r.body.bill.id);
      eq(r.body.transaction.matchedAmount, 300);
      await hold(rice.id, 22, 2500);
    });
    await test("a debit smaller than the restock is refused, and nothing is saved", async () => {
      const d = await debit(100);
      const bills = await prisma.businessDebt.count({ where: { businessId: biz.id } });
      const r = await newBill({ items: [{ itemId: rice.id, quantity: 2, unitCost: 150 }], payNow: { method: "bank", transactionId: d.id } });
      refused(r, 400, "EXCEEDS_TRANSFER");
      eq(await prisma.businessDebt.count({ where: { businessId: biz.id } }), bills, "no bill");
      eq((await prisma.transaction.findUnique({ where: { id: d.id } })).matchedBillId, null, "the debit is free");
      await hold(rice.id, 22, 2500);
      refused(await newBill({ items: [{ itemId: rice.id, quantity: 1, unitCost: 1 }], payNow: { method: "bank" } }), 400, "TRANSACTION_REQUIRED");
      refused(await newBill({ items: [{ itemId: rice.id, quantity: 1, unitCost: 1 }], payNow: { method: "barter" } }), 400, "BAD_METHOD");
      refused(await newBill({ items: [{ itemId: rice.id, quantity: 1, unitCost: 1 }], payNow: "cash" }), 400, "BAD_PAY_NOW");
    });
    await test("staff: bills need canManagePayables, paying from the KashBook account canViewBalance too", async () => {
      const d = await debit(100);
      refused(await newBill({ items: [{ itemId: rice.id, quantity: 1, unitCost: 100 }] }, plain.token), 403, "PERMISSION_DENIED", "plain");
      refused(
        await newBill({ items: [{ itemId: rice.id, quantity: 1, unitCost: 100 }], payNow: { method: "bank", transactionId: d.id } }, payables.token),
        403, "PERMISSION_DENIED", "payables without the bank",
      );
      const r = await newBill({ items: [{ itemId: rice.id, quantity: 1, unitCost: 100 }] }, payables.token);
      status(r, 201, "payables staff");
      const row = r.body.inventory.find((i) => i.id === rice.id);
      eq(row.stockValue, null, "no stock value without the reports");
      eq(row.quantity, 23);
      const b = await newBill({ items: [{ itemId: rice.id, quantity: 1, unitCost: 100 }], payNow: { method: "bank", transactionId: d.id } }, payBank.token);
      status(b, 201, "with the bank");
      eq(b.body.inventory.find((i) => i.id === rice.id).stockValue, 2700, "and they see costs with the reports");
      await hold(rice.id, 24, 2700);
    });
    await test("paid later: a payment towards a restock as towards any bill", async () => {
      const p = await POST(`/bills/${restock.id}/payments`, T, { amount: 500, method: "cash" });
      status(p, 201);
      eq(p.body.bill.status, "partial");
      eq(p.body.bill.items.length, 2, "the reply carries the lines");
    });
    await test("an edit that sends the same lines again moves nothing", async () => {
      const r = await PATCH(`/bills/${restock.id}`, T, {
        note: "same lines", items: [{ itemId: rice.id, quantity: 10, unitCost: 120 }, { itemId: beans.id, quantity: 2.5, unitCost: 33.333 }],
      });
      status(r, 200);
      eq(r.body.inventory.length, 0);
      eq(r.body.bill.items[0].id, restock.items[0].id, "the lines are the same rows");
      await hold(rice.id, 24, 2700);
    });
    await test("an edit with other lines replaces them, and the amount follows", async () => {
      const r = await PATCH(`/bills/${restock.id}`, T, { items: [{ itemId: rice.id, quantity: 8, unitCost: 120 }] });
      status(r, 200);
      eq(r.body.bill.amount, 960);
      eq(r.body.bill.items.length, 1);
      eq(r.body.bill.balance, 460, "less what was paid");
      await hold(rice.id, 22, 2700 - 1200 + 960);
      await hold(beans.id, 5, 0, "beans back as before the restock");
      eq((await movesOf(restock.items.map((i) => `bill:${i.id}`))).length, 0, "the old lines' movements are gone");
      restock = r.body.bill;
    });
    await test("a restock stays on Inventory Asset and at its lines' amount", async () => {
      refused(await PATCH(`/bills/${restock.id}`, T, { accountId: rentAccount.id }), 409, "STOCK_BILL_ACCOUNT");
      refused(await PATCH(`/bills/${restock.id}`, T, { amount: 5000 }), 400, "AMOUNT_MISMATCH");
      refused(await PATCH(`/bills/${restock.id}`, T, { items: [{ itemId: rice.id, quantity: 1, unitCost: 100 }] }), 409, "AMOUNT_BELOW_PAID", "below what is paid");
      status(await PATCH(`/bills/${restock.id}`, T, { accountId: stockAccount.id, amount: 960 }), 200, "its own account and amount are fine");
    });
    await test("a new bill date moves its goods' movements to that day", async () => {
      const r = await PATCH(`/bills/${restock.id}`, T, { billDate: lagosDay(-2) });
      status(r, 200);
      const [m] = await movesOf([`bill:${restock.items[0].id}`]);
      eq(m.date.toISOString(), `${lagosDay(-2)}T00:00:00.000Z`);
    });
    await test("a bill's lines make it a restock", async () => {
      const b = await newBill({ amount: 700, accountId: rentAccount.id });
      status(b, 201);
      eq(b.body.bill.items.length, 0, "a bill without lines has none");
      const r = await PATCH(`/bills/${b.body.bill.id}`, T, { items: [{ itemId: beans.id, quantity: 7, unitCost: 100 }] });
      status(r, 200);
      eq(r.body.bill.accountId, stockAccount.id);
      eq(r.body.bill.amount, 700);
      await hold(beans.id, 12, 700);
      status(await DEL(`/bills/${b.body.bill.id}`, T), 200, "delete");
      await hold(beans.id, 5, 0, "back");
    });
    await test("goods sold since: an edit or a delete is refused (409 STOCK_ALREADY_SOLD); once they are back, it goes", async () => {
      const oil = await mkItem(biz, "Oil", {});
      const b = await newBill({ items: [{ itemId: oil.id, quantity: 5, unitCost: 200 }] });
      status(b, 201);
      const sale = await newInvoice([line(oil, 5, 400)], { status: "SENT" });
      status(sale, 201);
      await hold(oil.id, 0, 0, "sold out");
      refused(await PATCH(`/bills/${b.body.bill.id}`, T, { items: [{ itemId: oil.id, quantity: 3, unitCost: 200 }] }), 409, "STOCK_ALREADY_SOLD", "edit");
      refused(await DEL(`/bills/${b.body.bill.id}`, T), 409, "STOCK_ALREADY_SOLD", "delete");
      eq((await prisma.billItem.count({ where: { billId: b.body.bill.id } })), 1, "the lines are as they were");
      status(await PATCH(`/invoices/${sale.body.id}/status`, T, { status: "VOID" }), 200);
      const d = await DEL(`/bills/${b.body.bill.id}`, T);
      status(d, 200, "delete");
      eq(d.body.inventory.find((i) => i.id === oil.id).quantity, 0);
      await hold(oil.id, 0, 0);
      eq(await prisma.billItem.count({ where: { billId: b.body.bill.id } }), 0);
    });
    await test("deleting a restock frees its debit and takes its goods out", async () => {
      const d = await debit(150);
      const b = await newBill({ items: [{ itemId: rice.id, quantity: 1, unitCost: 150 }], payNow: { method: "bank", transactionId: d.id } });
      status(b, 201);
      const before = await item(rice.id);
      const r = await DEL(`/bills/${b.body.bill.id}`, T);
      status(r, 200);
      eq(r.body.transactions[0].id, d.id);
      eq((await prisma.transaction.findUnique({ where: { id: d.id } })).matchedBillId, null);
      await hold(rice.id, before.quantity - 1, before.stockValue - 150);
    });

    // ═════════════════════════════════════════════════════════════════════════
    section("what the business sells");
    if (bizRouterError) {
      await test("routes/businesses.js loads", async () => { throw bizRouterError; });
    } else {
      await test("the owner sets it; GET returns it; null clears it", async () => {
        const r = await PATCH(`/businesses/${biz.id}`, T, { sells: "services" });
        status(r, 200);
        eq(r.body.sells, "services");
        const list = await GET("/businesses", T);
        eq(list.body.find((b) => b.id === biz.id).sells, "services");
        status(await PATCH(`/businesses/${biz.id}`, T, { sells: "both" }), 200);
        const cleared = await PATCH(`/businesses/${biz.id}`, T, { sells: null });
        eq(cleared.body.sells, null);
        const other = await PATCH(`/businesses/${biz.id}`, T, { emoji: "x" });
        eq(other.body.sells, null, "a PATCH without it leaves it");
      });
      await test("anything else is refused (400 BAD_SELLS), and staff cannot set it", async () => {
        refused(await PATCH(`/businesses/${biz.id}`, T, { sells: "stuff" }), 400, "BAD_SELLS");
        status(await PATCH(`/businesses/${biz.id}`, payBank.token, { sells: "goods" }), 403, "staff");
        eq((await prisma.business.findUnique({ where: { id: biz.id } })).sells, null);
      });
    }

    // ═════════════════════════════════════════════════════════════════════════
    section("the low-stock cron (server.js sendLowStockAlerts, run from its own text)");
    {
      const src = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
      const m = /(async function sendLowStockAlerts\(\) \{[\s\S]*?\r?\n\})\r?\n\/\/ End of sendLowStockAlerts\./.exec(src);
      const pushes = [];
      const fakeFetch = async (u, opts) => { pushes.push(JSON.parse(opts.body)); return { ok: true }; };
      const quiet = { log: () => {}, error: console.error };
      const run = m
        ? new Function("prisma", "fetch", "console", `return (${m[1]});`)(prisma, fakeFetch, quiet)
        : null;
      const cronOwner = await mkUser({ email: `stockdocs-cron-${tag}@t.local`, firstName: "Cron", accountType: "OWNER", expoPushToken: `ExponentPushToken[${tag}]` });
      const quietOwner = await mkUser({ email: `stockdocs-quiet-${tag}@t.local`, firstName: "Quiet", accountType: "OWNER", notificationsEnabled: false });
      const cronBiz = await mkBiz(cronOwner.id, "Cron");
      const quietBiz = await mkBiz(quietOwner.id, "Quiet");
      const low = await mkItem(cronBiz, "Low", { qty: 2, cost: 10 });
      const service = await mkItem(cronBiz, "Service", { itemType: "service" });
      const shelved = await mkItem(cronBiz, "Shelved", { qty: 1, cost: 10, archived: true });
      const plenty = await mkItem(cronBiz, "Plenty", { qty: 50, cost: 10 });
      await prisma.inventoryItem.update({ where: { id: plenty.id }, data: { lowStockNotifiedAt: new Date() } }); // a stale flag
      const quietLow = await mkItem(quietBiz, "Quiet low", { qty: 1, cost: 10 });
      // A business that sells services only sees no stock anywhere.
      const salonBiz = await mkBiz(cronOwner.id, "Salon");
      await prisma.business.update({ where: { id: salonBiz.id }, data: { sells: "services" } });
      const salonLow = await mkItem(salonBiz, "Salon low", { qty: 1, cost: 10 });
      const mine = () => pushes.filter((p) => p.to === `ExponentPushToken[${tag}]`).map((p) => p.body);
      const notes = () => prisma.appNotification.count({ where: { userId: cronOwner.id } });

      await test("the function is in server.js", async () => ok(run, "sendLowStockAlerts not found"));
      if (run) {
        await test("goods at or below their level alert once; services and archived items never", async () => {
          await run();
          eq(mine().length, 1, "one push");
          ok(mine()[0].startsWith(low.name), "for the low goods");
          eq(await notes(), 1, "one in-app notification");
          ok((await item(low.id)).lowStockNotifiedAt, "marked");
          eq((await item(service.id)).lowStockNotifiedAt, null, "a service is never low");
          eq((await item(shelved.id)).lowStockNotifiedAt, null, "an archived item is never alerted");
          eq((await item(salonLow.id)).lowStockNotifiedAt, null, "nor goods of a business that sells services only");
        });
        await test("a stale flag on stock above its level is cleared", async () => {
          eq((await item(plenty.id)).lowStockNotifiedAt, null);
        });
        await test("an owner with notifications off is passed over and not marked", async () => {
          eq((await item(quietLow.id)).lowStockNotifiedAt, null);
          eq(await prisma.appNotification.count({ where: { userId: quietOwner.id } }), 0);
        });
        await test("the next run does not alert again", async () => {
          await run();
          eq(mine().length, 1);
          eq(await notes(), 1);
        });
        await test("stock coming in above the level clears the flag, and the next fall alerts again", async () => {
          await stock.putIn(prisma, { businessId: cronBiz.id, itemId: low.id, quantity: 10, unitCost: 10, date: new Date(), sourceKey: `adj:cron-${tag}-in`, kind: "purchase" });
          eq((await item(low.id)).lowStockNotifiedAt, null, "cleared by the restock");
          await run();
          eq(mine().length, 1, "not low now");
          await stock.takeOut(prisma, { businessId: cronBiz.id, itemId: low.id, quantity: 9, date: new Date(), sourceKey: `adj:cron-${tag}-out`, kind: "adjustment", reason: "lost" });
          await run();
          eq(mine().length, 2, "alerted again");
          eq(await notes(), 2);
        });
      }
    }

    // ═════════════════════════════════════════════════════════════════════════
    section("the release 3 backfill");
    {
      const bfOwner = await mkUser({ email: `stockdocs-bf-${tag}@t.local`, firstName: "Old", accountType: "OWNER" });
      const bfBiz = await mkBiz(bfOwner.id, "Old shop");
      // Items as before release 3: a quantity and maybe a cost price, no movements.
      const raw = (name, data) => prisma.inventoryItem.create({
        data: { userId: bfOwner.id, businessId: bfBiz.id, name: `${name} ${tag}`, price: 100, ...data },
      });
      const costed = await raw("Costed", { quantity: 10, cost: 50 });
      const fractional = await raw("Fractional", { quantity: 2.5, cost: 33.33 });
      const uncosted = await raw("Uncosted", { quantity: 3 });
      const empty = await raw("Empty", { quantity: 0, cost: 20 });
      const service = await raw("Service", { quantity: 4, cost: 9, itemType: "service" });
      const homeless = await prisma.inventoryItem.create({ data: { userId: bfOwner.id, name: `Homeless ${tag}`, price: 1, quantity: 2, cost: 5 } });
      // The window between the server going live and the backfill: an item
      // the new server already moved (two left at no known cost).
      const moved = await raw("Moved", { quantity: 10, cost: 40 });
      await stock.takeOut(prisma, { businessId: bfBiz.id, itemId: moved.id, quantity: 2, date: new Date(), sourceKey: `sale:bf-${tag}`, kind: "sale" });
      const logs = [];
      const log = (l) => logs.push(l);

      let dry;
      await test("a dry run says what it would write and writes nothing", async () => {
        dry = await backfillR3({ dryRun: true, ownerId: bfOwner.id, log });
        eq(dry.items, 7);
        eq(dry.services, 1);
        eq(dry.openings.written, 4, "costed, fractional, uncosted, moved");
        eq(dry.openings.unknownCost, 1);
        eq(kobo(dry.openings.value), 50000 + 8333 + 40000);
        eq(dry.avgCost, 1, "the empty item keeps its cost");
        eq(dry.left, 1, "the item with no business");
        eq(await prisma.stockMovement.count({ where: { businessId: bfBiz.id, kind: "opening" } }), 0, "nothing written");
        eq((await item(empty.id)).avgCost, null);
        ok(logs.every((l) => !l.includes(tag)), "no names printed");
      });
      await test("a run writes one opening per item, on today's Lagos day, and sets the average", async () => {
        const run = await backfillR3({ ownerId: bfOwner.id, log });
        eq(run.openings.written, 4);
        eq(run.openings.value, dry.openings.value);
        eq(run.failed, 0);
        const open = async (it) => (await prisma.stockMovement.findMany({ where: { sourceKey: `open:${it.id}:1` } }))[0];
        const c = await open(costed);
        eq(c.kind, "opening");
        eq(c.quantity, 10);
        eq(c.value, 500);
        eq(c.date.toISOString(), `${lagosDay(0)}T00:00:00.000Z`);
        await hold(costed.id, 10, 500, "costed");
        eq((await item(costed.id)).avgCost, 50);
        eq((await open(fractional)).value, 83.33, "2.5 at 33.33, to the kobo");
        eq((await item(fractional.id)).avgCost, 33.33);
        eq((await open(uncosted)).value, 0, "unknown cost: nothing");
        eq((await item(uncosted.id)).avgCost, null, "and the average stays unknown");
        eq((await item(empty.id)).avgCost, 20, "nothing in stock: the cost is kept");
        eq(await prisma.stockMovement.count({ where: { itemId: empty.id } }), 0);
        eq(await prisma.stockMovement.count({ where: { itemId: service.id } }), 0, "a service is left alone");
        eq((await item(service.id)).itemType, "service");
        eq(await prisma.stockMovement.count({ where: { itemId: homeless.id } }), 0, "an item with no business is left");
        const mv = await open(moved);
        eq(mv.quantity, 10, "the quantity no movement explained");
        eq(mv.value, 400);
        await hold(moved.id, 8, 400, "moved");
        eq(await prisma.auditLog.count({ where: { action: "BACKFILL_R3_OPENING", resourceId: { in: [costed.id, fractional.id, uncosted.id, moved.id] } } }), 4);
        eq(await prisma.auditLog.count({ where: { action: "BACKFILL_R3_AVG_COST", resourceId: empty.id } }), 1);
        eq((await prisma.business.findUnique({ where: { id: bfBiz.id } })).sells, null, "sells stays null");
      });
      await test("a second run finds nothing to change", async () => {
        const again = await backfillR3({ ownerId: bfOwner.id, log });
        eq(again.openings.written, 0);
        eq(again.avgCost, 0);
        eq(await prisma.stockMovement.count({ where: { businessId: bfBiz.id, kind: "opening" } }), 4);
      });
    }

    // ═════════════════════════════════════════════════════════════════════════
    section("the books and Insights read what was sold and what it cost");
    {
      const insOwner = await mkUser({ email: `stockdocs-ins-${tag}@t.local`, firstName: "Ins", accountType: "OWNER" });
      const insBiz = await mkBiz(insOwner.id, "Insights shop");
      const TI = signToken({ userId: insOwner.id, tokenVersion: 0 });
      const yam = await mkItem(insBiz, "Yam", { qty: 10, cost: 100, lowStockAlert: 2 });
      const soap = await mkItem(insBiz, "Soap", { qty: 1, cost: 50, lowStockAlert: 3 });
      const repair = await mkItem(insBiz, "Repair", { itemType: "service" });
      const gone = await mkItem(insBiz, "Gone", { qty: 1, cost: 5, archived: true });
      // A sale with lines, as the sales route writes one (its goods out).
      const sale = await prisma.sales.create({ data: { userId: insOwner.id, businessId: insBiz.id, amount: 4000, paymentMethod: "cash", date: new Date() } });
      const yamLine = await prisma.saleItem.create({
        data: { saleId: sale.id, businessId: insBiz.id, itemId: yam.id, name: yam.name, itemType: "goods", quantity: 2, rate: 500, amount: 1000, position: 0 },
      });
      const out = await stock.takeOut(prisma, { businessId: insBiz.id, itemId: yam.id, quantity: 2, date: new Date(), sourceKey: `sale:${yamLine.id}`, kind: "sale" });
      await prisma.saleItem.update({ where: { id: yamLine.id }, data: { costAmount: out.costAmount, unitCost: out.unitCost } });
      await prisma.saleItem.create({
        data: { saleId: sale.id, businessId: insBiz.id, itemId: repair.id, name: repair.name, itemType: "service", quantity: 1, rate: 3000, amount: 3000, position: 1 },
      });
      // An issued invoice of yam and a draft of soap (the draft is no sale).
      const inv = await POST("/invoices", TI, { businessId: insBiz.id, issueDate: today, status: "SENT", items: [{ name: yam.name, itemId: yam.id, quantity: 3, rate: 400 }] });
      status(inv, 201, "invoice");
      status(await POST("/invoices", TI, { businessId: insBiz.id, issueDate: today, items: [{ name: soap.name, itemId: soap.id, quantity: 1, rate: 99999 }] }), 201, "draft");
      // What the goods cost: 200 for the cash sale, 300 for the invoice.
      const cost = 200 + 300;
      const fakeBiz = { id: insBiz.id, baseCurrency: "NGN" };

      await test("the books count what the goods sold cost (when sold)", async () => {
        const books = await booksFor(insBiz.id, { basis: "sold" });
        eq(books.expenses.lines.cogs && books.expenses.lines.cogs.gross, cost);
      });
      await test("best sellers come from sale lines and issued invoice lines, by amount and by quantity", async () => {
        const r = await answerQuestion("best seller this month", fakeBiz);
        eq(r.intent, "top_products");
        const top = r.data.top;
        eq(top[0].itemId, repair.id, "the service first by amount");
        eq(top[0].amount, 3000);
        const y = top.find((t) => t.itemId === yam.id);
        eq(y.amount, 2200, "a sale line and an invoice line");
        eq(y.quantity, 5);
        eq(r.data.byQuantity[0].itemId, yam.id, "yam first by quantity");
        ok(!top.some((t) => t.itemId === soap.id), "a draft is no sale");
        ok(r.answer.includes("Most sold by quantity"), r.answer);
      });
      await test("low stock is goods only, never archived, and the stock is valued at cost", async () => {
        const r = await answerQuestion("what is low on stock", fakeBiz);
        eq(r.intent, "stock");
        eq(r.data.low.length, 1, JSON.stringify(r.data.low));
        eq(r.data.low[0].name, soap.name);
        eq(r.data.count, 2, "two goods (the archived one aside)");
        eq(r.data.stockValue, 500 + 50, "yam 5 at 100, soap 1 at 50");
        ok(r.answer.includes("at cost"), r.answer);
      });
      await test("the profit answer gives the gross profit once costs exist (when paid: the cash sale's cost only)", async () => {
        const r = await answerQuestion("profit this month", fakeBiz);
        eq(r.intent, "profit");
        eq(r.data.costOfSales, 200, "the unpaid invoice's cost waits for its money");
        eq(r.data.grossProfit, Math.round((r.data.income - 200) * 100) / 100);
        ok(r.answer.includes("Gross profit"), r.answer);
      });
      await test("the cards' low stock leaves out services and archived goods, and a services-only business", async () => {
        const cards = await generateInsightCards(fakeBiz);
        const lowCard = cards.find((c) => c.icon === "cube");
        ok(lowCard && lowCard.body.includes(soap.name) && !lowCard.body.includes(repair.name) && !lowCard.body.includes(gone.name), JSON.stringify(cards));
        await prisma.business.update({ where: { id: insBiz.id }, data: { sells: "services" } });
        const after = await generateInsightCards(fakeBiz);
        ok(!after.some((c) => c.icon === "cube"), "no low-stock card");
        const r = await answerQuestion("what is low on stock", fakeBiz);
        ok(r.answer.includes("services"), r.answer);
        await prisma.business.update({ where: { id: insBiz.id }, data: { sells: null } });
      });
    }

    // ═════════════════════════════════════════════════════════════════════════
    section("every item holds what its movements add up to");
    await test("quantity and stock value are the sums of the movements, in every business touched", async () => {
      const items = await prisma.inventoryItem.findMany({ where: { name: { endsWith: tag } } });
      ok(items.length > 10, "items found");
      for (const it of items) {
        if (!it.businessId || it.itemType !== "goods") continue;
        const sum = await prisma.stockMovement.aggregate({ where: { itemId: it.id }, _sum: { quantity: true, value: true } });
        eq(milli(sum._sum.quantity || 0), milli(it.quantity), `${it.name} quantity`);
        eq(kobo(sum._sum.value || 0), kobo(it.stockValue), `${it.name} value`);
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
