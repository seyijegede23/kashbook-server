const router = require("express").Router();
const auth = require("../middleware/auth");
const prisma = require("../utils/db");
const stock = require("../utils/stock");
const { audit } = require("../utils/audit");
const { ownerIdOf } = require("../utils/scope");
const { requirePermission, ownerOnly } = require("../middleware/requirePermission");
const { validateInventoryItem, validateInventoryPatch } = require("../middleware/validate");
const { invalidateLedger } = require("../utils/ledgerData");
const { assertUnlockedIn } = require("../utils/booksLock");
const { toKobo } = require("../utils/money");
const items = require("../utils/items");

const { SERVICE_UNITS, canSeeCosts, publicItem } = items;

// Products and services (chart of accounts release 3, 2026-10-13). Every item
// is goods or a service (itemType). A goods item keeps its stock and what that
// stock cost (quantity, stockValue, avgCost), and only the stock engine
// (utils/stock.js) changes those three, always with a StockMovement: an
// opening stock when the item is added, a count or a new cost price from the
// owner, an adjustment (damaged, expired, lost, used, found), and the sales,
// invoices and restocks recorded on their own routes. A service has no stock
// and no cost.
//
// Who may do what: anyone in the business adds and edits items (name, price,
// unit, barcode and the rest), as before. Only the owner changes a quantity
// or a cost directly (a member gets 403 OWNER_ONLY), deletes, archives or
// adjusts. What stock cost (stockValue, avgCost, the movements' values) is
// the reports' figure: the owner and members with canViewReports see it; for
// anyone else those fields are null.
//
// Every write that moves stock runs under the business lock, in one
// transaction, checks the books lock date for its day (utils/booksLock.js),
// clears the business's cached ledger and leaves an audit row.
//
// Items like Zoho (2026-10-14): an item also carries its purchase
// information, more information (brand, weight, codes), whether goods' stock
// is counted (trackInventory) and whether counted goods may come back into
// stock on a credit note (returnable). The fields and their rules are
// utils/items.js, which routes/itemGroups.js (items with variants) uses too.
// Goods whose stock is not counted take no quantity and no cost price (400
// NOT_STOCKED). Whether stock is counted, like the type, is fixed once the
// item is used (409 TRACKING_FIXED). A variant's shared fields are its
// group's (400 GROUP_FIELD).

// A barcode is unique per business. Without this, scanning a code that is
// already on another product returns a blank 500 and the shopkeeper has no idea
// why the save failed or which product already owns it. Prisma 7's Postgres
// adapter names the fields under meta.driverAdapterError (no meta.target), so
// both places are read.
function isDuplicateBarcode(err) {
  if (err?.code !== "P2002") return false;
  const fields = [
    ...(Array.isArray(err?.meta?.target) ? err.meta.target : []),
    ...(err?.meta?.driverAdapterError?.cause?.constraint?.fields || []),
  ];
  return fields.some((f) => String(f).includes("barcode"));
}

router.use(auth);

// What a member may see (canSeeCosts) and an item as the app receives it
// (publicItem: what stock cost and the purchase information only for the
// owner and members with the reports) are utils/items.js's.

// What a movement belongs to, from its sourceKey: the sale, invoice (or
// credit note) or bill whose line moved the stock, an adjustment, or the
// opening stock. ids: the record ids found for the line ids (resolveSources).
function sourceOf(m, ids) {
  const at = m.sourceKey.indexOf(":");
  const prefix = m.sourceKey.slice(0, at);
  const rest = m.sourceKey.slice(at + 1);
  switch (prefix) {
    case "sale": return { type: "sale", id: ids.sale.get(rest) || null };
    case "inv": return { type: m.kind === "credit_note" ? "credit_note" : "invoice", id: ids.inv.get(rest) || null };
    case "bill": return { type: "bill", id: ids.bill.get(rest) || null };
    case "open": return { type: "opening", id: null };
    default: return { type: "adjustment", id: null };
  }
}

// The records behind a list of movements, read in three queries.
async function resolveSources(moves) {
  const lineIds = (prefix) => moves
    .filter((m) => m.sourceKey.startsWith(`${prefix}:`))
    .map((m) => m.sourceKey.slice(prefix.length + 1));
  const [sales, invs, bills] = await Promise.all([
    lineIds("sale").length ? prisma.saleItem.findMany({ where: { id: { in: lineIds("sale") } }, select: { id: true, saleId: true } }) : [],
    lineIds("inv").length ? prisma.invoiceItem.findMany({ where: { id: { in: lineIds("inv") } }, select: { id: true, invoiceId: true } }) : [],
    lineIds("bill").length ? prisma.billItem.findMany({ where: { id: { in: lineIds("bill") } }, select: { id: true, billId: true } }) : [],
  ]);
  return {
    sale: new Map(sales.map((l) => [l.id, l.saleId])),
    inv: new Map(invs.map((l) => [l.id, l.invoiceId])),
    bill: new Map(bills.map((l) => [l.id, l.billId])),
  };
}

// A movement as the app receives it. Only the owner and members with the
// reports read movements (GET /:id/movements, the sync bundle's stockMoves),
// so the values stay.
function publicMovement(m, { ids, names } = {}) {
  return {
    id: m.id,
    itemId: m.itemId,
    kind: m.kind,
    reason: m.reason,
    date: m.date,
    quantity: m.quantity,
    value: m.value,
    qtyAfter: m.qtyAfter,
    valueAfter: m.valueAfter,
    note: m.note,
    sourceKey: m.sourceKey,
    source: ids ? sourceOf(m, ids) : null,
    createdById: m.createdById,
    createdByName: (names && m.createdById && names.get(m.createdById)) || null,
    createdAt: m.createdAt,
  };
}

// ── Reading what a request sends ────────────────────────────────────────────

function routeError(status, code, message, extra) {
  const err = Object.assign(new Error(message), { status, code });
  if (extra) err.extra = extra;
  return err;
}

// A refusal as the app reads it: { error, code }, plus the field it is about
// and anything else it carries (the item, what is in stock, the lock date).
function sendRefusal(res, err) {
  return res.status(err.status).json({
    error: err.message,
    code: err.code,
    ...(err.field ? { field: err.field } : {}),
    ...(err.extra || {}),
  });
}

function fail(res, err, what) {
  if (isDuplicateBarcode(err)) {
    return res.status(409).json({ code: "BARCODE_TAKEN", error: "Another product already uses that barcode." });
  }
  if (err && err.status && err.code) return sendRefusal(res, err);
  console.error(`inventory: ${what} failed:`, err?.message || err);
  return res.status(500).json({ error: `Failed to ${what}` });
}

const { blank, num, readQuantity } = items;

// A cost price for one unit, in naira and kobo; null when none was sent.
const readCostPrice = (v, field = "costPrice") => items.readCost(v, field);

// ── Shared steps ─────────────────────────────────────────────────────────────

// Under the item's business lock, in one transaction (the stock engine also
// locks the item's row). An item from before businesses has no business, and
// is locked on its owner.
function locked(key, fn) {
  return prisma.withBusinessLock(key, () => prisma.$transaction(fn, { timeout: 20000 }));
}

// The item a route is about: this owner's, else 404 or 403 as before.
async function findItem(req, res) {
  const id = req.params.id;
  const item = typeof id === "string" && id.length <= 100
    ? await prisma.inventoryItem.findUnique({ where: { id } })
    : null;
  if (!item) {
    res.status(404).json({ error: "Item not found", code: "ITEM_NOT_FOUND" });
    return null;
  }
  if (item.userId !== ownerIdOf(req)) {
    res.status(403).json({ error: "Forbidden" });
    return null;
  }
  return item;
}

// The item again, inside the transaction, with its row locked.
async function lockedRow(px, id) {
  await px.$queryRaw`SELECT "id" FROM "InventoryItem" WHERE "id" = ${id} FOR UPDATE`;
  const item = await px.inventoryItem.findUnique({ where: { id } });
  if (!item) throw routeError(404, "ITEM_NOT_FOUND", "Item not found");
  return item;
}

// Stock moves only for an item of a business: the movements and the books
// are the business's.
function assertHasBusiness(item) {
  if (!item.businessId) {
    throw routeError(400, "BUSINESS_REQUIRED", "This item isn't in a business, so its stock can't be counted.");
  }
}

// A variant archived, brought back or deleted on its own changes its group's
// count of variants: the group is stamped, so every phone's next sync
// brings it again.
async function touchGroup(px, groupId) {
  if (groupId) await px.itemGroup.updateMany({ where: { id: groupId }, data: { updatedAt: new Date() } });
}

const isStaffReq = (req) => req.user.accountType === "staff";

function auditStock(req, action, item, metadata) {
  audit({ req, action, resourceType: "inventory_item", resourceId: item.id, metadata: { businessId: item.businessId, ...metadata } })
    .catch(() => {});
}

// ── Reading ──────────────────────────────────────────────────────────────────

// GET /inventory?businessId=&since=
// Archived items come too (archivedAt set): the app leaves them out of its
// lists and pickers and shows them under Archived.
router.get("/", async (req, res) => {
  try {
    const { businessId, since } = req.query;
    const where = { userId: ownerIdOf(req) };
    if (businessId) where.businessId = businessId;
    if (since) where.updatedAt = { gt: new Date(since) };
    const items = await prisma.inventoryItem.findMany({
      where,
      orderBy: since ? { updatedAt: "asc" } : { name: "asc" },
    });
    const canSee = canSeeCosts(req);
    res.json(items.map((i) => publicItem(i, canSee)));
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch inventory" });
  }
});

// GET /inventory/:id/movements?limit=
// The item's stock history, newest first: every movement with what it was
// (kind, reason), its day, the quantity and value it moved and what the item
// held after, the record it belongs to (source: { type: sale | invoice |
// credit_note | bill | adjustment | opening, id }) and who recorded it. Values
// are costs, so the history is the reports' (canViewReports; owners hold it).
router.get("/:id/movements", requirePermission("canViewReports"), async (req, res) => {
  try {
    const item = await findItem(req, res);
    if (!item) return;
    const limit = Math.min(500, Math.max(1, Math.floor(Number(req.query.limit)) || 100));
    const moves = item.businessId
      ? await prisma.stockMovement.findMany({
        where: { itemId: item.id, businessId: item.businessId },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit,
      })
      : [];
    const ids = await resolveSources(moves);
    const people = [...new Set(moves.map((m) => m.createdById).filter(Boolean))];
    // Only the owner and their own staff are named.
    const users = people.length
      ? await prisma.user.findMany({
        where: { id: { in: people }, OR: [{ id: item.userId }, { employerId: item.userId }] },
        select: { id: true, firstName: true, lastName: true },
      })
      : [];
    const names = new Map(users.map((u) => [u.id, `${u.firstName || ""} ${u.lastName || ""}`.trim() || null]));
    res.json({ item: publicItem(item, true), movements: moves.map((m) => publicMovement(m, { ids, names })) });
  } catch (err) {
    fail(res, err, "read the stock history");
  }
});

// ── Adding ───────────────────────────────────────────────────────────────────

// POST /inventory
// { businessId, name, itemType?: goods | service, price?, unit?, quantity?,
//   costPrice?, lowStockAlert?, incomeAccountId?, description?, category?,
//   sku?, barcode?, image?, trackInventory?, returnable?, purchasePrice?,
//   purchaseDescription?, purchaseAccountId?, preferredSupplier?, brand?,
//   manufacturer?, weight?, weightUnit?, length?, width?, height?,
//   dimensionUnit?, upc?, ean?, isbn?, mpn? }
// Counted goods added with a quantity above 0 get their opening stock (a
// movement of kind opening, valued at the cost price, or at no value when no
// cost price is given yet); a cost price with no quantity is kept as the
// item's cost for later. Both are the owner's (403 OWNER_ONLY for a member),
// and so is the purchase information. Goods whose stock is not counted
// (trackInventory false) take neither (400 NOT_STOCKED); their reorder point
// means nothing. A service keeps no stock: a quantity, cost price or
// reorder point sent for one is ignored. A service may have no fixed price
// (0). New goods are not returnable unless returnable is sent true.
router.post("/", validateInventoryItem, async (req, res) => {
  const body = req.body || {};
  const isStaff = isStaffReq(req);
  const canSee = canSeeCosts(req);
  try {
    const { businessId } = body;
    if (blank(businessId)) {
      throw routeError(400, "BUSINESS_REQUIRED", "Choose a business for this item.", { field: "businessId" });
    }
    const owned = typeof businessId === "string"
      ? await prisma.business.findFirst({ where: { id: businessId, userId: ownerIdOf(req) }, select: { id: true } })
      : null;
    if (!owned) return res.status(403).json({ error: "Forbidden" });

    const sent = items.memberPurchase(items.readItemFields(body), null, { isStaff, canSee });
    if (sent.name === undefined) throw routeError(400, "BAD_NAME", "Give the item a name.", { field: "name" });
    const fields = items.newItemFields(sent);
    const { quantity, costPrice } = items.readOpening(body, fields, { isStaff });
    items.assertUnitFits(fields.itemType, fields.unit);

    const result = await locked(businessId, async (px) => {
      // Under the business lock, which an account merge or delete takes too.
      await items.resolveAccounts(px, businessId, fields, { isStaff });
      return items.createItem(px, {
        businessId, ownerId: ownerIdOf(req), fields, quantity, costPrice,
        createdBy: { id: req.user.id, name: req.user.name },
      });
    });
    const { item } = result;
    invalidateLedger(businessId);
    if (result.opened) auditStock(req, "STOCK_ADJUST", item, { kind: "opening", quantity, costPrice });
    else if (result.costSet) auditStock(req, "STOCK_VALUE_SET", item, { costPrice, quantity: 0 });
    res.status(201).json(publicItem(item, canSee));
  } catch (err) {
    fail(res, err, "create item");
  }
});

// POST /inventory/stock-value { businessId, items: [{ itemId, unitCost }] }
// The "Set up stock value" sheet: the cost of one unit for goods whose stock
// has no value yet, all saved together or none. Each item's stock on hand is
// valued at its cost (an opening_value movement for stock that never had a
// value; a revalue for one that had, should its cost have been set since).
// Owner only.
router.post("/stock-value", ownerOnly(), async (req, res) => {
  const body = req.body || {};
  try {
    const { businessId } = body;
    const owned = typeof businessId === "string" && businessId
      ? await prisma.business.findFirst({ where: { id: businessId, userId: req.user.id }, select: { id: true } })
      : null;
    if (!owned) return res.status(403).json({ error: "Forbidden" });
    const raw = body.items;
    if (!Array.isArray(raw) || !raw.length || raw.length > 500) {
      throw routeError(400, "BAD_ITEMS", "Send between 1 and 500 items, each with its cost.", { field: "items", max: 500 });
    }
    const seen = new Set();
    const lines = raw.map((l, i) => {
      if (!l || typeof l !== "object" || typeof l.itemId !== "string" || !l.itemId) {
        throw routeError(400, "BAD_ITEMS", "Each line names an item and its cost.", { field: "items", line: i });
      }
      if (seen.has(l.itemId)) throw routeError(400, "DUPLICATE_ITEM", "An item is listed twice.", { field: "items", line: i, itemId: l.itemId });
      seen.add(l.itemId);
      let unitCost;
      try {
        unitCost = readCostPrice(l.unitCost, "items");
      } catch (e) {
        e.extra = { ...e.extra, line: i };
        throw e;
      }
      if (unitCost === null) throw routeError(400, "BAD_COST", "Enter a cost for every item.", { field: "items", line: i });
      return { itemId: l.itemId, unitCost, line: i };
    });

    const result = await locked(businessId, async (px) => {
      const now = new Date();
      await assertUnlockedIn(px, businessId, now);
      const items = [];
      const movements = [];
      for (const l of lines) {
        try {
          const r = await stock.revalue(px, { businessId, itemId: l.itemId, newUnitCost: l.unitCost, date: now, createdById: req.user.id });
          items.push(r.item);
          if (r.movement) movements.push(r.movement);
        } catch (e) {
          if (e && e.status) e.extra = { ...(e.extra || {}), line: l.line };
          throw e;
        }
      }
      return { items, movements };
    });
    invalidateLedger(businessId);
    audit({
      req, action: "STOCK_VALUE_SET", resourceType: "business", resourceId: businessId,
      metadata: { items: lines.length, movements: result.movements.length, itemIds: lines.map((l) => l.itemId).slice(0, 100) },
    }).catch(() => {});
    res.json({ items: result.items.map((i) => publicItem(i, true)), movements: result.movements.map((m) => publicMovement(m)) });
  } catch (err) {
    fail(res, err, "set the stock value");
  }
});

// ── Changing ─────────────────────────────────────────────────────────────────

// PATCH /inventory/:id
// Name, price, unit, reorder point, barcode, descriptions, more information
// and the rest: anyone in the business. itemType and trackInventory: only
// while the item is unused (no stock moved, no sale, invoice or bill names
// it; else 409 TYPE_FIXED or TRACKING_FIXED). A service is never counted;
// goods stop being counted with no stock and no cost of one unit, and only
// counted goods stay returnable. incomeAccountId: an income account its
// sales count as (null: Sales for goods, Service Income for a service).
// purchaseAccountId (goods not counted, or a service): a cost or spending
// account. The purchase information is the owner's (utils/items.js
// memberPurchase). A variant's shared fields are its group's: another value
// for one is 400 GROUP_FIELD. quantity: the owner counted the stock (the
// difference is an adjustment, reason counted). costPrice: the owner's new
// cost for one unit (the stock on hand is valued at it). A member sending a
// quantity that differs from the item's gets 403 OWNER_ONLY; the item's own
// quantity sent back (an edit form sending every field) changes nothing. A
// cost price is the same for a member who sees costs (canViewReports): their
// own view of it sent back changes nothing, any other is 403 OWNER_ONLY. A
// member who does not see costs gets 403 OWNER_ONLY for any cost price at
// all, so the answer never tells them whether a guess was the hidden cost.
// The purchase information is read for a member before anything else about
// the item, so a variant's answer never tells them either. Whether goods'
// stock is counted is the owner's to change (403 OWNER_ONLY for a member),
// and so is a change of type that would drop the owner's cost of one unit
// or purchase account; what an owner's change drops is in its audit row.
// Goods whose stock is not counted take no other quantity and no cost price
// (400 NOT_STOCKED). A service ignores a quantity and a cost price (the cost
// it had as goods is kept, for when it is goods again). A change of type or
// of tracking is audited.
router.patch("/:id", validateInventoryPatch, async (req, res) => {
  const body = req.body || {};
  const isStaff = isStaffReq(req);
  const canSee = canSeeCosts(req);
  try {
    const item0 = await findItem(req, res);
    if (!item0) return;
    const sent = items.readItemFields(body, { keepImage: item0.image });
    const sentQuantity = blank(body.quantity) ? null : readQuantity(body.quantity);
    const sentCost = readCostPrice(body.costPrice);
    // Refused before the item's cost is read, whatever it is.
    if (sentCost !== null && isStaff && !canSee) {
      throw routeError(403, "OWNER_ONLY", "Only the business owner can change the cost price.");
    }

    let counted = null;
    let revalued = null;
    let typeChange = null;
    let trackChange = null;
    const item = await locked(item0.businessId || item0.userId, async (px) => {
      let cur = await lockedRow(px, item0.id);
      // The purchase information first (a member's guess of a hidden value
      // gets the one answer whatever it is), then a variant's shared fields.
      const mine = items.memberPurchase(sent, cur, { isStaff, canSee });
      if (cur.groupId) items.assertOwnFields(mine, cur);
      const fields = items.settleFields(mine, cur);
      const itemType = fields.itemType !== undefined ? fields.itemType : cur.itemType;
      const counts = fields.trackInventory !== undefined ? fields.trackInventory : cur.trackInventory;
      if (itemType !== cur.itemType || counts !== cur.trackInventory) {
        // Whether goods' stock is counted is the owner's call (a change of
        // type carries its own tracking with it).
        if (isStaff && itemType === "goods" && cur.itemType === "goods") {
          throw routeError(403, "OWNER_ONLY", "Only the business owner can change whether this item's stock is counted.");
        }
        if (await items.isItemUsed(px, cur)) {
          if (itemType !== cur.itemType) {
            throw routeError(409, "TYPE_FIXED", "This item has been used, so it stays goods or a service as it is.", { itemId: cur.id });
          }
          throw routeError(409, "TRACKING_FIXED", "This item has been used, so whether its stock is counted stays as it is.", { itemId: cur.id });
        }
        // What the change drops of the owner's: the cost of one unit (goods
        // whose stock is not counted have none) and the purchase account
        // (counted goods keep none). A member's change never does.
        const dropped = {};
        if (itemType === "goods" && !counts && cur.avgCost != null) dropped.avgCost = cur.avgCost;
        if (cur.purchaseAccountId && fields.purchaseAccountId === null) dropped.purchaseAccountId = cur.purchaseAccountId;
        if (isStaff && Object.keys(dropped).length) {
          throw routeError(403, "OWNER_ONLY", "Only the business owner can change this item's type, as it would drop the owner's cost or purchase account.");
        }
        const extra = Object.keys(dropped).length ? { dropped } : {};
        if (itemType !== cur.itemType) typeChange = { from: cur.itemType, to: itemType, ...extra };
        else trackChange = { from: cur.trackInventory, to: counts, ...extra };
      }
      items.assertUnitFits(itemType, fields.unit !== undefined ? fields.unit : cur.unit);
      await items.resolveAccounts(px, cur.businessId, fields, { isStaff, cur });

      const data = items.itemColumns(fields);
      // An unused item has no stock and no stock value. Its cost of one unit
      // (avgCost) is kept when it becomes a service (a service ignores it, and
      // it is the cost again if the item goes back to goods, so a change of
      // type never wipes the owner's cost price); goods whose stock is not
      // counted have none. Neither is alerted for low stock.
      if (itemType === "goods" && !counts && cur.avgCost != null) data.avgCost = null;
      if (!counts && cur.lowStockNotifiedAt) data.lowStockNotifiedAt = null;

      // What the stock changes, for counted goods: a quantity or cost that
      // differs from the item's. A member may send the item's own values
      // back. Goods whose stock is not counted take none (400 NOT_STOCKED).
      const goods = itemType === "goods";
      const newCount = goods && sentQuantity !== null && Math.round(sentQuantity * 1000) !== Math.round(cur.quantity * 1000)
        ? sentQuantity : null;
      // A cost equal to the average to the kobo (as the app shows it) is the
      // same cost: no new value for a few kobo of rounding.
      const newCost = goods && sentCost !== null && (cur.avgCost == null || toKobo(sentCost) !== toKobo(cur.avgCost))
        ? sentCost : null;
      if (goods && !counts && (newCount !== null || newCost !== null)) {
        throw routeError(400, "NOT_STOCKED", "This item's stock isn't counted.", { field: newCount !== null ? "quantity" : "costPrice", itemId: cur.id });
      }
      if (isStaff && (newCount !== null || newCost !== null)) {
        throw routeError(403, "OWNER_ONLY", "Only the business owner can change the stock or the cost price.");
      }

      if (Object.keys(data).length) cur = await px.inventoryItem.update({ where: { id: cur.id }, data });
      if (newCount !== null || newCost !== null) {
        assertHasBusiness(cur);
        const now = new Date();
        await assertUnlockedIn(px, cur.businessId, now);
        // The new cost first, so goods found in the count come in at it.
        if (newCost !== null) {
          revalued = await stock.revalue(px, { businessId: cur.businessId, itemId: cur.id, newUnitCost: newCost, date: now, createdById: req.user.id });
          cur = revalued.item;
        }
        if (newCount !== null) {
          const from = cur.quantity;
          counted = await stock.count(px, { businessId: cur.businessId, itemId: cur.id, countedQuantity: newCount, date: now, createdById: req.user.id });
          counted.from = from;
          cur = counted.item;
        }
      }
      return cur;
    });
    if (item.businessId) invalidateLedger(item.businessId);
    if (typeChange) auditStock(req, "ITEM_TYPE_CHANGE", item, { ...typeChange, byStaff: isStaff });
    if (trackChange) auditStock(req, "ITEM_TRACKING_CHANGE", item, { ...trackChange, byStaff: isStaff });
    if (revalued) {
      auditStock(req, "STOCK_VALUE_SET", item, { costPrice: sentCost, value: revalued.value, movementId: revalued.movement ? revalued.movement.id : null });
    }
    if (counted) {
      auditStock(req, "STOCK_ADJUST", item, {
        reason: "counted", from: counted.from, to: sentQuantity, movementId: counted.movement ? counted.movement.id : null,
      });
    }
    res.json(publicItem(item, canSee));
  } catch (err) {
    fail(res, err, "update item");
  }
});

// POST /inventory/:id/adjust
// { quantity (signed: -2 damaged, +3 found) | countedQuantity, reason, date?,
//   note?, clientRef? }
// Stock that changed outside a sale or a restock (owner only). With quantity:
// goods out at the average cost (damaged, expired, lost, used, other), or in
// at it (found: other, counted). With countedQuantity: the stock was counted,
// and the difference is the adjustment (reason counted). Dated today unless a
// day is sent, and never on or before the books lock date. clientRef makes a
// retry safe: the same one again returns the first adjustment (repeated).
router.post("/:id/adjust", ownerOnly(), async (req, res) => {
  const body = req.body || {};
  try {
    const item0 = await findItem(req, res);
    if (!item0) return;
    assertHasBusiness(item0);
    const hasQty = !blank(body.quantity);
    const hasCount = !blank(body.countedQuantity);
    if (hasQty === hasCount) {
      throw routeError(400, "BAD_ADJUST", "Send how much the stock changed, or what you counted.", { field: "quantity" });
    }
    if (typeof body.date === "object" && body.date !== null) throw routeError(400, "BAD_DATE", "That date can't be read.", { field: "date" });
    const when = blank(body.date) ? new Date() : new Date(body.date);
    if (Number.isNaN(when.getTime())) throw routeError(400, "BAD_DATE", "That date can't be read.", { field: "date" });
    if (body.clientRef !== undefined && body.clientRef !== null && (typeof body.clientRef !== "string" || !body.clientRef.trim() || body.clientRef.length > 80)) {
      throw routeError(400, "BAD_CLIENT_REF", "That retry key isn't valid.", { field: "clientRef" });
    }
    const sourceKey = typeof body.clientRef === "string" ? `adj:${item0.id}:${body.clientRef.trim()}` : undefined;
    const note = typeof body.note === "string" ? body.note : undefined;
    const args = { businessId: item0.businessId, itemId: item0.id, date: when, note, sourceKey, createdById: req.user.id };

    const result = await locked(item0.businessId, async (px) => {
      await assertUnlockedIn(px, item0.businessId, when);
      if (hasCount) return stock.count(px, { ...args, countedQuantity: num(body.countedQuantity) });
      return stock.adjust(px, { ...args, quantity: num(body.quantity), reason: body.reason });
    });
    invalidateLedger(item0.businessId);
    if (result.movement && !result.repeated) {
      auditStock(req, "STOCK_ADJUST", item0, {
        reason: result.movement.reason, quantity: result.movement.quantity, value: result.movement.value, movementId: result.movement.id,
      });
    }
    res.status(result.repeated ? 200 : 201).json({
      item: publicItem(result.item, true),
      movement: result.movement ? publicMovement(result.movement) : null,
      repeated: !!result.repeated,
    });
  } catch (err) {
    fail(res, err, "adjust the stock");
  }
});

// POST /inventory/:id/archive and /unarchive (owner only)
// An item with history is archived instead of deleted: it leaves the lists
// and pickers (nothing new can be sold, invoiced or restocked with it), and
// its history and stock value stay. Unarchiving brings it back; a variant
// whose group is archived comes back with its group (409 GROUP_ARCHIVED).
for (const [path, archived] of [["archive", true], ["unarchive", false]]) {
  router.post(`/:id/${path}`, ownerOnly(), async (req, res) => {
    try {
      const item0 = await findItem(req, res);
      if (!item0) return;
      const item = await locked(item0.businessId || item0.userId, async (px) => {
        const cur = await lockedRow(px, item0.id);
        if (!!cur.archivedAt === archived) return cur;
        // A variant comes back with its group, never into an archived one.
        if (!archived && cur.groupId) {
          const group = await px.itemGroup.findUnique({ where: { id: cur.groupId }, select: { archivedAt: true } });
          if (group && group.archivedAt) {
            throw routeError(409, "GROUP_ARCHIVED", "Bring back the group first.", { groupId: cur.groupId });
          }
        }
        await touchGroup(px, cur.groupId);
        return px.inventoryItem.update({ where: { id: cur.id }, data: { archivedAt: archived ? new Date() : null } });
      });
      if (item.businessId) invalidateLedger(item.businessId);
      auditStock(req, "ITEM_ARCHIVE", item, { archived });
      res.json(publicItem(item, true));
    } catch (err) {
      fail(res, err, `${path} item`);
    }
  });
}

// ── Deleting ─────────────────────────────────────────────────────────────────

// DELETE /inventory/:id (owner only)
// Only an item with no history: no stock movement and no bill line names it.
// Otherwise 409 ITEM_HAS_HISTORY, and the app offers to archive it. Sale and
// invoice lines keep the item's name when it goes. A variant goes from its
// group (whose count of variants changes).
router.delete("/:id", async (req, res) => {
  if (isStaffReq(req)) {
    return res.status(403).json({ error: "Staff cannot delete inventory items", code: "OWNER_ONLY" });
  }
  try {
    const item0 = await findItem(req, res);
    if (!item0) return;
    await locked(item0.businessId || item0.userId, async (px) => {
      const cur = await lockedRow(px, item0.id);
      const [moves, billed] = await Promise.all([
        px.stockMovement.count({ where: { itemId: cur.id } }),
        px.billItem.count({ where: { itemId: cur.id } }),
      ]);
      if (moves || billed) {
        throw routeError(409, "ITEM_HAS_HISTORY", "This item has stock history. Archive it instead.", { itemId: cur.id });
      }
      await px.inventoryItem.delete({ where: { id: cur.id } });
      await touchGroup(px, cur.groupId);
    });
    if (item0.businessId) invalidateLedger(item0.businessId);
    res.json({ message: "Deleted" });
  } catch (err) {
    fail(res, err, "delete item");
  }
});

module.exports = router;
// What the other routes show of items and movements (routes/sales.js,
// routes/transactions.js, routes/sync.js), so every door hides the same costs
// (canSeeCosts and publicItem are utils/items.js's).
module.exports.itemView = { SERVICE_UNITS, canSeeCosts, publicItem, publicMovement };
