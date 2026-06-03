const router = require("express").Router();
const auth = require("../middleware/auth");
const prisma = require("../utils/db");

router.use(auth);

async function ownsBusiness(userId, businessId) {
  const biz = await prisma.business.findFirst({ where: { id: businessId, userId } });
  return !!biz;
}

// GET /payables?businessId=
router.get("/", async (req, res) => {
  const { businessId } = req.query;
  if (!businessId) return res.status(400).json({ error: "businessId required" });
  if (!(await ownsBusiness(req.user.id, businessId)))
    return res.status(403).json({ error: "Forbidden" });

  try {
    const list = await prisma.payable.findMany({
      where: { businessId },
      include: { payments: true },
      orderBy: { createdAt: "desc" },
    });
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch payables" });
  }
});

// POST /payables
router.post("/", async (req, res) => {
  const {
    businessId,
    creditorName,
    category = "other",
    amount,
    dueDate,
    note,
    date,
  } = req.body;
  if (!businessId || !creditorName || !amount) {
    return res
      .status(400)
      .json({ error: "businessId, creditorName, amount required" });
  }
  if (!(await ownsBusiness(req.user.id, businessId)))
    return res.status(403).json({ error: "Forbidden" });

  try {
    const payable = await prisma.payable.create({
      data: {
        businessId,
        creditorName,
        category,
        amount: Number(amount),
        dueDate: dueDate ? new Date(dueDate) : null,
        note: note || null,
        date: date ? new Date(date) : new Date(),
      },
      include: { payments: true },
    });
    res.status(201).json(payable);
  } catch (err) {
    res.status(500).json({ error: "Failed to create payable" });
  }
});

// DELETE /payables/:id
router.delete("/:id", async (req, res) => {
  try {
    const payable = await prisma.payable.findUnique({
      where: { id: req.params.id },
    });
    if (!payable) return res.status(404).json({ error: "Payable not found" });
    if (!(await ownsBusiness(req.user.id, payable.businessId)))
      return res.status(403).json({ error: "Forbidden" });

    await prisma.payable.delete({ where: { id: req.params.id } });
    res.json({ message: "Deleted" });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete payable" });
  }
});

// POST /payables/:id/payments
router.post("/:id/payments", async (req, res) => {
  const { amount, note, date } = req.body;
  if (!amount) return res.status(400).json({ error: "amount required" });

  try {
    const payable = await prisma.payable.findUnique({
      where: { id: req.params.id },
    });
    if (!payable) return res.status(404).json({ error: "Payable not found" });
    if (!(await ownsBusiness(req.user.id, payable.businessId)))
      return res.status(403).json({ error: "Forbidden" });

    const newPaid = Math.min(payable.paidAmount + Number(amount), payable.amount);
    const isPaid = newPaid >= payable.amount;

    await prisma.payablePayment.create({
      data: {
        payableId: req.params.id,
        amount: Number(amount),
        note: note || null,
        date: date ? new Date(date) : new Date(),
      },
    });

    const updated = await prisma.payable.update({
      where: { id: req.params.id },
      data: { paidAmount: newPaid, paid: isPaid },
      include: { payments: true },
    });

    res.status(201).json(updated);
  } catch (err) {
    res.status(500).json({ error: "Failed to record payment" });
  }
});

module.exports = router;
