const router = require("express").Router();
const prisma = require("../utils/db");
const authMiddleware = require("../middleware/auth");
const {
  allocateInvoiceNumber,
  formatInvoiceNumber,
  invoicePrefixOf,
  normalizePrefix,
  normalizeNextNumber,
} = require("../utils/invoiceNumber");

// ── Helpers ───────────────────────────────────────────────────────────────────

const PAYMENT_TERMS = new Set([
  "due_on_receipt", "net_15", "net_30", "net_45", "net_60",
  "due_end_of_month", "due_end_of_next_month", "custom",
]);

function cleanText(v, max) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}

// The invoice's customer. A customerId must belong to this owner. With no id,
// or an id the server has not seen yet (a customer the app created a moment
// ago, still in flight), a typed name finds that owner's customer of the same
// name in this business or creates one. Invoice has no name column of its own,
// so before this a hand-typed customer vanished from the invoice on next sync.
async function resolveCustomerId(body, businessId, ownerUserId) {
  const id = body.customerId ? String(body.customerId) : null;
  if (id) {
    const own = await prisma.customer.findFirst({ where: { id, userId: ownerUserId }, select: { id: true } });
    if (own) return own.id;
  }
  const name = typeof body.customerName === "string" ? body.customerName.trim().slice(0, 100) : "";
  if (!name) return null;
  const same = await prisma.customer.findFirst({
    where: { userId: ownerUserId, businessId, name: { equals: name, mode: "insensitive" } },
    select: { id: true },
  });
  if (same) return same.id;
  const created = await prisma.customer.create({
    data: { userId: ownerUserId, businessId, name },
    select: { id: true },
  });
  return created.id;
}

// The optional detail fields from the Add Invoice screen. Only keys present in
// the body come back, so an update that leaves them out does not wipe them.
async function readDetailFields(body, targetUserId) {
  const out = {};
  if ("paymentTerms" in body) {
    out.paymentTerms = PAYMENT_TERMS.has(body.paymentTerms) ? body.paymentTerms : null;
  }
  if ("orderNumber" in body) out.orderNumber = cleanText(body.orderNumber, 50);
  if ("subject" in body) out.subject = cleanText(body.subject, 250);
  if ("salespersonId" in body) {
    out.salespersonId = null;
    out.salespersonName = null;
    const id = body.salespersonId ? String(body.salespersonId) : null;
    if (id) {
      // The owner or one of the owner's staff, nobody else. An unknown id is
      // dropped rather than refused: the app saves invoices optimistically, and
      // failing the whole invoice over a stale staff pick would lose it.
      const person = await prisma.user.findFirst({
        where: { id, OR: [{ id: targetUserId }, { employerId: targetUserId }] },
        select: { id: true, firstName: true, lastName: true },
      });
      if (person) {
        out.salespersonId = person.id;
        out.salespersonName = `${person.firstName || ""} ${person.lastName || ""}`.trim() || null;
      }
    }
  }
  return out;
}

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
    const { businessId, status, type, dateFrom, dateTo, since } = req.query;
    if (!businessId) return res.status(400).json({ error: "businessId required" });
    if (!(await ownsBusiness(req, businessId)))
      return res.status(403).json({ error: "Access denied" });

    // Coerce + validate any date input before it reaches Prisma.
    const toDate = (v, label) => {
      const d = new Date(v);
      if (isNaN(d.getTime())) {
        const e = new Error(`Invalid ${label}`);
        e.status = 400;
        throw e;
      }
      return d;
    };

    const where = { businessId };
    if (since) {
      where.updatedAt = { gt: toDate(since, "since") };
    } else {
      if (status) where.status = status.toUpperCase();
      if (type) where.type = type; // "invoice" | "quote"
      if (dateFrom || dateTo) {
        where.issueDate = {};
        if (dateFrom) where.issueDate.gte = toDate(dateFrom, "dateFrom");
        if (dateTo) where.issueDate.lte = toDate(dateTo, "dateTo");
      }
    }

    const invoices = await prisma.invoice.findMany({
      where,
      include: INCLUDE,
      orderBy: since ? { updatedAt: "asc" } : { createdAt: "desc" },
    });

    // Recalculate overdue status on the fly. dueDate is a Lagos wall-calendar
    // "YYYY-MM-DD" string — compare against the Lagos date, not UTC (they
    // differ between 00:00 and 01:00 WAT).
    const now = new Date(Date.now() + 60 * 60 * 1000).toISOString().slice(0, 10);
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
    if (err.status === 400) return res.status(400).json({ error: err.message });
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
      type = "invoice",
    } = req.body;

    if (!businessId) return res.status(400).json({ error: "businessId required" });
    if (!issueDate) return res.status(400).json({ error: "issueDate required" });
    if (items.length === 0) return res.status(400).json({ error: "At least one line item required" });

    const biz = await ownsBusiness(req, businessId);
    if (!biz) return res.status(403).json({ error: "Access denied" });

    const details = await readDetailFields(req.body, userId);
    const resolvedCustomerId = await resolveCustomerId(req.body, businessId, userId);

    // Next number off the business counter, with the owner's prefix.
    const isQuote = type === "quote";
    const invoiceNumber = await allocateInvoiceNumber(prisma, businessId, isQuote ? "quote" : "invoice");

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
        customerId: resolvedCustomerId,
        userId,
        invoiceNumber,
        type: isQuote ? "quote" : "invoice",
        // A new document is a draft or sent. PAID and the rest come from
        // payments, never from the create body.
        status: String(status).toUpperCase() === "SENT" ? "SENT" : "DRAFT",
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
        ...details,
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

// ── PATCH /invoices/numbering ─────────────────────────────────────────────────
// The gear beside Invoice# on the Add Invoice screen. Owner only: the prefix
// and the next number apply to every invoice the business issues from now on.
router.patch("/numbering", authMiddleware, async (req, res) => {
  try {
    if (req.user.accountType === "staff") {
      return res.status(403).json({ error: "Only the owner can change invoice numbering.", code: "OWNER_ONLY" });
    }
    const body = req.body || {};
    if (!body.businessId) return res.status(400).json({ error: "businessId required" });
    const biz = await ownsBusiness(req, body.businessId);
    if (!biz) return res.status(403).json({ error: "Access denied" });

    const prefix = body.prefix === undefined ? invoicePrefixOf(biz) : normalizePrefix(body.prefix);
    if (prefix === null) {
      return res.status(400).json({
        error: "Use up to 10 letters, numbers or - _ / . # for the prefix.",
        code: "BAD_PREFIX",
      });
    }
    const next = body.nextNumber === undefined ? biz.invoiceCounter + 1 : normalizeNextNumber(body.nextNumber);
    if (next === null) {
      return res.status(400).json({ error: "The next number must be a whole number from 1.", code: "BAD_NUMBER" });
    }

    // Refuse a starting point that is already taken, so the owner hears about
    // it now instead of the allocator silently skipping ahead later.
    const number = formatInvoiceNumber(prefix, next);
    const clash = await prisma.invoice.findFirst({
      where: { businessId: biz.id, invoiceNumber: number },
      select: { id: true },
    });
    if (clash) {
      return res.status(409).json({ error: `${number} is already used.`, code: "NUMBER_IN_USE", number });
    }

    const updated = await prisma.business.update({
      where: { id: biz.id },
      data: { invoicePrefix: prefix, invoiceCounter: next - 1 },
      select: { invoicePrefix: true, invoiceCounter: true },
    });
    res.json({ ...updated, next: number });
  } catch (err) {
    console.error("invoice numbering error:", err);
    res.status(500).json({ error: "Failed to update invoice numbering" });
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

    const details = await readDetailFields(req.body, getTargetUserId(req));
    const resolvedCustomerId = await resolveCustomerId(req.body, existing.businessId, getTargetUserId(req));

    // "Save and send" from the editor moves a draft to SENT. Nothing else can
    // change status here: payments and voiding have their own routes.
    const statusPatch =
      typeof req.body.status === "string" &&
      req.body.status.toUpperCase() === "SENT" &&
      existing.status === "DRAFT"
        ? { status: "SENT" }
        : {};

    // Replace all items
    await prisma.invoiceItem.deleteMany({ where: { invoiceId: req.params.id } });

    const invoice = await prisma.invoice.update({
      where: { id: req.params.id },
      data: {
        ...details,
        ...statusPatch,
        customerId: resolvedCustomerId,
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
    if (existing.type === "quote")
      return res.status(403).json({ error: "Quotes can't take payments — convert it to an invoice first.", code: "QUOTE_NO_PAYMENT" });
    if (existing.status === "VOID")
      return res.status(400).json({ error: "Cannot record payment on a VOID invoice" });

    // Serialize payments per business so two concurrent posts can't both read a
    // stale amountPaid and overpay / lose an update. Re-read inside the lock.
    const invoice = await prisma.withBusinessLock(existing.businessId, async () => {
      const inv = await prisma.invoice.findUnique({ where: { id: req.params.id } });
      const outstanding = Math.max(0, inv.total - inv.amountPaid);
      if (outstanding <= 0) {
        const e = new Error("This invoice is already paid in full.");
        e.status = 400;
        throw e;
      }
      if (Number(amount) > outstanding) {
        const e = new Error(`Payment exceeds outstanding balance of ${outstanding.toFixed(2)}.`);
        e.status = 400;
        throw e;
      }

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

      const newAmountPaid = inv.amountPaid + Number(amount);
      // Lagos date, matching the overdue recalculation above.
      const today = new Date(Date.now() + 60 * 60 * 1000).toISOString().slice(0, 10);
      let newStatus;
      if (newAmountPaid >= inv.total) {
        newStatus = "PAID";
      } else if (inv.dueDate && inv.dueDate < today) {
        newStatus = "OVERDUE";
      } else {
        newStatus = "PARTIAL";
      }

      return prisma.invoice.update({
        where: { id: req.params.id },
        data: { amountPaid: newAmountPaid, status: newStatus },
        include: INCLUDE,
      });
    });

    res.status(201).json(formatInvoice(invoice));
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
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

// ── POST /invoices/:id/convert-to-invoice ─────────────────────────────────────
// Turn an accepted quote into a real invoice: flip type, assign a fresh INV-
// number off the business counter, reset to DRAFT so it can be sent + paid.
router.post("/:id/convert-to-invoice", authMiddleware, async (req, res) => {
  try {
    const existing = await prisma.invoice.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: "Invoice not found" });
    if (!(await ownsBusiness(req, existing.businessId)))
      return res.status(403).json({ error: "Access denied" });
    if (existing.type !== "quote")
      return res.status(400).json({ error: "Only a quote can be converted." });

    const invoiceNumber = await allocateInvoiceNumber(prisma, existing.businessId, "invoice");

    const invoice = await prisma.invoice.update({
      where: { id: req.params.id },
      data: { type: "invoice", invoiceNumber, status: "DRAFT" },
      include: INCLUDE,
    });
    res.json(formatInvoice(invoice));
  } catch (err) {
    console.error("convert error:", err);
    res.status(500).json({ error: "Failed to convert quote" });
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
