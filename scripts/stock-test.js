// The stock engine (utils/stock.js, chart of accounts release 3, 2026-10-13)
// on a real local Postgres: goods in and out at the moving average, to the
// kobo, the last unit taking whatever value is left; fractional quantities;
// services and archived items refused; another business's item not found;
// two phones selling the last unit (one wins, with and without the business
// lock); a retried request finding its movement; undoing a record's
// movements, and refusing when its goods have already been sold; revaluing,
// counting and adjusting; the low-stock alert cleared once stock is back;
// the database's own checks and keys; and, after long random sequences, every
// item's quantity and stock value equal to the sums of its movements. A last
// section checks the chart's two release 3 accounts (Service Income, Cost of
// Services): added to a chart that lacks them, and the income account an
// item's line counts as (chart.incomeForItem).
//
// Point it at a LOCAL scratch database (a clone of the migrated template):
//   node scratchpad/with-local-db.js kashbook_coa_e2e_a0r3 node scripts/stock-test.js
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
process.env.NODE_ENV = "test";

const assert = require("assert");
const prisma = require("../src/utils/db");
const stock = require("../src/utils/stock");
const chart = require("../src/utils/chart");
const { ensureChart, accountsFor } = require("../src/utils/ledgerData");

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

// A refusal as the routes would send it: status, code, and extra.
async function refuses(promise, status, code, what = "") {
  let err = null;
  try {
    await promise;
  } catch (e) {
    err = e;
  }
  ok(err, `${what} was not refused`);
  eq(err.code, code, `${what} code (${err.message})`);
  eq(err.status, status, `${what} status`);
  return err;
}

const K = (n) => Math.round(n * 100); // naira to kobo
const M = (n) => Math.round(n * 1000); // units to thousandths
const tag = Date.now().toString(36);

// A small seeded generator, so a failing random run can be repeated.
function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    chance: (p) => next() < p,
    pick: (list) => list[Math.floor(next() * list.length)],
  };
}

(async () => {
  console.log("\nSTOCK ENGINE");
  try {
    const mkUser = (data) => prisma.user.create({
      data: { password: "x", lastName: "T", businessName: "B", country: "NG", currency: "NGN", ...data },
    });
    const owner = await mkUser({ email: `stock-${tag}@t.local`, firstName: "Ada", accountType: "OWNER" });
    const rival = await mkUser({ email: `stock-rival-${tag}@t.local`, firstName: "Rival", accountType: "OWNER" });
    const biz = await prisma.business.create({ data: { userId: owner.id, name: `Stock ${tag}`, country: "NG", baseCurrency: "NGN" } });
    const rivalBiz = await prisma.business.create({ data: { userId: rival.id, name: `Rival ${tag}`, country: "NG", baseCurrency: "NGN" } });

    let n = 0;
    // A service's stock is never counted (items like Zoho, 2026-10-14).
    const mkItem = (data = {}, b = biz, u = owner) => prisma.inventoryItem.create({
      data: { userId: u.id, businessId: b.id, name: `Item ${tag} ${++n}`, price: 1000, ...(data.itemType === "service" ? { trackInventory: false } : {}), ...data },
    });
    // As a route writes: the business lock, then one transaction.
    const inLock = (fn, b = biz) => prisma.withBusinessLock(b.id, () => prisma.$transaction(fn, { timeout: 30000 }));
    let keyN = 0;
    const key = (kind) => `${kind}:${tag}-${++keyN}`;
    const base = (item, extra = {}) => ({ businessId: item.businessId, itemId: item.id, date: new Date(), createdById: owner.id, ...extra });
    const buy = (item, quantity, unitCost, extra = {}) =>
      inLock((px) => stock.putIn(px, base(item, { quantity, unitCost, kind: "purchase", sourceKey: key("bill"), ...extra })));
    const sell = (item, quantity, extra = {}) =>
      inLock((px) => stock.takeOut(px, base(item, { quantity, kind: "sale", sourceKey: key("sale"), ...extra })));
    const fresh = (item) => prisma.inventoryItem.findUnique({ where: { id: item.id } });

    // An item's quantity and value are the sums of its movements, never below
    // 0, and nothing in stock is worth nothing.
    async function invariant(item, what = "") {
      const now = await fresh(item);
      const moves = await prisma.stockMovement.findMany({ where: { itemId: item.id } });
      const q = moves.reduce((s, m) => s + M(m.quantity), 0);
      const v = moves.reduce((s, m) => s + K(m.value), 0);
      eq(q, M(now.quantity), `${what} Σ movement quantities`);
      eq(v, K(now.stockValue), `${what} Σ movement values`);
      ok(now.quantity >= 0 && now.stockValue >= 0, `${what} never below 0`);
      if (q === 0) eq(v, 0, `${what} an empty shelf is worth nothing`);
      // Stored kobo-exact and to the thousandth.
      eq(K(now.stockValue) / 100, now.stockValue, `${what} stockValue is whole kobo`);
      eq(M(now.quantity) / 1000, now.quantity, `${what} quantity is whole thousandths`);
      return now;
    }

    // ════════════════════════════════════════════════════════════════════
    section("The contract");
    await test("exports, kinds and the refusal shape", async () => {
      for (const f of ["stockError", "validQuantity", "lineCost", "takeOut", "putIn", "revalue", "adjust", "count", "removeBySource"]) {
        eq(typeof stock[f], "function", f);
      }
      assert.deepStrictEqual(stock.KINDS, ["opening", "opening_value", "purchase", "sale", "invoice", "credit_note", "adjustment", "revalue"]);
      assert.deepStrictEqual(stock.REASONS, ["damaged", "expired", "lost", "used", "counted", "other"]);
      const e = stock.stockError(409, "NOT_ENOUGH_STOCK", "Only 1 left.", { itemId: "x", available: 1 });
      ok(e instanceof Error);
      eq(e.status, 409);
      eq(e.code, "NOT_ENOUGH_STOCK");
      assert.deepStrictEqual(e.extra, { itemId: "x", available: 1 });
      eq(stock.stockError(400, "X", "m").extra, undefined, "no extra unless given");
    });
    await test("lineCost: quantity times unit cost, to the kobo", async () => {
      eq(stock.lineCost(3, 33.33), 99.99);
      eq(stock.lineCost(0.125, 10.1), 1.26, "126.25 kobo");
      eq(stock.lineCost(0.5, 0.05), 0.03, "2.5 kobo, halves up");
      eq(stock.lineCost(2.675, 1000), 2675);
      eq(stock.lineCost(1.5, 100 / 3), 50, "an average with many decimals");
      eq(stock.lineCost(7, 0), 0);
      eq(stock.lineCost(1000000, 2500.55), 2500550000);
    });
    await test("validQuantity: more than 0, at most three decimals, numbers only", async () => {
      for (const q of [1, 2.5, 0.001, 1.375, 0.1 + 0.2, 1e9]) ok(stock.validQuantity(q), `${q} is fine`);
      for (const q of [0, -1, 0.0005, 1.2345, NaN, Infinity, 1e9 + 1, "2", null, undefined]) ok(!stock.validQuantity(q), `${q} is refused`);
      ok(stock.validQuantity(0, { allowZero: true }), "a count may be 0");
    });

    // ════════════════════════════════════════════════════════════════════
    section("Goods in and out at the moving average");
    await test("a purchase sets the quantity, the value and the average", async () => {
      const item = await mkItem();
      const r = await buy(item, 10, 150);
      eq(r.repeated, false);
      eq(r.value, 1500);
      eq(r.costAmount, 1500);
      eq(r.unitCost, 150);
      eq(r.costKnown, true);
      eq(r.item.quantity, 10);
      eq(r.item.stockValue, 1500);
      eq(r.item.avgCost, 150);
      const m = r.movement;
      eq(m.kind, "purchase");
      eq(m.quantity, 10);
      eq(m.value, 1500);
      eq(m.qtyAfter, 10);
      eq(m.valueAfter, 1500);
      eq(m.reason, null);
      eq(m.businessId, biz.id);
      eq(m.createdById, owner.id);
      ok(m.sourceKey.startsWith("bill:"));
      await invariant(item);
    });
    await test("goods leave at the average of the moment; a later restock moves the average", async () => {
      const item = await mkItem();
      await buy(item, 10, 150);
      const b = await buy(item, 5, null, { value: 1050 });
      eq(b.item.avgCost, 170, "2550 / 15");
      const s = await sell(item, 3);
      eq(s.value, -510);
      eq(s.costAmount, 510);
      eq(s.unitCost, 170);
      eq(s.costKnown, true);
      eq(s.movement.quantity, -3);
      eq(s.movement.value, -510);
      eq(s.movement.qtyAfter, 12);
      eq(s.movement.valueAfter, 2040);
      eq(s.item.avgCost, 170, "the average does not change when goods leave");
      const c = await buy(item, 2, 200);
      eq(c.item.quantity, 14);
      eq(c.item.stockValue, 2440);
      eq(c.item.avgCost, 2440 / 14);
      await invariant(item);
    });
    await test("to the kobo: three units worth 100.00 leave as 33.33, 33.34 and the last 33.33", async () => {
      const item = await mkItem();
      await buy(item, 3, null, { value: 100 });
      const one = await sell(item, 1);
      eq(one.costAmount, 33.33);
      const two = await sell(item, 1);
      eq(two.costAmount, 33.34, "6667 / 2 = 3333.5, halves up");
      const last = await sell(item, 1);
      eq(last.costAmount, 33.33, "the last unit takes what is left");
      eq(last.item.stockValue, 0);
      eq(last.item.quantity, 0);
      eq(last.item.avgCost, 100 / 3, "the average is kept for a return or a count");
      eq(K(one.costAmount) + K(two.costAmount) + K(last.costAmount), 10000, "exactly what the stock cost");
      await invariant(item);
    });
    await test("the last unit empties the value exactly, whatever the average says", async () => {
      const item = await mkItem();
      await buy(item, 7, 10.01);
      await buy(item, 3, 9.99);
      const a = await sell(item, 4);
      const b = await sell(item, 6);
      eq(b.item.stockValue, 0);
      eq(b.item.quantity, 0);
      eq(K(a.costAmount) + K(b.costAmount), K(70.07 + 29.97));
      await invariant(item);
    });
    await test("fractional quantities: kg in and out, exact to the thousandth", async () => {
      const item = await mkItem({ unit: "kg" });
      await buy(item, 1.25, 800);
      const b = await buy(item, 0.125, 10.1);
      eq(b.value, 1.26);
      eq(b.item.quantity, 1.375);
      const s = await sell(item, 0.375);
      eq(s.item.quantity, 1);
      eq(s.costAmount, K(1001.26 * 0.375 / 1.375) / 100);
      const noise = await buy(item, 0.1 + 0.2, 100);
      eq(noise.movement.quantity, 0.3, "float noise is not a fourth decimal");
      eq(noise.item.quantity, 1.3);
      const all = await sell(item, 1.3);
      eq(all.item.quantity, 0);
      eq(all.item.stockValue, 0);
      await invariant(item);
    });
    await test("a quantity with a fourth decimal, 0, negative or not a number is refused", async () => {
      const item = await mkItem();
      await buy(item, 5, 10);
      for (const q of [0.0005, 1.2345, 0, -1, NaN, Infinity, "2", null]) {
        await refuses(sell(item, q), 400, "BAD_QUANTITY", `takeOut ${q}`);
        await refuses(buy(item, q, 10), 400, "BAD_QUANTITY", `putIn ${q}`);
      }
      await invariant(item);
      eq((await fresh(item)).quantity, 5);
    });
    await test("costs and values: refused when negative or not money", async () => {
      const item = await mkItem();
      await refuses(buy(item, 1, -1), 400, "BAD_COST");
      await refuses(buy(item, 1, null, { value: 1.234 }), 400, "BAD_VALUE", "a value is naira and kobo");
      await refuses(buy(item, 1, null, { value: -5 }), 400, "BAD_VALUE");
      await refuses(buy(item, 1, Infinity), 400, "BAD_COST");
      await refuses(inLock((px) => stock.putIn(px, base(item, { quantity: 1, unitCost: 1, kind: "sale", sourceKey: key("x") }))), 400, "BAD_KIND");
      await refuses(inLock((px) => stock.takeOut(px, base(item, { quantity: 1, kind: "purchase", sourceKey: key("x") }))), 400, "BAD_KIND");
      await refuses(inLock((px) => stock.putIn(px, base(item, { quantity: 1, unitCost: 1, kind: "purchase", sourceKey: "" }))), 400, "BAD_SOURCE_KEY");
      await refuses(inLock((px) => stock.putIn(px, base(item, { quantity: 1, unitCost: 1, kind: "purchase", sourceKey: key("bill"), date: "not a day" }))), 400, "BAD_DATE");
      eq(await prisma.stockMovement.count({ where: { itemId: item.id } }), 0, "nothing written");
    });

    // ════════════════════════════════════════════════════════════════════
    section("What is refused");
    await test("more than is in stock: 409 NOT_ENOUGH_STOCK { itemId, available }, nothing written", async () => {
      const item = await mkItem();
      await buy(item, 2.5, 100);
      const before = await prisma.stockMovement.count({ where: { itemId: item.id } });
      const e = await refuses(sell(item, 3), 409, "NOT_ENOUGH_STOCK");
      assert.deepStrictEqual(e.extra, { itemId: item.id, available: 2.5 });
      eq(await prisma.stockMovement.count({ where: { itemId: item.id } }), before);
      eq((await fresh(item)).quantity, 2.5);
      const empty = await mkItem();
      eq((await refuses(sell(empty, 1), 409, "NOT_ENOUGH_STOCK")).extra.available, 0);
    });
    await test("a service has no stock: 400 NOT_STOCKED for every write", async () => {
      const svc = await mkItem({ itemType: "service", unit: "hour" });
      await refuses(sell(svc, 1), 400, "NOT_STOCKED", "takeOut");
      await refuses(buy(svc, 1, 10), 400, "NOT_STOCKED", "putIn");
      await refuses(inLock((px) => stock.revalue(px, base(svc, { newUnitCost: 5 }))), 400, "NOT_STOCKED", "revalue");
      await refuses(inLock((px) => stock.count(px, base(svc, { countedQuantity: 3 }))), 400, "NOT_STOCKED", "count");
      await refuses(inLock((px) => stock.adjust(px, base(svc, { quantity: 2, reason: "other" }))), 400, "NOT_STOCKED", "adjust in");
      await refuses(inLock((px) => stock.adjust(px, base(svc, { quantity: -2, reason: "lost" }))), 400, "NOT_STOCKED", "adjust out");
      eq(await prisma.stockMovement.count({ where: { itemId: svc.id } }), 0);
      const s = await fresh(svc);
      eq(s.quantity, 0);
      eq(s.stockValue, 0);
      eq(s.avgCost, null);
    });
    await test("an archived item takes no new movements (409 ITEM_ARCHIVED); its sales can still be undone", async () => {
      const item = await mkItem();
      await buy(item, 4, 25);
      const s = await sell(item, 1);
      await prisma.inventoryItem.update({ where: { id: item.id }, data: { archivedAt: new Date() } });
      await refuses(sell(item, 1), 409, "ITEM_ARCHIVED", "takeOut");
      await refuses(buy(item, 1, 25), 409, "ITEM_ARCHIVED", "putIn");
      await refuses(inLock((px) => stock.count(px, base(item, { countedQuantity: 3 }))), 409, "ITEM_ARCHIVED", "count");
      await refuses(inLock((px) => stock.revalue(px, base(item, { newUnitCost: 30 }))), 409, "ITEM_ARCHIVED", "revalue");
      const r = await inLock((px) => stock.removeBySource(px, biz.id, [s.movement.sourceKey]));
      eq(r.removed.length, 1);
      eq(r.items[0].quantity, 4);
      eq(r.items[0].stockValue, 100);
      await invariant(item);
    });
    await test("another business's item, or none at all: 404 ITEM_NOT_FOUND", async () => {
      const theirs = await mkItem({}, rivalBiz, rival);
      const theirKey = `bill:${tag}-rival`;
      await inLock((px) => stock.putIn(px, base(theirs, { quantity: 5, unitCost: 10, kind: "purchase", sourceKey: theirKey })), rivalBiz);
      const e = await refuses(inLock((px) => stock.takeOut(px, { ...base(theirs), businessId: biz.id, quantity: 1, kind: "sale", sourceKey: key("sale") })), 404, "ITEM_NOT_FOUND");
      eq(e.extra.itemId, theirs.id);
      await refuses(inLock((px) => stock.putIn(px, { ...base(theirs), businessId: biz.id, quantity: 1, unitCost: 1, kind: "purchase", sourceKey: key("bill") })), 404, "ITEM_NOT_FOUND");
      await refuses(inLock((px) => stock.revalue(px, { ...base(theirs), businessId: biz.id, newUnitCost: 1 })), 404, "ITEM_NOT_FOUND");
      await refuses(inLock((px) => stock.takeOut(px, { businessId: biz.id, itemId: "no-such-item", quantity: 1, kind: "sale", sourceKey: key("sale") })), 404, "ITEM_NOT_FOUND");
      // Their movements are not ours to remove either.
      eq((await inLock((px) => stock.removeBySource(px, biz.id, [theirKey]))).removed.length, 0, "by key");
      eq((await inLock((px) => stock.removeBySource(px, biz.id, theirKey))).removed.length, 0, "by prefix");
      eq((await fresh(theirs)).quantity, 5, "theirs untouched");
    });

    // ════════════════════════════════════════════════════════════════════
    section("Two phones, one last unit");
    await test("eight sales of the last unit at once, under the business lock: exactly one wins", async () => {
      const item = await mkItem();
      await buy(item, 1, 500);
      const results = await Promise.allSettled([1, 2, 3, 4, 5, 6, 7, 8].map(() => sell(item, 1)));
      const won = results.filter((r) => r.status === "fulfilled");
      const lost = results.filter((r) => r.status === "rejected");
      eq(won.length, 1, "one sale");
      ok(lost.every((r) => r.reason.code === "NOT_ENOUGH_STOCK"), `the rest refused: ${lost.map((r) => r.reason.code)}`);
      eq(won[0].value.costAmount, 500);
      const now = await invariant(item);
      eq(now.quantity, 0);
      eq(await prisma.stockMovement.count({ where: { itemId: item.id, kind: "sale" } }), 1);
    });
    await test("without the business lock the item's own row lock still lets exactly three of eight take three units", async () => {
      const item = await mkItem();
      await buy(item, 3, 100);
      const results = await Promise.allSettled([1, 2, 3, 4, 5, 6, 7, 8].map(() =>
        prisma.$transaction((px) => stock.takeOut(px, base(item, { quantity: 1, kind: "sale", sourceKey: key("sale") })), { timeout: 30000 })));
      eq(results.filter((r) => r.status === "fulfilled").length, 3);
      ok(results.filter((r) => r.status === "rejected").every((r) => r.reason.code === "NOT_ENOUGH_STOCK"));
      const now = await invariant(item);
      eq(now.quantity, 0);
      eq(now.stockValue, 0);
    });
    await test("the root client opens a transaction of its own", async () => {
      const item = await mkItem();
      const r = await stock.putIn(prisma, base(item, { quantity: 2, unitCost: 7.5, kind: "purchase", sourceKey: key("bill") }));
      eq(r.item.stockValue, 15);
      const s = await stock.takeOut(prisma, base(item, { quantity: 2, kind: "sale", sourceKey: key("sale") }));
      eq(s.costAmount, 15);
      await invariant(item);
    });
    await test("the caller's transaction failing later undoes the movement", async () => {
      const item = await mkItem();
      await buy(item, 5, 20);
      await assert.rejects(inLock(async (px) => {
        await stock.takeOut(px, base(item, { quantity: 2, kind: "sale", sourceKey: key("sale") }));
        throw new Error("the sale could not be saved");
      }), /could not be saved/);
      const now = await invariant(item);
      eq(now.quantity, 5);
      eq(now.stockValue, 100);
    });

    // ════════════════════════════════════════════════════════════════════
    section("A retried request");
    await test("the same sourceKey twice: the movement comes back, nothing moves twice", async () => {
      const item = await mkItem();
      const bk = key("bill");
      const first = await buy(item, 6, 50, { sourceKey: bk });
      const again = await buy(item, 6, 50, { sourceKey: bk });
      eq(again.repeated, true);
      eq(again.movement.id, first.movement.id);
      eq(again.value, 300);
      eq(again.item.quantity, 6);
      const sk = key("sale");
      const s1 = await sell(item, 2, { sourceKey: sk });
      const s2 = await sell(item, 2, { sourceKey: sk });
      eq(s2.repeated, true);
      eq(s2.movement.id, s1.movement.id);
      eq(s2.costAmount, s1.costAmount);
      eq(s2.unitCost, 50);
      eq(s2.costKnown, true);
      eq((await fresh(item)).quantity, 4);
      // Even once the stock is gone, the retry finds its movement instead of
      // being refused.
      const last = key("sale");
      await sell(item, 4, { sourceKey: last });
      eq((await sell(item, 4, { sourceKey: last })).repeated, true);
      await invariant(item);
    });
    await test("a key already used for another item is refused (409 SOURCE_KEY_TAKEN)", async () => {
      const a = await mkItem();
      const b = await mkItem();
      const k = key("bill");
      await buy(a, 1, 10, { sourceKey: k });
      await refuses(buy(b, 1, 10, { sourceKey: k }), 409, "SOURCE_KEY_TAKEN");
      await invariant(b);
    });

    // ════════════════════════════════════════════════════════════════════
    section("Undoing a record");
    await test("removing a sale puts its goods and value back and recomputes the average", async () => {
      const item = await mkItem();
      await buy(item, 10, 100);
      const s = await sell(item, 4);
      const lowAt = new Date();
      await prisma.inventoryItem.update({ where: { id: item.id }, data: { lowStockAlert: 6, lowStockNotifiedAt: lowAt } });
      const r = await inLock((px) => stock.removeBySource(px, biz.id, [s.movement.sourceKey]));
      eq(r.removed.length, 1);
      eq(r.removed[0].id, s.movement.id);
      eq(r.items.length, 1);
      eq(r.items[0].quantity, 10);
      eq(r.items[0].stockValue, 1000);
      eq(r.items[0].avgCost, 100);
      eq(r.items[0].lowStockNotifiedAt, null, "back above the low-stock level");
      eq(await prisma.stockMovement.count({ where: { id: s.movement.id } }), 0);
      const again = await inLock((px) => stock.removeBySource(px, biz.id, [s.movement.sourceKey]));
      eq(again.removed.length, 0, "a retried delete does nothing");
      eq(again.items.length, 0);
      await invariant(item);
    });
    await test("a restock whose goods were sold can't be removed (409 STOCK_ALREADY_SOLD), and nothing changes", async () => {
      const item = await mkItem();
      const b = await buy(item, 10, 100);
      await sell(item, 6);
      const e = await refuses(inLock((px) => stock.removeBySource(px, biz.id, [b.movement.sourceKey])), 409, "STOCK_ALREADY_SOLD");
      eq(e.extra.itemId, item.id);
      eq(await prisma.stockMovement.count({ where: { id: b.movement.id } }), 1, "still there");
      const now = await invariant(item);
      eq(now.quantity, 4);
    });
    await test("at the average, a restock's goods leave with the others: removing either restock is refused once a sale counted them", async () => {
      const item = await mkItem();
      const dear = await buy(item, 10, 200);
      const cheap = await buy(item, 10, 100);
      const s = await sell(item, 10);
      eq(s.costAmount, 1500, "half the stock at the average");
      await refuses(inLock((px) => stock.removeBySource(px, biz.id, [cheap.movement.sourceKey])), 409, "STOCK_ALREADY_SOLD", "500 left with nothing to hold it");
      await refuses(inLock((px) => stock.removeBySource(px, biz.id, [dear.movement.sourceKey])), 409, "STOCK_ALREADY_SOLD", "500 below nothing");
      // Undo the sale first, and the restock goes.
      await inLock((px) => stock.removeBySource(px, biz.id, [s.movement.sourceKey]));
      const r = await inLock((px) => stock.removeBySource(px, biz.id, [cheap.movement.sourceKey]));
      eq(r.items[0].quantity, 10);
      eq(r.items[0].stockValue, 2000);
      eq(r.items[0].avgCost, 200);
      await invariant(item);
    });
    await test("several lines at once, two of them on one item, and a prefix", async () => {
      const a = await mkItem();
      const b = await mkItem();
      await buy(a, 10, 10);
      await buy(b, 10, 20);
      const doc = `sale:${tag}-doc-`;
      await sell(a, 2, { sourceKey: `${doc}1` });
      await sell(a, 3, { sourceKey: `${doc}2` });
      await sell(b, 4, { sourceKey: `${doc}3` });
      const r = await inLock((px) => stock.removeBySource(px, biz.id, doc));
      eq(r.removed.length, 3);
      eq(r.items.length, 2);
      eq((await fresh(a)).quantity, 10);
      eq((await fresh(b)).quantity, 10);
      await invariant(a);
      await invariant(b);
      await refuses(inLock((px) => stock.removeBySource(px, biz.id, "sale:")), 400, "BAD_SOURCE_KEY", "a bare kind would take every sale");
      await refuses(inLock((px) => stock.removeBySource(px, biz.id, 42)), 400, "BAD_SOURCE_KEY");
      eq((await inLock((px) => stock.removeBySource(px, biz.id, []))).removed.length, 0);
    });

    // ════════════════════════════════════════════════════════════════════
    section("Unknown cost, revaluing, counting, adjusting");
    await test("goods with no cost come in at no value and leave at no cost, costKnown false", async () => {
      const item = await mkItem();
      const o = await inLock((px) => stock.putIn(px, base(item, { quantity: 5, kind: "opening", sourceKey: `open:${item.id}:1` })));
      eq(o.value, 0);
      eq(o.costKnown, false);
      eq(o.unitCost, null);
      eq(o.item.avgCost, null, "still unknown");
      const s = await sell(item, 2);
      eq(s.costAmount, 0);
      eq(s.value, 0);
      eq(s.costKnown, false);
      eq(s.unitCost, null);
      // Setting the stock value: opening_value when no cost was ever known.
      const v = await inLock((px) => stock.revalue(px, base(item, { newUnitCost: 40 })));
      eq(v.movement.kind, "opening_value");
      eq(v.movement.quantity, 0);
      eq(v.value, 120);
      eq(v.item.avgCost, 40);
      eq(v.item.stockValue, 120);
      ok(v.movement.sourceKey.startsWith("adj:"));
      const s2 = await sell(item, 1);
      eq(s2.costKnown, true);
      eq(s2.costAmount, 40);
      await invariant(item);
    });
    await test("revalue: the stock on hand at a new cost; nothing in stock changes only the average", async () => {
      const item = await mkItem();
      await buy(item, 4, 100);
      const r = await inLock((px) => stock.revalue(px, base(item, { newUnitCost: 125 })));
      eq(r.movement.kind, "revalue");
      eq(r.value, 100);
      eq(r.movement.valueAfter, 500);
      eq(r.item.avgCost, 125);
      const down = await inLock((px) => stock.revalue(px, base(item, { newUnitCost: 90, kind: "revalue" })));
      eq(down.value, -140);
      eq(down.item.stockValue, 360);
      const same = await inLock((px) => stock.revalue(px, base(item, { newUnitCost: 90 })));
      eq(same.movement, null, "no difference, no movement");
      await sell(item, 4);
      const before = await prisma.stockMovement.count({ where: { itemId: item.id } });
      const empty = await inLock((px) => stock.revalue(px, base(item, { newUnitCost: 70 })));
      eq(empty.movement, null);
      eq(empty.item.avgCost, 70);
      eq(empty.item.stockValue, 0);
      eq(await prisma.stockMovement.count({ where: { itemId: item.id } }), before);
      await refuses(inLock((px) => stock.revalue(px, base(item, { newUnitCost: -1 }))), 400, "BAD_COST");
      await refuses(inLock((px) => stock.revalue(px, base(item, { newUnitCost: 1, kind: "sale" }))), 400, "BAD_KIND");
      await invariant(item);
    });
    await test("count: more comes in at the average, less goes out, the same writes nothing, 0 empties", async () => {
      const item = await mkItem();
      await buy(item, 10, 30);
      const up = await inLock((px) => stock.count(px, base(item, { countedQuantity: 12 })));
      eq(up.movement.kind, "adjustment");
      eq(up.movement.reason, "counted");
      eq(up.movement.quantity, 2);
      eq(up.value, 60);
      eq(up.item.quantity, 12);
      const down = await inLock((px) => stock.count(px, base(item, { countedQuantity: 9.5 })));
      eq(down.movement.quantity, -2.5);
      eq(down.value, -75);
      const same = await inLock((px) => stock.count(px, base(item, { countedQuantity: 9.5 })));
      eq(same.movement, null);
      const zero = await inLock((px) => stock.count(px, base(item, { countedQuantity: 0 })));
      eq(zero.item.quantity, 0);
      eq(zero.item.stockValue, 0);
      await refuses(inLock((px) => stock.count(px, base(item, { countedQuantity: -1 }))), 400, "BAD_QUANTITY");
      // A count with a key of its own is idempotent too.
      const k = key("adj");
      const c1 = await inLock((px) => stock.count(px, base(item, { countedQuantity: 3, sourceKey: k })));
      const c2 = await inLock((px) => stock.count(px, base(item, { countedQuantity: 3, sourceKey: k })));
      eq(c2.repeated, true);
      eq(c2.movement.id, c1.movement.id);
      eq(c1.costKnown, true, "in at the average kept from before");
      eq(c1.value, 90);
      await invariant(item);
    });
    await test("adjust: a reason is required; found goods come in at the average, lost goods go out", async () => {
      const item = await mkItem();
      await buy(item, 8, 12.5);
      await refuses(inLock((px) => stock.adjust(px, base(item, { quantity: -1 }))), 400, "BAD_REASON");
      await refuses(inLock((px) => stock.adjust(px, base(item, { quantity: -1, reason: "stolen" }))), 400, "BAD_REASON");
      await refuses(inLock((px) => stock.adjust(px, base(item, { quantity: 0, reason: "lost" }))), 400, "BAD_QUANTITY");
      await refuses(inLock((px) => stock.takeOut(px, base(item, { quantity: 1, kind: "adjustment", sourceKey: key("adj") }))), 400, "BAD_REASON", "takeOut too");
      const lost = await inLock((px) => stock.adjust(px, base(item, { quantity: -3, reason: "damaged", note: "  rain  " })));
      eq(lost.movement.reason, "damaged");
      eq(lost.movement.note, "rain");
      eq(lost.value, -37.5);
      const found = await inLock((px) => stock.adjust(px, base(item, { quantity: 1.5, reason: "other" })));
      eq(found.value, 18.75);
      eq(found.movement.quantity, 1.5);
      await refuses(inLock((px) => stock.adjust(px, base(item, { quantity: -10, reason: "lost" }))), 409, "NOT_ENOUGH_STOCK");
      await invariant(item);
    });
    await test("a credit note's goods come back at the item's average", async () => {
      const item = await mkItem();
      await buy(item, 5, 60);
      await sell(item, 5);
      const back = await inLock(async (px) => {
        const it = await px.inventoryItem.findUnique({ where: { id: item.id } });
        return stock.putIn(px, base(item, { quantity: 2, unitCost: it.avgCost, kind: "credit_note", sourceKey: key("inv") }));
      });
      eq(back.value, 120);
      eq(back.costAmount, 120);
      eq(back.item.quantity, 2);
      eq(back.item.avgCost, 60);
      await invariant(item);
    });
    await test("the low-stock alert: kept while stock is low, cleared once it is above the level", async () => {
      const item = await mkItem({ lowStockAlert: 5 });
      await buy(item, 6, 10);
      const at = new Date();
      await prisma.inventoryItem.update({ where: { id: item.id }, data: { lowStockNotifiedAt: at } });
      const s = await sell(item, 3);
      eq(+s.item.lowStockNotifiedAt, +at, "selling clears nothing");
      const b = await buy(item, 2, 10);
      eq(+b.item.lowStockNotifiedAt, +at, "5 is not above 5");
      const c = await buy(item, 0.5, 10);
      eq(c.item.lowStockNotifiedAt, null, "5.5 is");
    });

    // ════════════════════════════════════════════════════════════════════
    section("The database's own checks and keys");
    await test("CHECKs refuse what the engine never writes", async () => {
      const item = await mkItem();
      const bad = (data) => prisma.stockMovement.create({ data: { businessId: biz.id, itemId: item.id, sourceKey: key("x"), ...data } });
      await assert.rejects(bad({ kind: "sale", quantity: 1, value: 0 }), "a sale adds nothing");
      await assert.rejects(bad({ kind: "purchase", quantity: -1, value: -5 }), "a purchase takes nothing");
      await assert.rejects(bad({ kind: "purchase", quantity: 1, value: -5 }), "a purchase has a value of 0 or more");
      await assert.rejects(bad({ kind: "revalue", quantity: 1, value: 5 }), "a revalue moves no quantity");
      await assert.rejects(bad({ kind: "adjustment", quantity: -1, value: -5 }), "an adjustment has a reason");
      await assert.rejects(bad({ kind: "adjustment", reason: "lost", quantity: -1, value: 5 }), "its value goes with its quantity");
      await assert.rejects(bad({ kind: "purchase", reason: "lost", quantity: 1, value: 5 }), "only an adjustment has a reason");
      await assert.rejects(bad({ kind: "gift", quantity: 1, value: 5 }), "an unknown kind");
      await assert.rejects(bad({ kind: "purchase", quantity: NaN, value: 5 }), "NaN");
      await assert.rejects(bad({ kind: "purchase", quantity: 1, value: Infinity }), "infinity");
      const k = key("bill");
      await bad({ kind: "purchase", quantity: 1, value: 5, sourceKey: k, qtyAfter: 1, valueAfter: 5 });
      await assert.rejects(bad({ kind: "purchase", quantity: 1, value: 5, sourceKey: k }), "one movement per key and business");
      await prisma.stockMovement.deleteMany({ where: { sourceKey: k } });
      await assert.rejects(prisma.inventoryItem.update({ where: { id: item.id }, data: { quantity: -1 } }), "quantity below 0");
      await assert.rejects(prisma.inventoryItem.update({ where: { id: item.id }, data: { stockValue: -0.01 } }), "value below 0");
      await assert.rejects(prisma.inventoryItem.update({ where: { id: item.id }, data: { avgCost: -1 } }), "average below 0");
      await assert.rejects(prisma.inventoryItem.update({ where: { id: item.id }, data: { itemType: "thing" } }), "goods or service");
      await assert.rejects(prisma.business.update({ where: { id: biz.id }, data: { sells: "food" } }), "goods, services or both");
      await prisma.business.update({ where: { id: biz.id }, data: { sells: "both" } });
      await prisma.business.update({ where: { id: biz.id }, data: { sells: null } });
      const sale = await prisma.sales.create({ data: { userId: owner.id, businessId: biz.id, amount: 10 } });
      const line = (data) => prisma.saleItem.create({ data: { saleId: sale.id, businessId: biz.id, name: "x", quantity: 1, ...data } });
      await assert.rejects(line({ quantity: 0 }), "a line sells something");
      await assert.rejects(line({ itemType: "thing" }), "goods, service or other");
      await assert.rejects(line({ costAmount: -1 }), "cost 0 or more");
      await assert.rejects(line({ unitCost: -1 }), "unit cost 0 or more");
      const l = await line({ itemId: item.id, itemType: "goods", rate: 10, amount: 10, quantity: 2.5 });
      eq(l.quantity, 2.5);
      eq(l.unitCost, null);
      eq(l.costAmount, 0);
      eq(l.position, 0);
      // The sale's lines go with it.
      await prisma.sales.delete({ where: { id: sale.id } });
      eq(await prisma.saleItem.count({ where: { id: l.id } }), 0);
    });
    await test("an item a restock names can't be deleted; an owner with restocks still can be, items, bills and all", async () => {
      const u = await mkUser({ email: `stock-gone-${tag}@t.local`, firstName: "Gone", accountType: "OWNER" });
      const b = await prisma.business.create({ data: { userId: u.id, name: `Gone ${tag}`, country: "NG", baseCurrency: "NGN" } });
      const item = await mkItem({}, b, u);
      const bill = await prisma.businessDebt.create({
        data: { userId: u.id, businessId: b.id, name: "Supplier", originalAmount: 50, remainingAmount: 50 },
      });
      const bl = await prisma.billItem.create({ data: { billId: bill.id, itemId: item.id, quantity: 5, unitCost: 10, amount: 50 } });
      await inLock((px) => stock.putIn(px, { businessId: b.id, itemId: item.id, quantity: 5, value: 50, kind: "purchase", sourceKey: `bill:${bl.id}` }), b);
      await assert.rejects(prisma.inventoryItem.delete({ where: { id: item.id } }), "the bill line holds it");
      ok(await fresh(item), "still there");
      await assert.rejects(prisma.billItem.create({ data: { billId: bill.id, itemId: item.id, quantity: 0, unitCost: 1, amount: 0 } }), "a line restocks something");
      // The business goes (its movements with it), then the owner: their
      // items and bills, and the bills' lines, in one statement.
      await prisma.business.delete({ where: { id: b.id } });
      eq(await prisma.stockMovement.count({ where: { businessId: b.id } }), 0);
      await prisma.user.delete({ where: { id: u.id } });
      eq(await prisma.inventoryItem.count({ where: { id: item.id } }), 0);
      eq(await prisma.billItem.count({ where: { id: bl.id } }), 0);
    });

    // ════════════════════════════════════════════════════════════════════
    section("Random sequences");
    await test("after every step, each item's quantity and value equal the sums of its movements", async () => {
      const g = rng(20261013);
      const items = [];
      for (let i = 0; i < 4; i++) items.push(await mkItem({ unit: i % 2 ? "kg" : "piece", lowStockAlert: g.int(0, 5) }));
      const keys = new Map(items.map((it) => [it.id, []])); // sourceKeys still present, per item
      const qty = () => (g.chance(0.4) ? g.int(1, 3000) / 1000 : g.int(1, 20));
      const cost = () => (g.chance(0.1) ? 0 : g.int(1, 500000) / 100);
      let steps = 0;
      let refusedSold = 0;
      let refusedShort = 0;
      for (let step = 0; step < 360; step++) {
        const item = g.pick(items);
        const before = await fresh(item);
        const haveM = M(before.quantity);
        const haveK = K(before.stockValue);
        const op = g.pick(["buy", "buy", "sell", "sell", "sell", "revalue", "count", "adjust", "remove", "remove", "retry", "unknown"]);
        try {
          if (op === "buy" || op === "unknown") {
            const k = key("bill");
            const withValue = g.chance(0.3);
            const q = qty();
            const args = op === "unknown" ? {} : withValue ? { value: stock.lineCost(q, cost()) } : { unitCost: cost() };
            const r = await inLock((px) => stock.putIn(px, base(item, { quantity: q, kind: op === "unknown" ? "opening" : "purchase", sourceKey: k, ...args })));
            eq(K(r.movement.value), op === "unknown" ? 0 : withValue ? K(args.value) : K(stock.lineCost(q, args.unitCost)), "the value put in");
            keys.get(item.id).push(k);
          } else if (op === "sell") {
            const q = g.chance(0.15) ? (haveM + g.int(1, 2000)) / 1000 : Math.max(0.001, g.int(1, Math.max(1, haveM)) / 1000);
            const k = key("sale");
            const r = await inLock((px) => stock.takeOut(px, base(item, { quantity: q, kind: g.pick(["sale", "invoice"]), sourceKey: k })));
            const qM = M(q);
            const want = qM === haveM ? haveK : Math.round((qM * haveK) / haveM);
            eq(K(r.costAmount), want, "the share of the value taken");
            keys.get(item.id).push(k);
          } else if (op === "revalue") {
            const r = await inLock((px) => stock.revalue(px, base(item, { newUnitCost: cost() })));
            if (r.movement) keys.get(item.id).push(r.movement.sourceKey);
          } else if (op === "count") {
            const r = await inLock((px) => stock.count(px, base(item, { countedQuantity: g.int(0, Math.max(1, haveM * 2)) / 1000 })));
            if (r.movement) keys.get(item.id).push(r.movement.sourceKey);
          } else if (op === "adjust") {
            const r = await inLock((px) => stock.adjust(px, base(item, { quantity: (g.chance(0.5) ? 1 : -1) * qty(), reason: g.pick(stock.REASONS) })));
            keys.get(item.id).push(r.movement.sourceKey);
          } else if (op === "remove") {
            const list = keys.get(item.id);
            if (!list.length) continue;
            const pickN = Math.min(list.length, g.chance(0.3) ? 2 : 1);
            const chosen = [];
            for (let i = 0; i < pickN; i++) chosen.push(g.pick(list));
            const r = await inLock((px) => stock.removeBySource(px, biz.id, [...new Set(chosen)]));
            ok(r.removed.length >= 1, "removed");
            for (const k of new Set(chosen)) list.splice(list.indexOf(k), 1);
          } else if (op === "retry") {
            const list = keys.get(item.id);
            if (!list.length) continue;
            const k = g.pick(list);
            const m = await prisma.stockMovement.findUnique({ where: { businessId_sourceKey: { businessId: biz.id, sourceKey: k } } });
            const r = m.quantity > 0
              ? await inLock((px) => stock.putIn(px, base(item, { quantity: m.quantity, value: m.value, kind: m.kind === "adjustment" ? "adjustment" : "purchase", reason: m.reason || undefined, sourceKey: k })))
              : m.quantity < 0
                ? await inLock((px) => stock.takeOut(px, base(item, { quantity: -m.quantity, kind: m.kind === "adjustment" ? "adjustment" : "sale", reason: m.reason || undefined, sourceKey: k })))
                : await inLock((px) => stock.revalue(px, base(item, { newUnitCost: 1, sourceKey: k })));
            eq(r.repeated, true);
            eq(r.movement.id, m.id);
            const after = await fresh(item);
            eq(M(after.quantity), haveM, "a retry moves nothing");
            eq(K(after.stockValue), haveK, "a retry moves nothing");
          }
        } catch (e) {
          if (e.code === "STOCK_ALREADY_SOLD") refusedSold++;
          else if (e.code === "NOT_ENOUGH_STOCK") refusedShort++;
          else throw e;
          const after = await fresh(item);
          eq(M(after.quantity), haveM, `${op} refused, nothing moved`);
          eq(K(after.stockValue), haveK, `${op} refused, nothing moved`);
        }
        steps++;
        const now = await invariant(item, `step ${step} (${op})`);
        // The movement written last says what the item held right after.
        const last = await prisma.stockMovement.findFirst({ where: { itemId: item.id }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
        if (last && ["buy", "sell", "unknown", "adjust"].includes(op)) {
          eq(last.qtyAfter, now.quantity, `step ${step} qtyAfter`);
          eq(last.valueAfter, now.stockValue, `step ${step} valueAfter`);
        }
      }
      ok(steps > 300, `${steps} steps`);
      ok(refusedShort > 0, "some sales were refused for want of stock");
      ok(refusedSold > 0, "some removals were refused as already sold");
      for (const it of items) await invariant(it, "at the end");
      console.log(`        (${steps} steps; ${refusedShort} refused for want of stock, ${refusedSold} as already sold)`);
    });

    // ════════════════════════════════════════════════════════════════════
    section("The chart's release 3 accounts");
    await test("Service Income and Cost of Services: system accounts, pickable, in the default chart", async () => {
      eq(chart.SYS.SERVICE_INCOME, "service_income");
      eq(chart.SYS.COST_OF_SERVICES, "cost_of_services");
      const si = chart.DEFAULT_CHART.find((a) => a.sys === chart.SYS.SERVICE_INCOME);
      const cs = chart.DEFAULT_CHART.find((a) => a.sys === chart.SYS.COST_OF_SERVICES);
      assert.deepStrictEqual(si, { seed: "service_income", sys: "service_income", type: "income", name: "Service Income" });
      assert.deepStrictEqual(cs, { seed: "cost_of_services", sys: "cost_of_services", type: "cost_of_goods_sold", name: "Cost of Services" });
      for (const k of [si.sys, cs.sys]) {
        ok(!chart.CONTROLLED.includes(k), `${k} not controlled`);
        ok(!chart.HIDDEN_AT_ZERO.includes(k), `${k} not hidden`);
      }
      ok(chart.pickerAllows("income", { type: "income", systemKey: si.sys }), "Service Income is offered for a sale");
      ok(chart.pickerAllows("expense", { type: "cost_of_goods_sold", systemKey: cs.sys }), "Cost of Services is offered for spending");
      ok(chart.pickerAllows("bill", { type: "cost_of_goods_sold", systemKey: cs.sys }), "and for a bill");
    });
    await test("a chart from before release 3 gets both accounts, once, when it is read or set up", async () => {
      const b = await prisma.business.create({ data: { userId: owner.id, name: `Old chart ${tag}`, country: "NG", baseCurrency: "NGN" } });
      await ensureChart(b.id);
      const full = await prisma.ledgerAccount.count({ where: { businessId: b.id } });
      eq(full, chart.DEFAULT_CHART.length);
      // As a release 2 chart was: without the two.
      await prisma.ledgerAccount.deleteMany({ where: { businessId: b.id, systemKey: { in: ["service_income", "cost_of_services"] } } });
      const read = await accountsFor(b.id);
      eq(read.length, full, "the read added them back");
      const si = read.find((a) => a.systemKey === "service_income");
      eq(si.type, "income");
      eq(si.seed, "service_income");
      eq(si.name, "Service Income");
      eq(read.find((a) => a.systemKey === "cost_of_services").type, "cost_of_goods_sold");
      await Promise.all([1, 2, 3].map(() => accountsFor(b.id)));
      eq(await prisma.ledgerAccount.count({ where: { businessId: b.id } }), full, "and only once");
      // ensureChart does it too, keeping a renamed account and a name taken.
      await prisma.ledgerAccount.deleteMany({ where: { businessId: b.id, systemKey: "service_income" } });
      await prisma.ledgerAccount.create({ data: { businessId: b.id, type: "income", name: "Service Income", nameKey: "service income" } });
      eq(await ensureChart(b.id), 1);
      const again = await prisma.ledgerAccount.findFirst({ where: { businessId: b.id, systemKey: "service_income" } });
      eq(again.name, "Service Income 2", "a free name");
      eq(await ensureChart(b.id), 0, "nothing more");
    });
    await test("incomeForItem: the item's own account while usable, else Service Income for a service, else Sales", async () => {
      const b = await prisma.business.create({ data: { userId: owner.id, name: `Income ${tag}`, country: "NG", baseCurrency: "NGN" } });
      const C = chart.indexChart(await accountsFor(b.id));
      const sys = (k) => chart.sysAccount(C, k);
      const general = C.accounts.find((a) => a.seed === "general_income");
      eq(chart.incomeForItem(C, null).id, sys("sales").id, "a typed line");
      eq(chart.incomeForItem(C, { itemType: "goods" }).id, sys("sales").id);
      eq(chart.incomeForItem(C, { itemType: "service" }).id, sys("service_income").id);
      eq(chart.incomeForItem(C, { itemType: "service", incomeAccountId: general.id }).id, general.id);
      eq(chart.incomeForItem(C, { itemType: "goods", incomeAccountId: general.id }).id, general.id);
      eq(chart.incomeForItem(C, { itemType: "goods", incomeAccountId: sys("discount").id }).id, sys("sales").id, "Discount is no income for a sale");
      eq(chart.incomeForItem(C, { itemType: "service", incomeAccountId: sys("cogs").id }).id, sys("service_income").id, "an expense is no income");
      eq(chart.incomeForItem(C, { itemType: "service", incomeAccountId: "gone" }).id, sys("service_income").id, "not in the chart");
      const resting = { ...general, inactiveAt: new Date() };
      const C2 = chart.indexChart(C.accounts.map((a) => (a.id === general.id ? resting : a)));
      eq(chart.incomeForItem(C2, { itemType: "goods", incomeAccountId: general.id }).id, sys("sales").id, "an inactive account");
      const noService = chart.indexChart(C.accounts.filter((a) => a.systemKey !== "service_income"));
      eq(chart.incomeForItem(noService, { itemType: "service" }).id, sys("sales").id, "a chart without Service Income");
    });
  } finally {
    await prisma.$disconnect();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failures.length) console.log(`failed:\n  - ${failures.join("\n  - ")}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
