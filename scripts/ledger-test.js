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
// and, since release 2 (bills, bill payments linked to KashBook debits, manual
// journals, in the same random books):
//
//   8. every bill payment in the books is one entry taking its whole amount
//      from where it was paid; one kept outside the books posts nothing;
//   9. what each bill still owes in the books sits in its own account: in
//      Accounts Payable for a bill on spending "when sold" (nothing there
//      "when paid"), in the loan's account for a loan, the same in both views;
//  10. every journal the books take is one entry on its date with exactly its
//      lines; a draft, or one the books refuse, posts nothing;
//  11. stated opening balances hold on the opening date with bills and
//      journals dated before it;
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

// Where money can sit, as the engine reads a bill's "received into": an
// account on the balance sheet the engine does not keep itself.
const holdsMoney = (id) => {
  const a = id ? C.byId.get(id) : null;
  return !!a && onBalanceSheet(id) && !(a.systemKey && chart.CONTROLLED.includes(a.systemKey));
};

// Invariants 8 to 10 on one ledger: what is wrong, or null.
function r2Wrong(input, L, basis) {
  const byId = new Map();
  for (const e of L.entries) {
    if (!byId.has(e.id)) byId.set(e.id, []);
    byId.get(e.id).push(e);
  }
  const ap = sysId(chart.SYS.AP);
  const kOn = (entries, id) => entries.reduce((s, e) => s + e.lines.reduce((t, l) => t + (l.accountId === id ? l.k : 0), 0), 0);
  for (const bill of input.bills || []) {
    const spending = books.billIsSpending(bill, input.accounts);
    const own = onBalanceSheet(bill.accountId) ? C.byId.get(bill.accountId) : null;
    const posts = spending || !!own;
    let paid = 0;
    const mine = [...(byId.get(`bill:${bill.id}`) || [])];
    for (const p of bill.payments || []) {
      const list = byId.get(`bp:${p.id}`) || [];
      if (p.outsideBooks || !posts) {
        if (list.length) return `payment ${p.id} posted, though ${p.outsideBooks ? "it was kept outside the books" : "its bill posts nothing"}`;
        continue;
      }
      if (list.length !== 1) return `payment ${p.id} has ${list.length} entries`;
      const out = -list[0].lines.reduce((s, l) => s + (l.k < 0 ? l.k : 0), 0);
      if (out !== ledger.K(p.amount)) return `payment ${p.id} took ${out / 100} from where it was paid, not ${p.amount}`;
      paid += ledger.K(p.amount);
      mine.push(list[0]);
    }
    const inBooks = ledger.K(books.billBooksAmount(bill));
    if (spending) {
      const want = basis === "sold" ? paid - inBooks : 0;
      if (kOn(mine, ap) !== want) return `bill ${bill.id}: Accounts Payable holds ${kOn(mine, ap) / 100}, not ${want / 100}`;
    } else if (own) {
      const want = paid - (holdsMoney(bill.receivedViaAccountId) || bill.estimated ? inBooks : 0);
      if (kOn(mine, own.id) !== want) return `bill ${bill.id}: ${own.name} holds ${kOn(mine, own.id) / 100}, not ${want / 100}`;
    } else if (mine.length) {
      return `bill ${bill.id} posted, though its account is neither spending nor on the balance sheet`;
    }
  }
  for (const j of input.journals || []) {
    const list = byId.get(`mj:${j.id}`) || [];
    const takes = books.journalInBooks(j, input.accounts) && j.lines.every((l) => C.byId.get(l.accountId));
    if (!takes) {
      if (list.length) return `journal ${j.id} posted, though the books refuse it`;
      continue;
    }
    if (list.length !== 1) return `journal ${j.id} has ${list.length} entries`;
    if (list[0].day !== books.dayKey(j.date)) return `journal ${j.id} posted on ${list[0].day}, not ${books.dayKey(j.date)}`;
    const want = new Map();
    for (const l of j.lines) want.set(l.accountId, (want.get(l.accountId) || 0) + ledger.K(l.debit) - ledger.K(l.credit));
    for (const id of new Set([...want.keys(), ...list[0].lines.map((l) => l.accountId)])) {
      if ((want.get(id) || 0) !== kOn(list, id)) return `journal ${j.id}: ${(C.byId.get(id) || { name: id }).name} ${kOn(list, id) / 100}, not ${(want.get(id) || 0) / 100}`;
    }
  }
  return null;
}

// Starting balances on a random day for a few accounts that may have one
// (chart.pickerAllows "opening"): { openingDate, openings }.
const OPENABLE = ACCOUNTS.filter((a) => chart.pickerAllows("opening", a));
function randomOpenings(g) {
  const openings = [];
  const used = new Set();
  for (let i = 0, n = g.int(1, 4); i < n; i++) {
    const a = g.pick(OPENABLE);
    if (used.has(a.id)) continue;
    used.add(a.id);
    const amount = g.money();
    openings.push(g.chance(0.6) ? { accountId: a.id, debit: amount, credit: 0 } : { accountId: a.id, debit: 0, credit: amount });
  }
  return { openingDate: g.day(), openings };
}

// Invariant 11: each stated balance holds on the opening date, counting every
// entry dated before it (bills and journals among them) and the opening entry.
function openingWrong(L, ctx) {
  if (!ctx.openingDate || !(ctx.openings || []).length) return null;
  const D = ctx.openingDate;
  const held = new Map();
  for (const e of L.entries) {
    if (!(e.kind === "opening" || e.day < D)) continue;
    for (const l of e.lines) held.set(l.accountId, (held.get(l.accountId) || 0) + l.k);
  }
  for (const ob of ctx.openings) {
    const want = ledger.K(ob.debit) - ledger.K(ob.credit);
    const got = held.get(ob.accountId) || 0;
    if (got !== want) return `${C.byId.get(ob.accountId).name} holds ${got / 100} on ${D}, not the ${want / 100} stated`;
  }
  return null;
}

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

    const r2 = r2Wrong(input, L, opts.basis);
    if (r2) throw new Error(`iteration ${i} (${opts.basis}): ${r2}`);
  }
});

test("those books include bills and journals of every kind, in the books and not", () => {
  // The same draws as the test above, so these are the books it checked.
  const g = gen.makeGen(gen.rng(SEED));
  const n = { spending: 0, loan: 0, loanReceived: 0, noAccount: 0, estimated: 0, paid: 0, outside: 0, published: 0, pnlLines: 0, bsLines: 0, draft: 0, refused: 0 };
  for (let i = 0; i < ITER; i++) {
    const input = gen.randomInput(g, { chart: true, accounts: ACCOUNTS });
    for (const b of input.bills) {
      const acc = C.byId.get(b.accountId);
      if (!acc) n.noAccount++;
      else if (chart.classOf(acc.type) === "expense") n.spending++;
      else {
        n.loan++;
        if (b.receivedViaAccountId) n.loanReceived++;
      }
      if (b.estimated) n.estimated++;
      for (const p of b.payments) n[p.outsideBooks ? "outside" : "paid"]++;
    }
    for (const j of input.journals) {
      if (j.status !== "published") n.draft++;
      else if (!books.journalInBooks(j, input.accounts)) n.refused++;
      else {
        n.published++;
        for (const l of j.lines) n[onBalanceSheet(l.accountId) ? "bsLines" : "pnlLines"]++;
      }
    }
    gen.randomOpts(g);
    g.day();
    g.pick([1, 4, 7]);
  }
  for (const [k, v] of Object.entries(n)) assert.ok(v >= ITER / 30, `only ${v} ${k} in ${ITER} businesses`);
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
  const n = { sale: 0, saleAbove: 0, repayment: 0, invoicePayment: 0, expense: 0, refund: 0, billPayment: 0, loanPayment: 0, picked: 0 };
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
    if (t.matchedBillId) {
      const b = find(input.bills, t.matchedBillId);
      n.billPayment++;
      if (!books.billIsSpending(b, input.accounts)) n.loanPayment++;
      if (b.payments.find((p) => p.transactionId === t.id).paidThroughAccountId) n.picked++;
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
  const seen = { sale: 0, saleAbove: 0, repayment: 0, invoicePayment: 0, expense: 0, refund: 0, billPayment: 0, loanPayment: 0, picked: 0 };
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
      const r2 = r2Wrong(input, L, basis);
      if (r2) throw new Error(`iteration ${i} (${basis}): ${r2}`);
      const asOf = g.day();
      const kb = ledger.sumByAccount(L.entries, { to: asOf }).get(sysId(chart.SYS.KASHBOOK)) || 0;
      if (kb !== rawLedgerKobo(input.bankRows, asOf)) throw new Error(`iteration ${i} (${basis}): KashBook Account ≠ bank ledger at ${asOf}`);
    }
  }
  // Every kind of link was drawn often, so none of them went unchecked.
  for (const [k, n] of Object.entries(seen)) assert.ok(n >= LINKED / 20, `only ${n} ${k} in ${LINKED} businesses`);
});

const OPENED = Math.max(300, Math.round(ITER / 3));
test(`opening balances hold on their date with bills and journals dated before it (${OPENED} businesses, both views)`, () => {
  const g = gen.makeGen(gen.rng(SEED + 19));
  let touched = 0; // openings a bill or journal entry before the date moved
  for (let i = 0; i < OPENED; i++) {
    const input = gen.randomInput(g, { chart: true, accounts: ACCOUNTS, links: g.chance(0.5) });
    const { vat } = gen.randomOpts(g);
    const opening = randomOpenings(g);
    for (const basis of ["paid", "sold"]) {
      const ctx = { ...ctxFor(basis, vat), ...opening };
      const L = ledger.buildLedger(input, ctx);
      if (ledger.unbalanced(L.entries).length) throw new Error(`iteration ${i} (${basis}): unbalanced`);
      const wrong = openingWrong(L, ctx) || r2Wrong(input, L, basis);
      if (wrong) throw new Error(`iteration ${i} (${basis}): ${wrong}`);
      const tb = ledger.trialBalance(L.entries, C, opening.openingDate);
      if (!tb.balanced) throw new Error(`iteration ${i} (${basis}): trial balance off on the opening date`);
      for (const ob of opening.openings) {
        if (L.entries.some((e) => /^(bill|bp|mj):/.test(e.id) && e.day < opening.openingDate && e.lines.some((l) => l.accountId === ob.accountId))) touched++;
      }
    }
  }
  assert.ok(touched >= OPENED / 10, `only ${touched} openings had a bill or journal before them`);
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

test("a category merged into an account books there, and so do its older names; an account's own category is never another's", () => {
  // The chart once Fumigation, and Electricity and Utilities ("utility"),
  // merged into Advertising and Marketing (release 1.1): the account they
  // merged into stands for their categories too. "rent" is listed as well,
  // though no merge leaves a category another account stands for: Rent keeps it.
  const merged = ACCOUNTS.filter((a) => a.categorySlug !== "utility").map((a) =>
    a.name === "Advertising and Marketing" ? { ...a, aliasSlugs: ["fumigation", "utility", "rent"] } : a,
  );
  const ad = merged.find((a) => a.name === "Advertising and Marketing").id;
  const rent = merged.find((a) => a.name === "Rent").id;
  const other = merged.find((a) => a.systemKey === chart.SYS.OTHER_EXPENSES).id;
  // Both ways round, so no account wins by where it is listed.
  for (const list of [merged, [...merged].reverse()]) {
    const X = chart.indexChart(list);
    const on = (category) => chart.expenseAccount(X, { category }).id;
    eq(on("Fumigation"), ad, "a merged category");
    eq(on("electricity"), ad, "an older name of a merged category");
    eq(on("marketing"), ad, "its own");
    eq(on("rent"), rent, "another account's own category");
    eq(on("snacks"), other, "a category nothing stands for");
    const input = { expenses: [{ id: "e1", amount: 700, date: "2026-10-01", paymentMethod: "cash", category: "fumigation" }], accounts: {} };
    const L = ledger.buildLedger(input, { ...ctxFor("paid"), chart: X });
    eq(by(L, "expense:e1").lines.find((l) => l.k > 0).accountId, ad, "the ledger books it there");
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

// ── Release 2: bills and manual journals ──
const acct = (name) => ACCOUNTS.find((a) => a.name === name).id;
const CLASSES = Object.fromEntries(ACCOUNTS.map((a) => [a.id, { cls: chart.classOf(a.type), type: a.type }]));
const bpay = (id, amount, date, over = {}) => ({ id, amount, date, method: "cash", transactionId: null, outsideBooks: false, ...over });
const anchorDebit = (over) => ({ type: "expense", source: "anchor", paymentMethod: "bank", category: "transfer", currency: "NGN", ...over });

test("a bill on rent paid in two parts: when paid each payment is the spending; when sold the bill is owed, then settled", () => {
  const input = {
    bills: [{
      id: "b1", accountId: acct("Rent"), billDate: "2026-10-02", amount: 50000, vendorName: "Landlord",
      payments: [bpay("p1", 20000, "2026-10-05"), bpay("p2", 30000, "2026-11-03", { method: "transfer" })],
    }],
    accounts: CLASSES,
  };
  const paid = ledger.buildLedger(input, ctxFor("paid"));
  assert.deepStrictEqual(legsOf(by(paid, "bp:p1")), { Rent: 20000, "Cash at Hand": -20000 });
  assert.deepStrictEqual(legsOf(by(paid, "bp:p2")), { Rent: 30000, "Other Bank Account": -30000 });
  eq(by(paid, "bill:b1"), undefined, "paid: no entry for the bill itself");
  eq(by(paid, "bp:p1").day, "2026-10-05", "paid: on the payment's day");
  eq(by(paid, "bp:p1").ref, "b1", "an entry names its bill");
  eq(by(paid, "bp:p1").memo, "Landlord", "and its supplier");
  const sold = ledger.buildLedger(input, ctxFor("sold"));
  assert.deepStrictEqual(legsOf(by(sold, "bill:b1")), { Rent: 50000, "Accounts Payable": -50000 });
  eq(by(sold, "bill:b1").day, "2026-10-02", "sold: on the bill date");
  assert.deepStrictEqual(legsOf(by(sold, "bp:p1")), { "Accounts Payable": 20000, "Cash at Hand": -20000 });
  assert.deepStrictEqual(legsOf(by(sold, "bp:p2")), { "Accounts Payable": 30000, "Other Bank Account": -30000 });
  eq(ledger.sumByAccount(sold.entries, { to: "2026-10-31" }).get(sysId(chart.SYS.AP)) / 100, -30000, "sold: still owed at the end of October");
  for (const [L, basis] of [[paid, "paid"], [sold, "sold"]]) {
    for (const r of [{}, { from: "2026-10-01", to: "2026-10-31" }, { from: "2026-11-01", to: "2026-11-30" }]) {
      eq(ledger.profitAndLoss(L.entries, C, r).totalExpenses, books.computeBooks(input, { basis, ...r }).expenses.total, `${basis} ${JSON.stringify(r)}`);
    }
  }
});

test("a bill paid from the KashBook account: the debit leaves the payment in Bank Matching, the payment takes it out, the rest is still a debit", () => {
  const input = {
    bankRows: [anchorDebit({ id: "t1", amount: 12000, fee: 26.88, matchedBillId: "b1", matchedAmount: 10000, date: "2026-10-06" })],
    bills: [{
      id: "b1", accountId: acct("Rent"), billDate: "2026-10-01", amount: 10000,
      payments: [bpay("p1", 10000, "2026-10-06", { method: "bank", transactionId: "t1" })],
    }],
    accounts: CLASSES,
  };
  for (const basis of ["paid", "sold"]) {
    const L = ledger.buildLedger(input, ctxFor(basis));
    assert.deepStrictEqual(legsOf(by(L, "bank:t1")), {
      "KashBook Account": -12026.88, "Bank Fees and Charges": 26.88, "Bank Matching": 10000, "Unexplained Bank Payments": 2000,
    }, basis);
    assert.deepStrictEqual(legsOf(by(L, "bp:p1")), basis === "paid"
      ? { Rent: 10000, "Bank Matching": -10000 }
      : { "Accounts Payable": 10000, "Bank Matching": -10000 }, basis);
    eq(bankMatchingLeft(L.entries), 0, `${basis}: Bank Matching`);
    eq(ledger.profitAndLoss(L.entries, C).totalExpenses, 12026.88, `${basis}: the money that left, once`);
    eq(books.computeBooks(input, { basis }).expenses.total, 12026.88, `${basis}: the books`);
  }
});

test("a payment above what its debit left: Bank Matching gives what the debit left, the rest waits in Undeposited Funds", () => {
  // The route never saves this (matchedAmount is the payment); the ledger
  // still balances and leaves nothing behind in Bank Matching.
  const input = {
    bankRows: [anchorDebit({ id: "t1", amount: 8000, matchedBillId: "b1", matchedAmount: 8000, date: "2026-10-06" })],
    bills: [{
      id: "b1", accountId: acct("Rent"), billDate: "2026-10-01", amount: 10000,
      payments: [bpay("p1", 10000, "2026-10-06", { method: "bank", transactionId: "t1" })],
    }],
    accounts: CLASSES,
  };
  const L = ledger.buildLedger(input, ctxFor("paid"));
  assert.deepStrictEqual(legsOf(by(L, "bp:p1")), { Rent: 10000, "Bank Matching": -8000, "Undeposited Funds": -2000 });
  eq(bankMatchingLeft(L.entries), 0, "Bank Matching");
  eq(ledger.unbalanced(L.entries).length, 0, "balanced");
});

test("a loan: received into Cash at Hand on the bill date, paid back by transfer, never profit, the same in both views", () => {
  const input = {
    bills: [{
      id: "b1", accountId: sysId(chart.SYS.LOANS), receivedViaAccountId: sysId(chart.SYS.CASH), billDate: "2026-09-01",
      amount: 500000, vendorName: "First Bank", payments: [bpay("p1", 50000, "2026-10-01", { method: "transfer" })],
    }],
    accounts: CLASSES,
  };
  for (const basis of ["paid", "sold"]) {
    const L = ledger.buildLedger(input, ctxFor(basis));
    assert.deepStrictEqual(legsOf(by(L, "bill:b1")), { "Cash at Hand": 500000, Loans: -500000 }, basis);
    assert.deepStrictEqual(legsOf(by(L, "bp:p1")), { Loans: 50000, "Other Bank Account": -50000 }, basis);
    eq(ledger.sumByAccount(L.entries).get(sysId(chart.SYS.LOANS)) / 100, -450000, `${basis}: still owed`);
    eq(ledger.profitAndLoss(L.entries, C).profit, 0, `${basis}: no profit or loss`);
    eq(books.computeBooks(input, { basis }).profit, 0, `${basis}: the books`);
  }
  // Received nowhere named (a loan already in the starting balances): only
  // the payments post.
  const plain = { ...input, bills: [{ ...input.bills[0], receivedViaAccountId: null }] };
  const L = ledger.buildLedger(plain, ctxFor("sold"));
  eq(by(L, "bill:b1"), undefined, "no entry on the bill date");
  assert.deepStrictEqual(legsOf(by(L, "bp:p1")), { Loans: 50000, "Other Bank Account": -50000 });
});

test("a loan from before bills that names nowhere: its open part owed from its bill date against Opening Balance Adjustments", () => {
  const input = {
    bills: [{
      id: "b1", accountId: sysId(chart.SYS.LOANS), receivedViaAccountId: null, billDate: "2026-05-01", amount: 500000,
      estimated: true, vendorName: "Cousin",
      payments: [bpay("p0", 100000, "2026-06-01", { outsideBooks: true, estimated: true }), bpay("p1", 50000, "2026-10-02")],
    }],
    accounts: CLASSES,
  };
  for (const basis of ["paid", "sold"]) {
    const L = ledger.buildLedger(input, ctxFor(basis));
    assert.deepStrictEqual(legsOf(by(L, "bill:b1")), { "Opening Balance Adjustments": 400000, Loans: -400000 }, basis);
    eq(by(L, "bill:b1").day, "2026-05-01", `${basis}: on the bill date`);
    assert.deepStrictEqual(legsOf(by(L, "bp:p1")), { Loans: 50000, "Cash at Hand": -50000 }, basis);
    eq(by(L, "bp:p0"), undefined, `${basis}: nothing for the payment outside the books`);
    eq(ledger.sumByAccount(L.entries).get(sysId(chart.SYS.LOANS)) / 100, -350000, `${basis}: what the bill still owes`);
    eq(ledger.profitAndLoss(L.entries, C).profit, 0, `${basis}: no profit or loss`);
  }
});

test("a loan said to be received into spending or the KashBook Account (never allowed) posts nothing there", () => {
  for (const via of [acct("Rent"), sysId(chart.SYS.KASHBOOK), sysId(chart.SYS.AP)]) {
    const input = {
      bills: [{ id: "b1", accountId: sysId(chart.SYS.LOANS), receivedViaAccountId: via, billDate: "2026-09-01", amount: 1000, payments: [] }],
      accounts: CLASSES,
    };
    for (const basis of ["paid", "sold"]) {
      const L = ledger.buildLedger(input, ctxFor(basis));
      eq(L.entries.length, 0, `${C.byId.get(via).name} (${basis})`);
      eq(books.computeBooks(input, { basis }).profit, 0, basis);
    }
  }
});

test("a payable from before bills: when sold Accounts Payable holds only the open part; its payment outside the books posts nothing", () => {
  const input = {
    bills: [{
      id: "b1", accountId: sysId(chart.SYS.COGS), billDate: "2026-09-10", amount: 80000, estimated: true, vendorName: "Ada Supplies",
      payments: [bpay("p0", 30000, "2026-09-20", { outsideBooks: true, estimated: true }), bpay("p1", 15000, "2026-10-04")],
    }],
    accounts: CLASSES,
  };
  const sold = ledger.buildLedger(input, ctxFor("sold"));
  assert.deepStrictEqual(legsOf(by(sold, "bill:b1")), { "Cost of Goods Sold": 50000, "Accounts Payable": -50000 });
  assert.deepStrictEqual(legsOf(by(sold, "bp:p1")), { "Accounts Payable": 15000, "Cash at Hand": -15000 });
  eq(by(sold, "bp:p0"), undefined, "sold: nothing for the payment outside the books");
  eq(ledger.sumByAccount(sold.entries).get(sysId(chart.SYS.AP)) / 100, -35000, "what is still owed");
  const paid = ledger.buildLedger(input, ctxFor("paid"));
  assert.deepStrictEqual(legsOf(by(paid, "bp:p1")), { "Cost of Goods Sold": 15000, "Cash at Hand": -15000 });
  eq(by(paid, "bp:p0"), undefined, "paid: nothing for it either");
  eq(paid.entries.length, 1, "paid: the one real payment");
});

test("a journal moving rent paid ahead into spending: one entry on its date in both views, profit by account equal to the books", () => {
  const input = {
    journals: [
      {
        id: "j1", number: "MJ-00001", date: "2026-10-10", status: "published", note: "Rent used up",
        lines: [
          { id: "l1", accountId: acct("Rent"), debit: 30000, credit: 0 },
          { id: "l2", accountId: acct("Prepaid Expenses"), debit: 0, credit: 30000 },
        ],
      },
      {
        id: "j2", number: "MJ-00002", date: "2026-10-11", status: "draft",
        lines: [{ id: "l3", accountId: acct("Rent"), debit: 100, credit: 0 }, { id: "l4", accountId: sysId(chart.SYS.CASH), debit: 0, credit: 100 }],
      },
      {
        id: "j3", number: "MJ-00003", date: "2026-10-12", status: "published",
        lines: [
          { id: "l5", accountId: sysId(chart.SYS.SALES), debit: 2000, credit: 0 },
          { id: "l6", accountId: acct("Interest Income"), debit: 0, credit: 500 },
          { id: "l7", accountId: sysId(chart.SYS.CASH), debit: 0, credit: 1500 },
        ],
      },
    ],
    accounts: CLASSES,
  };
  for (const basis of ["paid", "sold"]) {
    const L = ledger.buildLedger(input, ctxFor(basis));
    assert.deepStrictEqual(legsOf(by(L, "mj:j1")), { Rent: 30000, "Prepaid Expenses": -30000 }, basis);
    assert.deepStrictEqual(legsOf(by(L, "mj:j3")), { Sales: 2000, "Interest Income": -500, "Cash at Hand": -1500 }, basis);
    eq(by(L, "mj:j1").memo, "Rent used up", "the journal's note");
    eq(by(L, "mj:j3").memo, "MJ-00003", "else its number");
    eq(by(L, "mj:j2"), undefined, `${basis}: a draft posts nothing`);
    const pl = ledger.profitAndLoss(L.entries, C);
    const b = books.computeBooks(input, { basis });
    eq(pl.totalIncome, b.sales.total, `${basis} income`);
    eq(pl.totalIncome, -1500, `${basis}: sales down 2,000, interest up 500`);
    eq(pl.totalExpenses, b.expenses.total, `${basis} expenses`);
  }
});

test("opening balances see bills and journals dated before the opening date", () => {
  const cash = sysId(chart.SYS.CASH);
  const input = {
    bills: [{ id: "b1", accountId: acct("Rent"), billDate: "2026-09-01", amount: 5000, payments: [bpay("p1", 5000, "2026-09-20")] }],
    journals: [{
      id: "j1", date: "2026-09-25", status: "published",
      lines: [{ id: "l1", accountId: acct("Prepaid Expenses"), debit: 2000, credit: 0 }, { id: "l2", accountId: cash, debit: 0, credit: 2000 }],
    }],
    accounts: CLASSES,
  };
  for (const basis of ["paid", "sold"]) {
    const ctx = { ...ctxFor(basis), openingDate: "2026-10-01", openings: [{ accountId: cash, debit: 25000, credit: 0 }] };
    const L = ledger.buildLedger(input, ctx);
    eq((ledger.sumByAccount(L.entries, { to: "2026-10-01" }).get(cash) || 0) / 100, 25000, `${basis}: cash on the opening day`);
    eq(legsOf(by(L, "opening"))["Opening Balance Adjustments"], -32000, `${basis}: the difference, the bill and the journal included`);
    eq(openingWrong(L, ctx), null, basis);
  }
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

// Release 2's rules: every invariant above and 8 to 11, on random books with
// bills, journals and starting balances (with real bank links, or one-sided
// ones), in both views. What is wrong, or null.
function r2Holds(build, links) {
  const g = gen.makeGen(gen.rng(SEED + (links ? 23 : 29)));
  for (let i = 0; i < 300; i++) {
    const input = gen.randomInput(g, { chart: true, accounts: ACCOUNTS, links });
    const opts = gen.randomOpts(g);
    const opening = randomOpenings(g);
    for (const basis of ["paid", "sold"]) {
      const ctx = { ...ctxFor(basis, opts.vat), ...opening };
      const L = build(input, ctx);
      if (ledger.unbalanced(L.entries).length) return `iteration ${i} (${basis}): unbalanced`;
      const pl = ledger.profitAndLoss(L.entries, C, { from: opts.from, to: opts.to });
      const b = books.computeBooks(input, { ...opts, basis });
      if (kobo(pl.totalIncome) !== kobo(b.sales.total) || kobo(pl.totalExpenses) !== kobo(b.expenses.total)) {
        return `iteration ${i} (${basis}): ledger ${pl.totalIncome}/${pl.totalExpenses} ≠ books ${b.sales.total}/${b.expenses.total}`;
      }
      const asOf = opening.openingDate;
      if ((ledger.sumByAccount(L.entries, { to: asOf }).get(sysId(chart.SYS.KASHBOOK)) || 0) !== rawLedgerKobo(input.bankRows, asOf)) {
        return `iteration ${i} (${basis}): KashBook Account ≠ bank ledger`;
      }
      if (links && bankMatchingLeft(L.entries)) return `iteration ${i} (${basis}): ${bankMatchingLeft(L.entries) / 100} left in Bank Matching`;
      const wrong = r2Wrong(input, L, basis) || openingWrong(L, ctx);
      if (wrong) return `iteration ${i} (${basis}): ${wrong}`;
    }
  }
  return null;
}

const mapBills = (input, fn) => ({ ...input, bills: input.bills.map(fn) });
const dropEntries = (pattern) => (input, ctx) => {
  const L = ledger.buildLedger(input, ctx);
  L.entries = L.entries.filter((e) => !pattern(e, input));
  return L;
};
// [links?, engine]: each breaks one rule of release 2.
const r2Mutants = {
  "a bill for a loan counted as spending": [false, (input, ctx) =>
    ledger.buildLedger(mapBills(input, (b) => (books.billIsSpending(b, input.accounts) ? b : { ...b, accountId: null })), ctx)],
  "a payment kept outside the books posted as paid": [false, (input, ctx) =>
    ledger.buildLedger(mapBills(input, (b) => ({ ...b, payments: b.payments.map((p) => ({ ...p, outsideBooks: false })) })), ctx)],
  "a payable from before bills counted in full when sold": [false, (input, ctx) =>
    ledger.buildLedger(mapBills(input, (b) => ({ ...b, payments: b.payments.filter((p) => !p.outsideBooks) })), ctx)],
  "a debit that paid a bill still counted whole": [false, (input, ctx) =>
    ledger.buildLedger({ ...input, bankRows: input.bankRows.map(({ matchedBillId, ...t }) => t) }, ctx)],
  "a bill payment from the KashBook account not taken out of Bank Matching": [true, (input, ctx) =>
    ledger.buildLedger(mapBills(input, (b) => ({ ...b, payments: b.payments.map((p) => ({ ...p, transactionId: null })) })), ctx)],
  "bills left out of the ledger": [false, dropEntries((e) => /^(bill|bp):/.test(e.id))],
  // Only a loan's money received: no profit moves, so only invariant 9 sees it.
  "a loan's money received left out": [false, dropEntries((e, input) =>
    e.kind === "bill" && !books.billIsSpending(input.bills.find((b) => b.id === e.ref), input.accounts))],
  "\"when sold\", payments not settling Accounts Payable": [false, (input, ctx) => {
    const L = ledger.buildLedger(input, ctx);
    if (ctx.basis === "sold") L.entries = L.entries.filter((e) => !(e.kind === "bill_payment" && e.lines.some((l) => l.accountId === sysId(chart.SYS.AP))));
    return L;
  }],
  "journals left out of the ledger": [false, dropEntries((e) => e.kind === "journal")],
  "a journal's balance-sheet lines dropped": [false, (input, ctx) => {
    const L = ledger.buildLedger(input, ctx);
    for (const e of L.entries) if (e.kind === "journal") e.lines = e.lines.filter((l) => !onBalanceSheet(l.accountId));
    return L;
  }],
  "a draft journal posted": [false, (input, ctx) =>
    ledger.buildLedger({ ...input, journals: input.journals.map((j) => ({ ...j, status: "published" })) }, ctx)],
  "a journal the books refuse posted anyway": [false, (input, ctx) => {
    const real = books.journalInBooks;
    books.journalInBooks = (j) => !!j && j.status === "published";
    try {
      return ledger.buildLedger(input, ctx);
    } finally {
      books.journalInBooks = real;
    }
  }],
  "bills and journals left out of what the opening entry counts": [false, (input, ctx) => {
    const full = ledger.buildLedger(input, { ...ctx, openingDate: null, openings: [] });
    const before = new Map();
    for (const e of full.entries) {
      if (!(e.day < ctx.openingDate) || /^(bill|bp|mj):/.test(e.id)) continue;
      for (const l of e.lines) before.set(l.accountId, (before.get(l.accountId) || 0) + l.k);
    }
    const lines = [];
    for (const ob of ctx.openings) {
      const diff = ledger.K(ob.debit) - ledger.K(ob.credit) - (before.get(ob.accountId) || 0);
      if (diff) lines.push({ accountId: ob.accountId, k: diff }, { accountId: sysId(chart.SYS.OPENING), k: -diff });
    }
    return { basis: full.basis, entries: [{ id: "opening", day: ctx.openingDate, kind: "opening", memo: "", ref: null, lines }, ...full.entries] };
  }],
};
for (const [name, [links, build]] of Object.entries(r2Mutants)) {
  test(`mutant caught (release 2): ${name}`, () => assert.ok(r2Holds(build, links), "every invariant still held"));
}
test("the real engine keeps every release 2 invariant on the same books", () => {
  for (const links of [false, true]) {
    const wrong = r2Holds(ledger.buildLedger, links);
    assert.ok(!wrong, `${links ? "with links" : "one-sided links"}: ${wrong}`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
