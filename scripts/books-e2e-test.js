// Books rule end to end (2026-10-09): invoice payments and refunds linked to
// the bank rows they are, write-offs, void/delete rules, VAT numbering, the
// "what was this money" outcomes, credit sales with their debt, the auto
// matcher's link, and the totals booksFor gives. Real routers over HTTP,
// real Postgres, real login tokens.
//
//   TEST_DATABASE_URL=postgresql://postgres:<pw>@localhost:5432/kashbook_books_e2e \
//     node scripts/books-e2e-test.js
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
const { signToken } = require("../src/utils/jwt");
const { booksFor, receivablesFor } = require("../src/utils/booksData");
const { tryMatchInvoice } = require("../src/utils/invoiceMatch");

const app = express();
app.use(express.json());
app.use("/invoices", require("../src/routes/invoices"));
app.use("/transactions", require("../src/routes/transactions"));
app.use("/sales", require("../src/routes/sales"));
app.use("/customers", require("../src/routes/customers"));

let BASE;
const call = (method, path, token, body) =>
  new Promise((resolve) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const r = http.request(`${BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        let j = null;
        try { j = JSON.parse(d); } catch { /* not json */ }
        resolve({ status: res.statusCode, body: j });
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
const section = (s) => console.log(`\n── ${s}`);

const tag = Date.now().toString(36);
const today = new Date(Date.now() + 3600000).toISOString().slice(0, 10);
const month = today.slice(0, 7);
let owner, biz, vatBiz, cust, cust2, T;
let seq = 0;

const credit = (amount, over = {}) =>
  prisma.transaction.create({
    data: {
      businessId: biz.id, userId: owner.id, type: "income", amount, category: "transfer",
      paymentMethod: "bank", source: "anchor", currency: "NGN", date: new Date(),
      reference: `b_${tag}_${seq++}`, ...over,
    },
  });
const debit = (amount, over = {}) => credit(amount, { type: "expense", ...over });
const invoice = async (total, over = {}, b = biz) => {
  const r = await call("POST", "/invoices", T, {
    businessId: b.id, customerId: cust.id, issueDate: today, status: "SENT",
    items: [{ name: "Goods", quantity: 1, rate: total }], ...over,
  });
  if (r.status !== 201) throw new Error(`invoice create ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};
const pay = (id, body) => call("POST", `/invoices/${id}/payments`, T, body);
const books = (basis) => booksFor(biz.id, { from: today, to: today, basis });
const txRow = (id) => prisma.transaction.findUnique({ where: { id } });
const inv = (id) => prisma.invoice.findUnique({ where: { id }, include: { payments: true } });

(async () => {
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  BASE = `http://127.0.0.1:${server.address().port}`;
  console.log(`\nBOOKS RULE — END TO END\n${BASE}`);

  owner = await prisma.user.create({
    data: {
      email: `books-${tag}@t.local`, password: "x", firstName: "Ada", lastName: "Owner",
      businessName: "Books Co", country: "NG", currency: "NGN", accountType: "OWNER",
    },
  });
  biz = await prisma.business.create({ data: { userId: owner.id, name: "Books Co", country: "NG", baseCurrency: "NGN" } });
  vatBiz = await prisma.business.create({
    data: { userId: owner.id, name: "VAT Co", country: "NG", baseCurrency: "NGN", vatEnabled: true, vatRate: 7.5 },
  });
  cust = await prisma.customer.create({ data: { userId: owner.id, businessId: biz.id, name: "Bola" } });
  cust2 = await prisma.customer.create({ data: { userId: owner.id, businessId: biz.id, name: "Chika" } });
  T = signToken({ userId: owner.id, tokenVersion: 0 });

  try {
    section("Invoice paid into the KashBook account");
    const c1 = await credit(50000);
    const i1 = await invoice(50000);
    await test("bank method needs the credit", async () => {
      const r = await pay(i1.id, { amount: 50000, method: "bank" });
      eq(r.status, 400); eq(r.body.code, "TRANSACTION_REQUIRED");
    });
    await test("linked payment: dated at the credit, credit marked, invoice paid", async () => {
      const r = await pay(i1.id, { amount: 50000, method: "bank", transactionId: c1.id });
      eq(r.status, 201, JSON.stringify(r.body));
      eq(r.body.status, "PAID");
      const p = r.body.payments[0];
      eq(p.transactionId, c1.id);
      eq(new Date(p.date).getTime(), c1.date.getTime());
      const t = await txRow(c1.id);
      eq(t.matchedInvoiceId, i1.id); eq(t.matchedAmount, 50000);
    });
    await test("the naira counts once: sales ₦50,000, not ₦100,000", async () => eq((await books()).sales.total, 50000));
    await test("a used credit can't pay another invoice", async () => {
      const i = await invoice(1000);
      const r = await pay(i.id, { amount: 1000, method: "bank", transactionId: c1.id });
      eq(r.status, 400); eq(r.body.code, "EXCEEDS_TRANSFER"); eq(r.body.remaining, 0);
    });
    await test("…nor be turned into a sale as well", async () => {
      const r = await call("POST", `/transactions/${c1.id}/create-sale`, T, {});
      eq(r.status, 409); eq(r.body.code, "ALREADY_MATCHED");
    });

    section("One credit, two invoices, undo");
    const c2 = await credit(30000);
    const iA = await invoice(20000);
    const iB = await invoice(15000);
    await test("pays A in full and B in part", async () => {
      eq((await pay(iA.id, { amount: 20000, method: "bank", transactionId: c2.id })).status, 201);
      const r = await pay(iB.id, { amount: 10000, method: "bank", transactionId: c2.id });
      eq(r.status, 201); eq(r.body.status, "PARTIAL");
      const t = await txRow(c2.id);
      eq(t.matchedInvoiceId, iA.id); eq(t.matchedAmount, 30000);
    });
    await test("no more than the credit", async () => {
      const r = await pay(iB.id, { amount: 5000, method: "bank", transactionId: c2.id });
      eq(r.body.code, "EXCEEDS_TRANSFER");
    });
    await test("undo A's payment: credit freed by 20,000 and re-pointed at B", async () => {
      const a = await inv(iA.id);
      const r = await call("DELETE", `/invoices/${iA.id}/payments/${a.payments[0].id}`, T);
      eq(r.status, 200, JSON.stringify(r.body)); eq(r.body.status, "SENT"); eq(r.body.amountPaid, 0);
      const t = await txRow(c2.id);
      eq(t.matchedInvoiceId, iB.id); eq(t.matchedAmount, 10000);
    });
    await test("totals still right: the freed 20,000 counts on its own", async () => eq((await books()).sales.total, 80000));
    await test("unmatching the credit takes its payment off B", async () => {
      const r = await call("DELETE", `/transactions/${c2.id}/match`, T);
      eq(r.status, 200, JSON.stringify(r.body));
      const b = await inv(iB.id);
      eq(b.amountPaid, 0); eq(b.status, "SENT"); eq(b.payments.length, 0);
      const t = await txRow(c2.id);
      eq(t.matchedInvoiceId, null); eq(t.matchedAmount, null);
    });

    section("Money that never touches the account");
    await test("cash and other-bank payments count on their date", async () => {
      const i = await invoice(9000);
      eq((await pay(i.id, { amount: 4000, method: "cash" })).status, 201);
      eq((await pay(i.id, { amount: 5000, method: "transfer" })).status, 201);
      eq((await books()).sales.lines.invoicePayments.gross, 50000 + 9000);
    });
    await test("bad method / bad date are refused", async () => {
      const i = await invoice(100);
      eq((await pay(i.id, { amount: 10, method: "crypto" })).body.code, "BAD_METHOD");
      eq((await pay(i.id, { amount: 10, method: "cash", date: "not-a-date" })).body.code, "BAD_DATE");
    });

    section("Refund from the KashBook account");
    const cn = (await call("POST", "/invoices", T, {
      businessId: biz.id, customerId: cust.id, issueDate: today, type: "credit_note", status: "SENT",
      items: [{ name: "Return", quantity: 1, rate: 10000 }],
    })).body;
    await test("the refund must equal the transfer", async () => {
      const d = await debit(9000);
      const r = await call("POST", `/invoices/${cn.id}/refund`, T, { amount: 10000, method: "bank", transactionId: d.id });
      eq(r.status, 400); eq(r.body.code, "AMOUNT_MISMATCH");
    });
    const d1 = await debit(10000);
    const before = (await books()).sales.total;
    await test("linked refund: debit marked customer_refund, not an expense", async () => {
      const r = await call("POST", `/invoices/${cn.id}/refund`, T, { amount: 10000, method: "bank", transactionId: d1.id });
      eq(r.status, 201, JSON.stringify(r.body));
      eq((await txRow(d1.id)).purpose, "customer_refund");
      const b = await books();
      eq(b.sales.total, before - 10000, "sales");
      eq(b.expenses.lines.bank.gross, 9000, "only the unlinked 9,000 debit is an expense");
    });
    await test("that debit can't be recorded as an expense too", async () => {
      const r = await call("POST", `/transactions/${d1.id}/create-expense`, T, {});
      eq(r.status, 409);
    });
    await test("undo the refund: debit freed, credit note open again", async () => {
      const c = await inv(cn.id);
      const r = await call("DELETE", `/invoices/${cn.id}/payments/${c.payments[0].id}`, T);
      eq(r.status, 200, JSON.stringify(r.body)); eq(r.body.status, "SENT");
      eq((await txRow(d1.id)).purpose, null);
    });

    section("Write-off");
    const iW = await invoice(8000);
    await pay(iW.id, { amount: 3000, method: "cash" });
    await test("writes off what is left", async () => {
      const r = await call("POST", `/invoices/${iW.id}/write-off`, T);
      eq(r.status, 200, JSON.stringify(r.body)); eq(r.body.writtenOffAmount, 5000);
    });
    await test("no payments, edits or credit on it now", async () => {
      eq((await pay(iW.id, { amount: 100, method: "cash" })).body.code, "WRITTEN_OFF");
      const e = await call("PUT", `/invoices/${iW.id}`, T, { items: [{ name: "x", quantity: 1, rate: 8000 }] });
      eq(e.body.code, "WRITTEN_OFF");
    });
    await test("not owed to you; bad debt in the when-sold view", async () => {
      const r = await receivablesFor(biz.id);
      const open = await prisma.invoice.findMany({ where: { businessId: biz.id, type: "invoice", status: { in: ["SENT", "PARTIAL", "OVERDUE"] }, writtenOffAt: null } });
      eq(r.invoicesOwed, Math.round(open.reduce((s, i) => s + i.total - i.amountPaid, 0) * 100) / 100);
      eq((await books("sold")).expenses.lines.badDebts.gross, 5000);
      eq((await books()).expenses.lines.badDebts.gross, 0);
    });
    await test("undo the write-off", async () => {
      const r = await call("DELETE", `/invoices/${iW.id}/write-off`, T);
      eq(r.body.writtenOffAt, null);
    });

    section("Void and delete");
    await test("an invoice with payments is neither voided nor deleted", async () => {
      eq((await call("PATCH", `/invoices/${iW.id}/status`, T, { status: "VOID" })).body.code, "PAYMENTS_RECORDED");
      eq((await call("DELETE", `/invoices/${iW.id}`, T)).body.code, "PAYMENTS_RECORDED");
    });
    await test("an unpaid one still can be", async () => {
      const i = await invoice(500);
      eq((await call("PATCH", `/invoices/${i.id}/status`, T, { status: "VOID" })).body.status, "VOID");
    });
    await test("VAT: an issued invoice from a closed period can't be voided", async () => {
      const i = await invoice(1000, { issueDate: "2026-01-15" }, vatBiz);
      const r = await call("PATCH", `/invoices/${i.id}/status`, T, { status: "VOID" });
      eq(r.status, 409); eq(r.body.code, "VAT_PERIOD_CLOSED");
    });
    await test("VAT: this month's can; an issued one is never deleted", async () => {
      const i = await invoice(1000, {}, vatBiz);
      eq((await call("DELETE", `/invoices/${i.id}`, T)).body.code, "VAT_ISSUED_LOCKED");
      eq((await call("PATCH", `/invoices/${i.id}/status`, T, { status: "VOID" })).body.status, "VOID");
    });
    await test("VAT: numbers are automatic", async () => {
      const r = await call("POST", "/invoices", T, {
        businessId: vatBiz.id, customerId: cust.id, issueDate: today, invoiceNumber: "MY-1",
        items: [{ name: "x", quantity: 1, rate: 10 }],
      });
      eq(r.status, 409); eq(r.body.code, "VAT_AUTO_NUMBERING");
      const n = await call("PATCH", "/invoices/numbering", T, { businessId: vatBiz.id, mode: "manual" });
      eq(n.body.code, "VAT_AUTO_NUMBERING");
    });
    await test("tax is charged after the discount", async () => {
      const i = await invoice(10000, { taxRate: 7.5, discountType: "fixed", discountValue: 1000 });
      eq(i.taxAmount, 675); eq(i.total, 9675);
    });
    await test("an invoice can't be cut below what was paid", async () => {
      const i = await invoice(5000);
      await pay(i.id, { amount: 4000, method: "cash" });
      const r = await call("PUT", `/invoices/${i.id}`, T, { items: [{ name: "x", quantity: 1, rate: 3000 }] });
      eq(r.body.code, "TOTAL_BELOW_PAID");
    });

    section("What was this money");
    const c3 = await credit(40000);
    await test("cash already recorded: out of sales", async () => {
      const s0 = (await books()).sales.total;
      const r = await call("POST", `/transactions/${c3.id}/classify`, T, { purpose: "cash_deposit" });
      eq(r.status, 200, JSON.stringify(r.body)); eq(r.body.transaction.purpose, "cash_deposit");
      eq((await books()).sales.total, s0 - 40000);
    });
    await test("a marked credit can't be matched or pay an invoice", async () => {
      eq((await call("POST", `/transactions/${c3.id}/create-sale`, T, {})).body.code, "MARKED_NOT_INCOME");
      const i = await invoice(40000);
      eq((await pay(i.id, { amount: 40000, method: "bank", transactionId: c3.id })).body.code, "TRANSACTION_TAKEN");
    });
    await test("unknown choices, debits and matched credits are refused", async () => {
      eq((await call("POST", `/transactions/${c3.id}/classify`, T, { purpose: "gift" })).body.code, "BAD_PURPOSE");
      eq((await call("POST", `/transactions/${d1.id}/classify`, T, { purpose: "loan" })).body.code, "NOT_INCOMING");
      eq((await call("POST", `/transactions/${c1.id}/classify`, T, { purpose: "loan" })).body.code, "ALREADY_MATCHED");
    });
    await test("a refund debit's mark can't be changed from here", async () => {
      const d = await debit(100, { purpose: "customer_refund", type: "income" });
      eq((await call("POST", `/transactions/${d.id}/classify`, T, { purpose: null })).body.code, "PURPOSE_LOCKED");
    });
    await test("supplier refund lowers expenses", async () => {
      const e0 = (await books()).expenses.total;
      await call("POST", `/transactions/${c3.id}/classify`, T, { purpose: "supplier_refund" });
      eq((await books()).expenses.total, e0 - 40000);
    });
    await test("taking the mark back", async () => {
      eq((await call("POST", `/transactions/${c3.id}/classify`, T, { purpose: null })).body.transaction.purpose, null);
    });

    section("Credit sales");
    let sale;
    await test("sold on credit to a customer opens their debt", async () => {
      const r = await call("POST", "/sales", T, { businessId: biz.id, customerId: cust2.id, amount: 20000, isCredit: true, paymentMethod: "credit", date: today });
      eq(r.status, 201, JSON.stringify(r.body));
      sale = r.body;
      eq(sale.debt.saleId, sale.id); eq(sale.debt.amount, 20000);
      eq((await prisma.customer.findUnique({ where: { id: cust2.id } })).totalOwed, 20000);
      eq((await books()).sales.lines.awaitingPayment.gross, 20000);
    });
    await test("…and counts when the customer pays", async () => {
      const s0 = (await books()).sales.total;
      const r = await call("POST", `/customers/${cust2.id}/debts/${sale.debt.id}/payment`, T, { amount: 6000 });
      eq(r.status < 300, true, JSON.stringify(r.body));
      eq((await books()).sales.total, s0 + 6000);
    });
    await test("a part-paid credit sale can't be deleted or re-priced", async () => {
      eq((await call("DELETE", `/sales/${sale.id}`, T)).body.code, "CREDIT_SALE_PAID");
      eq((await call("PATCH", `/sales/${sale.id}`, T, { amount: 1 })).body.code, "CREDIT_SALE_PAID");
    });
    await test("an unpaid one goes with its debt", async () => {
      const r = await call("POST", "/sales", T, { businessId: biz.id, customerId: cust2.id, amount: 700, isCredit: true, paymentMethod: "credit", date: today });
      const del = await call("DELETE", `/sales/${r.body.id}`, T);
      eq(del.status, 200); eq(del.body.debtId, r.body.debt.id);
      eq(await prisma.debt.count({ where: { id: r.body.debt.id } }), 0);
    });

    section("Auto-matcher");
    await test("an exact credit settles the invoice and is linked", async () => {
      const i = await invoice(12345);
      const c = await credit(12345);
      await tryMatchInvoice(biz, 12345, "ref-auto", { transactionId: c.id });
      const after = await inv(i.id);
      eq(after.status, "PAID"); eq(after.payments[0].transactionId, c.id);
      eq((await txRow(c.id)).matchedInvoiceId, i.id);
    });
    await test("a credit already marked is left alone", async () => {
      const i = await invoice(777);
      const c = await credit(777, { purpose: "owner_money" });
      await tryMatchInvoice(biz, 777, "ref-auto2", { transactionId: c.id });
      eq((await inv(i.id)).status, "SENT");
    });

    section("Race");
    await test("one credit, two invoices at once: it pays only one", async () => {
      const c = await credit(30000);
      const [x, y] = [await invoice(30000), await invoice(30000)];
      const rs = await Promise.all([
        pay(x.id, { amount: 30000, method: "bank", transactionId: c.id }),
        pay(y.id, { amount: 30000, method: "bank", transactionId: c.id }),
      ]);
      eq(rs.filter((r) => r.status === 201).length, 1, "successes");
      eq((await txRow(c.id)).matchedAmount, 30000);
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
