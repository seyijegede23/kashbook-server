// Recurring invoices — PREMIUM. CRUD for the rules; the daily cron
// (utils/recurringInvoiceRunner.js) turns due rules into real SENT invoices.
const router = require("express").Router();
const prisma = require("../utils/db");
const auth = require("../middleware/auth");

router.use(auth);

// Staff act on their employer's books (same convention as invoices/transfers).
function ownerId(req) {
  return req.user.accountType === "staff" ? req.user.employerId : req.user.id;
}

function validFrequency(f) {
  return ["daily", "weekly", "monthly", "yearly"].includes(f) ||
    (typeof f === "string" && f.startsWith("custom_") && parseInt(f.split("_")[1], 10) > 0);
}

function parseAmount(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n <= 1e12 ? n : null;
}

const mapRule = (r) => ({
  id: r.id,
  businessId: r.businessId,
  customerId: r.customerId,
  customerName: r.customer?.name || null,
  description: r.description,
  amount: r.amount,
  frequency: r.frequency,
  dueInDays: r.dueInDays,
  nextDue: r.nextDue,
  active: r.active,
  lastRunAt: r.lastRunAt,
});

// GET /recurring-invoices?businessId=
router.get("/", async (req, res) => {
  try {
    const where = { userId: ownerId(req) };
    if (req.query.businessId) where.businessId = String(req.query.businessId);
    const items = await prisma.recurringInvoice.findMany({
      where,
      orderBy: { nextDue: "asc" },
      include: { customer: { select: { name: true } } },
      take: 200,
    });
    res.json(items.map(mapRule));
  } catch (err) {
    console.error("[recurring-invoices GET]", err.message);
    res.status(500).json({ error: "Failed to fetch recurring invoices" });
  }
});

// POST /recurring-invoices { businessId, customerId?, description, amount, frequency, dueInDays?, startDate? }
router.post("/", async (req, res) => {
  try {
    if (req.user.effectivePlan !== "PREMIUM") {
      return res.status(403).json({
        error: "Recurring invoices are a Premium feature. Upgrade to automate your repeat billing.",
        code: "PREMIUM_REQUIRED",
      });
    }
    const uid = ownerId(req);
    const { businessId, customerId, startDate } = req.body;
    const description = String(req.body.description || "").trim();
    const amount = parseAmount(req.body.amount);
    const frequency = req.body.frequency || "monthly";
    const dueInDays = req.body.dueInDays == null || req.body.dueInDays === ""
      ? null
      : parseInt(req.body.dueInDays, 10);

    if (!description) return res.status(400).json({ error: "Describe what the invoice is for." });
    if (!amount) return res.status(400).json({ error: "Enter a valid amount." });
    if (!validFrequency(frequency)) return res.status(400).json({ error: "Invalid frequency" });
    if (dueInDays != null && (!Number.isInteger(dueInDays) || dueInDays < 0 || dueInDays > 365)) {
      return res.status(400).json({ error: "Due days must be between 0 and 365." });
    }

    const biz = await prisma.business.findFirst({ where: { id: String(businessId || ""), userId: uid } });
    if (!biz) return res.status(403).json({ error: "Forbidden" });

    let customer = null;
    if (customerId) {
      customer = await prisma.customer.findFirst({ where: { id: String(customerId), userId: uid } });
      if (!customer) return res.status(400).json({ error: "Customer not found." });
    }

    const nextDue = startDate ? new Date(startDate) : new Date();
    if (isNaN(nextDue.getTime())) return res.status(400).json({ error: "Invalid start date." });

    const rule = await prisma.recurringInvoice.create({
      data: {
        userId: uid,
        businessId: biz.id,
        customerId: customer?.id || null,
        description,
        amount,
        frequency,
        dueInDays,
        nextDue,
      },
      include: { customer: { select: { name: true } } },
    });
    res.status(201).json(mapRule(rule));
  } catch (err) {
    console.error("[recurring-invoices POST]", err.message);
    res.status(500).json({ error: "Failed to create recurring invoice" });
  }
});

// PATCH /recurring-invoices/:id { description?, amount?, frequency?, dueInDays?, active? }
router.patch("/:id", async (req, res) => {
  try {
    const rule = await prisma.recurringInvoice.findFirst({
      where: { id: req.params.id, userId: ownerId(req) },
    });
    if (!rule) return res.status(404).json({ error: "Not found" });

    const data = {};
    if (req.body.description !== undefined) {
      const d = String(req.body.description || "").trim();
      if (!d) return res.status(400).json({ error: "Description can't be empty." });
      data.description = d;
    }
    if (req.body.amount !== undefined) {
      const a = parseAmount(req.body.amount);
      if (!a) return res.status(400).json({ error: "Enter a valid amount." });
      data.amount = a;
    }
    if (req.body.frequency !== undefined) {
      if (!validFrequency(req.body.frequency)) return res.status(400).json({ error: "Invalid frequency" });
      data.frequency = req.body.frequency;
    }
    if (req.body.dueInDays !== undefined) {
      const v = req.body.dueInDays == null || req.body.dueInDays === "" ? null : parseInt(req.body.dueInDays, 10);
      if (v != null && (!Number.isInteger(v) || v < 0 || v > 365)) {
        return res.status(400).json({ error: "Due days must be between 0 and 365." });
      }
      data.dueInDays = v;
    }
    if (req.body.active !== undefined) data.active = !!req.body.active;

    const updated = await prisma.recurringInvoice.update({
      where: { id: rule.id },
      data,
      include: { customer: { select: { name: true } } },
    });
    res.json(mapRule(updated));
  } catch (err) {
    console.error("[recurring-invoices PATCH]", err.message);
    res.status(500).json({ error: "Failed to update recurring invoice" });
  }
});

// DELETE /recurring-invoices/:id
router.delete("/:id", async (req, res) => {
  try {
    const rule = await prisma.recurringInvoice.findFirst({
      where: { id: req.params.id, userId: ownerId(req) },
    });
    if (!rule) return res.json({ ok: true });
    await prisma.recurringInvoice.delete({ where: { id: rule.id } });
    res.json({ ok: true });
  } catch (err) {
    console.error("[recurring-invoices DELETE]", err.message);
    res.status(500).json({ error: "Failed to delete recurring invoice" });
  }
});

module.exports = router;
