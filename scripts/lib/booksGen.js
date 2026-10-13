// Seeded random books for the books-rule and ledger tests: every shape the
// rule handles (credit sales with and without debts, matched and partly
// matched bank rows, purposes, invoice payments of every kind, credit notes,
// write-offs, voids, quotes), and, with { chart: true }, what the chart of
// accounts added (accounts on records, fees, other currencies, payment
// methods, invoice lines, bank links, itemized expenses) and release 2 added
// (bills on spending and on liabilities, with payments, payables from before
// bills with an estimated payment outside the books, loans received into a
// money account; manual journals, published and draft, now and then one the
// books must refuse).
//
// The bank links drawn by default are one-sided ("t-sale", "x", "t-bill"):
// enough for the books rule, which reads each side on its own. With
// { links: true } they are real instead (linkRecords): each linked record and
// its bank row name each other, with amounts as the routes save them, so Bank
// Matching, where the two meet in the ledger, must come back to zero.
const chartLib = require("../../src/utils/chart");

// mulberry32: small, seeded, reproducible.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeGen(r) {
  const int = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
  const pick = (arr) => arr[int(0, arr.length - 1)];
  const chance = (p) => r() < p;
  // Naira with kobo now and then, up to ₦500,000.
  const money = () => (int(1, 50000) * 100 + (chance(0.3) ? int(0, 99) : 0)) / 100;
  const day = () => `2026-${String(int(1, 12)).padStart(2, "0")}-${String(int(1, 28)).padStart(2, "0")}`;
  // Dates arrive as day strings (the app) or Date objects (the server).
  const when = () =>
    chance(0.5) ? day() : new Date(`${day()}T${String(int(0, 23)).padStart(2, "0")}:${String(int(0, 59)).padStart(2, "0")}:00Z`);
  let n = 0;
  const id = (p) => `${p}${++n}`;
  return { int, pick, chance, money, day, when, id };
}

const MATCH_FIELDS = ["matchedSaleId", "matchedCustomerId", "matchedInvoiceId", "matchedExpenseId", "matchedBillId"];
const isMatched = (tx) => MATCH_FIELDS.some((k) => tx[k]);

// `total` kobo (≥ parts) in `parts` random pieces of at least one kobo each.
function pieces(g, total, parts) {
  const out = [];
  let left = total;
  for (let i = parts; i > 1; i--) {
    const k = g.int(1, left - (i - 1));
    out.push(k);
    left -= k;
  }
  out.push(left);
  return out;
}

// The default chart with ids, as a business would have it.
function seededChart() {
  return chartLib.DEFAULT_CHART.map((a, i) => ({
    id: `acc${i}`, type: a.type, name: a.name, systemKey: a.sys || null, categorySlug: a.cat || null, seed: a.seed,
  }));
}

function randomInput(g, opts = {}) {
  const withChart = !!opts.chart;
  const accounts = withChart ? opts.accounts || seededChart() : [];
  const ofClass = (...classes) => accounts.filter((a) => classes.includes(chartLib.classOf(a.type)) && !(a.systemKey && chartLib.CONTROLLED.includes(a.systemKey)));
  const maybeAccount = (classes, p) => (withChart && g.chance(p) ? g.pick(ofClass(...classes)).id : null);
  const moneyAccounts = accounts.filter((a) => ["cash", "bank"].includes(a.type) && a.systemKey !== "kashbook");

  const sales = [];
  const debts = [];
  for (let i = 0, k = g.int(0, 8); i < k; i++) {
    const s = {
      id: g.id("s"), amount: g.money(), date: g.when(), isCredit: g.chance(0.3),
      channel: g.pick([null, "walk-in", "instagram"]), customerId: g.chance(0.5) ? "c1" : null,
    };
    if (withChart) {
      s.paymentMethod = s.isCredit ? "credit" : g.pick(["cash", "transfer", "pos", "cash"]);
      if (!s.isCredit && g.chance(0.2)) s.matchedTransactionId = "t-sale";
      s.accountId = maybeAccount(["income"], 0.2);
      if (g.chance(0.1) && moneyAccounts.length) s.depositAccountId = g.pick(moneyAccounts).id;
      if (g.chance(0.05)) { s.currency = "EUR"; s.foreignCurrency = true; }
    }
    sales.push(s);
    if (s.isCredit && g.chance(0.7)) {
      const paid = g.chance(0.5) ? Math.min(s.amount, g.money()) : 0;
      debts.push({
        id: g.id("d"), amount: s.amount, paidAmount: paid, paid: paid >= s.amount, date: s.date, saleId: s.id, customerId: "c1",
        payments: paid ? [{ id: g.id("dp"), amount: paid, date: g.when(), method: withChart ? g.pick([null, "cash", "transfer"]) : undefined }] : [],
      });
    }
  }
  for (let i = 0, k = g.int(0, 4); i < k; i++) {
    const amount = g.money();
    const pays = [];
    let left = amount;
    for (let j = 0, m = g.int(0, 3); j < m && left > 0; j++) {
      const a = Math.min(left, g.money());
      left -= a;
      const p = { id: g.id("dp"), amount: a, date: g.when(), note: "" };
      if (withChart) {
        p.method = g.pick([null, "cash", "transfer", "pos"]);
        if (g.chance(0.2)) p.transactionId = "t-debt";
      }
      pays.push(p);
    }
    debts.push({ id: g.id("d"), amount, paidAmount: amount - left, paid: left <= 0, date: g.when(), saleId: null, customerId: "c2", note: "credit", payments: pays });
  }
  const expenses = [];
  // What a line of an itemized expense may be spent on, as Add Expense offers
  // it (chart.pickerAllows "expense"): spending, and on the balance sheet
  // equipment, prepayments, advances, VAT, loans and drawings.
  const lineAccounts = accounts.filter((a) => chartLib.pickerAllows("expense", a));
  for (let i = 0, k = g.int(0, 8); i < k; i++) {
    const e = { id: g.id("e"), amount: g.money(), date: g.when(), category: g.pick(["rent", "supplies", "other", "generator", "hair-oil"]) };
    if (withChart) {
      e.paymentMethod = g.pick(["cash", "transfer", "pos", "credit"]);
      if (g.chance(0.15)) e.matchedTransactionId = "t-exp";
      e.accountId = maybeAccount(["expense", "asset", "liability", "equity"], 0.3);
      if (g.chance(0.1) && moneyAccounts.length) e.paidThroughAccountId = g.pick(moneyAccounts).id;
      if (g.chance(0.05)) { e.currency = "EUR"; e.foreignCurrency = true; }
      // Itemized: one to four lines, mostly on accounts from the picker (some
      // on the balance sheet), now and then one whose account this chart does
      // not know or that has only a category. Saved as routes/expenses.js
      // saves it: the amount is the lines' sum, no account of its own, the
      // first line's category.
      if (g.chance(0.3) && lineAccounts.length) {
        const items = [];
        for (let j = 0, m = g.int(1, 4); j < m; j++) {
          const roll = g.int(1, 10);
          const acc = roll <= 8 ? g.pick(lineAccounts) : null;
          items.push({
            id: g.id("ei"),
            accountId: acc ? acc.id : roll === 9 ? "acc-gone" : null,
            category: acc ? acc.categorySlug || "other" : g.pick(["rent", "supplies", "other", "hair-oil"]),
            amount: g.money(),
          });
        }
        e.items = items;
        e.amount = items.reduce((s, it) => s + Math.round(it.amount * 100), 0) / 100;
        e.accountId = null;
        e.category = items[0].category;
      }
    }
    expenses.push(e);
  }
  const bankRows = [];
  for (let i = 0, k = g.int(0, 10); i < k; i++) {
    const income = g.chance(0.6);
    const amount = g.money();
    const tx = { id: g.id("t"), type: income ? "income" : "expense", amount, date: g.when(), purpose: null };
    if (g.chance(0.25)) {
      tx.purpose = income
        ? g.pick(["cash_deposit", "own_transfer", "owner_money", "loan", "supplier_refund"])
        : g.pick(["customer_refund", "savings_fee"]);
    }
    if (income && !tx.purpose && g.chance(0.3)) tx[g.pick(["matchedSaleId", "matchedCustomerId", "matchedInvoiceId"])] = "x";
    // A debit records an expense, or (release 2) pays a bill.
    if (!income && !tx.purpose && g.chance(0.3)) tx[withChart && g.chance(0.4) ? "matchedBillId" : "matchedExpenseId"] = "x";
    if (isMatched(tx) && g.chance(0.7)) {
      tx.matchedAmount = Math.round(amount * g.int(10, 100)) / 100;
    }
    if (!income && g.chance(0.4)) tx.fee = g.pick([0, 10.75, 26.88, 53.75]);
    if (withChart) {
      tx.source = g.chance(0.9) ? "anchor" : null;
      tx.paymentMethod = g.chance(0.95) ? "bank" : "cash";
      tx.category = income ? "transfer" : g.chance(0.95) ? "transfer" : "other";
      tx.currency = g.chance(0.05) ? "EUR" : "NGN";
      if (tx.currency !== "NGN") tx.foreignCurrency = true;
      if (!tx.purpose && !isMatched(tx) && g.chance(0.3)) {
        tx.accountId = income ? maybeAccount(["income", "expense", "equity", "liability"], 1) : maybeAccount(["expense", "equity", "asset"], 1);
        const cls = chartLib.classOf((accounts.find((a) => a.id === tx.accountId) || {}).type);
        if (cls === "asset" || cls === "liability" || cls === "equity") tx.purpose = "account";
      }
      // Payroll, and auto-debits from the recurring rules the ledger test
      // knows: r1 on a category, r2 on a loan (the balance sheet), r3 on a
      // spending account of its own.
      if (!income && g.chance(0.1)) {
        tx.reference = g.pick(["kbsal_x1", "kashbook_rec_r1_2026", "kashbook_rec_r2_2026", "kashbook_rec_r3_2026"]);
      }
    }
    bankRows.push(tx);
  }
  const invoices = [];
  for (let i = 0, k = g.int(0, 5); i < k; i++) {
    const type = g.pick(["invoice", "invoice", "invoice", "credit_note", "quote"]);
    let total;
    let taxAmount;
    let items;
    let subtotal;
    let discountAmount = 0;
    if (withChart) {
      // A document whose lines, discount and tax add up, as invoices.js saves them.
      items = [];
      for (let j = 0, m = g.int(1, 3); j < m; j++) {
        items.push({ id: g.id("it"), amount: g.money(), accountId: maybeAccount(["income"], 0.3) });
      }
      subtotal = Math.round(items.reduce((s, it) => s + it.amount * 100, 0)) / 100;
      if (g.chance(0.3)) discountAmount = Math.round(subtotal * g.int(1, 20)) / 100;
      const net = Math.round((subtotal - discountAmount) * 100) / 100;
      taxAmount = g.chance(0.5) ? Math.round(net * 7.5) / 100 : 0;
      total = Math.round((net + taxAmount) * 100) / 100;
    } else {
      total = g.money();
      taxAmount = g.chance(0.5) ? Math.round((total * 7.5) / 107.5 * 100) / 100 : 0;
    }
    const status = g.pick(["draft", "sent", "partial", "paid", "overdue", "void"]);
    const payments = [];
    for (let j = 0, m = g.int(0, 3); j < m; j++) {
      const method = type === "credit_note"
        ? g.pick(["credit_applied", "refund_cash", "refund_bank", "refund_transfer"])
        : g.pick(["cash", "card", "cheque", "transfer", "pos", "other", "bank", "credit_note"]);
      payments.push({
        id: g.id("ip"), amount: Math.min(total, g.money()), method, date: g.when(),
        transactionId: method.endsWith("bank") && g.chance(0.6) ? "t-link" : null,
      });
    }
    const amountPaid = payments.reduce((s, p) => s + p.amount, 0);
    const inv = { id: g.id("i"), type, status, issueDate: g.day(), total, taxAmount, amountPaid, payments, invoiceNumber: `INV-${i}`, customerId: "c1" };
    if (withChart) Object.assign(inv, { items, subtotal, discountAmount });
    if (type === "invoice" && g.chance(0.15)) {
      inv.writtenOffAt = g.when();
      inv.writtenOffAmount = Math.max(0, Math.round((total - amountPaid) * 100) / 100);
    }
    invoices.push(inv);
  }
  const input = { sales, expenses, bankRows, invoices, debts };
  if (withChart) {
    input.bills = randomBills(g, accounts, moneyAccounts);
    input.journals = randomJournals(g, accounts);
    input.accounts = {};
    for (const a of accounts) input.accounts[a.id] = { cls: chartLib.classOf(a.type), type: a.type };
    // Drawn after everything above, so books drawn without it stay the same.
    if (opts.links) linkRecords(g, input, moneyAccounts);
  }
  return input;
}

// Bills as routes/bills.js and scripts/backfill-r2.js save them (release 2):
// mostly on spending (the "bill" picker), some on a loan or another liability
// (received into a money account, or into equipment, or nowhere named), now
// and then one with no account or one this chart does not know. Payments add
// up to no more than the bill, by every method, sometimes from a money
// account picked for them, sometimes "bank" with a one-sided link ("t-bill").
// A payable from before bills (estimated) carries one payment kept outside
// the books.
function randomBills(g, accounts, moneyAccounts) {
  const allowed = accounts.filter((a) => chartLib.pickerAllows("bill", a));
  const spending = allowed.filter((a) => chartLib.classOf(a.type) === "expense");
  const owed = allowed.filter((a) => chartLib.classOf(a.type) === "liability");
  const into = [...moneyAccounts, ...accounts.filter((a) => a.type === "fixed_asset")];
  const bills = [];
  for (let i = 0, k = g.int(0, 4); i < k; i++) {
    const roll = g.int(1, 20);
    const acc = roll <= 13 ? g.pick(spending) : roll <= 18 ? g.pick(owed) : null;
    const amount = g.money();
    const bill = {
      id: g.id("b"), accountId: acc ? acc.id : roll === 19 ? null : "acc-gone", billDate: g.when(), amount,
      estimated: false, vendorName: g.pick(["Ada Supplies", "Landlord", "", "First Bank"]), billNumber: g.chance(0.3) ? `B-${i}` : null,
      receivedViaAccountId: null, payments: [],
    };
    if (acc && chartLib.classOf(acc.type) === "liability" && g.chance(0.7) && into.length) bill.receivedViaAccountId = g.pick(into).id;
    let left = Math.round(amount * 100);
    if (g.chance(0.2)) {
      bill.estimated = true;
      const outside = Math.min(left, Math.round(g.money() * 100));
      bill.payments.push({
        id: g.id("bp"), amount: outside / 100, date: g.when(), method: "cash", transactionId: null,
        estimated: true, outsideBooks: true, note: "Paid before bills",
      });
      left -= outside;
    }
    for (let j = 0, m = g.int(0, 3); j < m && left > 0; j++) {
      const a = Math.min(left, Math.round(g.money() * 100));
      left -= a;
      const p = {
        id: g.id("bp"), amount: a / 100, date: g.when(), method: g.pick(["cash", "transfer", "pos", "cheque", "other"]),
        transactionId: null, outsideBooks: false, paidThroughAccountId: null,
      };
      if (g.chance(0.2) && moneyAccounts.length) p.paidThroughAccountId = g.pick(moneyAccounts).id;
      if (g.chance(0.15)) {
        p.method = "bank";
        p.transactionId = "t-bill";
      }
      bill.payments.push(p);
    }
    bills.push(bill);
  }
  return bills;
}

// Manual journals (release 2): two to four lines, debits equal to credits to
// the kobo, on any account a journal may name (chart.pickerAllows "journal":
// income, spending and the balance sheet alike). Mostly published, some
// drafts; now and then a published one the books must refuse (unbalanced, or
// naming an account this chart does not know), which the route never saves.
function randomJournals(g, accounts) {
  const usable = accounts.filter((a) => chartLib.pickerAllows("journal", a));
  const journals = [];
  for (let i = 0, k = g.int(0, 3); i < k; i++) {
    const n = g.int(2, 4);
    const debits = g.int(1, n - 1);
    const total = Math.max(n, Math.round(g.money() * 100));
    const amounts = [...pieces(g, total, debits), ...pieces(g, total, n - debits)];
    const lines = amounts.map((k2, j) => ({
      id: g.id("jl"), accountId: g.pick(usable).id, position: j,
      debit: j < debits ? k2 / 100 : 0, credit: j < debits ? 0 : k2 / 100,
    }));
    const roll = g.int(1, 40);
    if (roll === 1) lines[0][lines[0].debit ? "debit" : "credit"] += 0.01;
    if (roll === 2) lines[lines.length - 1].accountId = "acc-gone";
    journals.push({
      id: g.id("j"), number: `MJ-${String(i + 1).padStart(5, "0")}`, date: g.when(), note: g.pick(["", "Rent used up", "Correction"]),
      status: g.chance(0.8) ? "published" : "draft", lines,
    });
  }
  return journals;
}

// Money-in methods an invoice payment linked to a credit may have had.
const MONEY_IN = ["cash", "card", "cheque", "transfer", "pos", "other", "bank"];

// Real bank links, both sides, as the routes write them: a credit matched to a
// sale (POST /transactions/:id/match: matchedAmount the smaller of the two, or
// an older match's NULL on a credit no bigger than its sale), applied to one
// or two repayments (match-debt), or carrying an invoice payment ("bank"); a
// debit recording an expense (create-expense: never below it), paying a bill
// (release 2, POST /bills/:id/payments with method "bank": matchedBillId, and
// matchedAmount the payment, never more than the debit), or paying out a
// credit note's refund (purpose customer_refund). Linked records sometimes
// name a money account of their own too, which the link beats. Every other
// way into Bank Matching is taken out first: the one-sided links, a refund
// "to the bank" with no debit, a customer refund with no refund, a bill
// payment "from the bank" with no debit.
function linkRecords(g, input, moneyAccounts) {
  const { sales, expenses, bankRows, invoices, debts } = input;
  const bills = input.bills || [];
  const pick = () => (moneyAccounts.length && g.chance(0.3) ? g.pick(moneyAccounts).id : null);
  for (const s of sales) delete s.matchedTransactionId;
  for (const e of expenses) delete e.matchedTransactionId;
  for (const d of debts) for (const p of d.payments) p.transactionId = null;
  for (const inv of invoices) {
    for (const p of inv.payments) {
      p.transactionId = null;
      if (p.method === "refund_bank") p.method = "refund_transfer";
    }
  }
  for (const b of bills) {
    for (const p of b.payments) {
      p.transactionId = null;
      if (p.method === "bank") p.method = "transfer";
    }
  }
  for (const t of bankRows) {
    for (const k of [...MATCH_FIELDS, "matchedAmount"]) delete t[k];
    if (t.purpose === "customer_refund") t.purpose = null;
  }
  const take = (list) => list.splice(g.int(0, list.length - 1), 1)[0];
  const r2 = (n) => Math.round(n * 100) / 100;
  // A credit sale a debt tracks is paid through the debt, never matched itself.
  const withDebt = new Set(debts.filter((d) => d.saleId).map((d) => d.saleId));
  const open = {
    sale: sales.filter((s) => !s.foreignCurrency && !withDebt.has(s.id)),
    repayment: debts.flatMap((d) => d.payments.map((p) => ({ d, p }))),
    invoicePayment: invoices
      .filter((i) => i.type === "invoice" && i.status !== "void")
      .flatMap((i) => i.payments.filter((p) => MONEY_IN.includes(p.method)).map((p) => ({ i, p }))),
    expense: expenses.filter((e) => !e.foreignCurrency),
    refund: invoices
      .filter((i) => i.type === "credit_note" && i.status !== "void")
      .flatMap((i) => i.payments.filter((p) => p.method.startsWith("refund_")).map((p) => ({ p }))),
    // Any payment towards a bill that is in the books, on spending or a loan.
    billPayment: bills.flatMap((b) => b.payments.filter((p) => !p.outsideBooks).map((p) => ({ b, p }))),
  };
  for (const t of bankRows) {
    // Only a row nothing explains yet can be linked (the routes refuse others).
    if (t.purpose || t.accountId || t.foreignCurrency || !g.chance(0.7)) continue;
    const kinds = (t.type === "income" ? ["sale", "repayment", "invoicePayment"] : ["expense", "refund", "billPayment"])
      .filter((k) => open[k].length);
    if (!kinds.length) continue;
    const kind = g.pick(kinds);
    // An older match saved no matchedAmount: the whole row is the record's.
    const settle = (amount) => {
      if (g.chance(0.3)) {
        t.amount = amount;
        t.matchedAmount = null;
      } else {
        t.amount = Math.max(t.amount, amount);
        t.matchedAmount = amount;
      }
    };
    if (kind === "sale") {
      const s = take(open.sale);
      t.matchedSaleId = s.id;
      s.matchedTransactionId = t.id;
      s.depositAccountId = pick() || s.depositAccountId;
      const shape = g.int(1, 3);
      if (shape === 1) {
        t.amount = Math.min(t.amount, s.amount);
        t.matchedAmount = null;
      } else if (shape === 2) {
        t.amount = s.amount;
        t.matchedAmount = s.amount;
      } else {
        // The sale above or below its credit.
        t.matchedAmount = Math.min(s.amount, t.amount);
      }
    } else if (kind === "repayment") {
      const linked = [take(open.repayment)];
      if (open.repayment.length && g.chance(0.3)) linked.push(take(open.repayment));
      let total = 0;
      for (const { d, p } of linked) {
        p.transactionId = t.id;
        p.depositAccountId = pick();
        t.matchedCustomerId = d.customerId;
        total = r2(total + p.amount);
      }
      settle(total);
    } else if (kind === "invoicePayment") {
      const { i, p } = take(open.invoicePayment);
      p.method = "bank";
      p.transactionId = t.id;
      p.depositAccountId = pick();
      t.matchedInvoiceId = i.id;
      settle(p.amount);
    } else if (kind === "expense") {
      const e = take(open.expense);
      e.matchedTransactionId = t.id;
      e.paidThroughAccountId = pick() || e.paidThroughAccountId;
      t.matchedExpenseId = e.id;
      settle(e.amount);
    } else if (kind === "billPayment") {
      const { b, p } = take(open.billPayment);
      p.method = "bank";
      p.transactionId = t.id;
      p.paidThroughAccountId = pick();
      t.matchedBillId = b.id;
      settle(p.amount);
    } else {
      const { p } = take(open.refund);
      p.method = "refund_bank";
      p.transactionId = t.id;
      p.depositAccountId = pick();
      t.purpose = "customer_refund";
      t.amount = p.amount;
    }
  }
}

function randomOpts(g) {
  const from = g.chance(0.2) ? "" : g.day();
  let to = g.chance(0.2) ? "" : g.day();
  if (from && to && to < from) to = from;
  const vat = g.chance(0.4)
    ? { enabled: true, rate: g.pick([7.5, 7.5, 5, null]), inclusive: g.chance(0.7) }
    : { enabled: false };
  return { from, to, basis: g.pick(["paid", "sold"]), vat };
}

module.exports = { rng, makeGen, seededChart, randomInput, randomOpts, randomBills, randomJournals };
