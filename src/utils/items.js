// What an item is and how one is made (items like Zoho, 2026-10-14). The one
// set of rules for the fields of an item, used by routes/inventory.js (one
// item) and routes/itemGroups.js (an item with variants), so both doors read,
// check and write an item the same way.
//
// An item is goods or a service. Goods may have their stock counted
// (trackInventory, the default) or not: goods whose stock is not counted are
// sold and invoiced without taking stock, hold no stock, no stock value and no
// cost of one unit, and are bought as ordinary spending. A service's stock is
// never counted. Only counted goods are returnable (they may come back into
// stock on a credit note); new goods are not unless the owner says so.
//
// Purchase information (purchasePrice, purchaseDescription, purchaseAccountId,
// preferredSupplier) is a cost: the owner sets it, the owner and members with
// canViewReports see it, anyone else gets null (publicItem). A member who
// sees it may send back what they see; any other value is 403 OWNER_ONLY.
//
// More information (brand, manufacturer, weight, dimensions, UPC, EAN, ISBN,
// MPN) is optional, shown to everyone, and checked lightly: 400 BAD_DETAIL or
// BAD_CODE with the field.
//
// A refusal is an Error with status, code and extra (the field it is about
// and anything else for the app), as routes/inventory.js sends them.
const stock = require("./stock");
const { twoDecimals, toKobo } = require("./money");
const { assertAccountUsable } = require("./ledgerData");
const { assertUnlockedIn } = require("./booksLock");
const { URL } = require("url");

const ITEM_TYPES = ["goods", "service"];
// The units a service is sold in. Goods keep the app's own list (piece, kg,
// litre, pack and the rest), checked only for length.
const SERVICE_UNITS = ["hour", "session", "job", "day", "visit", "piece"];
const WEIGHT_UNITS = ["kg", "g", "lb", "oz"];
const DIMENSION_UNITS = ["cm", "m", "in"];
// What buying goods that are not counted, or a service's direct costs, may
// count as: Cost of Goods Sold and its kind, or spending.
const PURCHASE_ACCOUNT_TYPES = ["cost_of_goods_sold", "expense", "other_expense"];
// The cost fields only the owner and members with the reports see.
const PURCHASE_FIELDS = ["purchasePrice", "purchaseDescription", "purchaseAccountId", "preferredSupplier"];
// What every variant of a group shares (kept on the group, copied to each
// variant, changed only through the group), and what each has of its own.
const SHARED_FIELDS = [
  "itemType", "unit", "trackInventory", "returnable", "description", "purchaseDescription",
  "incomeAccountId", "purchaseAccountId", "preferredSupplier", "brand", "manufacturer",
];
const OWN_FIELDS = [
  "name", "price", "purchasePrice", "lowStockAlert", "barcode", "image",
  "weight", "weightUnit", "length", "width", "height", "dimensionUnit", "upc", "ean", "isbn", "mpn",
];

// ── Refusals ─────────────────────────────────────────────────────────────────

function itemError(status, code, message, extra) {
  const err = Object.assign(new Error(message), { status, code });
  if (extra) err.extra = extra;
  return err;
}

const ownerOnly = (message) => itemError(403, "OWNER_ONLY", message);

// ── Who sees what ────────────────────────────────────────────────────────────

// Whether the caller sees what stock cost and the purchase information: the
// owner, and members the owner gave the reports (canViewReports). Owners hold
// every permission (middleware/auth.js).
function canSeeCosts(req) {
  return req?.user?.permissions?.canViewReports === true;
}

// An item as the app receives it. The old cost column (unused since release
// 3: stockValue and avgCost hold the cost) never leaves the server, and the
// costs (what the stock cost, the purchase information) are null for a
// member without the reports.
function publicItem(item, canSee) {
  if (!item) return item;
  const { cost: _unused, ...rest } = item;
  if (canSee) return rest;
  return {
    ...rest,
    stockValue: null,
    avgCost: null,
    purchasePrice: null,
    purchaseDescription: null,
    purchaseAccountId: null,
    preferredSupplier: null,
  };
}

// A group as the app receives it, its purchase information as for an item.
// variantCount: how many of its variants are not archived, when given.
function publicGroup(group, canSee, variantCount) {
  if (!group) return group;
  const out = canSee ? { ...group } : { ...group, purchaseDescription: null, purchaseAccountId: null, preferredSupplier: null };
  if (variantCount !== undefined) out.variantCount = variantCount;
  return out;
}

// How many variants each group has that are not archived, by group id.
async function variantCounts(db, groupIds) {
  const ids = [...new Set((groupIds || []).filter(Boolean))];
  if (!ids.length) return new Map();
  const rows = await db.inventoryItem.groupBy({
    by: ["groupId"],
    where: { groupId: { in: ids }, archivedAt: null },
    _count: { _all: true },
  });
  return new Map(rows.map((r) => [r.groupId, r._count._all]));
}

// ── Reading what a request sends ────────────────────────────────────────────

const blank = (v) => v === undefined || v === null || v === "";

// A number sent as a number or as text ("2.5"); NaN otherwise.
function num(v) {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim()) return Number(v);
  return NaN;
}

function readName(v) {
  if (typeof v !== "string" || !v.trim()) throw itemError(400, "BAD_NAME", "Give the item a name.", { field: "name" });
  const name = v.trim();
  if (name.length > 120) throw itemError(400, "BAD_NAME", "A name can be at most 120 characters.", { field: "name", max: 120 });
  return name;
}

// Text of at most `max` characters, trimmed; null when blank.
function readText(v, field, max, code) {
  if (blank(v)) return null;
  if (typeof v !== "string") throw itemError(400, code, `${field} must be text.`, { field });
  const s = v.trim();
  if (s.length > max) throw itemError(400, code, `${field} can be at most ${max} characters.`, { field, max });
  return s || null;
}

function readUnit(v) {
  if (blank(v)) return "piece";
  if (typeof v !== "string") throw itemError(400, "BAD_UNIT", "A unit is a word, like piece or kg.", { field: "unit" });
  const unit = v.trim();
  if (unit.length > 30) throw itemError(400, "BAD_UNIT", "A unit can be at most 30 characters.", { field: "unit", max: 30 });
  return unit || "piece";
}

function readPrice(v) {
  const p = num(v);
  if (!Number.isFinite(p) || p < 0 || p > 1e13 || !twoDecimals(p)) {
    throw itemError(400, "BAD_PRICE", "Enter a price of 0 or more, in naira and kobo.", { field: "price" });
  }
  return toKobo(p) / 100;
}

// A cost of one unit, in naira and kobo; null when none was sent.
function readCost(v, field) {
  if (blank(v)) return null;
  const c = num(v);
  if (!Number.isFinite(c) || c < 0 || c > 1e13 || !twoDecimals(c)) {
    throw itemError(400, "BAD_COST", "Enter a cost of 0 or more, in naira and kobo.", { field });
  }
  return toKobo(c) / 100;
}

function readLowStock(v) {
  const n = num(v);
  if (!Number.isInteger(n) || n < 0 || n > 1e9) {
    throw itemError(400, "BAD_LOW_STOCK", "Enter a reorder point as a whole number, 0 or more.", { field: "lowStockAlert" });
  }
  return n;
}

function readQuantity(v) {
  const q = num(v);
  if (!stock.validQuantity(q, { allowZero: true })) {
    throw itemError(400, "BAD_QUANTITY", "Enter a quantity of 0 or more, with at most three decimals.", { field: "quantity" });
  }
  return q;
}

// true or false; blank is not sent.
function readFlag(v, field) {
  if (typeof v !== "boolean") throw itemError(400, "BAD_DETAIL", `${field} is on or off.`, { field });
  return v;
}

// A weight or a length: more than 0; null when blank.
function readMeasure(v, field) {
  if (blank(v)) return null;
  const n = num(v);
  if (!Number.isFinite(n) || n <= 0 || n > 1e9) throw itemError(400, "BAD_DETAIL", "Enter a number more than 0.", { field });
  return n;
}

function readChoice(v, field, list) {
  if (blank(v)) return null;
  if (!list.includes(v)) throw itemError(400, "BAD_DETAIL", `Choose one of ${list.join(", ")}.`, { field, choices: list });
  return v;
}

// A product code, without the spaces and dashes people type in it. UPC: 12
// digits. EAN: 8 or 13. ISBN: 10 (the last may be X) or 13. MPN: the maker's
// own, at most 40 characters.
function readCode(v, field) {
  if (blank(v)) return null;
  if (typeof v !== "string" && typeof v !== "number") throw itemError(400, "BAD_CODE", "A code is text.", { field });
  if (field === "mpn") {
    const s = String(v).trim();
    if (s.length > 40) throw itemError(400, "BAD_CODE", "An MPN can be at most 40 characters.", { field, max: 40 });
    return s || null;
  }
  const s = String(v).replace(/[\s-]/g, "").toUpperCase();
  const ok = field === "upc" ? /^\d{12}$/.test(s)
    : field === "ean" ? /^(\d{8}|\d{13})$/.test(s)
      : /^(\d{9}[\dX]|\d{13})$/.test(s);
  if (!ok) {
    const says = { upc: "A UPC has 12 digits.", ean: "An EAN has 8 or 13 digits.", isbn: "An ISBN has 10 or 13 digits." };
    throw itemError(400, "BAD_CODE", says[field], { field });
  }
  return s;
}

function readAccountId(v, field) {
  if (blank(v)) return null;
  if (typeof v !== "string") throw itemError(400, "BAD_ID", "Name the account by its id.", { field });
  return v;
}

// A photo is the https address it was uploaded to, at most 2048 characters
// (400 BAD_IMAGE otherwise); blank clears it.
const MAX_IMAGE = 2048;
function readImage(v) {
  if (blank(v)) return null;
  const bad = () => itemError(400, "BAD_IMAGE", "A photo is an https address of at most 2048 characters.", { field: "image" });
  if (typeof v !== "string" || v.length > MAX_IMAGE || /\s/.test(v)) throw bad();
  let address;
  try {
    address = new URL(v);
  } catch {
    throw bad();
  }
  if (address.protocol !== "https:" || !address.hostname) throw bad();
  return v;
}

// The item fields a request sends, checked: only the keys it sends (an edit
// leaves the rest as they are), from `only` when given. The aliases older
// app builds send (unitPrice, lowStockThreshold, imageUrl) are read too.
// Opening stock (quantity, costPrice) is readOpening's. keepImage: the photo
// the item or group has now; sent back as it is, it changes nothing and is
// not checked again (a photo saved before photos were checked stays).
function readItemFields(body, { only, keepImage } = {}) {
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const out = {};
  const want = (k) => !only || only.includes(k);
  const sent = (k) => b[k] !== undefined;
  const either = (k, alias) => (sent(k) ? b[k] : b[alias]);
  const sentEither = (k, alias) => sent(k) || sent(alias);

  if (want("name") && sent("name")) out.name = readName(b.name);
  if (want("itemType") && !blank(b.itemType)) {
    if (!ITEM_TYPES.includes(b.itemType)) throw itemError(400, "BAD_ITEM_TYPE", "An item is goods or a service.", { field: "itemType" });
    out.itemType = b.itemType;
  }
  if (want("unit") && sent("unit")) out.unit = readUnit(b.unit);
  if (want("price") && sentEither("price", "unitPrice")) out.price = readPrice(either("price", "unitPrice"));
  if (want("lowStockAlert") && sentEither("lowStockAlert", "lowStockThreshold")) {
    out.lowStockAlert = readLowStock(either("lowStockAlert", "lowStockThreshold"));
  }
  if (want("image") && sentEither("image", "imageUrl")) {
    const image = either("image", "imageUrl");
    if (keepImage === undefined || image !== keepImage) out.image = readImage(image);
  }
  if (want("incomeAccountId") && sent("incomeAccountId")) out.incomeAccountId = readAccountId(b.incomeAccountId, "incomeAccountId");
  if (want("purchaseAccountId") && sent("purchaseAccountId")) out.purchaseAccountId = readAccountId(b.purchaseAccountId, "purchaseAccountId");
  for (const [k, max, code] of [
    ["description", 500, "BAD_DESCRIPTION"],
    ["purchaseDescription", 500, "BAD_DESCRIPTION"],
    ["preferredSupplier", 120, "BAD_DETAIL"],
    ["brand", 80, "BAD_DETAIL"],
    ["manufacturer", 80, "BAD_DETAIL"],
    ["category", 100, "BAD_ITEM"],
    ["sku", 100, "BAD_ITEM"],
    ["barcode", 100, "BAD_ITEM"],
  ]) {
    if (want(k) && sent(k)) out[k] = readText(b[k], k, max, code);
  }
  for (const k of ["trackInventory", "returnable"]) {
    if (want(k) && !blank(b[k])) out[k] = readFlag(b[k], k);
  }
  if (want("purchasePrice") && sent("purchasePrice")) out.purchasePrice = readCost(b.purchasePrice, "purchasePrice");
  for (const k of ["weight", "length", "width", "height"]) {
    if (want(k) && sent(k)) out[k] = readMeasure(b[k], k);
  }
  if (want("weightUnit") && sent("weightUnit")) out.weightUnit = readChoice(b.weightUnit, "weightUnit", WEIGHT_UNITS);
  if (want("dimensionUnit") && sent("dimensionUnit")) out.dimensionUnit = readChoice(b.dimensionUnit, "dimensionUnit", DIMENSION_UNITS);
  for (const k of ["upc", "ean", "isbn", "mpn"]) {
    if (want(k) && sent(k)) out[k] = readCode(b[k], k);
  }
  return out;
}

// The rules between the fields, for the item as it will be (cur: as it is
// now, or null for a new one). A service's stock is never counted; goods are
// counted unless the request says not (a service becoming goods is counted
// unless it says not); only counted goods are returnable; counted goods'
// purchase account is Cost of Goods Sold, where the engine posts their cost,
// so none is kept; a weight or a size with no unit is in kg or cm. Returns
// the fields sent with whatever these rules change.
function settleFields(sent, cur = null) {
  const f = { ...sent };
  const v = (k) => (f[k] !== undefined ? f[k] : cur ? cur[k] : undefined);
  const itemType = v("itemType") || "goods";
  let track;
  if (itemType === "service") track = false;
  else if (f.trackInventory !== undefined) track = f.trackInventory;
  else if (!cur || cur.itemType !== "goods") track = true;
  else track = cur.trackInventory !== false;
  const derived = {
    trackInventory: track,
    returnable: itemType === "goods" && track ? v("returnable") === true : false,
  };
  if (itemType === "goods" && track) derived.purchaseAccountId = null;
  if (v("weight") != null && !v("weightUnit")) derived.weightUnit = "kg";
  if (["length", "width", "height"].some((k) => v(k) != null) && !v("dimensionUnit")) derived.dimensionUnit = "cm";
  for (const [k, val] of Object.entries(derived)) {
    if (!cur || f[k] !== undefined || cur[k] !== val) f[k] = val;
  }
  return f;
}

// A new item's fields with the defaults filled in: goods, by the piece, price
// 0, reorder point 5, then settleFields.
function newItemFields(sent) {
  return settleFields({ itemType: "goods", unit: "piece", price: 0, lowStockAlert: 5, ...sent }, null);
}

// A service is sold by the hour, session, job, day, visit or piece.
function assertUnitFits(itemType, unit) {
  if (itemType === "service" && !SERVICE_UNITS.includes(unit)) {
    throw itemError(400, "BAD_UNIT", `A service is sold by the ${SERVICE_UNITS.join(", ")}.`, { field: "unit", units: SERVICE_UNITS });
  }
}

const sameValue = (k, a, b) => (k === "purchasePrice"
  ? (a == null && b == null) || (a != null && b != null && toKobo(a) === toKobo(b))
  : (a ?? null) === (b ?? null));

// A member's purchase information. The owner's to set: a member who sees it
// (canViewReports) may send back what they see, which changes nothing; any
// other value is 403 OWNER_ONLY. A member who does not see it gets 403 for
// any value at all, so the answer never tells them whether a guess was the
// hidden one, and a blank one changes nothing. Returns the fields without
// what changes nothing.
function memberPurchase(fields, cur, { isStaff, canSee }) {
  if (!isStaff) return fields;
  const out = { ...fields };
  for (const k of PURCHASE_FIELDS) {
    if (out[k] === undefined) continue;
    if (!canSee && out[k] === null) {
      delete out[k];
      continue;
    }
    if (canSee && sameValue(k, out[k], cur ? cur[k] : null)) {
      delete out[k];
      continue;
    }
    throw ownerOnly("Only the business owner can change the purchase information.");
  }
  return out;
}

// A variant's shared fields are its group's: one sent with another value is
// 400 GROUP_FIELD, naming it (the app changes it on the group). The same
// value sent back changes nothing.
function assertOwnFields(sent, cur) {
  for (const k of SHARED_FIELDS) {
    if (sent[k] === undefined || sameValue(k, sent[k], cur[k])) continue;
    throw itemError(400, "GROUP_FIELD", "Every variant shares this. Change it on the item group.", { field: k, groupId: cur.groupId });
  }
}

// The opening stock a new item comes with: { quantity, costPrice }. Counted
// goods take both, the owner's (403 OWNER_ONLY for a member); goods that are
// not counted take neither (400 NOT_STOCKED); a service ignores them.
function readOpening(body, fields, { isStaff }) {
  const b = body || {};
  if (fields.itemType !== "goods") return { quantity: 0, costPrice: null };
  const quantity = blank(b.quantity) ? 0 : readQuantity(b.quantity);
  const costPrice = readCost(b.costPrice, "costPrice");
  if (!fields.trackInventory) {
    if (quantity > 0 || costPrice !== null) {
      throw itemError(400, "NOT_STOCKED", "This item's stock isn't counted.", { field: quantity > 0 ? "quantity" : "costPrice" });
    }
    return { quantity: 0, costPrice: null };
  }
  if (isStaff && (quantity > 0 || costPrice !== null)) throw ownerOnly("Only the business owner can set stock or a cost price.");
  return { quantity, costPrice };
}

// The accounts the fields name, checked in this business's chart (inside the
// caller's transaction, under the business lock, which an account merge or
// delete takes too). incomeAccountId: an income account its sales may count
// as. purchaseAccountId: Cost of Goods Sold and its kind, or spending. An
// account the item names already (cur) is taken as it is, even one made
// inactive since, so sending an item back unchanged still saves.
async function resolveAccounts(px, businessId, fields, { isStaff, cur = null } = {}) {
  const kept = (k) => cur && fields[k] === cur[k];
  if (fields.incomeAccountId && !kept("incomeAccountId")) {
    if (!businessId) throw itemError(400, "BUSINESS_REQUIRED", "This item isn't in a business.");
    const acc = await assertAccountUsable(businessId, fields.incomeAccountId, "income", { isStaff, field: "incomeAccountId" }, px);
    fields.incomeAccountId = acc.id;
  }
  if (fields.purchaseAccountId && !kept("purchaseAccountId")) {
    if (!businessId) throw itemError(400, "BUSINESS_REQUIRED", "This item isn't in a business.");
    const acc = await assertAccountUsable(businessId, fields.purchaseAccountId, "expense", { isStaff, field: "purchaseAccountId" }, px);
    if (!PURCHASE_ACCOUNT_TYPES.includes(acc.type)) {
      throw Object.assign(new Error("Buying this counts as a cost or spending account."), {
        status: 400, code: "ACCOUNT_NOT_ALLOWED", field: "purchaseAccountId",
      });
    }
    fields.purchaseAccountId = acc.id;
  }
  return fields;
}

// The columns an item's fields write (every key the fields hold).
const COLUMNS = [
  "name", "description", "itemType", "unit", "price", "lowStockAlert", "incomeAccountId", "image", "category", "sku",
  "barcode", "trackInventory", "returnable", "purchasePrice", "purchaseDescription", "purchaseAccountId",
  "preferredSupplier", "brand", "manufacturer", "weight", "weightUnit", "length", "width", "height", "dimensionUnit",
  "upc", "ean", "isbn", "mpn",
];
function itemColumns(fields) {
  const data = {};
  for (const k of COLUMNS) if (fields[k] !== undefined) data[k] = fields[k];
  return data;
}

// Whether an item has been used: it holds stock or stock value (an item from
// before release 3 may, with no movement), stock moved, or a sale, invoice
// (of any type or status) or bill line names it. Its type and whether its
// stock is counted are then fixed, so a line's copy of them always equals the
// item's. item: the item's row, or its id.
async function isItemUsed(px, item) {
  const row = typeof item === "string"
    ? await px.inventoryItem.findUnique({ where: { id: item }, select: { id: true, quantity: true, stockValue: true } })
    : item;
  if (!row) return false;
  if (row.quantity > 0 || row.stockValue > 0) return true;
  const where = { itemId: row.id };
  const [moves, sold, invoiced, billed] = await Promise.all([
    px.stockMovement.count({ where }),
    px.saleItem.count({ where }),
    px.invoiceItem.count({ where }),
    px.billItem.count({ where }),
  ]);
  return moves + sold + invoiced + billed > 0;
}

// Adds an item (inside the caller's transaction, under the business lock),
// its accounts already checked (resolveAccounts) and its fields settled
// (newItemFields). Counted goods added with a quantity above 0 get their
// opening stock (a movement of kind opening, valued at the cost price, or at
// no value without one; the day must be after the books lock date); a cost
// price with no quantity is kept as the cost of one unit for later. extra:
// what a variant adds (groupId, variantValues, variantKey). Returns { item,
// opened, costSet }.
async function createItem(px, { businessId, ownerId, fields, quantity = 0, costPrice = null, createdBy, extra = {} }) {
  const created = await px.inventoryItem.create({
    data: {
      ...itemColumns(fields),
      ...extra,
      userId: ownerId,
      businessId,
      createdBy: createdBy ? createdBy.id : null,
      createdByName: createdBy ? createdBy.name : null,
    },
  });
  const now = new Date();
  if (quantity > 0) {
    await assertUnlockedIn(px, businessId, now);
    const r = await stock.putIn(px, {
      businessId, itemId: created.id, quantity, unitCost: costPrice ?? undefined, date: now,
      sourceKey: `open:${created.id}:1`, kind: "opening", createdById: createdBy ? createdBy.id : null,
    });
    return { item: r.item, opened: true, costSet: false };
  }
  if (costPrice !== null) {
    // Nothing in stock yet: only the cost of one unit is kept.
    const r = await stock.revalue(px, { businessId, itemId: created.id, newUnitCost: costPrice, date: now, createdById: createdBy ? createdBy.id : null });
    return { item: r.item, opened: false, costSet: true };
  }
  return { item: created, opened: false, costSet: false };
}

module.exports = {
  ITEM_TYPES,
  SERVICE_UNITS,
  WEIGHT_UNITS,
  DIMENSION_UNITS,
  PURCHASE_ACCOUNT_TYPES,
  PURCHASE_FIELDS,
  SHARED_FIELDS,
  OWN_FIELDS,
  itemError,
  canSeeCosts,
  publicItem,
  publicGroup,
  variantCounts,
  blank,
  num,
  readName,
  readQuantity,
  readCost,
  readItemFields,
  settleFields,
  newItemFields,
  assertUnitFits,
  memberPurchase,
  assertOwnFields,
  readOpening,
  resolveAccounts,
  itemColumns,
  isItemUsed,
  createItem,
};
