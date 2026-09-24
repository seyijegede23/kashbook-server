/**
 * Seed the store-review account with five months of trading.
 *
 * Apple and Google reviewers sign in with one account and expect a business
 * that is in use: stock with barcodes, customers, daily sales, weekly and
 * monthly expenses, invoices in every state, month views with real shapes.
 * This writes that history, deterministically: the same rows every run, so
 * a rerun adds nothing, and `--rebuild` wipes the rows an earlier run wrote
 * and writes them again.
 *
 *   node -r dotenv/config scripts/seed-review-account.js --email dami@example.com [--rebuild] [--dry]
 *
 * Rows are created the way the routes create them (same fields, the invoice
 * counter, channel normalisation), so nothing is distinguishable from
 * entries made in the app. Only rows this script wrote are ever removed:
 * anything dated before the seed window or matched to a bank transaction is
 * left alone. The plan is set to PREMIUM with the admin panel's audit action.
 * Pair it with REVENUECAT_PINNED_USER_IDS on the server (routes/revenuecat.js).
 */
const prisma = require("../src/utils/db");
const bcrypt = require("@node-rs/bcrypt");
const { audit } = require("../src/utils/audit");
const { normalizeChannel } = require("../src/utils/salesChannel");
const { computeNextPayDate, periodKeyFor, referenceFor, SALARY_APPROVAL_TTL_MS } = require("../src/utils/salarySchedule");

// Two staff logins with different grants, each on a monthly salary. The staff
// sign in with the phone number and STAFF_PASSWORD. Bank details are
// illustrative; see the salary section for why no money can ever go there.
const STAFF_PASSWORD = "KashStaff2026";
const STAFF = [
  { firstName: "Chidi", lastName: "Nwosu", phone: "+2348011223344", salary: 85000,
    perms: { canViewBalance: false, canTransfer: true, canViewReports: true, canManagePayables: false, dailyTransferCap: 50000 },
    bank: { accountNumber: "0123456789", bankCode: "058", bankName: "Guaranty Trust Bank", accountName: "CHIDI NWOSU" } },
  { firstName: "Amaka", lastName: "Obi", phone: "+2348022334455", salary: 60000,
    perms: { canViewBalance: false, canTransfer: false, canViewReports: false, canManagePayables: true, dailyTransferCap: null },
    bank: { accountNumber: "3012345678", bankCode: "011", bankName: "First Bank of Nigeria", accountName: "AMAKA OBI" } },
];
const PAY_DAY = 27;

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const EMAIL = opt("--email");
const DRY = args.includes("--dry");
const REBUILD = args.includes("--rebuild");
if (!EMAIL) { console.error("usage: --email <account email> [--rebuild] [--dry]"); process.exit(1); }

// ── Deterministic randomness ───────────────────────────────────────────────
// mulberry32: the same seed gives the same ledger on every machine and run.
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const rand = rng(20260924);
const between = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const weighted = (pairs) => { const r = rand() * pairs.reduce((s, [, w]) => s + w, 0); let acc = 0; for (const [v, w] of pairs) { acc += w; if (r < acc) return v; } return pairs[pairs.length - 1][0]; };

// ── The window: 5 calendar months back from today, in Lagos time ───────────
const DAY = 86400e3;
const TODAY = new Date(); TODAY.setHours(12, 0, 0, 0);
const START = new Date(TODAY); START.setMonth(START.getMonth() - 5); START.setDate(1); START.setHours(12, 0, 0, 0);
const at = (day, hour, minute = 0) => { const d = new Date(day); d.setHours(hour, minute, 0, 0); return d; };
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const ean13 = (body12) => { const s = String(body12).split("").map(Number); const sum = s.reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 1 : 3), 0); return body12 + String((10 - (sum % 10)) % 10); };

const PRODUCTS = [
  { name: "Indomie Chicken 70g", price: 350, cost: 300, quantity: 240, barcode: ean13("615010000001"), w: 5, maxQty: 24 },
  { name: "Peak Evaporated Milk 160g", price: 650, cost: 560, quantity: 120, barcode: ean13("615010000002"), w: 4, maxQty: 12 },
  { name: "Golden Penny Semovita 1kg", price: 2100, cost: 1850, quantity: 60, barcode: ean13("615010000003"), w: 3, maxQty: 6 },
  { name: "Dangote Sugar 1kg", price: 1800, cost: 1600, quantity: 45, barcode: ean13("615010000004"), w: 3, maxQty: 5 },
  { name: "Kings Vegetable Oil 1L", price: 2900, cost: 2600, quantity: 30, barcode: ean13("615010000005"), w: 2, maxQty: 4 },
  { name: "Milo 400g", price: 3200, cost: 2850, quantity: 8, barcode: ean13("615010000006"), w: 2, maxQty: 3 }, // low stock on purpose
];
const CUSTOMERS = [
  { name: "Chinedu Okafor", phone: "+2348023456701" },
  { name: "Blessing Eze", phone: "+2348134567802" },
  { name: "Ngozi Umeh", phone: "+2347012345603" },
  { name: "Tunde Bakare", phone: "+2348098765404" },
  { name: "Amina Yusuf", phone: "+2349011223305" },
];

// ── Generate the ledger ────────────────────────────────────────────────────
function generate() {
  const sales = [], expenses = [], invoices = [];
  const productPairs = PRODUCTS.map((p) => [p, p.w]);
  for (let day = new Date(START); day <= TODAY; day = new Date(day.getTime() + DAY)) {
    const dow = day.getDay(); // 0 Sunday
    const isToday = ymd(day) === ymd(TODAY);
    // Sales: Sundays quiet, Saturdays busy, today only up to the afternoon.
    // A provisions shop paying ₦150k rent turns over ₦1.5m to ₦2m a month;
    // the counts and basket sizes are tuned to land there, well above the
    // expenses below, so the month views read like a business that works.
    // A gentle upward trend, about 8% a month, so the current month is the
    // best one and "vs last month" reads as growth.
    const monthIndex = (day.getFullYear() - START.getFullYear()) * 12 + day.getMonth() - START.getMonth();
    const growth = 1 + 0.08 * monthIndex;
    const base = isToday ? 3 : dow === 0 ? between(0, 3) : dow === 6 ? between(5, 10) : between(3, 7);
    const count = Math.round(base * growth);
    for (let i = 0; i < count; i++) {
      const lines = between(1, 3);
      const chosen = new Map();
      for (let l = 0; l < lines; l++) { const p = weighted(productPairs); chosen.set(p.name, { p, qty: between(1, Math.ceil(p.maxQty * 1.4)) }); }
      const items = [...chosen.values()];
      const amount = items.reduce((s, { p, qty }) => s + p.price * qty, 0);
      const notes = items.map(({ p, qty }) => `${p.name} × ${qty}`).join(", ");
      const channel = weighted([["walk-in", 60], ["whatsapp", 25], ["instagram", 10], ["other", 5]]);
      const paymentMethod = weighted([["cash", 55], ["transfer", 40], ["pos", 5]]);
      const customer = rand() < 0.2 ? pick(CUSTOMERS).name : null;
      sales.push({ amount, paymentMethod, channel, date: at(day, between(8, isToday ? 11 : 19), between(0, 59)), notes, customer });
    }
    // Expenses.
    const dom = day.getDate();
    if (dom === 1) expenses.push({ category: "rent", amount: 150000, paymentMethod: "transfer", date: at(day, 9), notes: `Shop rent, ${day.toLocaleString("en-GB", { month: "long" })}` });
    if (dom === 3) expenses.push({ category: "utility", amount: between(9, 16) * 1000, paymentMethod: "transfer", date: at(day, 10), notes: "Electricity units" });
    if (dom === 27) expenses.push({ category: "salary", amount: 85000, paymentMethod: "transfer", date: at(day, 16), notes: "Shop assistant salary" });
    if (dom === 27) expenses.push({ category: "salary", amount: 60000, paymentMethod: "transfer", date: at(day, 16, 5), notes: "Storekeeper salary" });
    // Restock on Fridays: the week's sales come first, so the Week view is not
    // a loss every Monday to Thursday.
    if (dow === 5) expenses.push({ category: "supplies", amount: between(200, 300) * 1000, paymentMethod: "transfer", date: at(day, 10, 30), notes: `Restock: ${pick(["Indomie and Peak Milk", "Semovita and sugar", "Vegetable oil", "Milo and sugar", "Indomie cartons"])}` });
    if (dow === 2 || dow === 5) expenses.push({ category: "utility", amount: between(6, 14) * 1000, paymentMethod: "cash", date: at(day, 17), notes: "Generator diesel" });
    if (dow === 1 || dow === 3 || dow === 6) expenses.push({ category: "transport", amount: between(10, 40) * 100, paymentMethod: "cash", date: at(day, 14), notes: pick(["Okada delivery", "Delivery to Ikeja", "Keke to market", "Delivery to Yaba"]) });
    if (dom === 15 && rand() < 0.6) expenses.push({ category: "maintenance", amount: between(5, 25) * 1000, paymentMethod: "cash", date: at(day, 12), notes: pick(["Freezer repair", "Shelf and signage", "Generator service"]) });
    if (dom === 20 && rand() < 0.5) expenses.push({ category: "marketing", amount: between(3, 10) * 1000, paymentMethod: "transfer", date: at(day, 11), notes: "Instagram promotion" });
  }
  // Invoices: two a month, older ones paid, the recent ones in every state.
  const months = [];
  for (let m = new Date(START); m <= TODAY; m = new Date(m.getFullYear(), m.getMonth() + 1, 1, 12)) months.push(new Date(m));
  months.forEach((m, mi) => {
    const last = mi === months.length - 1, prev = mi === months.length - 2;
    for (let k = 0; k < 2; k++) {
      const issue = new Date(m.getFullYear(), m.getMonth(), k === 0 ? between(3, 9) : between(14, 22), 12);
      if (issue > TODAY) continue;
      const due = new Date(issue.getTime() + 14 * DAY);
      const lines = between(1, 3);
      const chosen = new Map();
      for (let l = 0; l < lines; l++) { const p = weighted(productPairs); chosen.set(p.name, { name: p.name, quantity: between(6, 40), rate: p.price }); }
      const items = [...chosen.values()];
      const total = items.reduce((s, it) => s + it.quantity * it.rate, 0);
      let status = "PAID", payments = [{ amount: total, method: pick(["transfer", "cash"]), date: new Date(issue.getTime() + between(2, 9) * DAY) }];
      if (last && k === 1) { status = "DRAFT"; payments = []; }
      else if (last && k === 0) { status = "SENT"; payments = []; }
      else if (prev && k === 1) { status = "SENT"; payments = []; } // past due date: the app shows it as overdue
      else if (prev && k === 0) { const part = Math.round(total * 0.4 / 100) * 100; status = "PARTIAL"; payments = [{ amount: part, method: "transfer", date: new Date(issue.getTime() + 5 * DAY) }]; }
      invoices.push({ customer: pick(CUSTOMERS).name, issue, due, items, total, status, payments, notes: k === 0 ? "Thank you for your order." : null });
    }
  });
  invoices.sort((a, b) => a.issue - b.issue);
  return { sales, expenses, invoices };
}

(async () => {
  const user = await prisma.user.findFirst({
    where: { email: { equals: EMAIL, mode: "insensitive" }, accountType: "OWNER" },
    select: { id: true, email: true, plan: true, firstName: true, lastName: true, businesses: { select: { id: true, name: true, invoiceCounter: true }, orderBy: { createdAt: "asc" } } },
  });
  if (!user) throw new Error(`no owner account for ${EMAIL}`);
  const biz = user.businesses[0];
  if (!biz) throw new Error("that account has no business");
  const ownerName = [user.firstName, user.lastName].filter(Boolean).join(" ") || "Owner";
  const { sales, expenses, invoices } = generate();
  console.log(`${DRY ? "[dry] " : ""}account ${user.id} (${user.plan}) business "${biz.name}" ${biz.id}`);
  console.log(`window ${ymd(START)} → ${ymd(TODAY)}: ${sales.length} sales, ${expenses.length} expenses, ${invoices.length} invoices generated`);
  const done = [];

  // 0. Rebuild: remove what earlier runs wrote, identified by creation time.
  //    The first seed ran on 2026-09-21; the owner's own entries on this
  //    account were all created before that, and anything matched to a bank
  //    transaction is never touched.
  if (REBUILD && !DRY) {
    const SEED_EPOCH = new Date("2026-09-21T17:00:00Z");
    const s = await prisma.sales.deleteMany({ where: { businessId: biz.id, createdAt: { gte: SEED_EPOCH }, matchedTransactionId: null } });
    const e = await prisma.expense.deleteMany({ where: { businessId: biz.id, createdAt: { gte: SEED_EPOCH }, matchedTransactionId: null } });
    const inv = await prisma.invoice.deleteMany({ where: { businessId: biz.id } });
    await prisma.business.update({ where: { id: biz.id }, data: { invoiceCounter: 0 } });
    biz.invoiceCounter = 0;
    done.push(`rebuild: removed ${s.count} sales, ${e.count} expenses, ${inv.count} invoices; invoice counter reset`);
  }

  // 1. Plan
  if (user.plan !== "PREMIUM") {
    if (!DRY) {
      await prisma.user.update({ where: { id: user.id }, data: { plan: "PREMIUM" } });
      await audit({ action: "ADMIN_PLAN_UPGRADE", resourceType: "user", resourceId: user.id, severity: "info",
        actorOverride: { type: "system", id: "seed-review-account" }, metadata: { reason: "store review account" } }).catch(() => {});
    }
    done.push("plan → PREMIUM");
  }

  // 2. Customers (unique on userId+phone, so upsert like the route)
  const customerByName = {};
  for (const c of await prisma.customer.findMany({ where: { businessId: biz.id } })) customerByName[c.name] = c;
  for (const c of CUSTOMERS) {
    if (customerByName[c.name]) continue;
    if (!DRY) {
      customerByName[c.name] = await prisma.customer.upsert({
        where: { userId_phone: { userId: user.id, phone: c.phone } },
        update: { name: c.name, businessId: biz.id },
        create: { userId: user.id, businessId: biz.id, name: c.name, phone: c.phone, reminderEnabled: false },
      });
    }
    done.push(`customer ${c.name}`);
  }

  // 3. Products, keyed by barcode (unique per business)
  const existingBarcodes = new Set((await prisma.inventoryItem.findMany({ where: { businessId: biz.id }, select: { barcode: true } })).map((i) => i.barcode));
  for (const p of PRODUCTS) {
    if (existingBarcodes.has(p.barcode)) continue;
    if (!DRY) await prisma.inventoryItem.create({ data: {
      userId: user.id, businessId: biz.id, name: p.name, unit: "piece", quantity: p.quantity, price: p.price, cost: p.cost,
      lowStockAlert: 10, category: "Food", barcode: p.barcode, lastRestocked: new Date(TODAY.getTime() - 8 * DAY), createdBy: user.id, createdByName: ownerName,
    } });
    done.push(`product ${p.name} [${p.barcode}]`);
  }

  // 4. Sales and expenses, keyed by date + amount + note so a rerun adds nothing
  const key = (r) => `${new Date(r.date).toISOString()}|${r.amount}|${r.notes}`;
  // Existing rows are read from a day before the window start: the first
  // rent entry is dated 09:00 on the 1st, before START's noon, and without
  // the margin a rerun would add it again.
  const KEY_FROM = new Date(START.getTime() - DAY);
  const saleKeys = new Set((await prisma.sales.findMany({ where: { businessId: biz.id, date: { gte: KEY_FROM } }, select: { date: true, amount: true, notes: true } })).map(key));
  const newSales = sales.filter((s) => !saleKeys.has(key(s)));
  if (!DRY && newSales.length) {
    await prisma.sales.createMany({ data: newSales.map((s) => ({
      userId: user.id, businessId: biz.id, customerId: s.customer ? customerByName[s.customer]?.id || null : null,
      amount: s.amount, paymentMethod: s.paymentMethod, isCredit: false, notes: s.notes, channel: normalizeChannel(s.channel),
      date: s.date, recordedBy: user.id, recordedByName: ownerName,
    })) });
  }
  if (newSales.length) done.push(`${newSales.length} sales, ₦${newSales.reduce((s, x) => s + x.amount, 0).toLocaleString("en-NG")} in total`);
  const expenseKeys = new Set((await prisma.expense.findMany({ where: { businessId: biz.id, date: { gte: KEY_FROM } }, select: { date: true, amount: true, notes: true } })).map(key));
  const newExpenses = expenses.filter((e) => !expenseKeys.has(key(e)));
  if (!DRY && newExpenses.length) {
    await prisma.expense.createMany({ data: newExpenses.map((e) => ({ userId: user.id, businessId: biz.id, category: e.category, amount: e.amount, paymentMethod: e.paymentMethod, date: e.date, notes: e.notes })) });
  }
  if (newExpenses.length) done.push(`${newExpenses.length} expenses, ₦${newExpenses.reduce((s, x) => s + x.amount, 0).toLocaleString("en-NG")} in total`);

  // 5. Invoices, in date order so the numbers run with the calendar
  const existingInv = new Set((await prisma.invoice.findMany({ where: { businessId: biz.id }, select: { issueDate: true, total: true } })).map((i) => `${i.issueDate}|${i.total}`));
  let counter = biz.invoiceCounter;
  for (const inv of invoices) {
    if (existingInv.has(`${ymd(inv.issue)}|${inv.total}`)) continue;
    const paid = inv.payments.reduce((s, p) => s + p.amount, 0);
    if (!DRY) {
      const updated = await prisma.business.update({ where: { id: biz.id }, data: { invoiceCounter: { increment: 1 } } });
      counter = updated.invoiceCounter;
      const row = await prisma.invoice.create({ data: {
        businessId: biz.id, customerId: customerByName[inv.customer]?.id || null, userId: user.id, invoiceNumber: `INV-${String(counter).padStart(3, "0")}`, type: "invoice",
        status: inv.status, issueDate: ymd(inv.issue), dueDate: ymd(inv.due), subtotal: inv.total, taxRate: 0, taxAmount: 0,
        discountValue: 0, discountAmount: 0, total: inv.total, amountPaid: paid, notes: inv.notes, template: "classic",
        createdAt: inv.issue, updatedAt: inv.issue,
        items: { create: inv.items.map((it) => ({ name: it.name, quantity: it.quantity, rate: it.rate, amount: it.quantity * it.rate })) },
      } });
      for (const p of inv.payments) await prisma.invoicePayment.create({ data: { invoiceId: row.id, amount: p.amount, method: p.method, date: p.date } });
    } else counter++;
    done.push(`invoice INV-${String(counter).padStart(3, "0")} ${inv.status} ${ymd(inv.issue)} ${inv.customer} ₦${inv.total.toLocaleString("en-NG")}`);
  }

  // 6. Staff logins with their grants, the way POST /auth/staff and the
  //    permissions route write them. Keyed by phone.
  const owner = await prisma.user.findUnique({ where: { id: user.id }, select: { businessName: true } });
  const staffByPhone = {};
  for (const s of STAFF) {
    let row = await prisma.user.findUnique({ where: { phone: s.phone }, select: { id: true, employerId: true, firstName: true, lastName: true } });
    if (row && row.employerId !== user.id) throw new Error(`${s.phone} belongs to another account`);
    if (!row) {
      if (!DRY) {
        row = await prisma.user.create({ data: {
          firstName: s.firstName, lastName: s.lastName, businessName: owner.businessName, phone: s.phone, email: null,
          password: await bcrypt.hash(STAFF_PASSWORD, 12), accountType: "STAFF", employerId: user.id, createdAt: START,
        }, select: { id: true, employerId: true, firstName: true, lastName: true } });
        await prisma.staffPermission.create({ data: { userId: row.id, employerId: user.id, ...s.perms, grantedById: user.id } });
      }
      done.push(`staff ${s.firstName} ${s.lastName} (${s.phone}) with grants`);
    }
    if (row) staffByPhone[s.phone] = row;
  }

  // 7. Salaries: one schedule per staff member, paid history for every month
  //    of the window, next pay date after this one. Consent is bound to the
  //    payee, and these schedules are written with a payee key that can never
  //    match ("demo:never-authorized"), so the runner suspends them instead of
  //    minting a payment: nothing on this account can send money to the
  //    illustrative bank details above, even if someone approves with a PIN.
  const nextRunDate = computeNextPayDate({ frequency: "monthly", anchorDay: PAY_DAY, businessDayRule: "before", from: new Date(TODAY.getTime() + 4 * DAY) });
  for (const s of STAFF) {
    const staff = staffByPhone[s.phone];
    if (!staff) continue;
    const staffNameSnapshot = `${staff.firstName} ${staff.lastName}`.trim();
    let schedule = await prisma.salarySchedule.findUnique({ where: { ownerId_staffUserId: { ownerId: user.id, staffUserId: staff.id } } });
    if (!schedule) {
      if (!DRY) {
        schedule = await prisma.salarySchedule.create({ data: {
          businessId: biz.id, ownerId: user.id, staffUserId: staff.id, staffNameSnapshot,
          payoutKind: "external_bank", accountNumber: s.bank.accountNumber, bankCode: s.bank.bankCode, bankName: s.bank.bankName, accountName: s.bank.accountName, nameVerified: true,
          amount: s.salary, currency: "NGN", frequency: "monthly", anchorDay: PAY_DAY, businessDayRule: "before", nextRunDate,
          authorizedAt: START, authorizedAmount: s.salary, authorizedPayee: "demo:never-authorized", status: "active", createdAt: START,
          lastRunAt: at(TODAY, 9), lastRunStatus: "paid",
        } });
      }
      done.push(`salary schedule ${staffNameSnapshot} ₦${s.salary.toLocaleString("en-NG")} monthly on the ${PAY_DAY}th, next ${ymd(nextRunDate)}`);
    }
    if (!schedule) continue;
    // Paid history: one row per month from the window start to this month.
    const rows = [];
    for (let m = new Date(START.getFullYear(), START.getMonth(), 1, 12); m <= TODAY; m = new Date(m.getFullYear(), m.getMonth() + 1, 1, 12)) {
      let scheduledFor = computeNextPayDate({ frequency: "monthly", anchorDay: PAY_DAY, businessDayRule: "before", from: m });
      if (scheduledFor > TODAY) scheduledFor = at(TODAY, 9); // this month, paid early
      const periodKey = periodKeyFor(scheduledFor, "monthly");
      const paidAt = new Date(scheduledFor.getTime() + 9 * 3600e3);
      rows.push({
        scheduleId: schedule.id, businessId: biz.id, ownerId: user.id, staffUserId: staff.id, staffNameSnapshot,
        amount: s.salary, currency: "NGN", payoutKind: "external_bank", accountNumber: s.bank.accountNumber, bankCode: s.bank.bankCode, bankName: s.bank.bankName, accountName: s.bank.accountName, nameVerified: true,
        periodKey, scheduledFor, status: "paid", owed: false, reference: referenceFor(schedule.id, periodKey),
        expiresAt: new Date(scheduledFor.getTime() + SALARY_APPROVAL_TTL_MS), decidedById: user.id, decidedAt: paidAt, paidAt,
        executedReference: referenceFor(schedule.id, periodKey), feeCharged: 53.75, createdAt: scheduledFor, updatedAt: paidAt,
      });
    }
    const existing = await prisma.salaryPayment.count({ where: { scheduleId: schedule.id } });
    if (existing < rows.length) {
      if (!DRY) await prisma.salaryPayment.createMany({ data: rows, skipDuplicates: true });
      done.push(`${rows.length - existing} paid salary rows for ${staffNameSnapshot}`);
    }
  }

  console.log(done.length ? done.map((d) => "  + " + d).join("\n") : "  nothing to add, already seeded");
  console.log(DRY ? "dry run, nothing written" : "done");
  await prisma.$disconnect();
})().catch(async (e) => { console.error("seed failed:", e.message); await prisma.$disconnect(); process.exit(1); });
