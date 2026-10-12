// The ledger's invariants (chart of accounts, 2026-10-11), on seeded random
// books that use everything the chart added (accounts on records, fees, other
// currencies, bank links, payment methods, invoice lines with discounts and
// VAT, itemized expenses with lines on the balance sheet, auto-debits from
// recurring rules, one of them on a loan), in both views:
//
//   1. every entry balances to the kobo;
//   2. the profit and loss by account equals computeBooks for random periods;
//   3. the trial balance balances and the balance sheet balances at random dates;
//   4. the KashBook Account equals the bank ledger (computeRawLedger's rows);
//   5. cash and bank accounts are the same in both views (only timing of
//      income and spending differs between them);
//   6. every expense leaves the account it was paid from in full, once,
//      however its lines count;
//   7. with real bank links on both sides (lib/booksGen.js { links: true }),
//      Bank Matching nets to zero: what a matched bank row leaves there, the
//      record it was matched to takes back out, even when the record names a
//      money account of its own or is bigger than its transfer;
//
// plus fixtures with exact expected entries, and checks that a deliberately
// broken engine fails them.
//
//   node scripts/ledger-test.js [iterations] [seed]
const assert = require("assert");
const books = require("../src/utils/books");
const chart = require("../src/utils/chart");
const ledger = require("../src/utils/ledger");
const { isLedgerBankRow } = require("../src/config/moneySources");
// Pure; loading it opens no database connection.
const { groupSpending } = require("../src/utils/insightsEngine");
const gen = require("./lib/booksGen");

const ITER = Number(process.argv[2]) || 1500;
const SEED = Number(process.argv[3]) || 20261012;

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${name}\n        ${String(e.message).split("\n").slice(0, 3).join("\n        ")}`);
  }
}
const eq = (a, b, what = "") => assert.strictEqual(a, b, `${what} ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);

const ACCOUNTS = gen.seededChart();
const C = chart.indexChart(ACCOUNTS);
const sysId = (key) => chart.sysAccount(C, key).id;
// The recurring rules the generated auto-debits come from (lib/booksGen.js):
// one on a category, one whose account is a loan (on the balance sheet: an
// auto-debit from it that names no account is still spending to the books),
// one on a spending account of its own.
const RULES = new Map([
  ["r1", { category: "rent" }],
  ["r2", { category: "rent", accountId: sysId(chart.SYS.LOANS) }],
  ["r3", { category: "other", accountId: ACCOUNTS.find((a) => a.name === "Advertising and Marketing").id }],
]);
const ctxFor = (basis, vat) => ({ chart: C, basis, vat, baseCurrency: "NGN", recurring: RULES });

// The bank ledger as computeRawLedger sums it, from the rows themselves.
function rawLedgerKobo(rows, to) {
  let k = 0;
  for (const tx of rows) {
    if (!isLedgerBankRow(tx, "NGN")) continue;
    if (to && books.dayKey(tx.date) > to) continue;
    if (tx.type === "income") k += ledger.K(tx.amount);
    else k -= ledger.K(tx.amount) + ledger.K(tx.fee);
  }
  return k;
}

const kobo = (n) => Math.round(n * 100);

// Every expense leaves the account it was paid from in full, once: its entries
// (one, or one per line of an itemized expense, counted or on the balance
// sheet) credit that account with the whole amount. Returns what is wrong, or
// null.
function expensesPaidInFull(input, entries) {
  const moneyOf = new Map((input.expenses || []).map((x) => [x.id, chart.moneyAccount(C, {
    accountId: x.paidThroughAccountId, linked: !!x.matchedTransactionId, method: x.paymentMethod, direction: "out",
  }).id]));
  const credited = new Map();
  for (const e of entries) {
    if (e.kind !== "expense") continue;
    for (const l of e.lines) {
      if (l.k < 0 && l.accountId === moneyOf.get(e.ref)) credited.set(e.ref, (credited.get(e.ref) || 0) - l.k);
    }
  }
  for (const x of input.expenses || []) {
    const want = x.foreignCurrency ? 0 : ledger.K(x.amount);
    const got = credited.get(x.id) || 0;
    if (got !== want) return `expense ${x.id} took ${got / 100} from the account it was paid from, not ${want / 100}`;
  }
  return null;
}

// An account on the balance sheet (what an expense line may be instead of spending).
const onBalanceSheet = (id) => {
  const a = id ? C.byId.get(id) : null;
  return !!a && !chart.isProfitClass(chart.classOf(a.type));
};

console.log("\nLEDGER — INVARIANTS");

test(`random books (${ITER} businesses, seed ${SEED}): balanced, P&L = computeBooks, BS balances, KashBook = bank ledger`, () => {
  const g = gen.makeGen(gen.rng(SEED));
  for (let i = 0; i < ITER; i++) {
    const input = gen.randomInput(g, { chart: true, accounts: ACCOUNTS });
    const opts = gen.randomOpts(g);
    const L = ledger.buildLedger(input, ctxFor(opts.basis, opts.vat));
    const bad = ledger.unbalanced(L.entries);
    if (bad.length) throw new Error(`iteration ${i}: ${bad.length} unbalanced, first ${bad[0].id}`);

    const pl = ledger.profitAndLoss(L.entries, C, { from: opts.from, to: opts.to });
    const b = books.computeBooks(input, opts);
    if (kobo(pl.totalIncome) !== kobo(b.sales.total)) {
      throw new Error(`iteration ${i} (${opts.basis}): ledger income ${pl.totalIncome} ≠ books sales ${b.sales.total}`);
    }
    if (kobo(pl.totalExpenses) !== kobo(b.expenses.total)) {
      throw new Error(`iteration ${i} (${opts.basis}): ledger expenses ${pl.totalExpenses} ≠ books expenses ${b.expenses.total}`);
    }

    const asOf = g.day();
    const tb = ledger.trialBalance(L.entries, C, asOf);
    if (!tb.balanced) throw new Error(`iteration ${i}: trial balance off at ${asOf}: ${tb.debit} vs ${tb.credit}`);
    const bs = ledger.balanceSheet(L.entries, C, asOf, g.pick([1, 4, 7]));
    if (!bs.balanced) throw new Error(`iteration ${i}: balance sheet off at ${asOf}: A ${bs.totals.assets} L ${bs.totals.liabilities} E ${bs.totals.equity}`);

    const kb = ledger.sumByAccount(L.entries, { to: asOf }).get(sysId(chart.SYS.KASHBOOK)) || 0;
    const raw = rawLedgerKobo(input.bankRows, asOf);
    if (kb !== raw) throw new Error(`iteration ${i}: KashBook Account ${kb / 100} ≠ bank ledger ${raw / 100} at ${asOf}`);

    const paidOut = expensesPaidInFull(input, L.entries);
    if (paidOut) throw new Error(`iteration ${i} (${opts.basis}): ${paidOut}`);
  }
});

test("those books include itemized expenses, with lines on the balance sheet and on spending", () => {
  // The same draws as the test above, so these are the books it checked.
  const g = gen.makeGen(gen.rng(SEED));
  let itemized = 0;
  let bsLines = 0;
  let spendLines = 0;
  for (let i = 0; i < ITER; i++) {
    for (const x of gen.randomInput(g, { chart: true, accounts: ACCOUNTS }).expenses) {
      if (!x.items) continue;
      itemized++;
      for (const it of x.items) {
        if (onBalanceSheet(it.accountId)) bsLines++;
        else spendLines++;
      }
    }
    gen.randomOpts(g);
    g.day();
    g.pick([1, 4, 7]);
  }
  assert.ok(
    itemized >= ITER / 5 && bsLines >= ITER / 10 && spendLines >= ITER / 5,
    `itemized ${itemized}, balance-sheet lines ${bsLines}, spending lines ${spendLines} in ${ITER} businesses`,
  );
});

test("Insights' spending by account is the ledger's profit and loss by account (when paid)", () => {
  const g = gen.makeGen(gen.rng(SEED + 3));
  const nonZero = (pairs) => new Map(pairs.filter(([, k]) => k));
  for (let i = 0; i < 600; i++) {
    const input = gen.randomInput(g, { chart: true, accounts: ACCOUNTS });
    const ctx = ctxFor("paid", gen.randomOpts(g).vat);
    const pl = ledger.profitAndLoss(ledger.buildLedger(input, ctx).entries, C);
    const want = nonZero(pl.expenses.map((r) => [r.account.id, kobo(r.amount)]));
    const got = nonZero(groupSpending(books.bookRows(input, "paid"), input.bankRows, { C, recurring: ctx.recurring })
      .map((r) => [r.accountId, kobo(r.amount)]));
    for (const id of new Set([...want.keys(), ...got.keys()])) {
      if (want.get(id) !== got.get(id)) {
        throw new Error(`iteration ${i}: ${(C.byId.get(id) || { name: id }).name}: Insights ${(got.get(id) || 0) / 100}, ledger ${(want.get(id) || 0) / 100}`);
      }
    }
  }
});

// What a business's real bank links are: how many of each kind, how many of
// its matched sales are bigger than their transfer, and how many linked
// records name a money account of their own too (the link must beat it).
function linksIn(input) {
  const n = { sale: 0, saleAbove: 0, repayment: 0, invoicePayment: 0, expense: 0, refund: 0, picked: 0 };
  const find = (list, id) => list.find((r) => r.id === id);
  for (const t of input.bankRows) {
    if (t.matchedSaleId) {
      const s = find(input.sales, t.matchedSaleId);
      n.sale++;
      if (s.amount > t.amount) n.saleAbove++;
      if (s.depositAccountId) n.picked++;
    }
    if (t.matchedCustomerId) n.repayment++;
    if (t.matchedInvoiceId) n.invoicePayment++;
    if (t.matchedExpenseId) {
      n.expense++;
      if (find(input.expenses, t.matchedExpenseId).paidThroughAccountId) n.picked++;
    }
    if (t.purpose === "customer_refund") n.refund++;
  }
  for (const p of [...input.debts.flatMap((d) => d.payments), ...input.invoices.flatMap((i) => i.payments)]) {
    if (p.transactionId && p.depositAccountId) n.picked++;
  }
  return n;
}

// Kobo left in Bank Matching once every record is in (any date).
const bankMatchingLeft = (entries) => ledger.sumByAccount(entries).get(sysId(chart.SYS.BANK_MATCH)) || 0;

const LINKED = Math.max(300, Math.round(ITER / 2));
test(`real bank links on both sides (${LINKED} businesses): Bank Matching nets to zero, and the books still tie out`, () => {
  const g = gen.makeGen(gen.rng(SEED + 11));
  const seen = { sale: 0, saleAbove: 0, repayment: 0, invoicePayment: 0, expense: 0, refund: 0, picked: 0 };
  for (let i = 0; i < LINKED; i++) {
    const input = gen.randomInput(g, { chart: true, accounts: ACCOUNTS, links: true });
    const opts = gen.randomOpts(g);
    for (const [k, v] of Object.entries(linksIn(input))) seen[k] += v;
    for (const basis of ["paid", "sold"]) {
      const L = ledger.buildLedger(input, ctxFor(basis, opts.vat));
      if (ledger.unbalanced(L.entries).length) throw new Error(`iteration ${i} (${basis}): unbalanced`);
      const left = bankMatchingLeft(L.entries);
      if (left) throw new Error(`iteration ${i} (${basis}): ${left / 100} left in Bank Matching`);
      const pl = ledger.profitAndLoss(L.entries, C, { from: opts.from, to: opts.to });
      const b = books.computeBooks(input, { ...opts, basis });
      if (kobo(pl.totalIncome) !== kobo(b.sales.total) || kobo(pl.totalExpenses) !== kobo(b.expenses.total)) {
        throw new Error(`iteration ${i} (${basis}): ledger ${pl.totalIncome}/${pl.totalExpenses} ≠ books ${b.sales.total}/${b.expenses.total}`);
      }
      const paidOut = expensesPaidInFull(input, L.entries);
      if (paidOut) throw new Error(`iteration ${i} (${basis}): ${paidOut}`);
      const asOf = g.day();
      const kb = ledger.sumByAccount(L.entries, { to: asOf }).get(sysId(chart.SYS.KASHBOOK)) || 0;
      if (kb !== rawLedgerKobo(input.bankRows, asOf)) throw new Error(`iteration ${i} (${basis}): KashBook Account ≠ bank ledger at ${asOf}`);
    }
  }
  // Every kind of link was drawn often, so none of them went unchecked.
  for (const [k, n] of Object.entries(seen)) assert.ok(n >= LINKED / 20, `only ${n} ${k} in ${LINKED} businesses`);
});

test("cash and bank accounts are the same in both views", () => {
  const g = gen.makeGen(gen.rng(SEED + 1));
  const money = ACCOUNTS.filter((a) => a.type === "cash" || a.type === "bank");
  for (let i = 0; i < 400; i++) {
    const input = gen.randomInput(g, { chart: true, accounts: ACCOUNTS });
    const vat = gen.randomOpts(g).vat;
    const paid = ledger.sumByAccount(ledger.buildLedger(input, ctxFor("paid", vat)).entries);
    const sold = ledger.sumByAccount(ledger.buildLedger(input, ctxFor("sold", vat)).entries);
    for (const a of money) {
      if ((paid.get(a.id) || 0) !== (sold.get(a.id) || 0)) {
        throw new Error(`iteration ${i}: ${a.name} paid ${(paid.get(a.id) || 0) / 100} ≠ sold ${(sold.get(a.id) || 0) / 100}`);
      }
    }
  }
});

console.log("\nLEDGER — FIXTURES");

const by = (L, id) => L.entries.find((e) => e.id === id);
const legsOf = (e) => {
  const out = {};
  for (const l of e.lines) {
    const name = C.byId.get(l.accountId).name;
    out[name] = (out[name] || 0) + l.k / 100;
  }
  return out;
};

test("a cash sale with VAT inside: Cash at Hand / Sales and VAT Payable", () => {
  const input = { sales: [{ id: "s1", amount: 10750, date: "2026-10-01", paymentMethod: "cash" }], accounts: {} };
  const L = ledger.buildLedger(input, ctxFor("paid", { enabled: true, rate: 7.5, inclusive: true }));
  assert.deepStrictEqual(legsOf(by(L, "sale:s1")), { "Cash at Hand": 10750, Sales: -10000, "VAT Payable": -750 });
});

test("a transfer fee: the debit leaves the KashBook Account with its fee", () => {
  const input = {
    bankRows: [{ id: "t1", type: "expense", amount: 10000, fee: 53.75, date: "2026-10-01", source: "anchor", paymentMethod: "bank", category: "transfer", currency: "NGN" }],
    accounts: {},
  };
  const L = ledger.buildLedger(input, ctxFor("paid"));
  assert.deepStrictEqual(legsOf(by(L, "bank:t1")), {
    "KashBook Account": -10053.75, "Bank Fees and Charges": 53.75, "Unexplained Bank Payments": 10000,
  });
});

test("a sale matched to a NUBAN credit meets it in Bank Matching, which nets to zero", () => {
  const input = {
    sales: [{ id: "s1", amount: 5000, date: "2026-10-01", paymentMethod: "transfer", matchedTransactionId: "t1" }],
    bankRows: [{ id: "t1", type: "income", amount: 5000, matchedSaleId: "s1", matchedAmount: 5000, date: "2026-10-01", source: "anchor", paymentMethod: "bank", category: "transfer", currency: "NGN" }],
    accounts: {},
  };
  const L = ledger.buildLedger(input, ctxFor("paid"));
  const sums = ledger.sumByAccount(L.entries);
  eq(sums.get(sysId(chart.SYS.BANK_MATCH)) || 0, 0, "Bank Matching");
  eq((sums.get(sysId(chart.SYS.KASHBOOK)) || 0) / 100, 5000, "KashBook Account");
  eq((sums.get(sysId(chart.SYS.SALES)) || 0) / 100, -5000, "Sales");
});

test("a sale matched to a smaller credit: Bank Matching takes the transfer, the rest is where the sale says", () => {
  const credit = (saleId, amount) => ({
    id: `t-${saleId}`, type: "income", amount, matchedSaleId: saleId, matchedAmount: amount,
    date: "2026-10-01", source: "anchor", paymentMethod: "bank", category: "transfer", currency: "NGN",
  });
  const sale = (id, amount, extra) => ({ id, amount, date: "2026-10-01", paymentMethod: "cash", matchedTransactionId: `t-${id}`, ...extra });
  // [what, the sale, its credit, the account the rest of the sale is in]
  const cases = [
    ["₦10,000 in cash, ₦4,000 of it by transfer", sale("s1", 10000), 4000, { "Cash at Hand": 6000 }],
    ["a ₦5,000 transfer the bank shaved ₦50 off", sale("s2", 5000, { paymentMethod: "transfer" }), 4950, { "Other Bank Account": 50 }],
    ["received into the POS account", sale("s3", 10000, { depositAccountId: sysId(chart.SYS.POS) }), 4000, { "POS Account": 6000 }],
    ["on credit, no debt tracking it", sale("s4", 8000, { paymentMethod: "credit", isCredit: true }), 5000, { "Accounts Receivable": 3000 }],
    ["marked \"bank\": its one transfer is linked, so the rest waits in Undeposited Funds", sale("s5", 10000, { paymentMethod: "bank" }), 4000, { "Undeposited Funds": 6000 }],
  ];
  for (const [what, s, amount, rest] of cases) {
    const input = { sales: [s], bankRows: [credit(s.id, amount)], accounts: {} };
    for (const basis of ["paid", "sold"]) {
      const L = ledger.buildLedger(input, ctxFor(basis));
      assert.deepStrictEqual(legsOf(by(L, `sale:${s.id}`)), { Sales: -s.amount, "Bank Matching": amount, ...rest }, `${what} (${basis})`);
      eq(bankMatchingLeft(L.entries), 0, `${what} (${basis}): Bank Matching`);
      eq(ledger.profitAndLoss(L.entries, C).totalIncome, books.computeBooks(input, { basis }).sales.total, `${what} (${basis}): income`);
    }
  }
});

test("an invoice with a discount, VAT and two line accounts, issued then paid by cash (when sold)", () => {
  const delivery = ACCOUNTS.find((a) => a.name === "Shipping Charge").id;
  const inv = {
    id: "i1", type: "invoice", status: "paid", issueDate: "2026-10-01", invoiceNumber: "INV-1",
    items: [{ id: "a", amount: 8000, accountId: null }, { id: "b", amount: 2000, accountId: delivery }],
    subtotal: 10000, discountAmount: 1000, taxAmount: 675, total: 9675, amountPaid: 9675,
    payments: [{ id: "p1", amount: 9675, method: "cash", date: "2026-10-03" }],
  };
  const L = ledger.buildLedger({ invoices: [inv], accounts: {} }, ctxFor("sold", { enabled: true, rate: 7.5 }));
  assert.deepStrictEqual(legsOf(by(L, "doc:i1")), {
    "Accounts Receivable": 9675, "VAT Payable": -675, Sales: -8000, "Shipping Charge": -2000, Discount: 1000,
  });
  assert.deepStrictEqual(legsOf(by(L, "ip:p1")), { "Cash at Hand": 9675, "Accounts Receivable": -9675 });
});

test("the same invoice when paid: the payment carries the lines, discount and VAT pro rata", () => {
  const inv = {
    id: "i1", type: "invoice", status: "partial", issueDate: "2026-10-01", invoiceNumber: "INV-1",
    items: [{ id: "a", amount: 8000 }, { id: "b", amount: 2000 }],
    subtotal: 10000, discountAmount: 1000, taxAmount: 675, total: 9675, amountPaid: 4837.5,
    payments: [{ id: "p1", amount: 4837.5, method: "transfer", date: "2026-10-03" }],
  };
  const L = ledger.buildLedger({ invoices: [inv], accounts: {} }, ctxFor("paid", { enabled: true, rate: 7.5 }));
  const legs = legsOf(by(L, "ip:p1"));
  eq(legs["Other Bank Account"], 4837.5, "money");
  eq(legs["VAT Payable"], -337.5, "VAT half");
  eq(Math.round((legs.Sales + legs.Discount) * 100) / 100, -4500, "net half");
  eq(legs.Discount, 500, "discount half");
});

test("an expense on equipment: Furniture and Equipment / Cash at Hand, and no spending", () => {
  const furniture = ACCOUNTS.find((a) => a.name === "Furniture and Equipment").id;
  const input = {
    expenses: [{ id: "e1", amount: 85000, date: "2026-10-01", paymentMethod: "cash", accountId: furniture }],
    accounts: { [furniture]: { cls: "asset", type: "fixed_asset" } },
  };
  const L = ledger.buildLedger(input, ctxFor("paid"));
  assert.deepStrictEqual(legsOf(by(L, "expense:e1")), { "Furniture and Equipment": 85000, "Cash at Hand": -85000 });
  eq(ledger.profitAndLoss(L.entries, C).totalExpenses, 0, "spending");
});

test("an itemized expense: an entry per line, the equipment line on the balance sheet, an unknown account by category", () => {
  const furniture = ACCOUNTS.find((a) => a.name === "Furniture and Equipment").id;
  const rent = ACCOUNTS.find((a) => a.name === "Rent").id;
  const input = {
    expenses: [{
      id: "e1", amount: 105500, date: "2026-10-01", paymentMethod: "cash", accountId: null, category: "rent",
      items: [
        { id: "l1", accountId: rent, category: "rent", amount: 20000 },
        { id: "l2", accountId: furniture, category: "other", amount: 85000 },
        { id: "l3", accountId: "gone", category: "transport", amount: 500 },
      ],
    }],
    accounts: { [rent]: { cls: "expense", type: "expense" }, [furniture]: { cls: "asset", type: "fixed_asset" } },
  };
  for (const basis of ["paid", "sold"]) {
    const L = ledger.buildLedger(input, ctxFor(basis));
    assert.deepStrictEqual(legsOf(by(L, "expense:e1:l1")), { Rent: 20000, "Cash at Hand": -20000 }, basis);
    assert.deepStrictEqual(legsOf(by(L, "expense:e1:l2")), { "Furniture and Equipment": 85000, "Cash at Hand": -85000 }, basis);
    assert.deepStrictEqual(legsOf(by(L, "expense:e1:l3")), { "Transport and Delivery": 500, "Cash at Hand": -500 }, basis);
    eq(by(L, "expense:e1"), undefined, `${basis}: no entry for the expense as a whole`);
    eq(ledger.profitAndLoss(L.entries, C).totalExpenses, 20500, `${basis} spending`);
    eq(books.computeBooks(input, { basis }).expenses.total, 20500, `${basis} books`);
    eq(expensesPaidInFull(input, L.entries), null, basis);
  }
});

test("an owner's money in: KashBook Account / Owner's Equity", () => {
  const input = {
    bankRows: [{ id: "t1", type: "income", amount: 200000, purpose: "owner_money", date: "2026-10-01", source: "anchor", paymentMethod: "bank", category: "transfer", currency: "NGN" }],
    accounts: {},
  };
  const L = ledger.buildLedger(input, ctxFor("sold"));
  assert.deepStrictEqual(legsOf(by(L, "bank:t1")), { "KashBook Account": 200000, "Owner's Equity": -200000 });
});

test("an unexplained credit: income when paid, Unexplained Receipts when sold", () => {
  const input = {
    bankRows: [{ id: "t1", type: "income", amount: 3000, date: "2026-10-01", source: "anchor", paymentMethod: "bank", category: "transfer", currency: "NGN" }],
    accounts: {},
  };
  assert.deepStrictEqual(legsOf(by(ledger.buildLedger(input, ctxFor("paid")), "bank:t1")), { "KashBook Account": 3000, "Unexplained Bank Receipts": -3000 });
  assert.deepStrictEqual(legsOf(by(ledger.buildLedger(input, ctxFor("sold")), "bank:t1")), { "KashBook Account": 3000, "Unexplained Receipts": -3000 });
});

test("a payroll debit lands in Salaries; an auto-debit in its rule's account", () => {
  const row = (id, reference) => ({ id, type: "expense", amount: 50000, date: "2026-10-01", reference, source: "anchor", paymentMethod: "bank", category: "transfer", currency: "NGN" });
  const L = ledger.buildLedger({ bankRows: [row("t1", "kbsal_abc"), row("t2", "kashbook_rec_r1_x"), row("t3", "kashbook_rec_r3_x")], accounts: {} }, ctxFor("paid"));
  eq(legsOf(by(L, "bank:t1"))["Salaries and Employee Wages"], 50000);
  eq(legsOf(by(L, "bank:t2")).Rent, 50000);
  eq(legsOf(by(L, "bank:t3"))["Advertising and Marketing"], 50000);
});

test("an auto-debit on a loan's rule: named on its row, the loan and no spending; an older row without it, the rule's category", () => {
  const loans = sysId(chart.SYS.LOANS);
  const accounts = Object.fromEntries(ACCOUNTS.map((a) => [a.id, { cls: chart.classOf(a.type), type: a.type }]));
  const row = (id, extra) => ({
    id, type: "expense", amount: 50000, fee: 53.75, date: "2026-10-01", reference: `kashbook_rec_r2_${id}`,
    source: "anchor", paymentMethod: "bank", category: "transfer", currency: "NGN", ...extra,
  });
  // t1 as the runner writes it now (utils/recurringExpenseRunner.js), t2 as
  // an auto-debit sent before that.
  const input = { bankRows: [row("t1", { accountId: loans, purpose: "account" }), row("t2")], accounts };
  for (const basis of ["paid", "sold"]) {
    const L = ledger.buildLedger(input, ctxFor(basis));
    assert.deepStrictEqual(legsOf(by(L, "bank:t1")), { "KashBook Account": -50053.75, "Bank Fees and Charges": 53.75, Loans: 50000 }, basis);
    assert.deepStrictEqual(legsOf(by(L, "bank:t2")), { "KashBook Account": -50053.75, "Bank Fees and Charges": 53.75, Rent: 50000 }, basis);
    const pl = ledger.profitAndLoss(L.entries, C);
    eq(pl.totalExpenses, 50107.5, `${basis}: the older row and both fees`);
    eq(books.computeBooks(input, { basis }).expenses.total, pl.totalExpenses, `${basis}: the books`);
  }
  const groups = groupSpending(books.bookRows(input, "paid"), input.bankRows, { C, recurring: RULES });
  assert.deepStrictEqual(groups.map((x) => [x.category, x.amount]).sort(), [["Bank Fees and Charges", 107.5], ["Rent", 50000]]);
});

test("opening balances: the stated balance holds, the difference goes to Opening Balance Adjustments", () => {
  const cash = sysId(chart.SYS.CASH);
  const input = { sales: [{ id: "s1", amount: 4000, date: "2026-09-15", paymentMethod: "cash" }], accounts: {} };
  const L = ledger.buildLedger(input, { ...ctxFor("paid"), openingDate: "2026-10-01", openings: [{ accountId: cash, debit: 25000, credit: 0 }] });
  eq((ledger.sumByAccount(L.entries, { to: "2026-10-01" }).get(cash) || 0) / 100, 25000, "cash on the opening day");
  eq(legsOf(by(L, "opening"))["Opening Balance Adjustments"], -21000, "the difference");
  eq(ledger.profitAndLoss(L.entries, C, { from: "2026-09-01", to: "2026-10-31" }).profit, 4000, "profit untouched");
});

test("an account statement reads by day with a running balance", () => {
  const input = {
    sales: [
      { id: "s2", amount: 300, date: "2026-10-05", paymentMethod: "cash" },
      { id: "s1", amount: 1000, date: "2026-10-01", paymentMethod: "cash" },
    ],
    expenses: [{ id: "e1", amount: 200, date: "2026-10-03", paymentMethod: "cash", category: "rent" }],
    accounts: {},
  };
  const L = ledger.buildLedger(input, ctxFor("paid"));
  const cash = sysId(chart.SYS.CASH);
  const st = ledger.accountTransactions(L.entries, cash, C.byId.get(cash), { from: "2026-10-02", to: "2026-10-31" });
  eq(st.opening, 1000, "opening");
  assert.deepStrictEqual(st.lines.map((l) => [l.day, l.amount, l.balance]), [["2026-10-03", -200, 800], ["2026-10-05", 300, 1100]]);
  eq(st.closing, 1100, "closing");
});

test("allocate splits exactly, any sign of weight", () => {
  const parts = ledger.allocate(1000, [3, 3, 3]);
  eq(parts.reduce((s, p) => s + p, 0), 1000, "sum");
  assert.deepStrictEqual(ledger.allocate(900, [800, 200, -100]), [800, 200, -100]);
});

console.log("\nLEDGER — A BROKEN ENGINE MUST FAIL");

// Mutations: each breaks one rule; the invariants above must catch it.
function invariantsHold(build) {
  const g = gen.makeGen(gen.rng(SEED + 7));
  for (let i = 0; i < 300; i++) {
    const input = gen.randomInput(g, { chart: true, accounts: ACCOUNTS });
    const opts = gen.randomOpts(g);
    const L = build(input, ctxFor(opts.basis, opts.vat));
    if (ledger.unbalanced(L.entries).length) return false;
    const pl = ledger.profitAndLoss(L.entries, C, { from: opts.from, to: opts.to });
    const b = books.computeBooks(input, opts);
    if (kobo(pl.totalIncome) !== kobo(b.sales.total) || kobo(pl.totalExpenses) !== kobo(b.expenses.total)) return false;
    const asOf = g.day();
    const kb = ledger.sumByAccount(L.entries, { to: asOf }).get(sysId(chart.SYS.KASHBOOK)) || 0;
    if (kb !== rawLedgerKobo(input.bankRows, asOf)) return false;
    if (expensesPaidInFull(input, L.entries)) return false;
  }
  return true;
}

const mutants = {
  "fees left off the bank row": (input, ctx) => ledger.buildLedger({ ...input, bankRows: input.bankRows.map((t) => ({ ...t, fee: 0 })) }, ctx),
  "an extra kobo on every sale": (input, ctx) => {
    const L = ledger.buildLedger(input, ctx);
    for (const e of L.entries) if (e.kind === "sale" && e.lines.length) e.lines[0].k += 1;
    return L;
  },
  "every bank row posted to the KashBook Account (legacy rows included)": (input, ctx) =>
    ledger.buildLedger({ ...input, bankRows: input.bankRows.map((t) => ({ ...t, source: "anchor", paymentMethod: "bank", category: "transfer" })) }, ctx),
  "a VAT leg dropped": (input, ctx) => {
    const L = ledger.buildLedger(input, ctx);
    const vatId = sysId(chart.SYS.VAT);
    for (const e of L.entries) e.lines = e.lines.filter((l) => l.accountId !== vatId);
    return L;
  },
  // The books inside the ledger forget that a line on equipment, a prepayment,
  // a loan or drawings is not spending.
  "a balance-sheet line of an itemized expense counted as spending": (input, ctx) =>
    ledger.buildLedger({
      ...input,
      expenses: input.expenses.map((x) => (x.items
        ? { ...x, items: x.items.map((it) => (onBalanceSheet(it.accountId) ? { ...it, accountId: null } : it)) }
        : x)),
    }, ctx),
  "a balance-sheet line of an itemized expense left out of the ledger": (input, ctx) => {
    const L = ledger.buildLedger(input, ctx);
    L.entries = L.entries.filter((e) => !(e.kind === "expense" && e.id.split(":").length === 3 &&
      e.lines.some((l) => l.k > 0 && onBalanceSheet(l.accountId))));
    return L;
  },
  // The ledger follows an auto-debit's rule to a loan or drawings although the
  // books count the debit, which names no account, as spending.
  "a counted auto-debit posted to its rule's balance-sheet account": (input, ctx) => {
    const real = chart.bankRowAccount;
    chart.bankRowAccount = (C2, tx, basis, recurring) => {
      const rule = recurring ? recurring.get(chart.recurringIdOf(tx)) : null;
      const own = chart.explicitAccount(C2, tx && tx.accountId);
      return !own && rule && rule.accountId ? chart.explicitAccount(C2, rule.accountId) : real(C2, tx, basis, recurring);
    };
    try {
      return ledger.buildLedger(input, ctx);
    } finally {
      chart.bankRowAccount = real;
    }
  },
  "an itemized expense posted whole as well as by its lines": (input, ctx) => {
    const L = ledger.buildLedger(input, ctx);
    for (const x of input.expenses) {
      if (!x.items || x.foreignCurrency) continue;
      const money = chart.moneyAccount(C, { accountId: x.paidThroughAccountId, linked: !!x.matchedTransactionId, method: x.paymentMethod, direction: "out" });
      const k = ledger.K(x.amount);
      L.entries.push({ id: `expense:${x.id}`, day: books.dayKey(x.date), kind: "expense", memo: "", ref: x.id,
        lines: [{ accountId: sysId(chart.SYS.OTHER_EXPENSES), k }, { accountId: money.id, k: -k }] });
    }
    return L;
  },
};
for (const [name, build] of Object.entries(mutants)) {
  test(`mutant caught: ${name}`, () => assert.ok(!invariantsHold(build), "the invariants did not notice"));
}
test("the real engine passes the same checks", () => assert.ok(invariantsHold(ledger.buildLedger)));

// Invariant 7 on books with real links, against engines that break it the way
// the ledger did before the review's fixes (2026-10-12).
function bankMatchingNets(build) {
  const g = gen.makeGen(gen.rng(SEED + 13));
  for (let i = 0; i < 300; i++) {
    const input = gen.randomInput(g, { chart: true, accounts: ACCOUNTS, links: true });
    const { vat } = gen.randomOpts(g);
    for (const basis of ["paid", "sold"]) if (bankMatchingLeft(build(input, ctxFor(basis, vat)).entries)) return false;
  }
  return true;
}
const linkMutants = {
  // The money account picked for a record beat its bank link (chart.moneyAccount).
  "a picked money account beats a bank link": (input, ctx) => {
    const real = chart.moneyAccount;
    chart.moneyAccount = (C2, m) => chart.explicitAccount(C2, m.accountId) || real(C2, { ...m, accountId: null });
    try {
      return ledger.buildLedger(input, ctx);
    } finally {
      chart.moneyAccount = real;
    }
  },
  // A matched sale took its whole amount out of Bank Matching (a credit sale
  // out of Accounts Receivable), whatever its transfer brought in.
  "a matched sale posted whole to Bank Matching": (input, ctx) => {
    const L = ledger.buildLedger(input, ctx);
    const sales = new Map((input.sales || []).map((s) => [s.id, s]));
    for (const e of L.entries) {
      const s = e.kind === "sale" ? sales.get(e.ref) : null;
      if (!s || !s.matchedTransactionId) continue;
      const k = e.lines.filter((l) => l.k > 0).reduce((t, l) => t + l.k, 0);
      e.lines = [...e.lines.filter((l) => l.k < 0), { accountId: sysId(s.isCredit ? chart.SYS.AR : chart.SYS.BANK_MATCH), k }];
    }
    return L;
  },
};
for (const [name, build] of Object.entries(linkMutants)) {
  test(`mutant caught by invariant 7: ${name}`, () => assert.ok(!bankMatchingNets(build), "Bank Matching still came to zero"));
}
test("the real engine nets Bank Matching to zero on the same books", () => assert.ok(bankMatchingNets(ledger.buildLedger)));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
