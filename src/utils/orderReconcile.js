// Match an inbound NUBAN credit to a storefront Order and mark it PAID.
//
// Idempotent (only acts on PENDING orders, so a re-delivered webhook or the
// reconcile loop can't double-process) and atomic per business (withBusinessLock).
// Matching: (a) the transfer narration/reference contains the order's
// paymentReference; else (b) exactly one PENDING order whose total equals the
// credited amount. Ambiguous/no match → left for manual matching in the app.
const prisma = require("./db");
const { pushTo } = require("./pushNotification");
const { money } = require("./storefrontHtml");

async function tryMatchOrder({ business, amount, narration = "", reference = "" }) {
  try {
    if (!business || !business.id || !(Number(amount) > 0)) return null;
    const amt = Number(amount);

    return await prisma.withBusinessLock(business.id, async () => {
      const open = await prisma.order.findMany({
        where: { businessId: business.id, status: "PENDING" },
        include: { items: true },
        orderBy: { createdAt: "desc" },
        take: 200,
      });
      if (!open.length) return null;

      const hay = `${narration} ${reference}`.toUpperCase().replace(/\s+/g, "");
      // (a) reference appears in the transfer narration
      let match = open.find(
        (o) => o.paymentReference && hay.includes(o.paymentReference.toUpperCase()),
      );
      // (b) else exactly one PENDING order with the exact total
      if (!match) {
        const exact = open.filter((o) => Math.abs(o.total - amt) < 0.01);
        if (exact.length === 1) match = exact[0];
      }
      if (!match) return null;

      const updated = await prisma.order.update({
        where: { id: match.id },
        data: { status: "PAID", paidAt: new Date() },
      });

      // Decrement stock for linked products (only happens on PENDING→PAID, so once).
      for (const it of match.items) {
        if (!it.inventoryItemId) continue;
        await prisma.inventoryItem
          .update({ where: { id: it.inventoryItemId }, data: { quantity: { decrement: it.quantity } } })
          .catch((e) => console.error("[orderReconcile stock]", e.message));
      }
      // Safety net: never let stock go negative (oversell edge-case).
      await prisma.$executeRaw`UPDATE "InventoryItem" SET "quantity" = 0 WHERE "quantity" < 0 AND "businessId" = ${business.id}`;

      pushTo(
        business.userId,
        `Order ${updated.orderNumber} paid ✅`,
        `${updated.customerName} · ${money(updated.total, updated.currency)}`,
      ).catch(() => {});
      console.log(`[orderReconcile] ${updated.orderNumber} → PAID (${updated.total})`);
      return updated;
    });
  } catch (e) {
    console.error("[tryMatchOrder]", e.message);
    return null;
  }
}

module.exports = { tryMatchOrder };
