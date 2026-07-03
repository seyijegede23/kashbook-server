// Unit tests for the deterministic insights engine's PARSER (pure functions —
// no DB writes). Run: cd server && node -r dotenv/config scripts/test-insights.js
const { normalize, parseTimeRange, parseQuestion, matchIntent } = require("../src/utils/insightsEngine");

// Fixed "now": Friday 2026-07-03 12:00 Lagos (11:00 UTC).
const NOW = new Date("2026-07-03T11:00:00Z");

let pass = 0, fail = 0;
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; }
  else { fail++; console.error(`✗ ${label}\n    got      ${a}\n    expected ${e}`); }
}

// ── Intent matching (incl. Pidgin + typos) ───────────────────────────────────
const intentCases = [
  ["how much did i make this week", "income"],
  ["how much money came in today", "income"],
  ["wetin i don make since monday", "income"],          // Pidgin
  ["income for june", "income"],
  ["what did i spend last month", "expenses"],
  ["my expnses this week", "expenses"],                 // typo
  ["what do i spend most on", "expense_breakdown"],
  ["where my money go", "expense_breakdown"],           // Pidgin
  ["profit this month", "profit"],
  ["how my business dey do", "profit"],                 // Pidgin
  ["am i making a loss", "profit"],
  ["who owes me money", "debts"],
  ["who dey owe me", "debts"],                          // Pidgin
  ["list my debtors", "debts"],
  ["who never pay me", "debts"],                        // Pidgin
  ["best customer this month", "top_customers"],
  ["who buy pass", "top_customers"],                    // Pidgin
  ["best seller", "top_products"],
  ["top selling product", "top_products"],
  ["wetin dey sell pass", "top_products"],              // Pidgin
  ["what is low on stock", "stock"],
  ["which items are running low", "stock"],
  ["do i need to restock", "stock"],
  ["sales by channel", "channels"],
  ["which channel brings the most money", "channels"],
  ["unpaid invoices", "invoices"],
  ["any overdue invoice", "invoices"],
  ["how many sales this week", "count"],
  ["bank balance", "balance"],
  ["how much dey my account", "balance"],               // Pidgin
  ["which day do i sell most", "best_day"],
  ["busiest day", "best_day"],
  ["what can you do", "help"],
  ["instagram sales this week", "income"],              // channel entity → income
];
for (const [q, want] of intentCases) {
  eq(parseQuestion(q, null, NOW).intent, want, `intent: "${q}"`);
}

// Fallback on nonsense
eq(parseQuestion("purple monkey dishwasher", null, NOW).intent, null, "fallback: nonsense");

// ── Channel + compare flags ──────────────────────────────────────────────────
eq(parseQuestion("instagram sales this week", null, NOW).channel, "instagram", "channel: instagram");
eq(parseQuestion("ig sales today", null, NOW).channel, "instagram", "channel: ig alias");
eq(parseQuestion("walk-in income this month", null, NOW).channel, "walk-in", "channel: walk-in");
eq(parseQuestion("compare income this month vs last month", null, NOW).compare, true, "compare flag");

// ── Follow-up context ────────────────────────────────────────────────────────
const fu = parseQuestion("what about last week", "income", NOW);
eq(fu.intent, "income", "follow-up reuses intent");
eq(fu.usedContext, true, "follow-up flag");
eq(fu.range.label, "last week", "follow-up range");
eq(parseQuestion("what about last week", null, NOW).intent, null, "no context → fallback");

// ── Time ranges (NOW = Fri 2026-07-03 12:00 WAT; WAT = UTC+1) ────────────────
function range(q) {
  const r = parseTimeRange(normalize(q), NOW);
  return r ? { s: r.start.toISOString(), e: r.end.toISOString(), label: r.label } : null;
}
eq(range("today"), { s: "2026-07-02T23:00:00.000Z", e: NOW.toISOString(), label: "today" }, "range: today");
eq(range("yesterday"), { s: "2026-07-01T23:00:00.000Z", e: "2026-07-02T23:00:00.000Z", label: "yesterday" }, "range: yesterday");
// Monday of this week = 2026-06-29 (00:00 WAT = 06-28 23:00 UTC)
eq(range("this week"), { s: "2026-06-28T23:00:00.000Z", e: NOW.toISOString(), label: "this week" }, "range: this week");
eq(range("last week"), { s: "2026-06-21T23:00:00.000Z", e: "2026-06-28T23:00:00.000Z", label: "last week" }, "range: last week");
eq(range("this month"), { s: "2026-06-30T23:00:00.000Z", e: NOW.toISOString(), label: "this month" }, "range: this month");
eq(range("last month"), { s: "2026-05-31T23:00:00.000Z", e: "2026-06-30T23:00:00.000Z", label: "last month" }, "range: last month");
eq(range("last 7 days"), { s: "2026-06-25T23:00:00.000Z", e: NOW.toISOString(), label: "the last 7 days" }, "range: last 7 days");
eq(range("past 2 weeks"), { s: "2026-06-18T23:00:00.000Z", e: NOW.toISOString(), label: "the last 2 weeks" }, "range: past 2 weeks");
// since monday → 2026-06-29 00:00 WAT
eq(range("since monday"), { s: "2026-06-28T23:00:00.000Z", e: NOW.toISOString(), label: "since monday" }, "range: since monday");
// since friday → today (Friday) 00:00 WAT
eq(range("since friday"), { s: "2026-07-02T23:00:00.000Z", e: NOW.toISOString(), label: "since friday" }, "range: since friday");
// month name: june (past) → full June; december → last year
eq(range("in june"), { s: "2026-05-31T23:00:00.000Z", e: "2026-06-30T23:00:00.000Z", label: "june 2026" }, "range: june");
eq(range("in december"), { s: "2025-11-30T23:00:00.000Z", e: "2025-12-31T23:00:00.000Z", label: "december 2025" }, "range: december → last year");
// july (current month) → month-to-date
eq(range("in july"), { s: "2026-06-30T23:00:00.000Z", e: NOW.toISOString(), label: "july 2026" }, "range: july (current, to now)");
// default when nothing matches
eq(parseTimeRange(normalize("who owes me"), NOW), null, "range: none → null (caller defaults)");
eq(parseQuestion("who owes me", null, NOW).range.label, "this month", "default range = this month");

// ── Normalizer spot checks ───────────────────────────────────────────────────
eq(normalize("Wetin I don make?!"), "what i made", "normalize: pidgin");
eq(normalize("Who dey owe me moni"), "who owe me money", "normalize: owe/money");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
