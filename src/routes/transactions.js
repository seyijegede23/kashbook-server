const router = require("express").Router();
const prisma = require("../utils/db");
const auth = require("../middleware/auth");
const { requirePermission } = require("../middleware/requirePermission");
const { normalizeChannel } = require("../utils/salesChannel");
const { isBankLedgerRow } = require("../config/moneySources");
const { audit } = require("../utils/audit");

// MOUNTED as of Aug 2026 — it sat unmounted for months while the app called its
// match endpoints, so "Match to Sale or Debt" silently 404'd and reverted.
// Bank-ledger rows remain provider-owned and append-only: POST refuses creating
// them, PATCH/DELETE refuse touching them. Matching (below) only LABELS credits
// and moves bookkeeping records; it never edits a bank row's money fields.

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
// canViewBalance: this returns the full bank ledger — the same data /sync
// withholds from ungranted staff. Mounting this router without the gate would
// have reopened that exact leak through a different door.
router.get("/", requirePermission("canViewBalance"), async (req, res) => {
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

// ═════════════════════════════════════════════════════════════════════════
// Matching — link an INCOMING bank credit to what it was for.
//
// Three answers to "what was this transfer?": an existing sale, a brand-new
// sale at the transfer's amount, or a customer paying off debt. Matching is
// what keeps reports honest: a matched credit is excluded from income sums
// because the sale (or the credit sale it repays) is already counted there.
//
// Rules every handler shares:
//   * income rows only — matching an OUTBOUND transfer is meaningless
//   * one match per credit, 409 on a second attempt, re-checked INSIDE the
//     business lock (the outer check is UX; the inner one is the guarantee)
//   * all writes in one prisma.$transaction — the old handlers used
//     Promise.all and loose sequential writes, which could half-apply
// ═════════════════════════════════════════════════════════════════════════

// Coded failure that the catch blocks translate to an HTTP response.
function matchError(status, code, message) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}

// Load + gate the credit being matched: exists, owned, incoming, unmatched.
// Responds and returns null on failure so handlers can early-return.
async function loadMatchableCredit(req, res) {
  const tx = await prisma.transaction.findUnique({ where: { id: req.params.id } });
  if (!tx) {
    res.status(404).json({ error: "Transaction not found" });
    return null;
  }
  if (!(await ownsBusiness(req, tx.businessId))) {
    res.status(403).json({ error: "Forbidden" });
    return null;
  }
  if (tx.type !== "income") {
    res.status(400).json({ error: "Matching is only for incoming transfers.", code: "NOT_INCOMING" });
    return null;
  }
  if (tx.matchedSaleId || tx.matchedCustomerId) {
    res.status(409).json({ error: "This transfer is already matched. Unmatch it first.", code: "ALREADY_MATCHED" });
    return null;
  }
  return tx;
}

const debtTotalOwed = (debts) =>
  debts.reduce((s, d) => s + Math.max(0, d.amount - d.paidAmount), 0);

// Translate a coded matchError into a response; 500 for anything else.
function respondMatchFailure(res, err, fallback) {
  if (err && err.status && err.code) {
    return res.status(err.status).json({ error: err.message, code: err.code });
  }
  console.error(`[transactions] ${fallback}:`, err);
  return res.status(500).json({ error: fallback });
}

// POST /transactions/:id/match  { saleId } — link to an EXISTING sale.
router.post("/:id/match", requirePermission("canViewBalance"), async (req, res) => {
  const { saleId } = req.body;
  if (!saleId) return res.status(400).json({ error: "saleId required" });
  try {
    const pre = await loadMatchableCredit(req, res);
    if (!pre) return;

    const result = await prisma.withBusinessLock(pre.businessId, () =>
      prisma.$transaction(async (px) => {
        // Re-check both sides under the lock. Two phones matching at once each
        // pass the outer read; only one may pass here.
        const tx = await px.transaction.findUnique({ where: { id: pre.id } });
        if (tx.matchedSaleId || tx.matchedCustomerId)
          throw matchError(409, "ALREADY_MATCHED", "This transfer is already matched.");
        const sale = await px.sales.findUnique({ where: { id: saleId } });
        if (!sale) throw matchError(404, "SALE_NOT_FOUND", "Sale not found");
        if (sale.userId !== getTargetUserId(req) || sale.businessId !== tx.businessId)
          throw matchError(403, "FORBIDDEN", "Forbidden");
        if (sale.matchedTransactionId)
          throw matchError(409, "SALE_ALREADY_MATCHED", "That sale is already matched to another transfer.");

        const updatedTx = await px.transaction.update({
          where: { id: tx.id }, data: { matchedSaleId: saleId },
        });
        const updatedSale = await px.sales.update({
          where: { id: saleId }, data: { matchedTransactionId: tx.id },
        });
        return { transaction: updatedTx, sale: updatedSale };
      }),
    );

    audit({
      req, action: "TX_MATCH_SALE", resourceType: "transaction", resourceId: pre.id,
      metadata: { saleId, amount: Number(pre.amount) },
    }).catch(() => {});
    res.json({ matched: true, ...result });
  } catch (err) {
    respondMatchFailure(res, err, "Failed to match");
  }
});

// Resolve the amount a record created FROM a transfer may carry.
//
// The transfer is the ceiling, never the floor: the owner composes the sale or
// expense in the full Add form (items, quantities, category) and the total may
// come out BELOW the transfer — a ₦5,000 credit paying for ₦4,500 of goods is
// real life. It may never come out above, because the record is matched to this
// transfer and the excess would be income/expense that no money ever backed.
// Omitted → the whole transfer amount (what old clients send). The half-kobo
// epsilon absorbs float noise from a client computing price × quantity.
function resolveCappedAmount(body, tx) {
  const cap = Number(tx.amount);
  if (body.amount === undefined || body.amount === null || body.amount === "") {
    return { amount: cap, remainder: 0 };
  }
  const n = Number(body.amount);
  if (!Number.isFinite(n) || n <= 0) {
    throw matchError(400, "INVALID_AMOUNT", "Enter a valid amount.");
  }
  if (n > cap + 0.005) {
    throw matchError(400, "AMOUNT_EXCEEDS_TRANSFER",
      `The amount can't be more than the transfer (${cap}).`);
  }
  const amount = Math.round(Math.min(n, cap) * 100) / 100;
  return { amount, remainder: Math.round((cap - amount) * 100) / 100 };
}

// Free-text length caps. These routes bypass the validateSale/validateExpense
// chains, so without this the description field is unbounded.
const clampText = (s, max) => (typeof s === "string" ? s.trim().slice(0, max) : "");

// POST /transactions/:id/create-sale  { amount?, description?, channel?, customerId? }
// The transfer IS the sale — record it in one step, already matched, so the
// income is counted exactly once. The DATE always comes from the credit (same
// reporting period as the money); the AMOUNT may be composed in the full Add
// form but is capped at the transfer (see resolveCappedAmount).
router.post("/:id/create-sale", requirePermission("canViewBalance"), async (req, res) => {
  const { channel, customerId } = req.body || {};
  const description = clampText((req.body || {}).description, 500);
  try {
    const pre = await loadMatchableCredit(req, res);
    if (!pre) return;
    const { amount, remainder } = resolveCappedAmount(req.body || {}, pre);

    if (customerId) {
      const customer = await prisma.customer.findUnique({ where: { id: customerId } });
      if (!customer || customer.userId !== getTargetUserId(req))
        return res.status(404).json({ error: "Customer not found" });
    }

    const result = await prisma.withBusinessLock(pre.businessId, () =>
      prisma.$transaction(async (px) => {
        const tx = await px.transaction.findUnique({ where: { id: pre.id } });
        if (tx.matchedSaleId || tx.matchedCustomerId)
          throw matchError(409, "ALREADY_MATCHED", "This transfer is already matched.");

        const sale = await px.sales.create({
          data: {
            userId: getTargetUserId(req),
            businessId: tx.businessId,
            customerId: customerId || null,
            amount,
            paymentMethod: "transfer",
            isCredit: false,
            notes: description || tx.description || "Bank transfer",
            channel: normalizeChannel(channel),
            // The transfer's date, so the sale lands in the same reporting
            // period as the money.
            date: tx.date,
            recordedBy: req.user.id,
            recordedByName: req.user.name,
            matchedTransactionId: tx.id,
          },
        });
        const updatedTx = await px.transaction.update({
          where: { id: tx.id }, data: { matchedSaleId: sale.id },
        });
        return { sale, transaction: updatedTx };
      }),
    );

    audit({
      req, action: "TX_MATCH_CREATE_SALE", resourceType: "transaction", resourceId: pre.id,
      metadata: { saleId: result.sale.id, amount, remainder },
    }).catch(() => {});
    res.status(201).json({ ...result, remainder });
  } catch (err) {
    respondMatchFailure(res, err, "Failed to create sale from transfer");
  }
});

// Gate for the EXPENSE mirror: the debit being recorded must exist, be owned,
// be OUTGOING, and not already carry an expense.
async function loadMatchableDebit(req, res) {
  const tx = await prisma.transaction.findUnique({ where: { id: req.params.id } });
  if (!tx) {
    res.status(404).json({ error: "Transaction not found" });
    return null;
  }
  if (!(await ownsBusiness(req, tx.businessId))) {
    res.status(403).json({ error: "Forbidden" });
    return null;
  }
  if (tx.type !== "expense") {
    res.status(400).json({ error: "Recording an expense is only for outgoing transfers.", code: "NOT_OUTGOING" });
    return null;
  }
  if (tx.matchedExpenseId) {
    res.status(409).json({ error: "This transfer is already recorded as an expense. Unmatch it first.", code: "ALREADY_MATCHED" });
    return null;
  }
  return tx;
}

// POST /transactions/:id/create-expense  { amount?, description?, category? }
// The outbound mirror: tap a transfer you SENT and record what it paid for.
// Same cap rule, same lock + in-lock re-check, same exclusion consequence —
// the bank debit stops counting in expense aggregates because the categorised
// Expense row now carries that money.
router.post("/:id/create-expense", requirePermission("canViewBalance"), async (req, res) => {
  const description = clampText((req.body || {}).description, 500);
  const category = clampText((req.body || {}).category, 40).toLowerCase() || "other";
  try {
    const pre = await loadMatchableDebit(req, res);
    if (!pre) return;
    const { amount, remainder } = resolveCappedAmount(req.body || {}, pre);

    const result = await prisma.withBusinessLock(pre.businessId, () =>
      prisma.$transaction(async (px) => {
        const tx = await px.transaction.findUnique({ where: { id: pre.id } });
        if (tx.matchedExpenseId)
          throw matchError(409, "ALREADY_MATCHED", "This transfer is already recorded as an expense.");

        const expense = await px.expense.create({
          data: {
            userId: getTargetUserId(req),
            businessId: tx.businessId,
            category,
            amount,
            // "transfer", NOT "bank": paymentMethod "bank" + category "transfer"
            // is the isBankLedgerRow signature, and a bookkeeping Expense must
            // never read as a bank movement.
            paymentMethod: "transfer",
            notes: description || tx.description || "Bank transfer",
            date: tx.date,
            matchedTransactionId: tx.id,
          },
        });
        const updatedTx = await px.transaction.update({
          where: { id: tx.id }, data: { matchedExpenseId: expense.id },
        });
        return { expense, transaction: updatedTx };
      }),
    );

    audit({
      req, action: "TX_MATCH_CREATE_EXPENSE", resourceType: "transaction", resourceId: pre.id,
      metadata: { expenseId: result.expense.id, amount, remainder, category },
    }).catch(() => {});
    res.status(201).json({ ...result, remainder });
  } catch (err) {
    respondMatchFailure(res, err, "Failed to record expense from transfer");
  }
});

// POST /transactions/:id/match-debt  { customerId }
// Apply the credit to the customer's unpaid debts, oldest first. Every payment
// row is stamped with the transaction id so unmatch can reverse exactly these.
router.post("/:id/match-debt", requirePermission("canViewBalance"), async (req, res) => {
  const { customerId } = req.body;
  if (!customerId) return res.status(400).json({ error: "customerId required" });
  try {
    const pre = await loadMatchableCredit(req, res);
    if (!pre) return;

    const customer = await prisma.customer.findUnique({ where: { id: customerId } });
    if (!customer || customer.userId !== getTargetUserId(req))
      return res.status(404).json({ error: "Customer not found" });

    const result = await prisma.withBusinessLock(pre.businessId, () =>
      prisma.$transaction(async (px) => {
        // The re-check under the lock is what killed the double-apply bug: the
        // old handler never looked at matchedCustomerId, so calling it twice
        // paid the debt down twice.
        const tx = await px.transaction.findUnique({ where: { id: pre.id } });
        if (tx.matchedSaleId || tx.matchedCustomerId)
          throw matchError(409, "ALREADY_MATCHED", "This transfer is already matched.");

        const unpaidDebts = await px.debt.findMany({
          where: { customerId, paid: false },
          orderBy: { date: "asc" },
        });
        if (!debtTotalOwed(unpaidDebts))
          throw matchError(409, "NO_OUTSTANDING_DEBT", "This customer has no outstanding debt.");

        let remaining = Number(tx.amount);
        for (const debt of unpaidDebts) {
          if (remaining <= 0) break;
          const outstanding = debt.amount - debt.paidAmount;
          const payment = Math.min(outstanding, remaining);
          if (payment <= 0) continue;
          await px.debt.update({
            where: { id: debt.id },
            data: { paidAmount: debt.paidAmount + payment, paid: debt.paidAmount + payment >= debt.amount },
          });
          await px.debtPayment.create({
            data: {
              debtId: debt.id,
              amount: payment,
              note: `Bank transfer: ${tx.description || ""}`.trim(),
              transactionId: tx.id,
            },
          });
          remaining -= payment;
        }

        const allDebts = await px.debt.findMany({ where: { customerId } });
        const updatedCustomer = await px.customer.update({
          where: { id: customerId },
          data: { totalOwed: debtTotalOwed(allDebts) },
          // Full shape so the client can drop it straight into state instead of
          // a refetch that its local-wins merge would then discard.
          include: { debts: { include: { payments: true } } },
        });
        const updatedTx = await px.transaction.update({
          where: { id: tx.id }, data: { matchedCustomerId: customerId },
        });
        return {
          amountApplied: Number(tx.amount) - remaining,
          remainder: remaining,
          customer: updatedCustomer,
          transaction: updatedTx,
        };
      }),
    );

    audit({
      req, action: "TX_MATCH_DEBT", resourceType: "transaction", resourceId: pre.id,
      metadata: { customerId, amountApplied: result.amountApplied, remainder: result.remainder },
    }).catch(() => {});
    res.json({ matched: true, ...result });
  } catch (err) {
    respondMatchFailure(res, err, "Failed to match debt");
  }
});

// DELETE /transactions/:id/match   (?deleteSale=true)
// Undo a match completely. For a debt match that means REVERSING the payments
// this credit created — the old handler cleared the label and left the money
// applied, so "unmatch" lied. For a created-from-transfer sale, deleteSale=true
// removes the sale too; without it, unlinking would leave an orphan sale that
// re-introduces the double count.
router.delete("/:id/match", requirePermission("canViewBalance"), async (req, res) => {
  const deleteSale = req.query.deleteSale === "true";
  const deleteExpense = req.query.deleteExpense === "true";
  try {
    const tx0 = await prisma.transaction.findUnique({ where: { id: req.params.id } });
    if (!tx0) return res.status(404).json({ error: "Transaction not found" });
    if (!(await ownsBusiness(req, tx0.businessId)))
      return res.status(403).json({ error: "Forbidden" });
    if (!tx0.matchedSaleId && !tx0.matchedCustomerId && !tx0.matchedExpenseId)
      return res.json({ matched: false }); // idempotent no-op

    const result = await prisma.withBusinessLock(tx0.businessId, () =>
      prisma.$transaction(async (px) => {
        const tx = await px.transaction.findUnique({ where: { id: tx0.id } });
        const out = { saleDeleted: false, expenseDeleted: false, customer: null };

        // Expense mirror of the sale branch below: unlink keeps the Expense as
        // its own record (it goes back to counting, and so does the bank debit
        // — the user asked to separate them); deleteExpense removes it, the
        // undo for create-expense.
        if (tx.matchedExpenseId) {
          const expense = await px.expense.findUnique({ where: { id: tx.matchedExpenseId } });
          if (expense && deleteExpense) {
            await px.expense.delete({ where: { id: expense.id } });
            out.expenseDeleted = true;
          } else if (expense) {
            await px.expense.update({ where: { id: expense.id }, data: { matchedTransactionId: null } });
          }
        }

        if (tx.matchedSaleId) {
          const sale = await px.sales.findUnique({ where: { id: tx.matchedSaleId } });
          if (sale && deleteSale) {
            await px.sales.delete({ where: { id: sale.id } });
            out.saleDeleted = true;
          } else if (sale) {
            await px.sales.update({ where: { id: sale.id }, data: { matchedTransactionId: null } });
          }
        }

        if (tx.matchedCustomerId) {
          const payments = await px.debtPayment.findMany({ where: { transactionId: tx.id } });
          // Group reversals per debt, then walk each debt once.
          const byDebt = new Map();
          for (const p of payments) byDebt.set(p.debtId, (byDebt.get(p.debtId) || 0) + Number(p.amount));
          for (const [debtId, reversed] of byDebt) {
            const debt = await px.debt.findUnique({ where: { id: debtId } });
            if (!debt) continue; // debt deleted since — nothing to restore
            const paidAmount = Math.max(0, debt.paidAmount - reversed);
            await px.debt.update({
              where: { id: debtId },
              data: { paidAmount, paid: paidAmount >= debt.amount },
            });
          }
          await px.debtPayment.deleteMany({ where: { transactionId: tx.id } });
          const allDebts = await px.debt.findMany({ where: { customerId: tx.matchedCustomerId } });
          out.customer = await px.customer.update({
            where: { id: tx.matchedCustomerId },
            data: { totalOwed: debtTotalOwed(allDebts) },
            include: { debts: { include: { payments: true } } },
          }).catch(() => null); // customer deleted since — labels still clear below
        }

        out.transaction = await px.transaction.update({
          where: { id: tx.id },
          data: { matchedSaleId: null, matchedCustomerId: null, matchedExpenseId: null },
        });
        return out;
      }),
    );

    audit({
      req, action: "TX_UNMATCH", resourceType: "transaction", resourceId: tx0.id,
      metadata: {
        hadSale: !!tx0.matchedSaleId, hadCustomer: !!tx0.matchedCustomerId,
        hadExpense: !!tx0.matchedExpenseId,
        saleDeleted: result.saleDeleted, expenseDeleted: result.expenseDeleted,
      },
    }).catch(() => {});
    res.json({ matched: false, ...result });
  } catch (err) {
    respondMatchFailure(res, err, "Failed to unmatch");
  }
});

module.exports = router;
