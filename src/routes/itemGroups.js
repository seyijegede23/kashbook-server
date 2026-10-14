const router = require("express").Router();
const auth = require("../middleware/auth");
const prisma = require("../utils/db");
const { audit } = require("../utils/audit");
const { ownerIdOf } = require("../utils/scope");
const { ownerOnly } = require("../middleware/requirePermission");
const { invalidateLedger } = require("../utils/ledgerData");
const items = require("../utils/items");

// Items with variants (items like Zoho, 2026-10-14). One product in
// attributes (Size: S, M, L; Colour: red, blue), one item per combination,
// each with its own price, purchase price, stock, cost and barcode. An
// ItemGroup holds what the variants share (type, unit, whether their stock is
// counted, returnable, the descriptions, the accounts, the preferred
// supplier, brand, manufacturer: utils/items.js SHARED_FIELDS), copied to
// every variant and changed only here; each variant is an ordinary
// InventoryItem (groupId, variantValues, variantKey), so selling, invoicing,
// restocking, the stock engine and the reports work on it as on any item.
//
// Variant names are "<group name> - <values joined with ' / '>" ("Shirt - M /
// Red") unless one is given, and each may be renamed on its own (PATCH
// /inventory/:id); renaming the group renames the variants that still carry
// the automatic name. Attributes are 1 to 3, with 1 to 30 options each, and at
// most 100 variants a group; attributes only grow (new options on the ones
// there are; an option a variant uses is never removed or renamed: 409
// OPTION_IN_USE). The type and whether stock is counted change only while no
// variant is used (409 TYPE_FIXED, TRACKING_FIXED). A group's name is one of
// its kind among the business's live groups (409 GROUP_NAME_TAKEN).
//
// Who may do what, as for items (routes/inventory.js): anyone in the
// business adds and edits groups and variants; opening stock, a cost price
// and the purchase information are the owner's (403 OWNER_ONLY), and only
// the owner archives or deletes. Every write runs under the business lock in
// one transaction, clears the business's cached ledger and leaves an audit
// row (ITEM_GROUP_CREATE, ITEM_GROUP_UPDATE, ITEM_GROUP_ARCHIVE,
// ITEM_GROUP_DELETE). Replies carry { group, items }: the group (with
// variantCount, the variants not archived) and its variants as they now are,
// in the order of the attributes' options. Refusals are { error, code,
// field?, ... } as on routes/inventory.js; one about a variant names it
// (variant: its index in the list sent).

router.use(auth);

const MAX_ATTRIBUTES = 3;
const MAX_OPTIONS = 30;
const MAX_VARIANTS = 100;
const MAX_LABEL = 40;
// Between the values of a variant's key (they never hold it).
const SEP = "\u001f";
const GROUP_FIELDS = ["name", "image", ...items.SHARED_FIELDS];
// A hundred variants, each with its opening stock.
const TX = { timeout: 60000 };

const { itemError, blank, canSeeCosts, publicItem, publicGroup } = items;
const isStaffReq = (req) => req.user.accountType === "staff";

// ── Refusals ─────────────────────────────────────────────────────────────────

// A unique index that refused a write, named as Prisma 7's Postgres adapter
// names it (meta.driverAdapterError) or as older ones did (meta.target).
function isDuplicate(err, field) {
  if (err?.code !== "P2002") return false;
  const fields = [
    ...(Array.isArray(err?.meta?.target) ? err.meta.target : []),
    ...(err?.meta?.driverAdapterError?.cause?.constraint?.fields || []),
  ];
  return fields.some((f) => String(f).includes(field));
}

function sendRefusal(res, err) {
  return res.status(err.status).json({
    error: err.message,
    code: err.code,
    ...(err.field ? { field: err.field } : {}),
    ...(err.extra || {}),
  });
}

function fail(res, err, what) {
  if (isDuplicate(err, "barcode")) {
    return res.status(409).json({ code: "BARCODE_TAKEN", error: "Another product already uses that barcode." });
  }
  if (isDuplicate(err, "variantKey")) {
    return res.status(409).json({ code: "DUPLICATE_VARIANT", error: "That combination is already a variant.", field: "variants" });
  }
  if (err && err.status && err.code) return sendRefusal(res, err);
  console.error(`itemGroups: ${what} failed:`, err?.message || err);
  return res.status(500).json({ error: `Failed to ${what}` });
}

// ── Attributes and variants ──────────────────────────────────────────────────

// [{ name, options: [text] }] as sent: 1 to 3 attributes with names of their
// own, each 1 to 30 options of its own (one spelling of a word, whatever its
// capitals), at most 40 characters each. 400 BAD_ATTRIBUTES { field:
// "attributes", attribute, option? } otherwise.
function readAttributes(raw) {
  const bad = (message, extra = {}) => itemError(400, "BAD_ATTRIBUTES", message, { field: "attributes", ...extra });
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_ATTRIBUTES) {
    throw bad(`An item with variants has 1 to ${MAX_ATTRIBUTES} attributes, like Size or Colour.`, { max: MAX_ATTRIBUTES });
  }
  const names = new Set();
  return raw.map((a, i) => {
    if (!a || typeof a !== "object" || Array.isArray(a)) throw bad("Each attribute has a name and its options.", { attribute: i });
    const name = typeof a.name === "string" ? a.name.trim() : "";
    if (!name || name.length > MAX_LABEL) throw bad(`Name each attribute, in at most ${MAX_LABEL} characters.`, { attribute: i });
    if (names.has(name.toLowerCase())) throw bad("Two attributes have the same name.", { attribute: i });
    names.add(name.toLowerCase());
    if (!Array.isArray(a.options) || a.options.length < 1 || a.options.length > MAX_OPTIONS) {
      throw bad(`An attribute has 1 to ${MAX_OPTIONS} options.`, { attribute: i, max: MAX_OPTIONS });
    }
    const seen = new Set();
    const options = a.options.map((o, j) => {
      const opt = typeof o === "string" ? o.trim() : typeof o === "number" && Number.isFinite(o) ? String(o) : "";
      if (!opt || opt.length > MAX_LABEL || opt.includes(SEP)) {
        throw bad(`Each option is a word or a number, at most ${MAX_LABEL} characters.`, { attribute: i, option: j });
      }
      if (seen.has(opt.toLowerCase())) throw bad("An option is listed twice.", { attribute: i, option: j });
      seen.add(opt.toLowerCase());
      return opt;
    });
    return { name, options };
  });
}

// The attributes an edit sends, against the group's: the same number of
// attributes (they may be renamed), and every option a variant uses still
// there as it is spelled (409 OPTION_IN_USE { attribute, option } names the
// first one missing). New options may be added and unused ones removed.
function mergeAttributes(saved, next, variants) {
  if (next.length !== saved.length) {
    throw itemError(400, "BAD_ATTRIBUTES", "Attributes can't be added or removed once the item group is made. Add options instead.", {
      field: "attributes", count: saved.length,
    });
  }
  for (let i = 0; i < next.length; i++) {
    for (const v of variants) {
      const used = Array.isArray(v.variantValues) ? v.variantValues[i] : undefined;
      if (used !== undefined && !next[i].options.includes(used)) {
        throw itemError(409, "OPTION_IN_USE", `A variant uses ${used}, so it stays.`, { field: "attributes", attribute: i, option: used, itemId: v.id });
      }
    }
  }
  return next;
}

const keyOf = (values) => values.map((v) => v.toLowerCase()).join(SEP);
const autoName = (groupName, values) => `${groupName} - ${(values || []).join(" / ")}`;

// A variant's option for each attribute, in the group's order, as the group
// spells it. 400 BAD_VARIANTS { field: "variants", attribute? } otherwise.
function readValues(raw, attributes) {
  if (!Array.isArray(raw) || raw.length !== attributes.length) {
    throw itemError(400, "BAD_VARIANTS", "Pick one option of each attribute for every variant.", { field: "variants" });
  }
  return raw.map((v, j) => {
    const said = typeof v === "string" ? v.trim().toLowerCase() : typeof v === "number" ? String(v).toLowerCase() : null;
    const option = said === null ? undefined : attributes[j].options.find((o) => o.toLowerCase() === said);
    if (option === undefined) {
      throw itemError(400, "BAD_VARIANTS", `That isn't one of the options of ${attributes[j].name}.`, { field: "variants", attribute: j });
    }
    return option;
  });
}

// The variants a request sends, [{ values, name?, price, purchasePrice?,
// quantity?, costPrice?, lowStockAlert?, barcode?, image?, weight?, ...more
// information }], 1 to 100: each a combination not listed twice (400
// DUPLICATE_VARIANT) nor made already (409 DUPLICATE_VARIANT, `existing`),
// its own fields checked as an item's (utils/items.js), the shared ones the
// group's, its opening stock as POST /inventory takes it. A refusal names
// the variant (its index). Returns [{ values, key, fields, quantity,
// costPrice }]; fields.name is left out for the automatic name.
function readVariants(raw, attributes, shared, { isStaff, canSee, existing = new Set(), room = MAX_VARIANTS }) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > room) {
    const says = room < 1
      ? `This item group has ${MAX_VARIANTS} variants, the most it can hold.`
      : `Add 1 to ${room} variants; an item group holds at most ${MAX_VARIANTS}.`;
    throw itemError(400, "BAD_VARIANTS", says, {
      field: "variants", max: MAX_VARIANTS,
    });
  }
  const keys = new Set();
  const barcodes = new Map();
  return raw.map((v, i) => {
    try {
      if (!v || typeof v !== "object" || Array.isArray(v)) {
        throw itemError(400, "BAD_VARIANTS", "Each variant names its options and its price.", { field: "variants" });
      }
      const values = readValues(v.values, attributes);
      const key = keyOf(values);
      if (keys.has(key)) throw itemError(400, "DUPLICATE_VARIANT", "That combination is listed twice.", { field: "variants" });
      if (existing.has(key)) throw itemError(409, "DUPLICATE_VARIANT", "That combination is already a variant.", { field: "variants" });
      keys.add(key);
      const src = blank(v.name) ? { ...v, name: undefined } : v;
      const own = items.memberPurchase(items.readItemFields(src, { only: items.OWN_FIELDS }), null, { isStaff, canSee });
      const fields = items.newItemFields({ ...own, ...shared });
      if (fields.barcode) {
        if (barcodes.has(fields.barcode)) {
          throw itemError(409, "BARCODE_TAKEN", "Two variants have the same barcode.", { field: "barcode" });
        }
        barcodes.set(fields.barcode, i);
      }
      const { quantity, costPrice } = items.readOpening(v, fields, { isStaff });
      return { values, key, fields, quantity, costPrice };
    } catch (e) {
      if (e && e.status) e.extra = { ...(e.extra || {}), variant: i };
      throw e;
    }
  });
}

// A barcode a variant brings that another item of the business has already
// (409 BARCODE_TAKEN { variant }), found before anything is written.
async function assertBarcodesFree(px, businessId, variants) {
  const codes = variants.map((v) => v.fields.barcode).filter(Boolean);
  if (!codes.length) return;
  const taken = await px.inventoryItem.findFirst({ where: { businessId, barcode: { in: codes } }, select: { barcode: true } });
  if (taken) {
    const variant = variants.findIndex((v) => v.fields.barcode === taken.barcode);
    throw itemError(409, "BARCODE_TAKEN", "Another product already uses that barcode.", { field: "barcode", variant });
  }
}

// ── Groups ───────────────────────────────────────────────────────────────────

const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
// What every variant of a group shares, as the group has it now.
const sharedOf = (group) => pick(group, items.SHARED_FIELDS);

// Under the business lock, in one transaction.
function locked(businessId, fn) {
  return prisma.withBusinessLock(businessId, () => prisma.$transaction(fn, TX));
}

// The group a route is about: this owner's, else 404 or 403.
async function findGroup(req, res) {
  const id = req.params.id;
  const group = typeof id === "string" && id.length <= 100 ? await prisma.itemGroup.findUnique({ where: { id } }) : null;
  if (!group) {
    res.status(404).json({ error: "Item group not found", code: "GROUP_NOT_FOUND" });
    return null;
  }
  if (group.userId !== ownerIdOf(req)) {
    res.status(403).json({ error: "Forbidden" });
    return null;
  }
  return group;
}

// The group again, inside the transaction, with its row locked.
async function lockedGroup(px, id) {
  await px.$queryRaw`SELECT "id" FROM "ItemGroup" WHERE "id" = ${id} FOR UPDATE`;
  const group = await px.itemGroup.findUnique({ where: { id } });
  if (!group) throw itemError(404, "GROUP_NOT_FOUND", "Item group not found");
  return group;
}

// No other live group of the business has this name (whatever its
// capitals). 409 GROUP_NAME_TAKEN { field: "name", groupId } otherwise.
async function assertNameFree(px, businessId, name, exceptId = null) {
  const clash = await px.itemGroup.findFirst({
    where: {
      businessId, archivedAt: null, name: { equals: name, mode: "insensitive" },
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
    select: { id: true },
  });
  if (clash) throw itemError(409, "GROUP_NAME_TAKEN", "Another item group already has that name.", { field: "name", groupId: clash.id });
}

// A group's variants in the order of its attributes' options (S before M,
// red before blue), then by name.
function sortVariants(variants, attributes) {
  const attrs = Array.isArray(attributes) ? attributes : [];
  const rank = (v) => attrs.map((a, i) => {
    const at = Array.isArray(v.variantValues) && Array.isArray(a.options) ? a.options.indexOf(v.variantValues[i]) : -1;
    return at < 0 ? MAX_OPTIONS : at;
  });
  return [...variants].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] - rb[i];
    return String(a.name).localeCompare(String(b.name));
  });
}

// { group, items } as the app receives them, read after the write.
async function answer(groupId, canSee) {
  const group = await prisma.itemGroup.findUnique({ where: { id: groupId } });
  if (!group) return { group: null, items: [] };
  const variants = await prisma.inventoryItem.findMany({ where: { groupId } });
  const live = variants.filter((v) => !v.archivedAt).length;
  return {
    group: publicGroup(group, canSee, live),
    items: sortVariants(variants, group.attributes).map((v) => publicItem(v, canSee)),
  };
}

// Adds the variants read by readVariants to a group, inside the caller's
// transaction (utils/items.js createItem: opening stock as POST /inventory).
// Returns what was opened, for the audit.
async function addVariants(px, req, group, variants) {
  const opened = [];
  const shared = sharedOf(group);
  for (const v of variants) {
    const fields = { ...v.fields, ...shared, name: v.fields.name !== undefined ? v.fields.name : autoName(group.name, v.values) };
    const r = await items.createItem(px, {
      businessId: group.businessId,
      ownerId: group.userId,
      fields,
      quantity: v.quantity,
      costPrice: v.costPrice,
      createdBy: { id: req.user.id, name: req.user.name },
      extra: { groupId: group.id, variantValues: v.values, variantKey: v.key },
    });
    if (r.opened || r.costSet) opened.push({ itemId: r.item.id, quantity: v.quantity, costPrice: v.costPrice });
  }
  return opened;
}

function auditGroup(req, action, group, metadata) {
  audit({ req, action, resourceType: "item_group", resourceId: group.id, metadata: { businessId: group.businessId, ...metadata } })
    .catch(() => {});
}

function readClientRef(v) {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string" || !v.trim() || v.length > 80) {
    throw itemError(400, "BAD_CLIENT_REF", "That retry key isn't valid.", { field: "clientRef" });
  }
  return v.trim();
}

// ── Reading ──────────────────────────────────────────────────────────────────

// GET /item-groups?businessId=
// The owner's groups (of one business when named), archived ones too
// (archivedAt), each with variantCount (its variants not archived). The
// variants themselves are items (GET /inventory, the sync bundle).
router.get("/", async (req, res) => {
  try {
    const { businessId } = req.query;
    const where = { userId: ownerIdOf(req) };
    if (businessId) where.businessId = businessId;
    const groups = await prisma.itemGroup.findMany({ where, orderBy: { name: "asc" } });
    const counts = await items.variantCounts(prisma, groups.map((g) => g.id));
    const canSee = canSeeCosts(req);
    res.json(groups.map((g) => publicGroup(g, canSee, counts.get(g.id) || 0)));
  } catch (err) {
    fail(res, err, "fetch the item groups");
  }
});

// GET /item-groups/:id → { group, items }
router.get("/:id", async (req, res) => {
  try {
    const group = await findGroup(req, res);
    if (!group) return;
    res.json(await answer(group.id, canSeeCosts(req)));
  } catch (err) {
    fail(res, err, "fetch the item group");
  }
});

// ── Adding ───────────────────────────────────────────────────────────────────

// POST /item-groups
// { businessId, name, itemType?, unit?, trackInventory?, returnable?,
//   description?, purchaseDescription?, incomeAccountId?, purchaseAccountId?,
//   preferredSupplier?, brand?, manufacturer?, image?, clientRef?,
//   attributes: [{ name, options }], variants: [{ values, name?, price,
//   purchasePrice?, quantity?, costPrice?, lowStockAlert?, barcode?, image?,
//   weight?, ... }] } → 201 { group, items }
// The group and every variant, with their opening stock, are saved together
// or not at all. clientRef makes a retry safe: the same one again answers
// 200 with the group it made.
router.post("/", async (req, res) => {
  const body = req.body || {};
  const isStaff = isStaffReq(req);
  const canSee = canSeeCosts(req);
  let clientRef = null;
  try {
    const { businessId } = body;
    if (blank(businessId)) throw itemError(400, "BUSINESS_REQUIRED", "Choose a business for this item.", { field: "businessId" });
    const owned = typeof businessId === "string"
      ? await prisma.business.findFirst({ where: { id: businessId, userId: ownerIdOf(req) }, select: { id: true } })
      : null;
    if (!owned) return res.status(403).json({ error: "Forbidden" });
    clientRef = readClientRef(body.clientRef);
    const priorOf = async (db) => (clientRef ? db.itemGroup.findFirst({ where: { businessId, clientRef }, select: { id: true } }) : null);
    const before = await priorOf(prisma);
    if (before) return res.status(200).json(await answer(before.id, canSee));

    const sent = items.memberPurchase(items.readItemFields(body, { only: GROUP_FIELDS }), null, { isStaff, canSee });
    if (sent.name === undefined) throw itemError(400, "BAD_NAME", "Give the item a name.", { field: "name" });
    const fields = items.settleFields({ itemType: "goods", unit: "piece", ...sent }, null);
    items.assertUnitFits(fields.itemType, fields.unit);
    const attributes = readAttributes(body.attributes);
    const variants = readVariants(body.variants, attributes, sharedOf(fields), { isStaff, canSee });

    const result = await locked(businessId, async (px) => {
      // A retry that raced the first create finds it here, under the lock.
      const prior = await priorOf(px);
      if (prior) return { prior: prior.id };
      await assertNameFree(px, businessId, fields.name);
      await assertBarcodesFree(px, businessId, variants);
      await items.resolveAccounts(px, businessId, fields, { isStaff });
      const group = await px.itemGroup.create({
        data: {
          ...pick(fields, GROUP_FIELDS),
          attributes,
          businessId,
          userId: ownerIdOf(req),
          clientRef,
          createdById: req.user.id,
        },
      });
      const opened = await addVariants(px, req, group, variants);
      return { group, opened };
    });
    if (result.prior) return res.status(200).json(await answer(result.prior, canSee));
    invalidateLedger(businessId);
    auditGroup(req, "ITEM_GROUP_CREATE", result.group, {
      name: result.group.name, variants: variants.length, opened: result.opened.slice(0, 100),
    });
    res.status(201).json(await answer(result.group.id, canSee));
  } catch (err) {
    if (clientRef && isDuplicate(err, "clientRef")) {
      const prior = await prisma.itemGroup.findFirst({ where: { businessId: body.businessId, clientRef }, select: { id: true } });
      if (prior) return res.status(200).json(await answer(prior.id, canSee));
    }
    fail(res, err, "create the item group");
  }
});

// POST /item-groups/:id/variants { variants: [...] } → 201 { group, items }
// New combinations for a group that is not archived (409 ITEM_ARCHIVED), as
// POST /item-groups takes them; one made already is 409 DUPLICATE_VARIANT.
router.post("/:id/variants", async (req, res) => {
  const body = req.body || {};
  const isStaff = isStaffReq(req);
  const canSee = canSeeCosts(req);
  try {
    const g0 = await findGroup(req, res);
    if (!g0) return;
    const result = await locked(g0.businessId, async (px) => {
      const group = await lockedGroup(px, g0.id);
      if (group.archivedAt) {
        throw itemError(409, "ITEM_ARCHIVED", "This item group is archived. Bring it back before adding variants.", { groupId: group.id });
      }
      const made = await px.inventoryItem.findMany({ where: { groupId: group.id }, select: { variantKey: true } });
      const variants = readVariants(body.variants, group.attributes, sharedOf(group), {
        isStaff, canSee, existing: new Set(made.map((m) => m.variantKey)), room: Math.max(0, MAX_VARIANTS - made.length),
      });
      await assertBarcodesFree(px, group.businessId, variants);
      const opened = await addVariants(px, req, group, variants);
      await px.itemGroup.update({ where: { id: group.id }, data: { updatedAt: new Date() } });
      return { group, added: variants.length, opened };
    });
    invalidateLedger(g0.businessId);
    auditGroup(req, "ITEM_GROUP_UPDATE", result.group, { added: result.added, opened: result.opened.slice(0, 100) });
    res.status(201).json(await answer(g0.id, canSee));
  } catch (err) {
    fail(res, err, "add the variants");
  }
});

// ── Changing ─────────────────────────────────────────────────────────────────

// PATCH /item-groups/:id
// { name?, image?, itemType?, unit?, trackInventory?, returnable?,
//   description?, purchaseDescription?, incomeAccountId?, purchaseAccountId?,
//   preferredSupplier?, brand?, manufacturer?, attributes? } → { group, items }
// The shared fields go to every variant in the same transaction. itemType
// and trackInventory change only while no variant is used (409 TYPE_FIXED,
// TRACKING_FIXED). A new name renames the variants that still carry the
// automatic one. attributes: the whole list again, only grown (see
// mergeAttributes). The purchase information is the owner's, as on an item,
// and so is whether the goods' stock is counted, and a change of type that
// would drop a variant's cost of one unit or the group's purchase account
// (403 OWNER_ONLY for a member); what an owner's change drops is in its
// audit row.
router.patch("/:id", async (req, res) => {
  const body = req.body || {};
  const isStaff = isStaffReq(req);
  const canSee = canSeeCosts(req);
  try {
    const g0 = await findGroup(req, res);
    if (!g0) return;
    const sent = items.readItemFields(body, { only: GROUP_FIELDS, keepImage: g0.image });
    const sentAttributes = body.attributes === undefined ? null : readAttributes(body.attributes);
    const result = await locked(g0.businessId, async (px) => {
      const cur = await lockedGroup(px, g0.id);
      const variants = await px.inventoryItem.findMany({ where: { groupId: cur.id } });
      const fields = items.settleFields(items.memberPurchase(sent, cur, { isStaff, canSee }), cur);
      const itemType = fields.itemType !== undefined ? fields.itemType : cur.itemType;
      const counts = fields.trackInventory !== undefined ? fields.trackInventory : cur.trackInventory;
      const dropped = {};
      if (itemType !== cur.itemType || counts !== cur.trackInventory) {
        if (isStaff && itemType === "goods" && cur.itemType === "goods") {
          throw itemError(403, "OWNER_ONLY", "Only the business owner can change whether these items' stock is counted.");
        }
        for (const v of variants) {
          if (!(await items.isItemUsed(px, v))) continue;
          if (itemType !== cur.itemType) {
            throw itemError(409, "TYPE_FIXED", "A variant has been used, so these stay goods or a service as they are.", { itemId: v.id });
          }
          throw itemError(409, "TRACKING_FIXED", "A variant has been used, so whether their stock is counted stays as it is.", { itemId: v.id });
        }
        // What the change drops of the owner's: the variants' cost of one
        // unit (goods whose stock is not counted have none) and the group's
        // purchase account (counted goods keep none).
        const costs = itemType === "goods" && !counts
          ? variants.filter((v) => v.avgCost != null).map((v) => ({ itemId: v.id, avgCost: v.avgCost }))
          : [];
        if (costs.length) dropped.avgCosts = costs;
        if (cur.purchaseAccountId && fields.purchaseAccountId === null) dropped.purchaseAccountId = cur.purchaseAccountId;
        if (isStaff && Object.keys(dropped).length) {
          throw itemError(403, "OWNER_ONLY", "Only the business owner can change these items' type, as it would drop the owner's costs or purchase account.");
        }
      }
      items.assertUnitFits(itemType, fields.unit !== undefined ? fields.unit : cur.unit);
      if (fields.name !== undefined && fields.name !== cur.name) await assertNameFree(px, cur.businessId, fields.name, cur.id);
      await items.resolveAccounts(px, cur.businessId, fields, { isStaff, cur });
      const data = pick(fields, GROUP_FIELDS);
      if (sentAttributes) data.attributes = mergeAttributes(cur.attributes, sentAttributes, variants);
      const group = await px.itemGroup.update({ where: { id: cur.id }, data: { ...data, updatedAt: new Date() } });

      // The shared fields, to every variant. Goods whose stock is no longer
      // counted keep no cost of one unit (they are unused, so they hold no
      // stock); nothing uncounted is alerted for low stock.
      const shared = pick(fields, items.SHARED_FIELDS);
      if (Object.keys(shared).length) {
        const vdata = { ...shared };
        if (group.itemType === "goods" && !group.trackInventory) vdata.avgCost = null;
        if (!group.trackInventory) vdata.lowStockNotifiedAt = null;
        await px.inventoryItem.updateMany({ where: { groupId: group.id }, data: vdata });
      }
      if (group.name !== cur.name) {
        for (const v of variants) {
          if (v.name === autoName(cur.name, v.variantValues)) {
            await px.inventoryItem.update({ where: { id: v.id }, data: { name: autoName(group.name, v.variantValues) } });
          }
        }
      }
      return { group, changed: [...Object.keys(data)], dropped };
    });
    invalidateLedger(g0.businessId);
    auditGroup(req, "ITEM_GROUP_UPDATE", result.group, {
      fields: result.changed, byStaff: isStaff, ...(Object.keys(result.dropped).length ? { dropped: result.dropped } : {}),
    });
    res.json(await answer(g0.id, canSee));
  } catch (err) {
    fail(res, err, "update the item group");
  }
});

// POST /item-groups/:id/archive and /unarchive (owner only) → { group, items }
// The group and all its variants together: archived ones leave the lists and
// pickers, their history and stock value stay. Bringing a group back brings
// every variant back, unless another live group has its name now (409
// GROUP_NAME_TAKEN).
for (const [path, archived] of [["archive", true], ["unarchive", false]]) {
  router.post(`/:id/${path}`, ownerOnly(), async (req, res) => {
    try {
      const g0 = await findGroup(req, res);
      if (!g0) return;
      const group = await locked(g0.businessId, async (px) => {
        const cur = await lockedGroup(px, g0.id);
        if (!archived && cur.archivedAt) await assertNameFree(px, cur.businessId, cur.name, cur.id);
        const when = new Date();
        await px.inventoryItem.updateMany({
          where: { groupId: cur.id, archivedAt: archived ? null : { not: null } },
          data: { archivedAt: archived ? when : null },
        });
        return px.itemGroup.update({ where: { id: cur.id }, data: { archivedAt: archived ? cur.archivedAt || when : null } });
      });
      invalidateLedger(group.businessId);
      auditGroup(req, "ITEM_GROUP_ARCHIVE", group, { archived });
      res.json(await answer(group.id, true));
    } catch (err) {
      fail(res, err, `${path} the item group`);
    }
  });
}

// ── Deleting ─────────────────────────────────────────────────────────────────

// DELETE /item-groups/:id (owner only)
// Only when every variant could be deleted on its own: no stock movement and
// no bill line names any (sale and invoice lines keep their names). Then the
// group and all its variants go in one transaction; otherwise 409
// ITEM_HAS_HISTORY { itemId }, and the app offers to archive the group.
router.delete("/:id", ownerOnly(), async (req, res) => {
  try {
    const g0 = await findGroup(req, res);
    if (!g0) return;
    const itemIds = await locked(g0.businessId, async (px) => {
      const cur = await lockedGroup(px, g0.id);
      const variants = await px.inventoryItem.findMany({ where: { groupId: cur.id }, select: { id: true } });
      const ids = variants.map((v) => v.id);
      if (ids.length) {
        await px.$queryRaw`SELECT "id" FROM "InventoryItem" WHERE "id" = ANY(${ids}::text[]) ORDER BY "id" FOR UPDATE`;
        const [moved, billed] = await Promise.all([
          px.stockMovement.findFirst({ where: { itemId: { in: ids } }, select: { itemId: true } }),
          px.billItem.findFirst({ where: { itemId: { in: ids } }, select: { itemId: true } }),
        ]);
        const used = moved || billed;
        if (used) {
          throw itemError(409, "ITEM_HAS_HISTORY", "A variant has stock history. Archive the item group instead.", { itemId: used.itemId, groupId: cur.id });
        }
        await px.inventoryItem.deleteMany({ where: { id: { in: ids } } });
      }
      await px.itemGroup.delete({ where: { id: cur.id } });
      return ids;
    });
    invalidateLedger(g0.businessId);
    auditGroup(req, "ITEM_GROUP_DELETE", g0, { name: g0.name, itemIds: itemIds.slice(0, 100) });
    res.json({ message: "Deleted", groupId: g0.id, itemIds });
  } catch (err) {
    fail(res, err, "delete the item group");
  }
});

module.exports = router;
