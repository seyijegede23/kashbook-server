const router = require("express").Router();
const prisma = require("../utils/db");
const chart = require("../utils/chart");
const { assertAccountUsable, accountsFor } = require("../utils/ledgerData");
const auth = require("../middleware/auth");
const { requirePermission } = require("../middleware/requirePermission");
const { normalizeChannel } = require("../utils/salesChannel");
const { isBankLedgerRow, isSavingsRow } = require("../config/moneySources");
const { audit } = require("../utils/audit");
const { CREDIT_OUTCOMES } = require("../utils/books");
const { recordLink, linkedFrom } = require("../utils/paymentLinks");
const { EXPENSE_INCLUDE, publicExpense } = require("../utils/expenseView");
const { cleanReference, expenseCustomerId } = require("../utils/expenseFields");
const { destroyReceipts } = require("../utils/receiptStorage");
const { assertUnlocked, assertUnlockedIn } = require("../utils/booksLock");
const { readSaleItems, saleChart, writeSaleItems, removeSaleStock, publicSale } = require("./sales").saleLines;
const { canSeeCosts, publicItem } = require("./inventory").itemView;

// MOUNTED as of Aug 2026 — it sat unmounted for months while the app called its
// match endpoints, so "Match to Sale or Debt" silently 404'd and reverted.
// Bank-ledger rows remain provider-owned and append-only: POST refuses creating
// them, PATCH/DELETE refuse touching them. Matching (below) only LABELS credits
// and moves bookkeeping records; it never edits a bank row's money fields.
//
// The lock date (chart of accounts release 2, utils/booksLock.js): a bank row
// dated on or before it is never refused (the bank's own rows always arrive,
// and the webhooks never ask), but explaining one is: matching it, recording
// a sale or an expense from it, applying it to a debt, linking a repayment to
// it, marking or categorizing it, and undoing any of those. Every such route
// also asks with the days of the records it moves (a matched sale's, a
// repayment's), and a manual row is a dated record of its own. Each asks
// under the business lock, which the lock date is set under.

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
    const when = new Date(date);
    const tx = await prisma.withBusinessLock(businessId, async () => {
      await assertUnlocked(businessId, when);
      return prisma.transaction.create({
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
          date: when,
          recordedBy: req.user.id,
          recordedByName: req.user.name,
        },
      });
    });
    res.status(201).json(tx);
  } catch (err) {
    if (err && err.status && err.code) return respondMatchFailure(res, err, "Failed to create transaction");
    res.status(500).json({ error: "Failed to create transaction" });
  }
});

// ── Rows another record carries ──────────────────────────────────────────
// A row another record names carries money that record counts: a row matched
// to a sale, to a customer's repayments, to an expense or to invoice payments;
// a debit that paid a bill (release 2), which the bill payment names; or a
// debit that paid a credit note's refund (marked customer_refund), which the
// refund names. That record keeps counting all it carries, so a smaller amount
// or a deleted row would leave money counted that no row backs (in the
// ledger, Bank Matching or Undeposited Funds off by the difference). The link
// is undone first, where it was made: a bill payment on the bill, a refund on
// the credit note, a match here (DELETE /:id/match). The app offers neither
// change on a bank row; this holds a direct call to the same rule.
function carriedBy(tx) {
  if (tx.matchedBillId) return "bill";
  if (tx.purpose === "customer_refund") return "refund";
  if (tx.matchedSaleId || tx.matchedCustomerId || tx.matchedExpenseId || tx.matchedInvoiceId) return "match";
  return null;
}
const UNDO_FIRST = {
  bill: "This transfer paid a bill. Remove the payment from the bill",
  refund: "This transfer paid a customer refund. Remove the refund from the credit note",
  match: "This transaction is matched to a record. Unmatch it",
};

// The refusal for changing the amount of ("amount") or deleting ("delete") a
// row another record carries, saying what to undo first; null when nothing
// carries it. Deleting a debit a bill payment carries is refused as
// unmatching it is (BILL_LINKED).
function carriedRowRefusal(tx, action) {
  const by = carriedBy(tx);
  if (!by) return null;
  if (action === "amount") {
    return matchError(409, "MATCHED_ROW_AMOUNT_LOCKED", `${UNDO_FIRST[by]} before changing the amount.`);
  }
  return matchError(409, by === "bill" ? "BILL_LINKED" : "MATCHED_ROW_LOCKED", `${UNDO_FIRST[by]} before deleting it.`);
}

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
    // other rows' legitimate remainders inside summed aggregates. A debit a
    // bill payment or a refund carries is held the same way (carriedBy).
    // Undo the link first, then edit.
    const amountRefusal = amount !== undefined ? carriedRowRefusal(tx, "amount") : null;
    if (amountRefusal) return respondMatchFailure(res, amountRefusal, "Failed to update transaction");
    // The lock date: the row's day before and after the edit, read again
    // under the business lock. The links too: a bill payment, a refund or a
    // match takes this lock to name the row, so the check above is the quick
    // answer and this one the guarantee.
    const updated = await prisma.withBusinessLock(tx.businessId, async () => {
      const cur = await prisma.transaction.findUnique({ where: { id: tx.id } });
      if (!cur) throw matchError(404, "TRANSACTION_NOT_FOUND", "Transaction not found");
      if (amount !== undefined) {
        const linked = carriedRowRefusal(cur, "amount");
        if (linked) throw linked;
      }
      await assertUnlocked(cur.businessId, cur.date, date !== undefined ? new Date(date) : null);
      return prisma.transaction.update({
        where: { id: cur.id },
        data: {
          ...(amount !== undefined && { amount: Number(amount) }),
          ...(description !== undefined && { description }),
          ...(category !== undefined && { category }),
          ...(paymentMethod !== undefined && { paymentMethod }),
          ...(date !== undefined && { date: new Date(date) }),
        },
      });
    });
    res.json(updated);
  } catch (err) {
    if (err && err.status && err.code) return respondMatchFailure(res, err, "Failed to update transaction");
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
    // Nor a row another record carries (carriedBy): that record would go on
    // counting money no row backs.
    const linkRefusal = carriedRowRefusal(tx, "delete");
    if (linkRefusal) return respondMatchFailure(res, linkRefusal, "Failed to delete transaction");

    // The lock date: the row's day, read again under the business lock, and
    // the links with it, as on PATCH.
    await prisma.withBusinessLock(tx.businessId, async () => {
      const cur = await prisma.transaction.findUnique({ where: { id: tx.id } });
      if (!cur) return;
      const linked = carriedRowRefusal(cur, "delete");
      if (linked) throw linked;
      await assertUnlocked(cur.businessId, cur.date);
      await prisma.transaction.delete({ where: { id: cur.id } });
    });
    res.json({ message: "Deleted" });
  } catch (err) {
    if (err && err.status && err.code) return respondMatchFailure(res, err, "Failed to delete transaction");
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
//   * a credit already explained, by a purpose or by an account from the
//     chart of accounts, is never matched as well (checked in both places)
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
  // Marked as not income (cash already recorded, own transfer, a loan...), or
  // explained with an account (money in on an income account keeps no
  // purpose). Either way it is explained, and a match would count it twice.
  if (tx.purpose || tx.accountId) {
    res.status(409).json({
      error: tx.accountId
        ? "This transfer is explained with an account. Clear that first."
        : "This transfer is marked as not a sale. Clear that first.",
      code: "MARKED_NOT_INCOME",
    });
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

// Translate a coded matchError into a response; 500 for anything else. An
// expense detail refused by utils/expenseFields.js also says which field, and
// a refusal may carry more for the app (`extra`: the lock date of a
// BOOKS_LOCKED refusal).
function respondMatchFailure(res, err, fallback) {
  if (err && err.status && err.code) {
    return res.status(err.status).json({
      error: err.message,
      code: err.code,
      ...(err.field ? { field: err.field } : {}),
      ...(err.extra || {}),
    });
  }
  console.error(`[transactions] ${fallback}:`, err);
  return res.status(500).json({ error: fallback });
}

// The owner's stake (chart of accounts, 2026-10-12). Equity accounts, the
// owner's own money put in or taken out, are the owner's to use
// (utils/ledgerData.js assertAccountUsable), and what the owner filed there is
// the owner's to change: staff may neither move nor clear it, whether it was
// filed by an account or by a purpose. A purpose stands for the account the
// ledger books it on (utils/chart.js PURPOSE_ACCOUNT); the ones that stand for
// an equity account are read from the chart, so the two never disagree.
// Today that is the owner's money.
const OWNER_ONLY_PURPOSES = Object.keys(chart.PURPOSE_ACCOUNT).filter((purpose) => {
  const sys = chart.DEFAULT_CHART.find((a) => a.sys === chart.PURPOSE_ACCOUNT[purpose]);
  return !!sys && chart.classOf(sys.type) === "equity";
});
const OWNERS_STAKE_REFUSAL = "The owner filed this as their own money. Only the business owner can change it.";

// Whether a bank row sits in the owner's stake: the account it names when it
// names one, else the account its purpose stands for, as the ledger books it
// (utils/chart.js bankRowAccount). Read under the business lock on the row as
// it is then, so an owner's change a moment earlier counts.
async function inOwnersStake(px, tx) {
  if (tx.accountId) {
    const acc = await px.ledgerAccount.findUnique({ where: { id: tx.accountId }, select: { type: true } });
    if (acc) return chart.classOf(acc.type) === "equity";
  }
  return OWNER_ONLY_PURPOSES.includes(tx.purpose);
}

// Whether an expense is filed in the owner's stake (the owner's drawings), as
// a whole or on one of its lines. Only the owner can file one there.
async function expenseInOwnersStake(px, expense) {
  const ids = [expense.accountId, ...(expense.items || []).map((it) => it.accountId)].filter(Boolean);
  if (!ids.length) return false;
  const accs = await px.ledgerAccount.findMany({ where: { id: { in: ids } }, select: { type: true } });
  return accs.some((a) => chart.classOf(a.type) === "equity");
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
        if (tx.matchedSaleId || tx.matchedCustomerId || tx.matchedInvoiceId || tx.purpose || tx.accountId)
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
        // The lock date: the transfer's day, and the sale's, whose money now
        // comes from the transfer.
        await assertUnlockedIn(px, tx.businessId, tx.date, sale.date);

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

// POST /transactions/:id/create-sale
//   { amount?, description?, channel?, customerId?, accountId?, items? }
// The transfer IS the sale — record it in one step, already matched, so the
// income is counted exactly once. The DATE always comes from the credit (same
// reporting period as the money); the AMOUNT may be composed in the full Add
// form but is capped at the transfer (see resolveCappedAmount). items: what
// was sold, as on POST /sales (routes/sales.js): goods leave the stock on the
// transfer's day, and the sale counts as its lines' accounts (accountId is
// then not used). Answers 201 { sale (with items), transaction, remainder,
// inventory: [the goods items as they now are] }.
router.post("/:id/create-sale", requirePermission("canViewBalance"), async (req, res) => {
  const { channel, customerId, accountId } = req.body || {};
  const description = clampText((req.body || {}).description, 500);
  const isStaff = req.user.accountType === "staff";
  try {
    const pre = await loadMatchableCredit(req, res);
    if (!pre) return;
    // A quick answer; the cap that counts is taken again under the lock.
    resolveCappedAmount(req.body || {}, pre);
    // Every line read before anything is looked up (routes/sales.js).
    const lines = readSaleItems((req.body || {}).items);
    const account = lines ? null : await assertAccountUsable(pre.businessId, accountId, "income", { isStaff });

    if (customerId) {
      const customer = await prisma.customer.findUnique({ where: { id: customerId } });
      if (!customer || customer.userId !== getTargetUserId(req))
        return res.status(404).json({ error: "Customer not found" });
    }

    const result = await prisma.withBusinessLock(pre.businessId, async () => {
      // The chart, for the account each line counts as, read under the lock.
      const chartIdx = lines ? await saleChart(pre.businessId) : null;
      return prisma.$transaction(async (px) => {
        const tx = await px.transaction.findUnique({ where: { id: pre.id } });
        if (tx.matchedSaleId || tx.matchedCustomerId || tx.matchedInvoiceId || tx.purpose || tx.accountId)
          throw matchError(409, "ALREADY_MATCHED", "This transfer is already matched.");
        // The cap on the transfer as it is now: a manual row's amount can
        // change between the read above and this lock (PATCH /:id), and the
        // sale never carries more than the row (matchedAmount ≤ amount).
        const { amount, remainder } = resolveCappedAmount(req.body || {}, tx);
        // The lock date: the sale is dated the transfer's day.
        await assertUnlockedIn(px, tx.businessId, tx.date);

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
            accountId: account ? account.id : null,
          },
        });
        const written = lines
          ? await writeSaleItems(px, { sale, lines, chartIdx, isStaff, createdById: req.user.id })
          : { items: [], inventory: [] };
        const updatedTx = await px.transaction.update({
          where: { id: tx.id },
          data: { matchedSaleId: sale.id, matchedAmount: amount },
        });
        return { sale, ...written, transaction: updatedTx, amount, remainder };
      }, { timeout: 20000 });
    });

    audit({
      req, action: "TX_MATCH_CREATE_SALE", resourceType: "transaction", resourceId: pre.id,
      metadata: { saleId: result.sale.id, amount: result.amount, remainder: result.remainder, lines: result.items.length },
    }).catch(() => {});
    const canSee = canSeeCosts(req);
    res.status(201).json({
      sale: publicSale(result.sale, canSee, result.items),
      transaction: result.transaction,
      remainder: result.remainder,
      inventory: result.inventory.map((i) => publicItem(i, canSee)),
    });
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
  // A refund to a customer lowers sales; it is never an expense too. Nor is a
  // transfer explained with an account (money out on an expense account keeps
  // no purpose): it is explained already, and an expense would explain it twice.
  if (tx.purpose || tx.accountId) {
    res.status(409).json({
      error: tx.accountId
        ? "This transfer is explained with an account. Clear that first."
        : "This transfer paid a customer refund.",
      code: "MARKED_NOT_EXPENSE",
    });
    return null;
  }
  if (tx.matchedExpenseId) {
    res.status(409).json({ error: "This transfer is already recorded as an expense. Unmatch it first.", code: "ALREADY_MATCHED" });
    return null;
  }
  // A payment towards a bill (release 2) already carries this money; an
  // expense would count it twice.
  if (tx.matchedBillId) {
    res.status(409).json({ error: "This transfer paid a bill. Remove that payment from the bill first.", code: "ALREADY_MATCHED" });
    return null;
  }
  return tx;
}

// POST /transactions/:id/create-expense
//   { amount?, description?, category?, accountId?, reference?, customerId? }
// The outbound mirror: tap a transfer you SENT and record what it paid for.
// Same cap rule, same lock + in-lock re-check, same exclusion consequence —
// the bank debit stops counting in expense aggregates because the categorised
// Expense row now carries that money. The supplier's reference and the
// customer the cost was for are checked as POST /expenses checks them
// (utils/expenseFields.js); lines are not taken here. Staff file only under a
// category the chart already has (anything else is Other Expenses), because
// only the owner adds accounts.
router.post("/:id/create-expense", requirePermission("canViewBalance"), async (req, res) => {
  const description = clampText((req.body || {}).description, 500);
  const category0 = clampText((req.body || {}).category, 40).toLowerCase() || "other";
  const isStaff = req.user.accountType === "staff";
  try {
    const pre = await loadMatchableDebit(req, res);
    if (!pre) return;
    // A quick answer; the cap that counts is taken again under the lock.
    resolveCappedAmount(req.body || {}, pre);
    const reference = cleanReference((req.body || {}).reference);
    const customerId = await expenseCustomerId(getTargetUserId(req), pre.businessId, (req.body || {}).customerId);
    // A category no account stands for becomes an account the next time the
    // chart is read (utils/ledgerData.js ensureChart), and only the owner adds
    // to the chart (routes/ledger.js). So for staff the chart is set up first:
    // its first set-up turns every category in use into an account, and would
    // take the staff member's text along. Before the business lock, because
    // setting the chart up takes a lock of its own and nesting two would hold
    // two connections (utils/db.js).
    if (isStaff) await accountsFor(pre.businessId);

    const result = await prisma.withBusinessLock(pre.businessId, async () => {
      // Checked under the lock an account merge or delete also takes
      // (routes/ledger.js), so the account is still there when the expense
      // is saved with it.
      const account = await assertAccountUsable(pre.businessId, (req.body || {}).accountId, "expense", { isStaff });
      // The account's own category when it stands for one, so older app
      // versions file the expense in the same place.
      let category = account && account.categorySlug ? account.categorySlug : category0;
      // Staff: the category of an active account that stands for what they
      // sent, as its own or as one merged into it (an older app still offers
      // a category the owner merged away), else Other Expenses. Never a new
      // account, and never a default the owner deleted or rested. Read under
      // the lock for the same reason. An account's own category beats one
      // merged into another, as chart.indexChart reads them.
      if (isStaff && !(account && account.categorySlug)) {
        const slug = chart.canonicalSlug(category0);
        const known = await prisma.ledgerAccount.findMany({
          where: { businessId: pre.businessId, inactiveAt: null, OR: [{ categorySlug: slug }, { aliasSlugs: { has: slug } }] },
          select: { categorySlug: true },
          // The chart's own order (utils/ledgerData.js accountsFor).
          orderBy: [{ createdAt: "asc" }, { name: "asc" }],
        });
        const hit = known.find((a) => a.categorySlug === slug) || known[0];
        category = (hit && hit.categorySlug) || "other";
      }
      return prisma.$transaction(async (px) => {
        const tx = await px.transaction.findUnique({ where: { id: pre.id } });
        if (tx.matchedExpenseId || tx.matchedBillId || tx.purpose || tx.accountId)
          throw matchError(409, "ALREADY_MATCHED", "This transfer is already recorded as an expense.");
        // The cap on the transfer as it is now, as for a sale: the expense
        // never carries more than the row (matchedAmount ≤ amount).
        const { amount, remainder } = resolveCappedAmount(req.body || {}, tx);
        // The lock date: the expense is dated the transfer's day.
        await assertUnlockedIn(px, tx.businessId, tx.date);

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
            accountId: account ? account.id : null,
            reference: reference || null,
            customerId: customerId || null,
          },
          include: EXPENSE_INCLUDE,
        });
        const updatedTx = await px.transaction.update({
          where: { id: tx.id },
          data: { matchedExpenseId: expense.id, matchedAmount: amount },
        });
        return { expense, transaction: updatedTx, amount, remainder };
      });
    });

    audit({
      req, action: "TX_MATCH_CREATE_EXPENSE", resourceType: "transaction", resourceId: pre.id,
      metadata: { expenseId: result.expense.id, amount: result.amount, remainder: result.remainder, category: result.expense.category },
    }).catch(() => {});
    // As every expense response: lines ([] here) and receipts without their
    // storage keys (utils/expenseView.js).
    res.status(201).json({ expense: publicExpense(result.expense), transaction: result.transaction, remainder: result.remainder });
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
    // books (its debts count there) while the credit stops counting here. A
    // customer always belongs to one business (release 2): one with none (its
    // business was deleted) is in no books, and the naira would vanish.
    if (!customer || customer.userId !== getTargetUserId(req) || customer.businessId !== pre.businessId)
      return res.status(404).json({ error: "Customer not found" });

    const result = await prisma.withBusinessLock(pre.businessId, () =>
      prisma.$transaction(async (px) => {
        // The re-check under the lock is what killed the double-apply bug: the
        // old handler never looked at matchedCustomerId, so calling it twice
        // paid the debt down twice.
        const tx = await px.transaction.findUnique({ where: { id: pre.id } });
        if (tx.matchedSaleId || tx.matchedCustomerId || tx.matchedInvoiceId || tx.purpose || tx.accountId)
          throw matchError(409, "ALREADY_MATCHED", "This transfer is already matched.");
        // The lock date: the repayments are dated the transfer's day.
        await assertUnlockedIn(px, tx.businessId, tx.date);

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

// Every day an unmatch changes, for the lock date: the transfer's own, the
// day of the sale or expense it carried (which counts on its own again, or
// goes), and the day of each repayment and invoice payment it made or was
// linked to, with the day a linked one goes back to.
async function unmatchDays(px, tx) {
  const days = [tx.date];
  if (tx.matchedSaleId) {
    const sale = await px.sales.findUnique({ where: { id: tx.matchedSaleId }, select: { date: true } });
    if (sale) days.push(sale.date);
  }
  if (tx.matchedExpenseId) {
    const expense = await px.expense.findUnique({ where: { id: tx.matchedExpenseId }, select: { date: true } });
    if (expense) days.push(expense.date);
  }
  const linked = [
    ...(tx.matchedCustomerId
      ? (await px.debtPayment.findMany({ where: { transactionId: tx.id }, select: { id: true, date: true } })).map((p) => ({ kind: "debt_payment", p }))
      : []),
    ...(tx.matchedInvoiceId
      ? (await px.invoicePayment.findMany({ where: { transactionId: tx.id }, select: { id: true, date: true } })).map((p) => ({ kind: "invoice_payment", p }))
      : []),
  ];
  for (const { kind, p } of linked) {
    days.push(p.date);
    const was = await linkedFrom(px, kind, p.id, tx.id);
    if (was && was.date) days.push(new Date(was.date));
  }
  return days;
}

// A debit that paid a bill (release 2) is undone from the bill, where the
// payment is: unmatching it here would leave the payment counting with no
// money behind it.
const BILL_LINKED = "This transfer paid a bill. Remove the payment from the bill instead.";

// DELETE /transactions/:id/match   (?deleteSale=true)
// Undo a match completely. For a debt match that means REVERSING the payments
// this credit created — the old handler cleared the label and left the money
// applied, so "unmatch" lied. For a created-from-transfer sale, deleteSale=true
// removes the sale too; without it, unlinking would leave an orphan sale that
// re-introduces the double count.
router.delete("/:id/match", requirePermission("canViewBalance"), async (req, res) => {
  const deleteSale = req.query.deleteSale === "true";
  const deleteExpense = req.query.deleteExpense === "true";
  // The receipts of an expense this undo deletes. Kept out of `out`, which is
  // sent to the client: their storage keys never leave the server.
  let deletedReceipts = null;
  try {
    const tx0 = await prisma.transaction.findUnique({ where: { id: req.params.id } });
    if (!tx0) return res.status(404).json({ error: "Transaction not found" });
    if (!(await ownsBusiness(req, tx0.businessId)))
      return res.status(403).json({ error: "Forbidden" });
    if (tx0.matchedBillId) return res.status(409).json({ error: BILL_LINKED, code: "BILL_LINKED" });
    if (!tx0.matchedSaleId && !tx0.matchedCustomerId && !tx0.matchedExpenseId && !tx0.matchedInvoiceId)
      return res.json({ matched: false }); // idempotent no-op
    // Taking invoice payments or debt repayments back out of the books is the
    // owner's call, as on the invoice itself (OWNER_ONLY there too).
    if (req.user.accountType === "staff" && (tx0.matchedInvoiceId || tx0.matchedCustomerId))
      return res.status(403).json({ error: "Only the business owner can do this.", code: "OWNER_ONLY" });

    const result = await prisma.withBusinessLock(tx0.businessId, () =>
      prisma.$transaction(async (px) => {
        const tx = await px.transaction.findUnique({ where: { id: tx0.id } });
        if (tx.matchedBillId) throw matchError(409, "BILL_LINKED", BILL_LINKED);
        // The lock date, before anything is undone.
        await assertUnlockedIn(px, tx.businessId, await unmatchDays(px, tx));
        const out = { saleDeleted: false, expenseDeleted: false, customer: null };

        // Expense mirror of the sale branch below: unlink keeps the Expense as
        // its own record (it goes back to counting, and so does the bank debit
        // — the user asked to separate them); deleteExpense removes it, the
        // undo for create-expense.
        if (tx.matchedExpenseId) {
          const expense = await px.expense.findUnique({
            where: { id: tx.matchedExpenseId },
            include: { items: { select: { accountId: true } } },
          });
          // An expense filed in the owner's stake (drawings), whole or on a
          // line, only the owner could record. Unlinking it or deleting it is
          // the owner's too, as changing a bank row filed there is.
          if (expense && req.user.accountType === "staff" && (await expenseInOwnersStake(px, expense))) {
            throw matchError(403, "OWNER_ONLY", OWNERS_STAKE_REFUSAL);
          }
          // Receipts are the owner's to add and remove (routes/expenses.js),
          // and deleting the expense removes them for good: staff may undo an
          // expense recorded from a transfer only while it has none.
          if (expense && deleteExpense && req.user.accountType === "staff" &&
              Array.isArray(expense.attachments) && expense.attachments.length) {
            throw matchError(403, "OWNER_ONLY", "This expense has receipts. Only the business owner can delete it.");
          }
          if (expense && deleteExpense) {
            await px.expense.delete({ where: { id: expense.id } });
            out.expenseDeleted = true;
            deletedReceipts = expense.attachments;
          } else if (expense) {
            await px.expense.update({ where: { id: expense.id }, data: { matchedTransactionId: null } });
          }
        }

        if (tx.matchedSaleId) {
          const sale = await px.sales.findUnique({ where: { id: tx.matchedSaleId } });
          if (sale && deleteSale) {
            // The goods its lines took go back into stock first (release 3),
            // as DELETE /sales/:id puts them back.
            const restored = await removeSaleStock(px, sale.businessId, sale.id);
            out.inventory = restored.map((i) => publicItem(i, canSeeCosts(req)));
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
    // A deleted expense's receipts leave Cloudinary once the undo has
    // committed, as on DELETE /expenses/:id: best effort, never failing it.
    if (result.expenseDeleted) destroyReceipts(deletedReceipts, `expense deleted by unmatching ${tx0.id}`);
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
        if (tx.matchedSaleId || tx.matchedCustomerId || tx.matchedInvoiceId || tx.purpose || tx.accountId)
          throw matchError(409, "ALREADY_MATCHED", "This transfer is already matched.");
        const payment = await px.debtPayment.findUnique({
          where: { id: debtPaymentId },
          include: { debt: { include: { customer: { select: { id: true, userId: true, businessId: true } } } } },
        });
        const customer = payment && payment.debt && payment.debt.customer;
        // This business's own customer only (every customer belongs to one
        // business, release 2), as on match-debt.
        if (!payment || !customer || customer.userId !== getTargetUserId(req) || customer.businessId !== tx.businessId) {
          throw matchError(404, "PAYMENT_NOT_FOUND", "Repayment not found.");
        }
        if (payment.transactionId) throw matchError(409, "ALREADY_LINKED", "This repayment is already linked.");
        if (Number(payment.amount) > Number(tx.amount) + 0.005) {
          throw matchError(400, "EXCEEDS_TRANSFER", "The repayment is more than the transfer.");
        }
        // The lock date: the repayment moves from its own day to the transfer's.
        await assertUnlockedIn(px, tx.businessId, payment.date, tx.date);
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
// (a supplier refund lowers expenses); { purpose: null } takes it back. The
// owner's money is the owner's to say: staff may not mark a credit so, nor
// change one the owner filed in the owner's stake (403 OWNER_ONLY), as on
// POST /:id/categorize.
router.post("/:id/classify", requirePermission("canViewBalance"), async (req, res) => {
  try {
    const raw = (req.body || {}).purpose;
    const purpose = raw === null || raw === "" ? null : String(raw);
    if (purpose !== null && !CREDIT_OUTCOMES.includes(purpose)) {
      return res.status(400).json({ error: "Unknown choice.", code: "BAD_PURPOSE" });
    }
    const isStaff = req.user.accountType === "staff";
    // The ledger books the owner's money on Owner's Equity, an account staff
    // may not use (POST /:id/categorize refuses it to them too).
    if (isStaff && OWNER_ONLY_PURPOSES.includes(purpose)) {
      return res.status(403).json({ error: "Only the business owner can mark this as the owner's money.", code: "OWNER_ONLY" });
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
        // Staff never change what the owner filed in the owner's stake, and
        // clearing it is a change too.
        if (isStaff && (await inOwnersStake(px, tx))) throw matchError(403, "OWNER_ONLY", OWNERS_STAKE_REFUSAL);
        // The lock date: what the transfer counts as changes on its day.
        await assertUnlockedIn(px, tx.businessId, tx.date);
        return px.transaction.update({ where: { id: tx.id }, data: { purpose, accountId: null } });
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

// POST /transactions/:id/categorize  { accountId | null }
// Chart of accounts (2026-10-11): explain a bank row with any account, as in
// Zoho. What it then counts as follows the account (utils/books.js): an
// income account is income, an expense account spending (or, on money in, a
// refund that lowers it), a balance-sheet account nothing (the owner's money,
// a loan, equipment, drawings, a move between accounts). The purpose is kept
// in step so an older app copy, which reads only the purpose, counts the row
// the same way. null clears it. Staff may not use an equity account
// (utils/ledgerData.js assertAccountUsable), nor move or clear a row the owner
// filed in the owner's stake (403 OWNER_ONLY).
const PURPOSE_FOR_ACCOUNT = {
  [chart.SYS.CASH]: "cash_deposit",
  [chart.SYS.OTHER_BANK]: "own_transfer",
  [chart.SYS.OWNER_EQUITY]: "owner_money",
  [chart.SYS.LOANS]: "loan",
};
router.post("/:id/categorize", requirePermission("canViewBalance"), async (req, res) => {
  try {
    const tx0 = await prisma.transaction.findUnique({ where: { id: req.params.id } });
    if (!tx0) return res.status(404).json({ error: "Transaction not found" });
    if (!(await ownsBusiness(req, tx0.businessId))) return res.status(403).json({ error: "Forbidden" });
    const isIn = tx0.type === "income";
    const isStaff = req.user.accountType === "staff";
    const raw = (req.body || {}).accountId;
    const account = await assertAccountUsable(tx0.businessId, raw, isIn ? "credit" : "debit", { isStaff });
    const cls = account ? chart.classOf(account.type) : null;
    let purpose = null;
    if (cls === "expense" && isIn) purpose = "supplier_refund";
    else if (cls && !chart.isProfitClass(cls)) purpose = (isIn && PURPOSE_FOR_ACCOUNT[account.systemKey]) || "account";
    if (cls === "income" && !isIn) {
      return res.status(400).json({ error: "Money that went out can't be income.", code: "ACCOUNT_NOT_ALLOWED" });
    }

    const updated = await prisma.withBusinessLock(tx0.businessId, () =>
      prisma.$transaction(async (px) => {
        const tx = await px.transaction.findUnique({ where: { id: tx0.id } });
        if (tx.purpose && !CREDIT_OUTCOMES.includes(tx.purpose) && tx.purpose !== "account") {
          throw matchError(409, "PURPOSE_LOCKED", "This transfer can't be changed here.");
        }
        // A payment towards a bill (release 2) is a match too.
        if (tx.matchedSaleId || tx.matchedCustomerId || tx.matchedInvoiceId || tx.matchedExpenseId || tx.matchedBillId) {
          throw matchError(409, "ALREADY_MATCHED", "This transfer is already matched. Unmatch it first.");
        }
        // Whatever staff send, null included, a row the owner filed in the
        // owner's stake stays as the owner left it.
        if (isStaff && (await inOwnersStake(px, tx))) throw matchError(403, "OWNER_ONLY", OWNERS_STAKE_REFUSAL);
        // The lock date: what the transfer counts as changes on its day.
        await assertUnlockedIn(px, tx.businessId, tx.date);
        return px.transaction.update({ where: { id: tx.id }, data: { accountId: account ? account.id : null, purpose } });
      }),
    );
    audit({
      req, action: "TX_CATEGORIZE", resourceType: "transaction", resourceId: tx0.id,
      metadata: { from: tx0.accountId || null, to: account ? account.id : null, purpose },
    }).catch(() => {});
    res.json({ transaction: updated });
  } catch (err) {
    respondMatchFailure(res, err, "Failed to update the transfer");
  }
});

module.exports = router;
