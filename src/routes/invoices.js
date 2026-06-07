const router = require("express").Router();
const prisma = require("../utils/db");
const authMiddleware = require("../middleware/auth");

// ── Helpers ───────────────────────────────────────────────────────────────────

function getTargetUserId(req) {
  return req.user.accountType === "staff" ? req.user.employerId : req.user.id;
}

async function ownsBusiness(req, businessId) {
  const userId = getTargetUserId(req);
  return prisma.business.findFirst({ where: { id: businessId, userId } });
}

function calcStatus(invoice) {
  const { amountPaid, total, dueDate, status } = invoice;
  if (status === "VOID") return "VOID";
  if (amountPaid >= total && total > 0) return "PAID";
  if (amountPaid > 0) {
    if (dueDate && new Date(dueDate) < new Date()) return "OVERDUE";
    return "PARTIAL";
  }
  if (dueDate && new Date(dueDate) < new Date() && status !== "DRAFT") return "OVERDUE";
  return status;
}

function formatInvoice(inv) {
  return {
    ...inv,
    status: inv.status,
    items: inv.items || [],
    payments: inv.payments || [],
    customer: inv.customer
      ? { id: inv.customer.id, name: inv.customer.name, phone: inv.customer.phone }
      : null,
  };
}

const INCLUDE = {
  items: true,
  payments: { orderBy: { date: "asc" } },
  customer: { select: { id: true, name: true, phone: true } },
};

// ── GET /invoices ─────────────────────────────────────────────────────────────
router.get("/", authMiddleware, async (req, res) => {
  try {
    const { businessId, status, dateFrom, dateTo, since } = req.query;
    if (!businessId) return res.status(400).json({ error: "businessId required" });
    if (!(await ownsBusiness(req, businessId)))
      return res.status(403).json({ error: "Access denied" });

    const where = { businessId };
    if (since) {
      where.updatedAt = { gt: new Date(since) };
    } else {
      if (status) where.status = status.toUpperCase();
      if (dateFrom || dateTo) {
        where.issueDate = {};
        if (dateFrom) where.issueDate.gte = dateFrom;
        if (dateTo) where.issueDate.lte = dateTo;
      }
    }

    const invoices = await prisma.invoice.findMany({
      where,
      include: INCLUDE,
      orderBy: since ? { updatedAt: "asc" } : { createdAt: "desc" },
    });

    // Recalculate overdue status on the fly
    const now = new Date().toISOString().slice(0, 10);
    const result = invoices.map((inv) => {
      if (
        inv.status !== "PAID" &&
        inv.status !== "VOID" &&
        inv.dueDate &&
        inv.dueDate < now
      ) {
        return { ...formatInvoice(inv), status: "OVERDUE" };
      }
      return formatInvoice(inv);
    });

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch invoices" });
  }
});

// ── POST /invoices ────────────────────────────────────────────────────────────
router.post("/", authMiddleware, async (req, res) => {
  try {
    const userId = getTargetUserId(req);
    const {
      businessId,
      customerId,
      issueDate,
      dueDate,
      items = [],
      taxRate = 0,
      discountType,
      discountValue = 0,
      notes,
      terms,
      template = "classic",
      status = "DRAFT",
    } = req.body;

    if (!businessId) return res.status(400).json({ error: "businessId required" });
    if (!issueDate) return res.status(400).json({ error: "issueDate required" });
    if (items.length === 0) return res.status(400).json({ error: "At least one line item required" });

    const biz = await ownsBusiness(req, businessId);
    if (!biz) return res.status(403).json({ error: "Access denied" });

    // Auto-increment invoice counter
    const updatedBiz = await prisma.business.update({
      where: { id: businessId },
      data: { invoiceCounter: { increment: 1 } },
    });
    const invoiceNumber = `INV-${String(updatedBiz.invoiceCounter).padStart(3, "0")}`;

    // Calculate totals
    const subtotal = items.reduce((sum, it) => sum + (Number(it.quantity) || 1) * (Number(it.rate) || 0), 0);
    const taxAmount = subtotal * ((Number(taxRate) || 0) / 100);
    let discountAmount = 0;
    if (discountType === "percent") {
      discountAmount = subtotal * ((Number(discountValue) || 0) / 100);
    } else if (discountType === "fixed") {
      discountAmount = Number(discountValue) || 0;
    }
    const total = Math.max(0, subtotal + taxAmount - discountAmount);

    const invoice = await prisma.invoice.create({
      data: {
        businessId,
        customerId: customerId || null,
        userId,
        invoiceNumber,
        status: status.toUpperCase(),
        issueDate,
        dueDate: dueDate || null,
        subtotal,
        taxRate: Number(taxRate) || 0,
        taxAmount,
        discountType: discountType || null,
        discountValue: Number(discountValue) || 0,
        discountAmount,
        total,
        notes: notes || null,
        terms: terms || null,
        template,
        items: {
          create: items.map((it) => ({
            name: it.name,
            description: it.description || null,
            quantity: Number(it.quantity) || 1,
            rate: Number(it.rate) || 0,
            amount: (Number(it.quantity) || 1) * (Number(it.rate) || 0),
          })),
        },
      },
      include: INCLUDE,
    });

    res.status(201).json(formatInvoice(invoice));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create invoice" });
  }
});

// ── GET /invoices/:id ─────────────────────────────────────────────────────────
router.get("/:id", authMiddleware, async (req, res) => {
  try {
    const invoice = await prisma.invoice.findUnique({
      where: { id: req.params.id },
      include: INCLUDE,
    });
    if (!invoice) return res.status(404).json({ error: "Invoice not found" });
    if (!(await ownsBusiness(req, invoice.businessId)))
      return res.status(403).json({ error: "Access denied" });
    res.json(formatInvoice(invoice));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch invoice" });
  }
});

// ── PUT /invoices/:id ─────────────────────────────────────────────────────────
router.put("/:id", authMiddleware, async (req, res) => {
  try {
    const existing = await prisma.invoice.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: "Invoice not found" });
    if (!(await ownsBusiness(req, existing.businessId)))
      return res.status(403).json({ error: "Access denied" });
    if (existing.status === "VOID" || existing.status === "PAID")
      return res.status(400).json({ error: "Cannot edit a PAID or VOID invoice" });

    const {
      customerId,
      issueDate,
      dueDate,
      items = [],
      taxRate = 0,
      discountType,
      discountValue = 0,
      notes,
      terms,
      template,
    } = req.body;

    const subtotal = items.reduce((sum, it) => sum + (Number(it.quantity) || 1) * (Number(it.rate) || 0), 0);
    const taxAmount = subtotal * ((Number(taxRate) || 0) / 100);
    let discountAmount = 0;
    if (discountType === "percent") {
      discountAmount = subtotal * ((Number(discountValue) || 0) / 100);
    } else if (discountType === "fixed") {
      discountAmount = Number(discountValue) || 0;
    }
    const total = Math.max(0, subtotal + taxAmount - discountAmount);

    // Replace all items
    await prisma.invoiceItem.deleteMany({ where: { invoiceId: req.params.id } });

    const invoice = await prisma.invoice.update({
      where: { id: req.params.id },
      data: {
        customerId: customerId || null,
        issueDate: issueDate || existing.issueDate,
        dueDate: dueDate || null,
        subtotal,
        taxRate: Number(taxRate) || 0,
        taxAmount,
        discountType: discountType || null,
        discountValue: Number(discountValue) || 0,
        discountAmount,
        total,
        notes: notes || null,
        terms: terms || null,
        template: template || existing.template,
        items: {
          create: items.map((it) => ({
            name: it.name,
            description: it.description || null,
            quantity: Number(it.quantity) || 1,
            rate: Number(it.rate) || 0,
            amount: (Number(it.quantity) || 1) * (Number(it.rate) || 0),
          })),
        },
      },
      include: INCLUDE,
    });

    res.json(formatInvoice(invoice));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update invoice" });
  }
});

// ── PATCH /invoices/:id/status ────────────────────────────────────────────────
router.patch("/:id/status", authMiddleware, async (req, res) => {
  try {
    const { status } = req.body;
    if (!status) return res.status(400).json({ error: "status required" });

    const existing = await prisma.invoice.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: "Invoice not found" });
    if (!(await ownsBusiness(req, existing.businessId)))
      return res.status(403).json({ error: "Access denied" });

    const newStatus = status.toUpperCase();
    const allowed = ["SENT", "VOID", "DRAFT"];
    if (!allowed.includes(newStatus))
      return res.status(400).json({ error: `Status must be one of: ${allowed.join(", ")}` });

    const invoice = await prisma.invoice.update({
      where: { id: req.params.id },
      data: { status: newStatus },
      include: INCLUDE,
    });
    res.json(formatInvoice(invoice));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update status" });
  }
});

// ── POST /invoices/:id/payments ───────────────────────────────────────────────
router.post("/:id/payments", authMiddleware, async (req, res) => {
  try {
    const { amount, method = "cash", note, date } = req.body;
    if (!amount || Number(amount) <= 0)
      return res.status(400).json({ error: "Valid amount required" });

    const existing = await prisma.invoice.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: "Invoice not found" });
    if (!(await ownsBusiness(req, existing.businessId)))
      return res.status(403).json({ error: "Access denied" });
    if (existing.status === "VOID")
      return res.status(400).json({ error: "Cannot record payment on a VOID invoice" });

    const outstanding = Math.max(0, existing.total - existing.amountPaid);
    if (outstanding <= 0)
      return res.status(400).json({ error: "This invoice is already paid in full." });
    if (Number(amount) > outstanding)
      return res.status(400).json({
        error: `Payment exceeds outstanding balance of ${outstanding.toFixed(2)}.`,
      });

    const paymentDate = date ? new Date(date) : new Date();
    await prisma.invoicePayment.create({
      data: {
        invoiceId: req.params.id,
        amount: Number(amount),
        method,
        note: note || null,
        date: paymentDate,
      },
    });

    const newAmountPaid = existing.amountPaid + Number(amount);
    const now = new Date().toISOString().slice(0, 10);
    let newStatus;
    if (newAmountPaid >= existing.total) {
      newStatus = "PAID";
    } else if (existing.dueDate && existing.dueDate < now) {
      newStatus = "OVERDUE";
    } else {
      newStatus = "PARTIAL";
    }

    const invoice = await prisma.invoice.update({
      where: { id: req.params.id },
      data: { amountPaid: newAmountPaid, status: newStatus },
      include: INCLUDE,
    });

    res.status(201).json(formatInvoice(invoice));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to record payment" });
  }
});

// ── POST /invoices/:id/share-link ─────────────────────────────────────────────
// Returns (and creates if missing) a public link customers can open without
// auth. Idempotent — multiple calls return the same token.
router.post("/:id/share-link", authMiddleware, async (req, res) => {
  try {
    const existing = await prisma.invoice.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: "Invoice not found" });
    if (!(await ownsBusiness(req, existing.businessId)))
      return res.status(403).json({ error: "Access denied" });

    let link = await prisma.invoiceShareLink.findUnique({
      where: { invoiceId: req.params.id },
    });
    if (!link) {
      const token = require("crypto").randomBytes(16).toString("base64url");
      link = await prisma.invoiceShareLink.create({
        data: { invoiceId: req.params.id, token },
      });
    }

    const base = process.env.PUBLIC_BASE_URL ||
      `${req.protocol}://${req.get("host")}`;
    res.json({ token: link.token, url: `${base}/i/${link.token}` });
  } catch (err) {
    console.error("share-link error:", err);
    res.status(500).json({ error: "Failed to create share link" });
  }
});

// ── DELETE /invoices/:id ──────────────────────────────────────────────────────
router.delete("/:id", authMiddleware, async (req, res) => {
  try {
    const existing = await prisma.invoice.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: "Invoice not found" });
    if (!(await ownsBusiness(req, existing.businessId)))
      return res.status(403).json({ error: "Access denied" });

    await prisma.invoice.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete invoice" });
  }
});

module.exports = router;
