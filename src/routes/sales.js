const router = require("express").Router();
const auth = require("../middleware/auth");
const prisma = require("../utils/db");
const { validateSale, validateIdParam } = require("../middleware/validate");

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
    const { amount, notes, paymentMethod, date } = req.body;
    const updated = await prisma.sales.update({
      where: { id: req.params.id },
      data: {
        ...(amount !== undefined && { amount: Number(amount) }),
        ...(notes !== undefined && { notes }),
        ...(paymentMethod !== undefined && { paymentMethod }),
        ...(date !== undefined && { date: new Date(date) }),
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
