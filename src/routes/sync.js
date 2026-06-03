/**
 * Sync routes
 *
 * POST /sync            — process the client's offline queue
 * GET  /sync/pull?businessId= — pull full snapshot of a business (new device / first login)
 */
const router = require("express").Router();
const auth = require("../middleware/auth");
const prisma = require("../utils/db");

router.use(auth);

// ── Ownership check ──────────────────────────────────────────────────────────
async function ownsBusiness(userId, businessId) {
  const biz = await prisma.business.findFirst({ where: { id: businessId, userId } });
  return !!biz;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /sync?businessId=&since=ISO
// Incremental sync: returns everything changed for the active business since
// the supplied timestamp. One round-trip replaces 8+ parallel polls. Without
// `since`, returns the full set capped at recent records — used for first load.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/", async (req, res) => {
  const { businessId, since } = req.query;
  if (!businessId) return res.status(400).json({ error: "businessId required" });
  const targetUserId =
    req.user.accountType === "staff" ? req.user.employerId : req.user.id;
  if (!(await ownsBusiness(targetUserId, businessId)))
    return res.status(403).json({ error: "Forbidden" });

  try {
    const sinceDate = since ? new Date(since) : null;
    const userScope = { userId: targetUserId, businessId };
    const businessScope = { businessId };
    const incremental = sinceDate ? { updatedAt: { gt: sinceDate } } : {};
    const orderBy = sinceDate ? { updatedAt: "asc" } : { date: "desc" };
    const txCap = sinceDate ? undefined : 200;

    const [sales, expenses, transactions, customers, inventory, debts, invoices, recurring] =
      await Promise.all([
        prisma.sales.findMany({
          where: { ...userScope, ...incremental },
          orderBy,
          take: txCap,
        }),
        prisma.expense.findMany({
          where: { ...userScope, ...incremental },
          orderBy,
          take: txCap,
        }),
        prisma.transaction.findMany({
          where: { ...businessScope, ...incremental },
          orderBy,
          take: txCap,
        }),
        prisma.customer.findMany({
          where: { ...userScope, ...incremental },
          include: { debts: { include: { payments: true } } },
          orderBy: sinceDate ? { updatedAt: "asc" } : { createdAt: "desc" },
        }),
        prisma.inventoryItem.findMany({
          where: { ...userScope, ...incremental },
          orderBy: sinceDate ? { updatedAt: "asc" } : { name: "asc" },
        }),
        prisma.businessDebt.findMany({
          where: { ...userScope, ...incremental },
          orderBy: sinceDate ? { updatedAt: "asc" } : { createdAt: "desc" },
        }),
        prisma.invoice.findMany({
          where: { ...businessScope, ...incremental },
          include: {
            items: true,
            payments: { orderBy: { date: "asc" } },
            customer: { select: { id: true, name: true, phone: true } },
          },
          orderBy: sinceDate ? { updatedAt: "asc" } : { createdAt: "desc" },
        }),
        prisma.recurringExpense.findMany({
          where: { userId: targetUserId, businessId, ...incremental },
          orderBy: { nextDue: "asc" },
        }),
      ]);

    res.json({
      sales,
      expenses,
      transactions,
      customers,
      inventory,
      debts,
      invoices,
      recurring,
      syncedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("Sync failed:", err);
    res.status(500).json({ error: "Sync failed" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /sync/pull?businessId=
// Full snapshot for new device login
// ─────────────────────────────────────────────────────────────────────────────
router.get("/pull", async (req, res) => {
  const { businessId } = req.query;
  if (!businessId) return res.status(400).json({ error: "businessId required" });
  if (!(await ownsBusiness(req.user.id, businessId)))
    return res.status(403).json({ error: "Forbidden" });

  try {
    const [transactions, customers, inventory, payables] = await Promise.all([
      prisma.transaction.findMany({
        where: { businessId },
        orderBy: { date: "desc" },
      }),
      prisma.customer.findMany({
        where: { businessId },
        include: { debts: { include: { payments: true } } },
      }),
      prisma.inventoryItem.findMany({ where: { businessId } }),
      prisma.payable.findMany({
        where: { businessId },
        include: { payments: true },
        orderBy: { createdAt: "desc" },
      }),
    ]);

    res.json({ transactions, customers, inventory, payables });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Sync pull failed" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /sync
// Body: { queue: [{ id, type, data, timestamp }] }
// ─────────────────────────────────────────────────────────────────────────────
router.post("/", async (req, res) => {
  const { queue = [] } = req.body;
  if (!Array.isArray(queue) || !queue.length) {
    return res.json({ processed: [], errors: [] });
  }

  const processed = [];
  const errors = [];

  for (const op of queue) {
    try {
      await processOp(op, req.user.id, req.user.name);
      processed.push(op.id);
    } catch (err) {
      console.error(`Sync op ${op.id} (${op.type}) failed:`, err.message);
      errors.push({ id: op.id, type: op.type, error: err.message });
    }
  }

  res.json({ processed, errors });
});

// ─────────────────────────────────────────────────────────────────────────────
// Process a single sync queue operation
// ─────────────────────────────────────────────────────────────────────────────
async function processOp(op, userId, userName) {
  const { type, data } = op;

  async function assertOwns(businessId) {
    if (!(await ownsBusiness(userId, businessId))) {
      throw new Error("Forbidden: business not owned by user");
    }
  }

  switch (type) {

    // ── Businesses ────────────────────────────────────────────────────────────
    case "add_business": {
      await prisma.business.upsert({
        where: { id: data.id },
        create: {
          id: data.id,
          userId,
          name: data.name,
          emoji: data.emoji || "🛍️",
          color: data.color || "#6C3FC5",
        },
        update: {},
      });
      break;
    }

    // ── Transactions ──────────────────────────────────────────────────────────
    case "add_transaction": {
      await assertOwns(data.businessId);
      await prisma.transaction.upsert({
        where: { id: data.id },
        create: {
          id: data.id,
          businessId: data.businessId,
          userId,
          type: data.type,
          amount: Number(data.amount),
          description: data.description || null,
          category: data.category || null,
          customerId: data.customerId || null,
          date: new Date(data.date),
        },
        update: {},
      });
      break;
    }

    case "delete_transaction": {
      const tx = await prisma.transaction.findUnique({ where: { id: data.id } });
      if (tx) {
        await assertOwns(tx.businessId);
        await prisma.transaction.delete({ where: { id: data.id } });
      }
      break;
    }

    // ── Customers ─────────────────────────────────────────────────────────────
    case "add_customer": {
      await assertOwns(data.businessId);
      await prisma.customer.upsert({
        where: { id: data.id },
        create: {
          id: data.id,
          userId,
          businessId: data.businessId,
          name: data.name,
          phone: data.phone || null,
        },
        update: {},
      });
      break;
    }

    case "delete_customer": {
      const c = await prisma.customer.findUnique({ where: { id: data.id } });
      if (c) {
        await assertOwns(c.businessId);
        await prisma.customer.delete({ where: { id: data.id } });
      }
      break;
    }

    // ── Debts ─────────────────────────────────────────────────────────────────
    case "add_debt": {
      const customer = await prisma.customer.findUnique({
        where: { id: data.customerId },
      });
      if (!customer) throw new Error("Customer not found");
      await assertOwns(customer.businessId);

      // Idempotent: only add if debt doesn't already exist
      const existing = await prisma.debt.findUnique({ where: { id: data.id } });
      if (!existing) {
        await prisma.debt.create({
          data: {
            id: data.id,
            customerId: data.customerId,
            amount: Number(data.amount),
            note: data.description || "",
            date: new Date(data.date),
          },
        });
        // Recalculate totalOwed
        const debts = await prisma.debt.findMany({
          where: { customerId: data.customerId },
        });
        const totalOwed = debts.reduce(
          (sum, d) => sum + Math.max(0, d.amount - d.paidAmount),
          0,
        );
        await prisma.customer.update({
          where: { id: data.customerId },
          data: { totalOwed },
        });
      }
      break;
    }

    case "record_payment": {
      const customer = await prisma.customer.findUnique({
        where: { id: data.customerId },
      });
      if (!customer) throw new Error("Customer not found");
      await assertOwns(customer.businessId);

      const debt = await prisma.debt.findUnique({ where: { id: data.debtId } });
      if (debt) {
        const alreadyRecorded = await prisma.debtPayment.findUnique({
          where: { id: data.id },
        });
        if (!alreadyRecorded) {
          await prisma.debtPayment.create({
            data: {
              id: data.id,
              debtId: data.debtId,
              amount: Number(data.amount),
              note: data.note || "",
              date: new Date(data.date),
            },
          });
          const newPaid = Math.min(
            debt.paidAmount + Number(data.amount),
            debt.amount,
          );
          await prisma.debt.update({
            where: { id: data.debtId },
            data: { paidAmount: newPaid, paid: newPaid >= debt.amount },
          });
          // Recalculate totalOwed
          const debts = await prisma.debt.findMany({
            where: { customerId: data.customerId },
          });
          const totalOwed = debts.reduce(
            (sum, d) => sum + Math.max(0, d.amount - d.paidAmount),
            0,
          );
          await prisma.customer.update({
            where: { id: data.customerId },
            data: { totalOwed },
          });
        }
      }
      break;
    }

    // ── Inventory ─────────────────────────────────────────────────────────────
    case "add_inventory_item": {
      await assertOwns(data.businessId);
      await prisma.inventoryItem.upsert({
        where: { id: data.id },
        create: {
          id: data.id,
          userId,
          businessId: data.businessId,
          name: data.name,
          quantity: Number(data.quantity) || 0,
          price: Number(data.unitPrice ?? data.price ?? 0),
          lowStockAlert: Number(data.lowStockThreshold ?? data.lowStockAlert ?? 5),
          createdBy: userId,
          createdByName: userName || null,
        },
        update: {},
      });
      break;
    }

    case "update_inventory_item": {
      const item = await prisma.inventoryItem.findUnique({
        where: { id: data.id },
      });
      if (!item) break;
      await assertOwns(item.businessId);

      const update = {};
      if (data.name !== undefined) update.name = data.name;
      if (data.quantity !== undefined) update.quantity = Number(data.quantity);
      if (data.unitPrice !== undefined) update.price = Number(data.unitPrice);
      if (data.price !== undefined) update.price = Number(data.price);
      if (data.lowStockThreshold !== undefined)
        update.lowStockAlert = Number(data.lowStockThreshold);
      if (data.lowStockAlert !== undefined)
        update.lowStockAlert = Number(data.lowStockAlert);

      if (Object.keys(update).length > 0) {
        await prisma.inventoryItem.update({ where: { id: data.id }, data: update });
      }
      break;
    }

    case "delete_inventory_item": {
      const item = await prisma.inventoryItem.findUnique({
        where: { id: data.id },
      });
      if (item) {
        await assertOwns(item.businessId);
        await prisma.inventoryItem.delete({ where: { id: data.id } });
      }
      break;
    }

    // ── Payables ──────────────────────────────────────────────────────────────
    case "add_payable": {
      await assertOwns(data.businessId);
      await prisma.payable.upsert({
        where: { id: data.id },
        create: {
          id: data.id,
          businessId: data.businessId,
          creditorName: data.creditorName,
          category: data.category || "other",
          amount: Number(data.amount),
          dueDate: data.dueDate ? new Date(data.dueDate) : null,
          note: data.note || null,
          date: new Date(data.date),
        },
        update: {},
      });
      break;
    }

    case "record_payable_payment": {
      const payable = await prisma.payable.findUnique({
        where: { id: data.payableId },
      });
      if (!payable) break;
      await assertOwns(payable.businessId);

      const alreadyRecorded = await prisma.payablePayment.findUnique({
        where: { id: data.id },
      });
      if (!alreadyRecorded) {
        const newPaid = Math.min(
          payable.paidAmount + Number(data.amount),
          payable.amount,
        );
        await prisma.payablePayment.create({
          data: {
            id: data.id,
            payableId: data.payableId,
            amount: Number(data.amount),
            note: data.note || null,
            date: new Date(data.date),
          },
        });
        await prisma.payable.update({
          where: { id: data.payableId },
          data: { paidAmount: newPaid, paid: newPaid >= payable.amount },
        });
      }
      break;
    }

    case "delete_payable": {
      const payable = await prisma.payable.findUnique({ where: { id: data.id } });
      if (payable) {
        await assertOwns(payable.businessId);
        await prisma.payable.delete({ where: { id: data.id } });
      }
      break;
    }

    default:
      throw new Error(`Unknown operation type: ${type}`);
  }
}

module.exports = router;
