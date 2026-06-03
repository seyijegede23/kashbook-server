const express = require("express");
const router = express.Router();
const prisma = require("../utils/db");
const auth = require("../middleware/auth");

router.use(auth);

// Compute nextDue given a frequency and a base date
function computeNextDue(frequency, from = new Date()) {
  const d = new Date(from);
  switch (frequency) {
    case "daily":   d.setDate(d.getDate() + 1); break;
    case "weekly":  d.setDate(d.getDate() + 7); break;
    case "monthly": d.setMonth(d.getMonth() + 1); break;
    case "yearly":  d.setFullYear(d.getFullYear() + 1); break;
    default: {
      if (frequency && frequency.startsWith("custom_")) {
        const days = parseInt(frequency.split("_")[1], 10);
        if (days > 0) { d.setDate(d.getDate() + days); break; }
      }
      d.setMonth(d.getMonth() + 1);
    }
  }
  return d;
}

// GET /recurring-expenses
router.get("/", async (req, res) => {
  try {
    const { businessId } = req.query;
    const where = { userId: req.user.id };
    if (businessId) where.businessId = businessId;

    const items = await prisma.recurringExpense.findMany({
      where,
      orderBy: { nextDue: "asc" },
    });
    res.json(items);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch recurring expenses" });
  }
});

// POST /recurring-expenses
router.post("/", async (req, res) => {
  try {
    const { businessId, category, amount, paymentMethod, notes, frequency, startDate } = req.body;

    if (!amount || amount <= 0) return res.status(400).json({ error: "Invalid amount" });
    const validFreq = ["daily", "weekly", "monthly", "yearly"].includes(frequency) ||
      (typeof frequency === "string" && frequency.startsWith("custom_") && parseInt(frequency.split("_")[1], 10) > 0);
    if (!validFreq) return res.status(400).json({ error: "Invalid frequency" });

    if (businessId) {
      const owned = await prisma.business.findFirst({
        where: { id: businessId, userId: req.user.id },
      });
      if (!owned) return res.status(403).json({ error: "Forbidden" });
    }

    // nextDue = startDate if provided (and in future), else first occurrence from now
    const base = startDate ? new Date(startDate) : new Date();
    const nextDue = base;

    const item = await prisma.recurringExpense.create({
      data: {
        userId: req.user.id,
        businessId: businessId || null,
        category: category || "other",
        amount: parseFloat(amount),
        paymentMethod: paymentMethod || "cash",
        notes: notes || null,
        frequency,
        nextDue,
      },
    });
    res.status(201).json(item);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create recurring expense" });
  }
});

// PATCH /recurring-expenses/:id
router.patch("/:id", async (req, res) => {
  try {
    const { category, amount, paymentMethod, notes, frequency, active } = req.body;
    const existing = await prisma.recurringExpense.findFirst({
      where: { id: req.params.id, userId: req.user.id },
    });
    if (!existing) return res.status(404).json({ error: "Not found" });

    const data = {};
    if (category !== undefined) data.category = category;
    if (amount !== undefined) data.amount = parseFloat(amount);
    if (paymentMethod !== undefined) data.paymentMethod = paymentMethod;
    if (notes !== undefined) data.notes = notes;
    if (frequency !== undefined) data.frequency = frequency;
    if (active !== undefined) data.active = active;

    const updated = await prisma.recurringExpense.update({
      where: { id: req.params.id },
      data,
    });
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update recurring expense" });
  }
});

// DELETE /recurring-expenses/:id
router.delete("/:id", async (req, res) => {
  try {
    const existing = await prisma.recurringExpense.findFirst({
      where: { id: req.params.id, userId: req.user.id },
    });
    if (!existing) return res.status(404).json({ error: "Not found" });
    await prisma.recurringExpense.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete recurring expense" });
  }
});

module.exports = { router, computeNextDue };
