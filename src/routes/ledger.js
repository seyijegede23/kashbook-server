// The chart of accounts and the books it reads (2026-10-11, like Zoho Books).
//
//   GET    /ledger/accounts                 every member (pickers); no amounts
//   GET    /ledger/balances                 balances at a date
//   GET    /ledger/accounts/:id/transactions  one account's entries
//   GET    /ledger/summary                  the Accounting home's figures
//   GET    /ledger/reports/profit-and-loss  by account ("when paid" by default)
//   GET    /ledger/reports/balance-sheet    ("when sold" by default)
//   GET    /ledger/reports/trial-balance
//   POST   /ledger/accounts                 owner: a new account
//   PATCH  /ledger/accounts/:id             owner: rename, code, description, parent, type, inactive
//   DELETE /ledger/accounts/:id             owner: only when nothing uses it
//   POST   /ledger/accounts/:id/merge       owner: move everything to another account, then delete
//   GET    /ledger/opening-balances
//   PUT    /ledger/opening-balances         owner
//
// Reading amounts needs the Reports permission; anything that reveals the
// bank balance (balances, statements, balance sheet, trial balance) also
// needs bank access, as the sync bundle already withholds bank rows. The
// ledger itself is derived from the records (utils/ledger.js): nothing here
// posts to it. Nothing posts Retained Earnings either: the profit of past
// financial years is worked out where it is read (balances, its statement),
// as the balance sheet works it out.
const router = require("express").Router();
const auth = require("../middleware/auth");
const { requirePermission, ownerOnly } = require("../middleware/requirePermission");
const prisma = require("../utils/db");
const { ownerIdOf } = require("../utils/scope");
const { audit } = require("../utils/audit");
const books = require("../utils/books");
const { receivablesFor } = require("../utils/booksData");
const chart = require("../utils/chart");
const ledger = require("../utils/ledger");
const { toKobo, twoDecimals } = require("../utils/money");
const {
  ACCOUNT_FIELDS, publicAccount, accountError, ensureChart, accountsFor, assertAccountUsable, invalidateLedger, loadLedger,
} = require("../utils/ledgerData");

router.use(auth);

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const today = () => books.dayKey(new Date()); // Lagos

function sendError(res, err, what) {
  if (err && err.status) return res.status(err.status).json({ error: err.message, code: err.code, ...(err.extra || {}) });
  console.error(`[ledger] ${what}:`, err);
  return res.status(500).json({ error: "Something went wrong with the accounts. Please try again." });
}

async function loadBusiness(req, businessId) {
  if (!businessId) throw accountError("Choose a business.", "BUSINESS_REQUIRED");
  const biz = await prisma.business.findFirst({ where: { id: String(businessId), userId: ownerIdOf(req) } });
  if (!biz) throw accountError("Business not found.", "BUSINESS_NOT_FOUND", 404);
  return biz;
}

// Staff need bank access for anything that shows the bank balance.
function needsBankAccess(req, res, next) {
  if (req.user.accountType !== "staff" || req.user.permissions?.canViewBalance === true) return next();
  return res.status(403).json({
    error: "You don't have access to the bank account or balance. Ask the business owner to turn it on for you.",
    code: "PERMISSION_DENIED",
    permission: "canViewBalance",
  });
}

const basisOf = (v, fallback) => (v === "paid" || v === "sold" ? v : fallback);
const naira = (k) => k / 100;

// ── Reading ─────────────────────────────────────────────────────────────────

router.get("/accounts", async (req, res) => {
  try {
    const biz = await loadBusiness(req, req.query.businessId);
    // New categories since last time (an older app's custom one, a free-text
    // one) get their account here.
    await ensureChart(biz.id);
    const accounts = await accountsFor(biz.id);
    res.json({ accounts: accounts.map(publicAccount) });
  } catch (err) {
    sendError(res, err, "list");
  }
});

// Retained Earnings holds the profit of every financial year before the one
// a balance is read on. The ledger closes no year (its profit and loss must
// stay equal to computeBooks for any period), so the figure is worked out
// where it is read, as ledger.balanceSheet works it out: in /balances, and in
// the account's statement as one line per year.
const isPLAccount = (a) => chart.isProfitClass(chart.classOf(a.type));

// What the profit-and-loss accounts hold from before the financial year.
// `sums` runs to the day asked about and `year` from the year's first day to
// it, so the difference is everything dated before the year; for any real
// date that is the balance sheet's retained earnings to the kobo. It is cut
// exactly where this year's figures beside it start, so the groups always add
// up. Kobo, debit positive (a profit is below zero), as the ledger's lines are.
function profitBeforeYear(accounts, sums, year) {
  let k = 0;
  for (const a of accounts) if (isPLAccount(a)) k += (sums.get(a.id) || 0) - (year.get(a.id) || 0);
  return k;
}

// The day a profit or loss dated `day` joins Retained Earnings: the first day
// of the next financial year, that is the first year start after `day`, with
// the start month read as ledger.yearStart reads it. Days are compared as
// text, as sumByAccount compares them, so even a day that is not a date (none
// should be) joins where /balances counts it; null when no year start up to
// 9999 comes after it.
function joinsRetained(day, startMonth) {
  const mm = String(Math.min(12, Math.max(1, Number(startMonth) || 1))).padStart(2, "0");
  const startOf = (y) => `${String(y).padStart(4, "0")}-${mm}-01`;
  // A day that starts with its year: that year's start, or the next one's.
  if (/^\d{4}/.test(day)) {
    const y = Number(day.slice(0, 4));
    if (startOf(y) > day) return startOf(y);
    return y < 9999 ? startOf(y + 1) : null;
  }
  // Anything else: the first of the years 0 to 9999 whose start comes after
  // it, by halving.
  let lo = 0;
  let hi = 10000;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (startOf(mid) > day) hi = mid;
    else lo = mid + 1;
  }
  return lo < 10000 ? startOf(lo) : null;
}

// "2025" for the financial year that ends the day before `next` (the first day
// of the year after it), or "2025/26" when years start in another month.
function yearName(next) {
  const y = Number(next.slice(0, 4)) - 1;
  if (!(y >= 1)) return "";
  return next.slice(5, 7) === "01" ? String(y) : `${y}/${String((y + 1) % 100).padStart(2, "0")}`;
}

// Retained Earnings' own statement: besides anything moved onto it, one line
// for each financial year with a profit or loss, on the day that profit joins
// (kind "year_profit", no record behind it, the year's name as its memo). So
// the statement's opening, lines and closing agree with /balances for any
// period. The lines are made up for the statement and never join the ledger;
// they come first on their day.
function yearProfitEntries(L, retainedId) {
  const pl = new Set(L.accounts.filter(isPLAccount).map((a) => a.id));
  const byDay = new Map(); // the day a year's profit joins → its kobo
  for (const e of L.entries) {
    let k = 0;
    for (const l of e.lines) if (pl.has(l.accountId)) k += l.k;
    const day = k ? joinsRetained(e.day, L.business.fiscalYearStartMonth) : null;
    if (day !== null) byDay.set(day, (byDay.get(day) || 0) + k);
  }
  const out = [];
  for (const [day, k] of byDay) {
    if (!k) continue;
    out.push({ id: `year_profit:${day}`, day, kind: "year_profit", memo: yearName(day), ref: null, lines: [{ accountId: retainedId, k }] });
  }
  return out;
}

router.get("/balances", requirePermission("canViewReports"), needsBankAccess, async (req, res) => {
  try {
    const biz = await loadBusiness(req, req.query.businessId);
    const asOf = DAY.test(String(req.query.asOf || "")) ? req.query.asOf : today();
    const basis = basisOf(req.query.basis, "sold");
    const L = await loadLedger(biz.id, { basis });
    const sums = ledger.sumByAccount(L.entries, { to: asOf });
    // Profit-and-loss accounts show this financial year so far; the rest their
    // balance, Retained Earnings with the profit of the years before this one.
    const fy = ledger.yearStart(asOf, L.business.fiscalYearStartMonth);
    const year = ledger.sumByAccount(L.entries, { from: fy, to: asOf });
    const before = profitBeforeYear(L.accounts, sums, year);
    const balances = L.accounts.map((a) => {
      const isPL = isPLAccount(a);
      const k = ((isPL ? year : sums).get(a.id) || 0) + (a.systemKey === chart.SYS.RETAINED ? before : 0);
      return { accountId: a.id, balance: naira(chart.debitNormal(chart.classOf(a.type)) ? k : -k), period: isPL ? "year" : "balance" };
    });
    res.json({ asOf, basis, yearStart: fy, balances });
  } catch (err) {
    sendError(res, err, "balances");
  }
});

router.get("/accounts/:id/transactions", requirePermission("canViewReports"), needsBankAccess, async (req, res) => {
  try {
    const biz = await loadBusiness(req, req.query.businessId);
    const basis = basisOf(req.query.basis, "sold");
    const L = await loadLedger(biz.id, { basis });
    const acc = L.chart.byId.get(String(req.params.id));
    if (!acc) throw accountError("Account not found.", "ACCOUNT_NOT_FOUND", 404);
    const from = DAY.test(String(req.query.from || "")) ? req.query.from : "";
    const to = DAY.test(String(req.query.to || "")) ? req.query.to : today();
    // Retained Earnings reads each finished year's profit too (above).
    const entries = acc.systemKey === chart.SYS.RETAINED ? [...yearProfitEntries(L, acc.id), ...L.entries] : L.entries;
    const st = ledger.accountTransactions(entries, acc.id, acc, { from, to });
    res.json({ account: publicAccount(acc), basis, from, to, ...st });
  } catch (err) {
    sendError(res, err, "transactions");
  }
});

// The Accounting home: cash and bank (the same in both views), what customers
// owe the business, what it owes, and profit this year ("when paid", as the
// Dashboard and Reports count it). Owed to you is counted as Reports and the
// More screen count it (books.receivables: open invoices and unpaid debts,
// never a credit note or a credit sale no debt tracks). You owe is what the
// business owes "when sold" plus the credit it owes customers back (credit
// notes not used yet, also sent on their own as youOweCustomers). It leaves
// out Unexplained Receipts (sent as `unexplained`): transfers into the bank
// nobody has explained yet, which "when paid" counts as sales.
router.get("/summary", requirePermission("canViewReports"), needsBankAccess, async (req, res) => {
  try {
    const biz = await loadBusiness(req, req.query.businessId);
    const day = today();
    const [sold, paid, owed] = await Promise.all([
      loadLedger(biz.id, { basis: "sold" }),
      loadLedger(biz.id, { basis: "paid" }),
      receivablesFor(biz.id),
    ]);
    const sums = ledger.sumByAccount(sold.entries, { to: day });
    let cash = 0;
    let youOwe = 0;
    let unexplained = 0;
    for (const a of sold.accounts) {
      const k = sums.get(a.id) || 0;
      if (a.type === "cash" || a.type === "bank" || a.type === "payment_clearing") cash += k;
      if (chart.classOf(a.type) !== "liability") continue;
      if (a.systemKey === chart.SYS.SUSPENSE) unexplained -= k;
      else youOwe -= k;
    }
    const { owedToYou = 0, youOweCustomers = 0 } = owed || {};
    const fy = ledger.yearStart(day, paid.business.fiscalYearStartMonth);
    const pl = ledger.profitAndLoss(paid.entries, paid.chart, { from: fy, to: day });
    res.json({
      asOf: day, yearStart: fy,
      cashAndBank: naira(cash), owedToYou, youOwe: naira(youOwe + toKobo(youOweCustomers)), youOweCustomers,
      unexplained: naira(unexplained), profitThisYear: pl.profit,
      openingBalanceDate: sold.business.openingBalanceDate,
    });
  } catch (err) {
    sendError(res, err, "summary");
  }
});

// Cash at Hand for the Dashboard's wallet card: the same money in both views,
// from every record (not the app's latest 2,500), with the starting cash.
router.get("/cash", needsBankAccess, async (req, res) => {
  try {
    const biz = await loadBusiness(req, req.query.businessId);
    const L = await loadLedger(biz.id, { basis: "sold" });
    const cash = chart.sysAccount(L.chart, chart.SYS.CASH);
    const k = (cash && ledger.sumByAccount(L.entries, { to: today() }).get(cash.id)) || 0;
    res.json({ cashAtHand: naira(k) });
  } catch (err) {
    sendError(res, err, "cash");
  }
});

router.get("/reports/profit-and-loss", requirePermission("canViewReports"), async (req, res) => {
  try {
    const biz = await loadBusiness(req, req.query.businessId);
    const basis = basisOf(req.query.basis, "paid");
    const from = DAY.test(String(req.query.from || "")) ? req.query.from : "";
    const to = DAY.test(String(req.query.to || "")) ? req.query.to : today();
    const L = await loadLedger(biz.id, { basis });
    const pl = ledger.profitAndLoss(L.entries, L.chart, { from, to });
    const row = (r) => ({ accountId: r.account.id, amount: r.amount });
    res.json({ basis, from, to, income: pl.income.map(row), expenses: pl.expenses.map(row), totalIncome: pl.totalIncome, totalExpenses: pl.totalExpenses, profit: pl.profit });
  } catch (err) {
    sendError(res, err, "profit and loss");
  }
});

router.get("/reports/balance-sheet", requirePermission("canViewReports"), needsBankAccess, async (req, res) => {
  try {
    const biz = await loadBusiness(req, req.query.businessId);
    const basis = basisOf(req.query.basis, "sold");
    const asOf = DAY.test(String(req.query.asOf || "")) ? req.query.asOf : today();
    const L = await loadLedger(biz.id, { basis });
    const bs = ledger.balanceSheet(L.entries, L.chart, asOf, L.business.fiscalYearStartMonth);
    const row = (r) => ({ accountId: r.account.id, amount: r.amount });
    res.json({
      basis, asOf, yearStart: bs.yearStart,
      assets: bs.assets.map(row), liabilities: bs.liabilities.map(row), equity: bs.equity.map(row),
      retainedEarnings: bs.retainedEarnings, currentYearEarnings: bs.currentYearEarnings,
      totals: bs.totals, balanced: bs.balanced,
    });
  } catch (err) {
    sendError(res, err, "balance sheet");
  }
});

router.get("/reports/trial-balance", requirePermission("canViewReports"), needsBankAccess, async (req, res) => {
  try {
    const biz = await loadBusiness(req, req.query.businessId);
    const basis = basisOf(req.query.basis, "sold");
    const asOf = DAY.test(String(req.query.asOf || "")) ? req.query.asOf : today();
    const L = await loadLedger(biz.id, { basis });
    const tb = ledger.trialBalance(L.entries, L.chart, asOf);
    res.json({
      basis, asOf, balanced: tb.balanced, debit: tb.debit, credit: tb.credit,
      rows: tb.rows.map((r) => ({ accountId: r.account.id, debit: r.debit, credit: r.credit })),
    });
  } catch (err) {
    sendError(res, err, "trial balance");
  }
});

// ── The owner's changes to the chart ───────────────────────────────────────

const owner = ownerOnly("Only the business owner can change the chart of accounts.");

function cleanName(v) {
  const name = String(v == null ? "" : v).trim().replace(/\s+/g, " ");
  if (!name) throw accountError("Give the account a name.", "NAME_REQUIRED");
  if (name.length > 100) throw accountError("Keep the name under 100 characters.", "NAME_TOO_LONG");
  return name;
}

function cleanCode(v) {
  if (v === undefined) return undefined;
  const code = String(v == null ? "" : v).trim();
  if (!code) return null;
  if (code.length > 50) throw accountError("Keep the code under 50 characters.", "CODE_TOO_LONG");
  return code;
}

function cleanDescription(v) {
  if (v === undefined) return undefined;
  const d = String(v == null ? "" : v).trim();
  if (d.length > 500) throw accountError("Keep the description under 500 characters.", "DESCRIPTION_TOO_LONG");
  return d || null;
}

async function checkUnique(businessId, { name, code }, exceptId) {
  const not = exceptId ? { id: { not: exceptId } } : {};
  if (name !== undefined && (await prisma.ledgerAccount.count({ where: { businessId, nameKey: chart.nameKey(name), ...not } }))) {
    throw accountError("Another account already has this name.", "NAME_TAKEN", 409);
  }
  if (code && (await prisma.ledgerAccount.count({ where: { businessId, codeKey: chart.nameKey(code), ...not } }))) {
    throw accountError("Another account already has this code.", "CODE_TAKEN", 409);
  }
}

async function checkParent(businessId, parentId, type, selfId) {
  if (parentId === undefined || parentId === null || parentId === "") return parentId === undefined ? undefined : null;
  const parent = await prisma.ledgerAccount.findFirst({ where: { id: String(parentId), businessId } });
  if (!parent || parent.id === selfId || parent.parentId || parent.type !== type) {
    throw accountError("A sub-account sits under one top-level account of the same type.", "BAD_PARENT");
  }
  if (selfId && (await prisma.ledgerAccount.count({ where: { parentId: selfId } }))) {
    throw accountError("This account has sub-accounts, so it can't become one.", "BAD_PARENT");
  }
  return parent.id;
}

// A category slug for an expense account, so older app versions (which send a
// category, not an account) still land expenses in it.
async function freeSlug(businessId, name) {
  const base = chart.canonicalSlug(String(name).toLowerCase().replace(/\s+/g, "-")) || "other";
  let slug = base;
  for (let i = 2; await prisma.ledgerAccount.count({ where: { businessId, categorySlug: slug } }); i++) slug = `${base}-${i}`;
  return slug;
}

// A recurring expense that names an account of another kind (a loan repaid,
// the owner's drawings) still reads its category: its auto-debits that carry
// no account of their own are spending, on the category's account
// (chart.bankRowAccount).
const SPENDING_TYPES = Object.keys(chart.ACCOUNT_TYPES).filter((t) => chart.classOf(t) === "expense");
const NOT_SPENDING = { account: { type: { notIn: SPENDING_TYPES } } };

// The records that reach an account by its category (they name no account):
// whole expenses and recurring expenses (`records`), and lines of itemized
// expenses (`lines`). An itemized expense reaches accounts only through its
// lines (its own category is the first line's, kept for older app versions),
// so it is never one of `records`' expenses: see WHOLE_EXPENSE. `rules` adds
// the recurring expenses on an account of another kind (NOT_SPENDING), as
// the chart's set-up reads them (utils/ledgerData.js ensureChart). `category`
// is the category itself or one of its older names.
function byCategoryOf(acc) {
  const slugs = acc.categorySlug
    ? [acc.categorySlug, ...Object.keys(chart.SLUG_ALIASES).filter((k) => k && chart.SLUG_ALIASES[k] === acc.categorySlug)]
    : [];
  if (!slugs.length) return null;
  const OR = slugs.map((s) => ({ category: { equals: s, mode: "insensitive" } }));
  return {
    category: { OR },
    records: { OR, accountId: null, businessId: acc.businessId },
    rules: { businessId: acc.businessId, AND: [{ OR }, { OR: [{ accountId: null }, NOT_SPENDING] }] },
    lines: { OR, accountId: null, expense: { businessId: acc.businessId } },
    // The same lines, seen from their expense (expense.items.some).
    line: { OR, accountId: null },
  };
}
const WHOLE_EXPENSE = { items: { none: {} } };

// An older app version adds a category as a custom category, and the chart's
// set-up gives each one its account (utils/ledgerData.js ensureChart). So the
// custom categories that stand for an account the owner deletes or merges
// away go with it, in the same transaction, or the next look at the chart
// makes the account again.
async function dropCustomCategories(px, acc) {
  if (!acc.categorySlug) return;
  const custom = await px.customCategory.findMany({ where: { businessId: acc.businessId }, select: { id: true, label: true, value: true } });
  const ids = custom.filter((c) => chart.canonicalSlug(c.value || c.label) === acc.categorySlug).map((c) => c.id);
  if (ids.length) await px.customCategory.deleteMany({ where: { id: { in: ids } } });
}

// What uses an account: records naming it, opening balances, sub-accounts,
// and expenses (or lines of one) and recurring expenses whose category it
// stands for.
async function usageOf(acc) {
  const id = acc.id;
  const byCategory = byCategoryOf(acc);
  const counts = await Promise.all([
    prisma.expense.count({ where: { OR: [{ accountId: id }, { paidThroughAccountId: id }] } }),
    byCategory ? prisma.expense.count({ where: { ...byCategory.records, ...WHOLE_EXPENSE } }) : 0,
    prisma.expenseItem.count({ where: { accountId: id } }),
    byCategory ? prisma.expenseItem.count({ where: byCategory.lines }) : 0,
    prisma.sales.count({ where: { OR: [{ accountId: id }, { depositAccountId: id }] } }),
    prisma.transaction.count({ where: { accountId: id } }),
    prisma.invoiceItem.count({ where: { accountId: id } }),
    prisma.invoicePayment.count({ where: { depositAccountId: id } }),
    prisma.debtPayment.count({ where: { depositAccountId: id } }),
    prisma.recurringExpense.count({ where: { OR: [{ accountId: id }, { paidThroughAccountId: id }] } }),
    byCategory ? prisma.recurringExpense.count({ where: byCategory.rules }) : 0,
    prisma.openingBalance.count({ where: { accountId: id } }),
    prisma.ledgerAccount.count({ where: { parentId: id } }),
  ]);
  return counts.reduce((s, n) => s + n, 0);
}

async function loadOwnAccount(req, id) {
  const acc = await prisma.ledgerAccount.findUnique({ where: { id: String(id) } });
  if (!acc) throw accountError("Account not found.", "ACCOUNT_NOT_FOUND", 404);
  await loadBusiness(req, acc.businessId);
  return acc;
}

router.post("/accounts", owner, async (req, res) => {
  try {
    const biz = await loadBusiness(req, req.body.businessId);
    await ensureChart(biz.id);
    const type = String(req.body.type || "");
    if (!chart.ACCOUNT_TYPES[type] || chart.SYSTEM_ONLY_TYPES.includes(type)) {
      throw accountError("Choose an account type.", "BAD_TYPE");
    }
    const name = cleanName(req.body.name);
    const code = cleanCode(req.body.code);
    const description = cleanDescription(req.body.description);
    await checkUnique(biz.id, { name, code });
    const parentId = await checkParent(biz.id, req.body.parentId, type);
    const categorySlug = chart.classOf(type) === "expense" ? await freeSlug(biz.id, name) : null;
    const acc = await prisma.ledgerAccount.create({
      data: {
        businessId: biz.id, type, name, nameKey: chart.nameKey(name), code: code || null, codeKey: code ? chart.nameKey(code) : null,
        description: description || null, parentId: parentId || null, categorySlug, createdById: req.user.id,
      },
      select: ACCOUNT_FIELDS,
    });
    invalidateLedger(biz.id);
    audit({ req, action: "ACCOUNT_CREATE", resourceType: "ledgerAccount", resourceId: acc.id, metadata: { type, name } }).catch(() => {});
    res.status(201).json(publicAccount(acc));
  } catch (err) {
    if (err?.code === "P2002") return res.status(409).json({ error: "Another account already has this name or code.", code: "NAME_TAKEN" });
    sendError(res, err, "create");
  }
});

router.patch("/accounts/:id", owner, async (req, res) => {
  try {
    const acc = await loadOwnAccount(req, req.params.id);
    const b = req.body || {};
    const data = {};
    if (b.name !== undefined) {
      data.name = cleanName(b.name);
      data.nameKey = chart.nameKey(data.name);
    }
    const code = cleanCode(b.code);
    if (code !== undefined) {
      data.code = code;
      data.codeKey = code ? chart.nameKey(code) : null;
    }
    const description = cleanDescription(b.description);
    if (description !== undefined) data.description = description;
    await checkUnique(acc.businessId, { name: data.name, code: data.code }, acc.id);

    if (b.type !== undefined && b.type !== acc.type) {
      const type = String(b.type);
      if (acc.systemKey) throw accountError("A KashBook account keeps its type.", "SYSTEM_ACCOUNT");
      if (!chart.ACCOUNT_TYPES[type] || chart.SYSTEM_ONLY_TYPES.includes(type)) throw accountError("Choose an account type.", "BAD_TYPE");
      if (await usageOf(acc)) throw accountError("This account is in use, so its type can't change.", "TYPE_LOCKED", 409);
      data.type = type;
      if (chart.classOf(type) !== "expense") data.categorySlug = null;
      else if (!acc.categorySlug) data.categorySlug = await freeSlug(acc.businessId, data.name || acc.name);
    }
    const parentId = await checkParent(acc.businessId, b.parentId, data.type || acc.type, acc.id);
    if (parentId !== undefined) data.parentId = parentId;

    if (b.inactive !== undefined) {
      const off = b.inactive === true;
      if (off && acc.systemKey) throw accountError("KashBook keeps this account in use.", "SYSTEM_ACCOUNT");
      if (off && (await prisma.recurringExpense.count({ where: { active: true, OR: [{ accountId: acc.id }, { paidThroughAccountId: acc.id }] } }))) {
        throw accountError("A recurring expense uses this account. Change it there first.", "IN_USE_RECURRING", 409);
      }
      // Every save of starting balances checks each account it names, and an
      // inactive one is refused there, so an account that rested while holding
      // a starting balance would block every later save of them.
      if (off && (await prisma.openingBalance.count({ where: { accountId: acc.id } }))) {
        throw accountError("This account has a starting balance. Clear it in Starting balances first.", "IN_USE_OPENING", 409);
      }
      data.inactiveAt = off ? acc.inactiveAt || new Date() : null;
    }
    const updated = await prisma.ledgerAccount.update({ where: { id: acc.id }, data, select: ACCOUNT_FIELDS });
    invalidateLedger(acc.businessId);
    audit({ req, action: "ACCOUNT_UPDATE", resourceType: "ledgerAccount", resourceId: acc.id, metadata: { fields: Object.keys(data) } }).catch(() => {});
    res.json(publicAccount(updated));
  } catch (err) {
    if (err?.code === "P2002") return res.status(409).json({ error: "Another account already has this name or code.", code: "NAME_TAKEN" });
    sendError(res, err, "update");
  }
});

router.delete("/accounts/:id", owner, async (req, res) => {
  try {
    const acc = await loadOwnAccount(req, req.params.id);
    if (acc.systemKey) throw accountError("KashBook keeps this account; it can't be deleted.", "SYSTEM_ACCOUNT");
    // Under the business lock every expense and invoice write takes while it
    // checks its accounts (routes/expenses.js, routes/invoices.js,
    // create-expense): an expense saved on this account at the same moment is
    // either a use (and the delete is refused) or finds the account gone,
    // never cut loose by the delete (its account set to null) or refused by a
    // foreign key.
    await prisma.withBusinessLock(acc.businessId, async () => {
      const used = await usageOf(acc);
      if (used) {
        throw Object.assign(accountError("This account is in use. Move its records to another account, or mark it inactive.", "ACCOUNT_IN_USE", 409), {
          extra: { used },
        });
      }
      await prisma.$transaction(async (px) => {
        const gone = await px.ledgerAccount.deleteMany({ where: { id: acc.id } });
        if (!gone.count) throw accountError("Account not found.", "ACCOUNT_NOT_FOUND", 404);
        await dropCustomCategories(px, acc);
      });
    });
    invalidateLedger(acc.businessId);
    audit({ req, action: "ACCOUNT_DELETE", resourceType: "ledgerAccount", resourceId: acc.id, metadata: { name: acc.name } }).catch(() => {});
    res.status(204).end();
  } catch (err) {
    sendError(res, err, "delete");
  }
});

// Move everything that uses one account to another of the same class (two
// custom categories that mean the same thing), then delete the first.
router.post("/accounts/:id/merge", owner, async (req, res) => {
  try {
    const from0 = await loadOwnAccount(req, req.params.id);
    const into0 = await loadOwnAccount(req, req.body.intoId);
    if (from0.id === into0.id || from0.businessId !== into0.businessId) throw accountError("Choose another account.", "BAD_TARGET");
    // Under the business lock every expense and invoice write takes while it
    // checks its accounts (routes/expenses.js, routes/invoices.js,
    // create-expense): an expense saved on `from` at the same moment lands
    // before the move (and moves with the rest) or finds the account gone,
    // never in between, where the delete would cut its line loose. Both
    // accounts are read again under the lock.
    const { from, into } = await prisma.withBusinessLock(from0.businessId, async () => {
      const [from, into] = await Promise.all([
        prisma.ledgerAccount.findUnique({ where: { id: from0.id } }),
        prisma.ledgerAccount.findUnique({ where: { id: into0.id } }),
      ]);
      if (!from || !into) throw accountError("Account not found.", "ACCOUNT_NOT_FOUND", 404);
      if (from.systemKey) throw accountError("KashBook keeps this account; it can't be merged away.", "SYSTEM_ACCOUNT");
      if (chart.classOf(from.type) !== chart.classOf(into.type)) {
        throw accountError("Accounts can only be merged into one of the same kind.", "BAD_TARGET");
      }
      if (into.inactiveAt) throw accountError("Choose an active account.", "BAD_TARGET");
      const bothOpen = await prisma.openingBalance.count({ where: { accountId: { in: [from.id, into.id] } } });
      if (bothOpen > 1) throw accountError("Both accounts have a starting balance. Remove one first.", "BOTH_OPENING", 409);
      return { from, into: await mergeInto(from, into) };
    });
    invalidateLedger(from.businessId);
    audit({ req, action: "ACCOUNT_MERGE", resourceType: "ledgerAccount", resourceId: into.id, metadata: { from: from.id, fromName: from.name } }).catch(() => {});
    res.json({ merged: from.id, into: publicAccount(into) });
  } catch (err) {
    sendError(res, err, "merge");
  }
});

// The merge itself, in one transaction: every record on `from` moves to
// `into`, then `from` goes, and its category with it, so nothing brings it
// back (the chart's set-up makes an account for every category the books
// still read). When `into` stands for no category it takes `from`'s, and an
// older app version's expense in that category lands in `into` from now on.
// When it stands for one of its own, what moved, and a recurring expense that
// reads `from`'s category, carry `into`'s instead. The older app's custom
// categories for `from` go too (dropCustomCategories). Returns `into` as the
// merge leaves it.
async function mergeInto(from, into) {
  const byCategory = byCategoryOf(from);
  return prisma.$transaction(async (px) => {
    // A phone's incremental sync finds a changed expense, invoice or customer
    // by that row's own updatedAt (routes/sync.js). Moving a line or a payment
    // changes only the line or the payment, so their expenses, invoices and
    // customers are touched first: every phone then gets them with the new
    // account, not a line on an account its chart no longer has.
    const touch = { updatedAt: new Date() };
    await px.expense.updateMany({ where: { items: { some: { accountId: from.id } } }, data: touch });
    if (byCategory) {
      await px.expense.updateMany({ where: { businessId: from.businessId, items: { some: byCategory.line } }, data: touch });
    }
    await px.invoice.updateMany({
      where: { OR: [{ items: { some: { accountId: from.id } } }, { payments: { some: { depositAccountId: from.id } } }] },
      data: touch,
    });
    await px.customer.updateMany({ where: { debts: { some: { payments: { some: { depositAccountId: from.id } } } } }, data: touch });

    const move = (model, field) => px[model].updateMany({ where: { [field]: from.id }, data: { [field]: into.id } });
    await move("expense", "accountId");
    await move("expense", "paidThroughAccountId");
    await move("expenseItem", "accountId");
    await move("sales", "accountId");
    await move("sales", "depositAccountId");
    await move("transaction", "accountId");
    await move("invoiceItem", "accountId");
    await move("invoicePayment", "depositAccountId");
    await move("debtPayment", "depositAccountId");
    await move("recurringExpense", "accountId");
    await move("recurringExpense", "paidThroughAccountId");
    await move("openingBalance", "accountId");
    if (byCategory) {
      // Records that reached it by their category now name the account: an
      // itemized expense never does (its lines do), so it keeps none.
      await px.expense.updateMany({ where: { ...byCategory.records, ...WHOLE_EXPENSE }, data: { accountId: into.id } });
      await px.recurringExpense.updateMany({ where: byCategory.records, data: { accountId: into.id } });
      await px.expenseItem.updateMany({ where: byCategory.lines, data: { accountId: into.id } });
      if (into.categorySlug) {
        // They carry `into`'s category from now on: everything that names it
        // now with `from`'s (or an older name of it), an itemized expense
        // whose first line did (it names no account), and a recurring expense
        // on an account of another kind, whose auto-debits read it.
        const data = { category: into.categorySlug };
        const onInto = [{ accountId: into.id }, { accountId: null }];
        await px.expense.updateMany({ where: { businessId: from.businessId, AND: [byCategory.category, { OR: onInto }] }, data });
        await px.expenseItem.updateMany({ where: { expense: { businessId: from.businessId }, AND: [byCategory.category, { OR: onInto }] }, data });
        await px.recurringExpense.updateMany({
          where: { businessId: from.businessId, AND: [byCategory.category, { OR: [...onInto, NOT_SPENDING] }] },
          data,
        });
      }
    }
    await px.ledgerAccount.updateMany({ where: { parentId: from.id }, data: { parentId: null } });
    await px.ledgerAccount.delete({ where: { id: from.id } });
    await dropCustomCategories(px, from);
    // Only once `from` is gone: a category stands for one account at a time.
    if (from.categorySlug && !into.categorySlug) {
      return px.ledgerAccount.update({ where: { id: into.id }, data: { categorySlug: from.categorySlug } });
    }
    return into;
  });
}

// ── Opening balances ────────────────────────────────────────────────────────

async function openingView(bizId) {
  const [biz, lines] = await Promise.all([
    prisma.business.findUnique({ where: { id: bizId }, select: { openingBalanceDate: true } }),
    prisma.openingBalance.findMany({ where: { businessId: bizId }, select: { accountId: true, debit: true, credit: true } }),
  ]);
  // The difference the records leave to Opening Balance Adjustments ("when
  // sold"). The opening entry posts one line there for each account entered,
  // so the difference is all of those lines, not the first.
  let adjustment = 0;
  if (biz.openingBalanceDate && lines.length) {
    const L = await loadLedger(bizId, { basis: "sold" });
    const opening = L.entries.find((e) => e.id === "opening");
    const oba = chart.sysAccount(L.chart, chart.SYS.OPENING);
    const k = opening && oba ? opening.lines.reduce((s, l) => (l.accountId === oba.id ? s + l.k : s), 0) : 0;
    adjustment = k ? -k / 100 : 0;
  }
  return { date: biz.openingBalanceDate, lines, adjustment };
}

router.get("/opening-balances", requirePermission("canViewReports"), needsBankAccess, async (req, res) => {
  try {
    const biz = await loadBusiness(req, req.query.businessId);
    res.json(await openingView(biz.id));
  } catch (err) {
    sendError(res, err, "opening balances");
  }
});

router.put("/opening-balances", owner, async (req, res) => {
  try {
    const biz = await loadBusiness(req, req.body.businessId);
    await ensureChart(biz.id);
    const date = String(req.body.date || "");
    if (!DAY.test(date) || date > today()) throw accountError("Choose the day your books start (today or earlier).", "BAD_DATE");
    const lines = Array.isArray(req.body.lines) ? req.body.lines : [];
    const seen = new Set();
    const rows = [];
    for (const l of lines) {
      const sentDebit = Number(l.debit) || 0;
      const sentCredit = Number(l.credit) || 0;
      // Naira and kobo, read as money.twoDecimals reads them (2500.55 is two
      // decimals, whatever 2500.55 * 100 comes to in floating point), and
      // kept to the kobo.
      if (
        sentDebit < 0 || sentCredit < 0 || (sentDebit > 0 && sentCredit > 0) ||
        !twoDecimals(sentDebit) || !twoDecimals(sentCredit)
      ) {
        throw accountError("Enter each starting balance once, in naira and kobo.", "BAD_AMOUNT");
      }
      const debit = toKobo(sentDebit) / 100;
      const credit = toKobo(sentCredit) / 100;
      if (!debit && !credit) continue;
      const acc = await assertAccountUsable(biz.id, l.accountId, "opening");
      if (seen.has(acc.id)) throw accountError("Each account once.", "DUPLICATE_ACCOUNT");
      seen.add(acc.id);
      rows.push({ businessId: biz.id, accountId: acc.id, debit, credit, updatedById: req.user.id });
    }
    await prisma.$transaction([
      prisma.openingBalance.deleteMany({ where: { businessId: biz.id } }),
      ...(rows.length ? [prisma.openingBalance.createMany({ data: rows })] : []),
      prisma.business.update({ where: { id: biz.id }, data: { openingBalanceDate: rows.length ? date : null } }),
    ]);
    invalidateLedger(biz.id);
    audit({ req, action: "OPENING_BALANCES_SET", resourceType: "business", resourceId: biz.id, metadata: { date, accounts: rows.length } }).catch(() => {});
    res.json(await openingView(biz.id));
  } catch (err) {
    sendError(res, err, "set opening balances");
  }
});

module.exports = router;
