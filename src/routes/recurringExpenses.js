const express = require("express");
const router = express.Router();
const prisma = require("../utils/db");
const auth = require("../middleware/auth");
const { computeNextDue } = require("../utils/recurringSchedule");
const { verifyTransactionPin } = require("../utils/transactionPin");
const { audit } = require("../utils/audit");
const { getProvider } = require("../providers");
const { getThresholds } = require("../config/amlLimits");

router.use(auth);

// Mask an account number for audit-log metadata.
const maskAccount = (n) =>
  !n ? "" : `${"*".repeat(Math.max(0, String(n).length - 4))}${String(n).slice(-4)}`;

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
    const {
      businessId, category, amount, paymentMethod, notes, frequency, startDate,
      // Auto-debit
      autoSend, payeeAccountNumber, payeeBankCode, payeeBankName, payeeAccountName, pin,
    } = req.body;

    if (!amount || amount <= 0) return res.status(400).json({ error: "Invalid amount" });
    const validFreq = ["daily", "weekly", "monthly", "yearly"].includes(frequency) ||
      (typeof frequency === "string" && frequency.startsWith("custom_") && parseInt(frequency.split("_")[1], 10) > 0);
    if (!validFreq) return res.status(400).json({ error: "Invalid frequency" });

    let biz = null;
    if (businessId) {
      biz = await prisma.business.findFirst({
        where: { id: businessId, userId: req.user.id },
      });
      if (!biz) return res.status(403).json({ error: "Forbidden" });
    }

    // Auto-debit validation — requires PIN consent + payee + banking-enabled country.
    if (autoSend) {
      if (!biz) return res.status(400).json({ error: "Auto-debit requires a business" });
      if (!getProvider(biz).supportsBanking) {
        return res.status(400).json({
          error: "Auto-debit isn't available in your country yet.",
          code: "BANKING_NOT_AVAILABLE",
        });
      }
      if (!payeeAccountNumber || !payeeBankCode) {
        return res.status(400).json({ error: "Payee account number and bank are required for auto-debit." });
      }
      const cap = getThresholds(biz).singleFlagAbove;
      if (Number(amount) > getThresholds(biz).stepUpOtpAbove * 5) {
        // Soft warning — the runner will fail BLOCKED_SINGLE_CAP regardless,
        // but reject here so the user gets immediate feedback at setup.
        return res.status(400).json({
          error: `Auto-debit is capped per transfer. Use the Send Money flow for amounts above the cap.`,
          code: "ABOVE_AUTODEBIT_CAP",
        });
      }
      const pinCheck = await verifyTransactionPin(req.user.id, pin);
      if (!pinCheck.ok) {
        return res.status(pinCheck.status || 401).json({ error: pinCheck.error, code: pinCheck.code });
      }
      void cap; // referenced for clarity; future use
    }

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
        ...(autoSend
          ? {
              autoSend: true,
              authorizedAt: new Date(),
              payeeAccountNumber,
              payeeBankCode,
              payeeBankName: payeeBankName || null,
              payeeAccountName: payeeAccountName || null,
            }
          : {}),
      },
    });

    if (autoSend) {
      await audit({
        req,
        action: "RECURRING_AUTHORIZED",
        resourceType: "recurringExpense",
        resourceId: item.id,
        severity: "warn",
        metadata: {
          amount: Number(amount),
          frequency,
          payeeAccountNumberMasked: maskAccount(payeeAccountNumber),
          payeeBankName: payeeBankName || null,
        },
      });
    }

    res.status(201).json(item);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create recurring expense" });
  }
});

// PATCH /recurring-expenses/:id
router.patch("/:id", async (req, res) => {
  try {
    const {
      category, amount, paymentMethod, notes, frequency, active,
      // Auto-debit fields. Any change that turns autoSend ON or modifies the
      // payee requires a fresh PIN entry (the consent token).
      autoSend, payeeAccountNumber, payeeBankCode, payeeBankName, payeeAccountName, pin,
    } = req.body;
    const existing = await prisma.recurringExpense.findFirst({
      where: { id: req.params.id, userId: req.user.id },
      include: { business: true },
    });
    if (!existing) return res.status(404).json({ error: "Not found" });

    const data = {};
    if (category !== undefined) data.category = category;
    if (amount !== undefined) data.amount = parseFloat(amount);
    if (paymentMethod !== undefined) data.paymentMethod = paymentMethod;
    if (notes !== undefined) data.notes = notes;
    if (frequency !== undefined) data.frequency = frequency;
    if (active !== undefined) data.active = active;

    // Determine whether this PATCH alters auto-debit posture in a way that
    // needs re-authorisation. Cases that trigger PIN:
    //   1. autoSend going from false → true
    //   2. payee account number changing while autoSend is on
    //   3. payee bank code changing while autoSend is on
    const turningOn = autoSend === true && !existing.autoSend;
    const payeeChanged =
      (payeeAccountNumber !== undefined && payeeAccountNumber !== existing.payeeAccountNumber) ||
      (payeeBankCode !== undefined && payeeBankCode !== existing.payeeBankCode);

    if (turningOn || (existing.autoSend && payeeChanged)) {
      if (!existing.business) return res.status(400).json({ error: "Auto-debit requires a business" });
      if (!getProvider(existing.business).supportsBanking) {
        return res.status(400).json({
          error: "Auto-debit isn't available in your country yet.",
          code: "BANKING_NOT_AVAILABLE",
        });
      }
      const effectiveAccount = payeeAccountNumber || existing.payeeAccountNumber;
      const effectiveBank = payeeBankCode || existing.payeeBankCode;
      if (!effectiveAccount || !effectiveBank) {
        return res.status(400).json({ error: "Payee account and bank are required for auto-debit." });
      }
      const pinCheck = await verifyTransactionPin(req.user.id, pin);
      if (!pinCheck.ok) {
        return res.status(pinCheck.status || 401).json({ error: pinCheck.error, code: pinCheck.code });
      }
      data.authorizedAt = new Date();
    }

    if (autoSend !== undefined) data.autoSend = !!autoSend;
    if (payeeAccountNumber !== undefined) data.payeeAccountNumber = payeeAccountNumber;
    if (payeeBankCode       !== undefined) data.payeeBankCode       = payeeBankCode;
    if (payeeBankName       !== undefined) data.payeeBankName       = payeeBankName;
    if (payeeAccountName    !== undefined) data.payeeAccountName    = payeeAccountName;

    // Re-enabling after a pause clears the failure counter — fresh start.
    if (active === true && existing.active === false) {
      data.consecutiveFailures = 0;
    }

    const updated = await prisma.recurringExpense.update({
      where: { id: req.params.id },
      data,
    });

    if (turningOn || (existing.autoSend && payeeChanged)) {
      await audit({
        req,
        action: "RECURRING_AUTHORIZED",
        resourceType: "recurringExpense",
        resourceId: updated.id,
        severity: "warn",
        metadata: {
          amount: updated.amount,
          frequency: updated.frequency,
          payeeAccountNumberMasked: maskAccount(updated.payeeAccountNumber),
          payeeBankName: updated.payeeBankName,
        },
      });
    }

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

// Re-export computeNextDue for backwards compatibility with anything that
// still imports it from this module; the canonical home is now
// utils/recurringSchedule.js.
module.exports = { router, computeNextDue };
