// The stock engine (chart of accounts release 3, 2026-10-13). The only code
// that changes a goods item's quantity, stockValue and avgCost: each change is
// one StockMovement, and an item's quantity and stockValue are always the sums
// of its movements (Inventory Asset in the ledger is the sum of every
// movement's value).
//
// Moving average by entry order. A goods item holds its quantity and what that
// stock cost (stockValue, naira); goods leave at the average at the moment
// they are recorded (stockValue times the share of the quantity taken, to the
// kobo; the last unit takes whatever value is left), so stockValue never goes
// below 0 and an empty shelf is worth nothing. A back-dated restock does not
// re-cost sales already recorded. avgCost is the last known average cost of
// one unit: kept when the quantity reaches 0 (a return or a count can use it),
// null when no cost was ever known (such goods leave at no cost, costKnown
// false, and nothing is guessed).
//
// Every write runs inside the caller's transaction (px, from
// prisma.$transaction), itself inside withBusinessLock(businessId), as the
// routes write everything else; the item's row is also locked (SELECT ... FOR
// UPDATE) for the rest of the transaction, so two phones selling the last unit
// never both get it even without the business lock. Given the root client
// instead, a function opens its own transaction. The routes check the books
// lock date for the record's day before they call (an adjustment's route for
// its own day); nothing here reads it.
//
// Idempotent by sourceKey, unique per business ("sale:<saleItemId>",
// "inv:<invoiceItemId>", "bill:<billItemId>", "adj:<uuid>",
// "open:<itemId>:<n>"): a retried request finds the movement it already wrote
// and gets it back, unchanged, with repeated: true.
//
// Money is kept in whole kobo and quantities in thousandths internally (at
// most three decimals: 2.5 kg, 0.75 litre), so sums are exact; both are stored
// as naira and units. A refusal is an Error with status, code and extra (the
// routes spread extra into the response), like the other route errors.
const { randomUUID } = require("crypto");
const { toKobo, twoDecimals } = require("./money");

const KINDS = ["opening", "opening_value", "purchase", "sale", "invoice", "credit_note", "adjustment", "revalue"];
const REASONS = ["damaged", "expired", "lost", "used", "counted", "other"];
// The kinds each function writes.
const IN_KINDS = ["opening", "purchase", "credit_note", "adjustment"];
const OUT_KINDS = ["sale", "invoice", "adjustment"];
const VALUE_KINDS = ["revalue", "opening_value"];

// Limits that keep the arithmetic exact: a billion units (a trillion
// thousandths) and ten trillion naira of stock.
const MAX_QUANTITY = 1e9;
const MAX_KOBO = 1e15;
const MILLI = 1000;

// ── Refusals ─────────────────────────────────────────────────────────────────

function stockError(status, code, message, extra) {
  const err = Object.assign(new Error(message), { status, code });
  if (extra) err.extra = extra;
  return err;
}

const notFound = (itemId) => stockError(404, "ITEM_NOT_FOUND", "That item isn't in this business.", { itemId });

// ── Numbers ──────────────────────────────────────────────────────────────────

// A stored quantity (units) in thousandths, and back.
const toMilli = (q) => Math.round((Number(q) || 0) * MILLI);
const units = (m) => m / MILLI;
const naira = (k) => k / 100 || 0; // never -0

// Whether q is a quantity the engine takes: a number, at most three decimals
// (float noise from 0.1 + 0.2 aside), more than 0 (or 0 itself when allowZero)
// and at most a billion.
function validQuantity(q, { allowZero = false } = {}) {
  if (typeof q !== "number" || !Number.isFinite(q)) return false;
  if (q < 0 || (q === 0 && !allowZero) || q > MAX_QUANTITY) return false;
  const m = q * MILLI;
  return Math.abs(m - Math.round(m)) <= 1e-12 * Math.max(1, Math.abs(m));
}

function readQuantity(q, opts) {
  if (!validQuantity(q, opts)) {
    throw stockError(400, "BAD_QUANTITY", "Enter a quantity more than 0, with at most three decimals.", { field: "quantity" });
  }
  return Math.round(q * MILLI);
}

// a / b to the nearest whole number, halves up (a >= 0, b > 0, BigInt).
function roundDiv(a, b) {
  return (a * 2n + b) / (2n * b);
}

// The value of `m` thousandths of a unit at `unitCost` naira each, in kobo.
// Exact when the cost is whole kobo (as an owner types it); a cost with more
// decimals (an average) is multiplied out and rounded, float noise aside.
function costKobo(m, unitCost) {
  if (twoDecimals(unitCost)) return Number(roundDiv(BigInt(m) * BigInt(toKobo(unitCost)), BigInt(MILLI)));
  return Math.round(Number(((m * unitCost) / 10).toPrecision(15)));
}

// What `quantity` units at `unitCost` each come to, in naira to the kobo. The
// one rule for a bill line's amount and for every value the engine puts in at
// a unit cost, so a route and the engine never differ by a kobo.
function lineCost(quantity, unitCost) {
  return naira(costKobo(Math.round(Number(quantity) * MILLI), Number(unitCost)));
}

function readUnitCost(c, field = "unitCost") {
  if (typeof c !== "number" || !Number.isFinite(c) || c < 0 || c * 100 > MAX_KOBO) {
    throw stockError(400, "BAD_COST", "Enter a cost of 0 or more.", { field });
  }
  return c;
}

function readValueKobo(v) {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || !twoDecimals(v) || v * 100 > MAX_KOBO) {
    throw stockError(400, "BAD_VALUE", "A stock value is naira and kobo, 0 or more.", { field: "value" });
  }
  return toKobo(v);
}

function readDate(d) {
  if (d === undefined || d === null || d === "") return new Date();
  const when = d instanceof Date ? new Date(d.getTime()) : new Date(d);
  if (Number.isNaN(when.getTime())) throw stockError(400, "BAD_DATE", "That date can't be read.", { field: "date" });
  return when;
}

function readKind(kind, allowed) {
  if (!allowed.includes(kind)) throw stockError(400, "BAD_KIND", `A movement of kind "${kind}" can't be written here.`);
  return kind;
}

// Only an adjustment has a reason, and it always has one.
function readReason(kind, reason) {
  if (kind !== "adjustment") return null;
  if (!REASONS.includes(reason)) throw stockError(400, "BAD_REASON", "Say why the stock changed.", { field: "reason" });
  return reason;
}

function readKey(key, fallback) {
  if ((key === undefined || key === null) && fallback) return fallback;
  if (typeof key !== "string" || !key.trim() || key.length > 200) {
    throw stockError(400, "BAD_SOURCE_KEY", "A stock movement needs the record line it belongs to.");
  }
  return key;
}

const readNote = (n) => (typeof n === "string" && n.trim() ? n.trim().slice(0, 500) : null);

// ── Rows ─────────────────────────────────────────────────────────────────────

// Inside the caller's transaction; the root client gets one of its own (a
// transaction client has no $transaction).
function inTx(px, fn) {
  return typeof px.$transaction === "function" ? px.$transaction(fn, { timeout: 20000 }) : fn(px);
}

// The item, its row locked to the end of the transaction. Another business's
// item is not found.
async function lockedItem(px, businessId, itemId) {
  if (typeof itemId !== "string" || !itemId || typeof businessId !== "string" || !businessId) throw notFound(itemId);
  await px.$queryRaw`SELECT "id" FROM "InventoryItem" WHERE "id" = ${itemId} FOR UPDATE`;
  const item = await px.inventoryItem.findUnique({ where: { id: itemId } });
  if (!item || item.businessId !== businessId) throw notFound(itemId);
  return item;
}

// A service has no stock, and an archived item takes no new movements (its
// history and value stay; removing a record's movements still works).
function assertStocked(item) {
  if (item.itemType !== "goods") {
    throw stockError(400, "NOT_STOCKED", "A service has no stock to count.", { itemId: item.id });
  }
  if (item.archivedAt) {
    throw stockError(409, "ITEM_ARCHIVED", "That item is archived. Bring it back before using it.", { itemId: item.id });
  }
}

// The movement a retried request already wrote, or null. A key belongs to one
// record line, so it names one item.
async function existingMove(px, businessId, sourceKey, itemId) {
  const m = await px.stockMovement.findUnique({ where: { businessId_sourceKey: { businessId, sourceKey } } });
  if (m && m.itemId !== itemId) {
    throw stockError(409, "SOURCE_KEY_TAKEN", "That record line already moved another item's stock.", { itemId });
  }
  return m;
}

// The average cost of one unit, in naira, for kobo and thousandths.
const average = (k, m) => (k * 10) / m;

// The item's new quantity and value, with the alert cleared when the quantity
// is above the low-stock level again.
function itemData(item, qtyM, valueK, avgCost) {
  const data = { quantity: units(qtyM), stockValue: naira(valueK) };
  if (avgCost !== undefined) data.avgCost = avgCost;
  if (item.lowStockNotifiedAt && qtyM > toMilli(item.lowStockAlert)) data.lowStockNotifiedAt = null;
  return data;
}

function writeMove(px, { businessId, item, kind, reason, date, qtyM, valueK, afterM, afterK, sourceKey, note, createdById }) {
  return px.stockMovement.create({
    data: {
      businessId,
      itemId: item.id,
      kind,
      reason,
      date,
      quantity: units(qtyM) || 0,
      value: naira(valueK),
      qtyAfter: units(afterM),
      valueAfter: naira(afterK),
      sourceKey,
      note,
      createdById: createdById ? String(createdById) : null,
    },
  });
}

// What a line records about the goods behind a movement: their value (signed,
// as the movement), what they cost (positive), and the cost of one unit (null
// when no cost was ever known).
function costOf(movement, costKnown) {
  const valueK = toKobo(movement.value);
  const qtyM = Math.abs(toMilli(movement.quantity));
  return {
    value: naira(valueK),
    costAmount: naira(Math.abs(valueK)),
    unitCost: costKnown && qtyM ? average(Math.abs(valueK), qtyM) : null,
    costKnown,
  };
}

// ── Goods out ────────────────────────────────────────────────────────────────

// takeOut(px, { businessId, itemId, quantity, date, sourceKey, kind, reason?,
// note?, createdById }) → { movement, value, costAmount, unitCost, costKnown,
// item, repeated }. kind: sale | invoice | adjustment (reason required).
// value is the movement's, negative: the goods' share of the stock value, to
// the kobo, or all of it for the last of the stock. costAmount is the same,
// positive (a line's costAmount); unitCost null unless the cost is known.
// Refuses a service (400 NOT_STOCKED), an archived item (409 ITEM_ARCHIVED),
// another business's item (404 ITEM_NOT_FOUND) and more than is in stock
// (409 NOT_ENOUGH_STOCK { itemId, available }). avgCost does not change.
async function takeOut(px, args) {
  const { businessId, itemId, quantity, date, sourceKey, kind, reason, note, createdById } = args || {};
  readKind(kind, OUT_KINDS);
  const qtyM = readQuantity(quantity);
  const why = readReason(kind, reason);
  const when = readDate(date);
  const key = readKey(sourceKey);
  return inTx(px, async (tx) => {
    const item = await lockedItem(tx, businessId, itemId);
    const again = await existingMove(tx, businessId, key, item.id);
    if (again) return { movement: again, ...costOf(again, again.value !== 0 || item.avgCost != null), item, repeated: true };
    assertStocked(item);

    const haveM = toMilli(item.quantity);
    const haveK = toKobo(item.stockValue);
    if (qtyM > haveM) {
      throw stockError(409, "NOT_ENOUGH_STOCK", `Only ${units(haveM)} left in stock.`, { itemId: item.id, available: units(haveM) });
    }
    const outK = qtyM === haveM ? haveK : Math.min(haveK, Number(roundDiv(BigInt(qtyM) * BigInt(haveK), BigInt(haveM))));
    const afterM = haveM - qtyM;
    const afterK = haveK - outK;
    const updated = await tx.inventoryItem.update({ where: { id: item.id }, data: itemData(item, afterM, afterK) });
    const movement = await writeMove(tx, {
      businessId, item, kind, reason: why, date: when, qtyM: -qtyM, valueK: -outK, afterM, afterK,
      sourceKey: key, note: readNote(note), createdById,
    });
    return { movement, ...costOf(movement, item.avgCost != null), item: updated, repeated: false };
  });
}

// ── Goods in ─────────────────────────────────────────────────────────────────

// putIn(px, { businessId, itemId, quantity, unitCost | value, date, sourceKey,
// kind, reason?, note?, createdById }) → { movement, value, costAmount,
// unitCost, costKnown, item, repeated }. kind: opening | purchase |
// credit_note | adjustment (reason required). value (naira, kobo-exact) is
// what the goods cost in all (a bill line's amount); else unitCost (naira) for
// one, valued with lineCost. With neither the cost is unknown: the goods come
// in at no value and an unknown average stays unknown. avgCost becomes
// stockValue / quantity. Refuses a service, an archived item and another
// business's item as takeOut does.
async function putIn(px, args) {
  const { businessId, itemId, quantity, unitCost, value, date, sourceKey, kind, reason, note, createdById } = args || {};
  readKind(kind, IN_KINDS);
  const qtyM = readQuantity(quantity);
  const why = readReason(kind, reason);
  const when = readDate(date);
  const key = readKey(sourceKey);
  let inK = 0;
  let known = false;
  if (value !== undefined && value !== null) {
    inK = readValueKobo(value);
    known = true;
  } else if (unitCost !== undefined && unitCost !== null) {
    inK = costKobo(qtyM, readUnitCost(unitCost));
    known = true;
  }
  return inTx(px, async (tx) => {
    const item = await lockedItem(tx, businessId, itemId);
    const again = await existingMove(tx, businessId, key, item.id);
    if (again) return { movement: again, ...costOf(again, again.value !== 0 || item.avgCost != null), item, repeated: true };
    assertStocked(item);

    const afterM = toMilli(item.quantity) + qtyM;
    const afterK = toKobo(item.stockValue) + inK;
    if (afterM > MAX_QUANTITY * MILLI) throw stockError(400, "BAD_QUANTITY", "That is more stock than one item can hold.", { field: "quantity" });
    if (afterK > MAX_KOBO) throw stockError(400, "BAD_VALUE", "That is more stock value than one item can hold.", { field: "value" });
    const avgCost = !known && item.avgCost == null && afterK === 0 ? null : average(afterK, afterM);
    const updated = await tx.inventoryItem.update({ where: { id: item.id }, data: itemData(item, afterM, afterK, avgCost) });
    const movement = await writeMove(tx, {
      businessId, item, kind, reason: why, date: when, qtyM, valueK: inK, afterM, afterK,
      sourceKey: key, note: readNote(note), createdById,
    });
    return { movement, ...costOf(movement, known), item: updated, repeated: false };
  });
}

// ── Value only ───────────────────────────────────────────────────────────────

// revalue(px, { businessId, itemId, newUnitCost, kind?, date, sourceKey?,
// note?, createdById }) → { movement | null, value, item, repeated }. The
// stock on hand is valued again at newUnitCost a unit (lineCost of the
// quantity); the movement carries the difference (kind revalue, or
// opening_value for stock that never had a value; with no kind given,
// opening_value when no cost was ever known, else revalue). avgCost becomes
// newUnitCost. With nothing in stock, or no difference, only avgCost changes
// and no movement is written. sourceKey defaults to "adj:<uuid>".
async function revalue(px, args) {
  const { businessId, itemId, newUnitCost, kind, date, sourceKey, note, createdById } = args || {};
  if (kind !== undefined && kind !== null) readKind(kind, VALUE_KINDS);
  const cost = readUnitCost(newUnitCost, "newUnitCost");
  const when = readDate(date);
  const key = readKey(sourceKey, `adj:${randomUUID()}`);
  return inTx(px, async (tx) => {
    const item = await lockedItem(tx, businessId, itemId);
    const again = await existingMove(tx, businessId, key, item.id);
    if (again) return { movement: again, value: again.value, item, repeated: true };
    assertStocked(item);

    const haveM = toMilli(item.quantity);
    const haveK = toKobo(item.stockValue);
    const afterK = haveM ? costKobo(haveM, cost) : haveK;
    if (afterK > MAX_KOBO) throw stockError(400, "BAD_VALUE", "That is more stock value than one item can hold.", { field: "newUnitCost" });
    const diffK = afterK - haveK;
    const updated = await tx.inventoryItem.update({ where: { id: item.id }, data: itemData(item, haveM, afterK, cost) });
    if (!diffK) return { movement: null, value: 0, item: updated, repeated: false };
    const movement = await writeMove(tx, {
      businessId, item, kind: kind || (item.avgCost == null ? "opening_value" : "revalue"), reason: null, date: when,
      qtyM: 0, valueK: diffK, afterM: haveM, afterK, sourceKey: key, note: readNote(note), createdById,
    });
    return { movement, value: movement.value, item: updated, repeated: false };
  });
}

// ── Adjustments and counts ───────────────────────────────────────────────────

// adjust(px, { businessId, itemId, quantity (signed), reason, date,
// sourceKey?, note?, createdById }) → as putIn or takeOut. Goods found come in
// at avgCost (at no value when no cost was ever known); goods damaged,
// expired, lost or used go out as takeOut takes them. sourceKey defaults to
// "adj:<uuid>".
async function adjust(px, args) {
  const { quantity, reason, sourceKey } = args || {};
  if (typeof quantity !== "number" || !quantity) readQuantity(quantity);
  readQuantity(Math.abs(quantity));
  readReason("adjustment", reason);
  const key = readKey(sourceKey, `adj:${randomUUID()}`);
  const base = { ...args, kind: "adjustment", sourceKey: key, quantity: Math.abs(quantity) };
  return inTx(px, async (tx) => {
    if (quantity < 0) return takeOut(tx, base);
    const item = await lockedItem(tx, args.businessId, args.itemId);
    return putIn(tx, { ...base, unitCost: item.avgCost, value: undefined });
  });
}

// count(px, { businessId, itemId, countedQuantity, date, sourceKey?, note?,
// createdById }) → { movement | null, ... }: the stock was counted, and the
// difference from the quantity on record is an adjustment (reason counted),
// in at avgCost or out as takeOut takes it. No difference, no movement.
async function count(px, args) {
  const { businessId, itemId, countedQuantity, sourceKey } = args || {};
  const countedM = readQuantity(countedQuantity, { allowZero: true });
  const key = readKey(sourceKey, `adj:${randomUUID()}`);
  return inTx(px, async (tx) => {
    const item = await lockedItem(tx, businessId, itemId);
    const again = await existingMove(tx, businessId, key, item.id);
    if (again) return { movement: again, ...costOf(again, again.value !== 0 || item.avgCost != null), item, repeated: true };
    assertStocked(item);
    const diffM = countedM - toMilli(item.quantity);
    if (!diffM) return { movement: null, value: 0, costAmount: 0, unitCost: null, costKnown: item.avgCost != null, item, repeated: false };
    const base = { ...args, kind: "adjustment", reason: "counted", sourceKey: key, quantity: units(Math.abs(diffM)) };
    if (diffM < 0) return takeOut(tx, base);
    return putIn(tx, { ...base, unitCost: item.avgCost, value: undefined });
  });
}

// ── Undoing a record ─────────────────────────────────────────────────────────

// removeBySource(px, businessId, keys) → { removed: [movements], items:
// [updated items] }. keys: a list of sourceKeys, or one prefix string with
// something after the kind ("bill:<billItemId>", "open:<itemId>:"; a bare
// "sale:" is refused). Deletes those movements and takes them back off their
// items, as if they never happened: quantity and stockValue less each
// movement's, avgCost recomputed while anything is left. Refuses with 409
// STOCK_ALREADY_SOLD { itemId } when that would leave an item with less than
// nothing, or with value and nothing to hold it: goods it brought in have
// already left (sold at an average that counted them). Nothing found,
// nothing done (a retried delete). Archived items are undone all the same.
async function removeBySource(px, businessId, keys) {
  let where;
  if (Array.isArray(keys)) {
    const list = [...new Set(keys)];
    if (!list.length) return { removed: [], items: [] };
    for (const k of list) readKey(k);
    where = { businessId, sourceKey: { in: list } };
  } else if (typeof keys === "string" && /^[a-z_]+:\S+/.test(keys)) {
    where = { businessId, sourceKey: { startsWith: keys } };
  } else {
    throw stockError(400, "BAD_SOURCE_KEY", "Say which record's stock movements to remove.");
  }
  if (typeof businessId !== "string" || !businessId) return { removed: [], items: [] };
  return inTx(px, async (tx) => {
    // Lock the items first (in one order, so two removals never wait on each
    // other), then read the movements again under the locks.
    let moves = await tx.stockMovement.findMany({ where, select: { itemId: true } });
    if (!moves.length) return { removed: [], items: [] };
    const locked = new Set();
    for (let pass = 0; pass < 3; pass++) {
      const ids = [...new Set(moves.map((m) => m.itemId))].filter((id) => !locked.has(id)).sort();
      if (!ids.length) break;
      await tx.$queryRaw`SELECT "id" FROM "InventoryItem" WHERE "id" = ANY(${ids}::text[]) ORDER BY "id" FOR UPDATE`;
      ids.forEach((id) => locked.add(id));
      moves = await tx.stockMovement.findMany({ where, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
    }
    if (!moves.length) return { removed: [], items: [] };
    const items = await tx.inventoryItem.findMany({ where: { id: { in: [...new Set(moves.map((m) => m.itemId))] } } });

    const plans = [];
    for (const item of items) {
      const mine = moves.filter((m) => m.itemId === item.id);
      const afterM = toMilli(item.quantity) - mine.reduce((s, m) => s + toMilli(m.quantity), 0);
      const afterK = toKobo(item.stockValue) - mine.reduce((s, m) => s + toKobo(m.value), 0);
      if (afterM < 0 || afterK < 0 || (afterM === 0 && afterK !== 0)) {
        throw stockError(409, "STOCK_ALREADY_SOLD", "Some of these goods have already been sold, so this can't be undone.", { itemId: item.id });
      }
      plans.push({ item, afterM, afterK });
    }
    await tx.stockMovement.deleteMany({ where: { id: { in: moves.map((m) => m.id) } } });
    const updated = [];
    for (const { item, afterM, afterK } of plans) {
      const avgCost = afterM > 0 ? average(afterK, afterM) : undefined;
      updated.push(await tx.inventoryItem.update({ where: { id: item.id }, data: itemData(item, afterM, afterK, avgCost) }));
    }
    return { removed: moves, items: updated };
  });
}

module.exports = {
  KINDS,
  REASONS,
  MAX_QUANTITY,
  stockError,
  validQuantity,
  lineCost,
  takeOut,
  putIn,
  revalue,
  adjust,
  count,
  removeBySource,
};
