const router = require("express").Router();
const prisma = require("../utils/db");
const authMiddleware = require("../middleware/auth");
const {
  allocateInvoiceNumber,
  formatInvoiceNumber,
  prefixOf,
  seriesOf,
  normalizePrefix,
  normalizeNextNumber,
  normalizeManualNumber,
  numberTaken,
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

// Numbering responses use the invoice field names for either run of numbers,
// so the app reads one shape; `kind` says which run it was.
function numberingOut(row, series) {
  return {
    invoicePrefix: row[series.prefix] ?? null,
    invoiceCounter: row[series.counter],
    invoiceNumberMode: row[series.mode] === "manual" ? "manual" : "auto",
  };
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

    // A number the owner typed ("manually each time" or "only for this
    // invoice"). Nothing typed means the server numbers it, whatever the
    // business's mode: an older app that never sends one must still work.
    const manualNumber = normalizeManualNumber(req.body.invoiceNumber);
    if (manualNumber === null) {
      return res.status(400).json({
        error: "Use up to 30 letters, numbers, spaces or - _ / . # for the invoice number.",
        code: "BAD_INVOICE_NUMBER",
      });
    }

    const details = await readDetailFields(req.body, userId);
    const resolvedCustomerId = await resolveCustomerId(req.body, businessId, userId);
    // invoice | quote | credit_note. A credit note is a credit TO the customer:
    // no payment terms and no due date.
    const docType = type === "quote" || type === "credit_note" ? type : "invoice";
    const isCredit = docType === "credit_note";
    if (isCredit) details.paymentTerms = null;

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

    // Choosing the number and writing the invoice happen under the business
    // lock, the same one the recurring runner and Instagram orders hold while
    // they number theirs, so a typed number and an automatic one can never land
    // on the same value.
    const invoice = await prisma.withBusinessLock(businessId, async () => {
      let invoiceNumber;
      if (manualNumber) {
        if (await numberTaken(prisma, businessId, manualNumber)) {
          throw Object.assign(new Error(`${manualNumber} is already used.`), {
            status: 409, code: "NUMBER_IN_USE", number: manualNumber,
          });
        }
        invoiceNumber = manualNumber;
      } else {
        invoiceNumber = await allocateInvoiceNumber(prisma, businessId, docType);
      }
      return prisma.invoice.create({
        data: {
          businessId,
          customerId: resolvedCustomerId,
          userId,
          invoiceNumber,
          type: docType,
          // A new document is a draft or sent. PAID and the rest come from
          // payments, never from the create body.
          status: String(status).toUpperCase() === "SENT" ? "SENT" : "DRAFT",
          issueDate,
          dueDate: isCredit ? null : dueDate || null,
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
    });

    res.status(201).json(formatInvoice(invoice));
  } catch (err) {
    if (err.status === 409) {
      return res.status(409).json({ error: err.message, code: err.code, number: err.number });
    }
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

    // Which run of numbers: invoices (shared with quotes) or credit notes.
    const kind = body.kind === "credit_note" ? "credit_note" : "invoice";
    const series = seriesOf(kind);

    // auto: the server issues the next number (prefix + counter).
    // manual: the app asks for a number on every new document. The prefix and
    // counter are kept so switching back to auto carries on where it was.
    const mode = body.mode === undefined ? (biz[series.mode] === "manual" ? "manual" : "auto") : body.mode;
    if (mode !== "auto" && mode !== "manual") {
      return res.status(400).json({ error: "Numbering is auto or manual.", code: "BAD_MODE" });
    }
    if (mode === "manual") {
      const updated = await prisma.business.update({
        where: { id: biz.id },
        data: { [series.mode]: "manual" },
        select: { [series.prefix]: true, [series.counter]: true, [series.mode]: true },
      });
      return res.json({ ...numberingOut(updated, series), kind, next: null });
    }

    const prefix = body.prefix === undefined ? prefixOf(biz, kind) : normalizePrefix(body.prefix, kind);
    if (prefix === null) {
      return res.status(400).json({
        error: "Use up to 10 letters, numbers or - _ / . # for the prefix.",
        code: "BAD_PREFIX",
      });
    }
    const next = body.nextNumber === undefined ? biz[series.counter] + 1 : normalizeNextNumber(body.nextNumber);
    if (next === null) {
      return res.status(400).json({ error: "The next number must be a whole number from 1.", code: "BAD_NUMBER" });
    }

    // Refuse a starting point that is already taken, so the owner hears about
    // it now instead of the allocator silently skipping ahead later. Under the
    // business lock, like every other read-then-write of the counter.
    const number = formatInvoiceNumber(prefix, next);
    const result = await prisma.withBusinessLock(biz.id, async () => {
      if (await numberTaken(prisma, biz.id, number)) return null;
      return prisma.business.update({
        where: { id: biz.id },
        data: { [series.prefix]: prefix, [series.counter]: next - 1, [series.mode]: "auto" },
        select: { [series.prefix]: true, [series.counter]: true, [series.mode]: true },
      });
    });
    if (!result) {
      return res.status(409).json({ error: `${number} is already used.`, code: "NUMBER_IN_USE", number });
    }
    res.json({ ...numberingOut(result, series), kind, next: number });
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

    // A credit note cannot shrink below the credit already used from it.
    const isCredit = existing.type === "credit_note";
    if (isCredit && total + 0.005 < (existing.amountPaid || 0)) {
      return res.status(400).json({
        error: "This credit note has credit in use; its total cannot go below that.",
        code: "CREDIT_BELOW_USED",
        used: existing.amountPaid,
      });
    }

    const details = await readDetailFields(req.body, getTargetUserId(req));
    if (isCredit && "paymentTerms" in details) details.paymentTerms = null;
    const resolvedCustomerId = await resolveCustomerId(req.body, existing.businessId, getTargetUserId(req));

    // "Save and send" from the editor moves a draft to SENT. Nothing else can
    // change status here: payments and voiding have their own routes.
    const statusPatch =
      typeof req.body.status === "string" &&
      req.body.status.toUpperCase() === "SENT" &&
      existing.status === "DRAFT"
        ? { status: "SENT" }
        : {};

    // A draft's number can be corrected (a typed number with a typo). Once
    // the invoice has gone out, its number is fixed.
    let newNumber = null;
    if ("invoiceNumber" in req.body) {
      const n = normalizeManualNumber(req.body.invoiceNumber);
      if (n === null) {
        return res.status(400).json({
          error: "Use up to 30 letters, numbers, spaces or - _ / . # for the invoice number.",
          code: "BAD_INVOICE_NUMBER",
        });
      }
      if (n && n !== existing.invoiceNumber) {
        if (existing.status !== "DRAFT") {
          return res.status(400).json({ error: "Only a draft's number can be changed.", code: "NUMBER_LOCKED" });
        }
        newNumber = n;
      }
    }

    // The duplicate check runs before anything is written, and under the
    // business lock when the number changes, like a create.
    const writeUpdate = async () => {
      if (newNumber && (await numberTaken(prisma, existing.businessId, newNumber, existing.id))) {
        throw Object.assign(new Error(`${newNumber} is already used.`), {
          status: 409, code: "NUMBER_IN_USE", number: newNumber,
        });
      }

      // Replace all items
      await prisma.invoiceItem.deleteMany({ where: { invoiceId: req.params.id } });

      return prisma.invoice.update({
        where: { id: req.params.id },
        data: {
          ...details,
          ...statusPatch,
          ...(newNumber ? { invoiceNumber: newNumber } : {}),
          customerId: resolvedCustomerId,
          issueDate: issueDate || existing.issueDate,
          dueDate: isCredit ? null : dueDate || null,
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
    };
    const invoice = newNumber
      ? await prisma.withBusinessLock(existing.businessId, writeUpdate)
      : await writeUpdate();

    res.json(formatInvoice(invoice));
  } catch (err) {
    if (err.status === 409) {
      return res.status(409).json({ error: err.message, code: err.code, number: err.number });
    }
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

    // SENT is how a draft goes out (or a credit note opens). On anything past
    // draft it would wipe PARTIAL or PAID, so it changes nothing there.
    if (newStatus === "SENT" && existing.status !== "DRAFT") {
      const same = await prisma.invoice.findUnique({ where: { id: existing.id }, include: INCLUDE });
      return res.json(formatInvoice(same));
    }
    // Money or credit already on a document pins it: a credit note that has
    // given credit cannot be voided or redrafted, an invoice that received
    // credit cannot be voided, and nothing with payments goes back to draft.
    // Otherwise the credit would vanish from one side of the link.
    if (existing.type === "credit_note" && (existing.amountPaid || 0) > 0 && newStatus !== "SENT") {
      return res.status(409).json({ error: "This credit note has been used.", code: "CREDIT_IN_USE" });
    }
    if (existing.type !== "credit_note" && newStatus === "VOID") {
      const applied = await prisma.creditApplication.count({ where: { invoiceId: existing.id } });
      if (applied) {
        return res.status(409).json({ error: "Credit has been applied to this invoice.", code: "CREDITS_APPLIED" });
      }
    }
    if (newStatus === "DRAFT" && (existing.amountPaid || 0) > 0) {
      return res.status(409).json({ error: "Payments are recorded on this document.", code: "PAYMENTS_RECORDED" });
    }

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
    if (existing.type === "credit_note")
      return res.status(403).json({ error: "A credit note is used by applying it to an invoice or recording a refund.", code: "CREDIT_NOTE_NO_PAYMENT" });
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

// ── Credit notes: apply to an invoice, or refund ───────────────────────────────
// A credit note's amountPaid is the credit already used. Both routes re-read
// both documents under the business lock and write everything in one
// transaction, so two taps (or two phones) cannot spend the same credit twice.

const OPEN_STATUSES = ["SENT", "PARTIAL", "OVERDUE"];
const REFUND_METHODS = ["cash", "transfer", "card", "cheque", "other"];
const toMoney = (v) => Math.round(Number(v) * 100) / 100;

function creditError(status, code, error, extra = {}) {
  return Object.assign(new Error(error), { status, code, extra });
}
function sendCreditError(res, err, fallback) {
  if (err.status) return res.status(err.status).json({ error: err.message, code: err.code, ...err.extra });
  console.error(fallback, err);
  return res.status(500).json({ error: fallback });
}
// Lagos calendar day, like the overdue checks above.
const lagosToday = () => new Date(Date.now() + 60 * 60 * 1000).toISOString().slice(0, 10);

// POST /invoices/:id/apply-credit  { invoiceId, amount }  (:id = the credit note)
router.post("/:id/apply-credit", authMiddleware, async (req, res) => {
  try {
    const body = req.body || {};
    const invoiceId = body.invoiceId ? String(body.invoiceId) : null;
    const amount = toMoney(body.amount);
    if (!invoiceId) return res.status(400).json({ error: "invoiceId required" });
    if (!(amount > 0)) return res.status(400).json({ error: "Enter an amount.", code: "BAD_AMOUNT" });

    const note = await prisma.invoice.findUnique({ where: { id: req.params.id } });
    if (!note) return res.status(404).json({ error: "Credit note not found" });
    if (!(await ownsBusiness(req, note.businessId))) return res.status(403).json({ error: "Access denied" });
    if (note.type !== "credit_note") {
      return res.status(400).json({ error: "Only a credit note can be applied.", code: "NOT_A_CREDIT_NOTE" });
    }

    const result = await prisma.withBusinessLock(note.businessId, async () => {
      const cn = await prisma.invoice.findUnique({ where: { id: note.id } });
      const inv = await prisma.invoice.findUnique({ where: { id: invoiceId } });
      if (!inv || inv.businessId !== cn.businessId || (inv.type || "invoice") !== "invoice") {
        throw creditError(404, "INVOICE_NOT_FOUND", "Invoice not found.");
      }
      if (!OPEN_STATUSES.includes(cn.status)) {
        throw creditError(409, "CREDIT_NOT_OPEN", "This credit note is not open.");
      }
      if (!OPEN_STATUSES.includes(inv.status)) {
        throw creditError(409, "INVOICE_NOT_OPEN", "That invoice is not waiting for payment.");
      }
      // Credit belongs to one customer and can only pay that customer's invoices.
      if (!cn.customerId || cn.customerId !== inv.customerId) {
        throw creditError(409, "CUSTOMER_MISMATCH", "The credit note and the invoice are for different customers.");
      }
      const remaining = toMoney(cn.total - cn.amountPaid);
      const outstanding = toMoney(inv.total - inv.amountPaid);
      if (amount > remaining) {
        throw creditError(400, "EXCEEDS_CREDIT", "That is more than the credit left.", { remaining });
      }
      if (amount > outstanding) {
        throw creditError(400, "EXCEEDS_BALANCE", "That is more than the invoice still owes.", { outstanding });
      }

      const when = new Date();
      const invPaid = toMoney(inv.amountPaid + amount);
      const invStatus =
        invPaid >= toMoney(inv.total) ? "PAID" : inv.dueDate && inv.dueDate < lagosToday() ? "OVERDUE" : "PARTIAL";
      const cnUsed = toMoney(cn.amountPaid + amount);
      const cnStatus = cnUsed >= toMoney(cn.total) ? "PAID" : "PARTIAL";

      const [, , , updatedInvoice, updatedCredit] = await prisma.$transaction([
        prisma.creditApplication.create({
          data: { businessId: cn.businessId, creditNoteId: cn.id, invoiceId: inv.id, amount, date: when },
        }),
        // The invoice's balance falls like any payment; the method says it was credit.
        prisma.invoicePayment.create({
          data: { invoiceId: inv.id, amount, method: "credit_note", note: cn.invoiceNumber, date: when },
        }),
        // The credit note keeps its own record of where the credit went.
        prisma.invoicePayment.create({
          data: { invoiceId: cn.id, amount, method: "credit_applied", note: inv.invoiceNumber, date: when },
        }),
        prisma.invoice.update({ where: { id: inv.id }, data: { amountPaid: invPaid, status: invStatus }, include: INCLUDE }),
        prisma.invoice.update({ where: { id: cn.id }, data: { amountPaid: cnUsed, status: cnStatus }, include: INCLUDE }),
      ]);
      return { invoice: updatedInvoice, creditNote: updatedCredit };
    });

    res.status(201).json({ creditNote: formatInvoice(result.creditNote), invoice: formatInvoice(result.invoice) });
  } catch (err) {
    return sendCreditError(res, err, "Failed to apply credit");
  }
});

// POST /invoices/:id/refund  { amount, method, note?, date? }  (:id = the credit note)
// Records money given back to the customer. Like invoice payments, it is a
// record on the document; it does not write to the sales or expense books.
router.post("/:id/refund", authMiddleware, async (req, res) => {
  try {
    const body = req.body || {};
    const amount = toMoney(body.amount);
    const method = String(body.method || "cash").toLowerCase();
    if (!(amount > 0)) return res.status(400).json({ error: "Enter an amount.", code: "BAD_AMOUNT" });
    if (!REFUND_METHODS.includes(method)) {
      return res.status(400).json({ error: "Unknown refund method.", code: "BAD_METHOD" });
    }
    const when = body.date ? new Date(body.date) : new Date();
    if (Number.isNaN(when.getTime())) return res.status(400).json({ error: "Invalid date", code: "BAD_DATE" });

    const note = await prisma.invoice.findUnique({ where: { id: req.params.id } });
    if (!note) return res.status(404).json({ error: "Credit note not found" });
    if (!(await ownsBusiness(req, note.businessId))) return res.status(403).json({ error: "Access denied" });
    if (note.type !== "credit_note") {
      return res.status(400).json({ error: "Only a credit note can be refunded.", code: "NOT_A_CREDIT_NOTE" });
    }

    const updated = await prisma.withBusinessLock(note.businessId, async () => {
      const cn = await prisma.invoice.findUnique({ where: { id: note.id } });
      if (!OPEN_STATUSES.includes(cn.status)) {
        throw creditError(409, "CREDIT_NOT_OPEN", "This credit note is not open.");
      }
      const remaining = toMoney(cn.total - cn.amountPaid);
      if (amount > remaining) {
        throw creditError(400, "EXCEEDS_CREDIT", "That is more than the credit left.", { remaining });
      }
      const cnUsed = toMoney(cn.amountPaid + amount);
      const [, row] = await prisma.$transaction([
        prisma.invoicePayment.create({
          data: {
            invoiceId: cn.id,
            amount,
            method: `refund_${method}`,
            note: body.note ? String(body.note).trim().slice(0, 200) || null : null,
            date: when,
          },
        }),
        prisma.invoice.update({
          where: { id: cn.id },
          data: { amountPaid: cnUsed, status: cnUsed >= toMoney(cn.total) ? "PAID" : "PARTIAL" },
          include: INCLUDE,
        }),
      ]);
      return row;
    });

    res.status(201).json(formatInvoice(updated));
  } catch (err) {
    return sendCreditError(res, err, "Failed to record refund");
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
    if (existing.type === "credit_note" && (existing.amountPaid || 0) > 0) {
      return res.status(409).json({ error: "This credit note has been used.", code: "CREDIT_IN_USE" });
    }
    if (existing.type !== "credit_note") {
      const applied = await prisma.creditApplication.count({ where: { invoiceId: existing.id } });
      if (applied) {
        return res.status(409).json({ error: "Credit has been applied to this invoice.", code: "CREDITS_APPLIED" });
      }
    }

    await prisma.invoice.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete invoice" });
  }
});

module.exports = router;
