const router = require("express").Router();
const auth = require("../middleware/auth");
const prisma = require("../utils/db");
const { validateExpense, validateIdParam } = require("../middleware/validate");

router.use(auth);

// Helper to resolve the correct business owner ID
const getTargetUserId = (req) =>
  req.user.accountType === "staff" ? req.user.employerId : req.user.id;

// GET /expenses?from=&to=&limit=&businessId=
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
    const expenses = await prisma.expense.findMany({
      where,
      orderBy: since ? { updatedAt: "asc" } : { date: "desc" },
      take: since ? undefined : Number(limit),
    });
    res.json(expenses);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch expenses" });
  }
});

// POST /expenses
router.post("/", validateExpense, async (req, res) => {
  if (req.user.accountType === "staff") {
    return res.status(403).json({ error: "Staff cannot create expenses" });
  }

  const {
    category = "other",
    amount,
    notes,
    date,
    businessId,
    paymentMethod = "cash",
  } = req.body;
  if (!amount) return res.status(400).json({ error: "amount required" });

  // Normalize category to lowercase
  const safeCategory =
    typeof category === "string" ? category.toLowerCase() : "other";

  try {
    if (businessId) {
      const owned = await prisma.business.findFirst({
        where: { id: businessId, userId: getTargetUserId(req) },
      });
      if (!owned) return res.status(403).json({ error: "Forbidden" });
    }

    const expense = await prisma.expense.create({
      data: {
        userId: getTargetUserId(req),
        businessId: businessId || null,
        category: safeCategory,
        amount: Number(amount),
        paymentMethod,
        notes: notes || null,
        date: date ? new Date(date) : new Date(),
      },
    });
    res.status(201).json(expense);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create expense" });
  }
});

// PATCH /expenses/:id
router.patch("/:id", validateIdParam, async (req, res) => {
  if (req.user.accountType === "staff")
    return res.status(403).json({ error: "Staff cannot edit expenses" });
  try {
    const expense = await prisma.expense.findUnique({ where: { id: req.params.id } });
    if (!expense) return res.status(404).json({ error: "Expense not found" });
    if (expense.userId !== req.user.id) return res.status(403).json({ error: "Forbidden" });
    const { amount, notes, category, paymentMethod, date } = req.body;
    const updated = await prisma.expense.update({
      where: { id: req.params.id },
      data: {
        ...(amount !== undefined && { amount: Number(amount) }),
        ...(notes !== undefined && { notes }),
        ...(category !== undefined && { category }),
        ...(paymentMethod !== undefined && { paymentMethod }),
        ...(date !== undefined && { date: new Date(date) }),
      },
    });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: "Failed to update expense" });
  }
});

// DELETE /expenses/:id
router.delete("/:id", validateIdParam, async (req, res) => {
  if (req.user.accountType === "staff") {
    return res.status(403).json({ error: "Staff cannot delete expenses" });
  }

  try {
    const expense = await prisma.expense.findUnique({
      where: { id: req.params.id },
    });
    if (!expense) return res.status(404).json({ error: "Expense not found" });
    if (expense.userId !== req.user.id)
      return res.status(403).json({ error: "Forbidden" });

    await prisma.expense.delete({ where: { id: req.params.id } });
    res.json({ message: "Deleted" });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete expense" });
  }
});

module.exports = router;
