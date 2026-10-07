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

    console.log("\nTyped (manual) numbers");
    const counterOf = async () => (await prisma.business.findUnique({ where: { id: biz.id } })).invoiceCounter;
    const staffManual = await call("PATCH", "/invoices/numbering", staff.id, { businessId: biz.id, mode: "manual" });
    check("staff cannot switch numbering to manual", staffManual.status === 403, staffManual.status);
    const badMode = await call("PATCH", "/invoices/numbering", owner.id, { businessId: biz.id, mode: "sometimes" });
    check("an unknown mode is refused", badMode.status === 400 && badMode.body?.code === "BAD_MODE", badMode);
    const toManual = await call("PATCH", "/invoices/numbering", owner.id, { businessId: biz.id, mode: "manual" });
    check("the owner switches to manual numbering", toManual.status === 200 && toManual.body?.invoiceNumberMode === "manual", toManual);
    check("switching to manual keeps the prefix and counter", toManual.body?.invoicePrefix === "KB/" && toManual.body?.invoiceCounter === 15, [toManual.body?.invoicePrefix, toManual.body?.invoiceCounter]);
    const c0 = await counterOf();
    const m1 = await create(owner.id, { customerId: bola.id, invoiceNumber: "  2026/045 " });
    check("a typed number is kept exactly, trimmed", m1.status === 201 && m1.body?.invoiceNumber === "2026/045", [m1.status, m1.body?.invoiceNumber]);
    check("a typed number does not move the counter", (await counterOf()) === c0, [c0, await counterOf()]);
    const dup = await create(owner.id, { customerId: bola.id, invoiceNumber: "2026/045" });
    check("the same number again is refused", dup.status === 409 && dup.body?.code === "NUMBER_IN_USE" && dup.body?.number === "2026/045", dup);
    const dupCase = await create(owner.id, { customerId: bola.id, invoiceNumber: "kb/010" });
    check("a number differing only in case is refused", dupCase.status === 409, dupCase.status);
    const badNum = await create(owner.id, { customerId: bola.id, invoiceNumber: "bad*number" });
    check("characters outside the allowed set are refused", badNum.status === 400 && badNum.body?.code === "BAD_INVOICE_NUMBER", badNum);
    const hashNum = await create(owner.id, { customerId: bola.id, invoiceNumber: "#045" });
    check("a number may start with #", hashNum.status === 201 && hashNum.body?.invoiceNumber === "#045", [hashNum.status, hashNum.body?.invoiceNumber]);
    const tooLong = await create(owner.id, { customerId: bola.id, invoiceNumber: "X".repeat(31) });
    check("more than 30 characters is refused", tooLong.status === 400, tooLong.status);
    const fallback = await create(owner.id, { customerId: bola.id });
    check("manual mode with no number still numbers it (older apps)", fallback.status === 201 && fallback.body?.invoiceNumber === "KB/016", [fallback.status, fallback.body?.invoiceNumber]);

    const race = await Promise.all(
      Array.from({ length: 5 }, () => create(owner.id, { customerId: bola.id, invoiceNumber: "RACE-1" })),
    );
    const won = race.filter((r) => r.status === 201).length;
    const lost = race.filter((r) => r.status === 409).length;
    check("five simultaneous saves of one number: exactly one wins", won === 1 && lost === 4, race.map((r) => r.status));
    check("and only one invoice carries it", (await prisma.invoice.count({ where: { businessId: biz.id, invoiceNumber: "RACE-1" } })) === 1);

    console.log("\nCorrecting a draft's number");
    const draft = await create(owner.id, { customerId: bola.id, invoiceNumber: "2026/046" });
    const fixd = await call("PUT", `/invoices/${draft.body?.id}`, owner.id, { customerId: bola.id, issueDate: "2026-10-07", items, invoiceNumber: "2026/047" });
    check("a draft's number can be corrected", fixd.status === 200 && fixd.body?.invoiceNumber === "2026/047", [fixd.status, fixd.body?.invoiceNumber]);
    const clashPut = await call("PUT", `/invoices/${draft.body?.id}`, owner.id, {
      customerId: bola.id, issueDate: "2026-10-07", items: [{ name: "Should not land", quantity: 1, rate: 1 }], invoiceNumber: "2026/045",
    });
    check("correcting to a used number is refused", clashPut.status === 409 && clashPut.body?.code === "NUMBER_IN_USE", clashPut);
    const after = await prisma.invoice.findUnique({ where: { id: draft.body?.id }, include: { items: true } });
    check("a refused correction writes nothing", after?.invoiceNumber === "2026/047" && after?.items.length === 1 && after.items[0].name === "Rice", [after?.invoiceNumber, after?.items.map((i) => i.name)]);
    const same = await call("PUT", `/invoices/${draft.body?.id}`, owner.id, { customerId: bola.id, issueDate: "2026-10-07", items, invoiceNumber: "2026/047" });
    check("sending the unchanged number is fine", same.status === 200, same.status);
    const sentInv = await create(owner.id, { customerId: bola.id, invoiceNumber: "2026/048", status: "sent" });
    const lockedPut = await call("PUT", `/invoices/${sentInv.body?.id}`, owner.id, { customerId: bola.id, issueDate: "2026-10-07", items, invoiceNumber: "2026/049" });
    check("a sent invoice's number is fixed", lockedPut.status === 400 && lockedPut.body?.code === "NUMBER_LOCKED", lockedPut);

    console.log("\nBack to automatic");
    const toAuto = await call("PATCH", "/invoices/numbering", owner.id, { businessId: biz.id, mode: "auto", prefix: "KB/", nextNumber: 50 });
    check("switching back to auto works", toAuto.status === 200 && toAuto.body?.invoiceNumberMode === "auto" && toAuto.body?.next === "KB/050", toAuto);
    const typedLower = await create(owner.id, { customerId: bola.id, invoiceNumber: "kb/050" });
    check("a one-off typed number is allowed in auto mode", typedLower.status === 201, typedLower.status);
    const autoAfter = await create(owner.id, { customerId: bola.id });
    check("the allocator skips a number typed in another case", autoAfter.body?.invoiceNumber === "KB/051", autoAfter.body?.invoiceNumber);

    // ─────────────────────────────────────────────────────────────────────────
    console.log("\nCredit notes");
    const bizRow = async () => prisma.business.findUnique({ where: { id: biz.id } });
    const invCounterBefore = (await bizRow()).invoiceCounter;
    const one = [{ name: "Rice returned", quantity: 1, rate: 1500 }];
    const cn1 = await create(owner.id, {
      type: "credit_note", customerId: bola.id, items: one, status: "sent",
      dueDate: "2026-12-01", paymentTerms: "net_30", orderNumber: "KB/010",
    });
    check("a credit note is created", cn1.status === 201 && cn1.body?.type === "credit_note", [cn1.status, cn1.body?.type]);
    check("it has its own numbers, CN-001", cn1.body?.invoiceNumber === "CN-001", cn1.body?.invoiceNumber);
    check("it opens as SENT (shown as Open)", cn1.body?.status === "SENT", cn1.body?.status);
    check("a credit note never has terms or a due date", cn1.body?.dueDate === null && cn1.body?.paymentTerms === null, [cn1.body?.dueDate, cn1.body?.paymentTerms]);
    check("the reference is kept", cn1.body?.orderNumber === "KB/010", cn1.body?.orderNumber);
    check("the invoice counter does not move", (await bizRow()).invoiceCounter === invCounterBefore, [(await bizRow()).invoiceCounter, invCounterBefore]);
    check("the credit note counter does", (await bizRow()).creditNoteCounter === 1, (await bizRow()).creditNoteCounter);

    const cnNumbering = await call("PATCH", "/invoices/numbering", owner.id, { businessId: biz.id, kind: "credit_note", prefix: "CR/", nextNumber: 5 });
    check("credit notes take their own prefix and next number", cnNumbering.status === 200 && cnNumbering.body?.kind === "credit_note" && cnNumbering.body?.invoicePrefix === "CR/" && cnNumbering.body?.next === "CR/005", cnNumbering.body);
    const cn2 = await create(owner.id, { type: "credit_note", customerId: bola.id, items: one, status: "sent" });
    check("the next credit note uses them", cn2.body?.invoiceNumber === "CR/005", cn2.body?.invoiceNumber);
    check("invoice numbering is untouched", (await bizRow()).invoicePrefix === "KB/", (await bizRow()).invoicePrefix);

    const payCn = await call("POST", `/invoices/${cn1.body?.id}/payments`, owner.id, { amount: 100, method: "cash" });
    check("a credit note takes no payments", payCn.status === 403 && payCn.body?.code === "CREDIT_NOTE_NO_PAYMENT", payCn);

    const target = await create(owner.id, { customerId: bola.id, items: [{ name: "Rice", quantity: 2, rate: 1500 }], status: "sent" });
    const apply1 = await call("POST", `/invoices/${cn1.body?.id}/apply-credit`, owner.id, { invoiceId: target.body?.id, amount: 1000 });
    check("credit is applied to the customer's invoice", apply1.status === 201, apply1);
    check("the credit note is partly used", apply1.body?.creditNote?.amountPaid === 1000 && apply1.body?.creditNote?.status === "PARTIAL", [apply1.body?.creditNote?.amountPaid, apply1.body?.creditNote?.status]);
    check("the invoice balance falls", apply1.body?.invoice?.amountPaid === 1000 && apply1.body?.invoice?.status === "PARTIAL", [apply1.body?.invoice?.amountPaid, apply1.body?.invoice?.status]);
    const credPay = (apply1.body?.invoice?.payments || []).find((p) => p.method === "credit_note");
    check("the invoice shows it as credit from CN-001", credPay?.note === "CN-001" && credPay?.amount === 1000, credPay);
    const usePay = (apply1.body?.creditNote?.payments || []).find((p) => p.method === "credit_applied");
    check("the credit note records where it went", usePay?.note === target.body?.invoiceNumber, usePay);
    check("the link row exists", (await prisma.creditApplication.count({ where: { creditNoteId: cn1.body?.id, invoiceId: target.body?.id } })) === 1);
    const tooMuch = await call("POST", `/invoices/${cn1.body?.id}/apply-credit`, owner.id, { invoiceId: target.body?.id, amount: 600 });
    check("more than the credit left is refused", tooMuch.status === 400 && tooMuch.body?.code === "EXCEEDS_CREDIT" && tooMuch.body?.remaining === 500, tooMuch.body);
    const apply2 = await call("POST", `/invoices/${cn1.body?.id}/apply-credit`, owner.id, { invoiceId: target.body?.id, amount: 500 });
    check("using the rest closes the credit note", apply2.body?.creditNote?.status === "PAID" && apply2.body?.creditNote?.amountPaid === 1500, [apply2.body?.creditNote?.status, apply2.body?.creditNote?.amountPaid]);
    const apply3 = await call("POST", `/invoices/${cn1.body?.id}/apply-credit`, owner.id, { invoiceId: target.body?.id, amount: 1 });
    check("a closed credit note cannot be applied", apply3.status === 409 && apply3.body?.code === "CREDIT_NOT_OPEN", apply3.body);

    const zedInv = await create(owner.id, { customerId: zed.id, items: one, status: "sent" });
    const mismatch = await call("POST", `/invoices/${cn2.body?.id}/apply-credit`, owner.id, { invoiceId: zedInv.body?.id, amount: 100 });
    check("credit cannot pay another customer's invoice", mismatch.status === 409 && mismatch.body?.code === "CUSTOMER_MISMATCH", mismatch.body);
    const small = await create(owner.id, { customerId: bola.id, items: [{ name: "Salt", quantity: 1, rate: 200 }], status: "sent" });
    const over = await call("POST", `/invoices/${cn2.body?.id}/apply-credit`, owner.id, { invoiceId: small.body?.id, amount: 300 });
    check("more than the invoice owes is refused", over.status === 400 && over.body?.code === "EXCEEDS_BALANCE" && over.body?.outstanding === 200, over.body);
    const draftInv = await create(owner.id, { customerId: bola.id, items: one });
    const toDraft = await call("POST", `/invoices/${cn2.body?.id}/apply-credit`, owner.id, { invoiceId: draftInv.body?.id, amount: 100 });
    check("credit cannot go to a draft invoice", toDraft.status === 409 && toDraft.body?.code === "INVOICE_NOT_OPEN", toDraft.body);
    const draftCn = await create(owner.id, { type: "credit_note", customerId: bola.id, items: one });
    const fromDraft = await call("POST", `/invoices/${draftCn.body?.id}/apply-credit`, owner.id, { invoiceId: small.body?.id, amount: 100 });
    check("a draft credit note cannot be applied", fromDraft.status === 409 && fromDraft.body?.code === "CREDIT_NOT_OPEN", fromDraft.body);
    const quoteAsCredit = await call("POST", `/invoices/${target.body?.id}/apply-credit`, owner.id, { invoiceId: small.body?.id, amount: 1 });
    check("an invoice cannot be applied as credit", quoteAsCredit.status === 400 && quoteAsCredit.body?.code === "NOT_A_CREDIT_NOTE", quoteAsCredit.body);
    const otherOwnerApply = await call("POST", `/invoices/${cn2.body?.id}/apply-credit`, other.id, { invoiceId: small.body?.id, amount: 1 });
    check("another owner cannot apply this credit", otherOwnerApply.status === 403, otherOwnerApply.status);

    console.log("\nRefunds");
    const r1 = await call("POST", `/invoices/${cn2.body?.id}/refund`, owner.id, { amount: 500, method: "cash", note: "Paid back at the counter" });
    check("a refund uses credit", r1.status === 201 && r1.body?.amountPaid === 500 && r1.body?.status === "PARTIAL", [r1.status, r1.body?.amountPaid, r1.body?.status]);
    check("it is recorded with its method", (r1.body?.payments || []).some((p) => p.method === "refund_cash" && p.note === "Paid back at the counter"), r1.body?.payments);
    const r2 = await call("POST", `/invoices/${cn2.body?.id}/refund`, owner.id, { amount: 2000, method: "transfer" });
    check("more than the credit left is refused", r2.status === 400 && r2.body?.code === "EXCEEDS_CREDIT", r2.body);
    const r3 = await call("POST", `/invoices/${cn2.body?.id}/refund`, owner.id, { amount: 10, method: "bitcoin" });
    check("an unknown method is refused", r3.status === 400 && r3.body?.code === "BAD_METHOD", r3.body);
    const r4 = await call("POST", `/invoices/${cn2.body?.id}/refund`, owner.id, { amount: 1000, method: "transfer" });
    check("refunding the rest closes it", r4.body?.status === "PAID" && r4.body?.amountPaid === 1500, [r4.body?.status, r4.body?.amountPaid]);

    console.log("\nUsed documents are pinned");
    const voidUsed = await call("PATCH", `/invoices/${cn1.body?.id}/status`, owner.id, { status: "VOID" });
    check("a used credit note cannot be voided", voidUsed.status === 409 && voidUsed.body?.code === "CREDIT_IN_USE", voidUsed.body);
    const delUsed = await call("DELETE", `/invoices/${cn1.body?.id}`, owner.id);
    check("or deleted", delUsed.status === 409 && delUsed.body?.code === "CREDIT_IN_USE", delUsed.body);
    const voidCredited = await call("PATCH", `/invoices/${target.body?.id}/status`, owner.id, { status: "VOID" });
    check("an invoice that received credit cannot be voided", voidCredited.status === 409 && voidCredited.body?.code === "CREDITS_APPLIED", voidCredited.body);
    const delCredited = await call("DELETE", `/invoices/${target.body?.id}`, owner.id);
    check("or deleted", delCredited.status === 409 && delCredited.body?.code === "CREDITS_APPLIED", delCredited.body);
    let dbRefused = false;
    try { await prisma.invoice.delete({ where: { id: target.body?.id } }); } catch { dbRefused = true; }
    check("the database refuses it too", dbRefused);
    const resend = await call("PATCH", `/invoices/${target.body?.id}/status`, owner.id, { status: "SENT" });
    check("SENT on a part-paid invoice changes nothing", resend.status === 200 && resend.body?.status === "PARTIAL", resend.body?.status);
    const redraft = await call("PATCH", `/invoices/${target.body?.id}/status`, owner.id, { status: "DRAFT" });
    check("nothing with payments goes back to draft", redraft.status === 409 && redraft.body?.code === "PAYMENTS_RECORDED", redraft.body);
    const cn4 = await create(owner.id, { type: "credit_note", customerId: bola.id, items: [{ name: "Credit", quantity: 1, rate: 1000 }], status: "sent" });
    await call("POST", `/invoices/${cn4.body?.id}/refund`, owner.id, { amount: 400, method: "cash" });
    const shrink = await call("PUT", `/invoices/${cn4.body?.id}`, owner.id, { customerId: bola.id, issueDate: "2026-10-08", items: [{ name: "Less", quantity: 1, rate: 100 }] });
    check("a credit note cannot shrink below the credit used", shrink.status === 400 && shrink.body?.code === "CREDIT_BELOW_USED" && shrink.body?.used === 400, [shrink.status, shrink.body]);
    const grow = await call("PUT", `/invoices/${cn4.body?.id}`, owner.id, { customerId: bola.id, issueDate: "2026-10-08", items: [{ name: "More", quantity: 1, rate: 1200 }] });
    check("but it can change while it stays above it", grow.status === 200 && grow.body?.total === 1200, [grow.status, grow.body?.total]);
    const voidFree = await call("PATCH", `/invoices/${draftCn.body?.id}/status`, owner.id, { status: "VOID" });
    check("an unused credit note can be voided", voidFree.status === 200 && voidFree.body?.status === "VOID", voidFree.body?.status);

    console.log("\nTwo phones, one credit");
    const cn3 = await create(owner.id, { type: "credit_note", customerId: bola.id, items: [{ name: "Credit", quantity: 1, rate: 1000 }], status: "sent" });
    const big = await create(owner.id, { customerId: bola.id, items: [{ name: "Big order", quantity: 1, rate: 5000 }], status: "sent" });
    const both = await Promise.all([
      call("POST", `/invoices/${cn3.body?.id}/apply-credit`, owner.id, { invoiceId: big.body?.id, amount: 1000 }),
      call("POST", `/invoices/${cn3.body?.id}/apply-credit`, owner.id, { invoiceId: big.body?.id, amount: 1000 }),
      call("POST", `/invoices/${cn3.body?.id}/refund`, owner.id, { amount: 1000, method: "cash" }),
    ]);
    const okCount = both.filter((r) => r.status === 201).length;
    const cn3Row = await prisma.invoice.findUnique({ where: { id: cn3.body?.id } });
    check("the same credit is spent exactly once", okCount === 1 && cn3Row.amountPaid === 1000, [both.map((r) => r.status), cn3Row.amountPaid]);
    const bigRow = await prisma.invoice.findUnique({ where: { id: big.body?.id } });
    const bigApplied = await prisma.creditApplication.aggregate({ _sum: { amount: true }, where: { invoiceId: big.body?.id } });
    check("and the invoice got at most that much", bigRow.amountPaid === (bigApplied._sum.amount || 0) && bigRow.amountPaid <= 1000, [bigRow.amountPaid, bigApplied._sum.amount]);

    console.log("\nPrinted credit note");
    const { buildInvoiceHtml } = require("../src/utils/invoiceHtml");
    const cnHtml = buildInvoiceHtml({
      invoice: { ...apply2.body?.creditNote, status: "paid" },
      business: { name: "Test Biz", virtualAccountNumber: "1234567890", virtualAccountBank: "9PSB" },
      customer: { name: "Bola Buyer" },
      payment: { bank: "9PSB", number: "1234567890", name: "Test Biz", source: "nuban" },
    });
    check("it is titled Credit Note", cnHtml.includes("Credit Note"));
    check("it says Closed, not Paid", cnHtml.includes("CLOSED") && !cnHtml.includes(">PAID<"));
    check("it shows credits used and remaining", cnHtml.includes("Credits Used") && cnHtml.includes("Credits Remaining") && !cnHtml.includes("Balance Due"));
    check("it has no Pay Into block", !cnHtml.includes("Pay Into"));
    const invHtml = buildInvoiceHtml({
      invoice: { ...apply2.body?.invoice, status: "partial" },
      business: { name: "Test Biz" },
      customer: { name: "Bola Buyer" },
    });
    check("the invoice shows credits applied apart from payments", invHtml.includes("Credits Applied") && !invHtml.includes("Amount Paid"), [invHtml.includes("Credits Applied"), invHtml.includes("Amount Paid")]);

    console.log("\nDeleting a whole business");
    const tmpBiz = await prisma.business.create({ data: { userId: owner.id, name: "Temp" } });
    const tmpCust = await prisma.customer.create({ data: { userId: owner.id, businessId: tmpBiz.id, name: "Temp customer" } });
    const tCn = await call("POST", "/invoices", owner.id, { businessId: tmpBiz.id, type: "credit_note", customerId: tmpCust.id, issueDate: "2026-10-08", items: one, status: "sent" });
    const tInv = await call("POST", "/invoices", owner.id, { businessId: tmpBiz.id, customerId: tmpCust.id, issueDate: "2026-10-08", items: one, status: "sent" });
    await call("POST", `/invoices/${tCn.body?.id}/apply-credit`, owner.id, { invoiceId: tInv.body?.id, amount: 500 });
    let bizGone = false;
    try {
      await prisma.customer.deleteMany({ where: { businessId: tmpBiz.id, invoices: { none: {} } } });
      await prisma.business.delete({ where: { id: tmpBiz.id } });
      bizGone = true;
    } catch (e) {
      console.log("        ", e.message.split("\n").slice(-1)[0]);
    }
    check("a business with applied credit can still be deleted", bizGone);
    check("its credit links went with it", (await prisma.creditApplication.count({ where: { businessId: tmpBiz.id } })) === 0);
  } finally {
    server.close();
    // Scratch rows: remove what this run made so it can run again cleanly.
    // Credit links first: they pin their documents (NO ACTION foreign keys).
    await prisma.creditApplication.deleteMany({ where: { businessId: { in: [biz.id, otherBiz.id] } } }).catch(() => {});
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
