/**
 * Business Insights engine — a fully DETERMINISTIC "ask your books" algorithm.
 * No AI, no external calls (except the existing Anchor balance fetch): a
 * question goes through
 *
 *   normalize (typos + Pidgin/synonyms) → time-range parser (Africa/Lagos)
 *   → scored intent matcher (+ channel entity, compare flag, follow-up context)
 *   → scoped Prisma queries → template answer.
 *
 * Every number in an answer comes from a query — nothing is generated.
 * All queries are scoped to one businessId (ownership enforced by the route).
 *
 * Exports: answerQuestion(), generateInsightCards(), SUGGESTIONS, and the pure
 * parser pieces (normalize/parseTimeRange/matchIntent) for unit tests.
 */

const prisma = require("./db");

// ── Money formatting ─────────────────────────────────────────────────────────
const CURRENCY_SYMBOLS = {
  NGN: "₦", USD: "$", KES: "KSh ", GHS: "GH₵", ZAR: "R", EGP: "E£", GBP: "£", EUR: "€",
};
function money(amount, currency = "NGN") {
  const sym = CURRENCY_SYMBOLS[currency] || `${currency} `;
  return sym + Number(amount || 0).toLocaleString("en-NG", { maximumFractionDigits: 0 });
}

// ── Normalization: lowercase, strip punctuation, Pidgin + synonym mapping ────
// Phrase replacements run on the whole string FIRST (multi-word Pidgin), then
// single-token synonyms. Everything maps onto the canonical keyword vocabulary
// the intents are scored against.
const PHRASE_MAP = [
  [/\bdon make\b/g, "made"],
  [/\bdey owe\b/g, "owe"],
  [/\bnever pay\b/g, "owe"],
  [/\bno pay\b/g, "owe"],
  [/\bhow far\b/g, "how"],
  [/\bhow much i don\b/g, "how much did i"],
  [/\bmoney wey\b/g, "money"],
  [/\bsell pass\b/g, "best seller"],
  [/\bbuy pass\b/g, "best customer"],
  [/\bmoney out\b/g, "expenses"],
  [/\bmoney in\b/g, "income"],
  [/\bcame in\b/g, "income"],
  [/\bcome in\b/g, "income"],
  [/\bcash at hand\b/g, "balance"],
  [/\bin my account\b/g, "balance"],
  [/\bmy account\b/g, "balance"],
  [/\brunning low\b/g, "low stock"],
  [/\bout of stock\b/g, "low stock"],
  [/\bwalk in\b/g, "walkin"],
  [/\bwalk-in\b/g, "walkin"],
];

const TOKEN_MAP = {
  // Pidgin / colloquial
  wetin: "what", abeg: "", dey: "", una: "", oga: "", shey: "", abi: "",
  moni: "money", kudi: "money", ego: "money",
  customa: "customer", kastoma: "customer",
  // synonyms → canonical
  earn: "made", earned: "made", earnings: "income", revenue: "income",
  turnover: "income", gain: "profit", gains: "profit",
  spent: "spend", spending: "spend", cost: "spend", costs: "spend",
  expenditure: "expenses", expense: "expenses",
  debtor: "owe", debtors: "owe", debt: "owe", debts: "owe", owing: "owe", owes: "owe",
  bestseller: "best seller", ig: "instagram", insta: "instagram", wa: "whatsapp",
  goods: "product", items: "product", item: "product", products: "product",
  inventory: "stock", restock: "stock",
  invoices: "invoice", bill: "invoice", bills: "invoice",
  transactions: "transaction", txn: "transaction", txns: "transaction",
  clients: "customer", client: "customer", customers: "customer", buyer: "customer", buyers: "customer",
};

function normalize(question) {
  let s = String(question || "").toLowerCase();
  s = s.replace(/[’']/g, "").replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  for (const [re, to] of PHRASE_MAP) s = s.replace(re, to);
  const tokens = s.split(" ").map((t) => (TOKEN_MAP[t] !== undefined ? TOKEN_MAP[t] : t)).filter(Boolean);
  return tokens.join(" ");
}

// Small edit-distance for typo tolerance ("proft", "expnses"). Only used for
// tokens ≥5 chars and distance ≤1 — cheap and low-false-positive.
function editDistance1(a, b) {
  if (a === b) return true;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < la && j < lb) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (la > lb) i++;
    else if (lb > la) j++;
    else { i++; j++; }
  }
  return edits + (la - i) + (lb - j) <= 1;
}

// ── Africa/Lagos time-range parsing (WAT = UTC+1 fixed, no DST) ──────────────
const WAT_MS = 60 * 60 * 1000;
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

function lagosParts(now) {
  const l = new Date(now.getTime() + WAT_MS);
  return { y: l.getUTCFullYear(), m: l.getUTCMonth(), d: l.getUTCDate(), dow: l.getUTCDay() };
}
function fromLagos(y, m, d) {
  return new Date(Date.UTC(y, m, d) - WAT_MS);
}

// Returns { start, end, label, kind } or null (caller decides the default).
function parseTimeRange(text, now = new Date()) {
  const { y, m, d, dow } = lagosParts(now);
  const t = ` ${text} `;

  if (/\btoday\b/.test(t)) return { start: fromLagos(y, m, d), end: now, label: "today", kind: "day" };
  if (/\byesterday\b/.test(t)) return { start: fromLagos(y, m, d - 1), end: fromLagos(y, m, d), label: "yesterday", kind: "day" };

  // week starts Monday
  const monOffset = (dow + 6) % 7;
  if (/\bthis week\b/.test(t)) return { start: fromLagos(y, m, d - monOffset), end: now, label: "this week", kind: "week" };
  if (/\blast week\b/.test(t)) {
    return { start: fromLagos(y, m, d - monOffset - 7), end: fromLagos(y, m, d - monOffset), label: "last week", kind: "week" };
  }

  if (/\bthis month\b/.test(t)) return { start: fromLagos(y, m, 1), end: now, label: "this month", kind: "month" };
  if (/\blast month\b/.test(t)) return { start: fromLagos(y, m - 1, 1), end: fromLagos(y, m, 1), label: "last month", kind: "month" };
  if (/\bthis year\b/.test(t)) return { start: fromLagos(y, 0, 1), end: now, label: "this year", kind: "year" };
  if (/\blast year\b/.test(t)) return { start: fromLagos(y - 1, 0, 1), end: fromLagos(y, 0, 1), label: "last year", kind: "year" };

  // "last/past N days|weeks|months"
  const rel = t.match(/\b(?:last|past) (\d{1,3}) (day|week|month)s?\b/);
  if (rel) {
    const n = parseInt(rel[1], 10);
    const days = rel[2] === "day" ? n : rel[2] === "week" ? n * 7 : n * 30;
    return { start: fromLagos(y, m, d - days), end: now, label: `the last ${n} ${rel[2]}${n === 1 ? "" : "s"}`, kind: "days", days };
  }

  // "since monday" — most recent such weekday (today counts)
  const since = t.match(/\bsince (sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  if (since) {
    const target = WEEKDAYS.indexOf(since[1]);
    const back = (dow - target + 7) % 7;
    return { start: fromLagos(y, m, d - back), end: now, label: `since ${since[1]}`, kind: "days", days: back || 7 };
  }

  // month names ("in june", "june") — this year, or last year if in the future
  for (let i = 0; i < 12; i++) {
    if (new RegExp(`\\b${MONTHS[i]}\\b`).test(t)) {
      const year = i > m ? y - 1 : y;
      const end = year === y && i === m ? now : fromLagos(year, i + 1, 1);
      return { start: fromLagos(year, i, 1), end, label: `${MONTHS[i]} ${year}`, kind: "month" };
    }
  }

  return null;
}

// The equal period immediately before (calendar-aware) — for comparisons.
function previousPeriod(range, now = new Date()) {
  const { y, m, d, dow } = lagosParts(now);
  switch (range.kind) {
    case "day": {
      const len = 24 * 60 * 60 * 1000;
      return { start: new Date(range.start.getTime() - len), end: range.start, label: "the day before" };
    }
    case "week": {
      const monOffset = (dow + 6) % 7;
      if (range.label === "this week") {
        return { start: fromLagos(y, m, d - monOffset - 7), end: fromLagos(y, m, d - monOffset), label: "last week" };
      }
      return { start: new Date(range.start.getTime() - 7 * 86400000), end: range.start, label: "the week before" };
    }
    case "month": {
      const s = new Date(range.start.getTime() + WAT_MS);
      return {
        start: fromLagos(s.getUTCFullYear(), s.getUTCMonth() - 1, 1),
        end: range.start,
        label: "the month before",
      };
    }
    case "year": {
      const s = new Date(range.start.getTime() + WAT_MS);
      return { start: fromLagos(s.getUTCFullYear() - 1, 0, 1), end: range.start, label: "the year before" };
    }
    default: {
      const len = range.end.getTime() - range.start.getTime();
      return { start: new Date(range.start.getTime() - len), end: range.start, label: "the period before" };
    }
  }
}

function defaultRange(now = new Date()) {
  const { y, m } = lagosParts(now);
  return { start: fromLagos(y, m, 1), end: now, label: "this month", kind: "month" };
}

// ── Channel entity ───────────────────────────────────────────────────────────
const CHANNELS = { instagram: "instagram", whatsapp: "whatsapp", walkin: "walk-in", online: "online" };
function parseChannel(text) {
  for (const key of Object.keys(CHANNELS)) {
    if (new RegExp(`\\b${key}\\b`).test(text)) return CHANNELS[key];
  }
  return null;
}

// ── Intent catalog + scoring ─────────────────────────────────────────────────
// phrases score 5, strong keywords 3, weak keywords 1. Highest total wins;
// below THRESHOLD → fallback (or follow-up via context).
const THRESHOLD = 3;

const INTENTS = [
  { id: "income", phrases: ["how much did i make", "how much have i made"], strong: ["income", "made", "sales"], weak: ["make", "money", "sold", "total"] },
  { id: "expenses", phrases: ["what did i spend"], strong: ["expenses", "spend"], weak: ["money"] },
  { id: "expense_breakdown", phrases: ["spend most on", "where is my money going", "where my money go"], strong: ["category", "categories"], weak: ["spend", "expenses", "biggest"] },
  { id: "profit", phrases: ["how is my business doing", "how my business"], strong: ["profit", "loss"], weak: ["net", "doing", "performance"] },
  { id: "debts", phrases: ["who owes me"], strong: ["owe"], weak: ["outstanding", "collect"] },
  { id: "top_customers", phrases: ["best customer", "top customer", "biggest customer", "who buys the most"], strong: [], weak: ["customer", "best", "top", "biggest"] },
  { id: "top_products", phrases: ["best seller", "top product", "best product", "top selling"], strong: [], weak: ["product", "seller", "selling", "best", "top"] },
  { id: "stock", phrases: ["low stock", "what should i stock"], strong: ["stock"], weak: ["product", "left", "remain", "remaining", "finish", "finished", "quantity"] },
  { id: "channels", phrases: ["by channel", "which channel", "sales by channel"], strong: ["channel", "channels"], weak: ["breakdown", "split", "compare"] },
  { id: "invoices", phrases: ["unpaid invoice", "overdue invoice"], strong: ["invoice"], weak: ["unpaid", "overdue", "paid"] },
  { id: "count", phrases: ["how many sales", "how many transaction", "number of sales"], strong: [], weak: ["how", "many", "transaction", "count", "sales"] },
  { id: "balance", phrases: ["bank balance", "account balance", "how much do i have"], strong: ["balance"], weak: ["bank", "account", "wallet"] },
  { id: "best_day", phrases: ["best day", "busiest day", "which day"], strong: ["busiest"], weak: ["day", "best"] },
  { id: "help", phrases: ["what can you do", "what can i ask"], strong: ["help"], weak: [] },
];

function matchIntent(text) {
  const tokens = text.split(" ");
  let best = null;
  for (const intent of INTENTS) {
    let score = 0;
    for (const p of intent.phrases) if (text.includes(p)) score += 5;
    for (const k of intent.strong) {
      if (tokens.includes(k)) score += 3;
      else if (k.length >= 5 && tokens.some((tk) => tk.length >= 4 && editDistance1(tk, k))) score += 3; // typo'd strong keyword still counts as strong
    }
    for (const k of intent.weak) if (tokens.includes(k)) score += 1;
    if (!best || score > best.score) best = { id: intent.id, score };
  }
  return best && best.score >= THRESHOLD ? best : null;
}

const COMPARE_RE = /\b(compare|compared|vs|versus|than last|change)\b/;

// Full parse (pure, testable): question (+ optional follow-up context) →
// { intent, range, channel, compare, usedContext }
function parseQuestion(question, context = null, now = new Date()) {
  const text = normalize(question);
  const range = parseTimeRange(text, now);
  const channel = parseChannel(text);
  const compare = COMPARE_RE.test(` ${text} `);
  let match = matchIntent(text);
  let usedContext = false;

  // Follow-up: "what about last week?" — a time expression with no clear intent
  // reuses the previous question's intent (passed back by the client).
  if (!match && range && context && typeof context === "string") {
    if (INTENTS.some((i) => i.id === context)) {
      match = { id: context, score: THRESHOLD };
      usedContext = true;
    }
  }

  return {
    intent: match ? match.id : null,
    range: range || defaultRange(now),
    hadExplicitRange: !!range,
    channel,
    compare,
    usedContext,
  };
}

// ── Query layer + answer templates ───────────────────────────────────────────
async function sumTransactions(businessId, type, range, channel) {
  const r = await prisma.transaction.aggregate({
    where: {
      businessId, type,
      date: { gte: range.start, lt: range.end },
      ...(channel ? { channel } : {}),
    },
    _sum: { amount: true },
    _count: { _all: true },
  });
  return { total: r._sum.amount || 0, count: r._count._all };
}

function pctDelta(cur, prev) {
  if (!prev) return null;
  return ((cur - prev) / prev) * 100;
}
function deltaPhrase(delta, vsLabel) {
  if (delta == null) return "";
  const arrow = delta >= 0 ? "up" : "down";
  return ` — ${arrow} ${Math.abs(delta).toFixed(0)}% from ${vsLabel}`;
}

const HANDLERS = {
  async income({ business, range, channel, compare }) {
    const cur = await sumTransactions(business.id, "income", range, channel);
    const chLabel = channel ? ` from ${channel === "walk-in" ? "walk-in" : channel} sales` : "";
    let tail = "";
    if (compare || range.kind === "week" || range.kind === "month") {
      const prev = previousPeriod(range);
      const p = await sumTransactions(business.id, "income", prev, channel);
      tail = deltaPhrase(pctDelta(cur.total, p.total), prev.label);
    }
    if (cur.count === 0) return { answer: `No income recorded ${range.label}${chLabel}.` };
    return {
      answer: `You made ${money(cur.total, business.baseCurrency)}${chLabel} ${range.label} (${cur.count} transaction${cur.count === 1 ? "" : "s"})${tail}.`,
      data: { total: cur.total, count: cur.count },
    };
  },

  async expenses({ business, range, compare }) {
    const cur = await sumTransactions(business.id, "expense", range, null);
    let tail = "";
    if (compare) {
      const prev = previousPeriod(range);
      const p = await sumTransactions(business.id, "expense", prev, null);
      tail = deltaPhrase(pctDelta(cur.total, p.total), prev.label);
    }
    if (cur.count === 0) return { answer: `No expenses recorded ${range.label}.` };
    return {
      answer: `You spent ${money(cur.total, business.baseCurrency)} ${range.label} (${cur.count} expense${cur.count === 1 ? "" : "s"})${tail}.`,
      data: { total: cur.total, count: cur.count },
    };
  },

  async expense_breakdown({ business, range }) {
    const rows = await prisma.transaction.groupBy({
      by: ["category"],
      where: { businessId: business.id, type: "expense", date: { gte: range.start, lt: range.end } },
      _sum: { amount: true },
    });
    const top = rows
      .map((r) => ({ category: r.category || "other", amount: r._sum.amount || 0 }))
      .filter((r) => r.amount > 0)
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 4);
    if (top.length === 0) return { answer: `No expenses recorded ${range.label}.` };
    const total = top.reduce((n, r) => n + r.amount, 0);
    const list = top.map((r) => `${r.category} ${money(r.amount, business.baseCurrency)}`).join(" · ");
    return {
      answer: `Your biggest expenses ${range.label}: ${list}. "${top[0].category}" is ${((top[0].amount / total) * 100).toFixed(0)}% of the top spending.`,
      data: { top },
    };
  },

  async profit({ business, range }) {
    const [inc, exp] = await Promise.all([
      sumTransactions(business.id, "income", range, null),
      sumTransactions(business.id, "expense", range, null),
    ]);
    const net = inc.total - exp.total;
    const prev = previousPeriod(range);
    const [pInc, pExp] = await Promise.all([
      sumTransactions(business.id, "income", prev, null),
      sumTransactions(business.id, "expense", prev, null),
    ]);
    const tail = deltaPhrase(pctDelta(net, pInc.total - pExp.total), prev.label);
    const word = net >= 0 ? "profit" : "loss";
    return {
      answer: `${range.label[0].toUpperCase()}${range.label.slice(1)}: ${money(inc.total, business.baseCurrency)} in, ${money(exp.total, business.baseCurrency)} out — a ${word} of ${money(Math.abs(net), business.baseCurrency)}${tail}.`,
      data: { income: inc.total, expenses: exp.total, net },
    };
  },

  async debts({ business }) {
    const rows = await prisma.customer.findMany({
      where: { businessId: business.id, totalOwed: { gt: 0 } },
      orderBy: { totalOwed: "desc" },
      take: 5,
      select: { name: true, totalOwed: true },
    });
    if (rows.length === 0) return { answer: "Nobody owes you money right now. 🎉" };
    const agg = await prisma.customer.aggregate({
      where: { businessId: business.id, totalOwed: { gt: 0 } },
      _sum: { totalOwed: true },
      _count: true,
    });
    const list = rows.map((r) => `${r.name} (${money(r.totalOwed, business.baseCurrency)})`).join(", ");
    return {
      answer: `${agg._count} customer${agg._count === 1 ? "" : "s"} owe${agg._count === 1 ? "s" : ""} you ${money(agg._sum.totalOwed, business.baseCurrency)} in total. Top: ${list}.`,
      data: { total: agg._sum.totalOwed, count: agg._count, top: rows },
    };
  },

  async top_customers({ business, range }) {
    const rows = await prisma.sales.groupBy({
      by: ["customerId"],
      where: { businessId: business.id, customerId: { not: null }, date: { gte: range.start, lt: range.end } },
      _sum: { amount: true },
      _count: { _all: true },
    });
    const top = rows.sort((a, b) => (b._sum.amount || 0) - (a._sum.amount || 0)).slice(0, 3);
    if (top.length === 0) return { answer: `No customer sales recorded ${range.label}. Record sales with a customer attached to see this.` };
    const customers = await prisma.customer.findMany({
      where: { id: { in: top.map((t) => t.customerId) } },
      select: { id: true, name: true },
    });
    const nameOf = (id) => customers.find((c) => c.id === id)?.name || "Unknown";
    const list = top.map((t) => `${nameOf(t.customerId)} ${money(t._sum.amount, business.baseCurrency)} (${t._count._all} sale${t._count._all === 1 ? "" : "s"})`).join(" · ");
    return { answer: `Your top customers ${range.label}: ${list}.`, data: { top } };
  },

  async top_products({ business, range }) {
    // Sales aren't linked to inventory items, so the honest product signal we
    // have is invoice line items (name + amount).
    const rows = await prisma.invoiceItem.groupBy({
      by: ["name"],
      where: { invoice: { businessId: business.id, createdAt: { gte: range.start, lt: range.end }, status: { not: "VOID" } } },
      _sum: { amount: true },
      _count: { _all: true },
    });
    const top = rows.sort((a, b) => (b._sum.amount || 0) - (a._sum.amount || 0)).slice(0, 3);
    if (top.length === 0) {
      return { answer: `I can't rank products ${range.label} yet — product names come from your invoice line items, and there aren't any in that period.` };
    }
    const list = top.map((t) => `${t.name} ${money(t._sum.amount, business.baseCurrency)}`).join(" · ");
    return { answer: `Your top invoiced items ${range.label}: ${list}.`, data: { top } };
  },

  async stock({ business }) {
    const low = await prisma.$queryRaw`
      SELECT name, quantity, "lowStockAlert" FROM "InventoryItem"
      WHERE "businessId" = ${business.id} AND quantity <= "lowStockAlert"
      ORDER BY quantity ASC LIMIT 5
    `;
    const count = await prisma.inventoryItem.count({ where: { businessId: business.id } });
    if (count === 0) return { answer: "You haven't added any inventory items yet." };
    if (low.length === 0) return { answer: `All ${count} inventory items are above their low-stock levels. ✅` };
    const list = low.map((r) => `${r.name} (${r.quantity} left)`).join(", ");
    return { answer: `${low.length} item${low.length === 1 ? " is" : "s are"} low on stock: ${list}.`, data: { low } };
  },

  async channels({ business, range }) {
    const rows = await prisma.transaction.groupBy({
      by: ["channel"],
      where: { businessId: business.id, type: "income", date: { gte: range.start, lt: range.end } },
      _sum: { amount: true },
    });
    const named = rows
      .map((r) => ({ channel: r.channel || "unspecified", amount: r._sum.amount || 0 }))
      .filter((r) => r.amount > 0)
      .sort((a, b) => b.amount - a.amount);
    if (named.length === 0) return { answer: `No income recorded ${range.label}.` };
    const list = named.map((r) => `${r.channel} ${money(r.amount, business.baseCurrency)}`).join(" · ");
    return { answer: `Income by channel ${range.label}: ${list}.`, data: { channels: named } };
  },

  async invoices({ business }) {
    const open = await prisma.invoice.findMany({
      where: { businessId: business.id, status: { in: ["SENT", "PARTIAL", "OVERDUE"] } },
      select: { total: true, amountPaid: true, dueDate: true },
    });
    if (open.length === 0) return { answer: "No unpaid invoices — everything is settled. ✅" };
    const today = new Date().toISOString().slice(0, 10);
    let outstanding = 0, overdue = 0, overdueCount = 0;
    for (const inv of open) {
      const bal = Math.max(0, (inv.total || 0) - (inv.amountPaid || 0));
      outstanding += bal;
      if (inv.dueDate && inv.dueDate < today) { overdue += bal; overdueCount++; }
    }
    const overduePart = overdueCount ? ` ${overdueCount} of them ${overdueCount === 1 ? "is" : "are"} overdue (${money(overdue, business.baseCurrency)}).` : "";
    return {
      answer: `${open.length} unpaid invoice${open.length === 1 ? "" : "s"} worth ${money(outstanding, business.baseCurrency)} outstanding.${overduePart}`,
      data: { count: open.length, outstanding, overdueCount, overdue },
    };
  },

  async count({ business, range }) {
    const [inc, exp] = await Promise.all([
      sumTransactions(business.id, "income", range, null),
      sumTransactions(business.id, "expense", range, null),
    ]);
    return {
      answer: `${range.label[0].toUpperCase()}${range.label.slice(1)}: ${inc.count} income transaction${inc.count === 1 ? "" : "s"} and ${exp.count} expense${exp.count === 1 ? "" : "s"} recorded.`,
      data: { income: inc.count, expenses: exp.count },
    };
  },

  async balance({ business }) {
    if (!business.anchorAccountId) {
      return { answer: "This business doesn't have a bank account yet — open one from the Dashboard to see a balance." };
    }
    const cache = require("./balanceCache");
    let bal = cache.getBalance(business.id);
    if (bal === undefined) {
      try {
        const anchor = require("./anchor");
        const r = await anchor.getAccountBalance(business.anchorAccountId);
        bal = r.balance;
        cache.setBalance(business.id, bal);
      } catch {
        return { answer: "I couldn't reach the bank right now — check the Dashboard for your balance." };
      }
    }
    return { answer: `Your bank balance is ${money(bal, business.baseCurrency)}.`, data: { balance: bal } };
  },

  async best_day({ business, range, hadExplicitRange }) {
    // Default to the last 30 days unless a period was asked for explicitly.
    const r = hadExplicitRange ? range : { start: new Date(Date.now() - 30 * 86400000), end: new Date(), label: "the last 30 days" };
    const rows = await prisma.transaction.findMany({
      where: { businessId: business.id, type: "income", date: { gte: r.start, lt: r.end } },
      select: { amount: true, date: true },
      take: 5000,
    });
    if (rows.length === 0) return { answer: `No income recorded in ${r.label}.` };
    const byDay = new Array(7).fill(0);
    for (const row of rows) {
      const dow = new Date(row.date.getTime() + WAT_MS).getUTCDay();
      byDay[dow] += row.amount || 0;
    }
    const bestIdx = byDay.indexOf(Math.max(...byDay));
    const name = WEEKDAYS[bestIdx][0].toUpperCase() + WEEKDAYS[bestIdx].slice(1);
    return {
      answer: `${name} is your best day — ${money(byDay[bestIdx], business.baseCurrency)} of income in ${r.label}.`,
      data: { byDay },
    };
  },

  async help() {
    return {
      answer:
        "You can ask me things like: “How much did I make this week?” · “Who owes me money?” · “What did I spend last month?” · “Best seller this month?” · “Sales by channel” · “What's low on stock?” · “Unpaid invoices?” · “Bank balance” · “Which day do I sell most?”",
    };
  },
};

const SUGGESTIONS = [
  "How much did I make this week?",
  "Who owes me money?",
  "What did I spend this month?",
  "Profit this month",
  "Sales by channel",
  "What's low on stock?",
  "Unpaid invoices",
  "Which day do I sell most?",
];

const FALLBACK =
  "I didn't understand that one. Try asking about income, expenses, profit, debts, customers, stock, invoices, channels or your bank balance — for example: “How much did I make this week?”";

// ── Public API ───────────────────────────────────────────────────────────────
// answerQuestion(question, business, context?) → { intent, answer, data? }
async function answerQuestion(question, business, context = null) {
  const parsed = parseQuestion(question, context);
  if (!parsed.intent) return { intent: null, answer: FALLBACK };
  const handler = HANDLERS[parsed.intent];
  const result = await handler({ business, ...parsed });
  return { intent: parsed.intent, answer: result.answer, data: result.data };
}

// Auto-generated observation cards for the Insights screen. All deterministic.
async function generateInsightCards(business) {
  const now = new Date();
  const { y, m } = lagosParts(now);
  const thisMonth = { start: fromLagos(y, m, 1), end: now };
  const lastMonth = { start: fromLagos(y, m - 1, 1), end: fromLagos(y, m, 1) };
  const cards = [];

  const [inc, prevInc, expRows, low, topDebtor, chRows] = await Promise.all([
    sumTransactions(business.id, "income", thisMonth, null),
    sumTransactions(business.id, "income", lastMonth, null),
    prisma.transaction.groupBy({
      by: ["category"],
      where: { businessId: business.id, type: "expense", date: { gte: thisMonth.start, lt: thisMonth.end } },
      _sum: { amount: true },
    }),
    prisma.$queryRaw`
      SELECT name, quantity FROM "InventoryItem"
      WHERE "businessId" = ${business.id} AND quantity <= "lowStockAlert"
      ORDER BY quantity ASC LIMIT 3
    `,
    prisma.customer.findFirst({
      where: { businessId: business.id, totalOwed: { gt: 0 } },
      orderBy: { totalOwed: "desc" },
      select: { name: true, totalOwed: true },
    }),
    prisma.transaction.groupBy({
      by: ["channel"],
      where: { businessId: business.id, type: "income", channel: { not: null }, date: { gte: thisMonth.start, lt: thisMonth.end } },
      _sum: { amount: true },
    }),
  ]);

  const delta = pctDelta(inc.total, prevInc.total);
  if (inc.count > 0) {
    cards.push({
      icon: "trending-up",
      title: `${money(inc.total, business.baseCurrency)} this month`,
      body: delta == null
        ? `${inc.count} income transaction${inc.count === 1 ? "" : "s"} so far.`
        : `Income is ${delta >= 0 ? "up" : "down"} ${Math.abs(delta).toFixed(0)}% vs the same point last month.`,
    });
  }

  const topExp = expRows
    .map((r) => ({ category: r.category || "other", amount: r._sum.amount || 0 }))
    .sort((a, b) => b.amount - a.amount)[0];
  if (topExp && topExp.amount > 0) {
    cards.push({
      icon: "wallet",
      title: `Biggest expense: ${topExp.category}`,
      body: `${money(topExp.amount, business.baseCurrency)} this month.`,
    });
  }

  if (low.length > 0) {
    cards.push({
      icon: "cube",
      title: `${low.length} item${low.length === 1 ? "" : "s"} low on stock`,
      body: low.map((r) => `${r.name} (${r.quantity})`).join(", "),
    });
  }

  if (topDebtor) {
    cards.push({
      icon: "cash",
      title: `${topDebtor.name} owes ${money(topDebtor.totalOwed, business.baseCurrency)}`,
      body: "Your biggest outstanding balance.",
    });
  }

  const topCh = chRows
    .map((r) => ({ channel: r.channel, amount: r._sum.amount || 0 }))
    .sort((a, b) => b.amount - a.amount)[0];
  if (topCh && topCh.amount > 0) {
    cards.push({
      icon: "megaphone",
      title: `${topCh.channel} leads your sales`,
      body: `${money(topCh.amount, business.baseCurrency)} this month came from ${topCh.channel}.`,
    });
  }

  return cards.slice(0, 5);
}

module.exports = {
  answerQuestion,
  generateInsightCards,
  SUGGESTIONS,
  // pure pieces exported for unit tests
  normalize,
  parseTimeRange,
  parseQuestion,
  matchIntent,
  previousPeriod,
};
