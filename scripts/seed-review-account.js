/**
 * Seed the store-review account.
 *
 * Apple and Google reviewers sign in with one account and expect to see a
 * business that is in use: stock with barcodes, customers, recent sales and
 * expenses, invoices in more than one state, and every Pro feature open. This
 * puts that account into that state, idempotently: run it twice and the second
 * run adds nothing.
 *
 *   node -r dotenv/config scripts/seed-review-account.js --email dami@example.com [--dry]
 *
 * Rows are created the way the routes create them (same fields, same
 * invoice-number counter, same channel normalisation), so nothing here is
 * distinguishable from entries made in the app. The plan is set to PREMIUM
 * with the same audit action the admin panel writes. Pair it with
 * REVENUECAT_PINNED_USER_IDS on the server so a reviewer's sandbox purchase
 * expiring cannot knock the account back to Free (see routes/revenuecat.js).
 */
const prisma = require("../src/utils/db");
const { audit } = require("../src/utils/audit");
const { normalizeChannel } = require("../src/utils/salesChannel");

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const EMAIL = opt("--email");
const DRY = args.includes("--dry");
if (!EMAIL) { console.error("usage: --email <account email> [--dry]"); process.exit(1); }

const DAY = 86400e3;
const daysAgo = (n, hour = 11) => { const d = new Date(Date.now() - n * DAY); d.setHours(hour, 0, 0, 0); return d; };
const ymd = (d) => d.toISOString().slice(0, 10);
// EAN-13 from a 12-digit body: Nigeria's GS1 prefix is 615.
const ean13 = (body12) => {
  const s = String(body12).split("").map(Number);
  const sum = s.reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 1 : 3), 0);
  return body12 + String((10 - (sum % 10)) % 10);
};

const PRODUCTS = [
  { name: "Indomie Chicken 70g", price: 350, cost: 300, quantity: 240, category: "Food", barcode: ean13("615010000001") },
  { name: "Peak Evaporated Milk 160g", price: 650, cost: 560, quantity: 120, category: "Food", barcode: ean13("615010000002") },
  { name: "Golden Penny Semovita 1kg", price: 2100, cost: 1850, quantity: 60, category: "Food", barcode: ean13("615010000003") },
];
const CUSTOMERS = [
  { name: "Chinedu Okafor", phone: "+2348023456701" },
  { name: "Blessing Eze", phone: "+2348134567802" },
];
const EXPENSES = [
  // Today's rows keep the dashboard's "today" tiles from reading zero in
  // review screenshots. daysAgo(0) is today at the given hour, so a rerun on
  // a later day adds nothing (same notes + amount) and the old rows age out.
  { category: "transport", amount: 1500, paymentMethod: "cash", date: daysAgo(0, 8), notes: "Okada delivery" },
  { category: "rent", amount: 150000, paymentMethod: "transfer", date: daysAgo(12, 9), notes: "Shop rent, September" },
  { category: "supplies", amount: 84000, paymentMethod: "transfer", date: daysAgo(8, 10), notes: "Restock: Indomie and Peak Milk" },
  { category: "utility", amount: 18000, paymentMethod: "cash", date: daysAgo(5, 16), notes: "Generator diesel" },
  { category: "transport", amount: 6500, paymentMethod: "cash", date: daysAgo(2, 14), notes: "Delivery to Ikeja" },
];
const SALES = [
  { amount: 3900, paymentMethod: "cash", channel: "walk-in", date: daysAgo(0, 9), notes: "Peak Evaporated Milk 160g × 6" },
  { amount: 6300, paymentMethod: "transfer", channel: "whatsapp", date: daysAgo(0, 10), notes: "Golden Penny Semovita 1kg × 3" },
  { amount: 4200, paymentMethod: "cash", channel: "walk-in", date: daysAgo(9, 10), notes: "Indomie Chicken 70g × 12" },
  { amount: 9750, paymentMethod: "transfer", channel: "whatsapp", date: daysAgo(7, 13), notes: "Peak Evaporated Milk 160g × 15" },
  { amount: 12600, paymentMethod: "transfer", channel: "instagram", date: daysAgo(6, 15), notes: "Golden Penny Semovita 1kg × 6" },
  { amount: 2650, paymentMethod: "cash", channel: "walk-in", date: daysAgo(4, 12), notes: "Indomie Chicken 70g × 5, Peak Evaporated Milk 160g × 1" },
  { amount: 25200, paymentMethod: "transfer", channel: "whatsapp", date: daysAgo(2, 11), notes: "Golden Penny Semovita 1kg × 12", customer: "Chinedu Okafor" },
  { amount: 7000, paymentMethod: "cash", channel: "walk-in", date: daysAgo(1, 17), notes: "Indomie Chicken 70g × 20" },
];
const INVOICES = [
  {
    status: "SENT", customer: "Chinedu Okafor", issue: daysAgo(3), due: new Date(Date.now() + 11 * DAY),
    items: [
      { name: "Golden Penny Semovita 1kg", quantity: 10, rate: 2100 },
      { name: "Peak Evaporated Milk 160g", quantity: 24, rate: 650 },
    ],
    notes: "Thank you for your order.",
  },
  {
    status: "PAID", customer: "Blessing Eze", issue: daysAgo(6), due: daysAgo(-8),
    items: [{ name: "Indomie Chicken 70g", quantity: 48, rate: 350 }],
    payment: { method: "transfer", date: daysAgo(5, 12) },
  },
];

(async () => {
  const user = await prisma.user.findFirst({
    where: { email: { equals: EMAIL, mode: "insensitive" }, accountType: "OWNER" },
    select: { id: true, email: true, plan: true, firstName: true, lastName: true, businesses: { select: { id: true, name: true, invoiceCounter: true }, orderBy: { createdAt: "asc" } } },
  });
  if (!user) throw new Error(`no owner account for ${EMAIL}`);
  const biz = user.businesses[0];
  if (!biz) throw new Error("that account has no business");
  const ownerName = [user.firstName, user.lastName].filter(Boolean).join(" ") || "Owner";
  console.log(`${DRY ? "[dry] " : ""}account ${user.id} (${user.plan}) business "${biz.name}" ${biz.id}`);
  const done = [];

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
      lowStockAlert: 10, category: p.category, barcode: p.barcode, lastRestocked: daysAgo(8, 10), createdBy: user.id, createdByName: ownerName,
    } });
    done.push(`product ${p.name} [${p.barcode}]`);
  }

  // 4. Expenses and sales, keyed by note + amount so a rerun adds nothing
  const expenseKeys = new Set((await prisma.expense.findMany({ where: { businessId: biz.id }, select: { notes: true, amount: true } })).map((e) => `${e.notes}|${e.amount}`));
  for (const e of EXPENSES) {
    if (expenseKeys.has(`${e.notes}|${e.amount}`)) continue;
    if (!DRY) await prisma.expense.create({ data: { userId: user.id, businessId: biz.id, category: e.category, amount: e.amount, paymentMethod: e.paymentMethod, date: e.date, notes: e.notes } });
    done.push(`expense ${e.notes} ₦${e.amount}`);
  }
  const saleKeys = new Set((await prisma.sales.findMany({ where: { businessId: biz.id }, select: { notes: true, amount: true } })).map((s) => `${s.notes}|${s.amount}`));
  for (const s of SALES) {
    if (saleKeys.has(`${s.notes}|${s.amount}`)) continue;
    if (!DRY) await prisma.sales.create({ data: {
      userId: user.id, businessId: biz.id, customerId: s.customer ? customerByName[s.customer]?.id || null : null,
      amount: s.amount, paymentMethod: s.paymentMethod, isCredit: false, notes: s.notes, channel: normalizeChannel(s.channel),
      date: s.date, recordedBy: user.id, recordedByName: ownerName,
    } });
    done.push(`sale ${s.notes} ₦${s.amount}`);
  }

  // 5. Invoices, only if the business has none (the counter must stay in step)
  const invoiceCount = await prisma.invoice.count({ where: { businessId: biz.id } });
  if (invoiceCount === 0) {
    for (const inv of INVOICES) {
      const subtotal = inv.items.reduce((sum, it) => sum + it.quantity * it.rate, 0);
      if (!DRY) {
        const updated = await prisma.business.update({ where: { id: biz.id }, data: { invoiceCounter: { increment: 1 } } });
        const invoiceNumber = `INV-${String(updated.invoiceCounter).padStart(3, "0")}`;
        const row = await prisma.invoice.create({ data: {
          businessId: biz.id, customerId: customerByName[inv.customer]?.id || null, userId: user.id, invoiceNumber, type: "invoice",
          status: inv.status, issueDate: ymd(inv.issue), dueDate: ymd(inv.due), subtotal, taxRate: 0, taxAmount: 0,
          discountValue: 0, discountAmount: 0, total: subtotal, amountPaid: inv.status === "PAID" ? subtotal : 0,
          notes: inv.notes || null, template: "classic",
          items: { create: inv.items.map((it) => ({ name: it.name, quantity: it.quantity, rate: it.rate, amount: it.quantity * it.rate })) },
        } });
        if (inv.payment) await prisma.invoicePayment.create({ data: { invoiceId: row.id, amount: subtotal, method: inv.payment.method, date: inv.payment.date } });
      }
      done.push(`invoice ${inv.status} to ${inv.customer} ₦${subtotal}`);
    }
  }

  console.log(done.length ? done.map((d) => "  + " + d).join("\n") : "  nothing to add, already seeded");
  console.log(DRY ? "dry run, nothing written" : "done");
  await prisma.$disconnect();
})().catch(async (e) => { console.error("seed failed:", e.message); await prisma.$disconnect(); process.exit(1); });
