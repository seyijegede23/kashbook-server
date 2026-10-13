const router = require("express").Router();
const auth = require("../middleware/auth");
const prisma = require("../utils/db");
const { validateSale, validateIdParam } = require("../middleware/validate");
const { normalizeChannel } = require("../utils/salesChannel");
const { assertAccountUsable, invalidateLedger } = require("../utils/ledgerData");
const { assertUnlocked, assertUnlockedIn } = require("../utils/booksLock");

router.use(auth);

// Helper to resolve the correct business owner ID
const getTargetUserId = (req) =>
  req.user.accountType === "staff" ? req.user.employerId : req.user.id;

// A refusal as the app reads it: { error, code }, plus the field it is about
// when it names one (an account the sale names is refused as accountId or
// depositAccountId: utils/ledgerData.js accountError), and anything else it
// carries for the app, such as a line (`extra`).
function sendRefusal(res, err) {
  return res.status(err.status).json({
    error: err.message,
    code: err.code,
    ...(err.field ? { field: err.field } : {}),
    ...(err.extra || {}),
  });
}

// Customer.totalOwed is the cached sum of what their unpaid debts still owe.
async function refreshTotalOwed(px, customerId) {
  const debts = await px.debt.findMany({ where: { customerId }, select: { amount: true, paidAmount: true } });
  const owed = debts.reduce((s, d) => s + Math.max(0, d.amount - d.paidAmount), 0);
  await px.customer.update({ where: { id: customerId }, data: { totalOwed: Math.round(owed * 100) / 100 } });
}

// GET /sales?from=&to=&limit=&businessId=
router.get("/", async (req, res) => {
  try {
    const { from, to, limit = 200, businessId, since } = req.query;
    const where = { userId: getTargetUserId(req) };
    if (businessId) where.businessId = businessId;
    if (since) {
      where.updatedAt = { gt: new Date(since) };
    } else if (from || to) {
      where.date = {};
      if (from) where.date.gte = new Date(from);
      if (to) where.date.lte = new Date(to);
    }
    const sales = await prisma.sales.findMany({
      where,
      orderBy: since ? { updatedAt: "asc" } : { date: "desc" },
      take: since ? undefined : Math.min(1000, Math.max(1, Number(limit) || 200)),
    });
    res.json(sales);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch sales" });
  }
});

// GET /sales/by-channel?businessId=&from=&to=
// Sales totals grouped by channel — powers the "Sales by channel" breakdown.
router.get("/by-channel", async (req, res) => {
  try {
    const { businessId, from, to } = req.query;
    const where = { userId: getTargetUserId(req) };
    if (businessId) where.businessId = businessId;
    if (from || to) {
      where.date = {};
      if (from) where.date.gte = new Date(from);
      if (to) where.date.lte = new Date(to);
    }
    const rows = await prisma.sales.groupBy({
      by: ["channel"],
      where,
      _sum: { amount: true },
      _count: { _all: true },
    });
    const result = rows
      .map((r) => ({
        channel: r.channel || "unspecified",
        total: r._sum.amount || 0,
        count: r._count._all,
      }))
      .sort((a, b) => b.total - a.total);
    res.json(result);
  } catch (err) {
    console.error("[sales/by-channel]", err);
    res.status(500).json({ error: "Failed to aggregate sales by channel" });
  }
});

// POST /sales
router.post("/", validateSale, async (req, res) => {
  const {
    customerId,
    amount,
    paymentMethod = "cash",
    isCredit = false,
    notes,
    date,
    businessId,
    channel,
    accountId,
    depositAccountId,
    clientRef,
  } = req.body;
  if (!amount) return res.status(400).json({ error: "amount required" });
  const ref = clientRef ? String(clientRef).slice(0, 80) : null;

  try {
    if (businessId) {
      const owned = await prisma.business.findFirst({
        where: { id: businessId, userId: getTargetUserId(req) },
      });
      if (!owned) return res.status(403).json({ error: "Forbidden" });
    }

    // A create the app retried (the first one timed out after it was saved)
    // gets the first one back instead of a second sale.
    if (businessId && ref) {
      const prior = await prisma.sales.findFirst({ where: { businessId, clientRef: ref } });
      if (prior) return res.status(200).json({ ...prior, debt: null });
    }
    const isStaff = req.user.accountType === "staff";
    const ownerId = getTargetUserId(req);
    const when = date ? new Date(date) : new Date();
    // Checked and saved under the business lock, which an account merge or
    // delete also takes (routes/ledger.js), so every account checked here is
    // still there when the sale is saved with it (as POST /expenses does).
    const lockedForBusiness = (fn) => (businessId ? prisma.withBusinessLock(businessId, fn) : fn());
    const { sale, debt } = await lockedForBusiness(async () => {
      // The lock date (utils/booksLock.js): nothing dated on or before it is
      // added. Asked under the lock it is set under.
      await assertUnlocked(businessId || null, when);
      // The chart of accounts: what the sale counts as (an income account, Sales
      // when none) and where the money went (by payment method when none). A
      // refusal names the field, so the app knows which of the two to leave out.
      const account = businessId
        ? await assertAccountUsable(businessId, accountId, "income", { isStaff, field: "accountId" })
        : null;
      const deposit = businessId
        ? await assertAccountUsable(businessId, depositAccountId, "money", { isStaff, field: "depositAccountId" })
        : null;

      // Sold on credit to a known customer: open that customer's debt for it in
      // the same transaction. Books rule: the sale then counts when the customer
      // pays (through the debt's payments), not on the day it was recorded.
      // Every customer belongs to one business (release 2), whose books count
      // their debts, so the customer must be this sale's business's: another
      // business's would carry the debt into its books, and one with no
      // business (its business was deleted) into none. A sale with no business
      // opens no debt.
      const creditCustomer =
        isCredit && customerId && businessId
          ? await prisma.customer.findFirst({
              where: { id: String(customerId), userId: ownerId, businessId },
              select: { id: true },
            })
          : null;

      return prisma.$transaction(async (px) => {
        const sale = await px.sales.create({
          data: {
            userId: ownerId,
            businessId: businessId || null,
            customerId: customerId || null,
            amount: Number(amount),
            paymentMethod,
            isCredit,
            notes: notes || null,
            channel: normalizeChannel(channel),
            date: when,
            recordedBy: req.user.id,
            recordedByName: req.user.name,
            accountId: account ? account.id : null,
            depositAccountId: deposit ? deposit.id : null,
            clientRef: ref,
          },
        });
        if (!creditCustomer) return { sale, debt: null };
        const debt = await px.debt.create({
          data: {
            customerId: creditCustomer.id,
            amount: Number(amount),
            note: notes || "",
            date: sale.date,
            saleId: sale.id,
          },
          include: { payments: true },
        });
        await refreshTotalOwed(px, creditCustomer.id);
        return { sale, debt };
      });
    });
    if (businessId) invalidateLedger(businessId);
    res.status(201).json({ ...sale, debt });
  } catch (err) {
    if (err?.code === "P2002" && ref && businessId) {
      const prior = await prisma.sales.findFirst({ where: { businessId, clientRef: ref } });
      if (prior) return res.status(200).json({ ...prior, debt: null });
    }
    if (err && err.status) return sendRefusal(res, err);
    console.error(err);
    res.status(500).json({ error: "Failed to create sale" });
  }
});

// PATCH /sales/:id
router.patch("/:id", validateIdParam, async (req, res) => {
  if (req.user.accountType === "staff")
    return res.status(403).json({ error: "Staff cannot edit sales" });
  try {
    const sale0 = await prisma.sales.findUnique({ where: { id: req.params.id } });
    if (!sale0) return res.status(404).json({ error: "Sale not found" });
    if (sale0.userId !== req.user.id) return res.status(403).json({ error: "Forbidden" });
    const { amount, notes, paymentMethod, date, channel, accountId, depositAccountId } = req.body;
    if (amount !== undefined && !(Number(amount) > 0)) {
      return res.status(400).json({ error: "Enter an amount.", code: "BAD_AMOUNT" });
    }
    // Books rule: a sale on credit with a customer has a debt that counts it
    // when paid. Changing the amount, the date or credit <-> paid keeps the
    // two in step; the paid part of a credit sale is fixed. A sale matched to
    // a bank transfer keeps the transfer's matchedAmount in step too. All of
    // it under the business lock, re-read inside. The accounts are checked
    // under the lock too: an account merge or delete (routes/ledger.js) takes
    // it, so an account checked here is still there when the sale is saved.
    const updated = await prisma.withBusinessLock(sale0.businessId || sale0.userId, async () => {
      const account = accountId !== undefined && sale0.businessId
        ? await assertAccountUsable(sale0.businessId, accountId, "income", { field: "accountId" }) : undefined;
      const deposit = depositAccountId !== undefined && sale0.businessId
        ? await assertAccountUsable(sale0.businessId, depositAccountId, "money", { field: "depositAccountId" }) : undefined;
      return prisma.$transaction(async (px) => {
        const sale = await px.sales.findUnique({ where: { id: sale0.id } });
        if (!sale) throw Object.assign(new Error("Sale not found"), { status: 404, code: "SALE_NOT_FOUND" });
        const debt = await px.debt.findFirst({ where: { saleId: sale.id } });
        // The lock date: the sale's day before and after the edit, its debt's,
        // and, when the amount changes, the day of the transfer it is matched
        // to (whose part left unexplained changes with it).
        const matched = sale.matchedTransactionId && amount !== undefined
          ? await px.transaction.findUnique({ where: { id: sale.matchedTransactionId }, select: { date: true } })
          : null;
        await assertUnlockedIn(
          px, sale.businessId, sale.date, date !== undefined ? new Date(date) : null,
          debt ? debt.date : null, matched ? matched.date : null,
        );
        const newAmount = amount !== undefined ? Number(amount) : Number(sale.amount);
        const toCredit = paymentMethod !== undefined ? paymentMethod === "credit" : !!sale.isCredit;
        if (debt && debt.paidAmount > 0 && (newAmount !== Number(sale.amount) || !toCredit)) {
          throw Object.assign(new Error("The customer has paid part of this credit sale. Its amount is fixed."), {
            status: 409, code: "CREDIT_SALE_PAID",
          });
        }
        if (toCredit && !sale.isCredit && sale.matchedTransactionId) {
          throw Object.assign(new Error("This sale was paid by a bank transfer, so it can't be on credit."), {
            status: 409, code: "SALE_MATCHED",
          });
        }
        const row = await px.sales.update({
          where: { id: sale.id },
          data: {
            ...(amount !== undefined && { amount: newAmount }),
            ...(notes !== undefined && { notes }),
            ...(paymentMethod !== undefined && { paymentMethod, isCredit: toCredit }),
            ...(date !== undefined && { date: new Date(date) }),
            ...(channel !== undefined && { channel: normalizeChannel(channel) }),
            ...(account !== undefined && { accountId: account ? account.id : null }),
            ...(deposit !== undefined && { depositAccountId: deposit ? deposit.id : null }),
          },
        });
        if (debt && !toCredit) {
          // Paid after all (nothing was repaid yet): the debt goes.
          await px.debt.delete({ where: { id: debt.id } });
          await refreshTotalOwed(px, debt.customerId);
        } else if (debt && (amount !== undefined || date !== undefined)) {
          await px.debt.update({
            where: { id: debt.id },
            data: {
              ...(amount !== undefined && { amount: newAmount, paid: debt.paidAmount >= newAmount }),
              ...(date !== undefined && { date: new Date(date) }),
            },
          });
          await refreshTotalOwed(px, debt.customerId);
        } else if (
          !debt && toCredit && !sale.isCredit && sale.customerId && sale.businessId &&
          // Only this business's own customer, as when the sale is created
          // on credit.
          (await px.customer.count({
            where: { id: sale.customerId, userId: sale.userId, businessId: sale.businessId },
          }))
        ) {
          // Now on credit: open the customer's debt for it.
          await px.debt.create({
            data: { customerId: sale.customerId, amount: newAmount, note: sale.notes || "", date: row.date, saleId: sale.id },
          });
          await refreshTotalOwed(px, sale.customerId);
        }
        if (sale.matchedTransactionId && amount !== undefined) {
          const tx = await px.transaction.findUnique({ where: { id: sale.matchedTransactionId } });
          if (tx && tx.matchedSaleId === sale.id) {
            await px.transaction.update({
              where: { id: tx.id },
              data: { matchedAmount: Math.min(newAmount, Number(tx.amount) || 0) },
            });
          }
        }
        return row;
      });
    });
    if (sale0.businessId) invalidateLedger(sale0.businessId);
    res.json(updated);
  } catch (err) {
    if (err.status) return sendRefusal(res, err);
    console.error(err);
    res.status(500).json({ error: "Failed to update sale" });
  }
});

// DELETE /sales/:id
router.delete("/:id", validateIdParam, async (req, res) => {
  if (req.user.accountType === "staff") {
    return res.status(403).json({ error: "Staff cannot delete sales" });
  }

  try {
    const sale = await prisma.sales.findUnique({ where: { id: req.params.id } });
    if (!sale) return res.status(404).json({ error: "Sale not found" });
    if (sale.userId !== req.user.id)
      return res.status(403).json({ error: "Forbidden" });

    // A credit sale and its debt go together. Once the customer has paid some
    // of it, those payments are counted sales, so the sale stays. A sale that
    // a bank transfer was matched to frees that transfer, which then counts on
    // its own again (instead of pointing at a sale that no longer exists).
    let debtId = null;
    await prisma.withBusinessLock(sale.businessId || sale.userId, () =>
      prisma.$transaction(async (px) => {
        const fresh = await px.sales.findUnique({ where: { id: sale.id } });
        if (!fresh) return;
        const debt = await px.debt.findFirst({ where: { saleId: fresh.id } });
        // The lock date: the sale's day, its debt's, and the day of a transfer
        // it frees (which counts on its own again).
        const matched = fresh.matchedTransactionId
          ? await px.transaction.findUnique({ where: { id: fresh.matchedTransactionId }, select: { date: true, matchedSaleId: true } })
          : null;
        await assertUnlockedIn(
          px, fresh.businessId, fresh.date, debt ? debt.date : null,
          matched && matched.matchedSaleId === fresh.id ? matched.date : null,
        );
        if (debt && debt.paidAmount > 0) {
          throw Object.assign(new Error("The customer has paid part of this credit sale, so it can't be deleted."), {
            status: 409, code: "CREDIT_SALE_PAID",
          });
        }
        if (debt) {
          debtId = debt.id;
          await px.debt.delete({ where: { id: debt.id } });
          await refreshTotalOwed(px, debt.customerId);
        }
        if (fresh.matchedTransactionId) {
          const tx = await px.transaction.findUnique({ where: { id: fresh.matchedTransactionId } });
          if (tx && tx.matchedSaleId === fresh.id) {
            await px.transaction.update({ where: { id: tx.id }, data: { matchedSaleId: null, matchedAmount: null } });
          }
        }
        await px.sales.delete({ where: { id: fresh.id } });
      }),
    );
    if (sale.businessId) invalidateLedger(sale.businessId);
    res.json({ message: "Deleted", debtId });
  } catch (err) {
    if (err.status) return sendRefusal(res, err);
    console.error(err);
    res.status(500).json({ error: "Failed to delete sale" });
  }
});

module.exports = router;
