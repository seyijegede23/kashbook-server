// Unit tests for the deterministic insights engine's PARSER (pure functions —
// no DB writes). Run: cd server && node -r dotenv/config scripts/test-insights.js
const {
  normalize, parseTimeRange, parseQuestion, matchIntent, previousPeriod,
  extractQuantity, matchInventoryItem, findInventoryCandidates, parseUpdateCommand,
  parseCreateCommand,
} = require("../src/utils/insightsEngine");

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
  ["best sales day", "best_day"],
  ["what can you do", "help"],
  ["instagram sales this week", "income"],              // channel entity → income
  // review-fix cases (commit after a764a7b)
  ["how much money in my account", "balance"],          // phrase order: balance before "money in"
  ["how much money do i have", "balance"],
  ["how much cash do i have", "balance"],               // cash → money token
  ["how much is in the bank", "balance"],
  ["how much do i owe", "payables"],                    // direction: user's own debt
  ["who do i owe", "payables"],
  ["i owe chioma money", "payables"],
  ["i have not paid chioma", "payables"],               // negated-pay + direction
  ["how much am i owed", "debts"],                      // owed → owe, but being owed = debts
  ["who has not paid me", "debts"],
  ["who hasnt paid me", "debts"],
  ["how much does chioma owe", "debts"],
  ["did i make money today", "income"],                 // make → made
  ["how much i make today", "income"],
  ["how much did we make this week", "income"],
  ["biggest expense this month", "expense_breakdown"],  // not the expenses total
  ["where does my money go", "expense_breakdown"],
  ["did i send the invoice", "invoices"],               // typo stoplist: send ≠ spend
  ["income vs expenses", "profit"],                     // both sides named = profit
  ["how much did i make and spend", "profit"],
  // spell correction (Damerau ≤1: swaps, drops, doubles, substitutions)
  ["porfit this month", "profit"],
  ["proffit this month", "profit"],
  ["my expences this week", "expenses"],
  ["what is low on stcok", "stock"],
  ["how mcuh did i make this week", "income"],          // typo inside a phrase
  ["unpaid invioces", "invoices"],
  ["how much moeny did i make", "income"],
  ["who owse me money", "debts"],
  ["whcih day do i sell most", "best_day"],
  ["bank balnce", "balance"],
  ["did i lose money this month", "profit"],            // lose/lost/losing → loss
  ["am i losing money", "profit"],
  // small talk
  ["good morning", "greeting"],
  ["good morming", "greeting"],                         // typo'd greeting
  ["good evening o", "greeting"],
  ["hello", "greeting"],
  ["hi", "greeting"],
  ["how you dey", "greeting"],
  ["how far", "greeting"],
  ["well done", "greeting"],
  ["thank you", "thanks"],
  ["thanks", "thanks"],
  ["tnx", "thanks"],
  // a real question in the same message beats the greeting
  ["good morning how much did i make yesterday", "income"],
  ["hello who owes me money", "debts"],
  // record commands (statement-shaped)
  ["record a sale of 5000", "record_sale"],
  ["add sale 2,500", "record_sale"],
  ["i sold 3 bags of rice for 15000", "record_sale"],
  ["i just sold 5k", "record_sale"],
  ["record an expense of 2000", "record_expense"],
  ["i spent 2k on fuel", "record_expense"],
  ["i bought fuel for 3000", "record_expense"],
  ["i paid 5000 for transport", "record_expense"],
  // question-shaped stays a question, never a record command
  ["how much did i sell today", "income"],
  ["how much have i spent on fuel", "expenses"],
  ["what did i spend last month", "expenses"],
  ["add up my sales this month", "income"],
  // review fixes: commands that were stolen or missed
  ["record a sale of my new product for 3000", "record_sale"],
  ["i sold a new product for 5000", "record_sale"],
  ["i bought new goods for 20k", "record_expense"],
  ["i have sold 5000 today", "record_sale"],          // perfect tense
  ["ive just sold 3 bags of rice for 15k", "record_sale"],
  ["i don sell 5000", "record_sale"],                 // Pidgin perfect tense
  ["can you record a sale of 5000", "record_sale"],   // polite command survives
  ["we sold out of rice", "stock"],                   // stock statement, not a sale
  ["should i restock rice", "stock"],                 // question, not a command
  ["update me on my stock", "stock"],
  ["what sells best", "top_products"],
  // inventory update commands
  ["restock rice 20", "update_stock"],
  ["restock rice with 20 pieces", "update_stock"],
  ["add 20 rice to stock", "update_stock"],
  ["add 20 rice to inventory", "update_stock"],
  ["set rice stock to 50", "update_stock"],
  ["update rice stock to 50", "update_stock"],
  ["change rice price to 1500", "update_stock"],
  ["set rice price to 1500", "update_stock"],
  // stock questions stay questions
  ["do i need to restock", "stock"],
  ["what should i restock", "stock"],
  // create-product commands
  ["add new product shawarma at 1500", "create_product"],
  ["create product shawarma", "create_product"],
  ["add new item shawarma at 1500", "create_product"],   // item → product
  ["add product shawarma price 1500 stock 20", "create_product"],
  // product questions stay questions
  ["best product this month", "top_products"],
  ["which product sells best", "top_products"],
  ["any new product sales this week", "income"],         // "any" is a question word
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
// Two channels named → channels breakdown, no single-channel filter
const twoCh = parseQuestion("whatsapp sales vs instagram sales", null, NOW);
eq(twoCh.intent, "channels", "two channels → channels intent");
eq(twoCh.channel, null, "two channels → no filter");

// ── Follow-up context ────────────────────────────────────────────────────────
const fu = parseQuestion("what about last week", "income", NOW);
eq(fu.intent, "income", "follow-up reuses intent");
eq(fu.usedContext, true, "follow-up flag");
eq(fu.range.label, "last week", "follow-up range");
eq(parseQuestion("what about last week", null, NOW).intent, null, "no context → fallback");
// Channel-only follow-up
const fuCh = parseQuestion("what about instagram", "income", NOW);
eq(fuCh.intent, "income", "channel-only follow-up reuses intent");
eq(fuCh.channel, "instagram", "channel-only follow-up channel");
eq(fuCh.range.label, "this month", "channel-only follow-up default range");
// "payables" is a valid follow-up context
eq(parseQuestion("what about last month", "payables", NOW).intent, "payables", "payables follow-up context");
// small-talk intents are NOT valid follow-up context
eq(parseQuestion("what about last week", "greeting", NOW).intent, null, "greeting not a follow-up context");
eq(parseQuestion("what about last week", "thanks", NOW).intent, null, "thanks not a follow-up context");

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
// "may" needs an anchor (modal verb) — bare "may" is not a month
eq(range("how much may i make"), null, "range: modal 'may' ignored");
eq(range("income in may"), { s: "2026-04-30T23:00:00.000Z", e: "2026-05-31T23:00:00.000Z", label: "may 2026" }, "range: anchored may");
// "since yesterday" / "since last week" run through NOW (open-ended)
eq(range("since yesterday"), { s: "2026-07-01T23:00:00.000Z", e: NOW.toISOString(), label: "since yesterday" }, "range: since yesterday");
eq(range("since last week"), { s: "2026-06-21T23:00:00.000Z", e: NOW.toISOString(), label: "since last week" }, "range: since last week");
// "last N months" = calendar months, not N×30 days (Jul 3 − 3 months = Apr 3)
eq(range("last 3 months"), { s: "2026-04-02T23:00:00.000Z", e: NOW.toISOString(), label: "the last 3 months" }, "range: last 3 months calendar");
// default when nothing matches
eq(parseTimeRange(normalize("who owes me"), NOW), null, "range: none → null (caller defaults)");
eq(parseQuestion("who owes me", null, NOW).range.label, "this month", "default range = this month");

// ── previousPeriod: to-date ranges compare like with like ───────────────────
function prev(q) {
  const r = parseTimeRange(normalize(q), NOW);
  const p = previousPeriod(r, NOW);
  return { s: p.start.toISOString(), e: p.end.toISOString(), label: p.label };
}
// "this month" (Jul 1 → now) vs the SAME elapsed span of June, not all of June
eq(prev("this month"), { s: "2026-05-31T23:00:00.000Z", e: "2026-06-03T11:00:00.000Z", label: "the same point last month" }, "prev: this month → same point");
// "last month" (completed June) vs full May
eq(prev("last month"), { s: "2026-04-30T23:00:00.000Z", e: "2026-05-31T23:00:00.000Z", label: "the month before" }, "prev: last month → full may");
// Mon Jun 22 WAT + same elapsed (4.5 days) = Fri Jun 26 noon WAT
eq(prev("this week"), { s: "2026-06-21T23:00:00.000Z", e: "2026-06-26T11:00:00.000Z", label: "the same point last week" }, "prev: this week → same point");
eq(prev("today"), { s: "2026-07-01T23:00:00.000Z", e: "2026-07-02T11:00:00.000Z", label: "this time yesterday" }, "prev: today → this time yesterday");
eq(prev("yesterday"), { s: "2026-06-30T23:00:00.000Z", e: "2026-07-01T23:00:00.000Z", label: "the day before" }, "prev: yesterday → full day before");

// ── Normalizer spot checks ───────────────────────────────────────────────────
eq(normalize("Wetin I don make?!"), "what i made", "normalize: pidgin");
eq(normalize("Who dey owe me moni"), "who owe me money", "normalize: owe/money");
// prototype-chain guard: "constructor" must pass through untouched
eq(normalize("constructor payment"), "constructor payment", "normalize: proto guard");
// spell correction reaches the date parser too
eq(range("income in jnauary"), { s: "2025-12-31T23:00:00.000Z", e: "2026-01-31T23:00:00.000Z", label: "january 2026" }, "range: typo'd month name");
eq(range("last 3 monhts"), { s: "2026-04-02T23:00:00.000Z", e: NOW.toISOString(), label: "the last 3 months" }, "range: typo'd 'months'");
// stoplisted real words are never "corrected"
eq(normalize("payment mode"), "payment mode", "normalize: stoplist mode≠made");
eq(normalize("i sent the invoice"), "i sent the invoice", "normalize: stoplist sent≠spend");
eq(normalize("part payment"), "part payment", "normalize: stoplist part≠past");
eq(normalize("debit alert"), "debit alert", "normalize: stoplist debit≠debt");
eq(normalize("give my money back"), "give my money back", "normalize: stoplist back≠bank");
eq(normalize("same as before"), "same as before", "normalize: stoplist same≠sale");
// customer names don't get mangled
eq(normalize("how much does chioma owe"), "how much does chioma owe", "normalize: names untouched");

// ── Inventory linking for record commands (pure helpers) ────────────────────
const ITEMS = [
  { id: "a", name: "Rice", quantity: 20 },
  { id: "b", name: "Beans", quantity: 10 },
  { id: "c", name: "Rice 50kg", quantity: 5 },
];
eq(matchInventoryItem("bags of rice", ITEMS)?.id, "a", "inv: 'bags of rice' → Rice (plural folded)");
eq(matchInventoryItem("beans", ITEMS)?.id, "b", "inv: exact");
eq(matchInventoryItem("rice 50kg", ITEMS)?.id, undefined, "inv: two full matches (Rice + Rice 50kg) = ambiguous → no link");
eq(matchInventoryItem("garri", ITEMS), null, "inv: no match");
eq(matchInventoryItem(null, ITEMS), null, "inv: no detail");
eq(matchInventoryItem("shoes", [{ id: "x", name: "Shoe", quantity: 3 }])?.id, "x", "inv: singular item name matches plural detail");
// similar names become ranked candidates → the handler asks the user
eq(findInventoryCandidates("rice", ITEMS).map((s) => s.item.id), ["a", "c"], "inv: candidates ranked full-first");
eq(findInventoryCandidates("rice 50kg", ITEMS).filter((s) => s.score >= 1).length, 2, "inv: two full matches → ask");
const KG_ONLY = [{ id: "c", name: "Rice 50kg", quantity: 5 }, { id: "d", name: "Rice 25kg", quantity: 8 }];
eq(matchInventoryItem("rice", KG_ONLY), null, "inv: partial-only → no auto-link");
eq(findInventoryCandidates("rice", KG_ONLY).length, 2, "inv: partial-only → both offered as choices");
eq(findInventoryCandidates("garri", ITEMS).length, 0, "inv: no candidates → no ask");
// update-command parsing (mode + value + product)
eq(parseUpdateCommand("restock rice 20"), { mode: "add", value: 20, detail: "rice" }, "upd: restock adds");
eq(parseUpdateCommand("add 20 rice to stock"), { mode: "add", value: 20, detail: "rice" }, "upd: add-to-stock");
eq(parseUpdateCommand("set rice stock to 50"), { mode: "set", value: 50, detail: "rice" }, "upd: set absolute");
eq(parseUpdateCommand("change rice price to 1,500"), { mode: "price", value: 1500, detail: "rice" }, "upd: price with comma");
eq(parseUpdateCommand("set rice 50kg stock to 100"), { mode: "set", value: 100, detail: "rice 50kg" }, "upd: numeric product name survives");
eq(parseUpdateCommand("restock rice"), { mode: "add", value: null, detail: "rice" }, "upd: missing count → ask");
// review fixes: mode precedence, zero, name-internal command words
eq(parseUpdateCommand("restock spoon set 20"), { mode: "add", value: 20, detail: "spoon set" }, "upd: 'set' in a name doesn't flip mode");
eq(parseUpdateCommand("restock stock cubes 20"), { mode: "add", value: 20, detail: "stock cubes" }, "upd: 'stock' survives in a name");
eq(parseUpdateCommand("set rice stock to 0"), { mode: "set", value: 0, detail: "rice" }, "upd: stock can be zeroed");
eq(parseUpdateCommand("restock rice with 5 000"), { mode: "add", value: 5000, detail: "rice" }, "upd: space-grouped count");
// create-command parsing (labeled + unlabeled numbers)
eq(parseCreateCommand("add new product shawarma at 1500"), { name: "shawarma", price: 1500, stock: 0 }, "create: price via 'at'");
eq(parseCreateCommand("add new product shawarma at 1500, 20 in stock"), { name: "shawarma", price: 1500, stock: 20 }, "create: 'N in stock'");
eq(parseCreateCommand("add product shawarma price 1,500 stock 20"), { name: "shawarma", price: 1500, stock: 20 }, "create: labeled both");
eq(parseCreateCommand("add product shawarma 1500 20"), { name: "shawarma", price: 1500, stock: 20 }, "create: unlabeled — larger is price");
eq(parseCreateCommand("add product shawarma at 2k"), { name: "shawarma", price: 2000, stock: 0 }, "create: k-suffix price");
eq(parseCreateCommand("create product shawarma"), { name: "shawarma", price: null, stock: 0 }, "create: no price → ask");
// review fixes: label words in names, name-leading digits, equal price/stock
eq(parseCreateCommand("add product price tags at 500"), { name: "price tags", price: 500, stock: 0 }, "create: 'price' survives in a name");
eq(parseCreateCommand("add product 5 alive at 1200"), { name: "5 alive", price: 1200, stock: 0 }, "create: leading digit stays in the name");
eq(parseCreateCommand("add product coke 500, 500 in stock"), { name: "coke", price: 500, stock: 500 }, "create: price equal to stock isn't deduped away");

// review fixes: amount parsing (extractAmount probed through price mode)
eq(parseUpdateCommand("set rice price to 1,500.75"), { mode: "price", value: 1500.75, detail: "rice" }, "amt: comma + decimal");
eq(parseUpdateCommand("set rice price to 5 000 000"), { mode: "price", value: 5000000, detail: "rice" }, "amt: space-grouped thousands");
// "than" must never be corrected to "thank" — comparisons keep working
eq(parseQuestion("compare income this month than last month", null, NOW).compare, true, "compare: 'than' survives spell correction");
eq(normalize("more than last month"), "more than last month", "normalize: than untouched");
eq(extractQuantity("i sold 3 bags of rice for 15,000", 15000), 3, "qty: quantity vs amount");
eq(extractQuantity("i sold rice for 5k", 5000), 1, "qty: default 1 (marked number is money)");
eq(extractQuantity("record a sale of 5000", 5000), 1, "qty: amount itself never counts");
eq(extractQuantity("i sold 2 shirts for 4000", 4000), 2, "qty: leading quantity");

// ── Answer text for DB-free handlers (greeting/thanks never touch Prisma) ───
(async () => {
  const { answerQuestion } = require("../src/utils/insightsEngine");
  const fakeBiz = { id: "test", baseCurrency: "NGN" };
  const g = await answerQuestion("good morning", fakeBiz);
  eq(g.intent, "greeting", "answer: greeting intent");
  eq(g.answer.startsWith("Good morning! 👋"), true, "answer: mirrors 'good morning'");
  const n = await answerQuestion("good night", fakeBiz);
  eq(n.answer.startsWith("Good night!"), true, "answer: mirrors 'good night'");
  const h = await answerQuestion("hello", fakeBiz);
  eq(/^Good (morning|afternoon|evening)! 👋/.test(h.answer), true, "answer: clock greeting for 'hello'");
  const t = await answerQuestion("thank you", fakeBiz);
  eq(t.intent, "thanks", "answer: thanks intent");
  eq(t.answer.includes("welcome"), true, "answer: thanks text");

  // Record commands parse amounts/details but never write — they return a
  // confirm action for the app (handlers are DB-free).
  const s1 = await answerQuestion("record a sale of 5000", fakeBiz);
  eq(s1.data?.action, { kind: "record_sale", amount: 5000, amountText: "₦5,000", description: null }, "action: plain sale");
  const s2 = await answerQuestion("i sold 3 bags of rice for 15,000", fakeBiz);
  eq(s2.data?.action?.amount, 15000, "action: amount after 'for' wins over quantity");
  eq(s2.data?.action?.description, "bags of rice", "action: description");
  // untracked product → offer an inventory add (unit price = amount ÷ qty)
  eq(s2.data?.action?.newProduct, { name: "Bags Of Rice", price: 5000, priceText: "₦5,000" }, "action: unknown product → add-to-inventory offer");
  eq(s2.answer.includes("isn't in your inventory"), true, "action: unknown product noted in answer");
  // channel mention is metadata, not a product name
  const sCh = await answerQuestion("i sold 5000 on whatsapp", fakeBiz);
  eq(sCh.data?.action?.channel, "whatsapp", "action: channel captured");
  eq(sCh.data?.action?.description, null, "action: channel not mistaken for a product");
  eq(sCh.answer.includes("via whatsapp"), true, "action: channel shown on the card");
  // unit pricing: "500 each" × 3
  const sEach = await answerQuestion("i sold 3 shirts 500 each", fakeBiz);
  eq(sEach.data?.action?.amount, 1500, "action: 'each' multiplies unit price by quantity");
  const s3 = await answerQuestion("record a sale of ₦7,500", fakeBiz);
  eq(s3.data?.action?.amount, 7500, "action: naira + comma amount");
  const s4 = await answerQuestion("i just sold 5k", fakeBiz);
  eq(s4.data?.action?.amount, 5000, "action: k suffix");
  const e1 = await answerQuestion("i spent 2k on fuel", fakeBiz);
  eq(e1.data?.action, { kind: "record_expense", amount: 2000, amountText: "₦2,000", description: "fuel", category: "fuel" }, "action: expense with category");
  const e2 = await answerQuestion("i spent 2m on rent", fakeBiz);
  eq(e2.data?.action?.amount, 2000000, "action: m suffix");
  // no amount → ask for it, no action attached
  const ask1 = await answerQuestion("record a sale", fakeBiz);
  eq(ask1.intent, "record_sale", "action: no amount still routes");
  eq(ask1.data, undefined, "action: no amount → no action");
  eq(ask1.answer.includes("How much"), true, "action: no amount → prompt");
  // bare-amount follow-up completes the command
  const fu1 = await answerQuestion("7,500", fakeBiz, "record_sale");
  eq(fu1.data?.action?.amount, 7500, "action: bare-amount follow-up");
  const fu2 = await answerQuestion("5k", fakeBiz, "record_expense");
  eq(fu2.data?.action?.amount, 5000, "action: bare 5k follow-up");
  // bare amount with no context stays a fallback; ranges don't re-enter commands
  eq(parseQuestion("5000", null, NOW).intent, null, "bare amount without context → fallback");
  eq(parseQuestion("what about last week", "record_sale", NOW).intent, null, "record intents not range follow-up context");

  // create_product end-to-end (fakeBiz has no items → no duplicate, creates)
  const c1 = await answerQuestion("add new product shawarma at 1500, 20 in stock", fakeBiz);
  eq(c1.intent, "create_product", "create: intent");
  eq(c1.data?.action, { kind: "create_product", name: "Shawarma", price: 1500, priceText: "₦1,500", stock: 20 }, "create: action payload");
  const c2 = await answerQuestion("create product shawarma", fakeBiz);
  eq(c2.data, undefined, "create: no price → no action");
  eq(c2.answer.includes("price"), true, "create: no price → asks for it");
  // unknown product in an update command becomes a create offer
  const u1 = await answerQuestion("restock garri 10", fakeBiz);
  eq(u1.data?.action, { kind: "create_product", name: "Garri", price: 0, stock: 10 }, "update: unknown → create offer with stock");
  const u2 = await answerQuestion("set garri price to 500", fakeBiz);
  eq(u2.data?.action, { kind: "create_product", name: "Garri", price: 500, priceText: "₦500", stock: 0 }, "update: unknown price-set → create offer with price");

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
