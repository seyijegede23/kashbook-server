const router = require("express").Router();
const auth = require("../middleware/auth");
const prisma = require("../utils/db");
const { validateSale, validateIdParam } = require("../middleware/validate");
const { normalizeChannel } = require("../utils/salesChannel");

router.use(auth);

// Helper to resolve the correct business owner ID
const getTargetUserId = (req) =>
  req.user.accountType === "staff" ? req.user.employerId : req.user.id;

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
      orderBy: since ? { updatedAt: "asc" } : { date: "desc" },
      take: since ? undefined : Math.min(1000, Math.max(1, Number(limit) || 200)),
    });
    res.json(sales);
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
  } = req.body;
  if (!amount) return res.status(400).json({ error: "amount required" });

  try {
    if (businessId) {
      const owned = await prisma.business.findFirst({
        where: { id: businessId, userId: getTargetUserId(req) },
      });
      if (!owned) return res.status(403).json({ error: "Forbidden" });
    }

    const sale = await prisma.sales.create({
      data: {
        userId: getTargetUserId(req),
        businessId: businessId || null,
        customerId: customerId || null,
        amount: Number(amount),
        paymentMethod,
        isCredit,
        notes: notes || null,
        channel: normalizeChannel(channel),
        date: date ? new Date(date) : new Date(),
        recordedBy: req.user.id,
        recordedByName: req.user.name,
      },
    });
    res.status(201).json(sale);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create sale" });
  }
});

// PATCH /sales/:id
router.patch("/:id", validateIdParam, async (req, res) => {
  if (req.user.accountType === "staff")
    return res.status(403).json({ error: "Staff cannot edit sales" });
  try {
    const sale = await prisma.sales.findUnique({ where: { id: req.params.id } });
    if (!sale) return res.status(404).json({ error: "Sale not found" });
    if (sale.userId !== req.user.id) return res.status(403).json({ error: "Forbidden" });
    const { amount, notes, paymentMethod, date, channel } = req.body;
    const updated = await prisma.sales.update({
      where: { id: req.params.id },
      data: {
        ...(amount !== undefined && { amount: Number(amount) }),
        ...(notes !== undefined && { notes }),
        ...(paymentMethod !== undefined && { paymentMethod }),
        ...(date !== undefined && { date: new Date(date) }),
        ...(channel !== undefined && { channel: normalizeChannel(channel) }),
      },
    });
    res.json(updated);
  } catch (err) {
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

    await prisma.sales.delete({ where: { id: req.params.id } });
    res.json({ message: "Deleted" });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete sale" });
  }
});

module.exports = router;
