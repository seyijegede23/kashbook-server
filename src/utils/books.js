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
//   - a NUBAN credit linked to nothing (counted as sales until explained as
//     something else; one explained as income has a line of its own);
//   minus refunds to customers (contra-sales, never an expense).
// "When sold" counts documents instead: recorded sales, issued invoices, minus
// credit notes, plus credit given on the customer screen; bank credits linked
// to nothing sit outside sales as "not yet explained"; write-offs are bad debt.
// Bills (release 2) are what the business owes its suppliers: a bill on
// spending counts when paid as each payment is made (a payment from the
// KashBook account carries its debit, which then stops counting) and when sold
// on its bill date; a bill for a loan never counts. Published manual journals
// count their lines on income and spending accounts, in both views.

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

// A debit is matched when it records an expense, or pays a bill (release 2:
// the bill's payment then carries the matchedAmount, and what is left of the
// debit counts as it did before).
function isDebitMatched(tx) {
  return !!(tx.matchedExpenseId || tx.matchedBillId);
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

// ── Bills and manual journals (release 2) ───────────────────────────────────

// Naira as whole kobo, so a journal balances exactly or not at all.
function koboOf(v) {
  return Math.round(num(v) * 100);
}

// What a bill is in the books: its amount less what was paid on it outside
// the books. Only a payable from before bills (estimated) has such a payment:
// what was paid on it then counts nowhere, because nobody knows when it was
// paid, and it only lowers what is owed. The rule reads the payments
// themselves, so the bill and what it still owes always agree. Never below zero.
function billBooksAmount(bill) {
  let outside = 0;
  for (const p of (bill && bill.payments) || []) if (p && p.outsideBooks) outside += num(p.amount);
  return Math.max(0, round2(num(bill && bill.amount) - outside));
}

// A bill is spending when its account is (or it names none this input knows,
// as a record with no account always counts); a bill for a loan or another
// liability, or anything else on the balance sheet, never touches profit.
function billIsSpending(bill, accounts) {
  const acc = accountOf(accounts, bill && bill.accountId);
  return !acc || acc.cls === "expense";
}

// A manual journal the books take: published, debits equal to credits to the
// kobo, every line on an account this input knows. Any other (a draft, or one
// the route would never have saved) counts nowhere and posts nothing.
function journalInBooks(journal, accounts) {
  if (!journal || lower(journal.status) !== "published") return false;
  const lines = journal.lines || [];
  if (!lines.length) return false;
  let debit = 0;
  let credit = 0;
  for (const line of lines) {
    if (!accountOf(accounts, line && line.accountId)) return false;
    debit += koboOf(line.debit);
    credit += koboOf(line.credit);
  }
  return debit === credit;
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

// The lines each view adds up; the others are information beside a total.
// Release 2: bills (their payments when paid, the bill on its date when sold)
// and published manual journals (both views).
const COUNTED_LINES = {
  paid: {
    sales: ["recorded", "invoicePayments", "debtPayments", "bank", "bankIncome", "refunds", "journals"],
    expenses: ["recorded", "bank", "supplierRefunds", "bankCharges", "bills", "journals"],
  },
  sold: {
    sales: ["recorded", "invoiced", "creditNotes", "creditGiven", "bankIncome", "journals"],
    expenses: ["recorded", "bank", "supplierRefunds", "badDebts", "bankCharges", "bills", "journals"],
  },
};

// The class ("asset", "liability", "equity", "income", "expense") and type of
// a record's own account, from input.accounts ({ [id]: { cls, type } }, built
// by the loaders from the chart). null when the record names no account, or
// one this input does not know: such a record counts as it always has.
function accountOf(accounts, id) {
  if (!id || !accounts) return null;
  return accounts[id] || null;
}

function isBalanceSheetClass(cls) {
  return cls === "asset" || cls === "liability" || cls === "equity";
}

// input: {
//   sales:    [{ amount, date, isCredit, id }]          recorded sales
//   expenses: [{ amount, date }]                         recorded expenses
//   bankRows: [{ type, amount, date, purpose, matched*, matchedAmount }]
//   invoices: [{ id, type, status, issueDate, total, taxAmount, amountPaid,
//                writtenOffAt, writtenOffAmount, payments: [{ amount, method,
//                date, transactionId }] }]
//   debts:    [{ amount, paidAmount, paid, date, saleId, payments: [{ amount, date }] }]
//   accounts: { [accountId]: { cls, type } }   the chart, for records that name an account
// }
// Since the chart of accounts (2026-10-11), records may also carry:
//   accountId        the account the merchant picked (expenses, bank rows)
//   fee              a bank debit's transfer fee: a bank charge, in both views
//   foreignCurrency  set by the loaders on rows not in the business's currency:
//                    left out of the naira books entirely
// Since Zoho-style expenses (2026-10-12), an expense may carry its lines:
//   expenses[].items: [{ id, accountId, category, amount }]
//                    an itemized expense (its amount is their sum): it counts
//                    line by line on the expense's date, each line by its own
//                    account; an empty list is a whole expense
// Since bills and manual journals (release 2, 2026-10-13):
//   bills:    [{ id, accountId, billDate, amount, estimated, payments: [{ id,
//                amount, date, method, transactionId, outsideBooks }] }]
//             what the business owes a supplier (or a lender). A bill on
//             spending counts when paid as each payment is made, and when sold
//             on its bill date (less anything paid outside the books); a bill
//             on the balance sheet (a loan) never counts. A payment kept
//             outside the books counts nowhere. The server's loader also
//             passes vendorName, billNumber, note, receivedViaAccountId and
//             each payment's paidThroughAccountId and note, for the ledger.
//   journals: [{ id, date, status, lines: [{ accountId, debit, credit }] }]
//             manual journals: a published one's lines on income accounts
//             count as sales (credit less debit) and on spending accounts as
//             expenses (debit less credit), in both views, on its date; lines
//             on the balance sheet count nowhere (journalInBooks)
//   bankRows[].matchedBillId: the bill a debit paid (isDebitMatched)
// opts: { from, to ("YYYY-MM-DD", inclusive, either may be empty),
//         basis: "paid" | "sold", vat: { enabled, rate, inclusive } }
//
// One event per amount a line adds, in the order the lines add them:
// { side: "sales" | "expenses", line, gross, vat, day, src }. computeBooks
// folds the events into its lines, and the ledger (server/src/utils/ledger.js)
// turns the same events into its profit-and-loss entries, so a total and the
// accounts behind it can never disagree. `src` names the record carrying the
// amount ({ kind, rec, pay, doc, debt, item, bill, line }; item: the line of
// an itemized expense; bill: the bill a payment is towards; line: the line of
// a journal) so the ledger can find its accounts.
function bookEvents(input, opts) {
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
  const bills = (input && input.bills) || [];
  const journals = (input && input.journals) || [];
  // allDates: every record whatever its date (bookRows), else the period.
  const inPeriod = (d) => (o.allDates ? true : inRange(d, from, to));

  // A credit sale counts when it is paid only when a debt tracks its payment.
  const salesWithDebt = new Set(debts.filter((d) => d.saleId).map((d) => d.saleId));

  const accounts = input && input.accounts;

  const events = [];
  const add = (side, line, gross, vatPart, day, src) => {
    events.push({ side, line, gross: num(gross), vat: num(vatPart), day: dayKey(day), src });
  };

  for (const s of sales) {
    if (s.foreignCurrency || !inPeriod(s.date)) continue;
    const a = num(s.amount);
    const src = { kind: "sale", rec: s };
    if (basis === "paid" && s.isCredit && salesWithDebt.has(s.id)) {
      add("sales", "awaitingPayment", a, 0, s.date, src);
      continue;
    }
    if (basis === "paid" && s.isCredit) add("sales", "creditUnlinked", a, 0, s.date, src);
    add("sales", "recorded", a, vatInside(a, vat), s.date, src);
  }

  for (const e of expenses) {
    if (e.foreignCurrency || !inPeriod(e.date)) continue;
    // An itemized expense counts line by line, every line on the expense's
    // date, by the same rule as a whole one: a line on something the business
    // now owns or owes counts nowhere, the rest is spending.
    if (Array.isArray(e.items) && e.items.length) {
      for (const line of e.items) {
        const lineAcc = accountOf(accounts, line.accountId);
        if (lineAcc && lineAcc.cls !== "expense") continue;
        add("expenses", "recorded", num(line.amount), 0, e.date, { kind: "expense", rec: e, item: line });
      }
      continue;
    }
    // Spent on something the business now owns or owes (equipment, rent paid
    // ahead, a loan repaid, the owner's drawings): it moves to that account on
    // the balance sheet and is not an expense, as in Zoho.
    const acc = accountOf(accounts, e.accountId);
    if (acc && acc.cls !== "expense") continue;
    add("expenses", "recorded", num(e.amount), 0, e.date, { kind: "expense", rec: e });
  }

  for (const tx of bankRows) {
    if (tx.foreignCurrency || !inPeriod(tx.date)) continue;
    const isIn = lower(tx.type) === "income";
    const src = { kind: "bank", rec: tx };
    // A transfer's fee left the account too: a bank charge, whatever the
    // transfer itself was (a sale's refund, a supplier, the owner's own).
    if (!isIn && num(tx.fee) > 0) {
      add("expenses", "bankCharges", num(tx.fee), 0, tx.date, { kind: "fee", rec: tx });
    }
    if (!isIn && tx.purpose === PURPOSES.SAVINGS_FEE) {
      add("expenses", "bankCharges", num(tx.amount), 0, tx.date, src);
      continue;
    }
    // The account the merchant explained the row with decides what it is.
    const acc = accountOf(accounts, tx.accountId);
    if (isIn && (tx.purpose === PURPOSES.SUPPLIER_REFUND || (acc && acc.cls === "expense"))) {
      add("expenses", "supplierRefunds", -num(tx.amount), 0, tx.date, src);
      continue;
    }
    // Explained as something on the balance sheet (the owner's money, a loan,
    // equipment, drawings): not trade, counted nowhere.
    if (acc && acc.cls !== (isIn ? "income" : "expense")) continue;
    const a = bankCountedAmount(tx);
    if (!(a > 0)) continue;
    if (isIn) {
      // Interest and other non-trade income carry no VAT.
      const v = acc && acc.type === "other_income" ? 0 : vatInsideReceived(a, vat);
      // A credit the merchant called income has its own line in both views.
      // One nothing explains counts as sales when paid ("bank") and waits
      // outside sales when sold ("unexplained").
      if (acc) add("sales", "bankIncome", a, v, tx.date, src);
      else if (basis === "paid") add("sales", "bank", a, v, tx.date, src);
      else add("sales", "unexplained", a, 0, tx.date, src);
    } else {
      add("expenses", "bank", a, 0, tx.date, src);
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
        if (!inPeriod(p.date)) continue;
        const signed = paymentSalesAmount(p);
        if (!signed) continue;
        const v = vatShareOfDocument(Math.abs(signed), inv) * Math.sign(signed);
        const src = { kind: "invoicePayment", rec: p, doc: inv };
        if (signed < 0) add("sales", "refunds", signed, v, p.date, src);
        else add("sales", "invoicePayments", signed, v, p.date, src);
      }
      continue;
    }
    if (ISSUED_EXCLUDED.includes(status)) continue;
    if (inPeriod(inv.issueDate)) {
      const src = { kind: "document", rec: inv, doc: inv };
      if (type === "credit_note") add("sales", "creditNotes", -num(inv.total), -num(inv.taxAmount), inv.issueDate, src);
      else add("sales", "invoiced", num(inv.total), num(inv.taxAmount), inv.issueDate, src);
    }
    if (type === "invoice" && inv.writtenOffAt && inPeriod(inv.writtenOffAt)) {
      // The whole unpaid balance is lost, VAT included: Nigeria gives no VAT
      // relief on bad debts, so the VAT is still owed although never received.
      const w = num(inv.writtenOffAmount);
      if (w > 0) add("expenses", "badDebts", w, 0, inv.writtenOffAt, { kind: "writeOff", rec: inv, doc: inv });
    }
  }

  for (const d of debts) {
    if (basis === "paid") {
      for (const p of d.payments || []) {
        if (!inPeriod(p.date)) continue;
        // A repayment settles a debt recorded like a sale (net when VAT is
        // added on top), so its VAT follows the recording mode, as the sale's
        // would have if it had been paid on the spot.
        const a = num(p.amount);
        add("sales", "debtPayments", a, vatInside(a, vat), p.date, { kind: "debtPayment", rec: p, debt: d });
      }
    } else if (!d.saleId && inPeriod(d.date)) {
      const a = num(d.amount);
      add("sales", "creditGiven", a, vatInside(a, vat), d.date, { kind: "debt", rec: d, debt: d });
    }
  }

  // Bills: spending when paid as each payment is made (a payment linked to a
  // KashBook debit counts here and its debit stops counting, isDebitMatched),
  // and when sold on the bill date, less what was paid outside the books.
  for (const bill of bills) {
    if (!billIsSpending(bill, accounts)) continue;
    if (basis === "paid") {
      for (const p of bill.payments || []) {
        if (!p || p.outsideBooks || !inPeriod(p.date)) continue;
        add("expenses", "bills", num(p.amount), 0, p.date, { kind: "billPayment", rec: p, bill });
      }
    } else if (inPeriod(bill.billDate)) {
      const a = billBooksAmount(bill);
      if (a > 0) add("expenses", "bills", a, 0, bill.billDate, { kind: "bill", rec: bill, bill });
    }
  }

  // Manual journals, in both views on their date: what a line moves into or
  // out of an income account is sales, into or out of a spending account is
  // spending (either may be below zero); the balance sheet counts nowhere.
  for (const j of journals) {
    if (!inPeriod(j.date) || !journalInBooks(j, accounts)) continue;
    for (const line of j.lines) {
      const k = koboOf(line.debit) - koboOf(line.credit); // above zero: a debit
      if (!k) continue;
      const cls = accountOf(accounts, line.accountId).cls;
      const src = { kind: "journal", rec: j, line };
      if (cls === "income") add("sales", "journals", -k / 100, 0, j.date, src);
      else if (cls === "expense") add("expenses", "journals", k / 100, 0, j.date, src);
    }
  }

  return { basis, vat, from, to, events };
}

function computeBooks(input, opts) {
  const { basis, vat, from, to, events } = bookEvents(input, opts);

  const L = {
    recorded: emptyLines(), // recorded sales (paid view: not those awaiting a debt)
    invoicePayments: emptyLines(),
    debtPayments: emptyLines(),
    bank: emptyLines(), // paid view: NUBAN credits (or what a match left) nothing explains
    refunds: emptyLines(), // negative
    invoiced: emptyLines(), // sold view
    creditNotes: emptyLines(), // sold view, negative
    creditGiven: emptyLines(), // sold view: debts with no sale row
    unexplained: emptyLines(), // sold view: credits linked to nothing
    bankIncome: emptyLines(), // both views: credits the merchant called income
    awaitingPayment: emptyLines(), // paid view: credit sales not yet paid (info)
    // Paid view, info: credit sales with no debt tracking them (recorded
    // before the rule, or with no customer). They still count on the sale
    // date, inside "recorded"; this line says how much of it that is.
    creditUnlinked: emptyLines(),
    journals: emptyLines(), // both views: manual journals on income accounts (may be negative)
  };
  const E = {
    recorded: emptyLines(),
    bank: emptyLines(),
    supplierRefunds: emptyLines(), // negative
    badDebts: emptyLines(), // sold view
    bankCharges: emptyLines(), // transfer fees (and a savings break fee)
    bills: emptyLines(), // paid view: payments towards bills; sold view: bills on their date
    journals: emptyLines(), // both views: manual journals on spending accounts (may be negative)
  };

  for (const ev of events) addTo((ev.side === "sales" ? L : E)[ev.line], ev.gross, ev.vat);

  let gross = 0;
  let vatTotal = 0;
  for (const k of COUNTED_LINES[basis].sales) {
    gross += L[k].gross;
    vatTotal += L[k].vat;
  }
  gross = round2(gross);
  vatTotal = round2(vatTotal);
  const salesTotal = round2(vat.enabled ? gross - vatTotal : gross);

  let expensesTotal = 0;
  for (const k of COUNTED_LINES[basis].expenses) expensesTotal += E[k].gross;
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
// recorded sales on their date, credit notes reduce their own month. Sales and
// expenses in another currency are left out, as the books rule leaves them out.
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
    if (s.foreignCurrency || !inRange(s.date, from, to)) continue;
    salesVat += vatOf(s.amount);
    salesCount += 1;
  }
  // Credit given on the customer screen is a supply on the day it was given.
  for (const d of (input && input.debts) || []) {
    if (d.saleId || !inRange(d.date, from, to)) continue;
    salesVat += vatOf(d.amount);
    salesCount += 1;
  }
  // Input VAT, an estimate: the VAT inside what the books rule counts as
  // spending, plus equipment bought (the Nigeria Tax Act 2025, s.156(5), lets a
  // business claim the VAT on fixed assets used for taxable supplies). Never a
  // VAT payment, a loan repaid, drawings or an advance: none of them is a
  // purchase. An itemized expense counts line by line, each line by its own
  // account, as the rule counts it; a record with no account, or one this input
  // does not know, counts whole.
  const accounts = input && input.accounts;
  const claimable = (acc) => !acc || acc.cls === "expense" || acc.type === "fixed_asset";
  let inputVat = 0;
  for (const e of expenses) {
    if (e.foreignCurrency || !inRange(e.date, from, to)) continue;
    let bought = 0;
    if (Array.isArray(e.items) && e.items.length) {
      for (const line of e.items) if (claimable(accountOf(accounts, line.accountId))) bought += num(line.amount);
    } else if (claimable(accountOf(accounts, e.accountId))) {
      bought = num(e.amount);
    }
    inputVat += vat.enabled && vat.rate > 0 ? (bought * vat.rate) / (100 + vat.rate) : 0;
  }
  // A bill is a purchase on its bill date (the supplier's invoice is the tax
  // point), like an expense on its date: the part of it the books carry (a
  // payable from before bills, less what was paid outside the books), by the
  // same accounts. Never a loan or another liability: borrowing buys nothing.
  for (const b of (input && input.bills) || []) {
    if (!inRange(b.billDate, from, to) || !claimable(accountOf(accounts, b.accountId))) continue;
    const bought = billBooksAmount(b);
    inputVat += vat.enabled && vat.rate > 0 ? (bought * vat.rate) / (100 + vat.rate) : 0;
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

// The name a bill goes by on a row or a ledger entry: its supplier's, else its
// number, else its note.
function billLabel(bill) {
  return (bill && (bill.vendorName || bill.name || bill.billNumber || bill.note)) || "";
}

// One row per counted amount, under either view: summing the income rows gives
// computeBooks' gross sales and the expense rows its expenses, so charts and
// breakdowns (by day, channel, customer, category) agree with the totals.
// Rows keep the source record's fields (description, channel, customerId,
// recordedByName...) where it has them. Built from the same events as the
// totals, every date included. A counted line of an itemized expense is a row
// of its own (id "<expense>:<line>", expenseId, itemId), with the line's
// account and category. Release 2: a payment towards a bill ("bp_<payment>",
// source "bill_payment", when paid), a bill on its date ("bill_<bill>",
// source "bill", when sold) and a counted line of a manual journal
// ("mj_<line>", source "journal", journalId) each carry the account they count
// in (accountId; a bill's may be null, which reads as Other Expenses).
function bookRows(input, basis) {
  const view = basis === "sold" ? "sold" : "paid";
  const counted = COUNTED_LINES[view];
  const rows = [];
  for (const ev of bookEvents(input, { basis: view, allDates: true }).events) {
    if (!(ev.side === "sales" ? counted.sales : counted.expenses).includes(ev.line)) continue;
    const { kind, rec, doc, debt, item, bill, line } = ev.src;
    const type = ev.side === "sales" ? "income" : "expense";
    if (kind === "expense" && item) {
      rows.push(Object.assign({}, rec, {
        type, amount: ev.gross, date: ev.day, id: `${rec.id}:${item.id}`, expenseId: rec.id, itemId: item.id,
        accountId: item.accountId, category: item.category || rec.category,
      }));
    } else if (kind === "sale" || kind === "expense") {
      rows.push(Object.assign({}, rec, { type, amount: ev.gross, date: ev.day }));
    } else if (kind === "bank") {
      const label =
        ev.line === "supplierRefunds" ? "supplier_refund" : ev.line === "bankCharges" ? "bank_charges" : null;
      rows.push(
        Object.assign({}, rec, label
          ? { type, amount: ev.gross, category: label, date: ev.day }
          : { type, amount: ev.gross, date: ev.day }),
      );
    } else if (kind === "fee") {
      rows.push({
        id: `fee_${rec.id}`, type, amount: ev.gross, date: ev.day,
        description: rec.description || "", category: "bank_charges", source: "fee",
      });
    } else if (kind === "invoicePayment") {
      rows.push({
        id: `ip_${rec.id}`, type, amount: ev.gross, date: ev.day,
        description: doc.invoiceNumber, customerId: doc.customerId || null,
        channel: "invoice", source: "invoice_payment",
      });
    } else if (kind === "document") {
      rows.push({
        id: `doc_${rec.id}`, type, amount: ev.gross,
        date: ev.day, description: rec.invoiceNumber,
        customerId: rec.customerId || null, channel: "invoice", source: "invoice",
      });
    } else if (kind === "writeOff") {
      rows.push({
        id: `bad_${rec.id}`, type, amount: ev.gross,
        date: ev.day, description: rec.invoiceNumber, category: "bad_debt", source: "write_off",
      });
    } else if (kind === "debtPayment") {
      rows.push({
        id: `dp_${rec.id}`, type, amount: ev.gross, date: ev.day,
        customerId: debt.customerId || null, channel: "credit_repaid", source: "debt_payment",
      });
    } else if (kind === "debt") {
      rows.push({
        id: `debt_${rec.id}`, type, amount: ev.gross, date: ev.day,
        description: rec.note, customerId: rec.customerId || null, source: "debt",
      });
    } else if (kind === "billPayment") {
      rows.push({
        id: `bp_${rec.id}`, type, amount: ev.gross, date: ev.day,
        description: billLabel(bill), accountId: bill.accountId || null, billId: bill.id, paymentId: rec.id,
        paymentMethod: rec.method || null, source: "bill_payment",
      });
    } else if (kind === "bill") {
      rows.push({
        id: `bill_${rec.id}`, type, amount: ev.gross, date: ev.day,
        description: billLabel(rec), accountId: rec.accountId || null, billId: rec.id, source: "bill",
      });
    } else if (kind === "journal") {
      rows.push({
        id: `mj_${line.id || `${rec.id}_${rec.lines.indexOf(line)}`}`, type, amount: ev.gross, date: ev.day,
        description: line.description || rec.note || rec.number || "", accountId: line.accountId,
        journalId: rec.id, source: "journal",
      });
    }
  }
  return rows;
}

// A credit linked to nothing and not explained some other way, by a purpose
// or by an account: what the "Unmatched" filter and the review queue show. A
// credit explained with an income account keeps no purpose (the categorize
// route), so its account alone says what it was.
function isUnexplainedCredit(tx) {
  return lower(tx.type) === "income" && !tx.purpose && !tx.accountId && !isCreditMatched(tx);
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
  billBooksAmount,
  billIsSpending,
  journalInBooks,
  billLabel,
  COUNTED_LINES,
  bookEvents,
  computeBooks,
  bookRows,
  receivables,
  vatDeadline,
  vatReturn,
};
