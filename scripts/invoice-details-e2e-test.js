// Invoice details end to end (2026-10-07): payment terms, order number,
// subject, salesperson, the numbering gear, typed-name customers, and the
// draft → sent move on edit. Real invoice routes over HTTP against a real
// Postgres; only the login check is stood in (x-test-user header).
//
//   TEST_DATABASE_URL='postgresql://postgres:<pw>@localhost:5432/kashbook_invoice_e2e' \
//     node scripts/invoice-details-e2e-test.js
//
// The database needs every migration applied (`npx prisma migrate deploy` with
// DATABASE_URL pointing at it). Refuses to run against anything but localhost.
const path = require("path");

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  console.error("TEST_DATABASE_URL is required (a local scratch database).");
  process.exit(1);
}
const host = new URL(url).hostname;
if (!["localhost", "127.0.0.1"].includes(host)) {
  console.error(`Refusing to run against ${host}: local databases only.`);
  process.exit(1);
}
process.env.DATABASE_URL = url;

const prisma = require("../src/utils/db");

// Stand-in for the auth middleware, shaped like the real req.user.
const authPath = path.resolve(__dirname, "../src/middleware/auth.js");
require.cache[authPath] = {
  id: authPath,
  filename: authPath,
  loaded: true,
  exports: async (req, res, next) => {
    const id = req.headers["x-test-user"];
    const u = id
      ? await prisma.user.findUnique({
          where: { id },
          select: { id: true, accountType: true, employerId: true, firstName: true, lastName: true },
        })
      : null;
    if (!u) return res.status(401).json({ error: "no user" });
    req.user = {
      id: u.id,
      accountType: u.accountType.toLowerCase(),
      employerId: u.employerId ?? null,
      name: `${u.firstName} ${u.lastName}`.trim(),
      permissions: {},
    };
    next();
  },
};

const express = require("express");
const invoicesRouter = require("../src/routes/invoices");
const { processRecurringInvoices } = require("../src/utils/recurringInvoiceRunner");

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  ok    ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail !== undefined ? `  →  ${JSON.stringify(detail)}` : ""}`);
  }
}

async function main() {
  const app = express();
  app.use(express.json());
  app.use("/invoices", invoicesRouter);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, userId, body) => {
    const r = await fetch(base + p, {
      method,
      headers: { "content-type": "application/json", "x-test-user": userId },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not json */
    }
    return { status: r.status, body: json };
  };

  const tag = Date.now().toString(36);
  const owner = await prisma.user.create({
    data: { firstName: "Ola", lastName: "Owner", businessName: "Test Biz", email: `owner-${tag}@test.local` },
  });
  const staff = await prisma.user.create({
    data: {
      firstName: "Chidi", lastName: "Staff", businessName: "Test Biz",
      email: `staff-${tag}@test.local`, accountType: "STAFF", employerId: owner.id,
    },
  });
  const other = await prisma.user.create({
    data: { firstName: "Eve", lastName: "Other", businessName: "Other Biz", email: `other-${tag}@test.local` },
  });
  const biz = await prisma.business.create({ data: { userId: owner.id, name: "Test Biz" } });
  const otherBiz = await prisma.business.create({ data: { userId: other.id, name: "Other Biz" } });
  const bola = await prisma.customer.create({
    data: { userId: owner.id, businessId: biz.id, name: "Bola Buyer", phone: `+234800${tag.slice(-6)}` },
  });
  const foreign = await prisma.customer.create({
    data: { userId: other.id, businessId: otherBiz.id, name: "Foreign Customer" },
  });

  const items = [{ name: "Rice", quantity: 2, rate: 1500 }];
  const create = (userId, extra) =>
    call("POST", "/invoices", userId, { businessId: biz.id, issueDate: "2026-10-07", items, ...extra });

  try {
    console.log("\nCreate with the new details");
    const a = await create(owner.id, {
      customerId: bola.id,
      dueDate: "2026-11-06",
      paymentTerms: "net_30",
      orderNumber: "  PO-4471  ",
      subject: "  October restock  ",
      salespersonId: staff.id,
    });
    check("201 Created", a.status === 201, a.status);
    check("first number is INV-001 (default prefix)", a.body?.invoiceNumber === "INV-001", a.body?.invoiceNumber);
    check("payment terms stored", a.body?.paymentTerms === "net_30", a.body?.paymentTerms);
    check("order number trimmed", a.body?.orderNumber === "PO-4471", a.body?.orderNumber);
    check("subject trimmed", a.body?.subject === "October restock", a.body?.subject);
    check("salesperson is the staff member", a.body?.salespersonId === staff.id, a.body?.salespersonId);
    check("salesperson name comes from the database", a.body?.salespersonName === "Chidi Staff", a.body?.salespersonName);
    check("customer linked", a.body?.customerId === bola.id && a.body?.customer?.name === "Bola Buyer", a.body?.customer);
    check("a new invoice is a draft", a.body?.status === "DRAFT", a.body?.status);

    console.log("\nValidation on create");
    const b = await create(owner.id, {
      customerId: bola.id, paymentTerms: "net_7_bogus", orderNumber: "X".repeat(80), status: "PAID",
      salespersonId: other.id,
    });
    check("unknown payment term dropped", b.body?.paymentTerms === null, b.body?.paymentTerms);
    check("order number capped at 50", b.body?.orderNumber?.length === 50, b.body?.orderNumber?.length);
    check("status PAID from the body becomes DRAFT", b.body?.status === "DRAFT", b.body?.status);
    check("another owner's user is never a salesperson", b.body?.salespersonId === null && b.body?.salespersonName === null, [b.body?.salespersonId, b.body?.salespersonName]);
    const sent = await create(owner.id, { customerId: bola.id, status: "sent" });
    check("status sent is accepted on create", sent.body?.status === "SENT", sent.body?.status);
    const self = await create(owner.id, { customerId: bola.id, salespersonId: owner.id });
    check("the owner can be the salesperson", self.body?.salespersonName === "Ola Owner", self.body?.salespersonName);

    console.log("\nCustomers typed by name");
    const walk1 = await create(owner.id, { customerName: "Walk-in Ada" });
    const ada = walk1.body?.customerId ? await prisma.customer.findUnique({ where: { id: walk1.body.customerId } }) : null;
    check("a typed name creates the customer", !!ada && ada.name === "Walk-in Ada", ada);
    check("created for this owner and business", ada?.userId === owner.id && ada?.businessId === biz.id, [ada?.userId, ada?.businessId]);
    const walk2 = await create(owner.id, { customerName: "walk-in ADA" });
    check("the same name again reuses that customer", walk2.body?.customerId === ada?.id, [walk2.body?.customerId, ada?.id]);
    const cross = await create(owner.id, { customerId: foreign.id });
    check("another owner's customer id is not linked", cross.body?.customerId === null, cross.body?.customerId);
    const crossNamed = await create(owner.id, { customerId: foreign.id, customerName: "Zed" });
    const zed = crossNamed.body?.customerId
      ? await prisma.customer.findUnique({ where: { id: crossNamed.body.customerId } })
      : null;
    check("a foreign id with a name falls back to this owner's customer", zed?.name === "Zed" && zed?.userId === owner.id, zed);
    const temp = await create(owner.id, { customerId: "temp-123", customerName: "Bola Buyer" });
    check("an unknown id plus a known name links the existing customer", temp.body?.customerId === bola.id, temp.body?.customerId);
    const byStaff = await create(staff.id, { customerName: "Staff Walk-in", salespersonId: staff.id });
    const staffCust = byStaff.body?.customerId
      ? await prisma.customer.findUnique({ where: { id: byStaff.body.customerId } })
      : null;
    check("a staff-created customer belongs to the owner", staffCust?.userId === owner.id, staffCust?.userId);
    check("staff can name themselves salesperson", byStaff.body?.salespersonName === "Chidi Staff", byStaff.body?.salespersonName);
    check("staff invoices belong to the owner", byStaff.body?.userId === owner.id, byStaff.body?.userId);

    console.log("\nNumbering");
    const staffTry = await call("PATCH", "/invoices/numbering", staff.id, { businessId: biz.id, prefix: "S-", nextNumber: 5 });
    check("staff cannot change numbering", staffTry.status === 403 && staffTry.body?.code === "OWNER_ONLY", staffTry);
    const badPrefix = await call("PATCH", "/invoices/numbering", owner.id, { businessId: biz.id, prefix: "bad prefix!", nextNumber: 5 });
    check("a bad prefix is refused", badPrefix.status === 400 && badPrefix.body?.code === "BAD_PREFIX", badPrefix);
    const badNext = await call("PATCH", "/invoices/numbering", owner.id, { businessId: biz.id, prefix: "KB/", nextNumber: 0 });
    check("next number 0 is refused", badNext.status === 400 && badNext.body?.code === "BAD_NUMBER", badNext);
    const foreignBiz = await call("PATCH", "/invoices/numbering", owner.id, { businessId: otherBiz.id, prefix: "X-", nextNumber: 1 });
    check("another owner's business is refused", foreignBiz.status === 403, foreignBiz.status);
    const set = await call("PATCH", "/invoices/numbering", owner.id, { businessId: biz.id, prefix: " KB/ ", nextNumber: 10 });
    check("numbering saved", set.status === 200 && set.body?.invoicePrefix === "KB/" && set.body?.invoiceCounter === 9, set);
    check("the response previews the next number", set.body?.next === "KB/010", set.body?.next);
    const k10 = await create(owner.id, { customerId: bola.id });
    check("the next invoice uses the new prefix and number", k10.body?.invoiceNumber === "KB/010", k10.body?.invoiceNumber);
    const inUse = await call("PATCH", "/invoices/numbering", owner.id, { businessId: biz.id, prefix: "KB/", nextNumber: 10 });
    check("a start number already used is refused", inUse.status === 409 && inUse.body?.code === "NUMBER_IN_USE" && inUse.body?.number === "KB/010", inUse);

    // Simulate a clash the route cannot see coming: KB/011 already exists.
    await prisma.invoice.create({
      data: {
        businessId: biz.id, userId: owner.id, invoiceNumber: "KB/011", issueDate: "2026-10-07",
        items: { create: [{ name: "x", quantity: 1, rate: 1, amount: 1 }] },
      },
    });
    const skip = await create(owner.id, { customerId: bola.id });
    check("the allocator skips a number already used", skip.body?.invoiceNumber === "KB/012", skip.body?.invoiceNumber);
    const quote = await create(owner.id, { customerId: bola.id, type: "quote" });
    check("quotes keep QTE- on the shared counter", quote.body?.invoiceNumber === "QTE-013", quote.body?.invoiceNumber);
    const conv = await call("POST", `/invoices/${quote.body?.id}/convert-to-invoice`, owner.id);
    check("a converted quote gets the owner's prefix", conv.body?.invoiceNumber === "KB/014", conv.body?.invoiceNumber);

    await prisma.recurringInvoice.create({
      data: {
        userId: owner.id, businessId: biz.id, customerId: bola.id, description: "Weekly supply",
        amount: 5000, frequency: "weekly", dueInDays: 7, nextDue: new Date(Date.now() - 60 * 1000),
      },
    });
    await processRecurringInvoices(new Date());
    const rec = await prisma.invoice.findFirst({
      where: { businessId: biz.id, items: { some: { name: "Weekly supply" } } },
      select: { invoiceNumber: true },
    });
    check("the recurring runner uses the owner's prefix", rec?.invoiceNumber === "KB/015", rec?.invoiceNumber);

    console.log("\nEditing");
    const d = a.body;
    const put1 = await call("PUT", `/invoices/${d.id}`, owner.id, {
      customerId: bola.id, issueDate: d.issueDate, dueDate: d.dueDate, items, status: "sent",
    });
    check("save and send moves a draft to SENT", put1.body?.status === "SENT", put1.body?.status);
    check("an update without the detail keys keeps them", put1.body?.orderNumber === "PO-4471" && put1.body?.subject === "October restock" && put1.body?.salespersonId === staff.id && put1.body?.paymentTerms === "net_30", [put1.body?.orderNumber, put1.body?.subject, put1.body?.salespersonId, put1.body?.paymentTerms]);
    const put2 = await call("PUT", `/invoices/${d.id}`, owner.id, {
      customerId: bola.id, issueDate: d.issueDate, items, status: "draft",
      salespersonId: null, paymentTerms: "net_45", orderNumber: "", subject: "Updated",
    });
    check("a sent invoice does not go back to draft", put2.body?.status === "SENT", put2.body?.status);
    check("salesperson cleared", put2.body?.salespersonId === null && put2.body?.salespersonName === null, [put2.body?.salespersonId, put2.body?.salespersonName]);
    check("terms changed", put2.body?.paymentTerms === "net_45", put2.body?.paymentTerms);
    check("an empty order number clears it", put2.body?.orderNumber === null, put2.body?.orderNumber);
    check("subject changed", put2.body?.subject === "Updated", put2.body?.subject);
    const put3 = await call("PUT", `/invoices/${d.id}`, owner.id, { customerName: "Walk-in Ada", issueDate: d.issueDate, items });
    check("editing to a typed name links that customer", put3.body?.customerId === ada?.id, put3.body?.customerId);

    console.log("\nReading back");
    const list = await call("GET", `/invoices?businessId=${biz.id}`, owner.id);
    const row = (list.body || []).find((i) => i.id === d.id);
    check("the list returns the new fields", !!row && row.paymentTerms === "net_45" && row.subject === "Updated", row && [row.paymentTerms, row.subject]);
  } finally {
    server.close();
    // Scratch rows: remove what this run made so it can run again cleanly.
    await prisma.invoice.deleteMany({ where: { businessId: { in: [biz.id, otherBiz.id] } } }).catch(() => {});
    await prisma.recurringInvoice.deleteMany({ where: { businessId: biz.id } }).catch(() => {});
    await prisma.appNotification.deleteMany({ where: { userId: { in: [owner.id, staff.id, other.id] } } }).catch(() => {});
    await prisma.customer.deleteMany({ where: { userId: { in: [owner.id, other.id] } } }).catch(() => {});
    await prisma.business.deleteMany({ where: { id: { in: [biz.id, otherBiz.id] } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: [staff.id, owner.id, other.id] } } }).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
