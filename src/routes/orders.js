// Merchant-facing storefront orders API (auth). List, view, update status,
// and manually mark-paid (safety net when auto-reconcile didn't match).
const router = require("express").Router();
const prisma = require("../utils/db");
const auth = require("../middleware/auth");
const { audit } = require("../utils/audit");

router.use(auth);

const targetUserId = (req) => (req.user.accountType === "staff" ? req.user.employerId : req.user.id);

// GET /orders?businessId=&status=&limit=
router.get("/", async (req, res) => {
  try {
    const where = { userId: targetUserId(req) };
    if (req.query.businessId) where.businessId = String(req.query.businessId);
    if (req.query.status) where.status = String(req.query.status).toUpperCase();
    const orders = await prisma.order.findMany({
      where,
      include: { items: true },
      orderBy: { createdAt: "desc" },
      take: Math.min(500, Math.max(1, Number(req.query.limit) || 100)),
    });
    res.json(orders);
  } catch (e) {
    console.error("[orders list]", e.message);
    res.status(500).json({ error: "Failed to fetch orders" });
  }
});

// GET /orders/:id
router.get("/:id", async (req, res) => {
  try {
    const order = await prisma.order.findFirst({
      where: { id: req.params.id, userId: targetUserId(req) },
      include: { items: true },
    });
    if (!order) return res.status(404).json({ error: "Order not found" });
    res.json(order);
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch order" });
  }
});

// PATCH /orders/:id  → { status: "FULFILLED"|"CANCELLED" } or { markPaid: true }
router.patch("/:id", async (req, res) => {
  try {
    const order = await prisma.order.findFirst({
      where: { id: req.params.id, userId: targetUserId(req) },
      include: { items: true },
    });
    if (!order) return res.status(404).json({ error: "Order not found" });
    const { status, markPaid } = req.body || {};

    // Manual mark-paid — mirrors auto-reconcile: PAID + decrement stock once.
    if (markPaid) {
      if (order.status !== "PENDING") return res.json(order);
      const updated = await prisma.withBusinessLock(order.businessId, async () => {
        const fresh = await prisma.order.findUnique({ where: { id: order.id }, include: { items: true } });
        if (!fresh || fresh.status !== "PENDING") return fresh;
        const u = await prisma.order.update({ where: { id: order.id }, data: { status: "PAID", paidAt: new Date() } });
        for (const it of fresh.items) {
          if (it.inventoryItemId)
            await prisma.inventoryItem.update({ where: { id: it.inventoryItemId }, data: { quantity: { decrement: it.quantity } } }).catch(() => {});
        }
        await prisma.$executeRaw`UPDATE "InventoryItem" SET "quantity" = 0 WHERE "quantity" < 0 AND "businessId" = ${order.businessId}`;
        return u;
      });
      await audit({ req, action: "ORDER_MARK_PAID", resourceType: "order", resourceId: order.id });
      return res.json(updated);
    }

    if (status && ["FULFILLED", "CANCELLED"].includes(status)) {
      const updated = await prisma.order.update({ where: { id: order.id }, data: { status } });
      await audit({ req, action: `ORDER_${status}`, resourceType: "order", resourceId: order.id });
      return res.json(updated);
    }

    return res.status(400).json({ error: "Provide status (FULFILLED|CANCELLED) or markPaid:true" });
  } catch (e) {
    console.error("[order patch]", e.message);
    res.status(500).json({ error: "Failed to update order" });
  }
});

module.exports = router;
