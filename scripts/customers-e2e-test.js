// The Add / Edit Customer form end to end (2026-10-10): every field's rules,
// the duplicate-mobile refusal (no more silent overwrite), partial edits,
// clearing, and the copy of a customer's addresses and TIN that each invoice
// keeps (create, edit, credit note, quote conversion, recurring), printed on
// the document and the public page. Real routers over HTTP, real Postgres,
// real login tokens.
//
//   TEST_DATABASE_URL=postgresql://postgres:<pw>@localhost:5432/kashbook_books_e2e \
//     node scripts/customers-e2e-test.js
const url = process.env.TEST_DATABASE_URL;
if (!url) {
  console.error("TEST_DATABASE_URL is required (a local scratch database).");
  process.exit(1);
}
if (!["localhost", "127.0.0.1"].includes(new URL(url).hostname)) {
  console.error("Refusing: local databases only.");
  process.exit(1);
}
process.env.DATABASE_URL = url;
process.env.JWT_SECRET = "e2e-only-secret-0123456789abcdef0123456789abcdef";
process.env.NODE_ENV = "test";

const assert = require("assert");
const http = require("http");
const express = require("express");
const prisma = require("../src/utils/db");
const { Prisma } = require("@prisma/client");
const { signToken } = require("../src/utils/jwt");
const { buildInvoiceHtml } = require("../src/utils/invoiceHtml");
const { processRecurringInvoices } = require("../src/utils/recurringInvoiceRunner");

const app = express();
app.use(express.json());
app.use("/customers", require("../src/routes/customers"));
app.use("/invoices", require("../src/routes/invoices"));
app.use("/", require("../src/routes/publicInvoice"));

let BASE;
const call = (method, path, token, body) =>
  new Promise((resolve) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const r = http.request(`${BASE}${path}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        let j = null;
        try { j = JSON.parse(d); } catch { /* html or empty */ }
        resolve({ status: res.statusCode, body: j, text: d });
      });
    });
    r.on("error", (e) => resolve({ status: 0, body: { error: e.message } }));
    if (data) r.write(data);
    r.end();
  });

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${name}\n        ${String(e.message).split("\n")[0]}`);
  }
}
const eq = (a, b, what = "") => assert.strictEqual(a, b, `${what} ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
const deq = (a, b, what = "") => assert.deepStrictEqual(a, b, `${what} ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
const section = (s) => console.log(`\n── ${s}`);

const tag = Date.now().toString(36);
const today = new Date(Date.now() + 3600000).toISOString().slice(0, 10);
let owner, biz, biz2, T;
const uniq = (n) => `+23480${String(Date.now()).slice(-6)}${n}`;

(async () => {
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  BASE = `http://127.0.0.1:${server.address().port}`;
  console.log(`\nCUSTOMER FORM — END TO END\n${BASE}`);

  owner = await prisma.user.create({
    data: {
      email: `cust-${tag}@t.local`, password: "x", firstName: "Ada", lastName: "Owner",
      businessName: "Cust Co", country: "NG", currency: "NGN", accountType: "OWNER",
    },
  });
  biz = await prisma.business.create({ data: { userId: owner.id, name: "Cust Co", country: "NG", baseCurrency: "NGN" } });
  biz2 = await prisma.business.create({ data: { userId: owner.id, name: "Second Co", country: "NG", baseCurrency: "NGN" } });
  T = signToken({ userId: owner.id, tokenVersion: 0 });

  const billing = {
    attention: "Accounts", street1: "12 Broad Street", street2: "Floor 3", city: "Lagos Island",
    state: "Lagos", postalCode: "101001", country: "Nigeria", phone: "0803 111 2222",
  };
  const full = {
    businessId: biz.id,
    onDuplicate: "refuse", // the Add Customer form's contract
    name: "Acme Stores Ltd",
    phone: uniq(1),
    customerType: "business",
    salutation: "Mr.",
    firstName: "Tunde",
    lastName: "Bello",
    companyName: "Acme Stores Ltd",
    email: "  Tunde@Acme.NG ",
    workPhone: "+234 1 234 5678",
    website: "acme.ng",
    taxId: "12345678-0001",
    paymentTerms: "net_30",
    billingAddress: billing,
    shippingAddress: { street1: "5 Wharf Road", city: "Apapa", state: "Lagos", country: "Nigeria", junk: "x" },
    contactPersons: [{ salutation: "Ms.", firstName: "Ngozi", lastName: "Eze", email: "ngozi@acme.ng", phone: "0805-000-1111", designation: "Buyer" }],
    notes: "Pays on the 5th",
  };
  let acme;

  try {
    section("Create");
    await test("every field is stored, cleaned", async () => {
      const r = await call("POST", "/customers", T, full);
      eq(r.status, 201, JSON.stringify(r.body));
      acme = r.body;
      eq(acme.name, "Acme Stores Ltd");
      eq(acme.email, "tunde@acme.ng", "email lower-cased, trimmed");
      eq(acme.workPhone, "+2341234567" + "8", "work phone compacted");
      eq(acme.website, "acme.ng");
      eq(acme.paymentTerms, "net_30");
      eq(acme.billingAddress.phone, "08031112222", "address phone compacted");
      eq(acme.billingAddress.street1, "12 Broad Street");
      eq(acme.shippingAddress.junk, undefined, "unknown address keys dropped");
      eq(acme.contactPersons.length, 1);
      eq(typeof acme.contactPersons[0].id, "string", "contact person gets an id");
      eq(acme.contactPersons[0].phone, "08050001111");
      eq(acme.notes, "Pays on the 5th");
      eq(acme.totalOwed, 0);
    });
    await test("bad email, phone, website and contact person are refused with their field", async () => {
      const base = { businessId: biz.id, name: "X", onDuplicate: "refuse" };
      const e = await call("POST", "/customers", T, { ...base, email: "not-an-email" });
      eq(e.status, 400); eq(e.body.code, "BAD_EMAIL"); eq(e.body.field, "email");
      const p = await call("POST", "/customers", T, { ...base, phone: "call me" });
      eq(p.body.code, "BAD_PHONE");
      const w = await call("POST", "/customers", T, { ...base, website: "not a site" });
      eq(w.body.code, "BAD_WEBSITE");
      const c = await call("POST", "/customers", T, { ...base, contactPersons: [{ email: "a@b.co" }] });
      eq(c.body.code, "BAD_CONTACT_PERSON");
      const many = Array.from({ length: 11 }, (_, i) => ({ firstName: `P${i}` }));
      const m = await call("POST", "/customers", T, { ...base, contactPersons: many });
      eq(m.body.code, "TOO_MANY_CONTACTS"); eq(m.body.max, 10);
    });
    await test("'custom' is never a customer's default terms; unknown types are dropped", async () => {
      const r = await call("POST", "/customers", T, { businessId: biz.id, name: "Terms Test", paymentTerms: "custom", customerType: "alien" });
      eq(r.status, 201); eq(r.body.paymentTerms, null); eq(r.body.customerType, null);
    });
    await test("a country on its own is not an address", async () => {
      const r = await call("POST", "/customers", T, { businessId: biz.id, name: "Country Only", billingAddress: { country: "Nigeria" } });
      eq(r.status, 201); eq(r.body.billingAddress, null);
    });
    await test("the old one-line add still works (name + phone)", async () => {
      const r = await call("POST", "/customers", T, { businessId: biz.id, name: "Walk-in Bola", phone: "0809 123 4567" });
      eq(r.status, 201); eq(r.body.phone, "08091234567"); eq(r.body.email, null);
    });
    await test("an older app's odd number is stored as typed, not refused", async () => {
      const r = await call("POST", "/customers", T, { businessId: biz.id, name: "Two Numbers", phone: "0803 111 0000/0805 2" });
      eq(r.status, 201, JSON.stringify(r.body)); eq(r.body.phone, "0803 111 0000/0805 2");
    });

    section("Duplicate mobile number");
    await test("refused with the customer who has it, who is left untouched", async () => {
      const r = await call("POST", "/customers", T, { businessId: biz2.id, name: "Impostor", phone: full.phone, onDuplicate: "refuse" });
      eq(r.status, 409); eq(r.body.code, "DUPLICATE_PHONE"); eq(r.body.customer.id, acme.id);
      const still = await prisma.customer.findUnique({ where: { id: acme.id } });
      eq(still.name, "Acme Stores Ltd", "not renamed");
      eq(still.businessId, biz.id, "not moved to the other business");
    });
    await test("the same number typed with spaces is the same number", async () => {
      const spaced = full.phone.replace(/^(\+\d{4})(\d{3})/, "$1 $2 ");
      const r = await call("POST", "/customers", T, { businessId: biz.id, name: "Spaced", phone: spaced, onDuplicate: "refuse" });
      eq(r.status, 409); eq(r.body.code, "DUPLICATE_PHONE");
    });
    await test("an older app gets the customer who has the number back, unchanged", async () => {
      const r = await call("POST", "/customers", T, { businessId: biz2.id, name: "Old App Ada", phone: full.phone });
      eq(r.status, 201); eq(r.body.id, acme.id);
      eq(r.body.name, "Acme Stores Ltd", "not renamed"); eq(r.body.businessId, biz.id, "not moved");
    });

    section("Edit");
    await test("only the fields sent change", async () => {
      const r = await call("PATCH", `/customers/${acme.id}`, T, { notes: "Pays on the 10th" });
      eq(r.status, 200, JSON.stringify(r.body));
      eq(r.body.notes, "Pays on the 10th");
      eq(r.body.email, "tunde@acme.ng"); eq(r.body.taxId, "12345678-0001");
      deq(r.body.billingAddress, acme.billingAddress);
    });
    await test("owner, business and balance can't be set from the body", async () => {
      const r = await call("PATCH", `/customers/${acme.id}`, T, { userId: "x", businessId: biz2.id, totalOwed: 999 });
      eq(r.status, 200);
      eq(r.body.userId, owner.id); eq(r.body.businessId, biz.id); eq(r.body.totalOwed, 0);
    });
    await test("an address and contact persons can be cleared", async () => {
      const r = await call("PATCH", `/customers/${acme.id}`, T, { shippingAddress: null, contactPersons: [] });
      eq(r.status, 200, JSON.stringify(r.body));
      eq(r.body.shippingAddress, null); eq(r.body.contactPersons, null);
    });
    await test("a blank display name is refused; a blank mobile is stored as none", async () => {
      const n = await call("PATCH", `/customers/${acme.id}`, T, { name: "  " });
      eq(n.status, 400); eq(n.body.code, "NAME_REQUIRED");
      const other = await call("POST", "/customers", T, { businessId: biz.id, name: "Blank Phone", phone: uniq(2) });
      const p = await call("PATCH", `/customers/${other.body.id}`, T, { phone: "" });
      eq(p.status, 200); eq(p.body.phone, null);
      const p2 = await call("PATCH", `/customers/${other.body.id}`, T, { phone: null });
      eq(p2.status, 200, "null phone no longer crashes");
    });
    await test("taking another customer's mobile number is refused", async () => {
      const other = await call("POST", "/customers", T, { businessId: biz.id, name: "Other", phone: uniq(3) });
      const r = await call("PATCH", `/customers/${other.body.id}`, T, { phone: full.phone });
      eq(r.status, 409); eq(r.body.code, "DUPLICATE_PHONE"); eq(r.body.customer.id, acme.id);
    });
    await test("a customer can be marked inactive and active again", async () => {
      const off = await call("PATCH", `/customers/${acme.id}`, T, { inactive: true });
      eq(off.status, 200); eq(typeof off.body.inactiveAt, "string", "inactiveAt set");
      eq(off.body.notes, "Pays on the 10th", "nothing else changes");
      const on = await call("PATCH", `/customers/${acme.id}`, T, { inactive: false });
      eq(on.status, 200); eq(on.body.inactiveAt, null);
    });
    await test("another owner's customer can't be edited", async () => {
      const rival = await prisma.user.create({
        data: { email: `rival-${tag}@t.local`, password: "x", firstName: "R", lastName: "V", businessName: "R", country: "NG", currency: "NGN", accountType: "OWNER" },
      });
      const r = await call("PATCH", `/customers/${acme.id}`, signToken({ userId: rival.id, tokenVersion: 0 }), { name: "Mine now" });
      eq(r.status, 403);
    });

    section("Invoices keep the customer's address and TIN as they were");
    // Put the shipping address back for the document tests.
    await call("PATCH", `/customers/${acme.id}`, T, { shippingAddress: full.shippingAddress });
    let inv;
    await test("a new invoice copies the addresses and TIN", async () => {
      const r = await call("POST", "/invoices", T, {
        businessId: biz.id, customerId: acme.id, issueDate: today, status: "SENT",
        items: [{ name: "Rice", quantity: 1, rate: 5000 }],
      });
      eq(r.status, 201, JSON.stringify(r.body));
      inv = r.body;
      eq(inv.customerTaxId, "12345678-0001");
      eq(inv.billingAddress.street1, "12 Broad Street");
      eq(inv.shippingAddress.city, "Apapa");
    });
    await test("editing the customer leaves the issued invoice as it was", async () => {
      await call("PATCH", `/customers/${acme.id}`, T, { taxId: "99999999-0001", billingAddress: { ...billing, street1: "1 New Road" } });
      const row = await prisma.invoice.findUnique({ where: { id: inv.id } });
      eq(row.customerTaxId, "12345678-0001"); eq(row.billingAddress.street1, "12 Broad Street");
    });
    await test("saving the invoice again takes the customer's details as they are now", async () => {
      const r = await call("PUT", `/invoices/${inv.id}`, T, {
        customerId: acme.id, issueDate: today, items: [{ name: "Rice", quantity: 1, rate: 5000 }],
      });
      eq(r.status, 200, JSON.stringify(r.body));
      eq(r.body.customerTaxId, "99999999-0001"); eq(r.body.billingAddress.street1, "1 New Road");
    });
    await test("a customer with no address leaves none behind on a re-saved invoice", async () => {
      const bare = await call("POST", "/customers", T, { businessId: biz.id, name: "Bare" });
      const r = await call("PUT", `/invoices/${inv.id}`, T, {
        customerId: bare.body.id, issueDate: today, items: [{ name: "Rice", quantity: 1, rate: 5000 }],
      });
      eq(r.status, 200); eq(r.body.billingAddress, null); eq(r.body.shippingAddress, null); eq(r.body.customerTaxId, null);
    });
    await test("credit notes and converted quotes carry them too", async () => {
      const cn = await call("POST", "/invoices", T, {
        businessId: biz.id, customerId: acme.id, issueDate: today, type: "credit_note", status: "SENT",
        items: [{ name: "Return", quantity: 1, rate: 100 }],
      });
      eq(cn.status, 201); eq(cn.body.customerTaxId, "99999999-0001");
      const q = await call("POST", "/invoices", T, {
        businessId: biz.id, customerId: acme.id, issueDate: today, type: "quote",
        items: [{ name: "Quote", quantity: 1, rate: 100 }],
      });
      // A quote saved before this feature has no copy; converting it takes one.
      await prisma.invoice.update({ where: { id: q.body.id }, data: { customerTaxId: null, billingAddress: Prisma.DbNull } });
      eq((await prisma.invoice.findUnique({ where: { id: q.body.id } })).billingAddress, null, "copy cleared first");
      const c = await call("POST", `/invoices/${q.body.id}/convert-to-invoice`, T);
      eq(c.status, 200, JSON.stringify(c.body)); eq(c.body.customerTaxId, "99999999-0001");
      eq(c.body.billingAddress.street1, "1 New Road");
    });
    await test("recurring invoices carry them", async () => {
      const rule = await prisma.recurringInvoice.create({
        data: {
          userId: owner.id, businessId: biz.id, customerId: acme.id, description: "Weekly supply",
          amount: 1000, frequency: "weekly", nextDue: new Date(Date.now() - 60000),
        },
      });
      await processRecurringInvoices(new Date());
      const made = await prisma.recurringInvoice.findUnique({ where: { id: rule.id } });
      const row = await prisma.invoice.findUnique({ where: { id: made.lastInvoiceId } });
      eq(row.customerTaxId, "99999999-0001"); eq(row.shippingAddress.city, "Apapa");
    });

    section("On the document");
    await test("Bill To prints the address and the customer's TIN; Ship To prints", async () => {
      const row = await prisma.invoice.findFirst({ where: { businessId: biz.id, customerId: acme.id, type: "invoice", customerTaxId: { not: null } }, include: { items: true, payments: true } });
      const html = buildInvoiceHtml({
        invoice: { ...row, status: String(row.status).toLowerCase() },
        business: { name: "Cust Co" },
        customer: { name: "Acme Stores Ltd", phone: full.phone },
      });
      for (const s of ["Bill To", "1 New Road", "Lagos Island, Lagos 101001", "TIN: 99999999-0001", "Ship To", "5 Wharf Road", "Attn: Accounts"]) {
        assert.ok(html.includes(s), `missing "${s}"`);
      }
    });
    await test("a document with no copy prints Bill To as before", async () => {
      const html = buildInvoiceHtml({
        invoice: { invoiceNumber: "INV-1", issueDate: today, items: [], total: 0, status: "sent" },
        business: { name: "Cust Co" },
        customer: { name: "Bola Buyer" },
      });
      assert.ok(html.includes("Bola Buyer")); assert.ok(!html.includes("Ship To")); assert.ok(!html.includes("TIN:"));
    });
    await test("the public page shows the address but never the notes or the email", async () => {
      const row = await prisma.invoice.findFirst({ where: { businessId: biz.id, customerId: acme.id, type: "invoice", customerTaxId: { not: null } } });
      const link = await call("POST", `/invoices/${row.id}/share-link`, T);
      eq(link.status < 300, true, JSON.stringify(link.body));
      const token = String(link.body.url || link.body.token).split("/").pop();
      const page = await call("GET", `/i/${token}`);
      eq(page.status, 200);
      assert.ok(page.text.includes("1 New Road"), "address missing");
      assert.ok(!page.text.includes("Pays on the 10th"), "notes leaked");
      assert.ok(!page.text.includes("tunde@acme.ng"), "email leaked");
    });

    section("Delete");
    await test("a customer with issued invoices is refused, and stays", async () => {
      const r = await call("DELETE", `/customers/${acme.id}`, T);
      eq(r.status, 409, JSON.stringify(r.body)); eq(r.body.code, "CUSTOMER_HAS_DOCUMENTS");
      assert.ok(await prisma.customer.findUnique({ where: { id: acme.id } }), "still there");
    });
    await test("a customer with only a recurring rule is refused", async () => {
      const c = await call("POST", "/customers", T, { businessId: biz.id, name: "Rule Only" });
      await prisma.recurringInvoice.create({
        data: {
          userId: owner.id, businessId: biz.id, customerId: c.body.id, description: "Monthly",
          amount: 500, frequency: "monthly", nextDue: new Date(Date.now() + 86400000),
        },
      });
      const r = await call("DELETE", `/customers/${c.body.id}`, T);
      eq(r.status, 409); eq(r.body.code, "CUSTOMER_HAS_DOCUMENTS");
    });
    await test("a customer with only a draft goes, the draft kept without them", async () => {
      const c = await call("POST", "/customers", T, { businessId: biz.id, name: "Draft Only" });
      const d = await call("POST", "/invoices", T, {
        businessId: biz.id, customerId: c.body.id, issueDate: today, status: "DRAFT",
        items: [{ name: "Maybe", quantity: 1, rate: 100 }],
      });
      eq(d.status, 201, JSON.stringify(d.body));
      const r = await call("DELETE", `/customers/${c.body.id}`, T);
      eq(r.status < 300, true, JSON.stringify(r.body));
      eq(await prisma.customer.findUnique({ where: { id: c.body.id } }), null, "gone");
      eq((await prisma.invoice.findUnique({ where: { id: d.body.id } })).customerId, null, "draft kept");
    });
    await test("a customer with nothing goes; deleting again is 404", async () => {
      const c = await call("POST", "/customers", T, { businessId: biz.id, name: "Nothing" });
      eq((await call("DELETE", `/customers/${c.body.id}`, T)).status < 300, true);
      eq((await call("DELETE", `/customers/${c.body.id}`, T)).status, 404);
    });
  } finally {
    server.close();
    await prisma.$disconnect();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
