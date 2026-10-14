const router = require("express").Router();
const { randomUUID } = require("crypto");
const auth = require("../middleware/auth");
const prisma = require("../utils/db");
const chart = require("../utils/chart");
const stock = require("../utils/stock");
const { validateSale, validateIdParam } = require("../middleware/validate");
const { normalizeChannel } = require("../utils/salesChannel");
const { assertAccountUsable, accountsFor, invalidateLedger } = require("../utils/ledgerData");
const { assertUnlocked, assertUnlockedIn } = require("../utils/booksLock");
const { twoDecimals, toKobo } = require("../utils/money");
const { canSeeCosts, publicItem } = require("./inventory").itemView;

router.use(auth);

// ── Sale lines (chart of accounts release 3, 2026-10-13) ────────────────────
//
// A sale may say what was sold, line by line: { items: [{ itemId?, name?,
// quantity, rate, amount?, accountId? }] }, 1 to 100 lines. A line names an
// item (goods or a service) or is typed in (no item: itemType other, a name
// of its own). Goods leave the stock as they are sold (utils/stock.js takeOut,
// one movement per line, sourceKey "sale:<saleItemId>"), at the average cost
// at that moment, which the line keeps (unitCost, costAmount); a service and
// a typed line move no stock and carry no cost. Each line counts as the income
// account sent with it, else its item's (chart.incomeForItem: the item's own
// account, Service Income for a service, Sales otherwise). The sale's amount
// stays what the app sends (a discount or rounding can make it differ from
// the lines'), and the sale's own accountId is not used: its lines carry the
// accounts. Lines are fixed once saved: deleting the sale puts the goods back
// (utils/stock.js removeBySource), and the sale is recorded again.
//
// What goods cost is the reports' figure: a member without canViewReports gets
// unitCost null, costAmount 0 and costKnown null on every line.
//
// Goods whose stock is not counted (items like Zoho, 2026-10-14:
// trackInventory off) are sold like a service: they take no stock, are never
// refused for stock and carry no cost, and their line says so (tracked
// false). Whether an item's stock is counted never changes once a line names
// it, so the line's copy is always the item's.

const MAX_SALE_ITEMS = 100;
const MAX_LINE_NAME = 200;
const SALE_ITEMS_INCLUDE = { items: { orderBy: [{ position: "asc" }, { id: "asc" }] } };

// A refusal about the lines: field "items", and the line (0-based) when it is
// about one.
function lineError(status, code, message, line, extra = {}) {
  const err = Object.assign(new Error(message), { status, code, field: "items" });
  err.extra = Number.isInteger(line) ? { line, ...extra } : { ...extra };
  return err;
}

const blank = (v) => v === undefined || v === null || v === "";

// A number sent as a number or as text ("2.5"); NaN otherwise.
function num(v) {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim()) return Number(v);
  return NaN;
}

// One line as sent, checked for shape only (the items and accounts are looked
// up once every line has passed this).
function readSaleLine(raw, i) {
  const bad = (code, message) => lineError(400, code, message, i);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw bad("BAD_ITEMS", "Each line needs a quantity and a price.");
  // Ids are plain strings (middleware/idGuard.js guards only the top level).
  if (!blank(raw.itemId) && typeof raw.itemId !== "string") throw bad("BAD_ITEMS", "A line names its item by the item's id.");
  if (!blank(raw.accountId) && typeof raw.accountId !== "string") throw bad("BAD_ITEMS", "A line names its account by the account's id.");
  if (!blank(raw.name) && typeof raw.name !== "string") throw bad("BAD_ITEMS", "A line's name is text.");
  const itemId = blank(raw.itemId) ? null : raw.itemId;
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (name.length > MAX_LINE_NAME) throw bad("ITEM_NAME_TOO_LONG", `A line's name can be at most ${MAX_LINE_NAME} characters.`);
  if (!itemId && !name) throw bad("ITEM_NAME_REQUIRED", "Name what was sold on every line.");
  const quantity = num(raw.quantity);
  if (!stock.validQuantity(quantity)) throw bad("BAD_QUANTITY", "Enter a quantity more than 0, with at most three decimals.");
  const rate = num(raw.rate);
  if (!Number.isFinite(rate) || rate < 0 || rate > 1e13 || !twoDecimals(rate)) {
    throw bad("BAD_RATE", "Enter a price of 0 or more on every line, in naira and kobo.");
  }
  let amount;
  if (blank(raw.amount)) amount = stock.lineCost(quantity, rate);
  else {
    amount = num(raw.amount);
    if (!Number.isFinite(amount) || amount < 0 || amount > 1e13 || !twoDecimals(amount)) {
      throw bad("BAD_ITEM_AMOUNT", "Enter an amount of 0 or more on every line, in naira and kobo.");
    }
    amount = toKobo(amount) / 100;
  }
  return {
    itemId,
    accountId: blank(raw.accountId) ? null : raw.accountId,
    name,
    quantity,
    rate: toKobo(rate) / 100,
    amount,
    position: i,
  };
}

// The lines a request sends: null when none (absent, null or an empty list),
// else every line read (readSaleLine). Refuses a list of more than 100.
function readSaleItems(raw) {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) throw lineError(400, "BAD_ITEMS", "Send the lines as a list.");
  if (!raw.length) return null;
  if (raw.length > MAX_SALE_ITEMS) {
    throw lineError(400, "TOO_MANY_ITEMS", `A sale can have at most ${MAX_SALE_ITEMS} lines.`, undefined, { max: MAX_SALE_ITEMS });
  }
  return raw.map(readSaleLine);
}

// The business's chart, for the account each line counts as. Read under the
// business lock before the sale's transaction: accountsFor adds a system
// account a chart lacks, on its own connection.
async function saleChart(businessId) {
  return chart.indexChart(await accountsFor(businessId));
}

// Saves the lines of a sale just created in this transaction (px), under the
// business lock: each item this business's and not archived, each account an
// income account a sale may use (a member's refused on the owner's), goods
// taken out of stock (409 NOT_ENOUGH_STOCK { itemId, available, line } when
// there are not enough). Returns { items: the lines saved, inventory: the
// goods items as they now are }.
async function writeSaleItems(px, { sale, lines, chartIdx, isStaff, createdById }) {
  const items = [];
  const touched = new Map();
  for (const line of lines) {
    let item = null;
    if (line.itemId) {
      item = await px.inventoryItem.findFirst({ where: { id: line.itemId, businessId: sale.businessId } });
      if (!item) throw lineError(404, "ITEM_NOT_FOUND", "That item isn't in this business.", line.position, { itemId: line.itemId });
      if (item.archivedAt) {
        throw lineError(409, "ITEM_ARCHIVED", "That item is archived. Bring it back before selling it.", line.position, { itemId: item.id });
      }
    }
    const account = line.accountId
      ? await assertAccountUsable(sale.businessId, line.accountId, "income", { isStaff, field: "items", line: line.position }, px)
      : chart.incomeForItem(chartIdx, item);
    const id = randomUUID();
    let unitCost = null;
    let costAmount = 0;
    const goods = !!item && item.itemType === "goods";
    const tracked = !goods || item.trackInventory !== false;
    if (goods && tracked) {
      try {
        const out = await stock.takeOut(px, {
          businessId: sale.businessId, itemId: item.id, quantity: line.quantity, date: sale.date,
          sourceKey: `sale:${id}`, kind: "sale", createdById,
        });
        unitCost = out.unitCost;
        costAmount = out.costAmount;
        touched.set(item.id, out.item);
      } catch (e) {
        if (e && e.status) {
          e.field = "items";
          e.extra = { ...(e.extra || {}), line: line.position };
        }
        throw e;
      }
    }
    items.push(await px.saleItem.create({
      data: {
        id,
        saleId: sale.id,
        businessId: sale.businessId,
        itemId: item ? item.id : null,
        // The item's name as it is today: the line keeps it if the item is
        // renamed or deleted.
        name: item ? item.name : line.name,
        itemType: item ? item.itemType : "other",
        quantity: line.quantity,
        rate: line.rate,
        amount: line.amount,
        accountId: account ? account.id : null,
        unitCost,
        costAmount,
        tracked,
        position: line.position,
      },
    }));
  }
  return { items, inventory: [...touched.values()] };
}

// Puts back the goods a sale's lines took (inside the caller's transaction,
// under the business lock), before the sale is deleted. Returns the items as
// they now are.
async function removeSaleStock(px, businessId, saleId) {
  if (!businessId) return [];
  const lines = await px.saleItem.findMany({ where: { saleId }, select: { id: true } });
  if (!lines.length) return [];
  const { items } = await stock.removeBySource(px, businessId, lines.map((l) => `sale:${l.id}`));
  return items;
}

// A line as the app receives it. costKnown: for counted goods, whether a
// cost was known when they left (false: no cost price yet, sold at no cost);
// null for goods whose stock is not counted, a service or a typed line, and
// for a member without the reports. tracked: false only for goods whose stock
// is not counted.
function publicSaleItem(l, canSee) {
  const tracked = l.tracked !== false;
  const goods = l.itemType === "goods" && tracked;
  return {
    id: l.id,
    saleId: l.saleId,
    itemId: l.itemId,
    name: l.name,
    itemType: l.itemType,
    quantity: l.quantity,
    rate: l.rate,
    amount: l.amount,
    accountId: l.accountId,
    position: l.position,
    unitCost: canSee ? l.unitCost : null,
    costAmount: canSee ? l.costAmount : 0,
    costKnown: canSee && goods ? l.unitCost !== null : null,
    tracked,
  };
}

// A sale with its lines ([] for a sale without), costs as the caller may see.
function publicSale(sale, canSee, items = sale.items) {
  const lines = [...(items || [])].sort((a, b) => a.position - b.position);
  return { ...sale, items: lines.map((l) => publicSaleItem(l, canSee)) };
}

// The counted goods items a sale's lines name, as they are now (a retried
// create answers with them).
async function itemsOfLines(lines) {
  const ids = [...new Set((lines || []).filter((l) => l.itemType === "goods" && l.tracked !== false && l.itemId).map((l) => l.itemId))];
  return ids.length ? prisma.inventoryItem.findMany({ where: { id: { in: ids } } }) : [];
}

// Helper to resolve the correct business owner ID
const getTargetUserId = (req) =>
  req.user.accountType === "staff" ? req.user.employerId : req.user.id;

// A refusal as the app reads it: { error, code }, plus the field it is about
// when it names one (an account the sale names is refused as accountId or
// depositAccountId: utils/ledgerData.js accountError), and anything else it
// carries for the app, such as a line (`extra`).
function sendRefusal(res, err) {
  return res.status(err.status).json({
    error: err.message,
    code: err.code,
    ...(err.field ? { field: err.field } : {}),
    ...(err.extra || {}),
  });
}

// Customer.totalOwed is the cached sum of what their unpaid debts still owe.
async function refreshTotalOwed(px, customerId) {
  const debts = await px.debt.findMany({ where: { customerId }, select: { amount: true, paidAmount: true } });
  const owed = debts.reduce((s, d) => s + Math.max(0, d.amount - d.paidAmount), 0);
  await px.customer.update({ where: { id: customerId }, data: { totalOwed: Math.round(owed * 100) / 100 } });
}

// GET /sales?from=&to=&limit=&businessId=
router.get("/", async (req, res) => {
  try {
    const { from, to, limit = 200, businessId, since } = req.query;
    const where = { userId: getTargetUserId(req) };
    if (businessId) where.businessId = businessId;
    if (since) {
      where.updatedAt = { gt: new Date(since) };
    } else if (from || to) {
      where.date = {};
      if (from) where.date.gte = new Date(from);
      if (to) where.date.lte = new Date(to);
    }
    const sales = await prisma.sales.findMany({
      where,
      include: SALE_ITEMS_INCLUDE,
      orderBy: since ? { updatedAt: "asc" } : { date: "desc" },
      take: since ? undefined : Math.min(1000, Math.max(1, Number(limit) || 200)),
    });
    const canSee = canSeeCosts(req);
    res.json(sales.map((s) => publicSale(s, canSee)));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch sales" });
  }
});

// GET /sales/by-channel?businessId=&from=&to=
// Sales totals grouped by channel — powers the "Sales by channel" breakdown.
router.get("/by-channel", async (req, res) => {
  try {
    const { businessId, from, to } = req.query;
    const where = { userId: getTargetUserId(req) };
    if (businessId) where.businessId = businessId;
    if (from || to) {
      where.date = {};
      if (from) where.date.gte = new Date(from);
      if (to) where.date.lte = new Date(to);
    }
    const rows = await prisma.sales.groupBy({
      by: ["channel"],
      where,
      _sum: { amount: true },
      _count: { _all: true },
    });
    const result = rows
      .map((r) => ({
        channel: r.channel || "unspecified",
        total: r._sum.amount || 0,
        count: r._count._all,
      }))
      .sort((a, b) => b.total - a.total);
    res.json(result);
  } catch (err) {
    console.error("[sales/by-channel]", err);
    res.status(500).json({ error: "Failed to aggregate sales by channel" });
  }
});

// POST /sales
// { amount, businessId, paymentMethod?, isCredit?, customerId?, notes?, date?,
//   channel?, accountId?, depositAccountId?, clientRef?, items? }
// With items (release 3, see the lines above), the sale, its lines and the
// stock they take are saved together or not at all, under the business lock:
// two phones selling the last unit, one gets 409 NOT_ENOUGH_STOCK. Answers
// 201 { ...sale, items, debt, inventory: [the goods items as they now are] }.
router.post("/", validateSale, async (req, res) => {
  const {
    customerId,
    amount,
    paymentMethod = "cash",
    isCredit = false,
    notes,
    date,
    businessId,
    channel,
    accountId,
    depositAccountId,
    clientRef,
  } = req.body;
  if (!amount) return res.status(400).json({ error: "amount required" });
  const ref = clientRef ? String(clientRef).slice(0, 80) : null;
  const canSee = canSeeCosts(req);
  // The first sale a retried create saved, as it was answered then.
  const priorAnswer = async (prior) => {
    const lines = await prisma.saleItem.findMany({ where: { saleId: prior.id }, orderBy: [{ position: "asc" }, { id: "asc" }] });
    const inventory = await itemsOfLines(lines);
    return { ...publicSale(prior, canSee, lines), debt: null, inventory: inventory.map((i) => publicItem(i, canSee)) };
  };

  try {
    if (businessId) {
      const owned = await prisma.business.findFirst({
        where: { id: businessId, userId: getTargetUserId(req) },
      });
      if (!owned) return res.status(403).json({ error: "Forbidden" });
    }
    // Every line read before anything is looked up. Lines need a business:
    // their stock and accounts are its.
    const lines = readSaleItems(req.body.items);
    if (lines && !businessId) {
      throw lineError(400, "BUSINESS_REQUIRED", "Choose a business before adding what was sold.");
    }

    // A create the app retried (the first one timed out after it was saved)
    // gets the first one back instead of a second sale.
    if (businessId && ref) {
      const prior = await prisma.sales.findFirst({ where: { businessId, clientRef: ref } });
      if (prior) return res.status(200).json(await priorAnswer(prior));
    }
    const isStaff = req.user.accountType === "staff";
    const ownerId = getTargetUserId(req);
    const when = date ? new Date(date) : new Date();
    // Checked and saved under the business lock, which an account merge or
    // delete also takes (routes/ledger.js), so every account checked here is
    // still there when the sale is saved with it (as POST /expenses does).
    const lockedForBusiness = (fn) => (businessId ? prisma.withBusinessLock(businessId, fn) : fn());
    const { sale, items, inventory, debt } = await lockedForBusiness(async () => {
      // The lock date (utils/booksLock.js): nothing dated on or before it is
      // added. Asked under the lock it is set under. The goods a sale takes
      // leave the stock on the sale's day, so this covers them too.
      await assertUnlocked(businessId || null, when);
      // The chart of accounts: what the sale counts as (an income account, Sales
      // when none) and where the money went (by payment method when none). A
      // refusal names the field, so the app knows which of the two to leave out.
      // A sale with lines counts as its lines' accounts: its own is not used.
      const account = businessId && !lines
        ? await assertAccountUsable(businessId, accountId, "income", { isStaff, field: "accountId" })
        : null;
      const deposit = businessId
        ? await assertAccountUsable(businessId, depositAccountId, "money", { isStaff, field: "depositAccountId" })
        : null;
      const chartIdx = lines ? await saleChart(businessId) : null;

      // Sold on credit to a known customer: open that customer's debt for it in
      // the same transaction. Books rule: the sale then counts when the customer
      // pays (through the debt's payments), not on the day it was recorded.
      // Every customer belongs to one business (release 2), whose books count
      // their debts, so the customer must be this sale's business's: another
      // business's would carry the debt into its books, and one with no
      // business (its business was deleted) into none. A sale with no business
      // opens no debt.
      const creditCustomer =
        isCredit && customerId && businessId
          ? await prisma.customer.findFirst({
              where: { id: String(customerId), userId: ownerId, businessId },
              select: { id: true },
            })
          : null;

      return prisma.$transaction(async (px) => {
        const sale = await px.sales.create({
          data: {
            userId: ownerId,
            businessId: businessId || null,
            customerId: customerId || null,
            amount: Number(amount),
            paymentMethod,
            isCredit,
            notes: notes || null,
            channel: normalizeChannel(channel),
            date: when,
            recordedBy: req.user.id,
            recordedByName: req.user.name,
            accountId: account ? account.id : null,
            depositAccountId: deposit ? deposit.id : null,
            clientRef: ref,
          },
        });
        const written = lines
          ? await writeSaleItems(px, { sale, lines, chartIdx, isStaff, createdById: req.user.id })
          : { items: [], inventory: [] };
        if (!creditCustomer) return { sale, ...written, debt: null };
        const debt = await px.debt.create({
          data: {
            customerId: creditCustomer.id,
            amount: Number(amount),
            note: notes || "",
            date: sale.date,
            saleId: sale.id,
          },
          include: { payments: true },
        });
        await refreshTotalOwed(px, creditCustomer.id);
        return { sale, ...written, debt };
      }, { timeout: 20000 });
    });
    if (businessId) invalidateLedger(businessId);
    res.status(201).json({
      ...publicSale(sale, canSee, items),
      debt,
      inventory: inventory.map((i) => publicItem(i, canSee)),
    });
  } catch (err) {
    if (err?.code === "P2002" && ref && businessId) {
      const prior = await prisma.sales.findFirst({ where: { businessId, clientRef: ref } });
      if (prior) return res.status(200).json(await priorAnswer(prior));
    }
    if (err && err.status) return sendRefusal(res, err);
    console.error(err);
    res.status(500).json({ error: "Failed to create sale" });
  }
});

// PATCH /sales/:id
// A sale's lines are fixed once saved (400 ITEMS_FIXED when items are sent):
// delete the sale, which puts its goods back, and record it again. The
// amount, notes, date, payment and customer stay editable. A sale with lines
// counts as its lines' accounts, so an accountId sent for one is not used.
// Answers the sale with its lines.
router.patch("/:id", validateIdParam, async (req, res) => {
  if (req.user.accountType === "staff")
    return res.status(403).json({ error: "Staff cannot edit sales" });
  try {
    const sale0 = await prisma.sales.findUnique({ where: { id: req.params.id } });
    if (!sale0) return res.status(404).json({ error: "Sale not found" });
    if (sale0.userId !== req.user.id) return res.status(403).json({ error: "Forbidden" });
    if (req.body.items !== undefined) {
      return res.status(400).json({
        error: "What was sold can't be changed. Delete the sale and record it again.",
        code: "ITEMS_FIXED",
        field: "items",
      });
    }
    const { amount, notes, paymentMethod, date, channel, depositAccountId } = req.body;
    // Lines never change, so whether the sale has any is known here.
    const itemized = (await prisma.saleItem.count({ where: { saleId: sale0.id } })) > 0;
    const accountId = itemized ? undefined : req.body.accountId;
    if (amount !== undefined && !(Number(amount) > 0)) {
      return res.status(400).json({ error: "Enter an amount.", code: "BAD_AMOUNT" });
    }
    // Books rule: a sale on credit with a customer has a debt that counts it
    // when paid. Changing the amount, the date or credit <-> paid keeps the
    // two in step; the paid part of a credit sale is fixed. A sale matched to
    // a bank transfer keeps the transfer's matchedAmount in step too. All of
    // it under the business lock, re-read inside. The accounts are checked
    // under the lock too: an account merge or delete (routes/ledger.js) takes
    // it, so an account checked here is still there when the sale is saved.
    const updated = await prisma.withBusinessLock(sale0.businessId || sale0.userId, async () => {
      const account = accountId !== undefined && sale0.businessId
        ? await assertAccountUsable(sale0.businessId, accountId, "income", { field: "accountId" }) : undefined;
      const deposit = depositAccountId !== undefined && sale0.businessId
        ? await assertAccountUsable(sale0.businessId, depositAccountId, "money", { field: "depositAccountId" }) : undefined;
      return prisma.$transaction(async (px) => {
        const sale = await px.sales.findUnique({ where: { id: sale0.id } });
        if (!sale) throw Object.assign(new Error("Sale not found"), { status: 404, code: "SALE_NOT_FOUND" });
        const debt = await px.debt.findFirst({ where: { saleId: sale.id } });
        // The lock date: the sale's day before and after the edit, its debt's,
        // and, when the amount changes, the day of the transfer it is matched
        // to (whose part left unexplained changes with it).
        const matched = sale.matchedTransactionId && amount !== undefined
          ? await px.transaction.findUnique({ where: { id: sale.matchedTransactionId }, select: { date: true } })
          : null;
        await assertUnlockedIn(
          px, sale.businessId, sale.date, date !== undefined ? new Date(date) : null,
          debt ? debt.date : null, matched ? matched.date : null,
        );
        const newAmount = amount !== undefined ? Number(amount) : Number(sale.amount);
        const toCredit = paymentMethod !== undefined ? paymentMethod === "credit" : !!sale.isCredit;
        if (debt && debt.paidAmount > 0 && (newAmount !== Number(sale.amount) || !toCredit)) {
          throw Object.assign(new Error("The customer has paid part of this credit sale. Its amount is fixed."), {
            status: 409, code: "CREDIT_SALE_PAID",
          });
        }
        if (toCredit && !sale.isCredit && sale.matchedTransactionId) {
          throw Object.assign(new Error("This sale was paid by a bank transfer, so it can't be on credit."), {
            status: 409, code: "SALE_MATCHED",
          });
        }
        const row = await px.sales.update({
          where: { id: sale.id },
          data: {
            ...(amount !== undefined && { amount: newAmount }),
            ...(notes !== undefined && { notes }),
            ...(paymentMethod !== undefined && { paymentMethod, isCredit: toCredit }),
            ...(date !== undefined && { date: new Date(date) }),
            ...(channel !== undefined && { channel: normalizeChannel(channel) }),
            ...(account !== undefined && { accountId: account ? account.id : null }),
            ...(deposit !== undefined && { depositAccountId: deposit ? deposit.id : null }),
          },
        });
        if (debt && !toCredit) {
          // Paid after all (nothing was repaid yet): the debt goes.
          await px.debt.delete({ where: { id: debt.id } });
          await refreshTotalOwed(px, debt.customerId);
        } else if (debt && (amount !== undefined || date !== undefined)) {
          await px.debt.update({
            where: { id: debt.id },
            data: {
              ...(amount !== undefined && { amount: newAmount, paid: debt.paidAmount >= newAmount }),
              ...(date !== undefined && { date: new Date(date) }),
            },
          });
          await refreshTotalOwed(px, debt.customerId);
        } else if (
          !debt && toCredit && !sale.isCredit && sale.customerId && sale.businessId &&
          // Only this business's own customer, as when the sale is created
          // on credit.
          (await px.customer.count({
            where: { id: sale.customerId, userId: sale.userId, businessId: sale.businessId },
          }))
        ) {
          // Now on credit: open the customer's debt for it.
          await px.debt.create({
            data: { customerId: sale.customerId, amount: newAmount, note: sale.notes || "", date: row.date, saleId: sale.id },
          });
          await refreshTotalOwed(px, sale.customerId);
        }
        if (sale.matchedTransactionId && amount !== undefined) {
          const tx = await px.transaction.findUnique({ where: { id: sale.matchedTransactionId } });
          if (tx && tx.matchedSaleId === sale.id) {
            await px.transaction.update({
              where: { id: tx.id },
              data: { matchedAmount: Math.min(newAmount, Number(tx.amount) || 0) },
            });
          }
        }
        const items = await px.saleItem.findMany({ where: { saleId: sale.id } });
        // The goods left the stock on the sale's day: a new day moves their
        // movements with it, so the stock on any day stays what the books
        // count (utils/ledger.js posts their cost on the sale's day).
        if (date !== undefined && items.length && sale.businessId) {
          await px.stockMovement.updateMany({
            where: { businessId: sale.businessId, sourceKey: { in: items.map((l) => `sale:${l.id}`) } },
            data: { date: row.date },
          });
        }
        return { ...row, items };
      });
    });
    if (sale0.businessId) invalidateLedger(sale0.businessId);
    res.json(publicSale(updated, canSeeCosts(req)));
  } catch (err) {
    if (err.status) return sendRefusal(res, err);
    console.error(err);
    res.status(500).json({ error: "Failed to update sale" });
  }
});

// DELETE /sales/:id
router.delete("/:id", validateIdParam, async (req, res) => {
  if (req.user.accountType === "staff") {
    return res.status(403).json({ error: "Staff cannot delete sales" });
  }

  try {
    const sale = await prisma.sales.findUnique({ where: { id: req.params.id } });
    if (!sale) return res.status(404).json({ error: "Sale not found" });
    if (sale.userId !== req.user.id)
      return res.status(403).json({ error: "Forbidden" });

    // A credit sale and its debt go together. Once the customer has paid some
    // of it, those payments are counted sales, so the sale stays. A sale that
    // a bank transfer was matched to frees that transfer, which then counts on
    // its own again (instead of pointing at a sale that no longer exists).
    // The goods its lines took go back into stock, as if never sold
    // (release 3); the answer carries those items as they now are.
    let debtId = null;
    let inventory = [];
    await prisma.withBusinessLock(sale.businessId || sale.userId, () =>
      prisma.$transaction(async (px) => {
        const fresh = await px.sales.findUnique({ where: { id: sale.id } });
        if (!fresh) return;
        const debt = await px.debt.findFirst({ where: { saleId: fresh.id } });
        // The lock date: the sale's day, its debt's, and the day of a transfer
        // it frees (which counts on its own again).
        const matched = fresh.matchedTransactionId
          ? await px.transaction.findUnique({ where: { id: fresh.matchedTransactionId }, select: { date: true, matchedSaleId: true } })
          : null;
        await assertUnlockedIn(
          px, fresh.businessId, fresh.date, debt ? debt.date : null,
          matched && matched.matchedSaleId === fresh.id ? matched.date : null,
        );
        if (debt && debt.paidAmount > 0) {
          throw Object.assign(new Error("The customer has paid part of this credit sale, so it can't be deleted."), {
            status: 409, code: "CREDIT_SALE_PAID",
          });
        }
        if (debt) {
          debtId = debt.id;
          await px.debt.delete({ where: { id: debt.id } });
          await refreshTotalOwed(px, debt.customerId);
        }
        if (fresh.matchedTransactionId) {
          const tx = await px.transaction.findUnique({ where: { id: fresh.matchedTransactionId } });
          if (tx && tx.matchedSaleId === fresh.id) {
            await px.transaction.update({ where: { id: tx.id }, data: { matchedSaleId: null, matchedAmount: null } });
          }
        }
        inventory = await removeSaleStock(px, fresh.businessId, fresh.id);
        await px.sales.delete({ where: { id: fresh.id } });
      }, { timeout: 20000 }),
    );
    if (sale.businessId) invalidateLedger(sale.businessId);
    const canSee = canSeeCosts(req);
    res.json({ message: "Deleted", debtId, inventory: inventory.map((i) => publicItem(i, canSee)) });
  } catch (err) {
    if (err.status) return sendRefusal(res, err);
    console.error(err);
    res.status(500).json({ error: "Failed to delete sale" });
  }
});

module.exports = router;
// The sale lines, for the other doors that record or show a sale
// (routes/transactions.js create-sale and unmatch, routes/sync.js).
module.exports.saleLines = {
  MAX_SALE_ITEMS,
  SALE_ITEMS_INCLUDE,
  readSaleItems,
  saleChart,
  writeSaleItems,
  removeSaleStock,
  publicSale,
  publicSaleItem,
};
