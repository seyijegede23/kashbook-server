// Savings (pots): the pure parts, plus structural guards. No network, no DB.
//   node scripts/savings-test.js
//
// The money paths (ledger deposit, PiggyVest deposit → NIP → inflow, withdrawal
// → verify → Anchor credit) need Postgres and the partners and live in
// scripts/savings-e2e-test.js. What CAN be pinned here is everything a wrong
// answer would silently mis-book: how an inbound credit is recognised as the
// merchant's own savings coming home, how wallet inflows pair with deposits,
// when a withdrawal may be called failed, the reserve arithmetic behind the
// spend gate, lock semantics, the webhook HMAC, kobo maths; and, read from the
// source as text, that the guards the plan names sit in the order it names.
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

process.env.JWT_SECRET = process.env.JWT_SECRET || "x".repeat(48);
process.env.CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || "testcloud";
process.env.CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY || "123456789012345";
process.env.CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET || "test_secret_value";
// Never a real database: Prisma connects lazily and nothing below queries.
delete process.env.DATABASE_URL;

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); failed++; }
}
function section(t) { console.log(`\n── ${t} ${"─".repeat(Math.max(0, 56 - t.length))}`); }

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "src");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const savings = require("../src/utils/savings");
const { decideCreditPurpose } = require("../src/utils/savingsCredit");
const { netSpendable } = require("../src/utils/savingsReserve");
const piggyvest = require("../src/services/piggyvest");
const { MONEY_EPS } = require("../src/config/fees");
const moneySources = require("../src/config/moneySources");

// ── source helpers ───────────────────────────────────────────────────────────
// Balanced-paren slice starting at an opening "(" — the argument list of a call.
function callArg(src, openIdx) {
  let depth = 0, str = null;
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i];
    if (str) {
      if (ch === "\\") { i++; continue; }
      if (ch === str) str = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { str = ch; continue; }
    if (ch === "(") depth++;
    else if (ch === ")") { depth--; if (depth === 0) return src.slice(openIdx, i + 1); }
  }
  return src.slice(openIdx);
}
// Every prisma.transaction.<method>(...) call in a file, with its argument text.
function transactionCalls(src) {
  const out = [];
  const re = /prisma\.transaction\.(aggregate|groupBy|findMany|findFirst|count)\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    const arg = callArg(src, m.index + m[0].length - 1);
    out.push({ method: m[1], index: m.index, line: src.slice(0, m.index).split("\n").length, arg });
  }
  return out;
}
// A top-level function body: from its declaration to the next "\n}" at column 0.
function fnBody(src, decl) {
  const start = src.indexOf(decl);
  assert.ok(start >= 0, `declaration not found: ${decl}`);
  const end = src.indexOf("\n}", start);
  return src.slice(start, end < 0 ? src.length : end);
}
// A router handler body: from router.<verb>("<path>" to the next "\n});".
function handlerBody(src, verb, route) {
  const decl = `router.${verb}("${route}"`;
  const start = src.indexOf(decl);
  assert.ok(start >= 0, `handler not found: ${decl}`);
  const end = src.indexOf("\n});", start);
  return src.slice(start, end < 0 ? src.length : end);
}
const mustPrecede = (hay, a, b, what) => {
  const ia = hay.indexOf(a), ib = hay.indexOf(b);
  assert.ok(ia >= 0, `${what}: "${a}" not found`);
  assert.ok(ib >= 0, `${what}: "${b}" not found`);
  assert.ok(ia < ib, `${what}: "${a}" must come before "${b}" (found at ${ia} vs ${ib})`);
};
const countOf = (hay, needle) => hay.split(needle).length - 1;

// ══ 1. INBOUND CREDIT CLASSIFICATION ═══════════════════════════════════════
section("1. a pot payout coming home is never booked as a customer's payment, and vice versa");

const POT_ACCT = "1234567890";
const cand = (id, reference, amount, potAccountNumber = POT_ACCT) => ({ id, reference, amount, potAccountNumber });

test("tier 1: our reference in the narration, exact amount", () => {
  const r = decideCreditPurpose({ narration: "KashBook savings kb_svw_ab12cd34", senderAccount: "9999999999", amount: 5000, candidates: [cand("m1", "kb_svw_ab12cd34", 5000)] });
  assert.deepStrictEqual(r, { purpose: "savings_withdrawal", movementId: "m1", tier: 1 });
});

test("tier 1: the reference match is case-insensitive (banks upper-case narrations)", () => {
  const r = decideCreditPurpose({ narration: "KASHBOOK SAVINGS KB_SVW_AB12CD34", amount: 5000, candidates: [cand("m1", "kb_svw_ab12cd34", 5000)] });
  assert.strictEqual(r.movementId, "m1");
  assert.strictEqual(r.tier, 1);
});

test("tier 1: a landing a little UNDER the request (fee on the way) is still ours", () => {
  const r = decideCreditPurpose({ narration: "kb_svw_ab12cd34", amount: 4950, candidates: [cand("m1", "kb_svw_ab12cd34", 5000)] });
  assert.strictEqual(r.purpose, "savings_withdrawal");
  assert.strictEqual(r.movementId, "m1");
});

test("tier 1: a landing OVER the request is not ours → income, reason reference_amount_over", () => {
  const r = decideCreditPurpose({ narration: "kb_svw_ab12cd34", senderAccount: POT_ACCT, amount: 5000.01, candidates: [cand("m1", "kb_svw_ab12cd34", 5000)] });
  assert.strictEqual(r.purpose, null);
  assert.strictEqual(r.review, "reference_amount_over");
  assert.strictEqual(r.movementId, undefined);
});

test("tier 1: an over-amount reference hit does NOT fall through to a tier-2 amount match on another row", () => {
  // Same sender, another open withdrawal happens to be 5000.01: the reference
  // named m1, so m2 must not be claimed by amount.
  const r = decideCreditPurpose({ narration: "kb_svw_ab12cd34", senderAccount: POT_ACCT, amount: 5000.01, candidates: [cand("m1", "kb_svw_ab12cd34", 5000), cand("m2", "kb_svw_ffffffff", 5000.01)] });
  assert.strictEqual(r.purpose, null);
  assert.strictEqual(r.review, "reference_amount_over");
});

test("tier 1: a reference in the narration that matches no candidate falls to tier 2", () => {
  const r = decideCreditPurpose({ narration: "kb_svw_unknown1", senderAccount: POT_ACCT, amount: 3000, candidates: [cand("m2", "kb_svw_ab12cd34", 3000)] });
  assert.deepStrictEqual(r, { purpose: "savings_withdrawal", movementId: "m2", tier: 2 });
});

test("tier 2: sender is the pot's funding account and exactly one open withdrawal has this amount", () => {
  const r = decideCreditPurpose({ narration: "Transfer", senderAccount: POT_ACCT, amount: 3000, candidates: [cand("m1", "kb_svw_a", 5000), cand("m2", "kb_svw_b", 3000)] });
  assert.deepStrictEqual(r, { purpose: "savings_withdrawal", movementId: "m2", tier: 2 });
});

test("tier 2: the amount must match to the kobo (IEEE floats compared in kobo)", () => {
  const r = decideCreditPurpose({ senderAccount: POT_ACCT, amount: 5000.1, candidates: [cand("m1", "kb_svw_a", 5000.10)] });
  assert.strictEqual(r.movementId, "m1");
  const r2 = decideCreditPurpose({ senderAccount: POT_ACCT, amount: 5000.11, candidates: [cand("m1", "kb_svw_a", 5000.10)] });
  assert.strictEqual(r2.purpose, null);
  assert.strictEqual(r2.review, "sender_no_amount_match");
});

test("tier 2: two open withdrawals of the same amount → ambiguous, booked as income with a review reason", () => {
  const r = decideCreditPurpose({ senderAccount: POT_ACCT, amount: 3000, candidates: [cand("m1", "kb_svw_a", 3000), cand("m2", "kb_svw_b", 3000)] });
  assert.strictEqual(r.purpose, null);
  assert.strictEqual(r.review, "ambiguous_amount");
  assert.strictEqual(r.movementId, undefined);
});

test("tier 2: sender account is formatted (spaces, dashes) but still 10 digits", () => {
  const r = decideCreditPurpose({ senderAccount: "123-456 7890", amount: 3000, candidates: [cand("m2", "kb_svw_b", 3000)] });
  assert.strictEqual(r.movementId, "m2");
});

test("tier 2: a candidate from ANOTHER pot's account is not matched by amount", () => {
  const r = decideCreditPurpose({ senderAccount: POT_ACCT, amount: 3000, candidates: [cand("m9", "kb_svw_z", 3000, "0000000000")] });
  assert.deepStrictEqual(r, { purpose: null });
});

test("non-10-digit sender never matches by amount (no review reason: not a pot account)", () => {
  for (const sender of ["12345", "12345678901"]) {
    const r = decideCreditPurpose({ narration: "Transfer", senderAccount: sender, amount: 3000, candidates: [cand("m2", "kb_svw_b", 3000)] });
    assert.deepStrictEqual(r, { purpose: null }, `sender=${JSON.stringify(sender)}`);
  }
  // A NAMED sender with no account is somebody: plain income, no review.
  for (const sender of ["", null, undefined]) {
    const r = decideCreditPurpose({ narration: "Transfer", senderAccount: sender, senderName: "Ada Buyer", amount: 3000, candidates: [cand("m2", "kb_svw_b", 3000)] });
    assert.deepStrictEqual(r, { purpose: null }, `sender=${JSON.stringify(sender)}`);
  }
});

test("rail bank name + amount alone is never enough (no sender account, no reference)", () => {
  // Named sender: income, full stop.
  const named = decideCreditPurpose({ narration: "VFD MFB transfer", senderAccount: null, senderName: "VFD MFB", amount: 3000, candidates: [cand("m2", "kb_svw_b", 3000)] });
  assert.deepStrictEqual(named, { purpose: null });
});

test("an UNATTRIBUTED credit (no sender at all) equal to an open withdrawal is income, but flagged so the matchers wait for the webhook", () => {
  const r = decideCreditPurpose({ narration: "NIP transfer", senderAccount: null, senderName: null, amount: 3000, candidates: [cand("m2", "kb_svw_b", 3000)] });
  assert.deepStrictEqual(r, { purpose: null, review: "possible_savings_landing" });
  // A different amount is nobody's withdrawal: nothing to wait for.
  const other = decideCreditPurpose({ narration: "NIP transfer", senderAccount: null, senderName: null, amount: 2999, candidates: [cand("m2", "kb_svw_b", 3000)] });
  assert.deepStrictEqual(other, { purpose: null });
});

test("no candidates → plain income, no matter the narration", () => {
  assert.deepStrictEqual(decideCreditPurpose({ narration: "kb_svw_ab12cd34", senderAccount: POT_ACCT, amount: 5000, candidates: [] }), { purpose: null });
  assert.deepStrictEqual(decideCreditPurpose({ narration: "kb_svw_ab12cd34", amount: 5000 }), { purpose: null });
});

test("zero, negative or non-numeric amounts are never tagged", () => {
  for (const amount of [0, -5, "abc", null, undefined]) {
    assert.deepStrictEqual(decideCreditPurpose({ narration: "kb_svw_ab12cd34", senderAccount: POT_ACCT, amount, candidates: [cand("m1", "kb_svw_ab12cd34", 5000)] }), { purpose: null }, `amount=${amount}`);
  }
});

// ══ 2. PAIRING WALLET INFLOWS WITH DEPOSITS ════════════════════════════════
section("2. each PiggyVest inflow settles at most one deposit, and only when it can be ours");

const dep = (id, status, reference, amount, createdAt) => ({ id, status, reference, amount, createdAt });
const inflow = (id, amount, narration = "", category = "") => ({ id, amount, narration, category });

test("oldest deposit first: one inflow of ₦1,000 settles the older of two ₦1,000 sent deposits", () => {
  const deposits = [
    dep("d2", "sent", "kb_sv_b", 1000, "2026-09-29T10:05:00Z"),
    dep("d1", "sent", "kb_sv_a", 1000, "2026-09-29T10:00:00Z"),
  ];
  const { pairs, leftoverInflows } = savings.pairInflows(deposits, [inflow("i1", 1000, "Funding")]);
  assert.deepStrictEqual(pairs, [{ depositId: "d1", inflowId: "i1" }]);
  assert.deepStrictEqual(leftoverInflows, []);
});

test("one inflow is consumed once: two deposits, one inflow → one pair", () => {
  const deposits = [dep("d1", "sent", "kb_sv_a", 1000, "2026-09-29T10:00:00Z"), dep("d2", "sent", "kb_sv_b", 1000, "2026-09-29T10:05:00Z")];
  const { pairs } = savings.pairInflows(deposits, [inflow("i1", 1000)]);
  assert.strictEqual(pairs.length, 1);
  const ids = new Set(pairs.map((p) => p.inflowId));
  assert.strictEqual(ids.size, pairs.length);
});

test("two inflows, two deposits → each inflow used exactly once", () => {
  const deposits = [dep("d1", "sent", "kb_sv_a", 1000, "2026-09-29T10:00:00Z"), dep("d2", "sent", "kb_sv_b", 1000, "2026-09-29T10:05:00Z")];
  const { pairs, leftoverInflows } = savings.pairInflows(deposits, [inflow("i1", 1000), inflow("i2", 1000)]);
  assert.deepStrictEqual(pairs, [{ depositId: "d1", inflowId: "i1" }, { depositId: "d2", inflowId: "i2" }]);
  assert.deepStrictEqual(leftoverInflows, []);
});

test("a SENT deposit may pair on amount alone (the money is known to have left Anchor)", () => {
  const { pairs } = savings.pairInflows([dep("d1", "sent", "kb_sv_a", 2500, "2026-09-29T10:00:00Z")], [inflow("i1", 2500, "NIP transfer")]);
  assert.deepStrictEqual(pairs, [{ depositId: "d1", inflowId: "i1" }]);
});

test("an INITIATED deposit needs our reference in the inflow narration", () => {
  const d = dep("d1", "initiated", "kb_sv_a", 2500, "2026-09-29T10:00:00Z");
  assert.deepStrictEqual(savings.pairInflows([d], [inflow("i1", 2500, "NIP transfer")]).pairs, []);
  assert.deepStrictEqual(savings.pairInflows([d], [inflow("i1", 2500, "Savings Rent KB_SV_A")]).pairs, [{ depositId: "d1", inflowId: "i1" }]);
});

test("an UNKNOWN deposit needs our reference in the inflow narration", () => {
  const d = dep("d1", "unknown", "kb_sv_a", 2500, "2026-09-29T10:00:00Z");
  assert.deepStrictEqual(savings.pairInflows([d], [inflow("i1", 2500)]).pairs, []);
  assert.deepStrictEqual(savings.pairInflows([d], [inflow("i1", 2500, "kb_sv_a")]).pairs, [{ depositId: "d1", inflowId: "i1" }]);
});

test("the reference match is exact per deposit: kb_sv_a does not claim an inflow for kb_sv_ab", () => {
  const d = dep("d1", "initiated", "kb_sv_ab", 2500, "2026-09-29T10:00:00Z");
  // The inflow carries kb_sv_a only; kb_sv_ab is not a substring of it.
  assert.deepStrictEqual(savings.pairInflows([d], [inflow("i1", 2500, "kb_sv_a")]).pairs, []);
});

test("an interest inflow never pairs on amount (narration)", () => {
  const { pairs, leftoverInflows } = savings.pairInflows([dep("d1", "sent", "kb_sv_a", 12.5, "2026-09-29T10:00:00Z")], [inflow("i1", 12.5, "Interest payout")]);
  assert.deepStrictEqual(pairs, []);
  assert.strictEqual(leftoverInflows.length, 1);
});

test("an interest inflow never pairs on amount (category)", () => {
  const { pairs } = savings.pairInflows([dep("d1", "sent", "kb_sv_a", 12.5, "2026-09-29T10:00:00Z")], [inflow("i1", 12.5, "", "interest")]);
  assert.deepStrictEqual(pairs, []);
});

test("an interest inflow DOES pair when it carries our reference (reference beats the interest rule)", () => {
  const { pairs } = savings.pairInflows([dep("d1", "sent", "kb_sv_a", 12.5, "2026-09-29T10:00:00Z")], [inflow("i1", 12.5, "kb_sv_a interest", "interest")]);
  assert.deepStrictEqual(pairs, [{ depositId: "d1", inflowId: "i1" }]);
});

test("amount pairing is to the kobo: ₦1,000 does not settle a ₦999.99 inflow", () => {
  assert.deepStrictEqual(savings.pairInflows([dep("d1", "sent", "kb_sv_a", 1000, "2026-09-29T10:00:00Z")], [inflow("i1", 999.99)]).pairs, []);
});

test("a deposit with no reference never pairs on the empty string", () => {
  const { pairs } = savings.pairInflows([dep("d1", "initiated", "", 1000, "2026-09-29T10:00:00Z")], [inflow("i1", 1000, "anything")]);
  assert.deepStrictEqual(pairs, []);
});

test("inputs are not mutated and leftovers keep their order", () => {
  const deposits = [dep("d2", "sent", "kb_sv_b", 1000, "2026-09-29T10:05:00Z"), dep("d1", "sent", "kb_sv_a", 1000, "2026-09-29T10:00:00Z")];
  const inflows = [inflow("i1", 5), inflow("i2", 1000), inflow("i3", 7)];
  const { leftoverInflows } = savings.pairInflows(deposits, inflows);
  assert.deepStrictEqual(deposits.map((d) => d.id), ["d2", "d1"]);
  assert.deepStrictEqual(leftoverInflows.map((i) => i.id), ["i1", "i3"]);
});

test("an inflow that arrived BEFORE the deposit was made cannot be its landing (amount-only pairing)", () => {
  const d = { id: "d1", status: "sent", reference: "kb_sv_late", amount: 1000, createdAt: "2026-09-29T10:00:00Z" };
  const early = { id: "i0", amount: 1000, narration: "NIP transfer", category: "credit", createdAt: "2026-09-29T09:30:00Z" };
  const later = { id: "i1", amount: 1000, narration: "NIP transfer", category: "credit", createdAt: "2026-09-29T10:03:00Z" };
  const { pairs } = savings.pairInflows([d], [early, later]);
  assert.deepStrictEqual(pairs, [{ depositId: "d1", inflowId: "i1" }]);
  // Clock skew of a few minutes is tolerated; an inflow with no time is allowed.
  const skew = { id: "i2", amount: 1000, narration: "NIP", category: "credit", createdAt: "2026-09-29T09:57:00Z" };
  assert.strictEqual(savings.pairInflows([d], [skew]).pairs.length, 1);
  const untimed = { id: "i3", amount: 1000, narration: "NIP", category: "credit" };
  assert.strictEqual(savings.pairInflows([d], [untimed]).pairs.length, 1);
});

test("the month key follows Lagos time (UTC+1), not UTC", () => {
  // 23:30 UTC on the last day of September is 00:30 on 1 October in Lagos.
  assert.strictEqual(savings.monthKey(new Date("2026-09-30T23:30:00Z")), "2026-10");
  assert.strictEqual(savings.monthKey(new Date("2026-09-30T22:59:00Z")), "2026-09");
});

// ══ 3. WITHDRAWAL OUTCOMES ═════════════════════════════════════════════════
section("3. a withdrawal is completed or failed only on PiggyVest's own word");

const T0 = new Date("2026-09-29T12:00:00Z");
const minutesAgo = (m) => new Date(T0.getTime() - m * 60 * 1000);

test("verify success → completed, misses reset", () => {
  assert.deepStrictEqual(savings.decideWithdrawalOutcome({ status: "processing", verify: { status: "success" }, now: T0 }), { next: "completed", misses: 0 });
  assert.deepStrictEqual(savings.decideWithdrawalOutcome({ status: "unknown", verify: { status: "success" }, verifyMisses: 1, now: T0 }), { next: "completed", misses: 0 });
});

test("verify failed → failed", () => {
  assert.deepStrictEqual(savings.decideWithdrawalOutcome({ status: "processing", verify: { status: "failed" }, now: T0 }), { next: "failed", misses: 0 });
});

test("verify pending → keep waiting, misses reset to 0", () => {
  assert.deepStrictEqual(savings.decideWithdrawalOutcome({ status: "processing", verify: { status: "pending" }, verifyMisses: 1, now: T0 }), { next: null, misses: 0 });
});

test("a missing or malformed verify answer is 'pending', never a terminal state", () => {
  assert.strictEqual(savings.decideWithdrawalOutcome({ status: "processing", verify: null, now: T0 }).next, null);
  assert.strictEqual(savings.decideWithdrawalOutcome({ status: "processing", verify: {}, now: T0 }).next, null);
  assert.strictEqual(savings.decideWithdrawalOutcome({ status: "processing", verify: { status: "weird" }, now: T0 }).next, null);
});

test("first not_found → one miss, still open", () => {
  assert.deepStrictEqual(savings.decideWithdrawalOutcome({ status: "processing", verify: { status: "not_found" }, verifyMisses: 0, lastVerifiedAt: null, now: T0 }), { next: null, misses: 1 });
});

test("second not_found only 5 minutes later does NOT count (a webhook nudge right after the poll)", () => {
  assert.deepStrictEqual(savings.decideWithdrawalOutcome({ status: "processing", verify: { status: "not_found" }, verifyMisses: 1, lastVerifiedAt: minutesAgo(5), now: T0 }), { next: null, misses: 1 });
});

test("second not_found 10 minutes later → failed", () => {
  assert.deepStrictEqual(savings.decideWithdrawalOutcome({ status: "processing", verify: { status: "not_found" }, verifyMisses: 1, lastVerifiedAt: minutesAgo(10), now: T0 }), { next: "failed", misses: 2 });
});

test("(cadence) at the loop's own 5-minute spacing the second counted miss is reachable: t, t+5 (uncounted, anchor untouched), t+10 → failed", () => {
  // applyWithdrawalOutcome only advances lastVerifiedAt on a COUNTED miss, so
  // the anchor stays at t through the t+5 nudge and t+10 is spaced.
  const t0 = new Date("2026-09-29T10:00:00Z");
  const m1 = savings.decideWithdrawalOutcome({ status: "unknown", verify: { status: "not_found" }, verifyMisses: 0, lastVerifiedAt: null, now: t0 });
  assert.deepStrictEqual(m1, { next: null, misses: 1 });
  const t5 = new Date(t0.getTime() + 5 * 60000);
  const m2 = savings.decideWithdrawalOutcome({ status: "unknown", verify: { status: "not_found" }, verifyMisses: 1, lastVerifiedAt: t0, now: t5 });
  assert.deepStrictEqual(m2, { next: null, misses: 1 }, "uncounted: the anchor must not move");
  const t10 = new Date(t0.getTime() + 10 * 60000);
  const m3 = savings.decideWithdrawalOutcome({ status: "unknown", verify: { status: "not_found" }, verifyMisses: 1, lastVerifiedAt: t0, now: t10 });
  assert.deepStrictEqual(m3, { next: "failed", misses: 2 });
});

test("a first miss always counts, even right after a pending answer stamped the row", () => {
  const r = savings.decideWithdrawalOutcome({ status: "processing", verify: { status: "not_found" }, verifyMisses: 0, lastVerifiedAt: new Date(Date.now() - 60000), now: new Date() });
  assert.deepStrictEqual(r, { next: null, misses: 1 });
});

test("a withdrawal PiggyVest ACCEPTED (a reference came back) is never auto-failed on not_found: it goes to review", () => {
  const r = savings.decideWithdrawalOutcome({ status: "processing", verify: { status: "not_found" }, verifyMisses: 1, lastVerifiedAt: minutesAgo(10), now: T0, accepted: true });
  assert.deepStrictEqual(r, { next: "needs_review", misses: 2 });
});

test("the streak is a streak: a pending answer between two not_founds resets it", () => {
  const afterPending = savings.decideWithdrawalOutcome({ status: "processing", verify: { status: "pending" }, verifyMisses: 1, lastVerifiedAt: minutesAgo(20), now: T0 });
  assert.strictEqual(afterPending.misses, 0);
  const r = savings.decideWithdrawalOutcome({ status: "processing", verify: { status: "not_found" }, verifyMisses: afterPending.misses, lastVerifiedAt: minutesAgo(10), now: T0 });
  assert.deepStrictEqual(r, { next: null, misses: 1 });
});

test("a row that is not processing/unknown is never changed by a verify answer", () => {
  for (const status of ["requested", "completed", "failed", "needs_review"]) {
    const r = savings.decideWithdrawalOutcome({ status, verify: { status: "success" }, verifyMisses: 3, now: T0 });
    assert.deepStrictEqual(r, { next: null, misses: 3 }, status);
  }
});

// ══ 4. PRE-ANCHOR ERRORS ═══════════════════════════════════════════════════
section("4. a deposit is failed outright only when the bank was never called");

test("known pre-Anchor codes", () => {
  for (const code of ["INSUFFICIENT_BALANCE", "RECIPIENT_UNVERIFIED", "UNKNOWN_BANK", "NO_BANKING", "SAVINGS_DEST_USE_DEPOSIT", "BAD_PURPOSE", "ANCHOR_NOT_CONFIGURED"]) {
    assert.strictEqual(savings.isPreAnchorError(Object.assign(new Error("x"), { code })), true, code);
  }
});

test("moneyMoved:false is trusted whatever the code", () => {
  assert.strictEqual(savings.isPreAnchorError(Object.assign(new Error("x"), { code: "WHATEVER", moneyMoved: false })), true);
  assert.strictEqual(savings.isPreAnchorError({ moneyMoved: false }), true);
});

test("an unknown error, a timeout, or moneyMoved:true is NOT pre-Anchor (money may have moved)", () => {
  assert.strictEqual(savings.isPreAnchorError(new Error("socket hang up")), false);
  assert.strictEqual(savings.isPreAnchorError(Object.assign(new Error("t"), { code: "ETIMEDOUT" })), false);
  assert.strictEqual(savings.isPreAnchorError(Object.assign(new Error("t"), { code: "INSUFFICIENT_BALANCE", moneyMoved: true })), true); // code still wins: the gate throws before the call
  assert.strictEqual(savings.isPreAnchorError(Object.assign(new Error("t"), { moneyMoved: true })), false);
  assert.strictEqual(savings.isPreAnchorError(null), false);
  assert.strictEqual(savings.isPreAnchorError(undefined), false);
});

test("executeTransfer's INSUFFICIENT_BALANCE carries moneyMoved:false", () => {
  const src = read("src/utils/executeTransfer.js");
  const gate = src.slice(src.indexOf('err.code = "INSUFFICIENT_BALANCE"'), src.indexOf('err.code = "INSUFFICIENT_BALANCE"') + 300);
  assert.ok(/err\.moneyMoved = false/.test(gate), "INSUFFICIENT_BALANCE does not set moneyMoved = false");
});

// ══ 5. THE RESERVE ═════════════════════════════════════════════════════════
section("5. spendable = gross − reserved, floored, rounded to the kobo");

test("plain subtraction", () => {
  assert.strictEqual(netSpendable(1000, 250), 750);
  assert.strictEqual(netSpendable(1000, 0), 1000);
  assert.strictEqual(netSpendable(0, 0), 0);
});

test("floored at zero when the reserve exceeds gross (over-reserve alarms, never throws)", () => {
  assert.strictEqual(netSpendable(100, 250), 0);
  assert.strictEqual(netSpendable(0, 5), 0);
});

test("a hair under MONEY_EPS is zero, a kobo is a kobo", () => {
  assert.strictEqual(netSpendable(100, 100.004), 0);
  assert.strictEqual(netSpendable(100, 99.999), 0);            // net 0.001 < EPS
  assert.strictEqual(netSpendable(100, 99.99), 0.01);
  assert.ok(MONEY_EPS < 0.01, "MONEY_EPS must be below one kobo");
});

test("float drift is rounded to 2 dp", () => {
  assert.strictEqual(netSpendable(1000.1, 0.3), 999.8);         // raw 999.8000000000001
  assert.strictEqual(netSpendable(0.3, 0.1), 0.2);              // raw 0.19999999999999998
  assert.strictEqual(netSpendable(5000.01, 0), 5000.01);
});

test("a negative or garbage reserve counts as zero; garbage gross counts as zero", () => {
  assert.strictEqual(netSpendable(500, -50), 500);
  assert.strictEqual(netSpendable(500, "abc"), 500);
  assert.strictEqual(netSpendable(500, null), 500);
  assert.strictEqual(netSpendable(null, 10), 0);
  assert.strictEqual(netSpendable("abc", 0), 0);
});

// ══ 6. LOCKS ═══════════════════════════════════════════════════════════════
section("6. a strict lock is server-enforced, a flexible one asks");

const future = new Date(T0.getTime() + 30 * 86400000);
const past = new Date(T0.getTime() - 86400000);

test("no lock → allowed", () => {
  assert.deepStrictEqual(savings.lockAllows({ lockUntil: null, lockMode: null }, { now: T0 }), { ok: true });
  assert.deepStrictEqual(savings.lockAllows({}, { now: T0 }), { ok: true });
  assert.deepStrictEqual(savings.lockAllows(null, { now: T0 }), { ok: true });
});

test("expired lock → allowed, whatever the mode", () => {
  assert.deepStrictEqual(savings.lockAllows({ lockUntil: past, lockMode: "strict" }, { now: T0 }), { ok: true });
  assert.deepStrictEqual(savings.lockAllows({ lockUntil: past, lockMode: "flexible" }, { now: T0 }), { ok: true });
  assert.deepStrictEqual(savings.lockAllows({ lockUntil: T0, lockMode: "strict" }, { now: T0 }), { ok: true }); // exactly now is over
});

test("strict + future → POT_LOCKED even with confirmEarly", () => {
  const r = savings.lockAllows({ lockUntil: future, lockMode: "strict" }, { now: T0, confirmEarly: true });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, "POT_LOCKED");
  assert.strictEqual(r.until.getTime(), future.getTime());
});

test("flexible + future without confirmation → EARLY_WITHDRAWAL_CONFIRM", () => {
  const r = savings.lockAllows({ lockUntil: future, lockMode: "flexible" }, { now: T0 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, "EARLY_WITHDRAWAL_CONFIRM");
});

test("flexible + future with confirmation → allowed and marked early", () => {
  assert.deepStrictEqual(savings.lockAllows({ lockUntil: future, lockMode: "flexible" }, { now: T0, confirmEarly: true }), { ok: true, early: true });
});

test("lockUntil as an ISO string works the same", () => {
  assert.strictEqual(savings.lockAllows({ lockUntil: future.toISOString(), lockMode: "strict" }, { now: T0 }).code, "POT_LOCKED");
});

// ══ 7. STRAY INFLOWS ═══════════════════════════════════════════════════════
section("7. an inflow that is not our deposit is interest or an outside deposit");

test("interest by category or narration", () => {
  assert.strictEqual(savings.classifyUnattributedInflow({ category: "interest", narration: "" }), "interest");
  assert.strictEqual(savings.classifyUnattributedInflow({ category: "credit", narration: "Monthly Interest payout" }), "interest");
  assert.strictEqual(savings.classifyUnattributedInflow({ category: "INTEREST_PAYOUT" }), "interest");
});

test("everything else is an external deposit", () => {
  assert.strictEqual(savings.classifyUnattributedInflow({ category: "credit", narration: "Transfer from ADA OBI" }), "external_deposit");
  assert.strictEqual(savings.classifyUnattributedInflow({}), "external_deposit");
  assert.strictEqual(savings.classifyUnattributedInflow(null), "external_deposit");
});

// ══ 8. WEBHOOK SIGNATURE ═══════════════════════════════════════════════════
section("8. the PiggyVest webhook is fail-closed");

const SECRET = "pvb_test_secret_0123456789";
const sign = (buf, key = SECRET) => crypto.createHmac("sha512", key).update(buf).digest("hex");
const EVENT = { eventId: "evt_1", eventType: "bank-transfer.outflow.success", eventData: { reference: "kb_svw_abc", amount: 500000 } };
const withSecret = (fn) => {
  const prev = process.env.PVB_SECRET_KEY;
  process.env.PVB_SECRET_KEY = SECRET;
  try { fn(); } finally { if (prev === undefined) delete process.env.PVB_SECRET_KEY; else process.env.PVB_SECRET_KEY = prev; }
};

test("valid signature over the raw bytes (Buffer and string)", () => withSecret(() => {
  const raw = Buffer.from(JSON.stringify(EVENT));
  assert.strictEqual(piggyvest.verifyWebhookSignature(raw, sign(raw)), true);
  assert.strictEqual(piggyvest.verifyWebhookSignature(raw.toString("utf8"), sign(raw)), true);
}));

test("a pretty-printed body verifies only via JSON.stringify(JSON.parse(raw))", () => withSecret(() => {
  const compact = Buffer.from(JSON.stringify(EVENT));
  const pretty = Buffer.from(JSON.stringify(EVENT, null, 2));
  assert.notStrictEqual(pretty.toString(), compact.toString());
  const sigOverCompact = sign(compact);
  assert.notStrictEqual(sign(pretty), sigOverCompact, "test premise: the raw bytes differ");
  assert.strictEqual(piggyvest.verifyWebhookSignature(pretty, sigOverCompact), true);
}));

test("the compact fallback does not accept a signature over some OTHER body", () => withSecret(() => {
  const pretty = Buffer.from(JSON.stringify(EVENT, null, 2));
  const other = Buffer.from(JSON.stringify({ ...EVENT, eventData: { ...EVENT.eventData, amount: 1 } }));
  assert.strictEqual(piggyvest.verifyWebhookSignature(pretty, sign(other)), false);
}));

test("header case is tolerated (upper-case hex, surrounding whitespace)", () => withSecret(() => {
  const raw = Buffer.from(JSON.stringify(EVENT));
  assert.strictEqual(piggyvest.verifyWebhookSignature(raw, ` ${sign(raw).toUpperCase()} `), true);
}));

test("wrong secret → false", () => withSecret(() => {
  const raw = Buffer.from(JSON.stringify(EVENT));
  assert.strictEqual(piggyvest.verifyWebhookSignature(raw, sign(raw, "another_secret")), false);
}));

test("tampered body → false", () => withSecret(() => {
  const raw = Buffer.from(JSON.stringify(EVENT));
  const sig = sign(raw);
  const tampered = Buffer.from(JSON.stringify({ ...EVENT, eventData: { ...EVENT.eventData, amount: 1 } }));
  assert.strictEqual(piggyvest.verifyWebhookSignature(tampered, sig), false);
}));

test("non-hex, wrong-length (sha256) or empty header → false, no throw", () => withSecret(() => {
  const raw = Buffer.from(JSON.stringify(EVENT));
  assert.strictEqual(piggyvest.verifyWebhookSignature(raw, "z".repeat(128)), false);
  assert.strictEqual(piggyvest.verifyWebhookSignature(raw, crypto.createHmac("sha256", SECRET).update(raw).digest("hex")), false);
  assert.strictEqual(piggyvest.verifyWebhookSignature(raw, ""), false);
  assert.strictEqual(piggyvest.verifyWebhookSignature(raw, "sha512=" + sign(raw)), false);
}));

test("missing header → false", () => withSecret(() => {
  const raw = Buffer.from(JSON.stringify(EVENT));
  assert.strictEqual(piggyvest.verifyWebhookSignature(raw, undefined), false);
  assert.strictEqual(piggyvest.verifyWebhookSignature(raw, null), false);
}));

test("missing secret → false even with a signature computed with the empty key", () => {
  const prev = process.env.PVB_SECRET_KEY;
  delete process.env.PVB_SECRET_KEY;
  try {
    const raw = Buffer.from(JSON.stringify(EVENT));
    assert.strictEqual(piggyvest.verifyWebhookSignature(raw, sign(raw, "")), false);
    assert.strictEqual(piggyvest.isConfigured(), false);
  } finally { if (prev !== undefined) process.env.PVB_SECRET_KEY = prev; }
});

test("a non-JSON body still verifies over the raw bytes only", () => withSecret(() => {
  const raw = Buffer.from("not json at all");
  assert.strictEqual(piggyvest.verifyWebhookSignature(raw, sign(raw)), true);
  assert.strictEqual(piggyvest.verifyWebhookSignature(raw, sign(Buffer.from("other"))), false);
}));

test("the route refuses a bad signature before parsing and never trusts the payload for money", () => {
  const src = read("src/routes/piggyvestWebhook.js");
  mustPrecede(src, "verifyWebhookSignature(raw, header)", "JSON.parse(raw", "webhook route");
  assert.ok(/return res\.status\(401\)/.test(src), "bad signature must answer 401");
  assert.ok(/piggyvest\.verifyTransaction\(movement\.reference\)/.test(src), "outflow events must re-verify with our own key");
  assert.ok(!/eventData\.status|d\.status\s*===\s*["']success/.test(src), "the payload's status must not decide the outcome");
  mustPrecede(src, "await handleEvent(evt)", "processedWebhook.create", "dedup marker is written after handling");
  assert.ok(/PVB_VERIFY_WEBHOOK === "false" && process\.env\.NODE_ENV !== "production"/.test(src), "the verify bypass must be dev-only");
});

// ══ 9. KOBO MATHS ══════════════════════════════════════════════════════════
section("9. naira ↔ kobo round-trips");

test("toKoboInt / fromKobo round-trip 0.01 and 1234.56", () => {
  assert.strictEqual(piggyvest.toKoboInt(0.01), 1);
  assert.strictEqual(piggyvest.fromKobo(1), 0.01);
  assert.strictEqual(piggyvest.toKoboInt(1234.56), 123456);
  assert.strictEqual(piggyvest.fromKobo(123456), 1234.56);
  assert.strictEqual(piggyvest.fromKobo(piggyvest.toKoboInt(1234.56)), 1234.56);
  assert.strictEqual(piggyvest.toKoboInt(5000.01), 500001); // IEEE 5000.01*100 = 500001.00000000006
  assert.strictEqual(piggyvest.toKoboInt(0.29), 29);        // 0.29*100 = 28.999999999999996
});

test("99.999 rounds to ₦100.00 (10000 kobo), never truncates to 9999", () => {
  assert.strictEqual(piggyvest.toKoboInt(99.999), 10000);
  assert.strictEqual(piggyvest.fromKobo(piggyvest.toKoboInt(99.999)), 100);
});

test("garbage is zero, and fromKobo rounds a fractional kobo", () => {
  assert.strictEqual(piggyvest.toKoboInt("abc"), 0);
  assert.strictEqual(piggyvest.toKoboInt(null), 0);
  assert.strictEqual(piggyvest.fromKobo(undefined), 0);
  assert.strictEqual(piggyvest.fromKobo("123456"), 1234.56);
  assert.strictEqual(piggyvest.fromKobo(100.4), 1);
});

test("the wire body sends integer kobo", () => {
  const src = read("src/services/piggyvest.js");
  const body = fnBody(src, "async function transferToBank(");
  assert.ok(/amount:\s*toKoboInt\(amount\)/.test(body), "transferToBank must send toKoboInt(amount)");
  const fund = fnBody(src, "async function testFunding(");
  assert.ok(/amount:\s*toKoboInt\(amount\)/.test(fund), "testFunding must send toKoboInt(amount)");
});

// ══ 10. TRANSFER STATUS WORDS ══════════════════════════════════════════════
section("10. unrecognised partner words are pending, never success");

test("success words", () => {
  for (const s of ["success", "SUCCESS", "Successful", "completed", "paid", "settled"]) assert.strictEqual(piggyvest.normaliseTransferStatus(s), "success", s);
});
test("failure words", () => {
  for (const s of ["failed", "FAILURE", "reversed", "declined", "rejected", "cancelled", "canceled"]) assert.strictEqual(piggyvest.normaliseTransferStatus(s), "failed", s);
});
test("anything else is pending", () => {
  for (const s of ["processing", "pending", "queued", "", null, undefined, "successs", "ok", 200]) assert.strictEqual(piggyvest.normaliseTransferStatus(s), "pending", String(s));
});
test("verifyTransaction maps a 404 or an empty record to not_found (never to failed by itself)", () => {
  const src = read("src/services/piggyvest.js");
  const body = fnBody(src, "async function verifyTransaction(");
  assert.ok(/e\.status === 404\) return \{ status: "not_found"/.test(body), "404 → not_found");
  assert.ok(/Object\.keys\(d\)\.length === 0\)\) return \{ status: "not_found"/.test(body), "empty data → not_found");
  assert.ok(!/status: "failed"/.test(body), "verifyTransaction must not invent 'failed'");
});

// ══ 11. MIGRATION ↔ SCHEMA ═════════════════════════════════════════════════
section("11. the tables the code writes are the tables the migration creates");

const MIGRATION_DIR = path.join(ROOT, "prisma", "migrations", "20260929120000_savings");
const migrationSql = fs.readFileSync(path.join(MIGRATION_DIR, "migration.sql"), "utf8");
const schema = read("prisma/schema.prisma");
const TABLES = ["SavingsProfile", "SavingsPot", "SavingsMovement"];

function migrationColumns(table) {
  const head = `"${table}" (`;
  const open = migrationSql.indexOf(head);
  assert.ok(open >= 0, `CREATE TABLE "${table}" missing from the migration`);
  const body = migrationSql.slice(open + head.length, migrationSql.indexOf(`CONSTRAINT "${table}_pkey"`, open));
  return new Set([...body.matchAll(/^\s*"(\w+)"\s+/gm)].map((m) => m[1]));
}
function modelBody(model) {
  const start = schema.indexOf(`model ${model} {`);
  assert.ok(start >= 0, `model ${model} missing from schema.prisma`);
  return schema.slice(start, schema.indexOf("\n}", start));
}
function modelFields(model) {
  return new Set([...modelBody(model).matchAll(/^\s+(\w+)\s+(String|Int|Float|DateTime|Boolean|Json)(\?|\[\])?(\s|$)/gm)].map((m) => m[1]));
}

for (const table of TABLES) {
  test(`${table}: every Prisma field has a column, and every column a field`, () => {
    const cols = migrationColumns(table);
    const fields = modelFields(table);
    assert.ok(fields.size >= 5, `parsed too few fields for ${table}: ${[...fields]}`);
    const missingCols = [...fields].filter((f) => !cols.has(f));
    const missingFields = [...cols].filter((c) => !fields.has(c));
    assert.deepStrictEqual(missingCols, [], `fields with no column: ${missingCols}`);
    assert.deepStrictEqual(missingFields, [], `columns with no field: ${missingFields}`);
  });
}

test("column types agree with the model (Float ↔ DOUBLE PRECISION, Int ↔ INTEGER, DateTime ↔ TIMESTAMP, nullability)", () => {
  const sqlType = { String: "TEXT", Int: "INTEGER", Float: "DOUBLE PRECISION", DateTime: "TIMESTAMP(3)", Boolean: "BOOLEAN", Json: "JSONB" };
  for (const table of TABLES) {
    const head = `"${table}" (`;
    const open = migrationSql.indexOf(head);
    const body = migrationSql.slice(open + head.length, migrationSql.indexOf(`CONSTRAINT "${table}_pkey"`, open));
    const colDefs = new Map([...body.matchAll(/^\s*"(\w+)"\s+([^,\n]+)/gm)].map((m) => [m[1], m[2].trim()]));
    for (const m of modelBody(table).matchAll(/^\s+(\w+)\s+(String|Int|Float|DateTime|Boolean|Json)(\?)?(\s|$)/gm)) {
      const [, field, type, optional] = m;
      const def = colDefs.get(field);
      assert.ok(def, `${table}.${field}: no column definition`);
      assert.ok(def.startsWith(sqlType[type]), `${table}.${field}: model ${type} but column "${def}"`);
      const notNull = /NOT NULL/.test(def);
      assert.strictEqual(notNull, !optional, `${table}.${field}: model ${optional ? "optional" : "required"} but column ${notNull ? "NOT NULL" : "nullable"}`);
    }
  }
});

test("Transaction.purpose is a nullable String in the model and ONE nullable TEXT column in the migration", () => {
  const tx = modelBody("Transaction");
  assert.ok(/^\s+purpose\s+String\?/m.test(tx), "Transaction.purpose String? missing from the model");
  const alters = [...migrationSql.matchAll(/ALTER TABLE "Transaction"[^;]*;/g)].map((m) => m[0]);
  assert.strictEqual(alters.length, 1, `expected one ALTER on Transaction, found ${alters.length}`);
  assert.ok(/^ALTER TABLE "Transaction" ADD COLUMN IF NOT EXISTS "purpose" TEXT;$/.test(alters[0].trim()), `unexpected ALTER: ${alters[0]}`);
});

test("the migration is additive: no DROP, no ALTER COLUMN, no RENAME, no TRUNCATE", () => {
  const code = migrationSql.replace(/--[^\n]*/g, "");
  assert.ok(!/\bDROP\b/i.test(code), "contains DROP");
  assert.ok(!/\bALTER\s+COLUMN\b/i.test(code), "contains ALTER COLUMN");
  assert.ok(!/\bRENAME\b/i.test(code), "contains RENAME");
  assert.ok(!/\bTRUNCATE\b/i.test(code), "contains TRUNCATE");
  assert.ok(!/\bDELETE\s+FROM\b/i.test(code), "contains DELETE FROM");
  assert.ok(!/\bUPDATE\s+"/i.test(code), "contains UPDATE");
});

test("ALTER TABLE touches only Transaction (ADD COLUMN IF NOT EXISTS) and the three new tables (FK constraints)", () => {
  const alters = [...migrationSql.matchAll(/ALTER TABLE\s+"(\w+)"\s*([\s\S]*?);/g)].map((m) => ({ table: m[1], rest: m[2].replace(/\s+/g, " ").trim() }));
  assert.ok(alters.length >= 1, "no ALTER TABLE found");
  for (const a of alters) {
    if (a.table === "Transaction") {
      assert.ok(/^ADD COLUMN IF NOT EXISTS "purpose" TEXT$/.test(a.rest), `Transaction ALTER is not the purpose column: ${a.rest}`);
    } else {
      assert.ok(TABLES.includes(a.table), `ALTER on a pre-existing table: ${a.table}`);
      assert.ok(/^ADD CONSTRAINT "\w+" FOREIGN KEY/.test(a.rest), `${a.table}: only FK constraints may be ALTERed in: ${a.rest}`);
    }
  }
});

test("every CREATE TABLE / INDEX is IF NOT EXISTS, and FKs are guarded by pg_constraint lookups (re-runnable)", () => {
  const creates = [...migrationSql.matchAll(/CREATE (?:UNIQUE )?(?:TABLE|INDEX)\b[^\n]*/g)].map((m) => m[0]);
  assert.ok(creates.length >= 3 + 1, "too few CREATE statements");
  for (const c of creates) assert.ok(/IF NOT EXISTS/.test(c), `not idempotent: ${c}`);
  const fkAdds = [...migrationSql.matchAll(/ADD CONSTRAINT "(\w+)"\s+FOREIGN KEY/g)].map((m) => m[1]);
  const guards = [...migrationSql.matchAll(/conname = '(\w+)'/g)].map((m) => m[1]);
  assert.deepStrictEqual(fkAdds.sort(), guards.sort(), "each FK add must be guarded by a lookup of the SAME name");
});

test("unique and index names follow Prisma's <Table>_<cols>_key / _idx convention and match the schema exactly", () => {
  const found = new Map();
  for (const m of migrationSql.matchAll(/CREATE (UNIQUE )?INDEX IF NOT EXISTS "(\w+)"\s+ON "(\w+)"\s*\(([^)]*)\)/g)) {
    const [, unique, name, table, colsRaw] = m;
    const cols = colsRaw.split(",").map((c) => c.trim().replace(/"/g, ""));
    const expected = `${table}_${cols.join("_")}_${unique ? "key" : "idx"}`;
    assert.strictEqual(name, expected, `index "${name}" should be "${expected}"`);
    assert.ok(TABLES.includes(table), `index on an unexpected table ${table}`);
    found.set(name, { table, unique: !!unique });
  }
  const expected = new Map();
  for (const table of TABLES) {
    const body = modelBody(table);
    // [ \t]+ not \s+: \s crosses newlines and would pair one line's field with the next line's @unique.
    for (const m of body.matchAll(/^[ \t]+(\w+)[ \t]+\S+[ \t]+[^\n]*@unique/gm)) expected.set(`${table}_${m[1]}_key`, { table, unique: true });
    for (const m of body.matchAll(/@@unique\(\[([^\]]+)\]\)/g)) expected.set(`${table}_${m[1].split(",").map((s) => s.trim()).join("_")}_key`, { table, unique: true });
    for (const m of body.matchAll(/@@index\(\[([^\]]+)\]\)/g)) expected.set(`${table}_${m[1].split(",").map((s) => s.trim()).join("_")}_idx`, { table, unique: false });
  }
  const missing = [...expected.keys()].filter((k) => !found.has(k));
  const extra = [...found.keys()].filter((k) => !expected.has(k));
  assert.deepStrictEqual(missing, [], `schema indexes with no migration index: ${missing}`);
  assert.deepStrictEqual(extra, [], `migration indexes not in the schema: ${extra}`);
  for (const [k, v] of expected) assert.strictEqual(found.get(k).unique, v.unique, `${k}: uniqueness differs`);
});

test("FK names follow <Table>_<col>_fkey and cover every @relation in the three models, with ON DELETE CASCADE", () => {
  const expected = [];
  for (const table of TABLES) {
    for (const m of modelBody(table).matchAll(/@relation\(fields:\s*\[(\w+)\],\s*references:\s*\[id\](?:,\s*onDelete:\s*(\w+))?/g)) {
      expected.push({ name: `${table}_${m[1]}_fkey`, cascade: m[2] === "Cascade" });
    }
  }
  assert.ok(expected.length >= 4, `expected at least 4 relations, parsed ${expected.length}`);
  for (const e of expected) {
    const re = new RegExp(`ADD CONSTRAINT "${e.name}"\\s+FOREIGN KEY \\("\\w+"\\) REFERENCES "\\w+"\\("id"\\)\\s+ON DELETE (\\w+)`);
    const m = migrationSql.match(re);
    assert.ok(m, `FK ${e.name} missing from the migration`);
    assert.strictEqual(m[1] === "CASCADE", e.cascade, `${e.name}: onDelete differs between schema and migration`);
  }
  const fkCount = countOf(migrationSql, "FOREIGN KEY");
  assert.strictEqual(fkCount, expected.length, `migration has ${fkCount} FKs, schema has ${expected.length} relations`);
});

test("the money-critical uniques exist in the model (a retry can never send or book twice)", () => {
  const mv = modelBody("SavingsMovement");
  assert.ok(/^\s+reference\s+String\s+@unique/m.test(mv), "SavingsMovement.reference not @unique");
  assert.ok(/^\s+pvTxnId\s+String\?\s+@unique/m.test(mv), "SavingsMovement.pvTxnId not @unique");
  assert.ok(/^\s+transactionId\s+String\?\s+@unique/m.test(mv), "SavingsMovement.transactionId not @unique");
  assert.ok(/^\s+landedTransactionId\s+String\?\s+@unique/m.test(mv), "SavingsMovement.landedTransactionId not @unique");
  assert.ok(/^\s+pvWalletId\s+String\?\s+@unique/m.test(modelBody("SavingsPot")), "SavingsPot.pvWalletId not @unique");
  assert.ok(/^\s+businessId\s+String\s+@unique/m.test(modelBody("SavingsProfile")), "SavingsProfile.businessId not @unique");
});

// ══ 12. REPORTING EXCLUDES SAVINGS, THE LEDGER KEEPS THEM ═════════════════
section("12. savings rows are left out of reports and kept in the ledger, AML windows and the staff cap");

test("moneySources exports the exclusion and isSavingsRow recognises only the four purposes", () => {
  assert.deepStrictEqual(moneySources.NOT_SAVINGS, { purpose: null });
  assert.strictEqual(moneySources.SQL_NOT_SAVINGS, 'AND "purpose" IS NULL');
  assert.deepStrictEqual([...moneySources.SAVINGS_PURPOSES], ["savings_deposit", "savings_withdrawal", "savings_interest", "savings_fee"]);
  assert.strictEqual(moneySources.isSavingsRow({ purpose: "savings_deposit" }), true);
  assert.strictEqual(moneySources.isSavingsRow({ purpose: "savings_withdrawal" }), true);
  assert.strictEqual(moneySources.isSavingsRow({ purpose: "savings_interest" }), true);
  assert.strictEqual(moneySources.isSavingsRow({ purpose: "savings_fee" }), true);
  assert.strictEqual(moneySources.isSavingsRow({ purpose: null }), false);
  assert.strictEqual(moneySources.isSavingsRow({ purpose: "refund" }), false);
  assert.strictEqual(moneySources.isSavingsRow({}), false);
  assert.strictEqual(moneySources.isSavingsRow(null), false);
  assert.ok(Object.isFrozen(moneySources.NOT_SAVINGS), "NOT_SAVINGS must be frozen (it is spread into many where clauses)");
});

const hasExclusion = (text) => /NOT_SAVINGS/.test(text) || /purpose:\s*null/.test(text);
const REPORTING = [
  { file: "src/utils/insightsEngine.js", minPrisma: 6, minRaw: 1 },
  { file: "src/utils/monthlyReport.js", minPrisma: 4, minRaw: 0 },
  { file: "src/routes/admin.js", minPrisma: 2, minRaw: 0 },
  { file: "src/utils/snapshots.js", minPrisma: 1, minRaw: 0 },
];
for (const { file, minPrisma, minRaw } of REPORTING) {
  test(`${file}: every income/expense money aggregate over prisma.transaction carries NOT_SAVINGS`, () => {
    const src = read(file);
    // Money aggregates: sums and row lists that feed a figure. A `count` of
    // outbound transfers (snapshots.js ops telemetry) is not a money figure and
    // a savings deposit IS a real transfer, so counts are not in scope here.
    const calls = transactionCalls(src).filter((c) => c.method !== "count" && /type:\s*"(income|expense)"/.test(c.arg));
    assert.ok(calls.length >= minPrisma, `expected at least ${minPrisma} income/expense aggregates, found ${calls.length}`);
    const bad = calls.filter((c) => !hasExclusion(c.arg));
    assert.deepStrictEqual(bad.map((c) => `line ${c.line} (${c.method})`), [], "aggregates without the savings exclusion");
    // Raw SQL over "Transaction" with a type predicate.
    const raws = [...src.matchAll(/\$queryRaw`[\s\S]*?`/g)].map((m) => m[0]).filter((q) => /"Transaction"/.test(q) && /type\s*=\s*'(income|expense)'/.test(q));
    assert.ok(raws.length >= minRaw, `expected at least ${minRaw} raw income/expense SQL, found ${raws.length}`);
    for (const q of raws) assert.ok(/"purpose" IS NULL/.test(q), `raw SQL lacks "purpose" IS NULL:\n${q.slice(0, 300)}`);
  });
}

test("dailyReport.js: the per-type groupBy over prisma.transaction carries NOT_SAVINGS", () => {
  const src = read("src/utils/dailyReport.js");
  const calls = transactionCalls(src).filter((c) => c.method === "groupBy");
  assert.ok(calls.length >= 1, "no prisma.transaction.groupBy in dailyReport");
  for (const c of calls) assert.ok(hasExclusion(c.arg), `dailyReport groupBy at line ${c.line} lacks NOT_SAVINGS`);
});

test("monthlyReport.js: the partial-match remainder predicate also excludes savings rows", () => {
  const src = read("src/utils/monthlyReport.js");
  const rem = fnBody(src, "const remainderWhere = (type, date) => ({");
  assert.ok(/NOT_SAVINGS/.test(rem), "remainderWhere lacks NOT_SAVINGS");
});

test("insightsEngine.js: the balance intent reports spendable and names the reserve", () => {
  const src = read("src/utils/insightsEngine.js");
  assert.ok(/getReservedBalance\(business\.id\)/.test(src), "balance intent does not read the reserve");
  assert.ok(/netSpendable\(bal, reserved\)/.test(src), "balance intent does not compute spendable");
  assert.ok(/savingsReserved: reserved/.test(src), "balance intent does not expose savingsReserved");
});

for (const file of ["src/utils/ledgerBalance.js", "src/utils/amlChecks.js", "src/utils/staffTransferCap.js"]) {
  test(`${file}: keeps savings rows (no NOT_SAVINGS, no purpose predicate)`, () => {
    const src = read(file);
    assert.ok(!/NOT_SAVINGS|SQL_NOT_SAVINGS|isSavingsRow/.test(src), `${file} imports the savings exclusion`);
    assert.ok(!/purpose\s*:/.test(src), `${file} filters on purpose`);
    assert.ok(!/"purpose" IS/.test(src), `${file} filters on purpose in SQL`);
    const calls = transactionCalls(src).filter((c) => /type:\s*"(income|expense)"/.test(c.arg));
    assert.ok(calls.length >= 1, `${file}: expected at least one income/expense query`);
  });
}

test("ledgerReconcile.js (if present) keeps savings rows too", () => {
  const p = path.join(SRC, "utils", "ledgerReconcile.js");
  if (!fs.existsSync(p)) return;
  assert.ok(!/NOT_SAVINGS|purpose/.test(fs.readFileSync(p, "utf8")), "ledgerReconcile filters on purpose");
});

// ══ 13. THE SPEND GATE ═════════════════════════════════════════════════════
section("13. executeTransfer refuses to spend what is set aside, and stamps savings debits");

const et = read("src/utils/executeTransfer.js");

test("the gate subtracts the reserve: getReservedBalance + netSpendable feed the INSUFFICIENT_BALANCE check", () => {
  const gateIdx = et.indexOf('err.code = "INSUFFICIENT_BALANCE"');
  assert.ok(gateIdx > 0, "no INSUFFICIENT_BALANCE gate");
  const before = et.slice(Math.max(0, gateIdx - 1500), gateIdx);
  assert.ok(/getReservedBalance\(business\.id\)/.test(before), "reserve not read before the gate");
  assert.ok(/const balance = netSpendable\(grossBalance, reserved\)/.test(before), "gate does not use netSpendable(gross, reserved)");
  assert.ok(/balance \+ MONEY_EPS < Number\(amount\) \+ totalCost/.test(before), "gate comparison changed");
  const after = et.slice(gateIdx, gateIdx + 300);
  assert.ok(/err\.reserved = reserved/.test(after), "INSUFFICIENT_BALANCE does not name the reserved amount");
  assert.ok(/^const \{ getReservedBalance, netSpendable \} = require\("\.\/savingsReserve"\);/m.test(et), "savingsReserve import");
});

test("savingsReserve never imports executeTransfer (it is imported BY it)", () => {
  const src = read("src/utils/savingsReserve.js");
  assert.ok(!/require\(["'][^"']*executeTransfer/.test(src), "savingsReserve imports executeTransfer: circular");
  assert.ok(/backing: "ledger", status: "active"/.test(src), "reserve must sum only ACTIVE LEDGER pots");
});

test("the Transaction row stores providerTxnId (Anchor transfer id) and purpose", () => {
  const createIdx = et.indexOf("prisma.transaction.create(");
  const create = callArg(et, createIdx + "prisma.transaction.create".length);
  assert.ok(/providerTxnId:\s*providerTransferId/.test(create), "create does not store providerTxnId from providerTransferId");
  assert.ok(/purpose:\s*purpose/.test(create), "create does not store purpose");
  assert.ok(/providerTransferId = nip\?\.transferId/.test(et), "NIP transfer id is not captured");
  assert.ok(/providerTransferId = book\?\.transferId/.test(et), "book transfer id is not captured");
  assert.ok(/return \{ reference: ref, route, transactionId: txn\.id, transaction: txn, fee, providerTransferId \}/.test(et), "return does not carry providerTransferId");
});

test("only savings_deposit is an accepted purpose, and it skips the internal-route lookup", () => {
  assert.ok(/if \(purpose && purpose !== "savings_deposit"\)/.test(et), "unknown purposes are not refused");
  assert.ok(/err\.code = "BAD_PURPOSE"/.test(et));
  assert.ok(/const internalDest = purpose === "savings_deposit" \? null : await prisma\.business\.findFirst/.test(et), "savings deposits must not book-route on a NUBAN collision");
});

test("a plain send to one of the business's own pot accounts is refused BEFORE idempotency, routing and the bank", () => {
  const guard = et.indexOf('err.code = "SAVINGS_DEST_USE_DEPOSIT"');
  assert.ok(guard > 0, "no SAVINGS_DEST_USE_DEPOSIT guard");
  const guardCall = et.lastIndexOf("prisma.savingsPot.findFirst", guard);
  assert.ok(guardCall > 0 && guardCall < guard);
  const guardArg = callArg(et, et.indexOf("(", guardCall));
  assert.ok(/pvAccountNumber: String\(accountNumber\)/.test(guardArg), "guard must key on pvAccountNumber");
  assert.ok(/businessId: business\.id/.test(guardArg), "guard must be scoped to THIS business");
  assert.ok(/status: \{ not: "closed" \}/.test(guardArg), "guard must skip closed pots");
  assert.ok(/if \(!purpose && accountNumber\)/.test(et), "guard must apply only to sends WITHOUT a purpose");
  assert.ok(guard < et.indexOf('route: "idempotent_skip"'), "guard must run before the idempotency short-circuit");
  assert.ok(guard < et.indexOf("const internalDest"), "guard must run before route detection");
  assert.ok(guard < et.indexOf("anchor.getAccountBalance"), "guard must run before any Anchor call");
});

// ══ 14. INBOUND CREDITS: CLASSIFY BEFORE BOOKING ═══════════════════════════
section("14. both credit writers ask savingsCredit BEFORE prisma.transaction.create");

test("routes/anchor.js: classification precedes the repair block and the credit create; savings rows skip the matchers", () => {
  const src = read("src/routes/anchor.js");
  const classify = src.indexOf("classifyInboundCredit(biz, { amount, sender, narration })");
  assert.ok(classify > 0, "webhook credit path does not call classifyInboundCredit");
  const repair = src.indexOf('description: { contains: "Anonymous sender" }');
  assert.ok(repair > 0 && classify < repair, "classification must precede the reconcile-repair block");
  const creates = [...src.matchAll(/prisma\.transaction\.create\(/g)].map((m) => m.index);
  const creditCreate = creates.find((i) => /purpose: "savings_withdrawal"/.test(callArg(src, i + "prisma.transaction.create".length)));
  assert.ok(creditCreate !== undefined, "no credit create stamps purpose savings_withdrawal");
  assert.ok(classify < creditCreate, "classification must precede the credit create");
  const between = src.slice(classify, creditCreate);
  assert.ok(!/withBusinessLock\(biz\.id, async \(\) => \{[\s\S]*classifyInboundCredit/.test(src.slice(0, classify + 100)), "classification must run outside the lock");
  // The repair stamps purpose only when the poller's row is still untouched:
  // a row a matcher already paid an invoice or a debt with is left alone and
  // a human is alerted (SAVINGS_LANDING_CONFLICT).
  assert.ok(/tagSavings \? \{ purpose: "savings_withdrawal" \}/.test(between), "the repair update must stamp purpose (when safe)");
  assert.ok(/matchedSaleId \|\| full\?\.matchedCustomerId \|\| full\?\.matchedExpenseId \|\| invoicePaid/.test(between), "the repair must check for a prior match before re-tagging");
  assert.ok(/SAVINGS_LANDING_CONFLICT/.test(between), "a conflicting repair must be audited");
  // After the create: the savings branch returns before push-as-payment and the matchers.
  const savingsBranch = src.indexOf("if (isSavings) {", creditCreate);
  const matchers = src.indexOf("tryMatchInvoice(biz, amount", creditCreate);
  const emailIdx = src.indexOf("sendTransactionEmail", creditCreate);
  assert.ok(savingsBranch > 0 && matchers > 0 && savingsBranch < matchers, "savings branch must come before the invoice matcher");
  assert.ok(savingsBranch < emailIdx, "savings branch must come before the credit email");
  const branch = src.slice(savingsBranch, matchers);
  assert.ok(/markLanded\(\{ movementId: savingsHit\.movementId, transactionId: createdRow\.id, amount \}\)/.test(branch), "savings branch must markLanded");
  assert.ok(/balanceCache"\)\.adjustBalance\(biz\.id/.test(branch), "savings branch must still adjust the balance cache");
  assert.ok(/\n\s+return;\n\s+\}/.test(branch), "savings branch must return before the payment treatment");
  // The repaired path lands the movement too.
  assert.ok(/markLanded\(\{ movementId: savingsHit\.movementId, transactionId: repaired\.id, amount \}\)/.test(src), "repair path must markLanded");
});

test("utils/anchorReconcile.js: classification precedes the create; savings rows get no compliance flag, push-as-payment or matcher", () => {
  const src = read("src/utils/anchorReconcile.js");
  const classify = src.indexOf("classifyInboundCredit(biz, { amount, sender, narration })");
  const create = src.indexOf("prisma.transaction.create(");
  assert.ok(classify > 0, "poller does not call classifyInboundCredit");
  assert.ok(create > 0 && classify < create, "classification must precede prisma.transaction.create");
  assert.strictEqual(countOf(src, "prisma.transaction.create("), 1, "the poller should have exactly one credit create");
  const createArg = callArg(src, create + "prisma.transaction.create".length);
  assert.ok(/isSavings \? \{ purpose: "savings_withdrawal" \}/.test(createArg), "create must stamp purpose");
  // The ComplianceFlag row is written BEFORE the savings branch: a held or
  // flagged savings landing must carry the flag the admin queue resolves it
  // through, or it would stay held forever. The branch then returns before
  // the push-as-payment and the matchers.
  const branch = src.indexOf("if (isSavings) {", create);
  const flag = src.indexOf("complianceFlag.create", create);
  const push = src.indexOf("buildInboundNotification({", create);
  const matcher = src.indexOf("tryMatchInvoice(biz, amount", create);
  assert.ok(branch > 0 && flag > 0 && flag < branch, "the compliance flag must be written before the savings branch");
  assert.ok(push > 0 && matcher > 0 && branch < push && branch < matcher, "savings branch must return before the payment push and the matchers");
  const b = src.slice(branch, push);
  assert.ok(/markLanded\(/.test(b) && /adjustBalance\(biz\.id/.test(b) && /continue;/.test(b), "savings branch must markLanded, adjust the cache and continue");
  // An unattributed credit equal to an open withdrawal keeps the matchers off.
  assert.ok(/possible_savings_landing/.test(src) && /if \(!maybeSavings\) await tryMatchInvoice/.test(src), "possible savings landings must skip the invoice matcher");
});

test("savingsCredit: markLanded is guarded on landedTransactionId null; candidates are un-landed PV withdrawals only", () => {
  const src = read("src/utils/savingsCredit.js");
  const landed = fnBody(src, "async function markLanded(");
  assert.ok(/where: \{ id: movementId, landedTransactionId: null \}/.test(landed), "markLanded is not a guarded claim");
  assert.ok(!/status:/.test(landed), "markLanded must not change status (verify does)");
  const load = fnBody(src, "async function loadCandidates(");
  assert.ok(/type: "withdrawal"/.test(load) && /backing: "piggyvest"/.test(load) && /landedTransactionId: null/.test(load), "loadCandidates filter");
  // Open withdrawals always; completed-but-unlanded ones only for a week, so a
  // single missed landing cannot make every later same-amount credit ambiguous.
  assert.ok(/status: \{ in: \["processing", "unknown"\] \}/.test(load), "processing|unknown candidates");
  assert.ok(/status: "completed", createdAt: \{ gte: weekAgo \}/.test(load), "completed candidates age out after a week");
  const wrap = fnBody(src, "async function classifyInboundCredit(");
  assert.ok(/catch \(e\)/.test(wrap) && /return \{ purpose: null \}/.test(wrap), "classifyInboundCredit must never throw (a credit must still book)");
});

// ══ 15. THE SERVICE'S CLAIMS ═══════════════════════════════════════════════
section("15. state changes are guarded claims; the partner is never called twice for one reference");

const sv = read("src/utils/savings.js");

test("withdrawFromPot: the requested → processing claim precedes transferToBank, inside the business lock, after assertNotFrozen", () => {
  const body = fnBody(sv, "async function withdrawFromPot(");
  mustPrecede(body, "prisma.withBusinessLock(biz.id", "await assertNotFrozen(biz)", "withdraw");
  mustPrecede(body, "await assertNotFrozen(biz)", "piggyvest.transferToBank(", "withdraw");
  mustPrecede(body, 'where: { id: movement.id, status: "requested" }, data: { status: "processing" }', "piggyvest.transferToBank(", "withdraw");
  assert.ok(/if \(claim\.count !== 1\) throw new SavingsError/.test(body), "the claim count is not checked");
  assert.strictEqual(countOf(body, "piggyvest.transferToBank("), 1, "transferToBank must be called exactly once");
  mustPrecede(body, "WITHDRAWAL_IN_FLIGHT", "piggyvest.transferToBank(", "withdraw");
  assert.ok(/status: \{ in: \["requested", "processing", "unknown"\] \}/.test(body), "in-flight guard set");
  mustPrecede(body, "lockAllows(fresh", "piggyvest.transferToBank(", "withdraw");
  mustPrecede(body, "INTEREST_FORFEIT_CONFIRM", "piggyvest.transferToBank(", "withdraw");
  assert.ok(/resolvePayoutTarget\(biz\)/.test(body), "payout target must be the merchant's own verified NUBAN");
  // After the POST: a timeout/5xx parks the row as unknown, never re-sends.
  const after = body.slice(body.indexOf("piggyvest.transferToBank("));
  assert.ok(/status: "unknown"/.test(after), "a mid-flight failure must park the row as unknown");
  assert.ok(/\[400, 401, 403, 404, 422\]\.includes\(Number\(e\.status\)\)/.test(after), "only definite 4xx fail the row");
  assert.ok(!/status: "completed"/.test(after), "withdrawFromPot must never mark completed itself");
});

test("depositToPot: the movement row exists before executeTransfer, inside the lock, after assertNotFrozen and the AML checks", () => {
  const body = fnBody(sv, "async function depositToPot(");
  mustPrecede(body, "prisma.withBusinessLock(biz.id", "await assertNotFrozen(biz)", "deposit");
  mustPrecede(body, "await assertNotFrozen(biz)", "executeTransfer({", "deposit");
  mustPrecede(body, "await runChecks()", "prisma.savingsMovement.create(", "deposit (PV)");
  const pv = body.slice(body.indexOf("// PiggyVest: a real NIP transfer"));
  mustPrecede(pv, "prisma.savingsMovement.create(", "executeTransfer({", "deposit (PV)");
  assert.ok(/status: "initiated", reference,/.test(pv), "PV deposit row is created as initiated with the reference");
  assert.ok(/purpose: "savings_deposit"/.test(pv), "executeTransfer must be called with purpose savings_deposit");
  assert.ok(/reference,\s*\n?\s*amlCheck/.test(pv) || /reference,/.test(pv), "the movement reference must be the transfer reference");
  assert.strictEqual(countOf(body, "executeTransfer({"), 1, "executeTransfer must be called exactly once");
  // Idempotency: existing reference returns the row, never re-sends.
  mustPrecede(body, "prisma.savingsMovement.findUnique({ where: { reference } })", "executeTransfer({", "deposit");
  assert.ok(/return replayOutcome\(existing, amt, fresh\)/.test(body), "replay must go through replayOutcome");
  // replayOutcome: a failed row answers with the ORIGINAL refusal, a different
  // amount under the same key is a client bug, an in-flight row replays.
  const ro = fnBody(sv, "function replayOutcome(");
  assert.ok(/IDEMPOTENCY_MISMATCH/.test(ro) && /existing\.status === "failed"/.test(ro) && /replay: true/.test(ro), "replayOutcome contract");
  // The `sent` write is a guarded claim so a webhook/reconcile settlement in
  // flight is never dragged back to sent.
  assert.ok(/where: \{ id: movement\.id, status: \{ in: \["initiated", "unknown"\] \} \},\s*data: \{\s*status: "sent"/.test(body), "sent must be a guarded claim");
  // Outcome handling: pre-Anchor → failed, else unknown.
  const after = body.slice(body.indexOf("executeTransfer({"));
  mustPrecede(after, "if (isPreAnchorError(e))", 'status: "unknown"', "deposit outcome");
  assert.ok(/where: \{ id: movement\.id, status: "initiated" \},\s*data: \{ status: "failed"/.test(after), "failed claim guarded on initiated");
  assert.ok(/where: \{ id: movement\.id, status: "initiated" \},\s*data: \{ status: "unknown"/.test(after), "unknown claim guarded on initiated");
});

test("ledger deposit and withdrawal are single guarded updateMany claims inside $transaction, with the balance gate", () => {
  const dbody = fnBody(sv, "async function depositToPot(");
  const ledgerDep = dbody.slice(dbody.indexOf('if (fresh.backing === "ledger")'), dbody.indexOf("// PiggyVest: a real NIP transfer"));
  assert.ok(/getSpendableBalance\(biz\)/.test(ledgerDep), "ledger deposit must read the live spendable balance");
  assert.ok(/BALANCE_UNAVAILABLE/.test(ledgerDep), "ledger deposit must fail closed when the bank is unreachable");
  assert.ok(/live\.spendable \+ MONEY_EPS < amt/.test(ledgerDep), "ledger deposit must refuse beyond spendable");
  assert.ok(/where: \{ id: fresh\.id, status: "active", backing: "ledger" \},\s*data: \{ balance: \{ increment: amt \} \}/.test(ledgerDep), "ledger deposit claim");
  assert.ok(/if \(claim\.count !== 1\) throw/.test(ledgerDep), "ledger deposit claim count check");
  assert.ok(/prisma\.\$transaction\(async \(px\)/.test(ledgerDep), "ledger deposit must be one $transaction");
  const wbody = fnBody(sv, "async function withdrawFromPot(");
  const ledgerW = wbody.slice(wbody.indexOf('if (fresh.backing === "ledger")'), wbody.indexOf("// PiggyVest."));
  assert.ok(/status: "active", backing: "ledger", balance: \{ gte: amt - MONEY_EPS \}/.test(ledgerW), "ledger withdrawal claim must require balance >= amount");
  assert.ok(/balance: \{ decrement: amt \}/.test(ledgerW), "ledger withdrawal decrements");
  assert.ok(/if \(claim\.count !== 1\) throw/.test(ledgerW), "ledger withdrawal claim count check");
});

test("SAVINGS_ENABLED gates creation and deposits only", () => {
  assert.ok(/if \(!isEnabled\(\)\) throw/.test(fnBody(sv, "async function createPot(")), "createPot not gated");
  assert.ok(/if \(!isEnabled\(\)\) throw/.test(fnBody(sv, "async function depositToPot(")), "depositToPot not gated");
  assert.ok(!/isEnabled\(\)/.test(fnBody(sv, "async function withdrawFromPot(")), "withdrawals must work with the switch off");
  assert.ok(!/isEnabled\(\)/.test(fnBody(sv, "async function closePot(")), "closing must work with the switch off");
  assert.ok(!/isEnabled\(\)/.test(read("src/utils/savingsReconcile.js")), "the reconcile loop must run with the switch off");
  assert.ok(!/isEnabled\(\)|SAVINGS_ENABLED/.test(read("src/utils/savingsReserve.js")), "the reserve must apply with the switch off");
  const prev = process.env.SAVINGS_ENABLED;
  delete process.env.SAVINGS_ENABLED;
  assert.strictEqual(savings.isEnabled(), false);
  process.env.SAVINGS_ENABLED = "true";
  assert.strictEqual(savings.isEnabled(), true);
  process.env.SAVINGS_ENABLED = "1";
  assert.strictEqual(savings.isEnabled(), false, "only the literal 'true' enables");
  if (prev === undefined) delete process.env.SAVINGS_ENABLED; else process.env.SAVINGS_ENABLED = prev;
});

test("applyWithdrawalOutcome claims only from processing|unknown and resets the miss streak on a terminal state", () => {
  const body = fnBody(sv, "async function applyWithdrawalOutcome(");
  assert.ok(/where: \{ id: movement\.id, status: \{ in: \["processing", "unknown"\] \} \},\s*data: \{\s*status: decision\.next/.test(body), "terminal claim not guarded");
  assert.ok(/if \(r\.count !== 1\) return null/.test(body), "terminal claim count not checked");
  assert.ok(/verifyMisses: 0/.test(body), "terminal state must reset misses");
});

test("createPot (PiggyVest): the pot row is written provisioning with no wallet id BEFORE createSubAccount, and createSubAccount is called once", () => {
  const body = fnBody(sv, "async function createPot(");
  mustPrecede(body, 'status: "provisioning"', "piggyvest.createSubAccount(", "createPot");
  assert.strictEqual(countOf(body, "piggyvest.createSubAccount("), 1);
  mustPrecede(body, "ensureProfile(biz, user)", "piggyvest.createSubAccount(", "createPot");
  assert.ok(/status: "provisioning", \.\.\.lock \}/.test(body), "PV pot row must be created as provisioning");
  const after = body.slice(body.indexOf("piggyvest.createSubAccount("));
  assert.ok(!/status: "active"/.test(after), "createPot must not activate a PV pot itself (activatePot does, after the funding account resolves)");
});

test("activatePot fails closed to error when the wallet bank cannot be mapped to an Anchor code", () => {
  const body = fnBody(sv, "async function activatePot(");
  assert.ok(/anchor\.getBanks\(\)/.test(body) && /matchBankCode\(banks, acct\.bankName\)/.test(body), "must map via Anchor's bank list");
  const noCode = body.slice(body.indexOf("if (!code) {"), body.indexOf("if (!code) {") + 400);
  assert.ok(/status: "error"/.test(noCode), "unmapped bank must set error");
  assert.ok(/where: \{ id: pot\.id, status: "provisioning" \}/.test(body), "activation is a guarded claim on provisioning");
});

test("ensureProfile: KYC tier, email, phone and BVN gates before the partner call; BVN is never logged", () => {
  const body = fnBody(sv, "async function ensureProfile(");
  mustPrecede(body, "resolveBusinessLimits(biz)", "piggyvest.createCustomer(", "ensureProfile");
  mustPrecede(body, "!user?.email || !user?.phone", "piggyvest.createCustomer(", "ensureProfile");
  mustPrecede(body, "decrypt(biz.kycBvn)", "piggyvest.createCustomer(", "ensureProfile");
  assert.ok(!/console\.\w+\([^)]*bvn/i.test(body), "BVN must not be logged");
  assert.ok(!/metadata: \{[^}]*bvn/i.test(body), "BVN must not be audited");
  assert.ok(/thirdPartyId: user\.id/.test(body), "third_party_identifier must be our user id");
  assert.ok(/returnIfExist=true/.test(fnBody(read("src/services/piggyvest.js"), "async function createCustomer(")), "createCustomer must be idempotent by returnIfExist");
});

// ══ 16. THE PARTNER CLIENT ═════════════════════════════════════════════════
section("16. PiggyVest POSTs that move money or create wallets are single-attempt");

test("transferToBank uses attempts: 1", () => {
  const src = read("src/services/piggyvest.js");
  const body = fnBody(src, "async function transferToBank(");
  assert.ok(/attempts:\s*1\b/.test(body), "transferToBank is not single-attempt");
  assert.ok(/method:\s*"POST"/.test(body));
});

test("createSubAccount uses attempts: 1", () => {
  const src = read("src/services/piggyvest.js");
  const body = fnBody(src, "async function createSubAccount(");
  assert.ok(/attempts:\s*1\b/.test(body), "createSubAccount is not single-attempt");
});

test("pvbFetch defaults to one attempt and only retries transient failures; a 200 with status:false is a failure", () => {
  const src = read("src/services/piggyvest.js");
  assert.ok(/attempts = 1/.test(fnBody(src, "async function pvbFetch(")), "pvbFetch must default to attempts = 1");
  assert.ok(/if \(attempt === attempts \|\| !isTransient\(err\)\) throw err/.test(src), "non-transient errors must not be retried");
  assert.ok(/!res\.ok \|\| data\?\.status === false/.test(src), "envelope status:false must be a failure");
  assert.strictEqual(piggyvest.isTransient({ status: 500 }), true);
  assert.strictEqual(piggyvest.isTransient({ status: 429 }), true);
  assert.strictEqual(piggyvest.isTransient({ status: 400 }), false);
  assert.strictEqual(piggyvest.isTransient({ status: 404 }), false);
  assert.strictEqual(piggyvest.isTransient({ code: "ETIMEDOUT" }), true);
  assert.strictEqual(piggyvest.isTransient(new Error("fetch failed")), true);
  assert.strictEqual(piggyvest.isTransient(new Error("boom")), false);
});

test("a timeout surfaces as ETIMEDOUT (unknown), not as 'not sent'", () => {
  const src = read("src/services/piggyvest.js");
  assert.ok(/e\?\.name === "AbortError"[\s\S]{0,300}err\.code = "ETIMEDOUT"/.test(src), "AbortError must map to ETIMEDOUT");
});

test("testFunding refuses in production", () => {
  const src = read("src/services/piggyvest.js");
  assert.ok(/NODE_ENV === "production"[\s\S]{0,200}PVB_TEST_ONLY/.test(fnBody(src, "async function testFunding(")));
});

// ══ 17. THE ROUTE ══════════════════════════════════════════════════════════
section("17. owner only, PIN before money, AML inside the lock, OTP whitelist");

const rt = read("src/routes/savings.js");

test("router is auth + requireUnfrozen + ownerOnly for every endpoint", () => {
  const head = rt.slice(0, rt.indexOf('router.get("/"'));
  assert.ok(/router\.use\(auth\);/.test(head), "auth middleware");
  assert.ok(/router\.use\(requireUnfrozen\);/.test(head), "requireUnfrozen middleware");
  assert.ok(/router\.use\(ownerOnly\(/.test(head), "ownerOnly middleware");
});

test("deposit: checkPin precedes depositToPot", () => {
  const body = handlerBody(rt, "post", "/pots/:id/deposit");
  mustPrecede(body, "await checkPin(req, res)", "savings.depositToPot(", "deposit route");
  assert.ok(/if \(!\(await checkPin\(req, res\)\)\) return;/.test(body), "a failed PIN must stop the handler");
});

test("withdraw: checkPin precedes withdrawFromPot", () => {
  const body = handlerBody(rt, "post", "/pots/:id/withdraw");
  mustPrecede(body, "await checkPin(req, res)", "savings.withdrawFromPot(", "withdraw route");
  assert.ok(/if \(!\(await checkPin\(req, res\)\)\) return;/.test(body), "a failed PIN must stop the handler");
  assert.ok(/confirmEarly: confirmEarly === true/.test(body) && /acceptInterestForfeit: acceptInterestForfeit === true/.test(body), "confirmations must be strict booleans");
});

test("checkPin audits PIN_FAILED and uses verifyTransactionPin", () => {
  const body = fnBody(rt, "async function checkPin(");
  assert.ok(/verifyTransactionPin\(req\.user\.id, req\.body\?\.pin\)/.test(body));
  assert.ok(/action: "PIN_FAILED"/.test(body));
});

test("deposit: the AML pipeline runs through runChecks (inside the lock) with the OTP_REQUIRED whitelist", () => {
  const body = handlerBody(rt, "post", "/pots/:id/deposit");
  assert.ok(/runPreTransferChecks\(\{ req, user: owner, business: biz, amount: Number\(amount\), otp \}\)/.test(body), "runPreTransferChecks call");
  assert.ok(/amlCheck\.code === "OTP_REQUIRED" && amlCheck\.otpTarget/.test(body), "OTP dispatch on OTP_REQUIRED");
  assert.ok(/dispatchOtp\(amlCheck\.otpTarget, TRANSFER_OTP_TYPE/.test(body), "dispatchOtp with the transfer OTP type");
  // Whitelist: the response body carries otpIdentifier (masked) and never otpTarget.
  const outcome = body.slice(body.indexOf("body: { error: amlCheck.error"), body.indexOf("body: { error: amlCheck.error") + 200);
  assert.ok(/otpIdentifier/.test(outcome), "OTP outcome must carry otpIdentifier");
  assert.ok(!/otpTarget/.test(outcome), "OTP outcome must NOT leak otpTarget");
  assert.ok(!/\.\.\.amlCheck/.test(body), "amlCheck must never be spread into a response");
  // The service runs runChecks inside withBusinessLock, before the movement row.
  const svc = fnBody(sv, "async function depositToPot(");
  mustPrecede(svc, "prisma.withBusinessLock(biz.id", "await runChecks()", "service");
  mustPrecede(svc, "await runChecks()", "prisma.savingsMovement.create(", "service");
});

test("the route never exposes the funding account of a pot that is not active, nor the BVN", () => {
  assert.ok(!/kycBvn|bvn/i.test(rt), "route file must not touch the BVN");
  const pub = fnBody(sv, "function publicPot(");
  assert.ok(/pot\.backing === "piggyvest" && pot\.status === "active" && pot\.pvAccountNumber/.test(pub), "fundingAccount only on active PV pots");
});

// ══ 18. WIRING ═════════════════════════════════════════════════════════════
section("18. loop, heartbeat, delete guard, match guard, server mounts");

test('withCronLock(4014) / SAVINGS_RECONCILE_LOCK = 4014 appears exactly once, and 4014 is not another loop\'s key', () => {
  const rec = read("src/utils/savingsReconcile.js");
  assert.strictEqual(countOf(rec, "SAVINGS_RECONCILE_LOCK = 4014"), 1, "SAVINGS_RECONCILE_LOCK = 4014 must appear once");
  assert.ok(/withCronLock\(SAVINGS_RECONCILE_LOCK,/.test(rec), "the loop must take the cron lock");
  const others = ["server.js", ...fs.readdirSync(path.join(SRC, "utils")).map((f) => `src/utils/${f}`)].filter((f) => f !== "src/utils/savingsReconcile.js" && f.endsWith(".js"));
  // Code only: server.js mentions 4014 in a comment next to the loop start.
  for (const f of others) assert.ok(!/\.withCronLock\(\s*4014/.test(read(f)), `${f} also locks 4014`);
  assert.strictEqual(countOf(read("server.js").replace(/\/\/[^\n]*/g, ""), "4014"), 0, "server.js code must not use 4014 itself");
  assert.ok(/recordHeartbeat\("savings-reconcile", "ok"\)/.test(rec), "heartbeat on success");
  assert.ok(/fireAlert\("savings-pvb-auth"/.test(rec), "auth failures must alert");
});

test('healthCheck.js knows the "savings-reconcile" heartbeat', () => {
  assert.ok(/"savings-reconcile":\s*\d+/.test(read("src/utils/healthCheck.js")));
});

test("routes/auth.js: the delete-account guard refuses while a pot holds money or a movement is in flight", () => {
  const src = read("src/routes/auth.js");
  assert.ok(/prisma\.savingsPot\.findFirst\(\{ where: \{ businessId: \{ in: bizIds \}, status: \{ not: "closed" \}, balance: \{ gt: 0\.004 \} \}/.test(src), "pot balance guard");
  assert.ok(/prisma\.savingsMovement\.count\(\{ where: \{ businessId: \{ in: bizIds \}, status: \{ in: \["initiated", "sent", "requested", "processing", "unknown", "needs_review"\] \} \}/.test(src), "in-flight movement guard");
  assert.ok(/code: "SAVINGS_REMAINING"/.test(src), "SAVINGS_REMAINING code");
  assert.ok(/savings: process\.env\.SAVINGS_ENABLED === "true"/.test(src), "features.savings");
  assert.ok(/savingsInterest: process\.env\.SAVINGS_ENABLED === "true" && !!process\.env\.PVB_SECRET_KEY/.test(src), "features.savingsInterest");
});

test("routes/transactions.js: both match loaders refuse savings rows", () => {
  const src = read("src/routes/transactions.js");
  for (const fn of ["loadMatchableCredit", "loadMatchableDebit"]) {
    const body = fnBody(src, `async function ${fn}(`);
    assert.ok(/if \(isSavingsRow\(tx\)\)/.test(body), `${fn} does not check isSavingsRow`);
    assert.ok(/SAVINGS_ROW_NOT_MATCHABLE/.test(body), `${fn} does not answer SAVINGS_ROW_NOT_MATCHABLE`);
    assert.ok(/status\(409\)/.test(body.slice(body.indexOf("isSavingsRow(tx)"), body.indexOf("isSavingsRow(tx)") + 200)), `${fn}: savings rows must be 409`);
  }
  assert.ok(/isSavingsRow\s*\}\s*=\s*require\("\.\.\/config\/moneySources"\)/.test(src), "isSavingsRow must come from moneySources");
});

test("server.js: /webhooks/piggyvest is mounted with express.raw BEFORE express.json; /savings is mounted behind apiLimiter; the loop is started", () => {
  const src = read("server.js");
  const mount = src.indexOf('"/webhooks/piggyvest"');
  const json = src.indexOf("app.use(express.json(");
  assert.ok(mount > 0, "webhook not mounted");
  assert.ok(json > 0 && mount < json, "webhook must be mounted before express.json");
  const block = src.slice(src.lastIndexOf("app.use(", mount), src.indexOf(");", mount));
  assert.ok(/express\.raw\(/.test(block), "webhook mount lacks express.raw");
  assert.ok(/webhookLimiter/.test(block), "webhook mount lacks webhookLimiter");
  assert.ok(/piggyvestWebhook/.test(block), "webhook mount does not use routes/piggyvestWebhook");
  assert.ok(/app\.use\("\/savings", apiLimiter\)/.test(src), "/savings must be rate limited");
  assert.ok(/app\.use\("\/savings", require\("\.\/src\/routes\/savings"\)\)/.test(src), "/savings router not mounted");
  assert.ok(/startSavingsReconcileLoop\(/.test(src), "reconcile loop not started");
  assert.ok(src.indexOf('app.use("/savings", apiLimiter)') < src.indexOf('app.use("/savings", require('), "limiter must precede the router");
});

test("validateEnv.js refuses a foreign PVB host and a disabled webhook check in production", () => {
  const src = read("src/utils/validateEnv.js");
  assert.ok(/api\.piggyvest\.business/.test(src), "live host check");
  assert.ok(/PVB_VERIFY_WEBHOOK === "false"/.test(src), "webhook bypass check");
});

test("balance readers report spendable and expose gross + reserved", () => {
  const tr = read("src/routes/transfers.js");
  assert.ok(/getSpendableBalance\(biz\)/.test(tr) && /balance: spendable, grossBalance: gross, savingsReserved: reserved/.test(tr), "transfers balance route");
  const bz = read("src/routes/businesses.js");
  assert.ok(/balance: netSpendable\(gross, reserved\), grossBalance: gross, savingsReserved: reserved/.test(bz), "businesses balance route");
  const sr = read("src/utils/salaryRunner.js");
  assert.ok(/getSpendableBalance\(biz\)\)\.spendable/.test(sr), "salary runner must pay from spendable");
});

// ══ 19. BREAKING A FLEXIBLE LOCK ═══════════════════════════════════════════
section("19. breaking a flexible lock costs 2%, at least ₦100, never more than the amount, and is swept once");

const fees = require("../src/config/fees");

test("2% of the amount, to the kobo", () => {
  process.env.ANCHOR_FEE_ACCOUNT_ID = process.env.ANCHOR_FEE_ACCOUNT_ID || "fee-acct-test";
  delete process.env.SAVINGS_BREAK_FEE_BPS; delete process.env.SAVINGS_BREAK_FEE_MIN;
  assert.strictEqual(fees.computeBreakFee(100_000).fee, 2_000);
  assert.strictEqual(fees.computeBreakFee(12_345.67).fee, 246.91);
  assert.strictEqual(fees.computeBreakFee(50_000).bps, 200);
});

test("floored at ₦100, capped at the amount itself", () => {
  assert.strictEqual(fees.computeBreakFee(1_000).fee, 100);
  assert.strictEqual(fees.computeBreakFee(4_999).fee, 100);
  assert.strictEqual(fees.computeBreakFee(5_000).fee, 100);
  assert.strictEqual(fees.computeBreakFee(5_050).fee, 101);
  assert.strictEqual(fees.computeBreakFee(60).fee, 60, "a ₦60 withdrawal cannot cost ₦100");
  assert.strictEqual(fees.computeBreakFee(0).fee, 0);
  assert.strictEqual(fees.computeBreakFee(-5).fee, 0);
});

test("the numbers come from env, within sane bounds", () => {
  process.env.SAVINGS_BREAK_FEE_BPS = "300"; process.env.SAVINGS_BREAK_FEE_MIN = "50";
  assert.strictEqual(fees.computeBreakFee(10_000).fee, 300);
  assert.strictEqual(fees.computeBreakFee(1_000).fee, 50);
  process.env.SAVINGS_BREAK_FEE_BPS = "5000"; // 50%: a typo, not a policy
  assert.strictEqual(fees.computeBreakFee(10_000).bps, 200);
  process.env.SAVINGS_BREAK_FEE_BPS = "0";
  assert.strictEqual(fees.computeBreakFee(10_000).fee, 0, "0 bps switches the fee off");
  assert.strictEqual(fees.computeBreakFee(10_000).enabled, false);
  delete process.env.SAVINGS_BREAK_FEE_BPS; delete process.env.SAVINGS_BREAK_FEE_MIN;
});

test("no fee account, no fee: a charge nothing can collect is never made", () => {
  const prev = process.env.ANCHOR_FEE_ACCOUNT_ID;
  delete process.env.ANCHOR_FEE_ACCOUNT_ID;
  assert.strictEqual(fees.computeBreakFee(100_000).fee, 0);
  assert.strictEqual(fees.computeBreakFee(100_000).enabled, false);
  process.env.ANCHOR_FEE_ACCOUNT_ID = prev;
});

test("collectBreakFee claims feeCollectedAt BEFORE the book transfer, books a savings_fee row, and never retries by itself", () => {
  const body = fnBody(sv, "async function collectBreakFee(");
  mustPrecede(body, "where: { id: mv.id, feeCollectedAt: null }, data: { feeCollectedAt: new Date() }", "anchor.createBookTransfer(", "break fee");
  assert.ok(/if \(claim\.count !== 1\) return false/.test(body), "the claim count is checked");
  assert.ok(/purpose: "savings_fee"/.test(body), "the fee row carries purpose savings_fee");
  assert.ok(/category: "transfer"/.test(body) && /type: "expense"/.test(body), "the fee row is a bank expense the ledger counts");
  assert.ok(/mv\.backing === "piggyvest" && !mv\.landedTransactionId\) return false/.test(body), "a PiggyVest fee waits for the landing");
  assert.ok(/SAVINGS_BREAK_FEE_FAILED/.test(body) && !/feeCollectedAt: null \}/.test(body.slice(body.indexOf("catch (e)"))), "a failed sweep alerts and stays claimed");
  assert.strictEqual(countOf(body, "anchor.createBookTransfer("), 1);
});

test("the fee is charged on early withdrawals only, carried in the confirmation, and swept from the landing", () => {
  const w = fnBody(sv, "async function withdrawFromPot(");
  assert.ok(/const fee = lock\.early \? breakFee\.fee : 0/.test(w), "fee only when the lock is broken early");
  assert.ok(/\{ lockUntil: fresh\.lockUntil, fee: breakFee\.fee, feeBps: breakFee\.bps \}/.test(w), "EARLY_WITHDRAWAL_CONFIRM carries the fee");
  assert.ok(/if \(fee > 0\) \{\s*await collectBreakFee\(result\.movement\.id\)/.test(w), "ledger withdrawal sweeps at once");
  const credit = read("src/utils/savingsCredit.js");
  assert.ok(/require\("\.\/savings"\)\.collectBreakFee\(movementId\)/.test(fnBody(credit, "async function markLanded(")), "markLanded sweeps the fee");
  const rec = read("src/utils/savingsReconcile.js");
  assert.ok(/feeCollectedAt: null/.test(rec) && /savings\.collectBreakFee\(m\.id\)/.test(rec), "the reconcile loop is the backstop");
});

test("savings_fee is a savings purpose on both sides, so reports skip it and the ledger keeps it", () => {
  assert.ok(moneySources.SAVINGS_PURPOSES.includes("savings_fee"));
  assert.ok(moneySources.isSavingsRow({ purpose: "savings_fee" }));
  const client = fs.readFileSync(path.join(ROOT, "..", "src", "utils", "matchedCredit.js"), "utf8");
  assert.ok(/"savings_fee"/.test(client), "the app's SAVINGS_PURPOSES must list savings_fee");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
