const router = require("express").Router();
const auth = require("../middleware/auth");
const prisma = require("../utils/db");

router.use(auth);

// Helper to resolve the correct business owner ID
const getTargetUserId = (req) =>
  req.user.accountType === "staff" ? req.user.employerId : req.user.id;

// GET /business-debts?status=&businessId=
router.get("/", async (req, res) => {
  try {
    const { status, businessId, since } = req.query;
    const where = { userId: getTargetUserId(req) };
    if (status) where.status = status;
    if (businessId) where.businessId = businessId;
    if (since) where.updatedAt = { gt: new Date(since) };
    const debts = await prisma.businessDebt.findMany({
      where,
      orderBy: since ? { updatedAt: "asc" } : [{ dueDate: "asc" }, { createdAt: "desc" }],
    });
    res.json(debts);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch debts" });
  }
});

// POST /business-debts
router.post("/", async (req, res) => {
  if (req.user.accountType === "staff") {
    return res
      .status(403)
      .json({ error: "Staff cannot manage business debts" });
  }

  const {
    name,
    type = "other",
    amount,
    dueDate,
    reminderEnabled = false,
    note,
    businessId,
  } = req.body;
  if (!name || !amount)
    return res.status(400).json({ error: "name and amount required" });

  try {
    if (businessId) {
      const owned = await prisma.business.findFirst({
        where: { id: businessId, userId: getTargetUserId(req) },
      });
      if (!owned) return res.status(403).json({ error: "Forbidden" });
    }

    const debt = await prisma.businessDebt.create({
      data: {
        userId: getTargetUserId(req),
        businessId: businessId || null,
        name: name.trim(),
        type,
        originalAmount: Number(amount),
        remainingAmount: Number(amount),
        dueDate: dueDate ? new Date(dueDate) : null,
        reminderEnabled,
        note: note || null,
      },
    });
    res.status(201).json(debt);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create debt" });
  }
});

// PATCH /business-debts/:id
router.patch("/:id", async (req, res) => {
  if (req.user.accountType === "staff") {
    return res
      .status(403)
      .json({ error: "Staff cannot modify business debts" });
  }

  const { name, type, dueDate, reminderEnabled, note } = req.body;
  try {
    const debt = await prisma.businessDebt.findUnique({
      where: { id: req.params.id },
    });
    if (!debt) return res.status(404).json({ error: "Debt not found" });
    if (debt.userId !== getTargetUserId(req))
      return res.status(403).json({ error: "Forbidden" });

    const data = {};
    if (name !== undefined) data.name = name.trim();
    if (type !== undefined) data.type = type;
    if (dueDate !== undefined) data.dueDate = dueDate ? new Date(dueDate) : null;
    if (reminderEnabled !== undefined) data.reminderEnabled = reminderEnabled;
    if (note !== undefined) data.note = note;

    const updated = await prisma.businessDebt.update({
      where: { id: req.params.id },
      data,
    });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: "Failed to update debt" });
  }
});

// DELETE /business-debts/:id
router.delete("/:id", async (req, res) => {
  if (req.user.accountType === "staff") {
    return res
      .status(403)
      .json({ error: "Staff cannot delete business debts" });
  }

  try {
    const debt = await prisma.businessDebt.findUnique({
      where: { id: req.params.id },
    });
    if (!debt) return res.status(404).json({ error: "Debt not found" });
    if (debt.userId !== req.user.id)
      return res.status(403).json({ error: "Forbidden" });

    await prisma.businessDebt.delete({ where: { id: req.params.id } });
    res.json({ message: "Deleted" });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete debt" });
  }
});

// POST /business-debts/:id/payments
router.post("/:id/payments", async (req, res) => {
  if (req.user.accountType === "staff") {
    return res
      .status(403)
      .json({ error: "Staff cannot record business debt payments" });
  }

  const { amount, notes, paymentDate } = req.body;
  if (!amount) return res.status(400).json({ error: "amount required" });

  try {
    const debt = await prisma.businessDebt.findUnique({
      where: { id: req.params.id },
    });
    if (!debt) return res.status(404).json({ error: "Debt not found" });
    if (debt.userId !== getTargetUserId(req))
      return res.status(403).json({ error: "Forbidden" });

    const newRemaining = Math.max(0, debt.remainingAmount - Number(amount));
    const newStatus =
      newRemaining === 0
        ? "paid"
        : newRemaining < debt.originalAmount
          ? "partial"
          : "unpaid";

    const updatedDebt = await prisma.businessDebt.update({
      where: { id: req.params.id },
      data: { remainingAmount: newRemaining, status: newStatus },
    });

    res.status(201).json({ debt: updatedDebt });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to record payment" });
  }
});

module.exports = router;
