const router = require("express").Router();
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");
const auth = require("../middleware/auth");
const prisma = require("../utils/db");
const { validateExpense, validateIdParam } = require("../middleware/validate");
const { accountError, assertAccountUsable, invalidateLedger } = require("../utils/ledgerData");
const { validateDataUri, DOC_TYPES } = require("../utils/uploadGuard");
const { EXPENSE_INCLUDE, publicAttachment, publicAttachments, publicExpense } = require("../utils/expenseView");
const { cleanReference, expenseCustomerId, resolveItems, itemData } = require("../utils/expenseFields");
const {
  MAX_RECEIPTS,
  RECEIPT_MAX_BYTES,
  saveReceipt,
  destroyReceipts,
  receiptLink,
} = require("../utils/receiptStorage");

router.use(auth);

// Every expense this router returns goes through publicExpense
// (utils/expenseView.js): its lines in order ([] for a whole expense) and its
// receipts without the keys that find them on Cloudinary.

// Helper to resolve the correct business owner ID
const getTargetUserId = (req) =>
  req.user.accountType === "staff" ? req.user.employerId : req.user.id;

// The category an expense is saved with: its account's, when the account
// stands for a category (so older app versions, which read the category, see
// it in the right place), else the one sent.
function categoryFor(account, category) {
  if (account && account.categorySlug) return account.categorySlug;
  return typeof category === "string" && category.trim() ? category.trim().toLowerCase() : "other";
}

function routeError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

// A refusal as the app reads it: { error, code }, plus the field it is about
// (for a refused account, the field that sent it) and, for a line of an
// itemized expense, which line (utils/expenseFields.js, and accountError in
// utils/ledgerData.js).
function sendRouteError(res, err, fallback) {
  if (err && err.status) {
    return res.status(err.status).json({
      error: err.message,
      code: err.code,
      ...(err.field ? { field: err.field } : {}),
      ...(err.extra || {}),
    });
  }
  console.error(err);
  return res.status(500).json({ error: fallback });
}

// The expense this request may change, by the guards PATCH has always had:
// the owner who recorded it may, staff never may. Responds and returns null
// when the request may not. The receipt routes use the same guards, so who
// may add, open or remove a receipt is exactly who may edit the expense.
async function editableExpense(req, res) {
  if (req.user.accountType === "staff") {
    res.status(403).json({ error: "Staff cannot edit expenses" });
    return null;
  }
  const expense = await prisma.expense.findUnique({ where: { id: req.params.id } });
  if (!expense) {
    res.status(404).json({ error: "Expense not found" });
    return null;
  }
  if (expense.userId !== req.user.id) {
    res.status(403).json({ error: "Forbidden" });
    return null;
  }
  return expense;
}

const receiptsOf = (row) => (Array.isArray(row && row.attachments) ? row.attachments : []);

// GET /expenses?from=&to=&limit=&businessId=
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
    const expenses = await prisma.expense.findMany({
      where,
      include: EXPENSE_INCLUDE,
      orderBy: since ? { updatedAt: "asc" } : { date: "desc" },
      take: since ? undefined : Math.min(1000, Math.max(1, Number(limit) || 200)),
    });
    res.json(expenses.map(publicExpense));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch expenses" });
  }
});

// POST /expenses
// A whole expense: { amount, accountId?, category?, ... }. An itemized one
// (Zoho's "Itemize"): { items: [{ accountId, amount, description? }], ... },
// 1 to 50 lines, each on its own account; its amount is the lines' sum, and
// any amount, accountId or category sent is ignored. Either kind may carry
// `reference` (the supplier's receipt or invoice number) and `customerId`
// (the customer the cost was for: it shows on their page, no total changes).
router.post("/", validateExpense, async (req, res) => {
  if (req.user.accountType === "staff") {
    return res.status(403).json({ error: "Staff cannot create expenses" });
  }

  const {
    category = "other",
    amount,
    notes,
    date,
    businessId,
    paymentMethod = "cash",
    accountId,
    paidThroughAccountId,
    clientRef,
    items,
    reference,
    customerId,
  } = req.body;
  // A business is named by its id, which is text. Anything else (an object,
  // which Prisma would read as a filter, so a lookup by it could reach another
  // owner's records) is refused before any lookup.
  if (businessId !== undefined && businessId !== null && typeof businessId !== "string") {
    return res.status(400).json({ error: "businessId must be a string", code: "BAD_BUSINESS", field: "businessId" });
  }
  const sendsLines = Array.isArray(items) && items.length > 0;
  if (!sendsLines && !amount) return res.status(400).json({ error: "amount required" });
  const ref = clientRef ? String(clientRef).slice(0, 80) : null;

  // The business once it is known to be this owner's: its id as the database
  // holds it, which every lookup below uses instead of the value sent. null
  // for an expense with no business.
  let bizId = null;
  try {
    const ownerId = getTargetUserId(req);
    if (businessId) {
      const owned = await prisma.business.findFirst({
        where: { id: businessId, userId: ownerId },
      });
      if (!owned) return res.status(403).json({ error: "Forbidden" });
      bizId = owned.id;
    }

    // A create the app retried (the first one timed out after it was saved)
    // gets the first one back, lines and all, instead of a second expense.
    if (bizId && ref) {
      const prior = await prisma.expense.findFirst({ where: { businessId: bizId, clientRef: ref }, include: EXPENSE_INCLUDE });
      if (prior) return res.status(200).json(publicExpense(prior));
    }

    const supplierRef = cleanReference(reference);
    // Checked and saved under the business lock, which an account merge or
    // delete also takes (routes/ledger.js), so every account checked here is
    // still there when the expense is saved with it.
    const expense = await prisma.withBusinessLock(bizId, async () => {
      // Every line checked before anything is saved (utils/expenseFields.js).
      const lines = await resolveItems(bizId, items);
      // The chart of accounts: what the money was spent on (an expense
      // account, or one on the balance sheet such as equipment or rent paid
      // ahead) and where it was paid from. Both optional. An itemized expense
      // names no account of its own: its lines do. A refusal names the field.
      const account = !lines && bizId ? await assertAccountUsable(bizId, accountId, "expense", { field: "accountId" }) : null;
      const paidFrom = bizId
        ? await assertAccountUsable(bizId, paidThroughAccountId, "money", { field: "paidThroughAccountId" })
        : null;
      const customer = await expenseCustomerId(ownerId, bizId, customerId);

      return prisma.expense.create({
        data: {
          userId: ownerId,
          businessId: bizId,
          // Itemized: the lines' sum and the first line's category, so older
          // app versions (which read only these two) show it whole.
          category: lines ? lines.category : categoryFor(account, category),
          amount: lines ? lines.total : Number(amount),
          paymentMethod,
          notes: notes || null,
          date: date ? new Date(date) : new Date(),
          accountId: account ? account.id : null,
          paidThroughAccountId: paidFrom ? paidFrom.id : null,
          clientRef: ref,
          reference: supplierRef || null,
          customerId: customer || null,
          // The lines are written with the expense, in the same transaction.
          ...(lines && { items: { create: lines.lines.map(itemData) } }),
        },
        include: EXPENSE_INCLUDE,
      });
    });
    if (bizId) invalidateLedger(bizId);
    res.status(201).json(publicExpense(expense));
  } catch (err) {
    if (err?.code === "P2002" && ref && bizId) {
      const prior = await prisma.expense.findFirst({ where: { businessId: bizId, clientRef: ref }, include: EXPENSE_INCLUDE });
      if (prior) return res.status(200).json(publicExpense(prior));
    }
    sendRouteError(res, err, "Failed to create expense");
  }
});

// ── An edit and the accounts the expense names already ───────────────────────
// An account the expense names now (its own, or one of its lines') is taken
// as it is on an edit, even one the owner has since made inactive, so the
// expense still saves and keeps counting where it did, as an invoice's lines
// do (routes/invoices.js checkLineAccounts). Without this, a split expense
// with a line on such an account could not have any of its lines edited:
// the app sends every line, the untouched one included. Only an account new
// to the expense must be one an expense may use now.

// The accounts an expense names now: its own and its lines'.
async function accountsNamedBy(expenseId) {
  const row = await prisma.expense.findUnique({
    where: { id: expenseId },
    select: { accountId: true, items: { select: { accountId: true } } },
  });
  if (!row) return new Set();
  return new Set([row.accountId, ...row.items.map((it) => it.accountId)].filter(Boolean));
}

// The account an edit names, for the expense or for one of its lines. One in
// `kept` (accountsNamedBy) needs only to be still in this business's chart,
// where its category comes from; any other is checked as on create. `at` is
// where the edit sent it ({ field: "accountId" }, or { field: "items", line }
// for a line), which a refusal names.
async function editAccount(bizId, accountId, kept, at) {
  if (!kept.has(String(accountId))) return assertAccountUsable(bizId, accountId, "expense", at);
  const acc = await prisma.ledgerAccount.findFirst({ where: { id: String(accountId), businessId: bizId } });
  if (!acc) throw accountError("That account isn't in this business's chart.", "ACCOUNT_NOT_FOUND", 400, at);
  return acc;
}

// The lines an edit sends, read and checked by resolveItems exactly as on
// create (utils/expenseFields.js). resolveItems refuses an inactive account,
// so when the account it refused is one in `kept`, the lines are read again
// here with every account taken through editAccount.
async function resolveEditItems(bizId, items, kept) {
  try {
    return await resolveItems(bizId, items);
  } catch (e) {
    // resolveItems reads every line before it looks up any account, so an
    // account it refused means every line is well formed. Any other refusal
    // stands.
    const refused = e && e.code === "ACCOUNT_NOT_ALLOWED" && e.extra ? items[e.extra.line] : null;
    if (!refused || !kept.has(String(refused.accountId))) throw e;
  }
  // Each line as resolveItems reads it: the account as text, the amount to
  // the kobo, the description trimmed (null when empty), the line's place in
  // the order sent.
  const lines = items.map((raw, i) => ({
    accountId: String(raw.accountId),
    amount: Math.round(Number(raw.amount) * 100) / 100,
    description: typeof raw.description === "string" ? raw.description.trim() || null : null,
    position: i,
    category: "other",
  }));
  const found = new Map();
  for (const line of lines) {
    if (!found.has(line.accountId)) {
      found.set(line.accountId, await editAccount(bizId, line.accountId, kept, { field: "items", line: line.position }));
    }
    line.category = found.get(line.accountId).categorySlug || "other";
  }
  const total = lines.reduce((s, l) => s + Math.round(l.amount * 100), 0) / 100;
  return { lines, total, category: lines[0].category };
}

// PATCH /expenses/:id
// Only the fields sent change. `items` replaces every line, and the amount
// follows them (any amount or accountId sent beside them is ignored). An empty
// list (or null) turns an itemized expense back into a whole one, after which
// amount and accountId apply as on any whole expense. While an expense has
// lines and none are sent, its amount, account and category follow those
// lines: a different amount, an account or a different category is refused
// (409 EXPENSE_ITEMIZED). An account the expense names already is kept even
// when it is inactive (see accountsNamedBy); a new one must be usable now.
// `reference` and `customerId` as on create; null clears either. An expense
// recorded from a bank transfer never comes out above that transfer (400
// AMOUNT_EXCEEDS_TRANSFER) and was paid from the KashBook account, so no
// other paid-through account is taken (409 LOCKED_BY_TRANSFER).
router.patch("/:id", validateIdParam, async (req, res) => {
  try {
    const expense0 = await editableExpense(req, res);
    if (!expense0) return;
    const {
      amount,
      notes,
      category,
      paymentMethod,
      date,
      accountId,
      paidThroughAccountId,
      items,
      reference,
      customerId,
    } = req.body;
    const bizId = expense0.businessId;
    const supplierRef = cleanReference(reference);

    // Under the business lock, which an account merge or delete also takes
    // (routes/ledger.js), so the accounts checked here are still there when
    // the expense is saved. An expense recorded from a bank transfer keeps
    // that transfer's matchedAmount in step with its total, as a sale does.
    // The lines and the expense change in one transaction.
    const updated = await prisma.withBusinessLock(bizId || expense0.userId, async () => {
      // The accounts the expense names now, read under the lock (a merge
      // moves them under it too), when the edit names any.
      const kept =
        bizId && (items !== undefined || accountId !== undefined) ? await accountsNamedBy(expense0.id) : new Set();
      const lines = await resolveEditItems(bizId, items, kept);
      // Beside new lines, the amount and the account sent are ignored.
      const amountSent = !lines && amount !== undefined;
      if (amountSent && !(Number(amount) > 0)) throw routeError(400, "BAD_AMOUNT", "Enter an amount.");
      const account =
        !lines && accountId !== undefined && bizId ? await editAccount(bizId, accountId, kept, { field: "accountId" }) : undefined;
      const paidFrom =
        paidThroughAccountId !== undefined && bizId
          ? await assertAccountUsable(bizId, paidThroughAccountId, "money", { field: "paidThroughAccountId" })
          : undefined;
      const customer = await expenseCustomerId(expense0.userId, bizId, customerId);

      return prisma.$transaction(async (px) => {
        const fresh = await px.expense.findUnique({
          where: { id: expense0.id },
          include: { _count: { select: { items: true } } },
        });
        if (!fresh) throw routeError(404, "EXPENSE_NOT_FOUND", "Expense not found");
        // The bank transfer this expense records, while it still points here.
        const linked = fresh.matchedTransactionId
          ? await px.transaction.findUnique({ where: { id: fresh.matchedTransactionId } })
          : null;
        const transfer = linked && linked.matchedExpenseId === fresh.id ? linked : null;
        // That money left through the KashBook account (Bank Matching in the
        // ledger); another account named as paying it would leave Bank
        // Matching holding the transfer for good.
        if (transfer && paidFrom) {
          throw routeError(409, "LOCKED_BY_TRANSFER", "This expense was paid by a bank transfer from your KashBook account.");
        }
        const itemized = fresh._count.items > 0;
        const keepsLines = itemized && lines === undefined;
        if (keepsLines) {
          // An older app version shows an itemized expense whole and may send
          // its amount or category back unchanged; a change would part the
          // expense from the lines the books count.
          const otherTotal = amountSent && Math.abs(Number(amount) - Number(fresh.amount)) >= 0.005;
          const otherCategory = category !== undefined && categoryFor(null, category) !== fresh.category;
          if (otherTotal || account || otherCategory) {
            throw routeError(409, "EXPENSE_ITEMIZED", "This expense is split into lines. Change its lines instead.");
          }
        }
        // What the total becomes: the new lines' sum, or the amount sent for a
        // whole expense (undefined: it stays). From a transfer it may come out
        // below the transfer, never above, as on create-expense
        // (routes/transactions.js resolveCappedAmount): the excess would be
        // spending no money backed. A total sent back unchanged passes, so an
        // older expense already above its transfer can still be edited.
        const total = lines ? lines.total : !keepsLines && amountSent ? Number(amount) : undefined;
        if (
          transfer && total !== undefined &&
          Math.abs(total - Number(fresh.amount)) >= 0.005 && total > Number(transfer.amount) + 0.005
        ) {
          throw Object.assign(
            routeError(400, "AMOUNT_EXCEEDS_TRANSFER", `The amount can't be more than the transfer (${Number(transfer.amount)}).`),
            { field: lines ? "items" : "amount" },
          );
        }

        const data = {
          ...(notes !== undefined && { notes }),
          ...(paidFrom !== undefined && { paidThroughAccountId: paidFrom ? paidFrom.id : null }),
          ...(paymentMethod !== undefined && { paymentMethod }),
          ...(date !== undefined && { date: new Date(date) }),
          ...(supplierRef !== undefined && { reference: supplierRef }),
          ...(customer !== undefined && { customerId: customer }),
        };
        if (lines) {
          // New lines replace the old ones and the expense follows them. The
          // row's updatedAt moves too, so an incremental sync picks it up.
          await px.expenseItem.deleteMany({ where: { expenseId: fresh.id } });
          await px.expenseItem.createMany({ data: lines.lines.map((l) => ({ expenseId: fresh.id, ...itemData(l) })) });
          Object.assign(data, { amount: lines.total, accountId: null, category: lines.category, updatedAt: new Date() });
        } else if (!keepsLines) {
          // A whole expense, or one whose lines were just cleared: it keeps
          // the total its lines had unless an amount is sent.
          if (itemized) {
            await px.expenseItem.deleteMany({ where: { expenseId: fresh.id } });
            data.updatedAt = new Date();
          }
          if (amountSent) data.amount = Number(amount);
          if (account !== undefined) data.accountId = account ? account.id : null;
          if (account) data.category = categoryFor(account, category !== undefined ? category : fresh.category);
          else if (category !== undefined) {
            data.category = categoryFor(null, category);
            // An older app version knows only categories: another one sent
            // with no account means the expense is now that category's, so it
            // stops naming its old account (the books then follow the category).
            if (account === undefined && fresh.accountId && data.category !== fresh.category) data.accountId = null;
          }
        }
        const row = await px.expense.update({ where: { id: fresh.id }, data, include: EXPENSE_INCLUDE });

        if (transfer && data.amount !== undefined) {
          await px.transaction.update({
            where: { id: transfer.id },
            data: { matchedAmount: Math.min(Number(row.amount), Number(transfer.amount) || 0) },
          });
        }
        return row;
      });
    });
    if (bizId) invalidateLedger(bizId);
    res.json(publicExpense(updated));
  } catch (err) {
    sendRouteError(res, err, "Failed to update expense");
  }
});

// DELETE /expenses/:id
router.delete("/:id", validateIdParam, async (req, res) => {
  if (req.user.accountType === "staff") {
    return res.status(403).json({ error: "Staff cannot delete expenses" });
  }

  try {
    const expense = await prisma.expense.findUnique({
      where: { id: req.params.id },
    });
    if (!expense) return res.status(404).json({ error: "Expense not found" });
    if (expense.userId !== req.user.id)
      return res.status(403).json({ error: "Forbidden" });

    // An expense recorded from a bank transfer frees that transfer, which then
    // counts on its own again. Left matched, the money left the account and
    // counted nowhere (the transfer pointed at an expense that no longer existed).
    // Its lines go with it (the foreign key cascades).
    const removed = await prisma.withBusinessLock(expense.businessId || expense.userId, () =>
      prisma.$transaction(async (px) => {
        const fresh = await px.expense.findUnique({ where: { id: expense.id } });
        if (!fresh) return null;
        if (fresh.matchedTransactionId) {
          const tx = await px.transaction.findUnique({ where: { id: fresh.matchedTransactionId } });
          if (tx && tx.matchedExpenseId === fresh.id) {
            await px.transaction.update({ where: { id: tx.id }, data: { matchedExpenseId: null, matchedAmount: null } });
          }
        }
        await px.expense.delete({ where: { id: fresh.id } });
        return fresh;
      }),
    );
    if (expense.businessId) invalidateLedger(expense.businessId);
    // Its receipts leave Cloudinary once the row is gone: best effort, never
    // failing the delete (utils/receiptStorage.js).
    if (removed) destroyReceipts(removed.attachments, `expense ${removed.id} deleted`);
    res.json({ message: "Deleted" });
  } catch (err) {
    sendRouteError(res, err, "Failed to delete expense");
  }
});

// ── Receipts (Zoho's Attachments) ────────────────────────────────────────────
// Up to 5 per expense, images or PDF, 8 MB each, checked by the upload guard
// and kept privately on Cloudinary as the KYB certificate is
// (utils/receiptStorage.js). The app sees { id, name, mime, size, uploadedAt }
// and opens one through a link that lasts ten minutes. Who may: whoever may
// edit the expense (editableExpense).
//
// Each owner also keeps at most RECEIPT_BUDGET_FILES receipts and
// RECEIPT_BUDGET_BYTES over all their expenses together, and adds at most 30
// in ten minutes. The cap per expense alone let one free account fill the
// Cloudinary storage every upload in KashBook shares, by adding expenses. A
// receipt photo from the app is a few hundred KB, so the budget holds years
// of a busy shop's receipts.

const RECEIPT_BUDGET_FILES = 10000;
const RECEIPT_BUDGET_BYTES = 2 * 1024 * 1024 * 1024;

// Uploads per signed-in person, from whatever IP, on top of the limit per IP
// that every /expenses request has (server.js apiLimiter).
const receiptLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user.id,
  message: { error: "Too many receipts at once. Wait a few minutes and try again.", code: "TOO_MANY_UPLOADS" },
});

// How many receipts an owner keeps over all their expenses, and their bytes
// (the size each was saved with). `db` is a transaction's client under the
// lock below.
async function receiptUsage(ownerId, db = prisma) {
  const [row] = await db.$queryRaw`
    SELECT COUNT(*)::int AS files,
           COALESCE(SUM(CASE WHEN jsonb_typeof(f.item -> 'size') = 'number'
                             THEN (f.item ->> 'size')::float8 ELSE 0 END), 0)::float8 AS bytes
    FROM "Expense" e
    CROSS JOIN LATERAL jsonb_array_elements(e."attachments") AS f(item)
    WHERE e."userId" = ${ownerId} AND jsonb_typeof(e."attachments") = 'array'`;
  return { files: Number(row && row.files) || 0, bytes: Number(row && row.bytes) || 0 };
}

// True when one more receipt of `bytes` would take the owner past the budget.
const overBudget = (usage, bytes) =>
  usage.files >= RECEIPT_BUDGET_FILES || usage.bytes + bytes > RECEIPT_BUDGET_BYTES;

// A file name as the app shows it: no control characters, 120 characters at
// most, "Receipt" when none was given.
function receiptName(v) {
  const s = typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 120).trim() : "";
  return s || "Receipt";
}

const tooManyReceipts = () =>
  routeError(409, "TOO_MANY_ATTACHMENTS", `An expense can keep at most ${MAX_RECEIPTS} receipts. Remove one first.`);

const receiptsFull = () =>
  routeError(
    409,
    "RECEIPT_STORAGE_FULL",
    "Your receipts have reached the most KashBook keeps for one account " +
      `(${RECEIPT_BUDGET_FILES.toLocaleString("en-US")} receipts or ${RECEIPT_BUDGET_BYTES / (1024 * 1024 * 1024)} GB in all). ` +
      "Remove some older receipts first.",
  );

// POST /expenses/:id/attachments  { fileBase64: "data:<type>;base64,...", name? }
// → 201 { attachment, attachments }
router.post("/:id/attachments", receiptLimiter, validateIdParam, async (req, res) => {
  try {
    const expense0 = await editableExpense(req, res);
    if (!expense0) return;
    // Refused before the upload when the expense is already full; checked
    // again under the lock below, where two uploads at once are decided.
    if (receiptsOf(expense0).length >= MAX_RECEIPTS) throw tooManyReceipts();

    const { fileBase64, name } = req.body || {};
    let meta;
    try {
      meta = validateDataUri(fileBase64, { allow: DOC_TYPES, maxBytes: RECEIPT_MAX_BYTES });
    } catch (e) {
      return res.status(e.httpStatus || 400).json({ error: e.message, code: e.code });
    }
    // The same for the owner's receipts over all their expenses: refused
    // before the upload, and checked again under the lock.
    if (overBudget(await receiptUsage(expense0.userId), meta.bytes)) throw receiptsFull();

    let stored;
    try {
      stored = await saveReceipt(fileBase64, meta);
    } catch (e) {
      console.error("[expenses] receipt upload failed:", (e && e.message) || e);
      return res.status(502).json({ error: "The receipt couldn't be saved. Try again.", code: "UPLOAD_FAILED" });
    }
    const receipt = {
      id: crypto.randomUUID(),
      name: receiptName(name),
      mime: meta.mime,
      size: meta.bytes,
      uploadedAt: new Date().toISOString(),
      publicId: stored.publicId,
      resourceType: stored.resourceType,
    };

    let row;
    try {
      // Two keys on one connection (utils/db.js): the owner's receipts first,
      // which every upload of theirs takes whatever the business, so their
      // budget is decided one upload at a time; then the expense's own, which
      // its other writes take.
      const lockKeys = [`receipts:${expense0.userId}`, expense0.businessId || expense0.userId];
      row = await prisma.withBusinessLock(lockKeys, () =>
        prisma.$transaction(async (px) => {
          const fresh = await px.expense.findUnique({ where: { id: expense0.id }, select: { id: true, attachments: true } });
          if (!fresh) throw routeError(404, "EXPENSE_NOT_FOUND", "Expense not found");
          const list = receiptsOf(fresh);
          if (list.length >= MAX_RECEIPTS) throw tooManyReceipts();
          if (overBudget(await receiptUsage(expense0.userId, px), receipt.size)) throw receiptsFull();
          return px.expense.update({
            where: { id: fresh.id },
            data: { attachments: [...list, receipt] },
            select: { attachments: true },
          });
        }),
      );
    } catch (e) {
      // Not kept (the expense or the owner's receipts filled up, or the
      // expense was deleted meanwhile, refused under the lock): the file it
      // would have pointed at goes too. Any other failure may have come after
      // the row was saved (the lock's own COMMIT failing once the save had
      // committed), so the file goes only when the expense does not list it;
      // when that can't be read, it stays (a stray file costs storage, a
      // missing one loses a receipt).
      const refused =
        e && (e.code === "TOO_MANY_ATTACHMENTS" || e.code === "RECEIPT_STORAGE_FULL" || e.code === "EXPENSE_NOT_FOUND");
      const kept = !refused && (await prisma.expense
        .findUnique({ where: { id: expense0.id }, select: { attachments: true } })
        .then((row) => receiptsOf(row).some((a) => a && a.id === receipt.id))
        .catch(() => true));
      if (!kept) destroyReceipts([receipt], "not kept");
      throw e;
    }
    res.status(201).json({ attachment: publicAttachment(receipt), attachments: publicAttachments(row.attachments) });
  } catch (err) {
    sendRouteError(res, err, "Failed to add the receipt");
  }
});

// GET /expenses/:id/attachments/:attachmentId/url → { url, expiresAt }
// A signed link to the private file that works for ten minutes.
router.get("/:id/attachments/:attachmentId/url", validateIdParam, async (req, res) => {
  try {
    const expense = await editableExpense(req, res);
    if (!expense) return;
    const receipt = receiptsOf(expense).find((a) => a && a.id === req.params.attachmentId);
    if (!receipt || !receipt.publicId) {
      return res.status(404).json({ error: "Receipt not found", code: "ATTACHMENT_NOT_FOUND" });
    }
    res.set("Cache-Control", "private, no-store");
    res.json(receiptLink(receipt));
  } catch (err) {
    sendRouteError(res, err, "Failed to open the receipt");
  }
});

// DELETE /expenses/:id/attachments/:attachmentId → { attachments }
// The receipt comes off the expense, then leaves Cloudinary (best effort).
router.delete("/:id/attachments/:attachmentId", validateIdParam, async (req, res) => {
  try {
    const expense0 = await editableExpense(req, res);
    if (!expense0) return;
    const { removed, row } = await prisma.withBusinessLock(expense0.businessId || expense0.userId, () =>
      prisma.$transaction(async (px) => {
        const fresh = await px.expense.findUnique({ where: { id: expense0.id }, select: { id: true, attachments: true } });
        if (!fresh) throw routeError(404, "EXPENSE_NOT_FOUND", "Expense not found");
        const list = receiptsOf(fresh);
        const gone = list.find((a) => a && a.id === req.params.attachmentId);
        if (!gone) throw routeError(404, "ATTACHMENT_NOT_FOUND", "Receipt not found");
        const kept = await px.expense.update({
          where: { id: fresh.id },
          data: { attachments: list.filter((a) => a !== gone) },
          select: { attachments: true },
        });
        return { removed: gone, row: kept };
      }),
    );
    destroyReceipts([removed], `removed from expense ${expense0.id}`);
    res.json({ attachments: publicAttachments(row.attachments) });
  } catch (err) {
    sendRouteError(res, err, "Failed to remove the receipt");
  }
});

module.exports = router;
