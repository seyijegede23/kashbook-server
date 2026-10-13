// The chart of accounts' data (2026-10-11): setting a business's chart up,
// checking an account a record names, and loading the ledger (utils/ledger.js)
// that is derived from the business's records.
const prisma = require("./db");
const chart = require("./chart");
const ledger = require("./ledger");
const { loadBooksInput } = require("./booksData");

const ACCOUNT_FIELDS = {
  id: true, businessId: true, type: true, name: true, code: true, description: true, systemKey: true,
  categorySlug: true, aliasSlugs: true, seed: true, parentId: true, inactiveAt: true, createdAt: true, updatedAt: true,
};

// An account as the app receives it (sync bundle, /ledger routes). aliasSlugs:
// the categories merged into it, which the app resolves to it as the server
// does (chart.indexChart).
function publicAccount(a) {
  return {
    id: a.id, type: a.type, class: chart.classOf(a.type), name: a.name, code: a.code, description: a.description,
    systemKey: a.systemKey, system: !!a.systemKey, categorySlug: a.categorySlug,
    aliasSlugs: Array.isArray(a.aliasSlugs) ? a.aliasSlugs : [], seed: a.seed, parentId: a.parentId,
    inactive: !!a.inactiveAt, controlled: !!(a.systemKey && chart.CONTROLLED.includes(a.systemKey)),
    hiddenAtZero: !!(a.systemKey && chart.HIDDEN_AT_ZERO.includes(a.systemKey)),
  };
}

// A coded refusal. For an account a request named, `at` says where in the
// request it was, so the app can point at it: `field`, the body field that
// named it (accountId, depositAccountId, paidThroughAccountId, or items for a
// line of an itemized record), and for a line its 0-based place, sent back
// as `line` (in `extra`, as utils/expenseFields.js sends a line's refusals).
function accountError(message, code, status = 400, { field, line } = {}) {
  const err = Object.assign(new Error(message), { status, code });
  if (field) err.field = field;
  if (Number.isInteger(line)) err.extra = { line };
  return err;
}

// The default chart is seeded once, when a business has no accounts. After
// that only what the books need is added: a system account a later release
// introduced, and an account for each expense category the books still read
// (below), so a default the merchant renamed or deleted never comes back.
// A category needs no account of its own when an account stands for it, as
// its own or as one merged into it (aliasSlugs), or when the owner retired it
// (Business.retiredCategorySlugs: its account was deleted, or made another
// kind), however often an older app version sends it.
// Idempotent and race-safe (a lock per business, unique keys underneath).
async function ensureChart(businessId) {
  return prisma.withBusinessLock(`chart:${businessId}`, async () => {
    const existing = await prisma.ledgerAccount.findMany({
      where: { businessId },
      select: { id: true, type: true, systemKey: true, categorySlug: true, aliasSlugs: true, nameKey: true },
    });
    // Read after the accounts: a delete, or a change to another kind of
    // account, takes the category off its account and retires it in one
    // transaction (routes/ledger.js), so the category is in one read or the
    // other.
    const biz = await prisma.business.findUnique({ where: { id: businessId }, select: { retiredCategorySlugs: true } });
    const haveSys = new Set(existing.map((a) => a.systemKey).filter(Boolean));
    const haveSlug = new Set([
      ...existing.map((a) => a.categorySlug),
      ...existing.flatMap((a) => a.aliasSlugs || []),
      ...((biz && biz.retiredCategorySlugs) || []),
    ].filter(Boolean));
    const haveName = new Set(existing.map((a) => a.nameKey));
    const rows = [];
    // A name not yet used in this chart ("Rent", else "Rent 2", ...).
    const freeName = (name) => {
      let n = name;
      for (let i = 2; haveName.has(chart.nameKey(n)); i++) n = `${name} ${i}`;
      haveName.add(chart.nameKey(n));
      return n;
    };
    const add = ({ type, name, sys, cat, seed }) => {
      const finalName = freeName(name);
      rows.push({
        businessId, type, name: finalName, nameKey: chart.nameKey(finalName),
        systemKey: sys || null, categorySlug: cat || null, seed: seed || null,
      });
      if (sys) haveSys.add(sys);
      if (cat) haveSlug.add(cat);
    };

    const firstTime = existing.length === 0;
    for (const a of chart.DEFAULT_CHART) {
      const missingSystem = !!a.sys && !haveSys.has(a.sys);
      if (!firstTime && !missingSystem) continue;
      if (a.sys && !missingSystem) continue;
      add({ type: a.type, name: a.name, sys: a.sys, cat: a.cat && !haveSlug.has(a.cat) ? a.cat : null, seed: a.seed });
    }

    // The expense categories the books still read: an older app's custom
    // categories (how one it adds gets its account); the category of a whole
    // expense, or of a line of an itemized expense, that names no account (an
    // itemized expense's own category is only its first line's, kept for
    // older app versions); and a recurring expense's, unless its account is
    // an expense, as its auto-debits that carry no account of their own read
    // it (chart.bankRowAccount). A record that names an account keeps its
    // category only for older app versions, so an account the merchant
    // merged or deleted does not come back for it.
    const spending = new Set(existing.filter((a) => chart.classOf(a.type) === "expense").map((a) => a.id));
    const [custom, whole, lines, rules] = await Promise.all([
      prisma.customCategory.findMany({ where: { businessId }, select: { label: true, value: true } }),
      prisma.expense.findMany({
        where: { businessId, accountId: null, items: { none: {} } },
        distinct: ["category"],
        select: { category: true },
      }),
      prisma.expenseItem.findMany({
        where: { accountId: null, expense: { businessId } },
        distinct: ["category"],
        select: { category: true },
      }),
      prisma.recurringExpense.findMany({ where: { businessId }, select: { category: true, accountId: true } }),
    ]);
    for (const c of custom) {
      const slug = chart.canonicalSlug(c.value || c.label);
      if (!slug || haveSlug.has(slug)) continue;
      add({ type: "expense", name: String(c.label || "").trim() || chart.nameFromSlug(slug), cat: slug });
    }
    for (const e of [...whole, ...lines, ...rules.filter((r) => !spending.has(r.accountId))]) {
      const slug = chart.canonicalSlug(e.category);
      if (!slug || haveSlug.has(slug)) continue;
      add({ type: "expense", name: chart.nameFromSlug(slug), cat: slug });
    }

    if (rows.length) await prisma.ledgerAccount.createMany({ data: rows, skipDuplicates: true });
    return rows.length;
  });
}

// The business's accounts, setting the chart up first if it has none.
async function accountsFor(businessId) {
  const count = await prisma.ledgerAccount.count({ where: { businessId } });
  if (!count) await ensureChart(businessId);
  return prisma.ledgerAccount.findMany({
    where: { businessId },
    select: ACCOUNT_FIELDS,
    orderBy: [{ createdAt: "asc" }, { name: "asc" }],
  });
}

// An account a record is about to name: it must be this business's, active,
// and one the context allows (chart.pickerAllows: an expense on an income
// account, or a bank row on the KashBook Account, makes no sense). Equity
// accounts (the owner's money and drawings) are the owner's to use. Returns
// the account, or null when none was given; throws 400/403 otherwise. A
// caller that says where the account was sent (`field`, and `line` for a line)
// gets a refusal that names it (accountError), so an app that sent two
// accounts knows which one to leave out.
async function assertAccountUsable(businessId, accountId, context, { isStaff = false, field, line } = {}, db = prisma) {
  if (accountId === undefined || accountId === null || accountId === "") return null;
  const at = { field, line };
  const acc = await db.ledgerAccount.findFirst({ where: { id: String(accountId), businessId } });
  if (!acc) throw accountError("That account isn't in this business's chart.", "ACCOUNT_NOT_FOUND", 400, at);
  if (!chart.pickerAllows(context, acc)) {
    throw accountError("That account can't be used here.", "ACCOUNT_NOT_ALLOWED", 400, at);
  }
  if (isStaff && chart.classOf(acc.type) === "equity") {
    throw accountError("Only the owner can use this account.", "OWNER_ONLY", 403, at);
  }
  return acc;
}

// ── The derived ledger, with a short cache ───────────────────────────────────

// Per business and view: rebuilt at most once a minute, and at once after a
// write in this business (invalidateLedger). Kept small: one entry per pair.
const CACHE_TTL_MS = 60 * 1000;
const cache = new Map();

// Counts the clearings (invalidateLedger, invalidateOwner), whether or not
// they found anything cached. A build that began before a write and ends
// after the write's clearing read the records from before it: its caller
// still gets it, but it is kept only when nothing was cleared while it was
// built, so it never stands in for the write for a minute. One count for
// every business: a clear elsewhere costs one extra build, never a stale
// answer.
let epoch = 0;

function invalidateLedger(businessId) {
  epoch++;
  for (const key of cache.keys()) if (key.startsWith(`${businessId}:`)) cache.delete(key);
}

// Every cached ledger of one owner's businesses: after any write by them or
// their staff (server.js clears it when a write request succeeds). Writes that
// come from the bank (webhooks, the reconcile poller) show within a minute.
function invalidateOwner(ownerId) {
  if (!ownerId) return;
  epoch++;
  for (const [key, hit] of cache) if (hit.ownerId === ownerId) cache.delete(key);
}

// Everything the reports need: the chart (indexed), the entries, the business.
async function loadLedger(businessId, { basis = "sold" } = {}) {
  const view = basis === "paid" ? "paid" : "sold";
  const key = `${businessId}:${view}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  // Noted before the first read (see epoch).
  const startEpoch = epoch;
  const accounts = await accountsFor(businessId);
  const [loaded, biz, openings, recurring] = await Promise.all([
    loadBooksInput(businessId, {}),
    prisma.business.findUnique({
      where: { id: businessId },
      select: { id: true, userId: true, name: true, baseCurrency: true, openingBalanceDate: true, fiscalYearStartMonth: true },
    }),
    prisma.openingBalance.findMany({ where: { businessId }, select: { accountId: true, debit: true, credit: true } }),
    prisma.recurringExpense.findMany({ where: { businessId }, select: { id: true, category: true, accountId: true } }),
  ]);
  if (!loaded || !biz) return null;
  const C = chart.indexChart(accounts);
  const { entries } = ledger.buildLedger(loaded.input, {
    chart: C,
    basis: view,
    vat: loaded.vat,
    baseCurrency: loaded.baseCurrency,
    recurring: new Map(recurring.map((r) => [r.id, r])),
    openingDate: biz.openingBalanceDate,
    openings,
  });
  const value = { business: biz, accounts, chart: C, entries, basis: view };
  if (epoch === startEpoch) cache.set(key, { at: Date.now(), ownerId: biz.userId, value });
  return value;
}

module.exports = {
  ACCOUNT_FIELDS,
  publicAccount,
  accountError,
  ensureChart,
  accountsFor,
  assertAccountUsable,
  invalidateLedger,
  invalidateOwner,
  loadLedger,
};
