/**
 * Business Insights engine — a fully DETERMINISTIC "ask your books" algorithm.
 * No AI, no external calls (except the existing Anchor balance fetch): a
 * question goes through
 *
 *   normalize (typos + Pidgin/synonyms) → time-range parser (Africa/Lagos)
 *   → scored intent matcher (+ channel entity, compare flag, follow-up context)
 *   → scoped Prisma queries → template answers.
 *
 * Every number in an answer comes from a query — nothing is generated.
 * All queries are scoped to one businessId (ownership enforced by the route).
 *
 * DATA MODEL NOTE: manual bookkeeping lives in Sales (income) and Expense
 * (money out); the Transaction table holds bank/NUBAN movement only. Totals
 * therefore merge both sides, excluding bank credits already matched to a
 * recorded sale (matchedSaleId) OR applied to a customer's debt (matchedCustomerId),
 * and bank debits already recorded as an Expense (matchedExpenseId) — each sum
 * counts every unit of money exactly once.
 * This mirrors the Dashboard's Sales+Expense+Transaction merge.
 *
 * Exports: answerQuestion(), generateInsightCards(), SUGGESTIONS, and the pure
 * parser pieces (normalize/parseTimeRange/parseQuestion/matchIntent) for tests.
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
// the intents are scored against. ORDER MATTERS: the balance phrases must run
// before the money-in/out rules ("money in my account" — "money in" would
// otherwise eat the "in" that belongs to "in my account").
const PHRASE_MAP = [
  [/\bcash at hand\b/g, "balance"],
  [/\bin my account\b/g, "balance"],
  [/\bmy account\b/g, "balance"],
  [/\bin the bank\b/g, "balance"],
  // Perfect-tense sale statements ("i've sold 3 bags…") — rewrite before the
  // QUESTION_RE gate sees "have". Apostrophes are stripped, so ive/weve.
  [/\b(?:ive|weve|i have|we have) (?:just )?sold\b/g, "i sold"],
  [/\bdon make\b/g, "made"],
  [/\bdey owe\b/g, "owe"],
  [/\b(?:has not|hasnt|have not|havent|did not|didnt|never) pa(?:id|y)\b/g, "owe"],
  [/\bno pay\b/g, "owe"],
  // Pidgin greetings → "hello" BEFORE the token stage drops "dey"/"una". A real
  // question in the same message still outscores the greeting intent (ties
  // break to the earlier intent in the catalog, and greeting sits last).
  [/\bhow (?:you|una|una all) dey\b/g, "hello"],
  [/\bhow far\b/g, "hello"],
  [/\bhow much i don\b/g, "how much did i"],
  [/\bmoney wey\b/g, "money"],
  [/\bsell pass\b/g, "best seller"],
  [/\bsells? (?:the )?best\b/g, "best seller"],
  [/\bbuy pass\b/g, "best customer"],
  // Pidgin perfect tense: "i don sell 5000" is a completed-sale statement.
  // MUST run after "how much i don" → "how much did i" and "sell pass" →
  // "best seller" so Pidgin QUESTIONS keep routing as questions.
  [/\b(?:i|we) don sell\b/g, "i sold"],
  [/\bwhere (?:does|did|do|is) my money go(?:ing)?\b/g, "where my money go"],
  [/\bmoney out\b/g, "expenses"],
  [/\bmoney in\b/g, "income"],
  [/\bcame in\b/g, "income"],
  [/\bcome in\b/g, "income"],
  [/\brunning low\b/g, "low stock"],
  [/\bsold out\b/g, "low stock"], // "we sold out of rice" is a stock statement, not a sale
  [/\bout of stock\b/g, "low stock"],
  [/\bwalk in\b/g, "walkin"],
  [/\bwalk-in\b/g, "walkin"],
];

const TOKEN_MAP = {
  // Pidgin / colloquial
  wetin: "what", abeg: "", dey: "", una: "", oga: "", shey: "", abi: "",
  moni: "money", kudi: "money", ego: "money", cash: "money",
  customa: "customer", kastoma: "customer",
  // synonyms → canonical
  earn: "made", earned: "made", make: "made", makes: "made",
  earnings: "income", revenue: "income", turnover: "income",
  gain: "profit", gains: "profit", lose: "loss", lost: "loss", losing: "loss",
  spent: "spend", spending: "spend", cost: "spend", costs: "spend",
  expenditure: "expenses", expense: "expenses",
  debtor: "owe", debtors: "owe", debt: "owe", debts: "owe", owing: "owe", owes: "owe", owed: "owe",
  sale: "sales", sell: "sales", sells: "sales", // NOT "selling" — "top selling" is a top_products phrase
  bestseller: "best seller", ig: "instagram", insta: "instagram", wa: "whatsapp",
  goods: "product", items: "product", item: "product", products: "product",
  inventory: "stock", // NOT "restock" — it's the stock-update command verb

  invoices: "invoice", bill: "invoice", bills: "invoice",
  transactions: "transaction", txn: "transaction", txns: "transaction",
  clients: "customer", client: "customer", customers: "customer", buyer: "customer", buyers: "customer",
  tanx: "thanks", tnx: "thanks", thx: "thanks",
};

function normalize(question) {
  let s = String(question || "").toLowerCase();
  s = s.replace(/[’']/g, "").replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  for (const [re, to] of PHRASE_MAP) s = s.replace(re, to);
  const tokens = s
    .split(" ")
    .map((t) => {
      // own-property guard: "constructor" etc. must not hit the prototype chain
      if (Object.prototype.hasOwnProperty.call(TOKEN_MAP, t)) return TOKEN_MAP[t];
      // Spell-correct unknown tokens against the engine vocabulary ("porfit",
      // "expences", "mcuh"), then re-apply the synonym map to the correction
      // ("mkae" → "make" → "made").
      const c = correctToken(t);
      if (c !== t && Object.prototype.hasOwnProperty.call(TOKEN_MAP, c)) return TOKEN_MAP[c];
      return c;
    })
    .filter(Boolean);
  return tokens.join(" ");
}

// Damerau–Levenshtein distance ≤ 1: one insertion, deletion, substitution OR
// adjacent transposition ("porfit" → "profit", "stcok" → "stock").
function within1(a, b) {
  if (a === b) return true;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0;
  if (la === lb) {
    while (i < la && a[i] === b[i]) i++;
    if (i === la) return true;
    if (a.slice(i + 1) === b.slice(i + 1)) return true; // substitution
    return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2); // transposition
  }
  const [short, long] = la < lb ? [a, b] : [b, a];
  while (i < short.length && short[i] === long[i]) i++;
  return short.slice(i) === long.slice(i + 1); // insertion/deletion
}

// Real words that are edit-distance-1 from a vocabulary word but mean
// something else — never treat them as typos ("send"≈spend, "part
// payment"≈past, "debit alert"≈debt, "money back"≈bank, "were"≈where).
// Found by sweeping ~500 common English words through the corrector.
const TYPO_STOPLIST = new Set([
  "send", "sent", "stuck", "stick", "stack", "sock", "shock",
  "mode", "post", "weak", "speed",
  "back", "busy", "case", "debit", "good", "held", "least", "less",
  "list", "love", "must", "part", "pass", "safe", "same", "save", "scale", "were",
  "will", "hell", "think", "thinks", "dont",
  // near command verbs / new vocab (change≈chance/charge, create≈crate,
  // thanks≈tanks, loss≈lots, sales≈salt, what≈wheat, march≈match, than≈thank)
  "than", "chance", "charge", "crate", "tanks", "lots", "salt", "wheat", "match", "produce",
]);

// Engine vocabulary for spell correction — built lazily from everything the
// parser understands (synonyms, intent keywords/phrases, time words, channels)
// so it can never drift from the matcher.
let VOCAB = null;
function buildVocab() {
  const words = new Set();
  const add = (w) => { if (/^[a-z]{4,}$/.test(w)) words.add(w); };
  for (const [k, v] of Object.entries(TOKEN_MAP)) { add(k); String(v).split(" ").forEach(add); }
  for (const intent of INTENTS) {
    intent.phrases.forEach((p) => p.split(" ").forEach(add));
    intent.strong.forEach(add);
    intent.weak.forEach(add);
  }
  WEEKDAYS.forEach(add);
  MONTHS.forEach(add);
  Object.keys(CHANNELS).forEach(add);
  ["much", "money", "made", "today", "yesterday", "week", "weeks", "month",
    "months", "year", "years", "days", "this", "last", "past", "since", "what",
    "where", "which", "have", "profit",
    // command verbs are detected by regex in parseQuestion, not intent
    // keywords — added here so typos correct ("recored"→record, "updtae"→update)
    "record", "update", "change", "create",
  ].forEach(add);
  return words;
}

// Snap a token to a vocabulary word within one edit. Guards against false
// positives: min length 4, same first letter, stoplisted real words and
// anything containing a digit stay untouched. Ties break deterministically
// (same-length correction first, then alphabetical).
function correctToken(t) {
  if (t.length < 4 || /\d/.test(t) || TYPO_STOPLIST.has(t)) return t;
  if (!VOCAB) VOCAB = buildVocab();
  if (VOCAB.has(t)) return t;
  let best = null;
  for (const w of VOCAB) {
    if (w[0] !== t[0] || !within1(t, w)) continue;
    if (!best) { best = w; continue; }
    const bestSameLen = best.length === t.length;
    const wSameLen = w.length === t.length;
    if ((wSameLen && !bestSameLen) || (wSameLen === bestSameLen && w < best)) best = w;
  }
  return best || t;
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
  const monOffset = (dow + 6) % 7; // week starts Monday

  // "since yesterday" / "since last week" — open-ended through now (must run
  // before the bare yesterday/last-week checks, which are closed periods).
  if (/\bsince yesterday\b/.test(t)) {
    return { start: fromLagos(y, m, d - 1), end: now, label: "since yesterday", kind: "days", days: 1 };
  }
  if (/\bsince last week\b/.test(t)) {
    return { start: fromLagos(y, m, d - monOffset - 7), end: now, label: "since last week", kind: "days", days: monOffset + 7 };
  }

  if (/\btoday\b/.test(t)) return { start: fromLagos(y, m, d), end: now, label: "today", kind: "day" };
  if (/\byesterday\b/.test(t)) return { start: fromLagos(y, m, d - 1), end: fromLagos(y, m, d), label: "yesterday", kind: "day" };

  if (/\bthis week\b/.test(t)) return { start: fromLagos(y, m, d - monOffset), end: now, label: "this week", kind: "week" };
  if (/\blast week\b/.test(t)) {
    return { start: fromLagos(y, m, d - monOffset - 7), end: fromLagos(y, m, d - monOffset), label: "last week", kind: "week" };
  }

  if (/\bthis month\b/.test(t)) return { start: fromLagos(y, m, 1), end: now, label: "this month", kind: "month" };
  if (/\blast month\b/.test(t)) return { start: fromLagos(y, m - 1, 1), end: fromLagos(y, m, 1), label: "last month", kind: "month" };
  if (/\bthis year\b/.test(t)) return { start: fromLagos(y, 0, 1), end: now, label: "this year", kind: "year" };
  if (/\blast year\b/.test(t)) return { start: fromLagos(y - 1, 0, 1), end: fromLagos(y, 0, 1), label: "last year", kind: "year" };

  // "last/past N days|weeks|months" — months are CALENDAR months, not N×30 days
  const rel = t.match(/\b(?:last|past) (\d{1,3}) (day|week|month)s?\b/);
  if (rel) {
    const n = parseInt(rel[1], 10);
    const label = `the last ${n} ${rel[2]}${n === 1 ? "" : "s"}`;
    if (rel[2] === "month") {
      // Date.UTC inside fromLagos normalizes month underflow (year rolls) and
      // short-month overflow (May 31 − 3 months → "Feb 31" → Mar 2/3).
      return { start: fromLagos(y, m - n, d), end: now, label, kind: "days" };
    }
    const days = rel[2] === "day" ? n : n * 7;
    return { start: fromLagos(y, m, d - days), end: now, label, kind: "days", days };
  }

  // "since monday" — most recent such weekday (today counts)
  const since = t.match(/\bsince (sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  if (since) {
    const target = WEEKDAYS.indexOf(since[1]);
    const back = (dow - target + 7) % 7;
    return { start: fromLagos(y, m, d - back), end: now, label: `since ${since[1]}`, kind: "days", days: back || 7 };
  }

  // Quarters — "this quarter", "last quarter", "q1", "q3 2025".
  const qStart = Math.floor(m / 3) * 3;
  if (/\bthis quarter\b/.test(t)) {
    return { start: fromLagos(y, qStart, 1), end: now, label: "this quarter", kind: "days" };
  }
  if (/\blast quarter\b/.test(t)) {
    return { start: fromLagos(y, qStart - 3, 1), end: fromLagos(y, qStart, 1), label: "last quarter", kind: "days" };
  }
  const q = t.match(/\bq([1-4])(?:\s+(\d{4}))?\b/);
  if (q) {
    const qi = (parseInt(q[1], 10) - 1) * 3;
    const yr = q[2] ? parseInt(q[2], 10) : qi > m ? y - 1 : y;
    const isCurrent = yr === y && m >= qi && m < qi + 3;
    return {
      start: fromLagos(yr, qi, 1),
      end: isCurrent ? now : fromLagos(yr, qi + 3, 1),
      label: `Q${q[1]} ${yr}`,
      kind: "days",
    };
  }

  // Month + explicit year ("june 2024") — pins the exact month, any year.
  // Must run before the bare-month loop, which only knows this-or-last year.
  const my = t.match(new RegExp(`\\b(${MONTHS.join("|")})\\s+(\\d{4})\\b`));
  if (my) {
    const i = MONTHS.indexOf(my[1]);
    const yr = parseInt(my[2], 10);
    const isCurrent = yr === y && i === m;
    return {
      start: fromLagos(yr, i, 1),
      end: isCurrent ? now : fromLagos(yr, i + 1, 1),
      label: `${MONTHS[i]} ${yr}`,
      kind: "month",
    };
  }

  // Month names ("in june", "june") — this year, or last year if in the future.
  // "may" is also a modal verb ("how much may i make"), so it only counts as a
  // month with an anchor: a preceding preposition or a trailing 4-digit year.
  for (let i = 0; i < 12; i++) {
    const re = i === 4
      ? /\b(?:in|for|during|since|last) may\b|\bmay \d{4}\b/
      : new RegExp(`\\b${MONTHS[i]}\\b`);
    if (re.test(t)) {
      const year = i > m ? y - 1 : y;
      const end = year === y && i === m ? now : fromLagos(year, i + 1, 1);
      return { start: fromLagos(year, i, 1), end, label: `${MONTHS[i]} ${year}`, kind: "month" };
    }
  }

  return null;
}

// The comparable period immediately before. Completed ranges (yesterday, last
// week, last month, june) → the full prior period. To-date ranges (today, this
// week/month/year, current month name) → the same elapsed span of the prior
// period, so deltas compare like with like instead of partial-vs-full.
function previousPeriod(range, now = new Date()) {
  const isToDate = now.getTime() - range.end.getTime() < 60 * 1000; // end ≈ now
  const elapsed = range.end.getTime() - range.start.getTime();
  const s = new Date(range.start.getTime() + WAT_MS);
  let prevStart, toDateLabel, fullLabel;
  switch (range.kind) {
    case "day":
      prevStart = new Date(range.start.getTime() - 86400000);
      toDateLabel = "this time yesterday"; fullLabel = "the day before"; break;
    case "week":
      prevStart = new Date(range.start.getTime() - 7 * 86400000);
      toDateLabel = "the same point last week";
      fullLabel = range.label === "this week" ? "last week" : "the week before"; break;
    case "month":
      prevStart = fromLagos(s.getUTCFullYear(), s.getUTCMonth() - 1, 1);
      toDateLabel = "the same point last month"; fullLabel = "the month before"; break;
    case "year":
      prevStart = fromLagos(s.getUTCFullYear() - 1, 0, 1);
      toDateLabel = "the same point last year"; fullLabel = "the year before"; break;
    default: // kind "days" ("last N days", "since monday") is equal-length by construction
      return { start: new Date(range.start.getTime() - elapsed), end: range.start, label: "the period before" };
  }
  if (isToDate) {
    // Cap at range.start so month-to-date late in a 31-day month can't spill
    // past a shorter previous month into the current period.
    const end = new Date(Math.min(prevStart.getTime() + elapsed, range.start.getTime()));
    return { start: prevStart, end, label: toDateLabel };
  }
  return { start: prevStart, end: range.start, label: fullLabel };
}

function defaultRange(now = new Date()) {
  const { y, m } = lagosParts(now);
  return { start: fromLagos(y, m, 1), end: now, label: "this month", kind: "month" };
}

// ── Channel entity ───────────────────────────────────────────────────────────
const CHANNELS = { instagram: "instagram", whatsapp: "whatsapp", walkin: "walk-in", online: "online" };
// Channel mentions inside a record-sale command are sale metadata, not product
// names ("i sold 5000 on whatsapp" must not become a "Whatsapp" product).
// Connector-anchored so a product genuinely named "online course" survives;
// includes raw aliases (ig/insta/wa) since extractDetail runs on the RAW text.
const CHANNEL_MENTION_RE = /\b(?:on|via|from|through|thru)\s+(?:whatsapp|watsapp|wa|instagram|insta|ig|online|walk[\s-]?in)\b/gi;
function parseChannels(text) {
  return Object.keys(CHANNELS)
    .filter((key) => new RegExp(`\\b${key}\\b`).test(text))
    .map((key) => CHANNELS[key]);
}

// ── Intent catalog + scoring ─────────────────────────────────────────────────
// phrases score 5, strong keywords 3 (typo'd strong also 3), weak keywords 1.
// Highest total wins; below THRESHOLD → fallback (or follow-up via context).
const THRESHOLD = 3;

// NOTE: phrases must be in POST-normalization form (e.g. make→made, so the
// phrase is "how much did i made").
const INTENTS = [
  { id: "income", phrases: ["how much did i made", "how much have i made"], strong: ["income", "made", "sales"], weak: ["money", "sold", "total"] },
  { id: "expenses", phrases: ["what did i spend"], strong: ["expenses", "spend"], weak: ["money"] },
  { id: "expense_breakdown", phrases: ["spend most on", "where my money go", "biggest expenses"], strong: ["category", "categories"], weak: ["spend", "expenses", "biggest"] },
  { id: "profit", phrases: ["how is my business doing", "how my business"], strong: ["profit", "loss"], weak: ["net", "doing", "performance"] },
  { id: "debts", phrases: ["who owe me"], strong: ["owe"], weak: ["outstanding", "collect"] },
  { id: "payables", phrases: [], strong: [], weak: [] }, // routed by direction detection in parseQuestion
  { id: "top_customers", phrases: ["best customer", "top customer", "biggest customer", "who buys the most"], strong: [], weak: ["customer", "best", "top", "biggest"] },
  // "product sales best" is the post-normalization form of "product sells best"
  { id: "top_products", phrases: ["best seller", "top product", "best product", "top selling", "product sales best"], strong: [], weak: ["product", "seller", "selling", "best", "top"] },
  { id: "stock", phrases: ["low stock", "what should i stock"], strong: ["stock", "restock"], weak: ["product", "left", "remain", "remaining", "finish", "finished", "quantity"] },
  { id: "channels", phrases: ["by channel", "which channel", "sales by channel"], strong: ["channel", "channels"], weak: ["breakdown", "split", "compare"] },
  { id: "invoices", phrases: ["unpaid invoice", "overdue invoice"], strong: ["invoice"], weak: ["unpaid", "overdue", "paid"] },
  { id: "count", phrases: ["how many sales", "how many transaction", "number of sales"], strong: [], weak: ["how", "many", "transaction", "count", "sales"] },
  { id: "balance", phrases: ["bank balance", "account balance", "how much do i have", "how much money do i have"], strong: ["balance"], weak: ["bank", "account", "wallet"] },
  { id: "best_day", phrases: ["best day", "busiest day", "which day", "sales day"], strong: ["busiest"], weak: ["day", "best"] },
  { id: "help", phrases: ["what can you do", "what can i ask"], strong: ["help"], weak: [] },
  // Small talk — a real question in the same message outscores these.
  { id: "greeting", phrases: ["good morning", "good afternoon", "good evening", "good night", "how you dey", "well done"], strong: ["hello", "hi", "hey"], weak: ["morning", "afternoon", "evening", "greetings"] },
  { id: "thanks", phrases: ["thank you"], strong: ["thanks"], weak: [] },
  // Record commands — detected by parseQuestion's command check (regex on the
  // statement shape), not by keyword scoring; listed here so they're valid
  // follow-up contexts (the bare-amount reply after "record a sale").
  { id: "record_sale", phrases: [], strong: [], weak: [] },
  { id: "record_expense", phrases: [], strong: [], weak: [] },
];

// Small-talk intents never carry over as follow-up context ("what about last
// week?" after a greeting must not answer with another greeting).
const SMALLTALK = new Set(["greeting", "thanks", "help"]);

// Record commands: only a bare-amount reply may re-enter them via context.
const ACTION_INTENTS = new Set(["record_sale", "record_expense"]);

// Anything question-shaped must never be treated as a record command
// ("how much did i sell today", "add up my sales", "should i restock rice").
const QUESTION_RE = /\b(?:should|need|any|how|what|who|which|when|why|much|many|did|do|does|have|has|show|total|up)\b/;

// ── Amount + detail extraction for record commands (run on the RAW question —
// normalize() turns "5,000" into two tokens) ─────────────────────────────────
// Shared number shape: "1,500.75", "5 000 000" (space groups), "5000", "2.5".
const NUM_SRC = "\\d{1,3}(?:[ ,]\\d{3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?";
const NUM_G_RE = new RegExp(`(${NUM_SRC})\\s*([km])?\\b`, "g"); // safe: matchAll clones
const numVal = (numStr, suffix) =>
  parseFloat(String(numStr).replace(/[ ,]/g, "")) * (suffix === "k" ? 1e3 : suffix === "m" ? 1e6 : 1);

// "5k"/"2m" multiply. Priority: a number followed by "each" is the UNIT price
// (× quantity), then a k/m-marked number, then one after "for/at" ("3 bags of
// rice for 15000" → 15000, not 3), else the largest.
function extractAmount(raw) {
  const s = String(raw || "").toLowerCase().replace(/₦|ngn/g, " ");
  const found = [];
  for (const m of s.matchAll(NUM_G_RE)) {
    const value = numVal(m[1], m[2]);
    if (Number.isFinite(value) && value > 0 && value <= 1e12) {
      found.push({ value, marked: !!m[2], index: m.index, end: m.index + m[0].length });
    }
  }
  if (!found.length) return null;
  const each = found.find((x) => /^\s*each\b/.test(s.slice(x.end)));
  if (each) {
    const qty = found.find((x) => x !== each && !x.marked && Number.isInteger(x.value) && x.value >= 1 && x.value <= 9999);
    return each.value * (qty ? qty.value : 1);
  }
  const marked = found.find((x) => x.marked);
  if (marked) return marked.value;
  const after = found.find((x) => /\b(?:for|at)\s*$/.test(s.slice(0, x.index)));
  if (after) return after.value;
  return Math.max(...found.map((x) => x.value));
}

// The quantity sold: the first unmarked small integer that isn't the amount
// ("i sold 3 bags of rice for 15000" → 3). Defaults to 1.
function extractQuantity(raw, amount) {
  const s = String(raw || "").toLowerCase().replace(/₦|ngn/g, " ");
  for (const m of s.matchAll(NUM_G_RE)) {
    if (m[2]) continue; // k/m-marked numbers are money
    const n = numVal(m[1], null);
    if (Number.isInteger(n) && n >= 1 && n <= 9999 && n !== amount) return n;
  }
  return 1;
}

// Match the command's detail text against the business's inventory names.
// Returns ranked candidates: score 1 = every word of the item name appears in
// the detail ("bags of rice" ⊇ "Rice"), fractional = partial ("rice" vs
// "Rice 50kg" → 0.5). Requires at least one substantive (≥3-char) shared
// token so filler words never qualify. Pure (items passed in) for tests.
function findInventoryCandidates(detail, items) {
  if (!detail) return [];
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/).filter(Boolean).map((w) => w.replace(/s$/, ""));
  const detailTokens = new Set(norm(detail));
  const scored = [];
  for (const item of items || []) {
    const nameTokens = norm(item.name);
    if (!nameTokens.length) continue;
    const hits = nameTokens.filter((w) => detailTokens.has(w));
    if (!hits.some((w) => w.length >= 3)) continue;
    scored.push({ item, score: hits.length / nameTokens.length });
  }
  scored.sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name));
  return scored;
}

// Auto-link only when exactly ONE item matches fully — anything less certain
// (partial or multiple full matches) is the caller's cue to ask the user.
function matchInventoryItem(detail, items) {
  const full = findInventoryCandidates(detail, items).filter((s) => s.score >= 1);
  return full.length === 1 ? full[0].item : null;
}

function titleCase(s) {
  return String(s || "").split(" ").map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(" ");
}

// Positional consumption: label words travel WITH their number, so bare
// "price"/"stock" INSIDE a product name ("Price Tags", "Stock Cubes") survive.
const TRAILING_NUMS_RE = new RegExp(`(?:(?:${NUM_SRC})\\s*[km]?\\s*)+$`);

// Parse a create-product command: "add new product shawarma at 1500, 20 in
// stock". Labeled numbers win (price/at/cost…, stock/qty/"N in stock");
// unlabeled TRAILING numbers: k/m-marked or the largest → price, an unmarked
// integer → stock. Numbers that are part of the name ("5 alive", "rice 50kg")
// are neither consumed nor stripped.
const CREATE_STRIP = ["create", "product", "products", "item", "items", "goods", "at", "is", "in", "called", "named", "with"];
function parseCreateCommand(raw) {
  let s = String(raw || "").toLowerCase().replace(/₦|ngn/g, " ");
  let price = null, stock = null;
  const pm = s.match(new RegExp(`(?:price|cost|at|sells? for)\\s*(?:of|is|to)?\\s*(${NUM_SRC})\\s*([km])?\\b`));
  if (pm) { price = numVal(pm[1], pm[2]); s = s.replace(pm[0], " "); }
  const sm = s.match(/(?:stock|quantity|qty)\s*(?:of|is|to|at)?\s*(\d{1,6})\b/) || s.match(/\b(\d{1,6})\s*in stock\b/);
  if (sm) { stock = parseInt(sm[1], 10); s = s.replace(sm[0], " "); }
  // unlabeled numbers only count when they TRAIL the name
  s = s.replace(/[.,;!?\s]+$/, "");
  const tail = s.match(TRAILING_NUMS_RE);
  if (tail) {
    s = s.slice(0, tail.index);
    const rest = [...tail[0].matchAll(NUM_G_RE)]
      .map((m) => ({ v: numVal(m[1], m[2]), marked: !!m[2] }))
      .filter((x) => Number.isFinite(x.v) && x.v > 0 && x.v <= 1e12);
    if (price == null && rest.length) {
      const pick = rest.find((x) => x.marked) || rest.reduce((a, b) => (b.v > a.v ? b : a));
      price = pick.v;
      rest.splice(rest.indexOf(pick), 1);
    }
    if (stock == null) {
      const pick = rest.find((x) => Number.isInteger(x.v) && !x.marked && x.v <= 1e6);
      if (pick) stock = pick.v;
    }
  }
  return { name: extractDetail(s, CREATE_STRIP, true), price, stock: stock == null ? 0 : stock };
}

// Parse an inventory-update command: "restock rice 20" (add), "set rice stock
// to 50" (absolute), "change rice price to 1500" (price). Pure, testable.
const UPDATE_STRIP = ["restock", "restocked", "update", "change", "inventory", "units", "unit", "pieces", "piece", "left", "with", "more", "by"];
function parseUpdateCommand(raw) {
  const s = String(raw || "").toLowerCase();
  // An explicit restock verb means ADD unless the user wrote "to <number>" —
  // a product name containing "set" ("Spoon Set") must not flip the mode.
  const mode = /\bprice\b/.test(s) ? "price"
    : /\brestock/.test(s) && !/\bto\s*₦?\s*\d/.test(s) ? "add"
    : (/\bset\b/.test(s) || /\bto\s*₦?\s*\d/.test(s)) ? "set"
    : "add";
  let value = null;
  if (mode === "price") {
    value = extractAmount(raw);
  } else {
    // stock counts: the LAST number wins, so product names with numbers
    // ("Rice 50kg" — which never parses as a number) and "set X to N" both
    // work. Zero is allowed only for absolute sets ("set rice stock to 0").
    const nums = [...s.replace(/₦|ngn/g, " ").matchAll(NUM_G_RE)]
      .map((m) => numVal(m[1], m[2]))
      .filter((n) => Number.isFinite(n) && (mode === "set" ? n >= 0 : n > 0) && n <= 1e9);
    if (nums.length) value = Math.round(nums[nums.length - 1]);
  }
  // Product name: consume label+number units positionally, then the leading
  // command verb and "to stock/inventory" phrasing — keeping name-internal
  // words ("Stock Cubes", "Spoon Set", "Rice 50kg") intact. Standalone digits
  // are stripped by extractDetail (the value was already taken from them).
  const cleaned = s
    .replace(new RegExp(`\\b(?:stock|price|quantity|qty)\\s*(?:of|is|to|at)?\\s*(?:${NUM_SRC})\\s*[km]?\\b`, "g"), " ")
    .replace(new RegExp(`\\b(?:to|at)\\s*₦?\\s*(?:${NUM_SRC})\\s*[km]?\\b`, "g"), " ")
    .replace(/\b(?:to|into|in)\s+(?:the\s+)?(?:stock|inventory)\b/g, " ")
    .replace(/^\s*(?:restock(?:ed)?|set|update|change)\b/, " ")
    .replace(/\b(?:stock|price)\s*$/, " ");
  return { mode, value, detail: extractDetail(cleaned, UPDATE_STRIP) };
}

// What's left of a record command once verbs, fillers and amounts are removed
// ("i sold 3 bags of rice for 15000" → "bags of rice"). keepNumbers skips the
// blanket digit strip for callers that consume numbers positionally.
function extractDetail(raw, extraStrip, keepNumbers) {
  let s = String(raw || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ");
  if (!keepNumbers) s = s.replace(/\b\d[\d.]*\s*[km]?\b/g, " ");
  s = s.replace(/\b(?:record|add|log|i|ive|we|weve|ve|have|don|just|sold|sell|spent|spend|bought|paid|pay|a|an|the|my|new|please|abeg|naira|ngn|sale|sales|expense|expenses|money)\b/g, " ");
  if (extraStrip && extraStrip.length) {
    s = s.replace(new RegExp(`\\b(?:${extraStrip.join("|")})\\b`, "g"), " ");
  }
  s = s.replace(/\s+/g, " ").trim();
  // connectors survive mid-detail ("bags of rice") but not at the edges or alone
  s = s.replace(/^(?:of|on|for|and|to)\s+/, "").replace(/\s+(?:of|on|for|and|to)$/, "");
  if (/^(?:of|on|for|and|to)(?:\s+(?:of|on|for|and|to))*$/.test(s)) s = "";
  return s ? s.slice(0, 60) : null;
}

function matchIntent(text) {
  const tokens = text.split(" ");
  let best = null;
  const scores = {};
  for (const intent of INTENTS) {
    let score = 0;
    for (const p of intent.phrases) if (text.includes(p)) score += 5;
    for (const k of intent.strong) {
      if (tokens.includes(k)) score += 3;
      else if (
        k.length >= 5 &&
        tokens.some((tk) => tk.length >= 4 && !TYPO_STOPLIST.has(tk) && within1(tk, k))
      ) score += 3; // typo'd strong keyword still counts as strong
    }
    for (const k of intent.weak) if (tokens.includes(k)) score += 1;
    scores[intent.id] = score;
    if (!best || score > best.score) best = { id: intent.id, score };
  }
  // "income vs expenses" names BOTH sides — that's a profit question, not an
  // income question that happens to win the index-order tie-break.
  if (scores.income >= 3 && scores.expenses >= 3 && (best.id === "income" || best.id === "expenses")) {
    best = { id: "profit", score: scores.income + scores.expenses };
  }
  return best && best.score >= THRESHOLD ? best : null;
}

const COMPARE_RE = /\b(compare|compared|vs|versus|than last|change)\b/;

// ── Follow-up context ────────────────────────────────────────────────────────
// Two shapes, both accepted forever:
//   legacy: the bare intent id ("income") — older clients round-trip this
//   rich:   JSON {"i":intent,"c":channel,"r":{"s":ISO,"e":ISO,"l":label,"k":kind}}
// The rich shape is what makes BOTH directions of follow-up work: "and on
// instagram?" after "income last week" keeps last week, and "what about
// june?" after "instagram sales" keeps the channel. The old shape kept only
// the intent, so every follow-up silently reset to this-month.
function parseContext(context) {
  if (!context || typeof context !== "string") return null;
  if (context[0] !== "{") return { intent: context, channel: null, range: null };
  try {
    const j = JSON.parse(context);
    let range = null;
    if (j.r && j.r.s && j.r.e) {
      const s = new Date(j.r.s);
      const e = new Date(j.r.e);
      if (!Number.isNaN(s.getTime()) && !Number.isNaN(e.getTime()) && s < e) {
        range = {
          start: s, end: e,
          label: String(j.r.l || "that period").slice(0, 60),
          kind: typeof j.r.k === "string" ? j.r.k : "days",
        };
      }
    }
    return {
      intent: typeof j.i === "string" ? j.i : null,
      channel: typeof j.c === "string" && Object.values(CHANNELS).includes(j.c) ? j.c : null,
      range,
    };
  } catch {
    return null;
  }
}

// The context string an answer hands back for the NEXT question. Only real
// query intents carry over — small talk and record commands must not.
function buildNextContext(intent, range, channel) {
  if (!intent || !INTENTS.some((i) => i.id === intent)) return null;
  if (SMALLTALK.has(intent) || ACTION_INTENTS.has(intent)) return null;
  return JSON.stringify({
    i: intent,
    ...(channel ? { c: channel } : {}),
    r: {
      s: range.start.toISOString(),
      e: range.end.toISOString(),
      l: range.label,
      k: range.kind || "days",
    },
  });
}

// ── Person entity (customer names) ──────────────────────────────────────────
// Anchored patterns only — free NER over normalized text would eat vocab
// words. Runs on POST-normalization text (lowercase, apostrophes stripped, so
// "Chioma's debt" arrives as "chiomas debt"; the within-1 customer matcher
// absorbs the trailing s).
const NAME_STOPWORDS = new Set([
  "i", "we", "me", "us", "my", "our", "you", "who", "he", "she", "they", "them",
  "it", "anyone", "anybody", "someone", "somebody", "people", "customer",
  "customers", "everyone", "the", "that", "this", "a", "much", "money", "still",
  "total", "any", "all", "do", "does", "did", "how", "what", "which",
]);
function extractPersonName(text) {
  const t = ` ${text} `;
  const pats = [
    // "how much does chioma owe" / "does ada g still owe"
    /\b(?:does|do)\s+([a-z][a-z ]{1,28}?)\s+(?:still\s+)?owes?\b/,
    // "chioma's debt" — normalize strips the apostrophe AND maps debt→owe, so
    // the surviving shape is "chiomas owe": one word with a possessive s.
    /\b([a-z]{3,20})s\s+owe\b/,
    // "chioma balance" (balance survives normalization)
    /\b([a-z][a-z ]{1,28}?)s?\s+balance\b/,
    // "sales to chioma" / "income from ada"
    /\b(?:sales|income)\s+(?:to|from)\s+([a-z][a-z ]{1,28}?)\s*$/,
  ];
  for (const re of pats) {
    const m = re.exec(t);
    if (!m) continue;
    const candidate = m[1].trim();
    if (!candidate) continue;
    const words = candidate.split(" ");
    // Every word a stopword → not a name ("does anyone owe", "my debt").
    if (words.every((w) => NAME_STOPWORDS.has(w))) continue;
    // A leading stopword run before the name ("does the customer chioma owe")
    // gets trimmed; anything left is the candidate.
    while (words.length && NAME_STOPWORDS.has(words[0])) words.shift();
    if (!words.length || words.length > 3) continue;
    return words.join(" ");
  }
  return null;
}

// Full parse (pure, testable): question (+ optional follow-up context) →
// { intent, range, channel, compare, usedContext }
function parseQuestion(question, context = null, now = new Date()) {
  const text = normalize(question);
  const ctx = parseContext(context);
  let range = parseTimeRange(text, now);
  const channelList = parseChannels(text);
  let channel = channelList.length === 1 ? channelList[0] : null;
  const compare = COMPARE_RE.test(` ${text} `);

  // Two-period comparison: "june vs march", "this week vs last month". Both
  // sides must parse as time ranges; a channel-vs-channel question ("ig vs
  // whatsapp") has no range on either side and stays with the channels intent.
  let rangeB = null;
  const vsParts = ` ${text} `.split(/\b(?:vs|versus|compared to|compared with|against)\b/);
  if (vsParts.length === 2) {
    const rA = parseTimeRange(vsParts[0], now);
    const rB = parseTimeRange(vsParts[1], now);
    if (rA && rB) {
      range = rA;
      rangeB = rB;
    }
  }

  let match;
  // Record commands ("record a sale of 5000", "i sold 3 bags of rice for
  // 15k", "i spent 2k on fuel") — statement-shaped, never question-shaped.
  // Post-normalization: sale→sales, expense(s)→expenses, spent→spend.
  if (!QUESTION_RE.test(` ${text} `)) {
    const tokens = text.split(" ");
    const explicit = tokens.some((t) => t === "record" || t === "add" || t === "log");
    // New product first ("add new product shawarma at 1500") — goods/item(s)
    // normalize to "product". The verb must be ADJACENT to "product" so
    // "i sold a new product for 5000" / "record a sale of my new product"
    // stay record commands and "any new product sales this week" stays a query.
    if (/\b(?:add|create)\s+(?:a\s+)?(?:new\s+)?product\b/.test(text)) {
      match = { id: "create_product", score: 9 };
    } else if (
      // Inventory updates — they name stock/price explicitly. The set/update/
      // change shape needs a number so "update me on my stock" stays a query
      // (bare "restock rice" still prompts for the count).
      /\brestock/.test(text) ||
      (/\b(?:set|update|change)\b/.test(text) && /\b(?:stock|price)\b/.test(text) && /\d/.test(text)) ||
      (tokens.includes("add") && tokens.includes("stock"))
    ) {
      match = { id: "update_stock", score: 9 };
    } else if ((explicit && tokens.includes("sales")) || /\b(?:i|we) (?:just )?sold\b/.test(text)) {
      match = { id: "record_sale", score: 9 };
    } else if ((explicit && tokens.includes("expenses")) || /\b(?:i|we) (?:just )?(?:spend|bought|paid)\b/.test(text)) {
      match = { id: "record_expense", score: 9 };
    }
  }
  // Bare-amount reply after "record a sale" → "5000" / "5k" / "5,000"
  if (!match && ctx?.intent && ACTION_INTENTS.has(ctx.intent) && /^\d[\d\s.]*[km]?$/.test(text)) {
    match = { id: ctx.intent, score: THRESHOLD };
  }
  // Direction check: "do i owe / i owe" is the merchant's OWN payables — the
  // opposite of the debts intent — unless they said "owe me/us" ("who owes me"
  // normalizes to "who owe me") or "am/are i/we owe(d)" (being owed = debts).
  if (
    !match &&
    /\b(?:do |does |should |must )?(?:i|we) owe\b/.test(text) &&
    !/\b(?:am|are) (?:i|we) owe\b/.test(text) &&
    !/\bowe (?:me|us)\b/.test(text)
  ) {
    match = { id: "payables", score: 5 };
  }
  if (!match && channelList.length >= 2) {
    // Two+ channels named ("whatsapp vs instagram sales") → per-channel breakdown
    match = { id: "channels", score: 5 };
  }
  if (!match) match = matchIntent(text);
  // A bare period-vs-period question ("june vs march") names no money word —
  // sales is the default thing merchants compare.
  if (!match && rangeB) match = { id: "income", score: THRESHOLD };
  let usedContext = false;

  // Follow-up: "what about last week?" / "what about instagram?" — a time or
  // channel expression with no clear intent reuses the previous question's
  // intent, AND inherits whichever dimension the follow-up did NOT restate:
  // "and on instagram?" after "income last week" keeps last week; "what about
  // june?" after "instagram sales" keeps the channel. (Legacy intent-id
  // contexts have no range/channel to inherit and behave as before.)
  if (!match && (range || channel) && ctx?.intent) {
    if (INTENTS.some((i) => i.id === ctx.intent) && !SMALLTALK.has(ctx.intent) && !ACTION_INTENTS.has(ctx.intent)) {
      match = { id: ctx.intent, score: THRESHOLD };
      usedContext = true;
      if (!range && ctx.range) range = ctx.range;
      if (!channel && channelList.length === 0 && ctx.channel) channel = ctx.channel;
    }
  }

  // Nothing cleared the bar — surface the closest sub-threshold intent so the
  // fallback can offer "did you mean…?" instead of a dead end.
  let nearMiss = null;
  if (!match) {
    const near = nearestIntent(text);
    if (near) nearMiss = near.id;
  }

  return {
    intent: match ? match.id : null,
    range: range || defaultRange(now),
    hadExplicitRange: !!range,
    rangeB,
    channel,
    compare,
    usedContext,
    personName: extractPersonName(text),
    nearMiss,
    text,
    raw: String(question || ""),
  };
}

// The best intent that DIDN'T clear the threshold — fuel for "did you mean".
function nearestIntent(text) {
  const tokens = text.split(" ");
  let best = null;
  for (const intent of INTENTS) {
    if (SMALLTALK.has(intent.id) || ACTION_INTENTS.has(intent.id)) continue;
    let score = 0;
    for (const p of intent.phrases) if (text.includes(p)) score += 5;
    for (const k of intent.strong) {
      if (tokens.includes(k)) score += 3;
      else if (
        k.length >= 5 &&
        tokens.some((tk) => tk.length >= 4 && !TYPO_STOPLIST.has(tk) && within1(tk, k))
      ) score += 3;
    }
    for (const k of intent.weak) if (tokens.includes(k)) score += 1;
    if (score > 0 && score < THRESHOLD && (!best || score > best.score)) best = { id: intent.id, score };
  }
  return best;
}

// ── Query layer ──────────────────────────────────────────────────────────────
// Manual bookkeeping lives in Sales/Expense; Transaction holds bank movement.
// Income = all Sales + bank credits NOT matched to a sale or a debt (both ids null,
// so a recorded sale that was paid by transfer isn't double-counted).
async function sumIncome(businessId, range, channel) {
  const date = { gte: range.start, lt: range.end };
  const [sales, bank, remainder] = await Promise.all([
    prisma.sales.aggregate({
      where: { businessId, date, ...(channel ? { channel } : {}) },
      _sum: { amount: true },
      _count: { _all: true },
    }),
    prisma.transaction.aggregate({
      where: { businessId, type: "income", date, matchedSaleId: null, matchedCustomerId: null, ...(channel ? { channel } : {}) },
      _sum: { amount: true },
      _count: { _all: true },
    }),
    sumMatchedRemainder(businessId, "income", date, channel),
  ]);
  return {
    total: Number(sales._sum.amount || 0) + Number(bank._sum.amount || 0) + remainder,
    count: sales._count._all + bank._count._all,
  };
}

// Expenses = recorded Expense rows + bank money-out (transfers, bills).
async function sumExpenses(businessId, range) {
  const date = { gte: range.start, lt: range.end };
  const [exp, bank, remainder] = await Promise.all([
    prisma.expense.aggregate({ where: { businessId, date }, _sum: { amount: true }, _count: { _all: true } }),
    prisma.transaction.aggregate({
      where: { businessId, type: "expense", matchedExpenseId: null, date },
      _sum: { amount: true },
      _count: { _all: true },
    }),
    sumMatchedRemainder(businessId, "expense", date),
  ]);
  return {
    total: Number(exp._sum.amount || 0) + Number(bank._sum.amount || 0) + remainder,
    count: exp._count._all + bank._count._all,
  };
}

// Partial matches: a matched bank row is excluded from the sums above because
// the Sales/Expense/DebtPayment rows carry that money — but when the match
// accounted for LESS than the row (a ₦5,000 credit that paid a ₦3,000 debt),
// the unmatched remainder is still real money and must stay in the totals.
// Rows matched before matchedAmount existed carry NULL = treated as fully
// matched, which is exactly the old behavior.
async function sumMatchedRemainder(businessId, type, date, channel) {
  const agg = await prisma.transaction.aggregate({
    where: {
      businessId, type, date,
      matchedAmount: { not: null },
      ...(type === "income"
        ? { OR: [{ matchedSaleId: { not: null } }, { matchedCustomerId: { not: null } }] }
        : { matchedExpenseId: { not: null } }),
      ...(channel ? { channel } : {}),
    },
    _sum: { amount: true, matchedAmount: true },
  });
  const rem = Number(agg._sum.amount || 0) - Number(agg._sum.matchedAmount || 0);
  return rem > 0 ? Math.round(rem * 100) / 100 : 0;
}

// Merge {key → amount} maps from several groupBy sweeps.
function mergeSums(target, rows, keyOf) {
  for (const r of rows) {
    const key = keyOf(r);
    target.set(key, (target.get(key) || 0) + Number(r._sum.amount || 0)); // Number(): Transaction _sum is Decimal
  }
  return target;
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
    const cur = await sumIncome(business.id, range, channel);
    const chLabel = channel ? ` from ${channel} sales` : "";
    let tail = "";
    if (compare || range.kind === "week" || range.kind === "month") {
      const prev = previousPeriod(range);
      const p = await sumIncome(business.id, prev, channel);
      tail = deltaPhrase(pctDelta(cur.total, p.total), prev.label);
    }
    if (cur.count === 0) return { answer: `No income recorded ${range.label}${chLabel}.` };
    return {
      answer: `You made ${money(cur.total, business.baseCurrency)}${chLabel} ${range.label} (${cur.count} record${cur.count === 1 ? "" : "s"})${tail}.`,
      data: { total: cur.total, count: cur.count },
    };
  },

  async expenses({ business, range, compare }) {
    const cur = await sumExpenses(business.id, range);
    let tail = "";
    if (compare) {
      const prev = previousPeriod(range);
      const p = await sumExpenses(business.id, prev);
      tail = deltaPhrase(pctDelta(cur.total, p.total), prev.label);
    }
    if (cur.count === 0) return { answer: `No expenses recorded ${range.label}.` };
    return {
      answer: `You spent ${money(cur.total, business.baseCurrency)} ${range.label} (${cur.count} expense${cur.count === 1 ? "" : "s"})${tail}.`,
      data: { total: cur.total, count: cur.count },
    };
  },

  async expense_breakdown({ business, range }) {
    const date = { gte: range.start, lt: range.end };
    const [expRows, bankRows] = await Promise.all([
      prisma.expense.groupBy({
        by: ["category"],
        where: { businessId: business.id, date },
        _sum: { amount: true },
      }),
      prisma.transaction.groupBy({
        by: ["category"],
        where: { businessId: business.id, type: "expense", matchedExpenseId: null, date },
        _sum: { amount: true },
      }),
    ]);
    const byCat = mergeSums(new Map(), expRows, (r) => r.category || "other");
    mergeSums(byCat, bankRows, (r) => r.category || "other");
    const top = [...byCat.entries()]
      .map(([category, amount]) => ({ category, amount }))
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
      sumIncome(business.id, range, null),
      sumExpenses(business.id, range),
    ]);
    const net = inc.total - exp.total;
    const prev = previousPeriod(range);
    const [pInc, pExp] = await Promise.all([
      sumIncome(business.id, prev, null),
      sumExpenses(business.id, prev),
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

  // The other direction: what the merchant owes (unpaid payables).
  async payables({ business }) {
    const rows = await prisma.payable.findMany({
      where: { businessId: business.id, paid: false },
      select: { creditorName: true, amount: true, paidAmount: true },
    });
    const open = rows
      .map((r) => ({ name: r.creditorName, balance: Math.max(0, (r.amount || 0) - (r.paidAmount || 0)) }))
      .filter((r) => r.balance > 0)
      .sort((a, b) => b.balance - a.balance);
    if (open.length === 0) return { answer: "You don't owe anyone right now — no unpaid payables. ✅" };
    const total = open.reduce((n, r) => n + r.balance, 0);
    const list = open.slice(0, 5).map((r) => `${r.name} (${money(r.balance, business.baseCurrency)})`).join(", ");
    return {
      answer: `You owe ${money(total, business.baseCurrency)} across ${open.length} payable${open.length === 1 ? "" : "s"}: ${list}.`,
      data: { total, count: open.length },
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
    const date = { gte: range.start, lt: range.end };
    const [salesRows, bankRows] = await Promise.all([
      prisma.sales.groupBy({
        by: ["channel"],
        where: { businessId: business.id, date },
        _sum: { amount: true },
      }),
      prisma.transaction.groupBy({
        by: ["channel"],
        where: { businessId: business.id, type: "income", matchedSaleId: null, matchedCustomerId: null, date },
        _sum: { amount: true },
      }),
    ]);
    const byCh = mergeSums(new Map(), salesRows, (r) => r.channel || "unspecified");
    mergeSums(byCh, bankRows, (r) => r.channel || "unspecified");
    const named = [...byCh.entries()]
      .map(([channel, amount]) => ({ channel, amount }))
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
    // dueDate is a Lagos wall-calendar "YYYY-MM-DD" string — compare against
    // the Lagos date, not the UTC date (they differ 00:00–01:00 WAT).
    const today = new Date(Date.now() + WAT_MS).toISOString().slice(0, 10);
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
      sumIncome(business.id, range, null),
      sumExpenses(business.id, range),
    ]);
    return {
      answer: `${range.label[0].toUpperCase()}${range.label.slice(1)}: ${inc.count} income record${inc.count === 1 ? "" : "s"} and ${exp.count} expense${exp.count === 1 ? "" : "s"} recorded.`,
      data: { income: inc.count, expenses: exp.count },
    };
  },

  async balance({ business, canViewBalance = true }) {
    // The BALANCE capability governs this answer, not the reports one.
    //
    // /insights/ask is gated on canViewReports, which is the right gate for
    // "how were sales last month". It is the wrong gate for "how much is in my
    // account" — that is canViewBalance, and an owner who grants reports but
    // withholds the bank account has said so explicitly. Without this check the
    // whole distinction collapses to a phrasing trick: a staff member simply
    // types "what's in my account" and the engine fetches it live.
    if (!canViewBalance) {
      return { answer: "You don't have access to the bank balance. Ask the business owner to turn it on for you." };
    }
    const bankingId = business.providerAccountId || business.anchorAccountId;
    if (!bankingId) {
      return { answer: "This business doesn't have a bank account yet — open one from the Dashboard to see a balance." };
    }
    const cache = require("./balanceCache");
    let bal = cache.getBalance(business.id);
    if (bal === undefined) {
      const provider = require("../providers").getProvider(business);
      if (provider.pooledWallet) {
        // Fincra pools all VAs into one wallet — the ledger is the balance.
        const { computeLedgerBalance } = require("./ledgerBalance");
        bal = await computeLedgerBalance(business.id, business.baseCurrency || "NGN");
        cache.setBalance(business.id, bal);
      } else {
        try {
          const anchor = require("./anchor");
          const r = await anchor.getAccountBalance(business.anchorAccountId);
          bal = r.balance;
          cache.setBalance(business.id, bal);
        } catch {
          return { answer: "I couldn't reach the bank right now — check the Dashboard for your balance." };
        }
      }
    }
    return { answer: `Your bank balance is ${money(bal, business.baseCurrency)}.`, data: { balance: bal } };
  },

  async best_day({ business, range, hadExplicitRange }) {
    // Default to the last 30 days unless a period was asked for explicitly.
    const r = hadExplicitRange ? range : { start: new Date(Date.now() - 30 * 86400000), end: new Date(), label: "the last 30 days" };
    // DB-side weekday aggregation (WAT shift = +1 hour) over both income
    // sources, so large ranges aren't sampled arbitrarily.
    const grouped = await prisma.$queryRaw`
      SELECT EXTRACT(DOW FROM ("date" + interval '1 hour'))::int AS dow,
             SUM(amount)::float8 AS total
      FROM (
        SELECT "date", amount FROM "Sales"
        WHERE "businessId" = ${business.id} AND "date" >= ${r.start} AND "date" < ${r.end}
        UNION ALL
        SELECT "date", amount FROM "Transaction"
        WHERE "businessId" = ${business.id} AND type = 'income'
          AND "matchedSaleId" IS NULL AND "matchedCustomerId" IS NULL AND "date" >= ${r.start} AND "date" < ${r.end}
      ) t
      GROUP BY 1
    `;
    if (grouped.length === 0) return { answer: `No income recorded in ${r.label}.` };
    const byDay = new Array(7).fill(0);
    for (const g of grouped) byDay[g.dow] = g.total || 0;
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
        "You can ask me things like: “How much did I make this week?” · “Who owes me money?” · “How much do I owe?” · “What did I spend last month?” · “Best seller this month?” · “Sales by channel” · “What's low on stock?” · “Unpaid invoices?” · “Bank balance” · “Which day do I sell most?” — or record on the spot: “Record a sale of 5000” · “I spent 2k on fuel”.",
    };
  },

  // Mirror an explicit "good morning/afternoon/evening/night"; otherwise greet
  // by the Lagos clock.
  async greeting({ text }) {
    const m = ` ${text} `.match(/\bgood (morning|afternoon|evening|night)\b/);
    let greet;
    if (m) {
      greet = `Good ${m[1]}`;
    } else {
      const hour = new Date(Date.now() + WAT_MS).getUTCHours();
      greet = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
    }
    return {
      answer: `${greet}! 👋 Ask me anything about your business — try “How much did I make this week?” or “Who owes me money?”`,
    };
  },

  async thanks() {
    return { answer: "You're welcome! 🙌 Anything else you'd like to know about your business?" };
  },

  // Record commands never write directly — they return a parsed action the
  // app renders as a Confirm card; recording happens on the device through
  // the normal addTransaction flow (Dashboard/state/sync stay consistent).
  async record_sale({ business, raw, channel }) {
    const amount = extractAmount(raw);
    if (!amount) {
      return { answer: "How much was the sale? Reply with the amount — e.g. “5000” or “5k”." };
    }
    // Channel mentions are sale metadata, not the product name.
    const description = extractDetail(String(raw || "").replace(CHANNEL_MENTION_RE, " "));
    const amountText = money(amount, business.baseCurrency);
    const viaText = channel ? ` via ${channel}` : "";
    let action = { kind: "record_sale", amount, amountText, description, ...(channel ? { channel } : {}) };
    let stockNote = "";
    if (description) {
      // Link to inventory when the detail names a product — the device then
      // decrements stock through the normal addTransaction flow. One clear
      // match auto-links; similar names become tappable choices instead.
      const items = await prisma.inventoryItem.findMany({
        where: { businessId: business.id },
        select: { id: true, name: true, quantity: true },
        take: 300,
      });
      const candidates = findInventoryCandidates(description, items);
      const full = candidates.filter((s) => s.score >= 1);
      const quantity = extractQuantity(raw, amount);
      if (full.length === 1) {
        const item = full[0].item;
        action = { ...action, inventoryItemId: item.id, itemName: item.name, quantity };
        const short = item.quantity < quantity ? ` (your records showed only ${item.quantity})` : "";
        stockNote = ` Stock: ${item.name} ${item.quantity} → ${Math.max(0, item.quantity - quantity)}${short}.`;
      } else if (candidates.length >= 1) {
        // Similar product names — ask which one to take from stock.
        action = {
          ...action,
          quantity,
          choices: candidates.slice(0, 4).map((s) => ({
            id: s.item.id, name: s.item.name, quantity: s.item.quantity,
          })),
        };
        return {
          answer: `Got it — a ${amountText} sale${description ? ` for “${description}”` : ""}${viaText}. Which product should I take from stock?`,
          data: { action },
        };
      } else {
        // Product isn't tracked at all — record the sale normally, and let
        // the app offer a one-tap "add to inventory" afterwards (name from
        // the detail, selling price = amount ÷ quantity).
        const unitPrice = Math.round(amount / quantity);
        action = {
          ...action,
          newProduct: { name: titleCase(description), price: unitPrice, priceText: money(unitPrice, business.baseCurrency) },
        };
        stockNote = ` “${description}” isn't in your inventory yet.`;
      }
    }
    return {
      answer: `Got it — record a ${amountText} sale${description ? ` for “${description}”` : ""}${viaText}?${stockNote} Tap Confirm and it goes straight into your books.`,
      data: { action },
    };
  },

  async record_expense({ business, raw }) {
    const amount = extractAmount(raw);
    if (!amount) {
      return { answer: "How much was the expense? Reply with the amount — e.g. “2000” or “2k”." };
    }
    const detail = extractDetail(raw);
    const action = {
      kind: "record_expense", amount,
      amountText: money(amount, business.baseCurrency),
      description: detail, category: detail || "other",
    };
    if (detail) {
      // "i bought 20 bags of rice for 5000" — if the expense clearly names a
      // tracked product, the app offers to top up its stock after recording.
      const items = await prisma.inventoryItem.findMany({
        where: { businessId: business.id },
        select: { id: true, name: true, quantity: true },
        take: 300,
      });
      const item = matchInventoryItem(detail, items);
      if (item) {
        action.restock = {
          inventoryItemId: item.id, itemName: item.name,
          itemQuantity: item.quantity, quantity: extractQuantity(raw, amount),
        };
      }
    }
    return {
      answer: `Got it — record a ${money(amount, business.baseCurrency)} expense${detail ? ` for “${detail}”` : ""}? Tap Confirm and it goes straight into your books.`,
      data: { action },
    };
  },

  // Inventory updates: restock (add), set stock (absolute), set price.
  async update_stock({ business, raw }) {
    const { mode, value, detail } = parseUpdateCommand(raw);
    if (!detail) {
      return { answer: "Which product? Try “restock rice 20” or “set rice price to 1500”." };
    }
    if (value == null) {
      // Ask for the FULL command — a bare-number reply can't re-enter this
      // flow (context carries only the intent, not the product).
      return {
        answer: mode === "price"
          ? `Send the full command with the price — e.g. “set ${detail} price to 1500”.`
          : `Send the full command with the count — e.g. “restock ${detail} 20”.`,
      };
    }
    const items = await prisma.inventoryItem.findMany({
      where: { businessId: business.id },
      select: { id: true, name: true, quantity: true },
      take: 300,
    });
    const candidates = findInventoryCandidates(detail, items);
    const full = candidates.filter((s) => s.score >= 1);
    if (full.length === 1) {
      const item = full[0].item;
      const answer = mode === "price"
        ? `Set ${item.name} price to ${money(value, business.baseCurrency)}? Tap Confirm.`
        : `${mode === "add" ? "Restock" : "Update"} ${item.name}: stock ${item.quantity} → ${mode === "add" ? item.quantity + value : value}. Tap Confirm.`;
      return {
        answer,
        data: {
          action: {
            kind: "update_stock", mode, value,
            valueText: mode === "price" ? money(value, business.baseCurrency) : undefined,
            inventoryItemId: item.id, itemName: item.name, itemQuantity: item.quantity,
          },
        },
      };
    }
    if (candidates.length >= 1) {
      // State the pending operation so a mis-parsed value is visible BEFORE
      // the user picks a product (the pick applies immediately).
      const opText = mode === "price"
        ? `set the price to ${money(value, business.baseCurrency)}`
        : mode === "add" ? `add ${value} to its stock` : `set its stock to ${value}`;
      return {
        answer: `Which product do you mean? I'll ${opText}.`,
        data: {
          action: {
            kind: "update_stock", mode, value,
            valueText: mode === "price" ? money(value, business.baseCurrency) : undefined,
            choices: candidates.slice(0, 4).map((s) => ({ id: s.item.id, name: s.item.name, quantity: s.item.quantity })),
          },
        },
      };
    }
    // Unknown product — turn the dead end into a create offer, carrying over
    // whatever the command already told us (price or opening stock).
    const name = titleCase(detail);
    if (mode === "price") {
      return {
        answer: `“${detail}” isn't in your inventory — add it as a new product at ${money(value, business.baseCurrency)}? Stock starts at 0.`,
        data: { action: { kind: "create_product", name, price: value, priceText: money(value, business.baseCurrency), stock: 0 } },
      };
    }
    return {
      answer: `“${detail}” isn't in your inventory — add it as a new product with ${value} in stock? Its price will be ₦0 until you set it (say “set ${detail} price to …”).`,
      data: { action: { kind: "create_product", name, price: 0, stock: value } },
    };
  },

  // Create a product: "add new product shawarma at 1500, 20 in stock".
  async create_product({ business, raw }) {
    const { name, price, stock } = parseCreateCommand(raw);
    if (!name) {
      return { answer: "What should I call the product? Try “add product shawarma at 1500”." };
    }
    const items = await prisma.inventoryItem.findMany({
      where: { businessId: business.id },
      select: { id: true, name: true, quantity: true },
      take: 300,
    });
    const existing = matchInventoryItem(name, items);
    if (existing) {
      return {
        answer: `You already have ${existing.name} (stock ${existing.quantity}). Try “restock ${existing.name.toLowerCase()} 20” or “set ${existing.name.toLowerCase()} price to 1500” instead.`,
      };
    }
    if (price == null) {
      return { answer: `What's the selling price for “${name}”? Include it — e.g. “add product ${name} at 1500”.` };
    }
    const title = titleCase(name);
    return {
      answer: `Add “${title}” to inventory — price ${money(price, business.baseCurrency)}, stock ${stock}? Tap Confirm.`,
      data: { action: { kind: "create_product", name: title, price, priceText: money(price, business.baseCurrency), stock } },
    };
  },
};

const SUGGESTIONS = [
  "How much did I make this week?",
  "Record a sale of 5000",
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
// answerQuestion(question, business, opts?) → { intent, answer, data? }
//
// `canViewBalance` defaults TRUE so the cron-driven monthly P&L email and every
// existing owner-side caller behave exactly as before. Only the HTTP route,
// which knows who is asking, passes it as false.
// Fuzzy customer lookup for person-entity questions. Token-based (bank/legal
// vs informal names never whole-string match): exact full-name equality wins,
// then all-query-tokens-present, then within-1 token matches. Exactly one
// best → match; several tie → choices for the user to tap.
const INTENT_EXAMPLES = {
  income: "How much did I make this month?",
  expenses: "How much did I spend this month?",
  profit: "What's my profit this month?",
  debts: "Who owes me money?",
  payables: "Who do I owe?",
  channels: "Which channel sells the most?",
  best_day: "What's my best day?",
  expense_breakdown: "Where is my money going?",
  top_customers: "Who are my top customers?",
  top_products: "What's my best-selling product?",
  stock: "What's low in stock?",
  invoices: "Any unpaid invoices?",
  balance: "What's my bank balance?",
  count: "How many sales this month?",
};

async function resolveCustomerByName(businessId, name) {
  const customers = await prisma.customer.findMany({
    where: { businessId },
    select: { id: true, name: true, totalOwed: true },
  });
  const qTokens = name.toLowerCase().split(" ").filter(Boolean);
  const scored = customers
    .map((c) => {
      const cTokens = (c.name || "").toLowerCase().split(/\s+/).filter(Boolean);
      if (cTokens.join(" ") === qTokens.join(" ")) return { c, score: 3 };
      const hits = qTokens.filter((q) =>
        cTokens.some((ct) => ct === q || (q.length >= 4 && within1(ct, q))),
      ).length;
      if (hits === qTokens.length) return { c, score: 2 };
      if (hits > 0) return { c, score: 1 };
      return null;
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);
  if (!scored.length) return { match: null, choices: [] };
  const top = scored.filter((s) => s.score === scored[0].score);
  if (top.length === 1) return { match: top[0].c, choices: [] };
  return { match: null, choices: top.slice(0, 4).map((s) => s.c) };
}

// Person-entity answers — "how much does chioma owe", "sales to chioma".
async function answerForCustomer(parsed, business, cust) {
  if (parsed.intent === "debts") {
    if (!(cust.totalOwed > 0)) {
      return { answer: `${cust.name} doesn't owe you anything right now. ✅`, data: { customer: cust.name, owed: 0 } };
    }
    const unpaid = await prisma.debt.findMany({
      where: { customerId: cust.id, paid: false },
      orderBy: { date: "asc" },
      select: { date: true },
    });
    const oldest = unpaid[0] ? ` The oldest debt is from ${new Date(unpaid[0].date).toLocaleDateString("en-NG", { day: "numeric", month: "short", year: "numeric" })}.` : "";
    return {
      answer: `${cust.name} owes you ${money(cust.totalOwed, business.baseCurrency)} across ${unpaid.length} unpaid debt${unpaid.length === 1 ? "" : "s"}.${oldest}`,
      data: { customer: cust.name, owed: cust.totalOwed, unpaidCount: unpaid.length },
    };
  }
  // income / count scoped to this customer's sales
  const agg = await prisma.sales.aggregate({
    where: { businessId: business.id, customerId: cust.id, date: { gte: parsed.range.start, lt: parsed.range.end } },
    _sum: { amount: true },
    _count: { _all: true },
  });
  const total = Number(agg._sum.amount || 0);
  if (agg._count._all === 0) {
    return { answer: `No sales to ${cust.name} recorded ${parsed.range.label}.`, data: { customer: cust.name, total: 0, count: 0 } };
  }
  return {
    answer: `Sales to ${cust.name} ${parsed.range.label}: ${money(total, business.baseCurrency)} (${agg._count._all} record${agg._count._all === 1 ? "" : "s"}).`,
    data: { customer: cust.name, total, count: agg._count._all },
  };
}

// Two-period comparison — "june vs march", "this week vs last month".
async function answerComparison(parsed, business) {
  const { intent, range, rangeB, channel } = parsed;
  const fetch = async (r) => {
    if (intent === "expenses") return (await sumExpenses(business.id, r)).total;
    if (intent === "profit") {
      const [i, e] = await Promise.all([sumIncome(business.id, r, channel), sumExpenses(business.id, r)]);
      return i.total - e.total;
    }
    return (await sumIncome(business.id, r, channel)).total;
  };
  const [a, b] = await Promise.all([fetch(range), fetch(rangeB)]);
  const noun = intent === "expenses" ? "Spending" : intent === "profit" ? "Profit" : "Income";
  const delta = pctDelta(a, b);
  const capA = range.label[0].toUpperCase() + range.label.slice(1);
  const tail =
    delta == null
      ? b === 0 && a === 0
        ? "Nothing recorded in either period."
        : `${capA} is new — nothing recorded ${rangeB.label}.`
      : `${capA} is ${delta >= 0 ? "up" : "down"} ${Math.abs(delta).toFixed(0)}% on ${rangeB.label}.`;
  return {
    answer: `${noun} ${range.label}: ${money(a, business.baseCurrency)} · ${rangeB.label}: ${money(b, business.baseCurrency)}. ${tail}`,
    data: {
      compare: {
        a: { label: range.label, total: a },
        b: { label: rangeB.label, total: b },
        deltaPct: delta,
      },
    },
  };
}

async function answerQuestion(question, business, context = null, { canViewBalance = true } = {}) {
  const parsed = parseQuestion(question, context);

  if (!parsed.intent) {
    // Closest sub-threshold intent → a tappable "did you mean", instead of
    // the dead-end static fallback.
    const example = parsed.nearMiss && INTENT_EXAMPLES[parsed.nearMiss];
    if (example) {
      return {
        intent: null,
        answer: `I didn't quite get that — did you mean "${example}"?`,
        data: { suggest: example },
      };
    }
    return { intent: null, answer: FALLBACK };
  }

  // Person entity: "how much does chioma owe", "sales to ada". Resolved here
  // (parseQuestion stays pure); an ambiguous name becomes tappable choices,
  // an unknown one falls through to the generic handler.
  if (parsed.personName && ["debts", "income", "count", "top_customers"].includes(parsed.intent)) {
    const { match: cust, choices } = await resolveCustomerByName(business.id, parsed.personName);
    if (cust) {
      const result = await answerForCustomer(parsed, business, cust);
      return {
        intent: parsed.intent,
        answer: result.answer,
        data: result.data,
        nextContext: buildNextContext(parsed.intent, parsed.range, parsed.channel),
      };
    }
    if (choices.length > 1) {
      return {
        intent: parsed.intent,
        answer: `Which ${parsed.intent === "debts" ? "customer" : "one"}? I found ${choices.map((c) => c.name).join(", ")}.`,
        data: { choices: choices.map((c) => ({ name: c.name, ask: parsed.intent === "debts" ? `How much does ${c.name} owe?` : `Sales to ${c.name}` })) },
      };
    }
  }

  // Two explicit periods → a comparison, for the money intents.
  if (parsed.rangeB && ["income", "expenses", "profit", "count"].includes(parsed.intent)) {
    const result = await answerComparison(parsed, business);
    return {
      intent: parsed.intent,
      answer: result.answer,
      data: result.data,
      nextContext: buildNextContext(parsed.intent, parsed.range, parsed.channel),
    };
  }

  const handler = HANDLERS[parsed.intent];
  const result = await handler({ business, canViewBalance, ...parsed });
  return {
    intent: parsed.intent,
    answer: result.answer,
    data: result.data,
    nextContext: buildNextContext(parsed.intent, parsed.range, parsed.channel),
  };
}

// Auto-generated observation cards for the Insights screen. All deterministic.
async function generateInsightCards(business) {
  const now = new Date();
  const { y, m } = lagosParts(now);
  const thisMonth = { start: fromLagos(y, m, 1), end: now };
  // "Same point last month": the prior month up to the same elapsed offset,
  // clamped so a longer elapsed span can't spill past the prior month's end.
  const lastMonthStart = fromLagos(y, m - 1, 1);
  const lastMonth = {
    start: lastMonthStart,
    end: new Date(Math.min(
      lastMonthStart.getTime() + (now.getTime() - thisMonth.start.getTime()),
      thisMonth.start.getTime(),
    )),
  };
  const cards = [];

  const [inc, prevInc, expRows, bankExpRows, low, topDebtor, chRows, bankChRows] = await Promise.all([
    sumIncome(business.id, thisMonth, null),
    sumIncome(business.id, lastMonth, null),
    prisma.expense.groupBy({
      by: ["category"],
      where: { businessId: business.id, date: { gte: thisMonth.start, lt: thisMonth.end } },
      _sum: { amount: true },
    }),
    prisma.transaction.groupBy({
      by: ["category"],
      where: { businessId: business.id, type: "expense", matchedExpenseId: null, date: { gte: thisMonth.start, lt: thisMonth.end } },
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
    prisma.sales.groupBy({
      by: ["channel"],
      where: { businessId: business.id, channel: { not: null }, date: { gte: thisMonth.start, lt: thisMonth.end } },
      _sum: { amount: true },
    }),
    prisma.transaction.groupBy({
      by: ["channel"],
      where: { businessId: business.id, type: "income", matchedSaleId: null, matchedCustomerId: null, channel: { not: null }, date: { gte: thisMonth.start, lt: thisMonth.end } },
      _sum: { amount: true },
    }),
  ]);

  const delta = pctDelta(inc.total, prevInc.total);
  if (inc.count > 0) {
    cards.push({
      icon: "trending-up",
      title: `${money(inc.total, business.baseCurrency)} this month`,
      body: delta == null
        ? `${inc.count} sale${inc.count === 1 ? "" : "s"} so far.`
        : `Income is ${delta >= 0 ? "up" : "down"} ${Math.abs(delta).toFixed(0)}% vs the same point last month.`,
    });
  }

  const byCat = mergeSums(new Map(), expRows, (r) => r.category || "other");
  mergeSums(byCat, bankExpRows, (r) => r.category || "other");
  const topExp = [...byCat.entries()]
    .map(([category, amount]) => ({ category, amount }))
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

  const byCh = mergeSums(new Map(), chRows, (r) => r.channel);
  mergeSums(byCh, bankChRows, (r) => r.channel);
  const topCh = [...byCh.entries()]
    .map(([channel, amount]) => ({ channel, amount }))
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
  extractQuantity,
  matchInventoryItem,
  findInventoryCandidates,
  parseUpdateCommand,
  parseCreateCommand,
  parseContext,
  buildNextContext,
  extractPersonName,
  nearestIntent,
  // the aggregates themselves, so the match e2e asserts the exclusion rules
  // (a matched credit or debit counts ONCE) against the real query, not a copy
  sumIncome,
  sumExpenses,
};
