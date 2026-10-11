// The app's phone helpers for the customer form (src/utils/phone.js), run in
// Node through Babel like books-app-test.js: country code + number in and out,
// and one key per number whatever its format (the "already a customer" check).
//   node scripts/customer-app-test.js
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const APP = path.resolve(__dirname, "../..");
const babel = require(require.resolve("@babel/core", { paths: [APP] }));
const cjs = require.resolve("@babel/plugin-transform-modules-commonjs", { paths: [APP] });

const cache = new Map();
function load(file) {
  if (cache.has(file)) return cache.get(file).exports;
  const { code } = babel.transformSync(fs.readFileSync(file, "utf8"), { filename: file, plugins: [cjs], babelrc: false, configFile: false });
  const mod = { exports: {} };
  cache.set(file, mod);
  const localRequire = (p) => (p.startsWith(".") ? load(path.resolve(path.dirname(file), p.endsWith(".js") ? p : `${p}.js`)) : require(p));
  new Function("exports", "require", "module", code)(mod.exports, localRequire, mod);
  return mod.exports;
}
const { splitPhone, joinPhone, isValidPhone, phoneKey, cleanPhone, phoneMatches } = load(path.join(APP, "src/utils/phone.js"));

let passed = 0;
let failed = 0;
const check = (name, fn) => {
  try {
    fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${name}  →  ${e.message}`);
  }
};
const deq = (a, b) => assert.deepStrictEqual(a, b, `${JSON.stringify(a)} !== ${JSON.stringify(b)}`);

console.log("\nPhone numbers on the customer form");
check("an international number splits into its code and the rest", () => {
  deq(splitPhone("+2348031234567"), { code: "234", number: "8031234567" });
  deq(splitPhone("+447700900123"), { code: "44", number: "7700900123" });
});
check("longest code wins (+1264 Anguilla, not +1)", () => deq(splitPhone("+12645551234").code, "1264"));
check("a local number reads as Nigerian and keeps its 0", () => deq(splitPhone("0803 123 4567"), { code: "234", number: "08031234567" }));
check("nothing typed gives the default code and no number", () => deq(splitPhone(""), { code: "234", number: "" }));
check("joining drops the local 0 and adds the code", () => {
  deq(joinPhone("234", "08031234567"), "+2348031234567");
  deq(joinPhone("44", "7700 900123"), "+447700900123");
  deq(joinPhone("234", ""), "");
  deq(joinPhone("234", "+447700900123"), "+447700900123");
});
check("split then join gives back an international number", () => {
  for (const n of ["+2348031234567", "+447700900123"]) {
    const { code, number } = splitPhone(n);
    deq(joinPhone(code, number), n);
  }
});
check("6 to 15 digits is a phone number", () => {
  deq(isValidPhone("+2348031234567"), true);
  deq(isValidPhone("12345"), false);
  deq(isValidPhone("+1234567890123456"), false);
});
check("one key per number, whatever the format", () => {
  const k = phoneKey("+2348031234567");
  deq(phoneKey("08031234567"), k);
  deq(phoneKey("0803 123 4567"), k);
  deq(phoneKey("2348031234567"), k);
  deq(phoneKey(""), "");
});
check("countries that keep their 0 keep it (Côte d'Ivoire, Italy, Congo)", () => {
  for (const n of ["+2250701234567", "+390612345678", "+242061234567"]) {
    const { code, number } = splitPhone(n);
    deq(joinPhone(code, number), n);
  }
  deq(joinPhone("225", "07 01 23 45 67"), "+2250701234567");
  deq(joinPhone("234", "0803 123 4567"), "+2348031234567");
});
check("numbers stored without a +: 234..., 00..., foreign ones", () => {
  deq(splitPhone("2348031234567"), { code: "234", number: "8031234567" });
  deq(joinPhone(...Object.values(splitPhone("2348031234567"))), "+2348031234567");
  deq(splitPhone("0044 7911 123456"), { code: "44", number: "7911123456" });
  deq(joinPhone("234", "447911123456"), "+447911123456");
  deq(joinPhone("234", "1-800-555-1234"), "+18005551234");
  deq(joinPhone("234", "8031234567"), "+2348031234567");
});
check("split and join agree with the duplicate key", () => {
  for (const n of ["08031234567", "2348031234567", "+2348031234567", "0044 7911 123456", "+2250701234567"]) {
    const { code, number } = splitPhone(n);
    deq(phoneKey(joinPhone(code, number)), phoneKey(n));
  }
});
check("search finds a +234 number by how people dial it", () => {
  deq(phoneMatches("+2348031234567", "0803"), true);
  deq(phoneMatches("+2348031234567", "08031234567"), true);
  deq(phoneMatches("+2348031234567", "1234"), true);
  deq(phoneMatches("08031234567", "0803"), true);
  deq(phoneMatches("+2348031234567", "0805"), false);
  deq(phoneMatches("", "0803"), false);
});
check("cleaning keeps a leading + and the digits", () => {
  deq(cleanPhone(" +234 (803) 123-4567 "), "+2348031234567");
  deq(cleanPhone("0803-123-4567"), "08031234567");
});

// ── The customer screens' numbers (src/utils/customerSummary.js) ──────────────
const CS = load(path.join(APP, "src/utils/customerSummary.js"));
const ada = {
  id: "c1", name: "Ada Stores", salutation: "Mrs.", firstName: "Ada", lastName: "Obi", totalDebt: 3000,
  createdAt: "2026-09-01T10:00:00.000Z",
  transactions: [
    { id: "d1", amount: 5000, paidAmount: 2000, date: "2026-09-10", note: "Rice on credit",
      payments: [{ id: "p1", amount: 2000, date: "2026-09-20", note: "" }] },
    // Settled before payments were recorded one by one: no payment rows.
    { id: "d2", amount: 1000, paidAmount: 1000, paid: true, date: "2026-08-01", note: "Old credit", payments: [] },
  ],
};
const docs = [
  { id: "i1", customerId: "c1", type: "invoice", status: "partial", invoiceNumber: "INV-1", issueDate: "2026-09-15",
    total: 10000, amountPaid: 6000, payments: [
      { id: "ip1", amount: 4000, method: "cash", date: "2026-09-16" },
      { id: "ip2", amount: 2000, method: "credit_note", date: "2026-09-18" },
    ] },
  { id: "i2", customerId: "c1", type: "invoice", status: "sent", invoiceNumber: "INV-2", issueDate: "2026-10-02",
    total: 1500, amountPaid: 0, writtenOffAt: "2026-10-05T09:00:00.000Z", writtenOffAmount: 1500, payments: [] },
  { id: "i3", customerId: "c1", type: "invoice", status: "draft", invoiceNumber: "INV-3", issueDate: "2026-10-03", total: 999, amountPaid: 0, payments: [] },
  { id: "n1", customerId: "c1", type: "credit_note", status: "partial", invoiceNumber: "CN-1", issueDate: "2026-09-17",
    total: 3000, amountPaid: 2000, payments: [{ id: "cp1", amount: 2000, method: "credit_applied", date: "2026-09-18" }] },
  { id: "x1", customerId: "someone-else", type: "invoice", status: "sent", invoiceNumber: "INV-9", issueDate: "2026-09-15", total: 777, amountPaid: 0, payments: [] },
];
const sales = [
  { id: "s1", customerId: "c1", source: "sale", amount: 2500, date: "2026-09-12", description: "Beans" },
  { id: "s2", customerId: "c9", source: "sale", amount: 900, date: "2026-09-12" },
];

console.log("\nCustomer screens");
check("the person to talk to, else the display name", () => {
  deq(CS.primaryName(ada), "Mrs. Ada Obi");
  deq(CS.primaryName({ name: "Bola Ventures" }), "Bola Ventures");
});
check("receivables = the credit book + open invoices (not drafts, not written off, not others')", () => {
  deq(CS.receivablesOf(ada, docs), 3000 + 4000);
});
check("credits = what is left on open credit notes", () => deq(CS.creditsOf(ada, docs), 1000));
check("payments received: repayments (one for a debt settled in one go) and money-in invoice payments", () => {
  const p = CS.paymentsOf(ada, docs);
  deq(p.map((x) => `${x.kind}:${x.amount}:${x.date}`), ["repayment:2000:2026-09-20", "invoice:4000:2026-09-16", "repayment:1000:2026-08-01"]);
});
check("the statement's closing balance is what they owe today", () => {
  const st = CS.statementOf(ada, docs, "2000-01-01", "2099-12-31");
  deq(st.opening, 0);
  deq(st.closing, CS.receivablesOf(ada, docs));
});
check("a period's opening balance carries what came before it", () => {
  const st = CS.statementOf(ada, docs, "2026-09-15", "2026-09-30");
  // Before 15 Sep: 1,000 old credit settled (0) + 5,000 rice credit = 5,000.
  deq(st.opening, 5000);
  deq(st.charged, 10000);
  deq(st.paid, 4000 + 2000 + 2000);
  deq(st.closing, 5000 + 10000 - 8000);
  deq(st.lines[0].kind, "invoice");
});
check("open items: unpaid credit and invoices with a balance", () => {
  deq(CS.outstandingOf(ada, docs).map((o) => `${o.kind}:${o.left}`), ["credit:3000", "invoice:4000"]);
});
check("activity: newest first, the customer being added in its place by date", () => {
  const a = CS.activityOf(ada, { transactions: sales, invoices: docs });
  deq(a[0].kind, "writeOff");
  const at = a.findIndex((e) => e.kind === "created");
  deq(a.slice(0, at).every((e) => e.date >= "2026-09-01"), true, "newer events first");
  deq(a.slice(at + 1).every((e) => e.date <= "2026-09-01"), true, "older ones after");
  deq(a.some((e) => e.key === "s_s2"), false, "another customer's sale");
  deq(a.filter((e) => e.kind === "invoicePayment").length, 1, "credit applied is not a payment");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
