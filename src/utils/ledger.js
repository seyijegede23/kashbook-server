// The ledger (chart of accounts, 2026-10-11): double-entry books DERIVED from
// the records every time, never posted. Each record becomes a balanced entry:
//
//   - its profit-and-loss side comes from the books rule's own events
//     (books.bookEvents), so the profit and loss by account always equals
//     computeBooks for the same period and view;
//   - its money side follows the record (utils/chart.js moneyAccount): a bank
//     link (through Bank Matching), else the account picked, else the payment
//     method; a sale's link carries only what its transfer brought in, and
//     the rest of the sale is where the sale says, so a sale above its
//     transfer leaves nothing behind in Bank Matching;
//   - an itemized expense posts one entry per line ("expense:<id>:<line>"),
//     each at the line's account, so a line on equipment sits on the balance
//     sheet while its siblings are spending;
//   - a bank row posts as a whole against the KashBook Account (only rows the
//     bank ledger counts: config/moneySources.isLedgerBankRow), so that account
//     equals computeRawLedger at any date;
//   - "when sold" adds what the books rule leaves outside profit: invoices and
//     credit given owed by customers (Accounts Receivable), payments against
//     them, unexplained credits (Unexplained Receipts);
//   - bills (release 2): on spending, "when paid" each payment is the
//     spending, paid from its money; "when sold" the bill is spending on its
//     date, owed in Accounts Payable, and each payment settles it. A payment
//     from the KashBook account meets its debit in Bank Matching, as a sale
//     meets its credit. A bill for a loan (or any balance-sheet account) is
//     never profit: in both views the money borrowed comes in where the bill
//     says it went, and each payment pays the loan back. A loan from before
//     bills that says nowhere is owed from its bill date against Opening
//     Balance Adjustments, as a starting balance would be. A payment kept
//     outside the books posts nothing;
//   - published manual journals post their lines on their date, in both
//     views: their profit-and-loss lines from the books rule's events, the
//     rest as written;
//   - stock (release 3): Inventory Asset holds what the goods on hand cost,
//     and equals the sum of every stock movement's value at any date. Goods
//     a sale or an issued invoice takes out leave it on the document's date:
//     "when sold" into Cost of Goods Sold, "when paid" into Goods Sold
//     Awaiting Payment, which releases them into Cost of Goods Sold as the
//     books count the money, or credit from a credit note is applied, and
//     all that still waits when an invoice is written off (a sale paid on
//     the spot: straight away). A
//     credit note that puts goods back does the mirror. A sale's income is
//     shared over its lines' accounts, as an invoice's is. A restock is a
//     bill on Inventory Asset: in both views the goods come in on its bill
//     date, owed in Accounts Payable, and each payment settles it. Stock
//     counted or valued again moves Inventory Asset against Stock
//     Adjustments; starting stock against Opening Balance Adjustments;
//   - cash deposits (2026-10-14): cash taken from the till to a bank, never
//     profit, in both views on the deposit's date: into another bank, that
//     bank / Cash at Hand; into the KashBook account, Undeposited Funds /
//     Cash at Hand while the cash is on its way, and the credit it is linked
//     to posts KashBook Account / Undeposited Funds when it arrives, whatever
//     account that credit carries (a cash_deposit credit no deposit names
//     still posts against Cash at Hand). A deposit's own entry is the same
//     whether it waits or has arrived: a link moves only its credit's entry,
//     on the credit's day. A cancelled deposit posts nothing;
//   - opening balances post the difference between what the merchant says an
//     account held when the books start and what the records already put
//     there, bills and journals included (the opening entry is built last).
//
// Amounts are integer kobo inside the engine; every split adds up exactly.
const books = require("./books");
const chart = require("./chart");
const { isLedgerBankRow } = require("../config/moneySources");

const { SYS } = chart;

// naira → kobo
function K(n) {
  return Math.round((Number(n) || 0) * 100);
}

function lower(v) {
  return String(v == null ? "" : v).toLowerCase();
}

// Split `total` kobo (≥ 0) over `weights` (any sign, summing above zero) in
// proportion, exactly: floors, then one kobo each to the largest remainders.
function allocate(total, weights) {
  const W = weights.reduce((s, w) => s + w, 0);
  if (!(W > 0)) return weights.map((_, i) => (i === 0 ? total : 0));
  const raw = weights.map((w) => (total * w) / W);
  const parts = raw.map((x) => Math.floor(x));
  let rest = total - parts.reduce((s, p) => s + p, 0);
  const order = raw.map((x, i) => [x - Math.floor(x), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let j = 0; rest > 0 && j < order.length; j++, rest--) parts[order[j][1]] += 1;
  return parts;
}

// ctx: { chart (chart.indexChart of the business's accounts), basis, vat,
//        baseCurrency, recurring (Map id → recurring rule), openingDate,
//        openings: [{ accountId, debit, credit }],
//        cashDeposits: [{ id, amount, date, into, intoAccountId, status, note }]
//          (the business's cash deposits; a cancelled one is skipped),
//        depositCredits: Set of the ids of the credits an arrived KashBook
//          deposit names }
// input: loadBooksInput(...).input (the books rule's input, every date).
function buildLedger(input, ctx) {
  const basis = ctx.basis === "sold" ? "sold" : "paid";
  const vat = books.vatSettings(ctx.vat);
  const C = ctx.chart;
  const base = ctx.baseCurrency || "NGN";
  const depositCredits = ctx.depositCredits instanceof Set ? ctx.depositCredits : new Set(ctx.depositCredits || []);
  const sys = (key) => {
    const a = chart.sysAccount(C, key);
    if (!a) throw new Error(`chart has no "${key}" account (run ensureChart)`);
    return a;
  };
  // The VAT a line carries is VAT Payable only when the business charges VAT;
  // otherwise computeBooks counts it as sales, and so does the ledger.
  const vatLeg = (v) => (vat.enabled ? K(v) : 0);

  const entries = [];
  function entry(id, day, kind, memo, ref) {
    const e = { id, day: books.dayKey(day), kind, memo: memo || "", ref: ref || null, lines: [] };
    entries.push(e);
    const post = (acc, k) => {
      if (!k) return;
      if (!acc) throw new Error(`entry ${id}: no account for ${k}`);
      e.lines.push({ accountId: acc.id, k });
    };
    const api = {
      dr(acc, k) { post(acc, k); return api; },
      cr(acc, k) { post(acc, -k); return api; },
    };
    return api;
  }

  const salesById = new Map((input.sales || []).map((s) => [s.id, s]));
  // A sale's money side waits for the bank rows, which say how much of it its
  // transfer brought in (see "Sales: where the money is").
  const pendingSales = []; // { e, rec, gross }: the sale's entry, its income and VAT posted
  const linkedToSale = new Map(); // sale id → kobo its transfer left in Bank Matching for it
  // The same for a payment towards a bill ("when paid"): its spending is
  // posted with the events, its money side once the bank rows say how much
  // its debit left in Bank Matching for it (see "Bill payments").
  const pendingBillPayments = []; // { e, p, k }: the payment's entry, its spending posted
  const linkedToBill = new Map(); // debit id → kobo it left in Bank Matching for the bill payment naming it

  // An account a bill or a bill payment names as where money came from or
  // went (paid from, received into), when money can sit there: never a
  // profit-and-loss account (its amount would be profit the books rule does
  // not count) and never one the engine keeps (the KashBook Account moves
  // only with bank rows, so it always equals the bank ledger). Else null, and
  // the payment's method decides.
  function heldIn(id) {
    const a = chart.explicitAccount(C, id);
    if (!a || chart.isProfitClass(chart.classOf(a.type))) return null;
    if (a.systemKey && chart.CONTROLLED.includes(a.systemKey)) return null;
    return a;
  }

  // What a bill on spending is spent on: its account, else (none, or one this
  // chart does not know) Other Expenses, as books.bookRows' rows say.
  const billSpentOn = (bill) => chart.expenseAccount(C, { accountId: bill.accountId });
  const billMemo = (bill, p) => (p && p.note) || books.billLabel(bill);

  // A document's income accounts: its lines (null → Sales, or Sales Returns on
  // a credit note) and its discount, in proportion to their amounts.
  function docIncomeLegs(doc, netKobo) {
    const isCN = lower(doc.type) === "credit_note";
    const fallback = sys(isCN ? SYS.SALES_RETURNS : SYS.SALES);
    const items = doc.items || [];
    const accs = items.map((it) => chart.explicitAccount(C, it.accountId) || fallback);
    const weights = items.map((it) => K(it.amount));
    const disc = K(doc.discountAmount);
    if (disc) {
      accs.push(sys(SYS.DISCOUNT));
      weights.push(-disc);
    }
    if (!items.length || !(weights.reduce((s, w) => s + w, 0) > 0)) return [{ acc: fallback, k: netKobo }];
    return allocate(netKobo, weights).map((k, i) => ({ acc: accs[i], k }));
  }

  // The kind of the entry that takes a document's goods out of stock (or, for
  // a credit note, puts them back).
  const costKindOf = (doc) => (lower(doc && doc.type) === "credit_note" ? "credit_note_cost" : "invoice_cost");

  // The income account a line of a sale counts as (release 3): the one it
  // names, when this chart has it as income, else Service Income for a
  // service, else Sales.
  function saleLineAccount(it) {
    const own = chart.explicitAccount(C, it && it.accountId);
    if (own && chart.classOf(own.type) === "income") return own;
    const service = it && it.itemType === "service" ? chart.sysAccount(C, SYS.SERVICE_INCOME) : null;
    return service || sys(SYS.SALES);
  }

  // A sale's income accounts for `netKobo` (an amount on it less its VAT): a
  // sale with lines shares it over their accounts in proportion to their
  // amounts (equally when every line is nothing, as a "price varies" service
  // can be), whatever the sale's own total (a discount, or rounding); one
  // without lines takes its own account, else Sales.
  function saleIncomeLegs(sale, netKobo) {
    const items = (sale && sale.items) || [];
    if (!items.length) return [{ acc: chart.incomeAccount(C, sale && sale.accountId), k: netKobo }];
    let weights = items.map((it) => Math.max(0, K(it && it.amount)));
    if (!(weights.reduce((s, w) => s + w, 0) > 0)) weights = items.map(() => 1);
    return allocate(netKobo, weights).map((k, i) => ({ acc: saleLineAccount(items[i]), k }));
  }

  // ── The books rule's events: every profit-and-loss amount ─────────────────
  const { events } = books.bookEvents(input, { basis, vat: ctx.vat, allDates: true });
  const counted = books.COUNTED_LINES[basis];
  const bankEvents = new Map(); // bank row → its counted events (posted with the row)
  const journalEvents = new Map(); // journal → its counted events (posted with the journal)

  for (const ev of events) {
    const isCounted = (ev.side === "sales" ? counted.sales : counted.expenses).includes(ev.line);
    if (!isCounted) continue;
    const { kind, rec, doc, debt } = ev.src;
    const gross = K(ev.gross);

    if (kind === "bank" || kind === "fee") {
      if (!bankEvents.has(rec)) bankEvents.set(rec, []);
      bankEvents.get(rec).push(ev);
      continue;
    }
    if (kind === "journal") {
      if (!journalEvents.has(rec)) journalEvents.set(rec, []);
      journalEvents.get(rec).push(ev);
      continue;
    }

    if (kind === "sale") {
      // Its income (at its lines' accounts) and VAT now; its money side once
      // the bank rows are posted.
      const v = vatLeg(ev.vat);
      const e = entry(`sale:${rec.id}`, ev.day, "sale", rec.notes, rec.id);
      for (const l of saleIncomeLegs(rec, gross - v)) e.cr(l.acc, l.k);
      e.cr(sys(SYS.VAT), v);
      pendingSales.push({ e, rec, gross });
    } else if (kind === "cost") {
      // What the goods sold cost (release 3). On the document's date it
      // leaves Inventory Asset for Cost of Goods Sold (a credit note's goods
      // come back: the amount is below zero). With the money, or credit
      // applied, or an invoice's write-off ("when paid") it moves from Goods
      // Sold Awaiting Payment, where the document's date put it (below),
      // into Cost of Goods Sold.
      const via = ev.src.via;
      if (via === "sale") {
        entry(`cost:sale:${rec.id}`, ev.day, "sale_cost", rec.notes, rec.id).dr(sys(SYS.COGS), gross).cr(sys(SYS.STOCK), gross);
      } else if (via === "document") {
        entry(`cost:doc:${doc.id}`, ev.day, costKindOf(doc), doc.invoiceNumber, doc.id).dr(sys(SYS.COGS), gross).cr(sys(SYS.STOCK), gross);
      } else if (via === "debtPayment") {
        entry(`cost:dp:${rec.id}`, ev.day, "cost_released", rec.note || debt.note, doc.id)
          .dr(sys(SYS.COGS), gross)
          .cr(sys(SYS.DEFERRED_COGS), gross);
      } else if (via === "writeOff") {
        // An invoice written off: whatever of its goods' cost still waited.
        entry(`cost:wo:${doc.id}`, ev.day, "cost_released", doc.invoiceNumber, doc.id)
          .dr(sys(SYS.COGS), gross)
          .cr(sys(SYS.DEFERRED_COGS), gross);
      } else {
        entry(`cost:ip:${rec.id}`, ev.day, "cost_released", doc.invoiceNumber, doc.id)
          .dr(sys(SYS.COGS), gross)
          .cr(sys(SYS.DEFERRED_COGS), gross);
      }
    } else if (kind === "stockMove") {
      // Stock counted or valued again: Inventory Asset moves by the
      // movement's value, against Stock Adjustments (the books' amount is
      // minus that value).
      entry(`stock:${rec.id}`, ev.day, `stock_${lower(rec.kind)}`, rec.note, rec.itemId || null)
        .dr(sys(SYS.STOCK), -gross)
        .dr(sys(SYS.STOCK_ADJ), gross);
    } else if (kind === "expense") {
      // A whole expense, or one counted line of an itemized expense (an entry
      // of its own, at the line's account), paid from the expense's money.
      const item = ev.src.item;
      const spentOn = item
        ? chart.explicitAccount(C, item.accountId) || chart.expenseAccount(C, { category: item.category })
        : chart.expenseAccount(C, rec);
      entry(item ? `expense:${rec.id}:${item.id}` : `expense:${rec.id}`, ev.day, "expense", rec.notes, rec.id)
        .dr(spentOn, gross)
        .cr(expenseMoney(rec), gross);
    } else if (kind === "invoicePayment") {
      // "When paid": money in (or back out, a refund on a credit note) at the
      // document's own accounts, VAT pro rata.
      const refund = ev.gross < 0;
      const amt = Math.abs(gross);
      const v = Math.abs(vatLeg(ev.vat));
      const money = chart.moneyAccount(C, {
        accountId: rec.depositAccountId, linked: !!rec.transactionId, method: rec.method, direction: refund ? "out" : "in",
      });
      const e = entry(`ip:${rec.id}`, ev.day, refund ? "refund" : "invoice_payment", doc.invoiceNumber, doc.id);
      const legs = docIncomeLegs(doc, amt - v);
      if (refund) {
        e.cr(money, amt).dr(sys(SYS.VAT), v);
        for (const l of legs) e.dr(l.acc, l.k);
      } else {
        e.dr(money, amt).cr(sys(SYS.VAT), v);
        for (const l of legs) e.cr(l.acc, l.k);
      }
    } else if (kind === "document") {
      // "When sold": an invoice is owed, a credit note is owed back.
      const isCN = ev.gross < 0;
      const total = Math.abs(gross);
      const v = Math.abs(vatLeg(ev.vat));
      const e = entry(`doc:${doc.id}`, ev.day, isCN ? "credit_note" : "invoice", doc.invoiceNumber, doc.id);
      const legs = docIncomeLegs(doc, total - v);
      if (isCN) {
        e.cr(sys(SYS.AR), total).dr(sys(SYS.VAT), v);
        for (const l of legs) e.dr(l.acc, l.k);
      } else {
        e.dr(sys(SYS.AR), total).cr(sys(SYS.VAT), v);
        for (const l of legs) e.cr(l.acc, l.k);
      }
    } else if (kind === "writeOff") {
      entry(`writeoff:${doc.id}`, ev.day, "write_off", doc.invoiceNumber, doc.id)
        .dr(sys(SYS.BAD_DEBT), gross)
        .cr(sys(SYS.AR), gross);
    } else if (kind === "debtPayment") {
      // "When paid": a repayment is the sale, at the sale's own accounts (its
      // lines', when it has them).
      const sale = debt.saleId ? salesById.get(debt.saleId) : null;
      const v = vatLeg(ev.vat);
      const e = entry(`dp:${rec.id}`, ev.day, "repayment", rec.note || debt.note, debt.customerId).dr(repaymentMoney(rec), gross);
      for (const l of saleIncomeLegs(sale, gross - v)) e.cr(l.acc, l.k);
      e.cr(sys(SYS.VAT), v);
    } else if (kind === "debt") {
      // "When sold": credit given on the customer screen is owed from that day.
      const v = vatLeg(ev.vat);
      entry(`debt:${rec.id}`, ev.day, "credit_given", rec.note, rec.customerId)
        .dr(sys(SYS.AR), gross)
        .cr(sys(SYS.SALES), gross - v)
        .cr(sys(SYS.VAT), v);
    } else if (kind === "billPayment") {
      // "When paid": a payment towards a bill is the spending, at the bill's
      // account; where it was paid from follows the bank rows.
      const bill = ev.src.bill;
      const e = entry(`bp:${rec.id}`, ev.day, "bill_payment", billMemo(bill, rec), bill.id).dr(billSpentOn(bill), gross);
      pendingBillPayments.push({ e, p: rec, k: gross });
    } else if (kind === "bill") {
      // "When sold": a bill is spending on its date, owed to the supplier.
      entry(`bill:${rec.id}`, ev.day, "bill", billMemo(rec), rec.id)
        .dr(billSpentOn(rec), gross)
        .cr(sys(SYS.AP), gross);
    }
  }

  function repaymentMoney(p) {
    return chart.moneyAccount(C, { accountId: p.depositAccountId, linked: !!p.transactionId, method: p.method, direction: "in" });
  }

  // Where an expense was paid from: Bank Matching when it records a bank
  // transfer, else the account picked, else its payment method.
  function expenseMoney(x) {
    return chart.moneyAccount(C, {
      accountId: x.paidThroughAccountId, linked: !!x.matchedTransactionId, method: x.paymentMethod, direction: "out",
    });
  }

  // ── Bank rows, each as a whole ────────────────────────────────────────────
  for (const tx of input.bankRows || []) {
    if (tx.foreignCurrency) continue;
    const isIn = lower(tx.type) === "income";
    const bank = isLedgerBankRow(tx, base) ? sys(SYS.KASHBOOK) : sys(SYS.LEGACY);
    const amount = K(tx.amount);
    const fee = isIn ? 0 : K(tx.fee);
    const e = entry(`bank:${tx.id}`, tx.date, isIn ? "bank_in" : "bank_out", tx.description, tx.id);
    if (isIn) e.dr(bank, amount);
    else e.cr(bank, amount + fee);

    const own = chart.explicitAccount(C, tx.accountId);
    let covered = 0; // the part of `amount` a profit-and-loss line carries
    for (const ev of bankEvents.get(tx) || []) {
      const g = K(ev.gross);
      if (ev.src.kind === "fee") {
        e.dr(sys(SYS.BANK_CHARGES), g);
      } else if (ev.line === "bankCharges") {
        e.dr(sys(SYS.BANK_CHARGES), g);
        covered += g;
      } else if (ev.line === "supplierRefunds") {
        e.cr(own && chart.classOf(own.type) === "expense" ? own : sys(SYS.COGS), -g);
        covered += -g;
      } else if (ev.side === "sales") {
        const v = vatLeg(ev.vat);
        e.cr(own && chart.classOf(own.type) === "income" ? own : sys(SYS.BANK_RECEIPTS), g - v).cr(sys(SYS.VAT), v);
        covered += g;
      } else {
        e.dr(chart.bankRowAccount(C, tx, basis, ctx.recurring), g);
        covered += g;
      }
    }

    // What no profit-and-loss line carries: the part a record carries (through
    // Bank Matching), a purpose or balance-sheet account, or (when sold) a
    // credit nobody has explained yet. The credit a cash deposit names brings
    // the deposit's cash out of Undeposited Funds, where the deposit put it,
    // whatever account it carries (tested first): a credit the owner had
    // marked as cash banked through Cash at Hand before a deposit took it
    // must never take the same cash out of Cash at Hand a second time.
    let rest = amount - covered;
    if (!rest) continue;
    const ownBS = own && !chart.isProfitClass(chart.classOf(own.type));
    let target;
    if (isIn && tx.purpose === "cash_deposit" && depositCredits.has(tx.id)) target = sys(SYS.UNDEPOSITED);
    else if (ownBS) target = own;
    else if (tx.purpose === "customer_refund") target = sys(SYS.BANK_MATCH);
    else if (tx.purpose && chart.PURPOSE_ACCOUNT[tx.purpose]) target = sys(chart.PURPOSE_ACCOUNT[tx.purpose]);
    else if (tx.purpose) target = sys(SYS.SUSPENSE);
    if (target) {
      if (isIn) e.cr(target, rest);
      else e.dr(target, rest);
      continue;
    }
    const matched = books.isMatchedBankRow(tx) ? amount - K(books.bankCountedAmount(tx)) : 0;
    if (matched) {
      if (isIn) e.cr(sys(SYS.BANK_MATCH), matched);
      else e.dr(sys(SYS.BANK_MATCH), matched);
      rest -= matched;
      // Left there for the sale it was matched to, which takes it back out.
      if (isIn && tx.matchedSaleId) linkedToSale.set(tx.matchedSaleId, (linkedToSale.get(tx.matchedSaleId) || 0) + matched);
      // Or for the bill payment that names this debit.
      if (!isIn && tx.matchedBillId) linkedToBill.set(tx.id, (linkedToBill.get(tx.id) || 0) + matched);
    }
    if (rest) {
      if (isIn) e.cr(sys(SYS.SUSPENSE), rest);
      else e.dr(sys(SYS.BANK_PAYMENTS), rest);
    }
  }

  // ── Sales: where the money is ─────────────────────────────────────────────
  // A sale matched to a bank transfer takes from Bank Matching what that
  // transfer left there for it, never more than the sale, so the two meet at
  // zero. A match accepts a sale above its transfer: the rest of it (notes
  // paid beside a smaller transfer, or what the bank shaved off) is where the
  // sale says, the account it was received into, else its payment method's,
  // or still owed when it was on credit. A sale has one transfer and it is
  // already linked, so the rest of a sale marked "bank" waits in Undeposited
  // Funds, not in Bank Matching for a transfer that will never come.
  for (const { e, rec, gross } of pendingSales) {
    const link = Math.max(0, Math.min(gross, linkedToSale.get(rec.id) || 0));
    let own = rec.isCredit
      ? sys(SYS.AR)
      : chart.moneyAccount(C, { accountId: rec.depositAccountId, linked: false, method: rec.paymentMethod, direction: "in" });
    if (link) {
      const bankMatch = sys(SYS.BANK_MATCH);
      if (own && own.id === bankMatch.id) own = sys(SYS.UNDEPOSITED);
      e.dr(bankMatch, link);
    }
    e.dr(own, gross - link);
  }

  // ── Bill payments: where the money came from ──────────────────────────────
  // A payment linked to a KashBook debit takes from Bank Matching what that
  // debit left there for it, never more than the payment, so the two meet at
  // zero. The rest of it (none, when the route saved it as it should: the
  // debit's matchedAmount is the payment), or all of an unlinked payment, is
  // where the payment says: the account it was paid from, else its method's.
  // A payment marked "bank" has one debit and it is already linked, so what
  // that debit does not cover waits in Undeposited Funds, as for a sale.
  function billPaymentMoney(e, p, k) {
    const left = p.transactionId ? linkedToBill.get(p.transactionId) || 0 : 0;
    const link = Math.max(0, Math.min(k, left));
    if (link) linkedToBill.set(p.transactionId, left - link);
    const bankMatch = sys(SYS.BANK_MATCH);
    const picked = heldIn(p.paidThroughAccountId);
    let own = chart.moneyAccount(C, { accountId: picked && picked.id, linked: false, method: p.method, direction: "out" });
    if (own && own.id === bankMatch.id) own = sys(SYS.UNDEPOSITED);
    e.cr(bankMatch, link).cr(own, k - link);
  }
  for (const { e, p, k } of pendingBillPayments) billPaymentMoney(e, p, k);

  // ── Expenses on the balance sheet (equipment, prepaid rent, drawings...) ──
  // What the books rule leaves out of spending: a whole expense on such an
  // account, or each such line of an itemized expense (its own entry, like
  // the line's counted siblings above).
  for (const x of input.expenses || []) {
    if (x.foreignCurrency) continue;
    const parts = Array.isArray(x.items) && x.items.length
      ? x.items.map((it) => ({ id: `expense:${x.id}:${it.id}`, accountId: it.accountId, amount: it.amount }))
      : [{ id: `expense:${x.id}`, accountId: x.accountId, amount: x.amount }];
    for (const part of parts) {
      const acc = chart.explicitAccount(C, part.accountId);
      if (!acc || chart.isProfitClass(chart.classOf(acc.type))) continue;
      const amt = K(part.amount);
      entry(part.id, x.date, "expense", x.notes, x.id).dr(acc, amt).cr(expenseMoney(x), amt);
    }
  }

  // ── "When sold": money against what customers owe ─────────────────────────
  if (basis === "sold") {
    for (const d of input.debts || []) {
      for (const p of d.payments || []) {
        const amt = K(p.amount);
        entry(`dp:${p.id}`, p.date, "repayment", p.note || d.note, d.customerId).dr(repaymentMoney(p), amt).cr(sys(SYS.AR), amt);
      }
    }
    for (const doc of input.invoices || []) {
      const type = lower(doc.type) || "invoice";
      if (type === "quote" || lower(doc.status) === "void") continue;
      for (const p of doc.payments || []) {
        const kind = books.paymentKind(p);
        const amt = K(p.amount);
        if (!amt || kind === "settlement") continue; // credit applied: owed to owed
        const e = entry(`ip:${p.id}`, p.date, kind === "refund" ? "refund" : "invoice_payment", doc.invoiceNumber, doc.id);
        if (kind === "refund") {
          e.dr(sys(SYS.AR), amt).cr(chart.moneyAccount(C, { accountId: p.depositAccountId, linked: !!p.transactionId, method: p.method, direction: "out" }), amt);
        } else if (kind === "presumed_bank") {
          // A "bank" payment with no link: the credit behind it sits in
          // Unexplained Receipts until it is linked.
          e.dr(sys(SYS.SUSPENSE), amt).cr(sys(SYS.AR), amt);
        } else {
          e.dr(chart.moneyAccount(C, { accountId: p.depositAccountId, linked: !!p.transactionId, method: p.method, direction: "in" }), amt)
            .cr(sys(SYS.AR), amt);
        }
      }
    }
  }

  // ── Bills: what is owed to suppliers and lenders, and paid back ───────────
  // A payment kept outside the books posts nothing, in either view: the bill
  // already carries only what was not paid that way (books.billBooksAmount).
  for (const bill of input.bills || []) {
    const payments = (bill.payments || []).filter((p) => p && !p.outsideBooks);
    if (books.billIsSpending(bill, input.accounts)) {
      // On spending, "when sold": each payment settles Accounts Payable.
      // ("When paid", the payments were the spending, posted above.)
      if (basis !== "sold") continue;
      for (const p of payments) {
        const k = K(p.amount);
        if (!k) continue;
        billPaymentMoney(entry(`bp:${p.id}`, p.date, "bill_payment", billMemo(bill, p), bill.id).dr(sys(SYS.AP), k), p, k);
      }
      continue;
    }
    const acc = chart.explicitAccount(C, bill.accountId);
    // A restock (release 3): a bill on Inventory Asset, the same in both
    // views and never spending. On its bill date its goods come into stock
    // at its lines' amounts (each line's stock movement carries the same
    // value), owed in Accounts Payable, and each payment settles that. The
    // route saves the bill's amount as the lines' sum; should the two ever
    // differ, the difference sits in Opening Balance Adjustments, so stock
    // still equals its movements and Accounts Payable what the bill says.
    if (acc && acc.type === "stock") {
      const owed = K(books.billBooksAmount(bill));
      const lines = bill.items || [];
      const goods = lines.length ? lines.reduce((s, it) => s + K(it && it.amount), 0) : owed;
      if (goods || owed) {
        entry(`bill:${bill.id}`, bill.billDate, "bill", billMemo(bill), bill.id)
          .dr(acc, goods)
          .cr(sys(SYS.AP), owed)
          .dr(sys(SYS.OPENING), owed - goods);
      }
      for (const p of payments) {
        const k = K(p.amount);
        if (!k) continue;
        billPaymentMoney(entry(`bp:${p.id}`, p.date, "bill_payment", billMemo(bill, p), bill.id).dr(sys(SYS.AP), k), p, k);
      }
      continue;
    }
    // A loan or another liability (or anything else on the balance sheet),
    // the same in both views and never profit: on the bill date the money
    // borrowed comes in where the bill says it went, and each payment pays
    // it back. A payable from before bills (estimated) that names nowhere was
    // owed before the books knew of it, and no record holds the money it
    // brought in: its open part (what was not paid outside the books) is
    // owed from its bill date against Opening Balance Adjustments, as a
    // starting balance would be, so the loan holds what the bill still owes
    // and its payments never take it below zero (dated before the opening
    // date, the opening entry counts it, so a stated starting balance still
    // holds). Any other bill that names nowhere posts nothing on its date:
    // its money is where it was recorded (a starting balance, or a KashBook
    // transfer explained as a loan), and the payments still lower it.
    if (!acc || chart.isProfitClass(chart.classOf(acc.type))) continue;
    const via = heldIn(bill.receivedViaAccountId) || (bill.estimated ? sys(SYS.OPENING) : null);
    const owed = K(books.billBooksAmount(bill));
    if (via && owed) entry(`bill:${bill.id}`, bill.billDate, "bill", billMemo(bill), bill.id).dr(via, owed).cr(acc, owed);
    for (const p of payments) {
      const k = K(p.amount);
      if (!k) continue;
      billPaymentMoney(entry(`bp:${p.id}`, p.date, "bill_payment", billMemo(bill, p), bill.id).dr(acc, k), p, k);
    }
  }

  // ── Manual journals: each as one entry on its date, in both views ────────
  // A line on an income or spending account posts what the books rule
  // counted for it (its event), so the profit and loss still equals
  // computeBooks; a line on the balance sheet posts as written. The books
  // rule takes only a published journal that balances to the kobo on
  // accounts it knows (books.journalInBooks), so the entry balances too.
  for (const j of input.journals || []) {
    if (!books.journalInBooks(j, input.accounts)) continue;
    if (!j.lines.every((line) => C.byId.get(line.accountId))) continue;
    const byLine = new Map((journalEvents.get(j) || []).map((ev) => [ev.src.line, ev]));
    const e = entry(`mj:${j.id}`, j.date, "journal", j.note || j.number, j.id);
    for (const line of j.lines) {
      const acc = C.byId.get(line.accountId);
      const ev = byLine.get(line);
      if (!ev) e.dr(acc, K(line.debit) - K(line.credit));
      else if (ev.side === "sales") e.cr(acc, K(ev.gross));
      else e.dr(acc, K(ev.gross));
    }
  }

  // ── Stock: goods awaiting their money, and starting stock ────────────────
  // "When paid", a credit sale a debt tracks and an issued document with an
  // amount to collect (books.stockCosts: defer) take their goods out of
  // stock on their own date into Goods Sold Awaiting Payment; the money
  // releases them from there (the "cost" events above). So Inventory Asset
  // moves on the same day in both views, and what is still awaited is the
  // cost of what has not been paid for. A sale the books know only from its
  // debt (listed false: a period's input, never the ledger's) is left out.
  if (basis === "paid") {
    for (const plan of books.stockCosts(input).values()) {
      if (!plan.defer || !plan.listed) continue;
      const isSale = plan.via === "sale";
      entry(
        isSale ? `cost:sale:${plan.doc.id}` : `cost:doc:${plan.doc.id}`, plan.doc[isSale ? "date" : "issueDate"],
        isSale ? "sale_cost" : costKindOf(plan.doc), isSale ? plan.doc.notes : plan.doc.invoiceNumber, plan.doc.id,
      ).dr(sys(SYS.DEFERRED_COGS), plan.k).cr(sys(SYS.STOCK), plan.k);
    }
  }
  // Starting stock (an opening count, or the value set up for stock already
  // held), in both views on its date: Inventory Asset against Opening Balance
  // Adjustments, as a starting balance would be. Never profit.
  for (const m of input.stockMoves || []) {
    const mk = lower(m && m.kind);
    if (mk !== "opening" && mk !== "opening_value") continue;
    const k = K(m.value);
    if (!k) continue;
    entry(`stock:${m.id}`, m.date, `stock_${mk}`, m.note, m.itemId || null).dr(sys(SYS.STOCK), k).cr(sys(SYS.OPENING), k);
  }

  // ── Cash deposits: cash taken from the till to a bank ────────────────────
  // On the deposit's date, in both views, and never profit: out of Cash at
  // Hand into the bank it went into (another bank's account, else Other Bank
  // Account should that account be gone), or for the KashBook account into
  // Undeposited Funds, which the credit it is linked to empties when it
  // arrives (above). Entry kind "cash_deposit", its ref the deposit's id.
  for (const d of ctx.cashDeposits || []) {
    if (!d || lower(d.status) === "cancelled") continue;
    const k = K(d.amount);
    if (!k) continue;
    const into = d.into === "kashbook"
      ? sys(SYS.UNDEPOSITED)
      : chart.explicitAccount(C, d.intoAccountId) || sys(SYS.OTHER_BANK);
    entry(`deposit:${d.id}`, d.date, "cash_deposit", d.note, d.id).dr(into, k).cr(sys(SYS.CASH), k);
  }

  // ── Opening balances: what the merchant says each account held ───────────
  if (ctx.openingDate && (ctx.openings || []).length) {
    const D = ctx.openingDate;
    const before = new Map();
    for (const e of entries) {
      if (!(e.day < D)) continue;
      for (const l of e.lines) before.set(l.accountId, (before.get(l.accountId) || 0) + l.k);
    }
    const e = entry("opening", D, "opening", "", null);
    for (const ob of ctx.openings) {
      const acc = C.byId.get(ob.accountId);
      if (!acc) continue;
      const diff = K(ob.debit) - K(ob.credit) - (before.get(acc.id) || 0);
      e.dr(acc, diff).cr(sys(SYS.OPENING), diff);
    }
    // Opening entries come first on their day.
    entries.unshift(entries.pop());
  }

  return { basis, entries };
}

// ── Reading the ledger ──────────────────────────────────────────────────────

// Kobo per account (debit positive) over entries with from ≤ day ≤ to.
function sumByAccount(entries, { from, to } = {}) {
  const out = new Map();
  for (const e of entries) {
    if (from && e.day < from) continue;
    if (to && e.day > to) continue;
    for (const l of e.lines) out.set(l.accountId, (out.get(l.accountId) || 0) + l.k);
  }
  return out;
}

// Every entry balances to the kobo (the first thing a test checks).
function unbalanced(entries) {
  return entries.filter((e) => e.lines.reduce((s, l) => s + l.k, 0) !== 0);
}

// An account's balance in its own sign: assets and expenses as debits, the
// rest as credits.
function signedFor(account, k) {
  return chart.debitNormal(chart.classOf(account.type)) ? k : -k;
}

// The financial year that `day` falls in starts on this day.
function yearStart(day, startMonth = 1) {
  const [y, m] = day.split("-").map(Number);
  const sm = Math.min(12, Math.max(1, Number(startMonth) || 1));
  const year = m >= sm ? y : y - 1;
  return `${year}-${String(sm).padStart(2, "0")}-01`;
}

function dayBefore(day) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// Profit and loss by account for [from, to]: income and expense accounts' net
// movement. Equals computeBooks for the same period and view.
function profitAndLoss(entries, C, { from, to } = {}) {
  const sums = sumByAccount(entries, { from, to });
  const income = [];
  const expenses = [];
  for (const [id, k] of sums) {
    const acc = C.byId.get(id);
    if (!acc || !k) continue;
    const cls = chart.classOf(acc.type);
    if (cls === "income") income.push({ account: acc, amount: -k / 100 });
    else if (cls === "expense") expenses.push({ account: acc, amount: k / 100 });
  }
  const totalIncome = Math.round(income.reduce((s, r) => s + r.amount * 100, 0)) / 100;
  const totalExpenses = Math.round(expenses.reduce((s, r) => s + r.amount * 100, 0)) / 100;
  return { income, expenses, totalIncome, totalExpenses, profit: Math.round((totalIncome - totalExpenses) * 100) / 100 };
}

// Every account's balance at the end of `asOf`, in debit / credit columns.
function trialBalance(entries, C, asOf) {
  const sums = sumByAccount(entries, { to: asOf });
  const rows = [];
  let debit = 0;
  let credit = 0;
  for (const [id, k] of sums) {
    const acc = C.byId.get(id);
    if (!acc || !k) continue;
    if (k > 0) debit += k;
    else credit += -k;
    rows.push({ account: acc, debit: k > 0 ? k / 100 : 0, credit: k < 0 ? -k / 100 : 0 });
  }
  return { asOf, rows, debit: debit / 100, credit: credit / 100, balanced: debit === credit };
}

// What the business owns and owes at the end of `asOf`. Profit made before
// the financial year started is Retained Earnings; this year's so far is
// Current Year Earnings. Assets = Liabilities + Equity, to the kobo.
function balanceSheet(entries, C, asOf, fiscalYearStartMonth = 1) {
  const sums = sumByAccount(entries, { to: asOf });
  const fy = yearStart(asOf, fiscalYearStartMonth);
  const sections = { asset: [], liability: [], equity: [] };
  let pnlBefore = 0; // kobo, debit positive (a profit is negative here)
  let pnlThisYear = 0;
  const priorSums = sumByAccount(entries, { to: dayBefore(fy) });
  for (const [id, k] of sums) {
    const acc = C.byId.get(id);
    if (!acc || !k) continue;
    const cls = chart.classOf(acc.type);
    if (chart.isProfitClass(cls)) continue;
    sections[cls].push({ account: acc, amount: signedFor(acc, k) / 100 });
  }
  for (const [id, k] of sums) {
    const acc = C.byId.get(id);
    if (acc && chart.isProfitClass(chart.classOf(acc.type))) pnlThisYear += k;
  }
  for (const [id, k] of priorSums) {
    const acc = C.byId.get(id);
    if (acc && chart.isProfitClass(chart.classOf(acc.type))) pnlBefore += k;
  }
  pnlThisYear -= pnlBefore;
  const total = (rows) => Math.round(rows.reduce((s, r) => s + r.amount * 100, 0));
  const assets = total(sections.asset);
  const liabilities = total(sections.liability);
  const equityAccounts = total(sections.equity);
  const retained = -pnlBefore;
  const currentYear = -pnlThisYear;
  const equity = equityAccounts + retained + currentYear;
  return {
    asOf,
    yearStart: fy,
    assets: sections.asset,
    liabilities: sections.liability,
    equity: sections.equity,
    retainedEarnings: retained / 100,
    currentYearEarnings: currentYear / 100,
    totals: { assets: assets / 100, liabilities: liabilities / 100, equity: equity / 100 },
    balanced: assets === liabilities + equity,
  };
}

// One account's entries for [from, to] with a running balance, in the
// account's own sign, after the balance it had before `from`.
function accountTransactions(entries, accountId, account, { from, to } = {}) {
  let k = 0;
  const lines = [];
  entries.forEach((e, idx) => {
    const own = e.lines.filter((l) => l.accountId === accountId);
    if (!own.length) return;
    const net = own.reduce((s, l) => s + l.k, 0);
    if (from && e.day < from) {
      k += net;
      return;
    }
    if (to && e.day > to) return;
    if (!net) return;
    lines.push({ entry: e, idx, amount: signedFor(account, net) });
    k += net;
  });
  // Entries are built record by record; the statement reads by day, the
  // opening balance first on its day.
  lines.sort((a, b) =>
    a.entry.day < b.entry.day ? -1 : a.entry.day > b.entry.day ? 1
      : (a.entry.kind === "opening" ? 0 : 1) - (b.entry.kind === "opening" ? 0 : 1) || a.idx - b.idx);
  const closing = signedFor(account, k);
  const moved = lines.reduce((s, l) => s + l.amount, 0);
  const opening = closing - moved;
  let run = opening;
  return {
    opening: opening / 100,
    closing: closing / 100,
    lines: lines.map((l) => {
      run += l.amount;
      return {
        id: l.entry.id, day: l.entry.day, kind: l.entry.kind, memo: l.entry.memo, ref: l.entry.ref,
        amount: l.amount / 100, balance: run / 100,
      };
    }),
  };
}

module.exports = {
  K,
  allocate,
  buildLedger,
  sumByAccount,
  unbalanced,
  yearStart,
  profitAndLoss,
  trialBalance,
  balanceSheet,
  accountTransactions,
};
