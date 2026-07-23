const router = require("express").Router();
const prisma = require("../utils/db");
const auth = require("../middleware/auth");
const { normalizeChannel } = require("../utils/salesChannel");
const { isBankLedgerRow } = require("../config/moneySources");
const { audit } = require("../utils/audit");

// This router is NOT mounted today (manual bookkeeping goes to Sales/Expense), but
// the client still references it. These guards ensure that even if it were mounted
// it can NEVER create, edit, or delete a real bank-ledger row (which would corrupt
// the spendable balance). Bank rows are provider-owned + append-only.

router.use(auth);

const getTargetUserId = (req) =>
  req.user.accountType === "staff" ? req.user.employerId : req.user.id;

async function ownsBusiness(req, businessId) {
  const biz = await prisma.business.findFirst({
    where: { id: businessId, userId: getTargetUserId(req) },
  });
  return !!biz;
}

// GET /transactions?businessId=&type=&startDate=&endDate=&limit=&offset=
router.get("/", async (req, res) => {
  const {
    businessId,
    type,
    startDate,
    endDate,
    limit = 100,
    offset = 0,
    since,
  } = req.query;
  if (!businessId)
    return res.status(400).json({ error: "businessId required" });
  if (!(await ownsBusiness(req,businessId)))
    return res.status(403).json({ error: "Forbidden" });

  try {
    const where = { businessId };
    if (since) {
      where.updatedAt = { gt: new Date(since) };
    } else {
      if (type) where.type = type;
      if (startDate || endDate) {
        where.date = {};
        if (startDate) where.date.gte = new Date(startDate);
        if (endDate) where.date.lte = new Date(endDate);
      }
    }

    const rows = await prisma.transaction.findMany({
      where,
      orderBy: since ? { updatedAt: "asc" } : [{ date: "desc" }, { createdAt: "desc" }],
      skip: since ? 0 : Number(offset),
      take: since ? undefined : Number(limit),
    });

    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch transactions" });
  }
});

// POST /transactions
router.post("/", async (req, res) => {
  const { businessId, type, amount, description, category, customerId, date, paymentMethod, channel } =
    req.body;
  if (!businessId || !type || !amount || !date) {
    return res
      .status(400)
      .json({ error: "businessId, type, amount, date required" });
  }
  if (!["income", "expense"].includes(type)) {
    return res.status(400).json({ error: "type must be income or expense" });
  }
  if (!(await ownsBusiness(req,businessId)))
    return res.status(403).json({ error: "Forbidden" });

  // Never create a bank-ledger row here — that's real money owned by the provider
  // webhook/transfer paths, and a manual "bank" income would inflate the spendable
  // balance. Reject a "bank" method or a client-supplied source.
  if (paymentMethod === "bank" || req.body.source) {
    return res.status(403).json({ error: "Bank transactions are created by the banking system, not here.", code: "BANK_ROW_FORBIDDEN" });
  }

  try {
    const tx = await prisma.transaction.create({
      data: {
        businessId,
        userId: getTargetUserId(req),
        type,
        amount: Number(amount),
        description: description || null,
        category: category || null,
        customerId: customerId || null,
        paymentMethod: paymentMethod || "cash",
        channel: normalizeChannel(channel),
        date: new Date(date),
        recordedBy: req.user.id,
        recordedByName: req.user.name,
      },
    });
    res.status(201).json(tx);
  } catch (err) {
    res.status(500).json({ error: "Failed to create transaction" });
  }
});

// PATCH /transactions/:id
router.patch("/:id", async (req, res) => {
  try {
    const tx = await prisma.transaction.findUnique({ where: { id: req.params.id } });
    if (!tx) return res.status(404).json({ error: "Transaction not found" });
    if (!(await ownsBusiness(req,tx.businessId)))
      return res.status(403).json({ error: "Forbidden" });
    const { amount, description, category, paymentMethod, date } = req.body;
    // Refuse to edit a bank-ledger row, or to convert a manual row INTO one — either
    // would move the spendable balance behind the banking system's back.
    if (isBankLedgerRow(tx) || paymentMethod === "bank" || req.body.source
        || (paymentMethod === undefined && category === "transfer" && tx.paymentMethod === "bank")) {
      await audit({ req, action: "TXN_EDIT_BANK_BLOCKED", resourceType: "transaction", resourceId: tx.id, severity: "warning", metadata: { source: tx.source, paymentMethod: tx.paymentMethod, category: tx.category } }).catch(() => {});
      return res.status(403).json({ error: "Bank transactions can't be edited.", code: "BANK_ROW_IMMUTABLE" });
    }
    const updated = await prisma.transaction.update({
      where: { id: req.params.id },
      data: {
        ...(amount !== undefined && { amount: Number(amount) }),
        ...(description !== undefined && { description }),
        ...(category !== undefined && { category }),
        ...(paymentMethod !== undefined && { paymentMethod }),
        ...(date !== undefined && { date: new Date(date) }),
      },
    });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: "Failed to update transaction" });
  }
});

// DELETE /transactions/:id
router.delete("/:id", async (req, res) => {
  try {
    const tx = await prisma.transaction.findUnique({
      where: { id: req.params.id },
    });
    if (!tx) return res.status(404).json({ error: "Transaction not found" });
    if (!(await ownsBusiness(req,tx.businessId)))
      return res.status(403).json({ error: "Forbidden" });

    // Deleting a bank-ledger row would re-inflate/understate the spendable balance.
    if (isBankLedgerRow(tx)) {
      await audit({ req, action: "TXN_DELETE_BANK_BLOCKED", resourceType: "transaction", resourceId: tx.id, severity: "warning", metadata: { source: tx.source, paymentMethod: tx.paymentMethod, category: tx.category } }).catch(() => {});
      return res.status(403).json({ error: "Bank transactions can't be deleted.", code: "BANK_ROW_IMMUTABLE" });
    }

    await prisma.transaction.delete({ where: { id: req.params.id } });
    res.json({ message: "Deleted" });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete transaction" });
  }
});

// POST /transactions/:id/match  { saleId }
router.post("/:id/match", async (req, res) => {
  const { saleId } = req.body;
  if (!saleId) return res.status(400).json({ error: "saleId required" });
  try {
    const tx = await prisma.transaction.findUnique({ where: { id: req.params.id } });
    if (!tx) return res.status(404).json({ error: "Transaction not found" });
    if (!(await ownsBusiness(req,tx.businessId)))
      return res.status(403).json({ error: "Forbidden" });

    const sale = await prisma.sales.findUnique({ where: { id: saleId } });
    if (!sale) return res.status(404).json({ error: "Sale not found" });
    if (sale.userId !== getTargetUserId(req))
      return res.status(403).json({ error: "Forbidden" });

    await Promise.all([
      prisma.transaction.update({ where: { id: tx.id }, data: { matchedSaleId: saleId } }),
      prisma.sales.update({ where: { id: saleId }, data: { matchedTransactionId: tx.id } }),
    ]);
    res.json({ matched: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to match" });
  }
});

// POST /transactions/:id/match-debt  { customerId }
// Links the transfer to a customer and records a debt payment for the transfer amount
router.post("/:id/match-debt", async (req, res) => {
  const { customerId } = req.body;
  if (!customerId) return res.status(400).json({ error: "customerId required" });
  try {
    const tx = await prisma.transaction.findUnique({ where: { id: req.params.id } });
    if (!tx) return res.status(404).json({ error: "Transaction not found" });
    if (!(await ownsBusiness(req,tx.businessId)))
      return res.status(403).json({ error: "Forbidden" });

    const customer = await prisma.customer.findUnique({ where: { id: customerId } });
    if (!customer) return res.status(404).json({ error: "Customer not found" });
    if (customer.userId !== getTargetUserId(req))
      return res.status(403).json({ error: "Forbidden" });

    // Find oldest unpaid debt for this customer
    const unpaidDebts = await prisma.debt.findMany({
      where: { customerId, paid: false },
      orderBy: { date: "asc" },
    });

    let remaining = Number(tx.amount);
    for (const debt of unpaidDebts) {
      if (remaining <= 0) break;
      const outstanding = debt.amount - debt.paidAmount;
      const payment = Math.min(outstanding, remaining);
      const newPaid = debt.paidAmount + payment;
      const fullyPaid = newPaid >= debt.amount;
      await prisma.debt.update({
        where: { id: debt.id },
        data: { paidAmount: newPaid, paid: fullyPaid },
      });
      await prisma.debtPayment.create({
        data: { debtId: debt.id, amount: payment, note: `Bank transfer: ${tx.description || ""}` },
      });
      remaining -= payment;
    }

    // Recalculate totalOwed
    const allDebts = await prisma.debt.findMany({ where: { customerId } });
    const totalOwed = allDebts.reduce((s, d) => s + Math.max(0, d.amount - d.paidAmount), 0);
    await prisma.customer.update({ where: { id: customerId }, data: { totalOwed } });

    // Link transaction to customer
    await prisma.transaction.update({ where: { id: tx.id }, data: { matchedCustomerId: customerId } });

    res.json({ matched: true, amountApplied: Number(tx.amount) - remaining });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to match debt" });
  }
});

// DELETE /transactions/:id/match
router.delete("/:id/match", async (req, res) => {
  try {
    const tx = await prisma.transaction.findUnique({ where: { id: req.params.id } });
    if (!tx) return res.status(404).json({ error: "Transaction not found" });
    if (!(await ownsBusiness(req,tx.businessId)))
      return res.status(403).json({ error: "Forbidden" });

    if (tx.matchedSaleId) {
      await prisma.sales.update({ where: { id: tx.matchedSaleId }, data: { matchedTransactionId: null } }).catch(() => {});
    }
    await prisma.transaction.update({ where: { id: tx.id }, data: { matchedSaleId: null, matchedCustomerId: null } });
    res.json({ matched: false });
  } catch (err) {
    res.status(500).json({ error: "Failed to unmatch" });
  }
});

module.exports = router;
