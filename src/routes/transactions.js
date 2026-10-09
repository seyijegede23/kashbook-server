const router = require("express").Router();
const prisma = require("../utils/db");
const auth = require("../middleware/auth");
const { requirePermission } = require("../middleware/requirePermission");
const { normalizeChannel } = require("../utils/salesChannel");
const { isBankLedgerRow, isSavingsRow } = require("../config/moneySources");
const { audit } = require("../utils/audit");
const { CREDIT_OUTCOMES } = require("../utils/books");
const { recordLink, linkedFrom } = require("../utils/paymentLinks");

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
    // A matched row's amount is load-bearing: matchedAmount ≤ amount is the
    // invariant every remainder aggregate rests on, and shrinking the amount
    // under an existing match would make the remainder go negative and cancel
    // other rows' legitimate remainders inside summed aggregates. Unmatch
    // first, then edit.
    if (amount !== undefined && (tx.matchedSaleId || tx.matchedCustomerId || tx.matchedExpenseId || tx.matchedInvoiceId)) {
      return res.status(409).json({
        error: "This transaction is matched to a record. Unmatch it before changing the amount.",
        code: "MATCHED_ROW_AMOUNT_LOCKED",
      });
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
  // A savings withdrawal landing is the merchant's own money, not a payment:
  // it can never be matched to a sale, a debt or an invoice.
  if (isSavingsRow(tx)) {
    res.status(409).json({ error: "This is money returning from your savings, not a customer payment.", code: "SAVINGS_ROW_NOT_MATCHABLE" });
    return null;
  }
  // Marked as not income (cash already recorded, own transfer, a loan...).
  if (tx.purpose) {
    res.status(409).json({ error: "This transfer is marked as not a sale. Clear that first.", code: "MARKED_NOT_INCOME" });
    return null;
  }
  if (tx.matchedSaleId || tx.matchedCustomerId || tx.matchedInvoiceId) {
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
        if (tx.matchedSaleId || tx.matchedCustomerId || tx.matchedInvoiceId || tx.purpose)
          throw matchError(409, "ALREADY_MATCHED", "This transfer is already matched.");
        const sale = await px.sales.findUnique({ where: { id: saleId } });
        if (!sale) throw matchError(404, "SALE_NOT_FOUND", "Sale not found");
        if (sale.userId !== getTargetUserId(req) || sale.businessId !== tx.businessId)
          throw matchError(403, "FORBIDDEN", "Forbidden");
        if (sale.matchedTransactionId)
          throw matchError(409, "SALE_ALREADY_MATCHED", "That sale is already matched to another transfer.");
        // A sale on credit whose debt tracks it counts when its debt is paid
        // (books rule). Matching the transfer to the SALE would count it
        // nowhere and leave the debt open: it must pay the debt instead.
        if (sale.isCredit && (await px.debt.count({ where: { saleId: sale.id } }))) {
          throw matchError(409, "CREDIT_SALE_HAS_DEBT", "This sale was on credit. Apply the transfer to the customer's debt instead.");
        }

        const updatedTx = await px.transaction.update({
          where: { id: tx.id },
          data: {
            matchedSaleId: saleId,
            // How much of the credit the sale accounts for. A sale below the
            // credit leaves a remainder that scalar income totals add back;
            // a sale ABOVE the credit still only accounts for the credit.
            matchedAmount: Math.min(Number(sale.amount) || 0, Number(tx.amount) || 0),
          },
        });
        const updatedSale = await px.sales.update({
          where: { id: saleId }, data: { matchedTransactionId: tx.id },
        });
        return { transaction: updatedTx, sale: updatedSale };
      }),
    );

    // provenance: which suggestion the user actually took (rank in the list,
    // whether it was the exact-amount candidate). Pure telemetry for judging
    // and tuning the ranking — clamped, never trusted for anything else.
    const prov = req.body.provenance || {};
    audit({
      req, action: "TX_MATCH_SALE", resourceType: "transaction", resourceId: pre.id,
      metadata: {
        saleId, amount: Number(pre.amount),
        pickedRank: Number.isFinite(Number(prov.rank)) ? Math.max(0, Math.min(999, Number(prov.rank))) : undefined,
        pickedExact: typeof prov.exact === "boolean" ? prov.exact : undefined,
        candidates: Number.isFinite(Number(prov.total)) ? Math.max(0, Math.min(9999, Number(prov.total))) : undefined,
      },
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
        if (tx.matchedSaleId || tx.matchedCustomerId || tx.matchedInvoiceId || tx.purpose)
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
          where: { id: tx.id },
          data: { matchedSaleId: sale.id, matchedAmount: amount },
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
  // A savings deposit is the merchant's own money moving into a pot, not an
  // expense; recording one would double-count it against their profit.
  if (isSavingsRow(tx)) {
    res.status(409).json({ error: "This is a transfer into your savings, not an expense.", code: "SAVINGS_ROW_NOT_MATCHABLE" });
    return null;
  }
  // A refund to a customer lowers sales; it is never an expense too.
  if (tx.purpose) {
    res.status(409).json({ error: "This transfer paid a customer refund.", code: "MARKED_NOT_EXPENSE" });
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
        if (tx.matchedExpenseId || tx.purpose)
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
          where: { id: tx.id },
          data: { matchedExpenseId: expense.id, matchedAmount: amount },
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
    // Another business's customer would move this naira into that business's
    // books (its debts count there) while the credit stops counting here.
    if (!customer || customer.userId !== getTargetUserId(req) ||
        (customer.businessId && customer.businessId !== pre.businessId))
      return res.status(404).json({ error: "Customer not found" });

    const result = await prisma.withBusinessLock(pre.businessId, () =>
      prisma.$transaction(async (px) => {
        // The re-check under the lock is what killed the double-apply bug: the
        // old handler never looked at matchedCustomerId, so calling it twice
        // paid the debt down twice.
        const tx = await px.transaction.findUnique({ where: { id: pre.id } });
        if (tx.matchedSaleId || tx.matchedCustomerId || tx.matchedInvoiceId || tx.purpose)
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
          // Compare-and-set: a repayment recorded at the same moment from the
          // customer screen (locked on another key for a customer with no
          // business) must not be overwritten.
          const moved = await px.debt.updateMany({
            where: { id: debt.id, paidAmount: debt.paidAmount },
            data: { paidAmount: debt.paidAmount + payment, paid: debt.paidAmount + payment >= debt.amount },
          });
          if (moved.count !== 1) throw matchError(409, "DEBT_CHANGED", "This debt just changed. Try again.");
          await px.debtPayment.create({
            data: {
              debtId: debt.id,
              amount: payment,
              note: `Bank transfer: ${tx.description || ""}`.trim(),
              transactionId: tx.id,
              // Repaid when the money arrived, not when it was matched: the
              // books count it on this date (it was counted as an unexplained
              // credit in this same period until now).
              date: tx.date,
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
          where: { id: tx.id },
          data: {
            matchedCustomerId: customerId,
            // Only what was actually applied to debts — the remainder stays
            // countable as income (scalar totals add amount − matchedAmount
            // back), instead of silently vanishing from reports.
            matchedAmount: Number(tx.amount) - remaining,
          },
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
    if (!tx0.matchedSaleId && !tx0.matchedCustomerId && !tx0.matchedExpenseId && !tx0.matchedInvoiceId)
      return res.json({ matched: false }); // idempotent no-op
    // Taking invoice payments or debt repayments back out of the books is the
    // owner's call, as on the invoice itself (OWNER_ONLY there too).
    if (req.user.accountType === "staff" && (tx0.matchedInvoiceId || tx0.matchedCustomerId))
      return res.status(403).json({ error: "Only the business owner can do this.", code: "OWNER_ONLY" });

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
          const all = await px.debtPayment.findMany({ where: { transactionId: tx.id } });
          // A repayment recorded by hand and LINKED to this credit existed
          // before the link: it goes back to what it was, still counted.
          const payments = [];
          for (const p of all) {
            const was = await linkedFrom(px, "debt_payment", p.id, tx.id);
            if (was) {
              await px.debtPayment.update({
                where: { id: p.id },
                data: { transactionId: null, ...(was.date ? { date: new Date(was.date) } : {}) },
              });
            } else payments.push(p);
          }
          // Group reversals per debt, then walk each debt once.
          const byDebt = new Map();
          for (const p of payments) byDebt.set(p.debtId, (byDebt.get(p.debtId) || 0) + Number(p.amount));
          for (const [debtId, reversed] of byDebt) {
            const debt = await px.debt.findUnique({ where: { id: debtId } });
            if (!debt) continue; // debt deleted since — nothing to restore
            const paidAmount = Math.max(0, debt.paidAmount - reversed);
            const moved = await px.debt.updateMany({
              where: { id: debtId, paidAmount: debt.paidAmount },
              data: { paidAmount, paid: paidAmount >= debt.amount },
            });
            if (moved.count !== 1) throw matchError(409, "DEBT_CHANGED", "This debt just changed. Try again.");
          }
          if (payments.length) await px.debtPayment.deleteMany({ where: { id: { in: payments.map((p) => p.id) } } });
          const allDebts = await px.debt.findMany({ where: { customerId: tx.matchedCustomerId } });
          out.customer = await px.customer.update({
            where: { id: tx.matchedCustomerId },
            data: { totalOwed: debtTotalOwed(allDebts) },
            include: { debts: { include: { payments: true } } },
          }).catch(() => null); // customer deleted since — labels still clear below
        }

        // Invoices this credit paid: their payments come off, and the credit
        // counts on its own again (books rule: one record per naira).
        if (tx.matchedInvoiceId) {
          const payments = await px.invoicePayment.findMany({ where: { transactionId: tx.id } });
          const touched = new Set();
          for (const p of payments) {
            const inv = await px.invoice.findUnique({ where: { id: p.invoiceId } });
            if (!inv) continue;
            if (inv.writtenOffAt) {
              throw matchError(409, "WRITTEN_OFF", `${inv.invoiceNumber} was written off. Undo the write-off first.`);
            }
            const was = await linkedFrom(px, "invoice_payment", p.id, tx.id);
            if (was) {
              // Recorded by hand, then linked: it keeps counting as it was.
              await px.invoicePayment.update({
                where: { id: p.id },
                data: { transactionId: null, method: was.method || "transfer", ...(was.date ? { date: new Date(was.date) } : {}) },
              });
              touched.add(inv.id);
              continue;
            }
            await px.invoicePayment.delete({ where: { id: p.id } });
            const paid = Math.max(0, Math.round((inv.amountPaid - Number(p.amount)) * 100) / 100);
            const today = new Date(Date.now() + 60 * 60 * 1000).toISOString().slice(0, 10);
            const overdue = inv.dueDate && inv.dueDate < today;
            const status =
              inv.status === "VOID" ? "VOID"
                : paid >= inv.total && inv.total > 0 ? "PAID"
                : paid > 0 ? (overdue ? "OVERDUE" : "PARTIAL")
                : overdue ? "OVERDUE" : "SENT";
            await px.invoice.update({ where: { id: inv.id }, data: { amountPaid: paid, status } });
            touched.add(inv.id);
          }
          // Each invoice once, as it now is, for the app to put in place.
          out.invoices = await px.invoice.findMany({
            where: { id: { in: [...touched] } },
            include: { items: true, payments: { orderBy: { date: "asc" } }, customer: { select: { id: true, name: true, phone: true } } },
          });
        }

        out.transaction = await px.transaction.update({
          where: { id: tx.id },
          data: {
            matchedSaleId: null, matchedCustomerId: null, matchedExpenseId: null,
            matchedInvoiceId: null, matchedAmount: null,
          },
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

// POST /transactions/:id/link-debt-payment  { debtPaymentId }
// A repayment recorded by hand on the customer screen that actually arrived
// as this transfer: link the two, so the money counts once (the repayment
// carries it; the credit is marked as applied to that customer's debt).
router.post("/:id/link-debt-payment", requirePermission("canViewBalance"), async (req, res) => {
  try {
    const debtPaymentId = req.body && req.body.debtPaymentId ? String(req.body.debtPaymentId) : null;
    if (!debtPaymentId) return res.status(400).json({ error: "debtPaymentId required", code: "PAYMENT_REQUIRED" });
    const pre = await loadMatchableCredit(req, res);
    if (!pre) return;

    const result = await prisma.withBusinessLock(pre.businessId, () =>
      prisma.$transaction(async (px) => {
        const tx = await px.transaction.findUnique({ where: { id: pre.id } });
        if (tx.matchedSaleId || tx.matchedCustomerId || tx.matchedInvoiceId || tx.purpose)
          throw matchError(409, "ALREADY_MATCHED", "This transfer is already matched.");
        const payment = await px.debtPayment.findUnique({
          where: { id: debtPaymentId },
          include: { debt: { include: { customer: { select: { id: true, userId: true, businessId: true } } } } },
        });
        const customer = payment && payment.debt && payment.debt.customer;
        if (!payment || !customer || customer.userId !== getTargetUserId(req) ||
            (customer.businessId && customer.businessId !== tx.businessId)) {
          throw matchError(404, "PAYMENT_NOT_FOUND", "Repayment not found.");
        }
        if (payment.transactionId) throw matchError(409, "ALREADY_LINKED", "This repayment is already linked.");
        if (Number(payment.amount) > Number(tx.amount) + 0.005) {
          throw matchError(400, "EXCEEDS_TRANSFER", "The repayment is more than the transfer.");
        }
        await recordLink(px, { req, kind: "debt_payment", payment, transactionId: tx.id });
        await px.debtPayment.update({ where: { id: payment.id }, data: { transactionId: tx.id, date: tx.date } });
        return px.transaction.update({
          where: { id: tx.id },
          data: { matchedCustomerId: customer.id, matchedAmount: Number(payment.amount) },
        });
      }),
    );
    audit({
      req, action: "TX_LINK_DEBT_PAYMENT", resourceType: "transaction", resourceId: pre.id,
      metadata: { debtPaymentId },
    }).catch(() => {});
    res.json({ transaction: result });
  } catch (err) {
    respondMatchFailure(res, err, "Failed to link the repayment");
  }
});

// POST /transactions/:id/classify  { purpose }
// What an incoming transfer was when it was not a sale: cash already recorded
// and now banked, money from the owner's other account, the owner's own money,
// a loan, or a refund from a supplier. Books rule: none of these is income
// (a supplier refund lowers expenses); { purpose: null } takes it back.
router.post("/:id/classify", requirePermission("canViewBalance"), async (req, res) => {
  try {
    const raw = (req.body || {}).purpose;
    const purpose = raw === null || raw === "" ? null : String(raw);
    if (purpose !== null && !CREDIT_OUTCOMES.includes(purpose)) {
      return res.status(400).json({ error: "Unknown choice.", code: "BAD_PURPOSE" });
    }
    const tx0 = await prisma.transaction.findUnique({ where: { id: req.params.id } });
    if (!tx0) return res.status(404).json({ error: "Transaction not found" });
    if (!(await ownsBusiness(req, tx0.businessId))) return res.status(403).json({ error: "Forbidden" });
    if (tx0.type !== "income") {
      return res.status(400).json({ error: "Only money that came in can be marked.", code: "NOT_INCOMING" });
    }

    const updated = await prisma.withBusinessLock(tx0.businessId, () =>
      prisma.$transaction(async (px) => {
        const tx = await px.transaction.findUnique({ where: { id: tx0.id } });
        if (tx.purpose && !CREDIT_OUTCOMES.includes(tx.purpose)) {
          throw matchError(409, "PURPOSE_LOCKED", "This transfer can't be changed here.");
        }
        if (tx.matchedSaleId || tx.matchedCustomerId || tx.matchedInvoiceId) {
          throw matchError(409, "ALREADY_MATCHED", "This transfer is already matched. Unmatch it first.");
        }
        return px.transaction.update({ where: { id: tx.id }, data: { purpose } });
      }),
    );
    audit({
      req, action: "TX_CLASSIFY", resourceType: "transaction", resourceId: tx0.id,
      metadata: { from: tx0.purpose || null, to: purpose },
    }).catch(() => {});
    res.json({ transaction: updated });
  } catch (err) {
    respondMatchFailure(res, err, "Failed to update the transfer");
  }
});

module.exports = router;
