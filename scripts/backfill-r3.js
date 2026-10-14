// Release 3 of the chart of accounts (2026-10-13): the stock counted before
// stock had a cost. Run it at deploy after the migration
// 20261013200000_stock_cost (on the primary, and on the standby once it is
// migrated), straight after the release 3 server is live and before the app
// update goes out. Idempotent: a second run finds nothing to change.
//
//   1. Every item is goods. The migration made each existing item goods (the
//      itemType column's default), so nothing is written for it; an item the
//      owner has made a service since keeps that, and is passed over.
//   2. Goods with stock on record that no stock movement explains (all of it,
//      for an item from before release 3) get ONE opening movement,
//      "open:<itemId>:1", dated today in Lagos, for that quantity. Its value is
//      the quantity at the item's old cost price, to the kobo (stock.lineCost),
//      when it had one; else nothing (the cost is unknown: such goods leave at
//      no cost until the owner sets one, and nothing is guessed). The item's
//      stockValue grows by that value, and its avgCost becomes the old cost
//      price (null when it had none). The opening counts on the balance sheet
//      only (Inventory Asset against Opening Balance Adjustments).
//   3. Goods with nothing in stock keep their old cost price as avgCost, so a
//      return or a count can use it. No movement: there is nothing to value.
//   Each business's "sells" stays null: the app asks the owner.
//
// An item whose stock movements explain more than it holds, or that belongs
// to no business, is listed and left. Each item is changed in a transaction
// of its own, under its business's lock and its own row lock, only if it is
// still as it was read (else it is left for the next run), with an AuditLog
// row (actor "system", action BACKFILL_R3_OPENING or BACKFILL_R3_AVG_COST). It
// prints ids and numbers, never names.
//
//   node scripts/backfill-r3.js --dry-run             # prints what it would change, writes nothing
//   node scripts/backfill-r3.js                       # changes it
//   node scripts/backfill-r3.js --owner <userId>      # only that owner's items (either way)
//
// Uses DATABASE_URL (swap sslmode=verify-full for sslmode=require on Render).
// Exits 1 when an item failed (the rest are still done), 2 on bad arguments.
const prisma = require("../src/utils/db");
const { dayKey } = require("../src/utils/books");
const { lineCost } = require("../src/utils/stock");
const { toKobo } = require("../src/utils/money");

const MILLI = 1000;
const toMilli = (q) => Math.round((Number(q) || 0) * MILLI);
const units = (m) => m / MILLI;
const naira = (k) => k / 100 || 0;
const shown = (k) => (k / 100).toFixed(2);

// The opening's own key: one per item, so a second run finds it.
const openingKey = (itemId) => `open:${itemId}:1`;

// An old cost price the books can use: a real number, 0 or more, at most a
// trillion naira a unit. Anything else is no cost at all.
function oldCost(cost) {
  const c = typeof cost === "number" ? cost : cost == null ? NaN : Number(cost);
  return Number.isFinite(c) && c >= 0 && c <= 1e12 ? c : null;
}

// What one item needs (pure, exported for the tests). item: the row;
// moved: { quantityM, valueK, opening } from its movements (the sums in
// thousandths and kobo, and whether an opening is there already). Returns
// { action: "none" } or { action: "leave", reason } or
// { action: "opening", quantityM, valueK, costKnown, avgCost, stockValueK } or
// { action: "avgCost", avgCost }.
function planFor(item, moved) {
  if (item.itemType !== "goods") return { action: "none" };
  if (!item.businessId) return { action: "leave", reason: "it belongs to no business" };
  const cost = oldCost(item.cost);
  const haveM = toMilli(item.quantity);
  const unexplainedM = haveM - moved.quantityM;
  if (unexplainedM < 0) {
    return { action: "leave", reason: `its movements bring in ${units(moved.quantityM)}, more than the ${units(haveM)} it holds` };
  }
  if (unexplainedM > 0 && !moved.opening) {
    const valueK = cost == null ? 0 : toKobo(lineCost(units(unexplainedM), cost));
    const stockValueK = toKobo(item.stockValue) + valueK;
    // With nothing else moved, the item's cost is its old cost price; else
    // the average of everything it now holds, as the stock engine keeps it.
    let avgCost;
    if (moved.quantityM === 0 && moved.valueK === 0) avgCost = cost;
    else if (cost == null && item.avgCost == null && stockValueK === 0) avgCost = null;
    else avgCost = (stockValueK * 10) / haveM;
    return { action: "opening", quantityM: unexplainedM, valueK, costKnown: cost != null, avgCost, stockValueK };
  }
  if (haveM === 0 && item.avgCost == null && cost != null) return { action: "avgCost", avgCost: cost };
  return { action: "none" };
}

async function backfillR3({ dryRun = false, ownerId = null, log = console.log } = {}) {
  const summary = {
    dryRun,
    items: 0,
    services: 0,
    openings: { written: 0, unknownCost: 0, value: 0 },
    avgCost: 0,
    left: 0,
    failed: 0,
  };
  const today = dayKey(new Date());
  const date = new Date(`${today}T00:00:00.000Z`); // today in Lagos, as a typed day is kept

  const items = await prisma.inventoryItem.findMany({
    where: ownerId ? { userId: ownerId } : {},
    select: {
      id: true, businessId: true, itemType: true, quantity: true, cost: true, stockValue: true, avgCost: true, updatedAt: true,
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  summary.items = items.length;
  summary.services = items.filter((i) => i.itemType !== "goods").length;
  log(`items: ${items.length} (${items.length - summary.services} goods, ${summary.services} services)`);

  // Sums of an item's movements, and whether its opening is there.
  const movedOf = async (db, itemId) => {
    const [sum, opening] = await Promise.all([
      db.stockMovement.aggregate({ where: { itemId }, _sum: { quantity: true, value: true } }),
      db.stockMovement.findFirst({ where: { itemId, sourceKey: { startsWith: `open:${itemId}:` } }, select: { id: true } }),
    ]);
    return { quantityM: toMilli(sum._sum.quantity), valueK: toKobo(sum._sum.value), opening: !!opening };
  };

  for (const row of items) {
    try {
      if (row.itemType !== "goods") continue;
      const plan = planFor(row, await movedOf(prisma, row.id));
      if (plan.action === "none") continue;
      if (plan.action === "leave") {
        summary.left++;
        log(`  leave  item ${row.id}: ${plan.reason}`);
        continue;
      }
      if (plan.action === "opening") {
        log(
          `  open   item ${row.id} in business ${row.businessId}: ${units(plan.quantityM)} in stock, ` +
          `${plan.costKnown ? `worth ${shown(plan.valueK)} at cost` : "cost unknown (0)"}, dated ${today}`,
        );
      } else {
        log(`  cost   item ${row.id} in business ${row.businessId}: nothing in stock, average cost ${plan.avgCost}`);
      }
      if (dryRun) {
        if (plan.action === "opening") {
          summary.openings.written++;
          if (!plan.costKnown) summary.openings.unknownCost++;
          summary.openings.value += plan.valueK;
        } else summary.avgCost++;
        continue;
      }

      const done = await prisma.withBusinessLock(row.businessId, () => prisma.$transaction(async (px) => {
        await px.$queryRaw`SELECT "id" FROM "InventoryItem" WHERE "id" = ${row.id} FOR UPDATE`;
        const item = await px.inventoryItem.findUnique({
          where: { id: row.id },
          select: { id: true, businessId: true, itemType: true, quantity: true, cost: true, stockValue: true, avgCost: true, updatedAt: true },
        });
        // Still as it was read, else the next run takes it.
        if (!item || item.updatedAt.getTime() !== row.updatedAt.getTime()) return null;
        const now = planFor(item, await movedOf(px, item.id));
        if (now.action !== plan.action) return null;
        if (now.action === "avgCost") {
          await px.inventoryItem.update({ where: { id: item.id }, data: { avgCost: now.avgCost } });
          await px.auditLog.create({
            data: {
              actorType: "system", action: "BACKFILL_R3_AVG_COST", resourceType: "inventory_item", resourceId: item.id,
              metadata: { businessId: item.businessId, avgCost: now.avgCost },
            },
          });
          return now;
        }
        await px.stockMovement.create({
          data: {
            businessId: item.businessId,
            itemId: item.id,
            kind: "opening",
            date,
            quantity: units(now.quantityM),
            value: naira(now.valueK),
            qtyAfter: item.quantity,
            valueAfter: naira(now.stockValueK),
            sourceKey: openingKey(item.id),
          },
        });
        await px.inventoryItem.update({
          where: { id: item.id },
          data: { stockValue: naira(now.stockValueK), avgCost: now.avgCost },
        });
        await px.auditLog.create({
          data: {
            actorType: "system", action: "BACKFILL_R3_OPENING", resourceType: "inventory_item", resourceId: item.id,
            metadata: {
              businessId: item.businessId, quantity: units(now.quantityM), value: naira(now.valueK),
              costKnown: now.costKnown, avgCost: now.avgCost, date: today,
            },
          },
        });
        return now;
      }, { timeout: 20000 }));

      if (!done) {
        summary.left++;
        log(`  leave  item ${row.id}: it changed meanwhile (run again)`);
      } else if (done.action === "opening") {
        summary.openings.written++;
        if (!done.costKnown) summary.openings.unknownCost++;
        summary.openings.value += done.valueK;
      } else summary.avgCost++;
    } catch (err) {
      summary.failed++;
      log(`  FAIL   item ${row.id}: ${String((err && err.message) || err).split("\n").filter(Boolean).pop()}`);
    }
  }

  summary.openings.value = naira(summary.openings.value);
  log(
    `openings ${dryRun ? "to write" : "written"}: ${summary.openings.written} ` +
    `(${summary.openings.unknownCost} with no cost), worth ${summary.openings.value.toFixed(2)} at cost; ` +
    `average costs kept: ${summary.avgCost}; left: ${summary.left}`,
  );
  log(dryRun ? "dry run: nothing written" : "done");
  return summary;
}

function parseArgs(argv) {
  const out = { dryRun: false, ownerId: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--owner" && /^[A-Za-z0-9_-]+$/.test(argv[i + 1] || "")) out.ownerId = argv[++i];
    else throw new Error(`unknown argument ${a}\nusage: node scripts/backfill-r3.js [--dry-run] [--owner <userId>]`);
  }
  return out;
}

module.exports = { backfillR3, parseArgs, planFor, oldCost, openingKey };

if (require.main === module) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  let where = "?";
  try {
    const u = new URL(process.env.DATABASE_URL);
    where = `${u.hostname}${u.pathname}`;
  } catch { /* printed as "?" */ }
  console.log(`release 3 backfill on ${where}${args.dryRun ? " (dry run)" : ""}${args.ownerId ? `, owner ${args.ownerId}` : ""}`);
  backfillR3(args)
    .then(async (summary) => {
      console.log(`RESULT ${JSON.stringify(summary)}`);
      await prisma.$disconnect();
      // The business lock holds its own pg connection; without this Node waits on it.
      process.exit(summary.failed ? 1 : 0);
    })
    .catch(async (err) => {
      console.error(err);
      await prisma.$disconnect();
      process.exit(1);
    });
}
