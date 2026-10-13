// Release 2 of the chart of accounts (2026-10-13): the data the new records
// need. Run it at deploy after the migration
// 20261013100000_bills_journals_lock (on the primary, and on the standby once
// it is migrated), and straight after the release 2 server is live. Until
// then the release 1 server still adds payables and expenses on credit, and
// pays a payable only by lowering what it owes, which no bill payment
// records. If it ran before the server push, run it again after the push:
// that run makes bills of what the old server added and puts right the bills
// it paid (step 2). The server's cached books catch up within a minute.
// Idempotent: a run finds nothing to change unless something changed since
// the last one.
//
//   1. Customers with no business get one, as every customer now belongs to
//      one business: the business of their debts' sales, else of their linked
//      transfers (the bank rows their debts' repayments came from, or that
//      were matched to them or name them), else of their other records (sales,
//      invoices and expenses that name them), else the owner's first business.
//      Within one of those steps, the business most of them are in.
//   2. Payables from before bills (BusinessDebt rows made by nobody known:
//      the bill routes and this script always say who made a bill) become
//      bills: the account by their type (supplier → Cost of Goods Sold, rent
//      → Rent, salary → Salaries and Employee Wages, utility → Electricity
//      and Utilities, loan → Loans, anything else → the account of its
//      category if there is one, else Other Expenses), dated the day they
//      were entered, and estimated. One the owner already gave an account
//      through the bill routes keeps it, and its date. What was paid on one
//      before bills becomes ONE payment, estimated and kept outside the books
//      (it lowers what is owed and counts nowhere: nobody knows when it was
//      really paid), dated when the row last changed; payments the bill
//      routes recorded on it stay as they are, and count. A row with no
//      business goes to the owner's first business. A bill an earlier run
//      made of one is put right when what it owes no longer matches its
//      payments, as after the release 1 server paid it by lowering what it
//      owes: its payment kept outside the books becomes what it now says was
//      paid before bills, dated when the row last changed. Until then the
//      bill routes move no money on it (routes/bills.js assertConverted).
//   3. Expenses saved on credit become unpaid bills, dated on the expense's
//      day, on the account the ledger booked them to (an itemized expense, one
//      bill per line), and the expense goes. Only those the ledger holds as
//      owed (in Accounts Payable): one recorded from a bank transfer, or
//      naming the account it was paid from, was booked as paid and stays.
//      One that cannot become bills as it is stays too, and is listed: with
//      receipts (a bill keeps none), in another currency, or on an account
//      that is not spending (a bill on one would mean something else).
//
// Also listed, never changed: recurring expenses on credit (each now makes an
// unpaid bill when due, or is paused when it cannot: utils/recurringExpenseRunner.js),
// and rows in the old Payable table (retired, left as they are).
//
// "The owner's first business" is the earliest one they made that is not
// closed, else the earliest. Each record is changed in a transaction of its
// own, under its business's lock, only if it is still as it was read (else it
// is left for the next run), with an AuditLog row (actor "system", actions
// BACKFILL_R2_CUSTOMER_BUSINESS, BACKFILL_R2_BILL, BACKFILL_R2_BILL_REPAIR
// and BACKFILL_R2_EXPENSE_TO_BILLS: the expense as it was, to undo by hand).
// It prints ids and amounts, never names or phone numbers.
//
//   node scripts/backfill-r2.js --dry-run             # prints what it would change, writes nothing
//   node scripts/backfill-r2.js                       # changes it
//   node scripts/backfill-r2.js --owner <userId>      # only that owner's records (either way)
//
// Uses DATABASE_URL (swap sslmode=verify-full for sslmode=require on Render).
// Exits 1 when a record failed (the rest are still done), 2 on bad arguments.
const prisma = require("../src/utils/db");
const chart = require("../src/utils/chart");

const kobo = (n) => Math.round(Number(n) * 100);
const naira = (k) => (k / 100).toFixed(2);
// The Lagos day, as the books read a date (printed only).
const dayOf = (d) => (d instanceof Date ? require("../src/utils/books").dayKey(d) : String(d || ""));

// ── Pure rules (exported for the tests) ─────────────────────────────────────

// An expense category as an account's slug: as the app makes a custom
// category's value from its label (lower case, spaces to dashes), then the
// older names the chart folds together (chart.canonicalSlug).
function slugOf(text) {
  return chart.canonicalSlug(String(text == null ? "" : text).trim().toLowerCase().replace(/\s+/g, "-"));
}

// The account a payable's type stands for, in one business's chart
// (chart.indexChart). `by`: "type" for the five named types, "category" for a
// type that is the category of an account, "fallback" for Other Expenses.
const TYPE_ACCOUNT = {
  supplier: (C) => chart.sysAccount(C, chart.SYS.COGS),
  rent: (C) => C.byCategorySlug.get("rent") || null,
  salary: (C) => chart.sysAccount(C, chart.SYS.SALARIES),
  utility: (C) => C.byCategorySlug.get("utility") || null,
  loan: (C) => chart.sysAccount(C, chart.SYS.LOANS),
};
function billAccountFor(C, type) {
  const key = String(type == null ? "" : type).trim().toLowerCase();
  const named = Object.prototype.hasOwnProperty.call(TYPE_ACCOUNT, key) ? TYPE_ACCOUNT[key](C) : null;
  if (named) return { account: named, by: "type" };
  const byCategory = C.byCategorySlug.get(slugOf(type)) || C.byCategorySlug.get(chart.canonicalSlug(type));
  if (byCategory) return { account: byCategory, by: "category" };
  return { account: chart.sysAccount(C, chart.SYS.OTHER_EXPENSES), by: "fallback" };
}

// What a payable becomes, in kobo: the bill's amount, what is still owed on
// it, and the part already paid (its payments, outsidePart below). Only
// { reason } when it cannot be a bill. A row owing more than its amount (an
// old payment route took negative amounts) owes its amount.
function payableAmounts(row) {
  const amount = kobo(row.originalAmount);
  const remaining = kobo(row.remainingAmount);
  if (!Number.isFinite(amount) || amount <= 0) return { reason: `its amount (${row.originalAmount}) is not above zero` };
  if (!Number.isFinite(remaining) || remaining < 0) return { reason: `what it owes (${row.remainingAmount}) is not an amount` };
  const owed = Math.min(remaining, amount);
  return {
    amount, owed, paid: amount - owed, capped: remaining > amount,
    status: owed === 0 ? "paid" : owed < amount ? "partial" : "unpaid",
  };
}

// The part of what a payable says is paid (payableAmounts) that is kept
// outside the books, in kobo: `want`, what it says is paid less the payments
// the bill routes recorded on it (`inBooks`, which count as they are), and
// `now`, what earlier runs keep outside (only this script keeps a payment
// so). The old server paid only by lowering what is owed, so a bill it paid
// after a run wants more than it has. { reason } when its payments in the
// books add up to more than it says is paid.
function outsidePart(amounts, payments) {
  let inBooks = 0;
  let now = 0;
  for (const p of payments || []) {
    if (p.outsideBooks) now += kobo(p.amount);
    else inBooks += kobo(p.amount);
  }
  const want = amounts.paid - inBooks;
  if (want < 0) return { reason: `its payments (${naira(inBooks)}) are more than it says was paid (${naira(amounts.paid)})` };
  return { inBooks, now, want };
}

// A bill an earlier run made of a payable, still as that run left it: it
// owes its amount less all its payments, and never more than its amount (as
// routes/bills.js assertConverted reads it). Nothing to do, nothing printed.
function billSettled(row) {
  if (!row.estimated) return false;
  const amounts = payableAmounts(row);
  if (amounts.reason || amounts.capped) return false;
  const part = outsidePart(amounts, row.payments);
  return !part.reason && part.want === part.now;
}

// The bills an expense saved on credit becomes, one per line of an itemized
// expense, each on the account the ledger books that part to (utils/ledger.js:
// a line's own account else its category's; a whole expense's account else
// its category's; else Other Expenses): { parts }, or { reason } when it stays.
function creditExpenseParts(x, C, base) {
  if (x.matchedTransactionId) return { reason: `it was recorded from bank transfer ${x.matchedTransactionId}` };
  // The ledger takes an expense's money from the account it names before its
  // method (chart.moneyAccount): one that names where it was paid from was
  // booked as paid from there, never as owed, so it is not a bill.
  const paidFrom = chart.explicitAccount(C, x.paidThroughAccountId);
  if (paidFrom && paidFrom.systemKey !== chart.SYS.AP) {
    return { reason: `it names ${paidFrom.name} as where it was paid from, so the books took it as paid` };
  }
  const receipts = Array.isArray(x.attachments) ? x.attachments.length : 0;
  if (receipts) return { reason: `it has ${receipts} receipt(s), and a bill keeps none` };
  if (x.currency && x.currency !== base) return { reason: `it is in ${x.currency}, not ${base}` };
  const items = Array.isArray(x.items) ? [...x.items].sort((a, b) => (a.position || 0) - (b.position || 0)) : [];
  const parts = items.length
    ? items.map((it) => ({
      amount: kobo(it.amount), category: it.category, description: it.description || null,
      account: chart.explicitAccount(C, it.accountId) || chart.expenseAccount(C, { category: it.category }),
    }))
    : [{ amount: kobo(x.amount), category: x.category, description: null, account: chart.expenseAccount(C, x) }];
  for (const p of parts) {
    if (!p.account) return { reason: "no account in the chart for it" };
    if (chart.classOf(p.account.type) !== "expense") return { reason: `it is on ${p.account.name}, which is not spending` };
    if (!Number.isFinite(p.amount) || p.amount <= 0) return { reason: "an amount is not above zero" };
  }
  return { parts };
}

// The supplier's name a bill made from an expense carries: the first line of
// the expense's note, else the account it was on (the expense never said).
function vendorOf(x, account) {
  const first = String(x.notes || "").split(/\r?\n/).map((s) => s.trim()).find(Boolean);
  const name = first || (account && account.name) || chart.nameFromSlug(chart.canonicalSlug(x.category));
  return Array.from(name).slice(0, 100).join("");
}

function noteOf(x, part) {
  const note = [x.notes, part.description].map((s) => String(s || "").trim()).filter(Boolean).join(" · ");
  return note || null;
}

// The bill rows (BusinessDebt) for an expense's parts.
function billsFromExpense(x, parts, businessId) {
  const vendor = vendorOf(x, parts[0].account);
  return parts.map((p) => ({
    userId: x.userId,
    businessId,
    name: vendor,
    type: chart.canonicalSlug(p.category) || "other",
    originalAmount: p.amount / 100,
    remainingAmount: p.amount / 100,
    status: "unpaid",
    accountId: p.account.id,
    billDate: x.date,
    billNumber: x.reference || null,
    note: noteOf(x, p),
    estimated: false,
    createdById: x.userId,
  }));
}

// The expense as it was, kept in the AuditLog row that records its change.
function expenseSnapshot(x) {
  return {
    amount: x.amount, date: x.date.toISOString(), category: x.category, paymentMethod: x.paymentMethod,
    accountId: x.accountId, paidThroughAccountId: x.paidThroughAccountId, currency: x.currency, notes: x.notes,
    reference: x.reference, customerId: x.customerId, clientRef: x.clientRef, businessId: x.businessId,
    createdAt: x.createdAt.toISOString(),
    items: (x.items || []).map((it) => ({
      accountId: it.accountId, category: it.category, description: it.description, amount: it.amount, position: it.position,
    })),
  };
}

// The business a customer with none belongs to: the first step with any
// evidence decides, and within it the business most of it is in (then the
// earliest evidence, then the earliest business). `steps`: [{ by, list:
// [{ businessId, at }] }]; `owned`: the owner's businesses, earliest first.
// Evidence in a business of another owner is never taken.
function pickBusiness(steps, owned) {
  const order = new Map(owned.map((b, i) => [b.id, i]));
  for (const { by, list } of steps) {
    const tally = new Map();
    for (const ev of list) {
      if (!order.has(ev.businessId)) continue;
      const t = tally.get(ev.businessId) || { n: 0, first: Infinity };
      t.n += 1;
      t.first = Math.min(t.first, ev.at ? new Date(ev.at).getTime() : Infinity);
      tally.set(ev.businessId, t);
    }
    if (!tally.size) continue;
    const [businessId, t] = [...tally].sort((a, b) =>
      b[1].n - a[1].n || a[1].first - b[1].first || order.get(a[0]) - order.get(b[0]))[0];
    return { businessId, by, count: t.n, businesses: tally.size };
  }
  return null;
}

// The chart ensureChart would leave a business with, for a dry run, which must
// not write: the default chart when it has none, else what it has plus any
// system account it lacks (ids "(new) <name>").
function plannedChart(accounts, retired = []) {
  const list = accounts.slice();
  const firstTime = list.length === 0;
  const haveSys = new Set(list.map((a) => a.systemKey).filter(Boolean));
  const haveSlug = new Set([...list.flatMap((a) => [a.categorySlug, ...(a.aliasSlugs || [])]), ...(retired || [])].filter(Boolean));
  for (const a of chart.DEFAULT_CHART) {
    const missingSystem = !!a.sys && !haveSys.has(a.sys);
    if (!firstTime && !missingSystem) continue;
    list.push({
      id: `(new) ${a.name}`, type: a.type, name: a.name, systemKey: a.sys || null,
      categorySlug: a.cat && !haveSlug.has(a.cat) ? a.cat : null, aliasSlugs: [], seed: a.seed,
    });
    if (a.cat) haveSlug.add(a.cat);
  }
  return list;
}

// ── The run ─────────────────────────────────────────────────────────────────

const ACCOUNT_SELECT = { id: true, type: true, name: true, systemKey: true, categorySlug: true, aliasSlugs: true, seed: true, inactiveAt: true };
const BUSINESS_SELECT = { id: true, userId: true, createdAt: true, accountStatus: true, baseCurrency: true, retiredCategorySlugs: true };
const PAYMENT_SELECT = { id: true, amount: true, date: true, outsideBooks: true };

// A bill's payments as one string, to see under the lock that they are still
// the ones the run read.
const paymentsKey = (payments) => payments.map((p) => `${p.id}:${kobo(p.amount)}:${p.outsideBooks ? 1 : 0}`).sort().join(",");

// The payments kept outside the books become ONE for `part.want` (none when
// that is nothing), dated when the row last changed. Only this script makes
// them, one per bill, so there is at most one to change.
async function keepOutside(px, row, part) {
  if (part.want === part.now) return;
  const [first, ...rest] = (row.payments || []).filter((p) => p.outsideBooks);
  for (const p of rest) await px.billPayment.delete({ where: { id: p.id } });
  if (!part.want) {
    if (first) await px.billPayment.delete({ where: { id: first.id } });
  } else if (first) {
    await px.billPayment.update({ where: { id: first.id }, data: { amount: part.want / 100, date: row.updatedAt } });
  } else {
    await px.billPayment.create({
      data: { billId: row.id, amount: part.want / 100, date: row.updatedAt, method: "other", estimated: true, outsideBooks: true },
    });
  }
}

async function backfillR2({ dryRun = false, ownerId = null, log = console.log } = {}) {
  const mine = ownerId ? { userId: ownerId } : {};
  const summary = {
    dryRun,
    customers: { assigned: 0, left: 0, failed: 0 },
    payables: { converted: 0, repaired: 0, paidOutside: 0, left: 0, failed: 0 },
    creditExpenses: { converted: 0, bills: 0, left: 0, failed: 0 },
    creditRules: 0,
    oldPayables: 0,
  };
  // Loaded only for a real run: setting a chart up writes.
  const { ensureChart } = dryRun ? {} : require("../src/utils/ledgerData");

  const owners = new Map(); // owner id → their businesses, earliest first
  const ownedBy = async (userId) => {
    if (!owners.has(userId)) {
      owners.set(userId, await prisma.business.findMany({
        where: { userId }, select: BUSINESS_SELECT, orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      }));
    }
    return owners.get(userId);
  };
  const firstBusinessOf = async (userId) => {
    const list = await ownedBy(userId);
    return list.find((b) => b.accountStatus !== "closed") || list[0] || null;
  };
  const businesses = new Map();
  const businessById = async (id) => {
    if (!businesses.has(id)) businesses.set(id, await prisma.business.findUnique({ where: { id }, select: BUSINESS_SELECT }));
    return businesses.get(id);
  };
  const charts = new Map(); // business id → chart.indexChart
  const chartOf = async (biz) => {
    if (!charts.has(biz.id)) {
      if (!dryRun) await ensureChart(biz.id);
      const accounts = await prisma.ledgerAccount.findMany({ where: { businessId: biz.id }, select: ACCOUNT_SELECT });
      charts.set(biz.id, chart.indexChart(dryRun ? plannedChart(accounts, biz.retiredCategorySlugs) : accounts));
    }
    return charts.get(biz.id);
  };
  // One record's change, under its business's lock, in one transaction.
  const write = (keys, fn) => prisma.withBusinessLock(keys, () => prisma.$transaction(fn));
  const failed = (what, id, err) => log(`  FAIL   ${what} ${id}: ${String((err && err.message) || err).split("\n").filter(Boolean).pop()}`);

  // 1. Customers with no business.
  const customers = await prisma.customer.findMany({
    where: { businessId: null, ...mine }, select: { id: true, userId: true }, orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  log(`customers with no business: ${customers.length}`);
  for (const c of customers) {
    try {
      const owned = await ownedBy(c.userId);
      const debts = await prisma.debt.findMany({
        where: { customerId: c.id }, select: { saleId: true, payments: { select: { transactionId: true } } },
      });
      const saleIds = debts.map((d) => d.saleId).filter(Boolean);
      const txIds = debts.flatMap((d) => d.payments.map((p) => p.transactionId)).filter(Boolean);
      const [debtSales, transfers, sales, invoices, expenses] = await Promise.all([
        saleIds.length ? prisma.sales.findMany({ where: { id: { in: saleIds } }, select: { businessId: true, date: true } }) : [],
        prisma.transaction.findMany({
          where: { OR: [...(txIds.length ? [{ id: { in: txIds } }] : []), { matchedCustomerId: c.id }, { customerId: c.id }] },
          select: { businessId: true, date: true },
        }),
        prisma.sales.findMany({ where: { customerId: c.id }, select: { businessId: true, date: true } }),
        prisma.invoice.findMany({ where: { customerId: c.id }, select: { businessId: true, createdAt: true } }),
        prisma.expense.findMany({ where: { customerId: c.id }, select: { businessId: true, date: true } }),
      ]);
      const ev = (rows, at) => rows.filter((r) => r.businessId).map((r) => ({ businessId: r.businessId, at: r[at] }));
      let pick = pickBusiness([
        { by: "its debts' sales", list: ev(debtSales, "date") },
        { by: "its linked transfers", list: ev(transfers, "date") },
        { by: "its other records", list: [...ev(sales, "date"), ...ev(invoices, "createdAt"), ...ev(expenses, "date")] },
      ], owned);
      if (!pick) {
        const first = await firstBusinessOf(c.userId);
        if (first) pick = { businessId: first.id, by: "the owner's first business", count: 0, businesses: 1 };
      }
      if (!pick) {
        summary.customers.left++;
        log(`  leave  customer ${c.id}: its owner has no business`);
        continue;
      }
      const spread = pick.businesses > 1 ? `; its records are in ${pick.businesses} businesses` : "";
      log(`  assign customer ${c.id} -> business ${pick.businessId} (${pick.by}${pick.count ? `, ${pick.count}` : ""}${spread})`);
      if (dryRun) {
        summary.customers.assigned++;
        continue;
      }
      const done = await prisma.$transaction(async (px) => {
        const r = await px.customer.updateMany({ where: { id: c.id, businessId: null }, data: { businessId: pick.businessId } });
        if (!r.count) return false;
        await px.auditLog.create({
          data: {
            actorType: "system", action: "BACKFILL_R2_CUSTOMER_BUSINESS", resourceType: "customer", resourceId: c.id,
            metadata: { businessId: pick.businessId, by: pick.by, evidence: pick.count, businesses: pick.businesses },
          },
        });
        return true;
      });
      if (done) summary.customers.assigned++;
      else {
        summary.customers.left++;
        log(`  leave  customer ${c.id}: it changed meanwhile (run again)`);
      }
    } catch (err) {
      summary.customers.failed++;
      failed("customer", c.id, err);
    }
  }

  // 2. Payables from before bills: made bills of, or put right. Every row
  // made by nobody known is read, whatever either server did to it since the
  // migration; a bill an earlier run made of one that still matches its
  // payments is passed over (billSettled).
  const payables = await prisma.businessDebt.findMany({
    where: { createdById: null, ...mine },
    include: { payments: { select: PAYMENT_SELECT, orderBy: [{ date: "asc" }, { id: "asc" }] } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const todo = payables.filter((row) => !billSettled(row));
  log(`payables to make bills of or put right: ${todo.length}`);
  for (const row of todo) {
    try {
      const leave = (why) => {
        summary.payables.left++;
        log(`  leave  payable ${row.id}: ${why}`);
      };
      // A bill an earlier run made of it (estimated) stays in its business.
      const repair = row.estimated;
      if (repair && !row.businessId) {
        leave("it is in no business (its business was deleted), so nobody can pay it");
        continue;
      }
      const biz = row.businessId ? await businessById(row.businessId) : await firstBusinessOf(row.userId);
      if (!biz) {
        leave("its owner has no business");
        continue;
      }
      if (biz.userId !== row.userId) {
        leave(`its business ${biz.id} belongs to another owner`);
        continue;
      }
      const amounts = payableAmounts(row);
      if (amounts.reason) {
        leave(amounts.reason);
        continue;
      }
      const part = outsidePart(amounts, row.payments);
      if (part.reason) {
        leave(part.reason);
        continue;
      }
      const outsideNote = part.want !== part.now
        ? `; ${naira(part.want)} already paid kept outside the books, dated ${dayOf(row.updatedAt)}` +
          `${repair ? ` (it was ${naira(part.now)})` : ""}`
        : "";
      const cappedNote = amounts.capped ? ` (it said ${row.remainingAmount} owed, more than its amount)` : "";
      const data = { remainingAmount: amounts.owed / 100, status: amounts.status };
      let made = null; // a new bill's account, and why
      if (repair) {
        log(`  repair payable ${row.id} in business ${biz.id}: ${naira(amounts.owed)} owed${outsideNote}${cappedNote}`);
      } else {
        const C = await chartOf(biz);
        // One the owner already gave an account (the bill routes, before this
        // ran) keeps it, and its date.
        const own = row.accountId ? C.byId.get(row.accountId) || null : null;
        made = own ? { account: own, by: "its own" } : billAccountFor(C, row.type);
        Object.assign(data, { businessId: biz.id, estimated: true }, own ? {} : { accountId: made.account.id, billDate: row.createdAt });
        const inBooksNote = part.inBooks ? `; ${naira(part.inBooks)} paid through bills, kept as recorded` : "";
        log(
          `  bill   payable ${row.id} in business ${biz.id}${row.businessId ? "" : " (it had none)"}: ${naira(amounts.amount)}` +
          ` on ${made.account.name} (${made.by}), dated ${dayOf(own ? row.billDate : row.createdAt)}, estimated,` +
          ` ${naira(amounts.owed)} owed${inBooksNote}${outsideNote}${cappedNote}`,
        );
      }
      const tally = () => {
        if (repair) summary.payables.repaired++;
        else summary.payables.converted++;
        if (part.want && part.want !== part.now) summary.payables.paidOutside++;
      };
      if (dryRun) {
        tally();
        continue;
      }
      const done = await write(biz.id, async (px) => {
        // Only as it was read: the same payments, and the row unchanged since
        // (every write to it, by either server, moves updatedAt).
        const payments = await px.billPayment.findMany({ where: { billId: row.id }, select: PAYMENT_SELECT });
        if (paymentsKey(payments) !== paymentsKey(row.payments)) return false;
        const r = await px.businessDebt.updateMany({
          where: { id: row.id, createdById: null, estimated: repair, updatedAt: row.updatedAt },
          data,
        });
        if (!r.count) return false;
        await keepOutside(px, row, part);
        await px.auditLog.create({
          data: {
            actorType: "system", action: repair ? "BACKFILL_R2_BILL_REPAIR" : "BACKFILL_R2_BILL",
            resourceType: "businessDebt", resourceId: row.id,
            metadata: {
              businessId: biz.id,
              // A new bill: where it went and why. A repair: the payment kept
              // outside the books as it was, to undo by hand.
              ...(made
                ? { hadBusiness: !!row.businessId, accountId: made.account.id, by: made.by, type: row.type }
                : {
                  outsideBefore: row.payments.filter((p) => p.outsideBooks)
                    .map((p) => ({ id: p.id, amount: p.amount, date: p.date.toISOString() })),
                }),
              originalAmount: row.originalAmount, remainingAmount: row.remainingAmount,
              paidOutsideBooks: part.want / 100, paidInBooks: part.inBooks / 100,
              updatedAt: row.updatedAt.toISOString(),
            },
          },
        });
        return true;
      });
      if (done) tally();
      else leave("it changed meanwhile (run again)");
    } catch (err) {
      summary.payables.failed++;
      failed("payable", row.id, err);
    }
  }

  // 3. Expenses saved on credit.
  const onCredit = await prisma.expense.findMany({
    where: { paymentMethod: { equals: "credit", mode: "insensitive" }, ...mine },
    include: { items: { orderBy: { position: "asc" } } },
    orderBy: [{ date: "asc" }, { id: "asc" }],
  });
  log(`expenses saved on credit: ${onCredit.length}`);
  for (const x of onCredit) {
    try {
      const biz = x.businessId ? await businessById(x.businessId) : await firstBusinessOf(x.userId);
      const leave = (why) => {
        summary.creditExpenses.left++;
        log(`  leave  expense ${x.id}: ${why}`);
      };
      if (!biz) {
        leave("its owner has no business");
        continue;
      }
      if (biz.userId !== x.userId) {
        leave(`its business ${biz.id} belongs to another owner`);
        continue;
      }
      // A debit marked as recorded by it would stop counting for good once
      // it goes (whatever the expense itself says).
      const marked = await prisma.transaction.findFirst({ where: { matchedExpenseId: x.id }, select: { id: true } });
      if (marked) {
        leave(`bank transfer ${marked.id} is marked as recorded by it`);
        continue;
      }
      const plan = creditExpenseParts(x, await chartOf(biz), biz.baseCurrency || "NGN");
      if (plan.reason) {
        leave(plan.reason);
        continue;
      }
      const bills = billsFromExpense(x, plan.parts, biz.id);
      log(
        `  bills  expense ${x.id} in business ${biz.id}${x.businessId ? "" : " (it had none)"}: ` +
        plan.parts.map((p) => `${naira(p.amount)} on ${p.account.name}`).join(", ") +
        `, unpaid, dated ${dayOf(x.date)}; the expense goes`,
      );
      if (dryRun) {
        summary.creditExpenses.converted++;
        summary.creditExpenses.bills += bills.length;
        continue;
      }
      const made = await write([...new Set([x.businessId || x.userId, biz.id])], async (px) => {
        if (await px.transaction.count({ where: { matchedExpenseId: x.id } })) return null;
        const gone = await px.expense.deleteMany({ where: { id: x.id, updatedAt: x.updatedAt, matchedTransactionId: null } });
        if (!gone.count) return null;
        const ids = [];
        for (const data of bills) ids.push((await px.businessDebt.create({ data, select: { id: true } })).id);
        await px.auditLog.create({
          data: {
            actorType: "system", action: "BACKFILL_R2_EXPENSE_TO_BILLS", resourceType: "expense", resourceId: x.id,
            metadata: { businessId: biz.id, bills: ids, expense: expenseSnapshot(x) },
          },
        });
        return ids;
      });
      if (made) {
        summary.creditExpenses.converted++;
        summary.creditExpenses.bills += made.length;
        log(`         made bill(s) ${made.join(", ")}`);
      } else leave("it changed meanwhile (run again)");
    } catch (err) {
      summary.creditExpenses.failed++;
      failed("expense", x.id, err);
    }
  }

  // Listed only.
  const rules = await prisma.recurringExpense.findMany({
    where: { paymentMethod: { equals: "credit", mode: "insensitive" }, active: true, ...mine },
    select: { id: true, businessId: true },
  });
  summary.creditRules = rules.length;
  if (rules.length) {
    log(`recurring expenses on credit (each makes an unpaid bill when due; one that cannot is paused): ${rules.length}`);
    for (const r of rules) log(`  note   recurring expense ${r.id} (business ${r.businessId || "none"})`);
  }
  summary.oldPayables = await prisma.payable.count({ where: ownerId ? { business: { userId: ownerId } } : {} });
  if (summary.oldPayables) log(`rows in the retired Payable table (left as they are): ${summary.oldPayables}`);

  log(dryRun ? "dry run: nothing written" : "done");
  return summary;
}

function parseArgs(argv) {
  const out = { dryRun: false, ownerId: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--owner" && /^[A-Za-z0-9_-]+$/.test(argv[i + 1] || "")) out.ownerId = argv[++i];
    else throw new Error(`unknown argument ${a}\nusage: node scripts/backfill-r2.js [--dry-run] [--owner <userId>]`);
  }
  return out;
}

module.exports = {
  backfillR2, parseArgs, slugOf, billAccountFor, payableAmounts, outsidePart, billSettled, creditExpenseParts,
  billsFromExpense, vendorOf, pickBusiness, plannedChart,
};

if (require.main === module) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  let where = "?";
  try {
    const u = new URL(process.env.DATABASE_URL);
    where = `${u.hostname}${u.pathname}`;
  } catch { /* printed as "?" */ }
  console.log(`release 2 backfill on ${where}${args.dryRun ? " (dry run)" : ""}${args.ownerId ? `, owner ${args.ownerId}` : ""}`);
  backfillR2(args)
    .then(async (summary) => {
      console.log(`RESULT ${JSON.stringify(summary)}`);
      await prisma.$disconnect();
      // The business lock holds its own pg connection; without this Node waits on it.
      const bad = summary.customers.failed + summary.payables.failed + summary.creditExpenses.failed;
      process.exit(bad ? 1 : 0);
    })
    .catch(async (err) => {
      console.error(err);
      await prisma.$disconnect();
      process.exit(1);
    });
}
