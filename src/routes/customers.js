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

    // Books rule: a customer's repayments are counted sales, a credit sale's
    // debt is what counts it when paid, and a bank transfer applied to their
    // debt points at them. Deleting the customer would take all of that with
    // it (the debts cascade), so it is refused once money is attached.
    const [repaid, creditSales, transfers] = await Promise.all([
      prisma.debtPayment.count({ where: { debt: { customerId: customer.id } } }),
      prisma.debt.count({ where: { customerId: customer.id, saleId: { not: null } } }),
      prisma.transaction.count({ where: { matchedCustomerId: customer.id } }),
    ]);
    if (repaid || creditSales || transfers) {
      return res.status(409).json({
        error: "This customer has repayments or credit sales in your books, so they can't be deleted.",
        code: "CUSTOMER_HAS_PAYMENTS",
      });
    }

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
  const { note = "" } = req.body;
  const amount = Math.round(Number(req.body.amount) * 100) / 100;
  if (!(amount > 0) || !Number.isFinite(amount)) {
    return res.status(400).json({ error: "amount required", code: "BAD_AMOUNT" });
  }

  try {
    const customer = await prisma.customer.findUnique({
      where: { id: req.params.id },
    });
    if (!customer) return res.status(404).json({ error: "Customer not found" });
    if (customer.userId !== getTargetUserId(req))
      return res.status(403).json({ error: "Forbidden" });

    // Books rule: every repayment is a counted sale, so it is never more than
    // the debt still owes, and the payment and the debt change together. Under
    // the business lock (the owner's id for customers with no business) so two
    // phones settling the same debt cannot both pay it.
    const lockKey = customer.businessId || customer.userId;
    const updated = await prisma.withBusinessLock(lockKey, () =>
      prisma.$transaction(async (px) => {
        // SECURITY: the debt must belong to the customer we just authorised.
        // Looking it up by id alone let an attacker with one owned customer
        // write payments against — and settle — another merchant's debt.
        const debt = await px.debt.findFirst({
          where: { id: req.params.debtId, customerId: customer.id },
        });
        if (!debt) throw Object.assign(new Error("Debt not found"), { status: 404 });
        const remaining = Math.round((debt.amount - debt.paidAmount) * 100) / 100;
        if (!(remaining > 0)) {
          throw Object.assign(new Error("This debt is already paid."), { status: 409, code: "DEBT_PAID" });
        }
        if (amount > remaining + 0.005) {
          throw Object.assign(new Error("That is more than the customer owes on this debt."), {
            status: 400, code: "EXCEEDS_DEBT", remaining,
          });
        }
        await px.debtPayment.create({
          data: { debtId: debt.id, amount, note: note || "", date: new Date() },
        });
        const paidAmount = Math.min(debt.amount, Math.round((debt.paidAmount + amount) * 100) / 100);
        // Compare-and-set: match-debt locks on the transfer's business,
        // which for a customer with no business is another key.
        const moved = await px.debt.updateMany({
          where: { id: debt.id, paidAmount: debt.paidAmount },
          data: { paidAmount, paid: paidAmount >= debt.amount - 0.005 },
        });
        if (moved.count !== 1) {
          throw Object.assign(new Error("This debt just changed. Try again."), { status: 409, code: "DEBT_CHANGED" });
        }
        const debts = await px.debt.findMany({ where: { customerId: customer.id } });
        const totalOwed = debts.reduce((sum, d) => sum + Math.max(0, d.amount - d.paidAmount), 0);
        return px.customer.update({
          where: { id: customer.id },
          data: { totalOwed },
          include: { debts: { include: { payments: true } } },
        });
      }),
    );
    res.json(updated);
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.message, code: err.code, remaining: err.remaining });
    }
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
