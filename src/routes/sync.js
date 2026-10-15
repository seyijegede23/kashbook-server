/**
 * Sync routes
 *
 * POST /sync            — process the client's offline queue
 * GET  /sync/pull?businessId= — pull full snapshot of a business (new device / first login)
 */
const router = require("express").Router();
const auth = require("../middleware/auth");
const prisma = require("../utils/db");
const { isBankLedgerRow } = require("../config/moneySources");
const { audit } = require("../utils/audit");
const { accountsFor, publicAccount } = require("../utils/ledgerData");
const { EXPENSE_INCLUDE, publicExpense } = require("../utils/expenseView");
const { BILL_INCLUDE, billFor, booksOnlyBill } = require("../utils/billView");
const { assertUnlocked, assertUnlockedIn } = require("../utils/booksLock");
const { SALE_ITEMS_INCLUDE, publicSale } = require("./sales").saleLines;
const { canSeeCosts, publicItem } = require("./inventory").itemView;
const { publicGroup, variantCounts } = require("../utils/items");
const { DEPOSIT_INCLUDE, publicDeposit, withDepositIds, assertNotDeposit } = require("../utils/cashDeposits");

// The stock movements the books read beside the records (release 3): stock
// adjusted or valued again counts in the profit (utils/books.js), and the
// opening stock and its value are on the balance sheet. A sale's, invoice's
// or bill's movements are read from their lines.
const BOOKS_STOCK_KINDS = ["adjustment", "revalue", "opening", "opening_value"];

// An invoice for a member without the reports: its lines without what their
// goods cost.
function withoutLineCosts(inv) {
  return { ...inv, items: (inv.items || []).map((it) => ({ ...it, unitCost: null, costAmount: 0 })) };
}

router.use(auth);

// ── Ownership check ──────────────────────────────────────────────────────────
// An id, never a filter: `businessId[in][]=...` arrives as an object, which
// Prisma would read as a filter that matches the caller's own business while
// the scoped queries below then read other businesses too (server.js's
// idGuard refuses it first; this holds even without it).
async function ownsBusiness(userId, businessId) {
  if (typeof businessId !== "string" || !businessId) return false;
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
  if (!businessId || typeof businessId !== "string") return res.status(400).json({ error: "businessId required" });
  const targetUserId =
    req.user.accountType === "staff" ? req.user.employerId : req.user.id;
  if (!(await ownsBusiness(targetUserId, businessId)))
    return res.status(403).json({ error: "Forbidden" });

  try {
    // The cursor the app sends back as `since` on its next pull, taken BEFORE
    // the reads. A record changed after its table was read but before this
    // reply is then newer than the cursor, so the next pull carries it; a
    // cursor taken after the reads would be newer than that record, and no
    // pull would ever send it. A record changed between the cursor and its
    // table's read comes twice, which the app's upserts by id take as one.
    const syncedAt = new Date().toISOString();
    const sinceDate = since ? new Date(since) : null;
    const userScope = { userId: targetUserId, businessId };
    const businessScope = { businessId };
    const incremental = sinceDate ? { updatedAt: { gt: sinceDate } } : {};
    const orderBy = sinceDate ? { updatedAt: "asc" } : { date: "desc" };
    // The full load is what the app's reports are built from, so it has to
    // carry the business's history, not a page of it. At 200 a shop doing a
    // few sales a day lost every month but the last one on reinstall, and
    // the month views showed expenses with no income. 2,500 rows per table
    // is about two years for a busy shop and a few hundred kB gzipped.
    const txCap = sinceDate ? undefined : 2500;
    // Bills are the canManagePayables capability's (owners hold it): those
    // members get them whole. A member who sees the bank rows or the reports
    // gets them for the books alone (booksOnlyBill); anyone else, not at all.
    const canSeeBills = req.user.permissions?.canManagePayables === true;
    const canSeeBank = req.user.permissions?.canViewBalance === true;
    const canSeeReports = req.user.permissions?.canViewReports === true;
    const billsForBooks = canSeeBills || canSeeBank || canSeeReports;

    const [sales, expenses, transactions, customers, inventory, bills, invoices, recurring, journals, stockMoves, itemGroups] =
      await Promise.all([
        // With their lines (release 3), which never change once saved.
        prisma.sales.findMany({
          where: { ...userScope, ...incremental },
          include: SALE_ITEMS_INCLUDE,
          orderBy,
          take: txCap,
        }),
        // With an itemized expense's lines, in their order: the app shows and
        // edits them. Receipts come with the row (publicExpense below).
        prisma.expense.findMany({
          where: { ...userScope, ...incremental },
          include: EXPENSE_INCLUDE,
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
        // Every bill with its payments, never capped: the app's own totals
        // count them (useBooks), so a page of them would be wrong figures. A
        // payment added or taken back moves its bill's updatedAt
        // (routes/bills.js), so an incremental pull carries it.
        billsForBooks
          ? prisma.businessDebt.findMany({
            where: { ...userScope, ...incremental },
            include: BILL_INCLUDE,
            orderBy: sinceDate ? { updatedAt: "asc" } : [{ billDate: "desc" }, { createdAt: "desc" }],
          })
          : [],
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
        // Published adjustments (manual journals), whole on every pull and
        // never capped: their lines on income and spending accounts count in
        // the phone's totals as in the server's (books.js), and one taken back
        // to a draft or deleted must leave the phone's books, which an
        // incremental pull could not say. A business keeps few. Readable with
        // the reports (routes/journals.js), so only those members get them.
        canSeeReports
          ? prisma.manualJournal.findMany({
            where: { businessId, status: "published" },
            select: {
              id: true, businessId: true, number: true, date: true, note: true, status: true, updatedAt: true,
              lines: {
                select: { id: true, accountId: true, debit: true, credit: true, description: true },
                orderBy: [{ position: "asc" }, { id: "asc" }],
              },
            },
            orderBy: [{ date: "asc" }, { id: "asc" }],
          })
          : [],
        // The stock movements the books count (BOOKS_STOCK_KINDS), whole on
        // every pull like the adjustments above: their values are costs, the
        // reports' figure, so only those members get them.
        canSeeReports
          ? prisma.stockMovement.findMany({
            where: { businessId, kind: { in: BOOKS_STOCK_KINDS } },
            select: { id: true, itemId: true, kind: true, reason: true, date: true, quantity: true, value: true },
            orderBy: [{ date: "asc" }, { id: "asc" }],
          })
          : [],
        // Items with variants (items like Zoho, 2026-10-14), archived ones
        // too (archivedAt), as inventory comes: their variants are items.
        prisma.itemGroup.findMany({
          where: { ...userScope, ...incremental },
          orderBy: sinceDate ? { updatedAt: "asc" } : { name: "asc" },
        }),
      ]);
    const groupCounts = await variantCounts(prisma, itemGroups.map((g) => g.id));
    // Cash deposits (2026-10-14), the owner's only, every status, changed
    // since the last pull like the lists above (a business keeps few).
    const isOwner = req.user.accountType !== "staff";
    const cashDeposits = isOwner
      ? await prisma.cashDeposit.findMany({
        where: { businessId, ...incremental },
        include: DEPOSIT_INCLUDE,
        orderBy: sinceDate ? { updatedAt: "asc" } : [{ date: "desc" }, { createdAt: "desc" }],
      })
      : null;
    // The chart of accounts, whole on every pull (a business has well under
    // a hundred): every member picks accounts, nobody gets amounts from it.
    const accounts = await accountsFor(businessId);

    // THE BULK PULL IS A PERMISSION SURFACE, not just a cache warm-up.
    //
    // The app calls this once on every launch and drops the result straight
    // into AppContext, so anything returned here is in the staff member's
    // hands regardless of which screens are gated. Two payloads must not be:
    //
    //   transactions — every bank credit and debit with amounts. Handing these
    //                  over makes canViewBalance decorative: the balance is
    //                  hidden while the entire ledger that produces it is not.
    //   recurring    — standing auto-debit instructions INCLUDING the payee
    //                  account numbers. The whole recurringExpenses router is
    //                  ownerOnly precisely because NO capability is meant to
    //                  unlock a standing instruction, so gating these on
    //                  canViewBalance would have been the wrong gate: it would
    //                  hand them to a trusted staff member the owner-only rule
    //                  says must never see them. Owners only, full stop.
    //   bills        — what the business owes, and to whom: canManagePayables,
    //                  as on every route in routes/bills.js (read above). A
    //                  member with the bank rows or the reports gets only what
    //                  the books read (booksOnlyBill).
    //   journals     — published adjustments: canViewReports, as on the
    //                  journals routes.
    //
    //   costs        — what goods cost (an item's stockValue and avgCost, a
    //                  sale line's unitCost and costAmount, stockMoves) and
    //                  the purchase information of items and item groups
    //                  (purchasePrice, purchaseDescription, purchaseAccountId,
    //                  preferredSupplier): the reports' figure,
    //                  canViewReports. Others get the items, groups and lines
    //                  without them.
    //
    // Sales, expenses, customers, inventory and invoices are the bookkeeping a
    // staff member is employed to do, and stay.
    const canSeeCost = canSeeCosts(req);
    res.json({
      // Each with its lines ([] for a sale without); a line of goods whose
      // stock is not counted says so (tracked false), as an invoice line does.
      sales: sales.map((s) => publicSale(s, canSeeCost)),
      // A receipt's storage keys never leave the server (utils/expenseView.js).
      expenses: expenses.map(publicExpense),
      // Each with cashDepositId: the cash deposit a credit is, else null
      // (staff who see the bank rows get no deposits, and tell one by this).
      transactions: canSeeBank ? await withDepositIds(prisma, transactions) : [],
      customers,
      // Archived items come too (archivedAt): the app keeps them out of its
      // lists and pickers.
      inventory: inventory.map((i) => publicItem(i, canSeeCost)),
      // Items with variants, each with variantCount (its variants not
      // archived); upserted by id like inventory.
      itemGroups: itemGroups.map((g) => publicGroup(g, canSeeCost, groupCounts.get(g.id) || 0)),
      // Bills replace payables (release 2): each with its payments, in the
      // shape routes/bills.js answers with.
      // A member without the bank rows gets each payment from the KashBook
      // account as a plain transfer, without its debit (booksOnlyBill).
      bills: bills.map((b) => (canSeeBills ? billFor(b, { canSeeBank }) : booksOnlyBill(b, { canSeeBank }))),
      // An invoice line's cost (release 3: what the goods it took cost) is
      // the reports' figure too.
      invoices: canSeeCost ? invoices : invoices.map(withoutLineCosts),
      recurring: isOwner ? recurring : [],
      accounts: accounts.map(publicAccount),
      // Every published adjustment (see above): the app replaces its list.
      journals: canSeeReports ? journals : null,
      // The stock movements the books count (see above): the app replaces
      // its list; null for a member without the reports.
      stockMoves: canSeeReports ? stockMoves : null,
      // Cash deposits (owner only; null for staff), each with its linked
      // transfer while it has arrived.
      cashDeposits: cashDeposits ? cashDeposits.map(publicDeposit) : null,
      // Told, not silently emptied — the client can distinguish "no bank
      // activity" from "not yours to see" instead of rendering a confident zero.
      bankWithheld: !canSeeBank,
      syncedAt,
    });
  } catch (err) {
    console.error("Sync failed:", err);
    res.status(500).json({ error: "Sync failed" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /sync/pull?businessId=
// Full snapshot for new device login. The legacy payables it used to carry are
// retired (release 2): bills come with GET /sync above.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/pull", async (req, res) => {
  const { businessId } = req.query;
  if (!businessId || typeof businessId !== "string") return res.status(400).json({ error: "businessId required" });
  if (!(await ownsBusiness(req.user.id, businessId)))
    return res.status(403).json({ error: "Forbidden" });

  try {
    const [transactions, customers, inventory] = await Promise.all([
      prisma.transaction.findMany({
        where: { businessId },
        orderBy: { date: "desc" },
      }),
      prisma.customer.findMany({
        where: { businessId },
        include: { debts: { include: { payments: true } } },
      }),
      prisma.inventoryItem.findMany({ where: { businessId } }),
    ]);

    // Same rule as the main pull above. This variant scopes on req.user.id so
    // only an owner reaches it today, but that is scoping, not a capability
    // check, and it would stop holding the moment someone "consistency-fixes"
    // it to ownerIdOf(req) — which is precisely the tidy-up this codebase
    // invites. Gate it explicitly rather than rely on the accident.
    const canSeeBank = req.user.permissions?.canViewBalance === true;
    const canSeeCost = canSeeCosts(req);
    res.json({
      transactions: canSeeBank ? await withDepositIds(prisma, transactions) : [],
      customers,
      inventory: inventory.map((i) => publicItem(i, canSeeCost)),
      bankWithheld: !canSeeBank,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Sync pull failed" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /sync
// Body: { queue: [{ id, type, data, timestamp }] }
// ─────────────────────────────────────────────────────────────────────────────
// Cap the queue. Each op runs 1-5 sequential DB round-trips against a small
// connection pool, so an unbounded queue (a 10MB body holds ~50k minimal ops)
// was the cheapest way for one authenticated request to stall the whole API.
const MAX_SYNC_OPS = 500;

router.post("/", async (req, res) => {
  const { queue = [] } = req.body;
  if (!Array.isArray(queue) || !queue.length) {
    return res.json({ processed: [], errors: [] });
  }
  if (queue.length > MAX_SYNC_OPS) {
    return res.status(413).json({
      error: `Too many operations in one sync (${queue.length}). Send at most ${MAX_SYNC_OPS} per request.`,
      code: "SYNC_QUEUE_TOO_LARGE",
      maxOps: MAX_SYNC_OPS,
    });
  }

  const processed = [];
  const errors = [];

  for (const op of queue) {
    try {
      await processOp(op, req.user.id, req.user.name, req.user.accountType);
      processed.push(op.id);
    } catch (err) {
      // Log the real reason server-side, return a STABLE code to the client.
      // Raw err.message here was leaking Prisma internals — table names, column
      // names, constraint names and record values (e.g. "Unique constraint
      // failed on the fields: (userId,phone)") — a free schema map, and an
      // existence oracle when combined with a guessed id.
      console.error(`Sync op ${op.id} (${op.type}) failed:`, err.message);
      errors.push({
        id: op.id,
        type: op.type,
        error: err.expose ? err.message : "This item could not be synced.",
        code: err.code && !String(err.code).startsWith("P") ? err.code : "SYNC_OP_FAILED",
      });
    }
  }

  res.json({ processed, errors });
});

// ─────────────────────────────────────────────────────────────────────────────
// Process a single sync queue operation
// ─────────────────────────────────────────────────────────────────────────────
async function processOp(op, userId, userName, accountType) {
  const { type, data } = op;

  async function assertOwns(businessId) {
    if (!(await ownsBusiness(userId, businessId))) {
      throw new Error("Forbidden: business not owned by user");
    }
  }

  switch (type) {

    // ── Businesses ────────────────────────────────────────────────────────────
    case "add_business": {
      // Every other op in this switch calls assertOwns() first. This one wrote a
      // Business row with userId taken from the CALLER, checking nothing — so a
      // staff member could create a business they personally own, through the
      // sync endpoint, while POST /businesses refuses them outright and enforces
      // the free-plan limit. That row would then be outside their employer's
      // control entirely.
      //
      // Business creation is owner-only and belongs to POST /businesses, which
      // applies the plan cap, the country/currency binding and the name rules.
      // None of that can be reproduced here, so the op is refused rather than
      // half-implemented.
      if (accountType === "staff") {
        throw new Error("Forbidden: staff cannot create businesses");
      }
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
      // A synced offline row is manual bookkeeping only. Never let the client mint
      // a bank-ledger row (that would inflate the spendable balance): reject a
      // "bank" method or any provider source, and never copy those fields into the
      // create (paymentMethod defaults to "cash").
      if (data.paymentMethod === "bank" || data.source) {
        throw Object.assign(new Error("Bank transactions can't be created here."), { code: "BANK_ROW_FORBIDDEN" });
      }
      // The books lock date (utils/booksLock.js), as on every route that adds,
      // changes or removes a dated record: nothing on or before it.
      await assertUnlocked(data.businessId, data.date);
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
        // Bank-ledger rows are provider-owned + append-only. Deleting one would
        // silently change the spendable balance (re-inflate a payout, drop a
        // credit) — refuse and leave an audit trail. Manual/cash rows stay deletable.
        if (isBankLedgerRow(tx)) {
          await audit({
            actorOverride: { type: "user", id: userId }, // attribute the blocked attempt to the caller
            action: "SYNC_DELETE_BANK_BLOCKED", resourceType: "transaction", resourceId: tx.id,
            severity: "warning", metadata: { source: tx.source, paymentMethod: tx.paymentMethod, category: tx.category, businessId: tx.businessId },
          }).catch(() => {});
          throw Object.assign(new Error("Bank transactions can't be deleted."), { code: "BANK_ROW_IMMUTABLE" });
        }
        // Under the business lock, where every link to a row is written, and
        // read again there: a row another record carries (a bill payment, a
        // customer refund, a match) is not deleted under it, or that record
        // would keep counting money no row backs (as DELETE /transactions/:id
        // refuses it).
        await prisma.withBusinessLock(tx.businessId || tx.userId, async () => {
          const cur = await prisma.transaction.findUnique({ where: { id: tx.id } });
          if (!cur) return;
          if (cur.matchedBillId) {
            throw Object.assign(new Error("This transfer paid a bill. Remove the payment from the bill before deleting it."), { code: "BILL_LINKED" });
          }
          // A cash deposit's credit is the deposit's (DEPOSIT_LINKED).
          await assertNotDeposit(prisma, cur.id);
          if (cur.purpose === "customer_refund" || cur.matchedSaleId || cur.matchedCustomerId || cur.matchedExpenseId || cur.matchedInvoiceId) {
            throw Object.assign(new Error("This transaction is linked to a record. Remove that link before deleting it."), { code: "MATCHED_ROW_LOCKED" });
          }
          await assertUnlocked(cur.businessId, cur.date);
          await prisma.transaction.delete({ where: { id: cur.id } });
        });
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
        // Same rule as DELETE /customers/:id: owners only, and never once
        // repayments, credit sales or a matched transfer are in the books.
        if (accountType === "staff") {
          throw Object.assign(new Error("Staff cannot delete customers"), { code: "OWNER_ONLY" });
        }
        const [repaid, creditSales, transfers] = await Promise.all([
          prisma.debtPayment.count({ where: { debt: { customerId: c.id } } }),
          prisma.debt.count({ where: { customerId: c.id, saleId: { not: null } } }),
          prisma.transaction.count({ where: { matchedCustomerId: c.id } }),
        ]);
        if (repaid || creditSales || transfers) {
          throw Object.assign(
            new Error("This customer has repayments or credit sales in your books, so they can't be deleted."),
            { code: "CUSTOMER_HAS_PAYMENTS" },
          );
        }
        // Credit given with no sale counts on its own day ("when sold"), and
        // goes with the customer.
        const credit = await prisma.debt.findMany({ where: { customerId: c.id }, select: { date: true } });
        await assertUnlocked(c.businessId, credit.map((d) => d.date));
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
        await assertUnlocked(customer.businessId, data.date);
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

      // SECURITY: bind the debt to the authorised customer. Fetching by id
      // alone allowed a cross-tenant write — pass your own customerId (passes
      // the ownership check above) plus a victim's debtId, and their receivable
      // ledger gets modified.
      const debt = await prisma.debt.findFirst({
        where: { id: data.debtId, customerId: customer.id },
      });
      if (debt) {
        // Books rule: a repayment is a counted sale, so it is never more than
        // the debt still owes (a stale phone replaying it would otherwise count
        // money that never arrived), and it is written with the debt in one
        // transaction under the business lock.
        const lockKey = customer.businessId || customer.userId;
        await prisma.withBusinessLock(lockKey, () =>
          prisma.$transaction(async (px) => {
            const alreadyRecorded = await px.debtPayment.findUnique({ where: { id: data.id } });
            if (alreadyRecorded) return;
            const fresh = await px.debt.findUnique({ where: { id: debt.id } });
            const remaining = Math.round((fresh.amount - fresh.paidAmount) * 100) / 100;
            const amount = Math.min(Math.round(Number(data.amount) * 100) / 100, remaining);
            if (!(amount > 0)) return; // already paid: nothing left to record
            const sent = new Date(data.date);
            const when = Number.isNaN(sent.getTime()) ? new Date() : sent;
            // A repayment counts on its own day: never one on or before the
            // books lock date. Read in this transaction, under the lock.
            await assertUnlockedIn(px, customer.businessId, when);
            await px.debtPayment.create({
              data: {
                id: data.id,
                debtId: fresh.id,
                amount,
                note: data.note || "",
                date: when,
              },
            });
            const newPaid = Math.min(fresh.amount, Math.round((fresh.paidAmount + amount) * 100) / 100);
            // Compare-and-set: match-debt locks on the transfer's business,
            // which for a customer with no business is another key.
            const moved = await px.debt.updateMany({
              where: { id: fresh.id, paidAmount: fresh.paidAmount },
              data: { paidAmount: newPaid, paid: newPaid >= fresh.amount - 0.005 },
            });
            if (moved.count !== 1) throw Object.assign(new Error("This debt just changed. Try again."), { code: "DEBT_CHANGED" });
            const debts = await px.debt.findMany({ where: { customerId: data.customerId } });
            const totalOwed = debts.reduce((sum, d) => sum + Math.max(0, d.amount - d.paidAmount), 0);
            await px.customer.update({ where: { id: data.customerId }, data: { totalOwed } });
          }),
        );
      }
      break;
    }

    // The legacy inventory ops (add_inventory_item, update_inventory_item,
    // delete_inventory_item) are retired with release 3: an item's stock and
    // cost change only through the stock engine (utils/stock.js) behind
    // routes/inventory.js, with a movement for every change, so an op naming
    // one is an unknown op.
    // The legacy payable ops (add_payable, record_payable_payment,
    // delete_payable) are retired with payables (release 2): bills live in
    // routes/bills.js, and an op naming one is an unknown op.
    default:
      throw new Error(`Unknown operation type: ${type}`);
  }
}

module.exports = router;
