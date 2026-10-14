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
//
// With { stock: true } (release 3, drawn after everything else, so books
// drawn without it stay the same): goods and services on sales, invoices and
// credit notes, restocks, stock counted and valued again, and starting stock,
// with every cost as the stock engine (utils/stock.js) would write it
// (randomStock).
const chartLib = require("../../src/utils/chart");
const { dayKey } = require("../../src/utils/books");

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
    if (opts.stock) randomStock(g, input, accounts, moneyAccounts, !!opts.links);
  }
  return input;
}

// ── Release 3: stock ─────────────────────────────────────────────────────────
// Goods and services, and everything that moves stock, as the routes save
// them through the stock engine (utils/stock.js), worked out here by the same
// rules in entry order (not date order: a record can be back-dated): goods
// leave at the item's average, to the kobo (the last of the stock takes
// whatever value is left), come in at their cost (a restock line's amount,
// a credit note's return at the average, unknown cost at nothing), and are
// never sold below zero. Writes, on the input:
//   sales[].items          lines on about two sales in three (goods, services,
//                          typed lines; amounts that share the sale's amount,
//                          now and then not, now and then all nothing)
//   invoices[].items[]     itemId, itemType, costAmount (an issued invoice's
//                          goods), restock (a credit note's goods back); now
//                          and then a draft or void one still carrying a cost
//                          its lines no longer move
//   bills                  restocks: on Inventory Asset, with lines, paid now,
//                          later, in part or not at all
//   stockMoves             adjustment, revalue, opening, opening_value
// and, for the tests only (the books never read them):
//   stockItems             each item's final quantity and stockValue
//   stockLedger            every movement the records imply:
//                          { kind, day, k (signed kobo), itemId }
function randomStock(g, input, accounts, moneyAccounts, links) {
  const sysId = (key) => (accounts.find((a) => a.systemKey === key) || {}).id;
  const SALES = sysId(chartLib.SYS.SALES);
  const SERVICE = sysId(chartLib.SYS.SERVICE_INCOME);
  const STOCK = sysId(chartLib.SYS.STOCK);
  const incomeAccounts = accounts.filter((a) => chartLib.pickerAllows("income", a));
  // Thousandths of a unit and kobo, as the engine keeps them.
  const goods = [];
  for (let i = 0, n = g.int(1, 4); i < n; i++) goods.push({ id: g.id("gd"), itemType: "goods", qM: 0, vK: 0, avg: null });
  const services = [];
  for (let i = 0, n = g.int(0, 2); i < n; i++) services.push({ id: g.id("sv"), itemType: "service" });
  const moves = [];
  const ledger = [];
  const note = (kind, day, k, itemId) => ledger.push({ kind, day: dayKey(day), k, itemId });
  // a / b rounded, halves up (a ≥ 0, b > 0), as the engine rounds.
  const roundDiv = (a, b) => Math.floor((2 * a + b) / (2 * b));
  const qty = (max) => {
    // Whole units mostly, a half or a quarter now and then (kg, litres).
    const want = g.int(1, 4) * 1000 / (g.chance(0.2) ? g.pick([2, 4]) : 1);
    return Math.max(1, Math.min(max, Math.round(want)));
  };
  const takeOut = (it, qM) => {
    const outK = qM === it.qM ? it.vK : Math.min(it.vK, roundDiv(qM * it.vK, it.qM));
    it.qM -= qM;
    it.vK -= outK;
    return outK;
  };
  const putIn = (it, qM, inK, known) => {
    it.qM += qM;
    it.vK += inK;
    if (known || it.avg != null || it.vK) it.avg = it.vK / it.qM; // kobo a thousandth
  };
  const atAverage = (it, qM) => (it.avg == null ? null : Math.round(qM * it.avg));
  const inStock = () => goods.filter((it) => it.qM > 0);
  const incomeFor = (type) => {
    const roll = g.int(1, 40);
    if (roll <= 4 && incomeAccounts.length) return g.pick(incomeAccounts).id; // picked on the line
    if (roll === 5) return null; // an older line, or one cut loose
    if (roll === 6) return "acc-gone";
    return type === "service" ? SERVICE : SALES;
  };
  const move = (kind, it, day, k, extra = {}) => {
    const m = { id: g.id("mv"), kind, date: day, value: k / 100, itemId: it.id, reason: null, note: g.pick(["", "Shelf count"]), ...extra };
    moves.push(m);
    note(kind, day, k, it.id);
  };

  // Starting stock first: a count, at a cost or (unknown) at nothing.
  for (const it of goods) {
    if (!g.chance(0.6)) continue;
    const qM = qty(20000) * g.int(1, 5);
    const known = g.chance(0.75);
    const k = known ? Math.round((qM * g.int(50, 500000)) / 1000) : 0;
    putIn(it, qM, k, known);
    move("opening", it, g.when(), k);
  }

  // Then every other record, in a random order of entry.
  const tasks = [];
  for (const s of input.sales) if (g.chance(0.65)) tasks.push(["sale", s]);
  for (const inv of input.invoices) if (inv.type !== "quote" && g.chance(0.7)) tasks.push(["doc", inv]);
  for (let i = 0, n = g.int(0, 3); i < n; i++) tasks.push(["restock"]);
  for (let i = 0, n = g.int(0, 3); i < n; i++) tasks.push(["adjust"]);
  for (let i = 0, n = g.int(0, 2); i < n; i++) tasks.push(["revalue"]);
  for (let i = tasks.length - 1; i > 0; i--) {
    const j = g.int(0, i);
    [tasks[i], tasks[j]] = [tasks[j], tasks[i]];
  }

  // A line of what was sold: goods while any are in stock, else a service or
  // a typed line. → { line, outK } (outK: the goods' cost, kobo).
  const soldLine = (prefix) => {
    const roll = g.int(1, 20);
    const stocked = inStock();
    if (roll <= 12 && stocked.length) {
      const it = g.pick(stocked);
      const qM = qty(it.qM);
      const known = it.avg != null;
      const outK = takeOut(it, qM);
      return {
        line: { id: g.id(prefix), itemId: it.id, itemType: "goods", quantity: qM / 1000, costAmount: outK / 100, unitCost: known ? outK / qM * 10 : null },
        it, outK,
      };
    }
    if (roll <= 17 && services.length) {
      return { line: { id: g.id(prefix), itemId: g.pick(services).id, itemType: "service", quantity: g.int(1, 3), costAmount: 0, unitCost: null }, outK: 0 };
    }
    return { line: { id: g.id(prefix), itemId: null, itemType: "other", quantity: 1, costAmount: 0, unitCost: null }, outK: 0 };
  };

  for (const [what, rec] of tasks) {
    if (what === "sale") {
      const n = g.int(1, 3);
      const total = Math.round(rec.amount * 100);
      // The lines share the sale's amount, mostly; now and then they add up
      // to more (a discount on the sale), or are all nothing (price varies).
      const shape = g.int(1, 20);
      const amounts = shape === 1 ? Array(n).fill(0)
        : shape <= 4 ? Array.from({ length: n }, () => g.int(1, 2 * total))
        : total >= n ? pieces(g, total, n) : Array(n).fill(total);
      rec.items = [];
      for (let i = 0; i < n; i++) {
        const { line, outK } = soldLine("si");
        line.amount = amounts[i] / 100;
        line.accountId = incomeFor(line.itemType);
        line.name = line.itemType;
        rec.items.push(line);
        if (outK || line.itemType === "goods") note("sale", rec.date, -outK, line.itemId);
      }
    } else if (what === "doc") {
      const issued = !["draft", "void"].includes(rec.status);
      const isCN = rec.type === "credit_note";
      for (const line of rec.items || []) {
        line.costAmount = 0;
        line.restock = false;
        if (isCN) {
          // A line from a product that may go back into stock.
          if (!g.chance(0.6)) continue;
          const it = g.pick(goods);
          line.itemId = it.id;
          line.itemType = "goods";
          if (!g.chance(0.75)) continue;
          line.restock = true;
          const qM = qty(5000);
          if (issued) {
            const inK = atAverage(it, qM);
            putIn(it, qM, inK || 0, inK != null);
            line.costAmount = (inK || 0) / 100;
            note("credit_note", rec.issueDate, inK || 0, it.id);
          } else if (g.chance(0.3)) {
            line.costAmount = g.int(1, 50000) / 100; // a draft or void one: moves nothing
          }
          continue;
        }
        const roll = g.int(1, 10);
        if (roll <= 6) {
          const stocked = inStock();
          if (issued && stocked.length) {
            const it = g.pick(stocked);
            const outK = takeOut(it, qty(it.qM));
            Object.assign(line, { itemId: it.id, itemType: "goods", costAmount: outK / 100 });
            note("invoice", rec.issueDate, -outK, it.id);
          } else if (!issued && g.chance(0.3)) {
            Object.assign(line, { itemId: g.pick(goods).id, itemType: "goods", costAmount: g.int(1, 50000) / 100 });
          }
        } else if (roll <= 8 && services.length) {
          Object.assign(line, { itemId: g.pick(services).id, itemType: "service" });
        }
      }
    } else if (what === "restock") {
      const lines = [];
      for (let i = 0, n = g.int(1, 3); i < n; i++) {
        const it = g.pick(goods);
        const qM = qty(10000) * g.int(1, 3);
        const unitK = g.int(50, 300000);
        const amountK = roundDiv(qM * unitK, 1000);
        lines.push({ id: g.id("bi"), itemId: it.id, quantity: qM / 1000, unitCost: unitK / 100, amount: amountK / 100, it, qM, amountK });
      }
      const amountK = lines.reduce((s, l) => s + l.amountK, 0);
      const bill = {
        id: g.id("rb"), accountId: STOCK, billDate: g.when(), amount: amountK / 100, estimated: false,
        vendorName: g.pick(["Ada Wholesale", "Mama Tunde", ""]), billNumber: g.chance(0.3) ? `RS-${tasks.length}` : null,
        receivedViaAccountId: null, payments: [],
        items: lines.map(({ id, itemId, quantity, unitCost, amount }) => ({ id, itemId, quantity, unitCost, amount })),
      };
      for (const l of lines) {
        putIn(l.it, l.qM, l.amountK, true);
        note("purchase", bill.billDate, l.amountK, l.it.id);
      }
      // Paid now (the Restock screen), in parts later, or not yet.
      let left = amountK;
      const shape = g.int(1, 3);
      for (let j = 0, m = shape === 1 ? 1 : shape === 2 ? g.int(1, 3) : 0; j < m && left > 0; j++) {
        const a = shape === 1 ? left : Math.min(left, Math.round(g.money() * 100));
        left -= a;
        const p = {
          id: g.id("rp"), amount: a / 100, date: shape === 1 ? bill.billDate : g.when(),
          method: g.pick(["cash", "transfer", "pos"]), transactionId: null, outsideBooks: false,
          paidThroughAccountId: g.chance(0.2) && moneyAccounts.length ? g.pick(moneyAccounts).id : null,
        };
        if (!links && g.chance(0.15)) {
          p.method = "bank";
          p.transactionId = "t-bill";
        }
        bill.payments.push(p);
      }
      input.bills.push(bill);
    } else if (what === "adjust") {
      const it = g.pick(goods);
      const out = it.qM > 0 && g.chance(0.6);
      const day = g.when();
      if (out) {
        const outK = takeOut(it, qty(it.qM));
        move("adjustment", it, day, -outK, { reason: g.pick(["damaged", "expired", "lost", "used", "counted"]) });
      } else {
        const qM = qty(5000);
        const inK = atAverage(it, qM);
        putIn(it, qM, inK || 0, inK != null);
        move("adjustment", it, day, inK || 0, { reason: g.pick(["counted", "other"]) });
      }
    } else {
      // Valued again (or, never valued, set up: opening_value).
      const held = inStock();
      if (!held.length) continue;
      const it = g.pick(held);
      const afterK = roundDiv(it.qM * g.int(50, 500000), 1000);
      const diff = afterK - it.vK;
      const kind = it.avg == null ? "opening_value" : "revalue";
      it.vK = afterK;
      it.avg = afterK / it.qM;
      if (diff) move(kind, it, g.when(), diff);
    }
  }
  input.stockMoves = moves;
  input.stockItems = [...goods, ...services].map((it) => ({
    id: it.id, itemType: it.itemType, quantity: (it.qM || 0) / 1000, stockValue: (it.vK || 0) / 100,
  }));
  input.stockLedger = ledger;
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
