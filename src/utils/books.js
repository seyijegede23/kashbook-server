// The books rule: what counts as sales, expenses and profit, and when.
//
// ONE implementation, mirrored verbatim in the app (src/utils/books.js; the
// parity test in scripts/books-test.js compares everything above the export
// block). Server reports, Insights, the daily and monthly emails and every app
// screen total through computeBooks, so a figure never depends on the screen.
//
// Research basis (2026-10-08 report, "Invoices and credit notes in reports"):
// "when paid" is the default view and counts money when it arrives. Every naira
// has exactly one record that carries it:
//   - a recorded sale (Sales row) paid on the spot;
//   - an invoice payment: cash, card, cheque, another bank, or a NUBAN credit
//     linked to it (the credit then stops counting, its remainder still does);
//   - a debt repayment (credit sales count when the customer pays);
//   - a NUBAN credit linked to nothing (counted as sales until explained);
//   minus refunds to customers (contra-sales, never an expense).
// "When sold" counts documents instead: recorded sales, issued invoices, minus
// credit notes, plus credit given on the customer screen; bank credits linked
// to nothing sit outside sales as "not yet explained"; write-offs are bad debt.

const MONEY_IN_METHODS = ["cash", "card", "cheque", "transfer", "pos", "other"];
// Paid into the business's own KashBook account: the payment must link the
// NUBAN credit (transactionId). Older rows without the link count nothing,
// because the unlinked credit already counts.
const BANK_METHOD = "bank";
const SETTLEMENT_METHODS = ["credit_note", "credit_applied"];
const REFUND_PREFIX = "refund_";
const REFUND_BANK_METHOD = "refund_bank";

const PURPOSES = {
  SAVINGS_FEE: "savings_fee",
  CUSTOMER_REFUND: "customer_refund",
  CASH_DEPOSIT: "cash_deposit",
  OWN_TRANSFER: "own_transfer",
  OWNER_MONEY: "owner_money",
  LOAN: "loan",
  SUPPLIER_REFUND: "supplier_refund",
};
// What a merchant can say an incoming transfer was, when it was not a sale.
const CREDIT_OUTCOMES = ["cash_deposit", "own_transfer", "owner_money", "loan", "supplier_refund"];

const OPEN_INVOICE_STATUSES = ["sent", "partial", "overdue"];
const ISSUED_EXCLUDED = ["draft", "void"];

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function round2(n) {
  return Math.round((num(n) + Number.EPSILON) * 100) / 100;
}

function lower(v) {
  return String(v == null ? "" : v).toLowerCase();
}

// "YYYY-MM-DD" for a day. Strings are taken as they are (the app keeps dates
// as ISO text); Date objects are read in Lagos time (UTC+1, no DST).
function dayKey(d) {
  if (d == null || d === "") return "";
  if (typeof d === "string") return d.slice(0, 10);
  const t = d instanceof Date ? d.getTime() : new Date(d).getTime();
  if (!Number.isFinite(t)) return "";
  return new Date(t + 60 * 60 * 1000).toISOString().slice(0, 10);
}

function inRange(d, from, to) {
  const k = dayKey(d);
  if (!k) return false;
  if (from && k < from) return false;
  if (to && k > to) return false;
  return true;
}

// ── Invoice payments ────────────────────────────────────────────────────────

// "in" (money received off the KashBook account), "bank" (a linked NUBAN
// credit), "presumed_bank" (a bank payment with no link: the credit counts),
// "settlement" (credit-note value, not money) or "refund" (money given back).
function paymentKind(p) {
  const m = lower(p && p.method) || "cash";
  if (SETTLEMENT_METHODS.includes(m)) return "settlement";
  if (m.startsWith(REFUND_PREFIX)) return "refund";
  if (m === BANK_METHOD) return p.transactionId ? "bank" : "presumed_bank";
  return "in";
}

// Signed amount a payment adds to "when paid" sales.
function paymentSalesAmount(p) {
  const kind = paymentKind(p);
  const a = num(p.amount);
  if (kind === "in" || kind === "bank") return a;
  if (kind === "refund") return -a;
  return 0;
}

// ── Bank rows (the NUBAN ledger) ────────────────────────────────────────────

function isCreditMatched(tx) {
  return !!(tx.matchedSaleId || tx.matchedCustomerId || tx.matchedInvoiceId);
}

function isDebitMatched(tx) {
  return !!tx.matchedExpenseId;
}

function isMatchedBankRow(tx) {
  return lower(tx.type) === "income" ? isCreditMatched(tx) : isDebitMatched(tx);
}

// The part of a matched row its match did not account for. NULL matchedAmount
// on an old match means fully matched.
function matchedRemainder(tx) {
  if (tx.matchedAmount == null) return 0;
  return Math.max(0, round2(num(tx.amount) - num(tx.matchedAmount)));
}

// What a bank row adds to sales (credits) or expenses (debits) on its own.
// Rows with a purpose are not trade and count nothing here.
function bankCountedAmount(tx) {
  if (tx.purpose) return 0;
  if (isMatchedBankRow(tx)) return matchedRemainder(tx);
  return num(tx.amount);
}

// ── VAT ─────────────────────────────────────────────────────────────────────

function vatSettings(v) {
  const enabled = !!(v && v.enabled);
  const rate = enabled ? (v.rate == null || v.rate === "" ? 7.5 : num(v.rate)) : 0;
  return { enabled, rate, inclusive: !(v && v.inclusive === false) };
}

// VAT inside an amount the merchant RECORDED as a sale (a manual sale, credit
// given on the customer screen). Inclusive: amount × r / (100 + r).
// Exclusive: the recorded amount is net, so nothing is inside it.
function vatInside(amount, vat) {
  if (!vat.enabled || !(vat.rate > 0) || !vat.inclusive) return 0;
  return round2((num(amount) * vat.rate) / (100 + vat.rate));
}

// VAT inside money RECEIVED that no record explains (a bank credit):
// what a customer pays always includes the VAT, whatever the recording mode.
function vatInsideReceived(amount, vat) {
  if (!vat.enabled || !(vat.rate > 0)) return 0;
  return round2((num(amount) * vat.rate) / (100 + vat.rate));
}

// VAT inside part of an invoice: pro rata to the document's own tax.
function vatShareOfDocument(amount, doc) {
  const total = num(doc && doc.total);
  const tax = num(doc && doc.taxAmount);
  if (!(total > 0) || !(tax > 0)) return 0;
  return round2((num(amount) * tax) / total);
}

// ── The totals ──────────────────────────────────────────────────────────────

function emptyLines() {
  return { gross: 0, vat: 0, count: 0 };
}

function addTo(line, amount, vat) {
  line.gross = round2(line.gross + num(amount));
  line.vat = round2(line.vat + num(vat));
  line.count += 1;
}

// input: {
//   sales:    [{ amount, date, isCredit, id }]          recorded sales
//   expenses: [{ amount, date }]                         recorded expenses
//   bankRows: [{ type, amount, date, purpose, matched*, matchedAmount }]
//   invoices: [{ id, type, status, issueDate, total, taxAmount, amountPaid,
//                writtenOffAt, writtenOffAmount, payments: [{ amount, method,
//                date, transactionId }] }]
//   debts:    [{ amount, paidAmount, paid, date, saleId, payments: [{ amount, date }] }]
// }
// opts: { from, to ("YYYY-MM-DD", inclusive, either may be empty),
//         basis: "paid" | "sold", vat: { enabled, rate, inclusive } }
function computeBooks(input, opts) {
  const o = opts || {};
  const basis = o.basis === "sold" ? "sold" : "paid";
  const vat = vatSettings(o.vat);
  const from = o.from || "";
  const to = o.to || "";
  const sales = (input && input.sales) || [];
  const expenses = (input && input.expenses) || [];
  const bankRows = (input && input.bankRows) || [];
  const invoices = (input && input.invoices) || [];
  const debts = (input && input.debts) || [];

  // A credit sale counts when it is paid only when a debt tracks its payment.
  const salesWithDebt = new Set(debts.filter((d) => d.saleId).map((d) => d.saleId));

  const L = {
    recorded: emptyLines(), // recorded sales (paid view: not those awaiting a debt)
    invoicePayments: emptyLines(),
    debtPayments: emptyLines(),
    bank: emptyLines(), // NUBAN credits linked to nothing (paid view)
    refunds: emptyLines(), // negative
    invoiced: emptyLines(), // sold view
    creditNotes: emptyLines(), // sold view, negative
    creditGiven: emptyLines(), // sold view: debts with no sale row
    unexplained: emptyLines(), // sold view: credits linked to nothing
    awaitingPayment: emptyLines(), // paid view: credit sales not yet paid (info)
    // Paid view, info: credit sales with no debt tracking them (recorded
    // before the rule, or with no customer). They still count on the sale
    // date, inside "recorded"; this line says how much of it that is.
    creditUnlinked: emptyLines(),
  };
  const E = {
    recorded: emptyLines(),
    bank: emptyLines(),
    supplierRefunds: emptyLines(), // negative
    badDebts: emptyLines(), // sold view
  };

  for (const s of sales) {
    if (!inRange(s.date, from, to)) continue;
    const a = num(s.amount);
    if (basis === "paid" && s.isCredit && salesWithDebt.has(s.id)) {
      addTo(L.awaitingPayment, a, 0);
      continue;
    }
    if (basis === "paid" && s.isCredit) addTo(L.creditUnlinked, a, 0);
    addTo(L.recorded, a, vatInside(a, vat));
  }

  for (const e of expenses) {
    if (!inRange(e.date, from, to)) continue;
    addTo(E.recorded, num(e.amount), 0);
  }

  for (const tx of bankRows) {
    if (!inRange(tx.date, from, to)) continue;
    const isIn = lower(tx.type) === "income";
    if (isIn && tx.purpose === PURPOSES.SUPPLIER_REFUND) {
      addTo(E.supplierRefunds, -num(tx.amount), 0);
      continue;
    }
    const a = bankCountedAmount(tx);
    if (!(a > 0)) continue;
    if (isIn) {
      if (basis === "paid") addTo(L.bank, a, vatInsideReceived(a, vat));
      else addTo(L.unexplained, a, 0);
    } else {
      addTo(E.bank, a, 0);
    }
  }

  for (const inv of invoices) {
    const type = lower(inv.type) || "invoice";
    const status = lower(inv.status);
    if (type === "quote") continue;
    if (basis === "paid") {
      // A void document's payments are reversed with it. (Since the rule, a
      // document with payments cannot be voided; this covers older voids.)
      if (status === "void") continue;
      for (const p of inv.payments || []) {
        if (!inRange(p.date, from, to)) continue;
        const signed = paymentSalesAmount(p);
        if (!signed) continue;
        const v = vatShareOfDocument(Math.abs(signed), inv) * Math.sign(signed);
        if (signed < 0) addTo(L.refunds, signed, v);
        else addTo(L.invoicePayments, signed, v);
      }
      continue;
    }
    if (ISSUED_EXCLUDED.includes(status)) continue;
    if (inRange(inv.issueDate, from, to)) {
      if (type === "credit_note") addTo(L.creditNotes, -num(inv.total), -num(inv.taxAmount));
      else addTo(L.invoiced, num(inv.total), num(inv.taxAmount));
    }
    if (type === "invoice" && inv.writtenOffAt && inRange(inv.writtenOffAt, from, to)) {
      // The whole unpaid balance is lost, VAT included: Nigeria gives no VAT
      // relief on bad debts, so the VAT is still owed although never received.
      const w = num(inv.writtenOffAmount);
      if (w > 0) addTo(E.badDebts, w, 0);
    }
  }

  for (const d of debts) {
    if (basis === "paid") {
      for (const p of d.payments || []) {
        if (!inRange(p.date, from, to)) continue;
        // A repayment settles a debt recorded like a sale (net when VAT is
        // added on top), so its VAT follows the recording mode, as the sale's
        // would have if it had been paid on the spot.
        const a = num(p.amount);
        addTo(L.debtPayments, a, vatInside(a, vat));
      }
    } else if (!d.saleId && inRange(d.date, from, to)) {
      const a = num(d.amount);
      addTo(L.creditGiven, a, vatInside(a, vat));
    }
  }

  const salesLines =
    basis === "paid"
      ? ["recorded", "invoicePayments", "debtPayments", "bank", "refunds"]
      : ["recorded", "invoiced", "creditNotes", "creditGiven"];
  let gross = 0;
  let vatTotal = 0;
  for (const k of salesLines) {
    gross += L[k].gross;
    vatTotal += L[k].vat;
  }
  gross = round2(gross);
  vatTotal = round2(vatTotal);
  const salesTotal = round2(vat.enabled ? gross - vatTotal : gross);

  const expenseLines = basis === "paid" ? ["recorded", "bank", "supplierRefunds"] : ["recorded", "bank", "supplierRefunds", "badDebts"];
  let expensesTotal = 0;
  for (const k of expenseLines) expensesTotal += E[k].gross;
  expensesTotal = round2(expensesTotal);

  return {
    basis,
    from,
    to,
    vatEnabled: vat.enabled,
    sales: { lines: L, gross, vat: vatTotal, total: salesTotal },
    expenses: { lines: E, total: expensesTotal },
    profit: round2(salesTotal - expensesTotal),
  };
}

// What customers owe and what the business owes customers, right now.
function receivables(input) {
  const invoices = (input && input.invoices) || [];
  const debts = (input && input.debts) || [];
  let invoicesOwed = 0;
  let invoiceCount = 0;
  let creditOwed = 0;
  let creditCount = 0;
  for (const inv of invoices) {
    const type = lower(inv.type) || "invoice";
    const status = lower(inv.status);
    const left = round2(num(inv.total) - num(inv.amountPaid));
    if (!(left > 0)) continue;
    if (type === "invoice" && OPEN_INVOICE_STATUSES.includes(status) && !inv.writtenOffAt) {
      invoicesOwed += left;
      invoiceCount += 1;
    } else if (type === "credit_note" && ["sent", "partial"].includes(status)) {
      creditOwed += left;
      creditCount += 1;
    }
  }
  let debtsOwed = 0;
  let debtCount = 0;
  for (const d of debts) {
    if (d.paid) continue;
    const left = round2(num(d.amount) - num(d.paidAmount));
    if (left > 0) {
      debtsOwed += left;
      debtCount += 1;
    }
  }
  return {
    owedToYou: round2(invoicesOwed + debtsOwed),
    invoicesOwed: round2(invoicesOwed),
    invoiceCount,
    debtsOwed: round2(debtsOwed),
    debtCount,
    youOweCustomers: round2(creditOwed),
    creditCount,
  };
}

// The 21st of the month after `month` ("YYYY-MM"): a VAT return's deadline.
function vatDeadline(month) {
  const [y, m] = String(month).split("-").map(Number);
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return `${ny}-${String(nm).padStart(2, "0")}-21`;
}

// Output VAT for one month, dated by supply: invoices on their issue date,
// recorded sales on their date, credit notes reduce their own month.
function vatReturn(input, month, vatOpts) {
  const vat = vatSettings(vatOpts);
  const from = `${month}-01`;
  const to = `${month}-31`;
  const sales = (input && input.sales) || [];
  const invoices = (input && input.invoices) || [];
  const expenses = (input && input.expenses) || [];
  let invoicesVat = 0;
  let invoicesNet = 0;
  let invoiceCount = 0;
  let creditVat = 0;
  let creditCount = 0;
  let advanceVat = 0;
  let advanceCount = 0;
  for (const inv of invoices) {
    const type = lower(inv.type) || "invoice";
    const status = lower(inv.status);
    if (type === "quote" || ISSUED_EXCLUDED.includes(status)) continue;
    if (type === "credit_note") {
      if (!inRange(inv.issueDate, from, to)) continue;
      creditVat += num(inv.taxAmount);
      creditCount += 1;
      continue;
    }
    // The tax point is the earliest of invoice, delivery or payment: money
    // received BEFORE the invoice date carries its share of the VAT into the
    // month it arrived, and the invoice's month keeps the rest.
    const issued = dayKey(inv.issueDate);
    let early = 0;
    for (const p of inv.payments || []) {
      const kind = paymentKind(p);
      if (kind !== "in" && kind !== "bank" && kind !== "presumed_bank") continue;
      const paid = dayKey(p.date);
      if (!paid || !issued || paid >= issued) continue;
      const share = vatShareOfDocument(num(p.amount), inv);
      early += share;
      if (inRange(p.date, from, to)) {
        advanceVat += share;
        advanceCount += 1;
      }
    }
    if (!inRange(inv.issueDate, from, to)) continue;
    invoicesVat += Math.max(0, num(inv.taxAmount) - early);
    invoicesNet += num(inv.total) - num(inv.taxAmount);
    invoiceCount += 1;
  }
  invoicesVat += advanceVat;
  // A recorded amount carries VAT inside it (inclusive) or on top (exclusive).
  const vatOf = (amount) => {
    if (!vat.enabled || !(vat.rate > 0)) return 0;
    return vat.inclusive ? vatInside(amount, vat) : round2((num(amount) * vat.rate) / 100);
  };
  let salesVat = 0;
  let salesCount = 0;
  for (const s of sales) {
    if (!inRange(s.date, from, to)) continue;
    salesVat += vatOf(s.amount);
    salesCount += 1;
  }
  // Credit given on the customer screen is a supply on the day it was given.
  for (const d of (input && input.debts) || []) {
    if (d.saleId || !inRange(d.date, from, to)) continue;
    salesVat += vatOf(d.amount);
    salesCount += 1;
  }
  let inputVat = 0;
  for (const e of expenses) {
    if (!inRange(e.date, from, to)) continue;
    inputVat += vat.enabled && vat.rate > 0 ? (num(e.amount) * vat.rate) / (100 + vat.rate) : 0;
  }
  const output = round2(invoicesVat + salesVat - creditVat);
  return {
    month,
    deadline: vatDeadline(month),
    rate: vat.rate,
    invoices: { vat: round2(invoicesVat), net: round2(invoicesNet), count: invoiceCount },
    // Of which: VAT on payments received before their invoice was issued.
    advance: { vat: round2(advanceVat), count: advanceCount },
    sales: { vat: round2(salesVat), count: salesCount },
    creditNotes: { vat: round2(-creditVat), count: creditCount },
    output,
    inputEstimate: round2(inputVat),
    payable: round2(output - inputVat),
  };
}

// One row per counted amount, under either view: summing the income rows gives
// computeBooks' gross sales and the expense rows its expenses, so charts and
// breakdowns (by day, channel, customer, category) agree with the totals.
// Rows keep the source record's fields (description, channel, customerId,
// recordedByName...) where it has them.
function bookRows(input, basis) {
  const view = basis === "sold" ? "sold" : "paid";
  const rows = [];
  const day = (d) => dayKey(d);
  const debts = (input && input.debts) || [];
  const salesWithDebt = new Set(debts.filter((d) => d.saleId).map((d) => d.saleId));

  for (const s of (input && input.sales) || []) {
    if (view === "paid" && s.isCredit && salesWithDebt.has(s.id)) continue;
    rows.push(Object.assign({}, s, { type: "income", amount: num(s.amount), date: day(s.date) }));
  }
  for (const e of (input && input.expenses) || []) {
    rows.push(Object.assign({}, e, { type: "expense", amount: num(e.amount), date: day(e.date) }));
  }
  for (const tx of (input && input.bankRows) || []) {
    const isIn = lower(tx.type) === "income";
    if (isIn && tx.purpose === PURPOSES.SUPPLIER_REFUND) {
      rows.push(Object.assign({}, tx, { type: "expense", amount: -num(tx.amount), category: "supplier_refund", date: day(tx.date) }));
      continue;
    }
    if (view === "sold" && isIn) continue; // "not yet explained", outside sales
    const a = bankCountedAmount(tx);
    if (a > 0) rows.push(Object.assign({}, tx, { type: isIn ? "income" : "expense", amount: a, date: day(tx.date) }));
  }
  for (const inv of (input && input.invoices) || []) {
    const type = lower(inv.type) || "invoice";
    if (type === "quote") continue;
    const status = lower(inv.status);
    if (view === "paid") {
      if (status === "void") continue;
      for (const p of inv.payments || []) {
        const signed = paymentSalesAmount(p);
        if (!signed) continue;
        rows.push({
          id: `ip_${p.id}`, type: "income", amount: signed, date: day(p.date),
          description: inv.invoiceNumber, customerId: inv.customerId || null,
          channel: "invoice", source: "invoice_payment",
        });
      }
      continue;
    }
    if (ISSUED_EXCLUDED.includes(status)) continue;
    rows.push({
      id: `doc_${inv.id}`, type: "income",
      amount: type === "credit_note" ? -num(inv.total) : num(inv.total),
      date: day(inv.issueDate), description: inv.invoiceNumber,
      customerId: inv.customerId || null, channel: "invoice", source: "invoice",
    });
    if (type === "invoice" && inv.writtenOffAt && num(inv.writtenOffAmount) > 0) {
      rows.push({
        id: `bad_${inv.id}`, type: "expense", amount: num(inv.writtenOffAmount),
        date: day(inv.writtenOffAt), description: inv.invoiceNumber, category: "bad_debt", source: "write_off",
      });
    }
  }
  for (const d of debts) {
    if (view === "paid") {
      for (const p of d.payments || []) {
        rows.push({
          id: `dp_${p.id}`, type: "income", amount: num(p.amount), date: day(p.date),
          customerId: d.customerId || null, channel: "credit_repaid", source: "debt_payment",
        });
      }
    } else if (!d.saleId) {
      rows.push({
        id: `debt_${d.id}`, type: "income", amount: num(d.amount), date: day(d.date),
        description: d.note, customerId: d.customerId || null, source: "debt",
      });
    }
  }
  return rows;
}

// A credit linked to nothing and not marked as something else: what the
// "Unmatched" filter and the review queue show.
function isUnexplainedCredit(tx) {
  return lower(tx.type) === "income" && !tx.purpose && !isCreditMatched(tx);
}

// ── exports (everything above this line is identical in src/utils/books.js) ──
module.exports = {
  MONEY_IN_METHODS,
  BANK_METHOD,
  SETTLEMENT_METHODS,
  REFUND_PREFIX,
  REFUND_BANK_METHOD,
  PURPOSES,
  CREDIT_OUTCOMES,
  OPEN_INVOICE_STATUSES,
  dayKey,
  inRange,
  round2,
  paymentKind,
  paymentSalesAmount,
  isCreditMatched,
  isDebitMatched,
  isMatchedBankRow,
  matchedRemainder,
  bankCountedAmount,
  isUnexplainedCredit,
  vatSettings,
  vatInside,
  vatInsideReceived,
  vatShareOfDocument,
  computeBooks,
  bookRows,
  receivables,
  vatDeadline,
  vatReturn,
};
