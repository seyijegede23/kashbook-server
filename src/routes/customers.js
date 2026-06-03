const router = require("express").Router();
const auth = require("../middleware/auth");
const prisma = require("../utils/db");
const { validateCustomer, validateIdParam } = require("../middleware/validate");

router.use(auth);

// Helper to resolve the correct business owner ID
const getTargetUserId = (req) =>
  req.user.accountType === "staff" ? req.user.employerId : req.user.id;

// ── Helper: recalculate totalOwed and persist ───────────────────────────────
async function recalcAndSaveOwed(customerId) {
  const debts = await prisma.debt.findMany({ where: { customerId } });
  const totalOwed = debts.reduce(
    (sum, d) => sum + Math.max(0, d.amount - d.paidAmount),
    0,
  );
  return prisma.customer.update({
    where: { id: customerId },
    data: { totalOwed },
    include: { debts: { include: { payments: true } } },
  });
}

// GET /customers?businessId=
router.get("/", async (req, res) => {
  try {
    const { businessId, since } = req.query;
    const where = { userId: getTargetUserId(req) };
    if (businessId) where.businessId = businessId;
    if (since) where.updatedAt = { gt: new Date(since) };
    const customers = await prisma.customer.findMany({
      where,
      include: { debts: { include: { payments: true } } },
      orderBy: since ? { updatedAt: "asc" } : { createdAt: "desc" },
    });
    res.json(customers);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch customers" });
  }
});

// POST /customers
router.post("/", validateCustomer, async (req, res) => {
  const { name, phone, reminderEnabled = false, businessId } = req.body;
  if (!name) return res.status(400).json({ error: "name required" });

  const userId = getTargetUserId(req);
  const trimmedPhone = phone?.trim() || null;

  try {
    if (businessId) {
      const owned = await prisma.business.findFirst({
        where: { id: businessId, userId },
      });
      if (!owned) return res.status(403).json({ error: "Forbidden" });
    }

    if (req.user.effectivePlan !== "PREMIUM") {
      const count = await prisma.customer.count({ where: { userId } });
      if (count >= 20) {
        return res.status(403).json({ error: "Free plan allows up to 20 customers. Upgrade to Pro for unlimited customers." });
      }
    }
    let customer;
    if (trimmedPhone) {
      // Use upsert so a duplicate phone returns the existing customer instead of crashing
      customer = await prisma.customer.upsert({
        where: { userId_phone: { userId, phone: trimmedPhone } },
        update: { name: name.trim(), businessId: businessId || null, reminderEnabled },
        create: {
          userId,
          businessId: businessId || null,
          name: name.trim(),
          phone: trimmedPhone,
          reminderEnabled,
        },
        include: { debts: { include: { payments: true } } },
      });
    } else {
      customer = await prisma.customer.create({
        data: {
          userId,
          businessId: businessId || null,
          name: name.trim(),
          phone: null,
          reminderEnabled,
        },
        include: { debts: { include: { payments: true } } },
      });
    }
    res.status(201).json(customer);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create customer" });
  }
});

// GET /customers/:id
router.get("/:id", async (req, res) => {
  try {
    const customer = await prisma.customer.findUnique({
      where: { id: req.params.id },
      include: { debts: { include: { payments: true } } },
    });
    if (!customer) return res.status(404).json({ error: "Customer not found" });
    if (customer.userId !== getTargetUserId(req))
      return res.status(403).json({ error: "Forbidden" });
    res.json(customer);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch customer" });
  }
});

// PATCH /customers/:id
router.patch("/:id", async (req, res) => {
  const { name, phone, reminderEnabled } = req.body;
  try {
    const customer = await prisma.customer.findUnique({
      where: { id: req.params.id },
    });
    if (!customer) return res.status(404).json({ error: "Customer not found" });
    if (customer.userId !== getTargetUserId(req))
      return res.status(403).json({ error: "Forbidden" });

    const data = {};
    if (name !== undefined) data.name = name.trim();
    if (phone !== undefined) data.phone = phone.trim();
    if (reminderEnabled !== undefined) data.reminderEnabled = reminderEnabled;

    const updated = await prisma.customer.update({
      where: { id: req.params.id },
      data,
      include: { debts: { include: { payments: true } } },
    });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: "Failed to update customer" });
  }
});

// DELETE /customers/:id
router.delete("/:id", validateIdParam, async (req, res) => {
  if (req.user.accountType === "staff") {
    return res.status(403).json({ error: "Staff cannot delete customers" });
  }

  try {
    const customer = await prisma.customer.findUnique({
      where: { id: req.params.id },
    });
    if (!customer) return res.status(404).json({ error: "Customer not found" });
    if (customer.userId !== req.user.id)
      return res.status(403).json({ error: "Forbidden" });

    await prisma.customer.delete({ where: { id: req.params.id } });
    res.json({ message: "Deleted" });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete customer" });
  }
});

// POST /customers/:id/debts — add a new debt record
router.post("/:id/debts", async (req, res) => {
  const { amount, note = "", date } = req.body;
  if (!amount) return res.status(400).json({ error: "amount required" });

  try {
    const customer = await prisma.customer.findUnique({
      where: { id: req.params.id },
    });
    if (!customer) return res.status(404).json({ error: "Customer not found" });
    if (customer.userId !== getTargetUserId(req))
      return res.status(403).json({ error: "Forbidden" });

    await prisma.debt.create({
      data: {
        customerId: req.params.id,
        amount: Number(amount),
        paidAmount: 0,
        paid: false,
        note: note || "",
        date: date ? new Date(date) : new Date(),
      },
    });

    const updated = await recalcAndSaveOwed(req.params.id);
    res.status(201).json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to add debt" });
  }
});

// POST /customers/:id/debts/:debtId/payment — record a payment on a specific debt
router.post("/:id/debts/:debtId/payment", async (req, res) => {
  const { amount, note = "" } = req.body;
  if (!amount) return res.status(400).json({ error: "amount required" });

  try {
    const customer = await prisma.customer.findUnique({
      where: { id: req.params.id },
    });
    if (!customer) return res.status(404).json({ error: "Customer not found" });
    if (customer.userId !== getTargetUserId(req))
      return res.status(403).json({ error: "Forbidden" });

    const debt = await prisma.debt.findUnique({
      where: { id: req.params.debtId },
    });
    if (!debt) return res.status(404).json({ error: "Debt not found" });

    const newPaidAmount = Math.min(
      debt.paidAmount + Number(amount),
      debt.amount,
    );

    await prisma.debtPayment.create({
      data: {
        debtId: req.params.debtId,
        amount: Number(amount),
        note: note || "",
        date: new Date(),
      },
    });

    await prisma.debt.update({
      where: { id: req.params.debtId },
      data: { paidAmount: newPaidAmount, paid: newPaidAmount >= debt.amount },
    });

    const updated = await recalcAndSaveOwed(req.params.id);
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to record payment" });
  }
});

// Legacy — POST /customers/:id/credit
router.post("/:id/credit", async (req, res) => {
  const { amount, note, date } = req.body;
  if (!amount) return res.status(400).json({ error: "amount required" });
  try {
    const customer = await prisma.customer.findUnique({
      where: { id: req.params.id },
    });
    if (!customer) return res.status(404).json({ error: "Customer not found" });
    if (customer.userId !== getTargetUserId(req))
      return res.status(403).json({ error: "Forbidden" });

    await prisma.debt.create({
      data: {
        customerId: req.params.id,
        amount: Number(amount),
        note: note || "",
        date: date ? new Date(date) : new Date(),
      },
    });

    const updated = await recalcAndSaveOwed(req.params.id);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: "Failed to record credit" });
  }
});

// Legacy — POST /customers/:id/payment
router.post("/:id/payment", async (req, res) => {
  const { amount } = req.body;
  if (!amount) return res.status(400).json({ error: "amount required" });
  try {
    const customer = await prisma.customer.findUnique({
      where: { id: req.params.id },
    });
    if (!customer) return res.status(404).json({ error: "Customer not found" });
    if (customer.userId !== getTargetUserId(req))
      return res.status(403).json({ error: "Forbidden" });

    const updated = await prisma.customer.update({
      where: { id: req.params.id },
      data: { totalOwed: Math.max(0, customer.totalOwed - Number(amount)) },
      include: { debts: { include: { payments: true } } },
    });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: "Failed to record payment" });
  }
});

module.exports = router;
