// Savings (ledger pots): the pure parts, plus structural guards. No network, no DB.
//   node scripts/savings-test.js
//
// A pot moves no money. Its balance is a reserve that executeTransfer subtracts
// in its balance gate; deposits and withdrawals are single atomic writes under
// the business lock; an Unbreakable pot (lockMode "strict") never opens before
// its day, and taking money out of a Breakable one ("flexible") early costs a
// fee that is swept to KashBook's fee account and booked as a Transaction with
// purpose "savings_fee", a Bank Fees and Charges expense in the books. A pot
// opens at 00:00 Lagos time on its day. What CAN be pinned here is everything
// a wrong answer would silently mis-book: the reserve arithmetic behind the
// spend gate, the opening moment, lock semantics, the break-fee schedule, the
// idempotent replay, the deletion refusal, which rows raw aggregates skip and
// the ledger keeps; and, read from the source as text, that the guards sit in
// the order the design names, that the migration matches the schema, that
// only the savings service writes pots, that no admin path can open one, and
// that nothing of the removed PiggyVest integration is left.
//
// The money paths themselves (deposit, withdraw, the fee sweep, the reconcile
// loop) need Postgres and Anchor and live in scripts/savings-e2e-test.js.
const assert = require("assert");
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
// The few tests that must await (a stubbed bank call) run last, in order.
const asyncTests = [];
const testAsync = (name, fn) => asyncTests.push([name, fn]);
function section(t) { console.log(`\n── ${t} ${"─".repeat(Math.max(0, 56 - t.length))}`); }

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "src");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const savings = require("../src/utils/savings");
const { netSpendable } = require("../src/utils/savingsReserve");
const fees = require("../src/config/fees");
const { MONEY_EPS } = fees;
const moneySources = require("../src/config/moneySources");
// The service, as text, for the structural checks below.
const sv = read("src/utils/savings.js");

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
// Every source-like file under a directory, recursively.
function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (ent.isFile() && /\.(js|cjs|mjs|json|sql|prisma|md|html)$/.test(ent.name)) out.push(p);
  }
  return out;
}
// Lines of `text` (1-based) matching `re`, for a readable failure.
const linesMatching = (text, re) => text.split("\n").map((l, i) => (re.test(l) ? i + 1 : 0)).filter(Boolean);

const T0 = new Date("2026-09-29T12:00:00Z");
const future = new Date(T0.getTime() + 30 * 86400000);
const past = new Date(T0.getTime() - 86400000);

// ══ 1. THE RESERVE ═════════════════════════════════════════════════════════
section("1. spendable = gross − reserved, floored, rounded to the kobo");

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

test("numeric strings (a Decimal serialised by the bank client) are read as numbers", () => {
  assert.strictEqual(netSpendable("1000.50", "250.25"), 750.25);
});

// ══ 2. LOCKS ═══════════════════════════════════════════════════════════════
section("2. an Unbreakable (strict) lock is server-enforced, a Breakable (flexible) one asks");

test("no lock → allowed", () => {
  assert.deepStrictEqual(savings.lockAllows({ lockUntil: null, lockMode: null }, { now: T0 }), { ok: true });
  assert.deepStrictEqual(savings.lockAllows({}, { now: T0 }), { ok: true });
  assert.deepStrictEqual(savings.lockAllows(null, { now: T0 }), { ok: true });
  assert.deepStrictEqual(savings.lockAllows(undefined, { now: T0 }), { ok: true });
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
  assert.strictEqual(savings.lockAllows({ lockUntil: future, lockMode: "strict" }, { now: T0 }).code, "POT_LOCKED");
});

test("flexible + future without confirmation → EARLY_WITHDRAWAL_CONFIRM, with the date", () => {
  const r = savings.lockAllows({ lockUntil: future, lockMode: "flexible" }, { now: T0 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, "EARLY_WITHDRAWAL_CONFIRM");
  assert.strictEqual(r.until.getTime(), future.getTime());
});

test("flexible + future with confirmation → allowed and marked early", () => {
  assert.deepStrictEqual(savings.lockAllows({ lockUntil: future, lockMode: "flexible" }, { now: T0, confirmEarly: true }), { ok: true, early: true });
});

test("a lock with a date but no mode behaves as flexible (never silently strict)", () => {
  assert.strictEqual(savings.lockAllows({ lockUntil: future, lockMode: null }, { now: T0 }).code, "EARLY_WITHDRAWAL_CONFIRM");
  assert.deepStrictEqual(savings.lockAllows({ lockUntil: future }, { now: T0, confirmEarly: true }), { ok: true, early: true });
});

test("lockUntil as an ISO string works the same", () => {
  assert.strictEqual(savings.lockAllows({ lockUntil: future.toISOString(), lockMode: "strict" }, { now: T0 }).code, "POT_LOCKED");
  assert.deepStrictEqual(savings.lockAllows({ lockUntil: past.toISOString(), lockMode: "strict" }, { now: T0 }), { ok: true });
});

test("lockAllows trusts its caller (any truthy confirmEarly consents), so the ROUTE must coerce to a strict boolean", () => {
  // Pinned on purpose: the helper treats the string "false" as consent, which
  // is only safe because the route passes `confirmEarly === true` (section 12).
  assert.strictEqual(savings.lockAllows({ lockUntil: future, lockMode: "flexible" }, { now: T0, confirmEarly: "false" }).ok, true);
  assert.ok(/confirmEarly: confirmEarly === true/.test(read("src/routes/savings.js")), "the route must coerce confirmEarly");
});

test("an Unbreakable pot is shut until its very moment and open at it, whoever asks", () => {
  const opens = new Date("2027-03-14T23:00:00.000Z"); // 00:00 Lagos on 15 Mar 2027
  const pot = { lockUntil: opens, lockMode: "strict" };
  for (const confirmEarly of [false, true, "yes", 1]) {
    const r = savings.lockAllows(pot, { now: new Date(opens.getTime() - 1), confirmEarly });
    assert.strictEqual(r.code, "POT_LOCKED", `1 ms before, confirmEarly=${JSON.stringify(confirmEarly)}`);
  }
  assert.deepStrictEqual(savings.lockAllows(pot, { now: opens }), { ok: true }, "at the moment it opens");
  assert.deepStrictEqual(savings.lockAllows(pot, { now: new Date(opens.getTime() + 1) }), { ok: true });
});

// ══ 2b. THE OPENING MOMENT ═════════════════════════════════════════════════
section("2b. a pot opens at 00:00 Lagos time on its day, never earlier than asked");

const iso = (d) => (d instanceof Date ? d.toISOString() : d);

test("a bare day opens at 00:00 Lagos on that day (23:00 UTC the day before)", () => {
  assert.strictEqual(iso(savings.lockOpensAt("2027-03-15")), "2027-03-14T23:00:00.000Z");
  assert.strictEqual(iso(savings.lockOpensAt("2027-01-01")), "2026-12-31T23:00:00.000Z", "across a year end");
  assert.strictEqual(iso(savings.lockOpensAt("2028-02-29")), "2028-02-28T23:00:00.000Z", "a real leap day");
  assert.strictEqual(iso(savings.lockOpensAt(" 2027-03-15 ")), "2027-03-14T23:00:00.000Z", "surrounding spaces are ignored");
});

test("a timestamp moves up to the next Lagos midnight at or after it", () => {
  assert.strictEqual(iso(savings.lockOpensAt("2027-03-14T23:00:00.000Z")), "2027-03-14T23:00:00.000Z", "a Lagos midnight stays");
  assert.strictEqual(iso(savings.lockOpensAt("2027-03-14T23:00:00.001Z")), "2027-03-15T23:00:00.000Z", "a millisecond later is the next day");
  // The old app sent 23:59:59 local for "locked until 15 Mar": that pot now
  // opens at the start of 16 Mar, never before the day the merchant chose.
  assert.strictEqual(iso(savings.lockOpensAt("2027-03-15T22:59:59.000Z")), "2027-03-15T23:00:00.000Z");
  assert.strictEqual(iso(savings.lockOpensAt("2027-03-15T00:00:00.000Z")), "2027-03-15T23:00:00.000Z", "UTC midnight is 01:00 in Lagos");
  assert.strictEqual(iso(savings.lockOpensAt("2027-03-15T12:30:00+01:00")), "2027-03-15T23:00:00.000Z");
});

test("a Date, an epoch number and an ISO string give the same moment", () => {
  const t = Date.parse("2027-03-15T10:00:00.000Z");
  const want = "2027-03-15T23:00:00.000Z";
  assert.strictEqual(iso(savings.lockOpensAt(new Date(t))), want);
  assert.strictEqual(iso(savings.lockOpensAt(t)), want);
  assert.strictEqual(iso(savings.lockOpensAt(new Date(t).toISOString())), want);
});

test("not a date → null: words, days the calendar lacks, other types", () => {
  for (const bad of ["next tuesday", "2026-02-30", "2027-02-29", "2026-13-01", "2026-04-31", "15/03/2027", "", null, undefined, {}, [], true, NaN, Infinity]) {
    assert.strictEqual(savings.lockOpensAt(bad), null, `lockOpensAt(${JSON.stringify(bad)})`);
  }
});

test("the result is always a Lagos midnight", () => {
  for (const input of ["2027-03-15", "2027-03-15T05:06:07Z", "2027-06-30T23:59:59.999+01:00", 1_800_000_123_456]) {
    const d = savings.lockOpensAt(input);
    assert.ok(d instanceof Date, `${input}`);
    assert.strictEqual(new Date(d.getTime() + 3600000).toISOString().slice(11), "00:00:00.000Z", `${input} → ${iso(d)}`);
  }
});

test("lagosDay and dayWords read an instant in Lagos time, the same on a UTC server", () => {
  const opens = new Date("2027-03-14T23:00:00.000Z");
  assert.strictEqual(savings.lagosDay(opens), "2027-03-15", "23:00 UTC is already the next day in Lagos");
  assert.strictEqual(savings.lagosDay("2027-03-14T22:59:59.999Z"), "2027-03-14");
  assert.strictEqual(savings.lagosDay(null), null);
  assert.strictEqual(savings.lagosDay("rubbish"), null);
  assert.strictEqual(savings.dayWords(opens), "15 Mar 2027");
  assert.strictEqual(savings.dayWords("2027-03-15"), "15 Mar 2027");
  assert.strictEqual(savings.dayWords(opens.toISOString()), "15 Mar 2027");
  assert.strictEqual(savings.dayWords("2031-01-01"), "1 Jan 2031");
  assert.strictEqual(savings.dayWords(null), "");
  // The bug this replaces: toLocaleDateString on a UTC server named the day
  // before ("14 Mar"), so a pot looked like it opened a day early.
  assert.ok(!/toLocaleDateString|toLocaleString/.test(sv), "savings.js words dates itself, never in the server's zone");
});

test("validateLock: the day must come after today (Lagos) and within five years of it", () => {
  const now = new Date("2026-10-15T10:00:00.000Z"); // 11:00 on 15 Oct 2026 in Lagos
  const ok = (lockUntil) => savings.validateLock({ lockUntil, lockMode: "strict" }, { now });
  const refused = (lockUntil, re) => assert.throws(() => ok(lockUntil), (e) => {
    assert.ok(e instanceof savings.SavingsError);
    assert.strictEqual(e.code, "BAD_LOCK");
    assert.strictEqual(e.status, 400);
    if (re) assert.ok(re.test(e.message), e.message);
    return true;
  }, `${lockUntil} must be refused`);
  refused("2026-10-15", /Pick a day after today/);
  refused("2026-10-14", /Pick a day after today/);
  refused("2026-10-15T09:00:00.000Z", /Pick a day after today/); // earlier today: opened at midnight
  assert.strictEqual(iso(ok("2026-10-16").lockUntil), "2026-10-15T23:00:00.000Z", "tomorrow");
  assert.strictEqual(iso(ok("2026-10-15T20:00:00.000Z").lockUntil), "2026-10-15T23:00:00.000Z", "later today moves to tomorrow");
  assert.strictEqual(iso(ok("2031-10-15").lockUntil), "2031-10-14T23:00:00.000Z", "the same date five years on is the latest");
  refused("2031-10-16", /within 5 years.*15 Oct 2031/);
  refused("2026-02-30", /not valid/);
  refused("someday", /not valid/);
  assert.strictEqual(iso(savings.latestOpening(now)), "2031-10-14T23:00:00.000Z");
  assert.strictEqual(savings.MAX_LOCK_YEARS, 5);
});

test("validateLock: just before midnight Lagos, tomorrow is still tomorrow", () => {
  const now = new Date("2026-10-15T22:59:59.000Z"); // 23:59:59 on 15 Oct in Lagos
  assert.strictEqual(iso(savings.validateLock({ lockUntil: "2026-10-16", lockMode: "flexible" }, { now }).lockUntil), "2026-10-15T23:00:00.000Z");
  const after = new Date("2026-10-15T23:00:00.000Z"); // 00:00 on 16 Oct in Lagos
  assert.throws(() => savings.validateLock({ lockUntil: "2026-10-16", lockMode: "flexible" }, { now: after }), /Pick a day after today/);
});

test("validateLock: the lock needs a mode, and no date means no lock", () => {
  const now = new Date("2026-10-15T10:00:00.000Z");
  assert.deepStrictEqual(savings.validateLock({ lockUntil: null, lockMode: "strict" }, { now }), { lockUntil: null, lockMode: null });
  assert.deepStrictEqual(savings.validateLock({}, { now }), { lockUntil: null, lockMode: null });
  for (const lockMode of [undefined, null, "forever", "STRICT", "unbreakable"]) {
    assert.throws(() => savings.validateLock({ lockUntil: "2027-01-01", lockMode }, { now }), (e) => e.code === "BAD_LOCK" && /Unbreakable or Breakable/.test(e.message), `mode ${lockMode}`);
  }
  assert.strictEqual(savings.validateLock({ lockUntil: "2027-01-01", lockMode: "flexible" }, { now }).lockMode, "flexible");
});

// ══ 3. BREAKING A FLEXIBLE LOCK ════════════════════════════════════════════
section("3. breaking a flexible lock costs 2%, at least ₦100, never more than the amount");

const withFeeEnv = (env, fn) => {
  const keys = ["ANCHOR_FEE_ACCOUNT_ID", "SAVINGS_BREAK_FEE_BPS", "SAVINGS_BREAK_FEE_MIN", "SAVINGS_DEPOSIT_FEE"];
  const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  Object.assign(process.env, env);
  try { fn(); }
  finally { for (const k of keys) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; } }
};
const FEE_ENV = { ANCHOR_FEE_ACCOUNT_ID: "fee-acct-test" };

test("2% of the amount, to the kobo", () => withFeeEnv(FEE_ENV, () => {
  assert.strictEqual(fees.computeBreakFee(100_000).fee, 2_000);
  assert.strictEqual(fees.computeBreakFee(12_345.67).fee, 246.91);
  assert.strictEqual(fees.computeBreakFee(50_000).bps, 200);
  assert.strictEqual(fees.computeBreakFee(50_000).enabled, true);
  assert.strictEqual(fees.computeBreakFee(1_000_000).fee, 20_000);
}));

test("exactly 2%, no minimum by default (owner, 2026-10-15), never more than the amount", () => withFeeEnv(FEE_ENV, () => {
  assert.strictEqual(fees.computeBreakFee(1_000).fee, 20, "the owner's example: ₦20 on ₦1,000");
  assert.strictEqual(fees.computeBreakFee(4_999).fee, 99.98);
  assert.strictEqual(fees.computeBreakFee(5_000).fee, 100);
  assert.strictEqual(fees.computeBreakFee(5_050).fee, 101);
  assert.strictEqual(fees.computeBreakFee(60).fee, 1.2);
  assert.strictEqual(fees.computeBreakFee(100).fee, 2);
  assert.strictEqual(fees.computeBreakFee(0.5).fee, 0.01);
  assert.strictEqual(fees.computeBreakFee(0.01).fee, 0, "2% of a kobo rounds to nothing");
  assert.strictEqual(fees.computeBreakFee(0).fee, 0);
  assert.strictEqual(fees.computeBreakFee(-5).fee, 0);
  assert.strictEqual(fees.computeBreakFee("abc").fee, 0);
  assert.strictEqual(fees.breakFeeConfig().min, 0);
}));

test("a minimum set in env still floors the fee, and is still capped at the amount", () => withFeeEnv({ ...FEE_ENV, SAVINGS_BREAK_FEE_MIN: "100" }, () => {
  assert.strictEqual(fees.computeBreakFee(1_000).fee, 100);
  assert.strictEqual(fees.computeBreakFee(5_050).fee, 101);
  assert.strictEqual(fees.computeBreakFee(60).fee, 60, "a ₦60 withdrawal cannot cost ₦100");
  assert.strictEqual(fees.computeBreakFee(0.01).fee, 0.01);
}));

test("the numbers come from env, within sane bounds", () => withFeeEnv({ ...FEE_ENV, SAVINGS_BREAK_FEE_BPS: "300", SAVINGS_BREAK_FEE_MIN: "50" }, () => {
  assert.strictEqual(fees.computeBreakFee(10_000).fee, 300);
  assert.strictEqual(fees.computeBreakFee(1_000).fee, 50);
  assert.deepStrictEqual(fees.breakFeeConfig(), { bps: 300, min: 50, enabled: true });
  process.env.SAVINGS_BREAK_FEE_BPS = "5000"; // 50%: a typo, not a policy
  assert.strictEqual(fees.computeBreakFee(10_000).bps, 200);
  process.env.SAVINGS_BREAK_FEE_BPS = "-1";
  assert.strictEqual(fees.computeBreakFee(10_000).bps, 200);
  process.env.SAVINGS_BREAK_FEE_BPS = "abc";
  assert.strictEqual(fees.computeBreakFee(10_000).bps, 200);
  process.env.SAVINGS_BREAK_FEE_MIN = "-5";
  assert.strictEqual(fees.breakFeeConfig().min, 0);
  process.env.SAVINGS_BREAK_FEE_MIN = "12.345";
  assert.strictEqual(fees.breakFeeConfig().min, 12.35, "the minimum is rounded to the kobo");
}));

test("0 bps switches the fee off", () => withFeeEnv({ ...FEE_ENV, SAVINGS_BREAK_FEE_BPS: "0" }, () => {
  assert.strictEqual(fees.computeBreakFee(10_000).fee, 0);
  assert.strictEqual(fees.computeBreakFee(10_000).enabled, false);
}));

test("no fee account, no fee: a charge nothing can collect is never made", () => withFeeEnv({}, () => {
  assert.strictEqual(fees.computeBreakFee(100_000).fee, 0);
  assert.strictEqual(fees.computeBreakFee(100_000).enabled, false);
  assert.strictEqual(fees.breakFeeConfig().enabled, false);
  assert.strictEqual(fees.breakFeeConfig().bps, 200, "the schedule is still reported, so the app can show it");
}));

test("the fee is always a 2-dp number (never a float artefact the ledger would carry)", () => withFeeEnv(FEE_ENV, () => {
  for (const amt of [0.29, 5000.01, 12_345.67, 99_999.99, 1.1, 333.33]) {
    const { fee } = fees.computeBreakFee(amt);
    assert.strictEqual(fee, Math.round(fee * 100) / 100, `fee for ${amt} is ${fee}`);
  }
}));

test("breakFeeView (what GET /savings tells the app): the schedule when charged, all zeros when not", () => {
  withFeeEnv(FEE_ENV, () => {
    assert.deepStrictEqual(savings.breakFeeView(), { enabled: true, bps: 200, pct: 2, min: 0 });
  });
  withFeeEnv({ ...FEE_ENV, SAVINGS_BREAK_FEE_BPS: "250", SAVINGS_BREAK_FEE_MIN: "50" }, () => {
    assert.deepStrictEqual(savings.breakFeeView(), { enabled: true, bps: 250, pct: 2.5, min: 50 });
  });
  const ZEROS = { enabled: false, bps: 0, pct: 0, min: 0 };
  withFeeEnv({}, () => assert.deepStrictEqual(savings.breakFeeView(), ZEROS, "no fee account: nothing is charged, so no rate and no minimum"));
  withFeeEnv({ ...FEE_ENV, SAVINGS_BREAK_FEE_BPS: "0" }, () => assert.deepStrictEqual(savings.breakFeeView(), ZEROS, "a rate of 0 is no fee"));
  // The view and the charge agree: whenever the view says free, the charge is 0.
  for (const env of [{}, { ...FEE_ENV, SAVINGS_BREAK_FEE_BPS: "0" }]) {
    withFeeEnv(env, () => assert.strictEqual(fees.computeBreakFee(50_000).fee, 0));
  }
});

test("the deposit fee: a flat ₦250 by default (owner, 2026-10-15), off without a fee account or at 0", () => {
  withFeeEnv(FEE_ENV, () => {
    assert.deepStrictEqual(fees.computeDepositFee(), { fee: 250, enabled: true });
    assert.deepStrictEqual(fees.depositFeeConfig(), { amount: 250, enabled: true });
    assert.deepStrictEqual(savings.depositFeeView(), { enabled: true, amount: 250 });
  });
  withFeeEnv({}, () => {
    assert.deepStrictEqual(fees.computeDepositFee(), { fee: 0, enabled: false }, "no fee account: nothing is charged");
    assert.deepStrictEqual(savings.depositFeeView(), { enabled: false, amount: 0 });
  });
  withFeeEnv({ ...FEE_ENV, SAVINGS_DEPOSIT_FEE: "0" }, () => {
    assert.deepStrictEqual(fees.computeDepositFee(), { fee: 0, enabled: false }, "0 turns it off");
    assert.deepStrictEqual(savings.depositFeeView(), { enabled: false, amount: 0 });
  });
  for (const [raw, want] of [["300", 300], ["99.999", 100], ["12.345", 12.35], ["", 250], ["  ", 250], ["abc", 250], ["-1", 250], ["200000", 250]]) {
    withFeeEnv({ ...FEE_ENV, SAVINGS_DEPOSIT_FEE: raw }, () => assert.strictEqual(fees.computeDepositFee().fee, want, `SAVINGS_DEPOSIT_FEE=${JSON.stringify(raw)}`));
  }
});

// ══ 4. IDEMPOTENT REPLAY ═══════════════════════════════════════════════════
section("4. a repeated request answers with the row it already made, never a second");

test("same amount → the existing movement, replay:true, same pot object", () => {
  const existing = { id: "m1", amount: 5000, type: "deposit", status: "completed" };
  const pot = { id: "p1", balance: 5000 };
  const r = savings.replayOutcome(existing, 5000, pot);
  assert.deepStrictEqual(r, { movement: existing, pot, replay: true });
  assert.strictEqual(r.movement, existing);
  assert.strictEqual(r.pot, pot);
});

test("amounts are compared in kobo (IEEE drift and numeric strings are the same money)", () => {
  const existing = { id: "m1", amount: 5000.01 };
  assert.strictEqual(savings.replayOutcome(existing, 5000.01, null).replay, true);
  assert.strictEqual(savings.replayOutcome(existing, "5000.01", null).replay, true);
  assert.strictEqual(savings.replayOutcome({ amount: 0.1 + 0.2 }, 0.3, null).replay, true);
});

test("a different amount under the same key → IDEMPOTENCY_MISMATCH 409 (a client bug, named)", () => {
  const existing = { id: "m1", amount: 5000 };
  assert.throws(() => savings.replayOutcome(existing, 5000.01, null), (e) => {
    assert.ok(e instanceof savings.SavingsError);
    assert.strictEqual(e.code, "IDEMPOTENCY_MISMATCH");
    assert.strictEqual(e.status, 409);
    return true;
  });
  assert.throws(() => savings.replayOutcome(existing, 4999.99, null), /already used for a different amount/);
});

test("SavingsError carries code, HTTP status and extras, and is a real Error", () => {
  const e = new savings.SavingsError("msg", "SOME_CODE", 423, { lockUntil: future, fee: 100 });
  assert.ok(e instanceof Error);
  assert.strictEqual(e.message, "msg");
  assert.strictEqual(e.code, "SOME_CODE");
  assert.strictEqual(e.status, 423);
  assert.strictEqual(e.lockUntil, future);
  assert.strictEqual(e.fee, 100);
  assert.strictEqual(new savings.SavingsError("m", "C").status, 400, "status defaults to 400");
});

// ══ 5. PURPOSES ════════════════════════════════════════════════════════════
section("5. savings_fee is the only savings purpose, on both sides");

test("moneySources: SAVINGS_PURPOSES === [\"savings_fee\"], frozen; NO_PURPOSE leaves out every purpose", () => {
  assert.deepStrictEqual([...moneySources.SAVINGS_PURPOSES], ["savings_fee"]);
  assert.ok(Object.isFrozen(moneySources.SAVINGS_PURPOSES), "SAVINGS_PURPOSES must be frozen");
  assert.deepStrictEqual(moneySources.NO_PURPOSE, { purpose: null });
  assert.ok(Object.isFrozen(moneySources.NO_PURPOSE), "NO_PURPOSE must be frozen (it is spread into many where clauses)");
  assert.strictEqual(moneySources.SQL_NO_PURPOSE, 'AND "purpose" IS NULL');
  // The old names said "savings" for a filter that drops every purpose.
  assert.ok(!("NOT_SAVINGS" in moneySources) && !("SQL_NOT_SAVINGS" in moneySources), "the old names are gone");
});

test("no file under src/ or server.js still says NOT_SAVINGS", () => {
  const hits = [];
  for (const f of [path.join(ROOT, "server.js"), ...walk(SRC)]) {
    for (const l of linesMatching(fs.readFileSync(f, "utf8"), /NOT_SAVINGS/)) hits.push(`${path.relative(ROOT, f).replace(/\\/g, "/")}:${l}`);
  }
  assert.deepStrictEqual(hits, [], `found in: ${hits.join(", ")}`);
});

test("the books count the break fee once, as a Bank Fees and Charges expense, in both views", () => {
  const books = require("../src/utils/books");
  const fee = { id: "t1", type: "expense", amount: 100, fee: 0, date: "2026-10-06", purpose: "savings_fee", source: "anchor", paymentMethod: "bank", category: "transfer" };
  for (const basis of ["paid", "sold"]) {
    const r = books.computeBooks({ bankRows: [fee] }, { from: "2026-10-01", to: "2026-10-31", basis });
    assert.strictEqual(r.expenses.lines.bankCharges.gross, 100, `${basis}: bankCharges`);
    assert.strictEqual(r.expenses.lines.bankCharges.count, 1, `${basis}: counted once`);
    assert.strictEqual(r.expenses.lines.bank.gross, 0, `${basis}: not also a plain bank expense`);
    assert.strictEqual(r.expenses.total, 100, `${basis}: expenses total`);
    assert.strictEqual(r.sales.total, 0, `${basis}: never income`);
  }
  // Raw sums of bank rows (bankCountedAmount) leave it out; the line above is
  // where it counts.
  assert.strictEqual(books.bankCountedAmount(fee), 0);
  assert.strictEqual(require("../src/utils/chart").PURPOSE_ACCOUNT.savings_fee, require("../src/utils/chart").SYS.BANK_CHARGES, "the ledger posts it to Bank Fees and Charges too");
});

test("isSavingsRow recognises savings_fee and nothing else", () => {
  assert.strictEqual(moneySources.isSavingsRow({ purpose: "savings_fee" }), true);
  for (const purpose of ["savings_deposit", "savings_withdrawal", "savings_interest", "refund", "", null, undefined, "SAVINGS_FEE"]) {
    assert.strictEqual(moneySources.isSavingsRow({ purpose }), false, `purpose=${JSON.stringify(purpose)}`);
  }
  assert.strictEqual(moneySources.isSavingsRow({}), false);
  assert.strictEqual(moneySources.isSavingsRow(null), false);
  assert.strictEqual(moneySources.isSavingsRow(undefined), false);
});

test("the app's matchedCredit.js lists exactly [\"savings_fee\"] and takes its bank-row amounts from the books rule", () => {
  const client = fs.readFileSync(path.join(ROOT, "..", "src", "utils", "matchedCredit.js"), "utf8");
  const m = client.match(/export const SAVINGS_PURPOSES\s*=\s*(\[[^\]]*\])/);
  assert.ok(m, "the app's matchedCredit.js must export SAVINGS_PURPOSES");
  assert.deepStrictEqual(JSON.parse(m[1].replace(/'/g, '"')), ["savings_fee"]);
  assert.ok(/export const isSavingsRow/.test(client), "the app must export isSavingsRow");
  // Since the books rule (2026-10-09) report sums go through books.computeBooks:
  // bankCountedAmount counts nothing for a row with any purpose, and the fee
  // counts once, on the Bank Fees and Charges line (section 5 above).
  assert.ok(/bankCountedAmount/.test(client), "the app's bank-row amounts must come from the books rule");
  const { bankCountedAmount } = require("../src/utils/books");
  assert.strictEqual(bankCountedAmount({ type: "expense", amount: 50, purpose: "savings_fee" }), 0, "a raw bank-row sum leaves the fee to its own line");
  assert.ok(!/savings_deposit|savings_withdrawal|savings_interest/.test(client), "the app must not know the dead purposes");
});

// ══ 6. THE SWITCH ══════════════════════════════════════════════════════════
section("6. SAVINGS_ENABLED gates creation and deposits only, on the literal \"true\"");

test("isEnabled only on the literal \"true\"", () => {
  const prev = process.env.SAVINGS_ENABLED;
  try {
    delete process.env.SAVINGS_ENABLED;
    assert.strictEqual(savings.isEnabled(), false);
    process.env.SAVINGS_ENABLED = "true";
    assert.strictEqual(savings.isEnabled(), true);
    for (const v of ["1", "TRUE", "True", "yes", "on", " true", "true ", ""]) {
      process.env.SAVINGS_ENABLED = v;
      assert.strictEqual(savings.isEnabled(), false, `SAVINGS_ENABLED=${JSON.stringify(v)} must not enable`);
    }
  } finally { if (prev === undefined) delete process.env.SAVINGS_ENABLED; else process.env.SAVINGS_ENABLED = prev; }
});

test("createPot and depositToPot are gated; withdrawals, closing, the reserve and the loop run with the switch off", () => {
  assert.ok(/if \(!isEnabled\(\)\) throw/.test(fnBody(sv, "async function createPot(")), "createPot not gated");
  assert.ok(/if \(!isEnabled\(\)\) throw/.test(fnBody(sv, "async function depositToPot(")), "depositToPot not gated");
  assert.ok(!/isEnabled\(\)/.test(fnBody(sv, "async function withdrawFromPot(")), "withdrawals must work with the switch off");
  assert.ok(!/isEnabled\(\)/.test(fnBody(sv, "async function closePot(")), "closing must work with the switch off");
  assert.ok(!/isEnabled\(\)/.test(fnBody(sv, "async function updatePot(")), "renaming or moving a lock later must work with the switch off");
  assert.ok(!/isEnabled\(\)/.test(fnBody(sv, "async function collectSavingsFee(")), "the fee sweep must run with the switch off");
  assert.ok(!/isEnabled\(\)/.test(fnBody(sv, "async function savingsBlockingDeletion(")), "the deletion guard must apply with the switch off");
  assert.ok(!/isEnabled\(\)|SAVINGS_ENABLED/.test(read("src/utils/savingsReconcile.js")), "the reconcile loop must run with the switch off");
  assert.ok(!/isEnabled\(\)|SAVINGS_ENABLED/.test(read("src/utils/savingsReserve.js")), "the reserve must apply with the switch off");
  assert.ok(!/isEnabled\(\)|SAVINGS_ENABLED/.test(read("src/utils/executeTransfer.js")), "the spend gate must apply with the switch off");
});

// ══ 7. VIEWS ═══════════════════════════════════════════════════════════════
section("7. what the app sees");

test("publicPot: locked follows lockUntil vs now, balance is a number, nothing internal leaks", () => {
  const base = { id: "p1", businessId: "b1", userId: "u1", name: "Rent", targetAmount: 100000, status: "active", balance: "2500.5", lockMode: "flexible", createdAt: T0, closedAt: null, updatedAt: T0 };
  const open = savings.publicPot({ ...base, lockUntil: new Date(Date.now() + 86400000) });
  assert.strictEqual(open.locked, true);
  assert.strictEqual(open.balance, 2500.5);
  assert.strictEqual(savings.publicPot({ ...base, lockUntil: new Date(Date.now() - 86400000) }).locked, false);
  assert.strictEqual(savings.publicPot({ ...base, lockUntil: null }).locked, false);
  assert.strictEqual(savings.publicPot({ ...base, balance: null }).balance, 0);
  assert.ok(!("userId" in open) && !("updatedAt" in open), "publicPot must not echo internal columns");
  assert.deepStrictEqual(Object.keys(open).sort(), ["balance", "businessId", "closedAt", "createdAt", "id", "lockMode", "lockUntil", "locked", "name", "status", "targetAmount"]);
  assert.strictEqual(savings.publicPot(null), null);
});

test("publicMovement: amount and fee are numbers, feeCollectedAt stays server-side", () => {
  const m = savings.publicMovement({ id: "m1", potId: "p1", businessId: "b1", userId: "u1", type: "withdrawal", amount: "5000", fee: "100", status: "completed", reference: "kb_svw_abc", createdAt: T0, completedAt: T0, feeCollectedAt: T0 });
  assert.strictEqual(m.amount, 5000);
  assert.strictEqual(m.fee, 100);
  assert.ok(!("feeCollectedAt" in m) && !("businessId" in m) && !("userId" in m));
  assert.deepStrictEqual(Object.keys(m).sort(), ["amount", "completedAt", "createdAt", "fee", "id", "potId", "reference", "status", "type"]);
  assert.strictEqual(savings.publicMovement({ id: "m2", amount: null, fee: undefined }).fee, 0);
  assert.strictEqual(savings.publicMovement(null), null);
});

test("reference prefixes are distinct and exported", () => {
  assert.strictEqual(savings.DEPOSIT_REF_PREFIX, "kb_sv_");
  assert.strictEqual(savings.WITHDRAWAL_REF_PREFIX, "kb_svw_");
  assert.ok(!savings.WITHDRAWAL_REF_PREFIX.startsWith(savings.DEPOSIT_REF_PREFIX) || savings.DEPOSIT_REF_PREFIX !== savings.WITHDRAWAL_REF_PREFIX);
  assert.ok(Number.isInteger(savings.MAX_POTS) && savings.MAX_POTS > 0);
});

// ══ 8. MIGRATION ↔ SCHEMA ══════════════════════════════════════════════════
section("8. the tables the code writes are the tables the migration creates");

const MIGRATION_DIR = path.join(ROOT, "prisma", "migrations", "20260929120000_savings");
const migrationSql = fs.readFileSync(path.join(MIGRATION_DIR, "migration.sql"), "utf8");
const schema = read("prisma/schema.prisma");
const TABLES = ["SavingsPot", "SavingsMovement"];
const SCALAR_TYPES = "String|Int|Float|DateTime|Boolean|Json";

function tableBody(table) {
  const head = `CREATE TABLE IF NOT EXISTS "${table}" (`;
  const open = migrationSql.indexOf(head);
  assert.ok(open >= 0, `CREATE TABLE IF NOT EXISTS "${table}" missing from the migration`);
  const close = migrationSql.indexOf(`CONSTRAINT "${table}_pkey"`, open);
  assert.ok(close > open, `${table}: no primary key constraint`);
  return migrationSql.slice(open + head.length, close);
}
function migrationColumns(table) {
  return new Map([...tableBody(table).matchAll(/^\s*"(\w+)"\s+([^,\n]+)/gm)].map((m) => [m[1], m[2].trim()]));
}
function modelBody(model) {
  const start = schema.indexOf(`model ${model} {`);
  assert.ok(start >= 0, `model ${model} missing from schema.prisma`);
  return schema.slice(start, schema.indexOf("\n}", start));
}
function modelFields(model) {
  // [ \t] not \s: \s crosses newlines, and a field with no attributes would
  // then swallow the NEXT line as its attribute text.
  return [...modelBody(model).matchAll(new RegExp(`^[ \\t]+(\\w+)[ \\t]+(${SCALAR_TYPES})(\\?|\\[\\])?(?:[ \\t]+([^\\n]*))?$`, "gm"))]
    .map((m) => ({ field: m[1], type: m[2], optional: m[3] === "?", list: m[3] === "[]", attrs: m[4] || "" }));
}

for (const table of TABLES) {
  test(`${table}: every Prisma field has a column, and every column a field`, () => {
    const cols = migrationColumns(table);
    const fields = modelFields(table);
    assert.ok(fields.length >= 5, `parsed too few fields for ${table}: ${fields.map((f) => f.field)}`);
    const missingCols = fields.filter((f) => !cols.has(f.field)).map((f) => f.field);
    const missingFields = [...cols.keys()].filter((c) => !fields.some((f) => f.field === c));
    assert.deepStrictEqual(missingCols, [], `fields with no column: ${missingCols}`);
    assert.deepStrictEqual(missingFields, [], `columns with no field: ${missingFields}`);
  });
}

test("column types, nullability and defaults agree with the model", () => {
  const sqlType = { String: "TEXT", Int: "INTEGER", Float: "DOUBLE PRECISION", DateTime: "TIMESTAMP(3)", Boolean: "BOOLEAN", Json: "JSONB" };
  for (const table of TABLES) {
    const cols = migrationColumns(table);
    for (const f of modelFields(table)) {
      const def = cols.get(f.field);
      assert.ok(def, `${table}.${f.field}: no column definition`);
      assert.ok(!f.list, `${table}.${f.field}: scalar lists are not expected here`);
      assert.ok(def.startsWith(sqlType[f.type]), `${table}.${f.field}: model ${f.type} but column "${def}"`);
      const notNull = /NOT NULL/.test(def);
      assert.strictEqual(notNull, !f.optional, `${table}.${f.field}: model ${f.optional ? "optional" : "required"} but column ${notNull ? "NOT NULL" : "nullable"}`);
      // @default("x") ↔ DEFAULT 'x'; @default(0) ↔ DEFAULT 0; @default(now()) ↔ DEFAULT CURRENT_TIMESTAMP.
      // @default(uuid()) and @updatedAt are Prisma-side and have no SQL default.
      const d = f.attrs.match(/@default\(("([^"]*)"|([\d.]+)|now\(\)|uuid\(\))\)/);
      const sqlDefault = def.match(/DEFAULT\s+('([^']*)'|([\d.]+)|CURRENT_TIMESTAMP)/);
      if (d && !/uuid\(\)/.test(d[0])) {
        assert.ok(sqlDefault, `${table}.${f.field}: model has ${d[0]} but the column has no DEFAULT`);
        if (d[2] !== undefined) assert.strictEqual(sqlDefault[2], d[2], `${table}.${f.field}: default differs`);
        else if (d[3] !== undefined) assert.strictEqual(Number(sqlDefault[3]), Number(d[3]), `${table}.${f.field}: default differs`);
        else assert.strictEqual(sqlDefault[1], "CURRENT_TIMESTAMP", `${table}.${f.field}: now() must be CURRENT_TIMESTAMP`);
      } else if (!d) {
        assert.ok(!sqlDefault, `${table}.${f.field}: column has ${sqlDefault && sqlDefault[0]} but the model has no @default`);
      }
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

test("the migration is additive: no DROP, no ALTER COLUMN, no RENAME, no TRUNCATE, no DELETE, no UPDATE", () => {
  const code = migrationSql.replace(/--[^\n]*/g, "");
  assert.ok(!/\bDROP\b/i.test(code), "contains DROP");
  assert.ok(!/\bALTER\s+COLUMN\b/i.test(code), "contains ALTER COLUMN");
  assert.ok(!/\bRENAME\b/i.test(code), "contains RENAME");
  assert.ok(!/\bTRUNCATE\b/i.test(code), "contains TRUNCATE");
  assert.ok(!/\bDELETE\s+FROM\b/i.test(code), "contains DELETE FROM");
  assert.ok(!/\bUPDATE\s+"/i.test(code), "contains UPDATE");
});

test("ALTER TABLE touches only Transaction (ADD COLUMN IF NOT EXISTS) and the two new tables (FK constraints)", () => {
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

test("exactly the two tables are created; SavingsProfile and every PiggyVest column are gone from migration and schema", () => {
  const created = [...migrationSql.matchAll(/CREATE TABLE IF NOT EXISTS "(\w+)"/g)].map((m) => m[1]);
  assert.deepStrictEqual(created.sort(), [...TABLES].sort());
  for (const text of [migrationSql, schema]) {
    assert.ok(!/SavingsProfile/.test(text), "SavingsProfile must not exist");
    assert.ok(!/pvWalletId|pvAccountNumber|pvTxnId|pvCustomerId|backing|landedTransactionId|verifyMisses|lastVerifiedAt|interestAccrued/.test(text), "a PiggyVest-era column survived");
  }
  assert.ok(!/model Savings(?!Pot|Movement)\w*/.test(schema), "only SavingsPot and SavingsMovement may exist");
  // The movement is lean: a deposit or withdrawal, already completed.
  const mvCols = [...migrationColumns("SavingsMovement").keys()].sort();
  assert.deepStrictEqual(mvCols, ["amount", "businessId", "completedAt", "createdAt", "fee", "feeCollectedAt", "id", "potId", "reference", "status", "type", "updatedAt", "userId"]);
  const potCols = [...migrationColumns("SavingsPot").keys()].sort();
  assert.deepStrictEqual(potCols, ["balance", "businessId", "closedAt", "createdAt", "id", "lockMode", "lockUntil", "name", "status", "targetAmount", "updatedAt", "userId"]);
});

test("every CREATE TABLE / INDEX is IF NOT EXISTS, and FKs are guarded by pg_constraint lookups (re-runnable)", () => {
  const creates = [...migrationSql.matchAll(/CREATE (?:UNIQUE )?(?:TABLE|INDEX)\b[^\n]*/g)].map((m) => m[0]);
  assert.ok(creates.length >= TABLES.length + 1, "too few CREATE statements");
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
  assert.ok(expected.size >= 4, `expected the reference unique plus three indexes, parsed ${expected.size}`);
});

test("FK names follow <Table>_<col>_fkey, point at the related model, cover every @relation, with ON DELETE CASCADE", () => {
  const expected = [];
  for (const table of TABLES) {
    for (const m of modelBody(table).matchAll(/^\s+(\w+)\s+(\w+)\s+@relation\(fields:\s*\[(\w+)\],\s*references:\s*\[id\](?:,\s*onDelete:\s*(\w+))?/gm)) {
      expected.push({ name: `${table}_${m[3]}_fkey`, refTable: m[2], cascade: m[4] === "Cascade" });
    }
  }
  assert.strictEqual(expected.length, 3, `expected 3 relations (pot→business, movement→pot, movement→business), parsed ${expected.length}`);
  for (const e of expected) {
    const re = new RegExp(`ADD CONSTRAINT "${e.name}"\\s+FOREIGN KEY \\("\\w+"\\) REFERENCES "(\\w+)"\\("id"\\)\\s+ON DELETE (\\w+)`);
    const m = migrationSql.match(re);
    assert.ok(m, `FK ${e.name} missing from the migration`);
    assert.strictEqual(m[1], e.refTable, `${e.name}: references "${m[1]}", schema says ${e.refTable}`);
    assert.strictEqual(m[2] === "CASCADE", e.cascade, `${e.name}: onDelete differs between schema and migration`);
    assert.ok(e.cascade, `${e.name}: a business delete must take its pots and movements with it (the routes refuse while money remains)`);
  }
  const fkCount = countOf(migrationSql, "FOREIGN KEY");
  assert.strictEqual(fkCount, expected.length, `migration has ${fkCount} FKs, schema has ${expected.length} relations`);
});

test("the money-critical unique exists: SavingsMovement.reference (a retried request can never book twice)", () => {
  const mv = modelBody("SavingsMovement");
  assert.ok(/^\s+reference\s+String\s+@unique/m.test(mv), "SavingsMovement.reference not @unique");
  assert.ok(/CREATE UNIQUE INDEX IF NOT EXISTS "SavingsMovement_reference_key"\s+ON "SavingsMovement" \("reference"\)/.test(migrationSql), "unique index on reference missing");
  assert.ok(/^\s+fee\s+Float\s+@default\(0\)/m.test(mv), "SavingsMovement.fee Float @default(0)");
  assert.ok(/^\s+feeCollectedAt\s+DateTime\?/m.test(mv), "SavingsMovement.feeCollectedAt DateTime?");
  assert.ok(/^\s+balance\s+Float\s+@default\(0\)/m.test(modelBody("SavingsPot")), "SavingsPot.balance Float @default(0)");
});

// ══ 9. RAW AGGREGATES SKIP PURPOSE ROWS, THE LEDGER KEEPS THEM ═══════════════════
section("9. purpose rows are left out of raw aggregates and kept in the ledger, AML windows and the staff cap");

const hasExclusion = (text) => /NO_PURPOSE/.test(text) || /purpose:\s*null/.test(text);
const REPORTING = [
  // Since 2026-10-12 every Insights money figure comes from the books rule
  // (totals, and the expense breakdowns by account through
  // spendingByAccount), which counts the fee on its own line (section 5).
  // None is required here any more; one that comes back must carry NO_PURPOSE.
  { file: "src/utils/insightsEngine.js", minPrisma: 0, minRaw: 0 },
  // The month's top expenses come from the books rule's rows since 2026-10-12
  // (insightsEngine.spendingByAccount); three bank aggregates remain.
  { file: "src/utils/monthlyReport.js", minPrisma: 3, minRaw: 0 },
  { file: "src/routes/admin.js", minPrisma: 2, minRaw: 0 },
  { file: "src/utils/snapshots.js", minPrisma: 1, minRaw: 0 },
];
for (const { file, minPrisma, minRaw } of REPORTING) {
  test(`${file}: every income/expense money aggregate over prisma.transaction carries NO_PURPOSE`, () => {
    const src = read(file);
    // Money aggregates: sums and row lists that feed a figure. A `count` of
    // outbound transfers (snapshots.js ops telemetry) is not a money figure,
    // so counts are not in scope here.
    const calls = transactionCalls(src).filter((c) => c.method !== "count" && /type:\s*"(income|expense)"/.test(c.arg));
    assert.ok(calls.length >= minPrisma, `expected at least ${minPrisma} income/expense aggregates, found ${calls.length}`);
    const bad = calls.filter((c) => !hasExclusion(c.arg));
    assert.deepStrictEqual(bad.map((c) => `line ${c.line} (${c.method})`), [], "aggregates without the purpose exclusion");
    // Raw SQL over "Transaction" with a type predicate.
    const raws = [...src.matchAll(/\$queryRaw`[\s\S]*?`/g)].map((m) => m[0]).filter((q) => /"Transaction"/.test(q) && /type\s*=\s*'(income|expense)'/.test(q));
    assert.ok(raws.length >= minRaw, `expected at least ${minRaw} raw income/expense SQL, found ${raws.length}`);
    for (const q of raws) assert.ok(/"purpose" IS NULL/.test(q), `raw SQL lacks "purpose" IS NULL:\n${q.slice(0, 300)}`);
  });
}

// Since 2026-10-09 the daily report totals through the books rule, which counts
// nothing for a bank row that carries a purpose (savings rows included): through
// booksFor, or (since 2026-10-12, to count the day's records from the same
// input) computeBooks over loadBooksInput, which is what booksFor does.
test("dailyReport.js: totals come from the books rule, and the books rule drops purpose rows", () => {
  const src = read("src/utils/dailyReport.js");
  assert.ok(/booksFor\(/.test(src) || (/computeBooks\(/.test(src) && /loadBooksInput\(/.test(src)), "dailyReport does not total through the books rule");
  assert.strictEqual(transactionCalls(src).length, 0, "dailyReport queries bank rows directly again");
  const { bankCountedAmount } = require("../src/utils/books");
  assert.strictEqual(bankCountedAmount({ type: "expense", amount: 100, purpose: "savings_fee" }), 0);
});

test("monthlyReport.js: the partial-match remainder predicate also excludes purpose rows", () => {
  const src = read("src/utils/monthlyReport.js");
  const rem = fnBody(src, "const remainderWhere = (type, date) => ({");
  assert.ok(/NO_PURPOSE/.test(rem), "remainderWhere lacks NO_PURPOSE");
});

test("insightsEngine.js: income and expense totals are the books rule, whose raw bank sums leave purpose rows out", () => {
  const src = read("src/utils/insightsEngine.js");
  assert.ok(/booksForInstants\(businessId, range\.start, range\.end\)/.test(src), "totals do not come from booksForInstants");
  const books = require("../src/utils/books");
  for (const purpose of ["savings_deposit", "savings_withdrawal", "savings_interest", "savings_fee"]) {
    for (const type of ["income", "expense"]) {
      assert.strictEqual(books.bankCountedAmount({ type, amount: 100, purpose }), 0, `${type} ${purpose}`);
    }
  }
});

test("insightsEngine.js: the balance intent reports spendable and names the reserve", () => {
  const src = read("src/utils/insightsEngine.js");
  assert.ok(/getReservedBalance\(business\.id\)/.test(src), "balance intent does not read the reserve");
  assert.ok(/netSpendable\(bal, reserved\)/.test(src), "balance intent does not compute spendable");
  assert.ok(/savingsReserved: reserved/.test(src), "balance intent does not expose savingsReserved");
});

for (const file of ["src/utils/ledgerBalance.js", "src/utils/amlChecks.js", "src/utils/staffTransferCap.js"]) {
  test(`${file}: keeps savings rows (no NO_PURPOSE, no purpose predicate)`, () => {
    const src = read(file);
    assert.ok(!/NO_PURPOSE|NOT_SAVINGS|isSavingsRow/.test(src), `${file} imports the purpose exclusion`);
    assert.ok(!/purpose\s*:/.test(src), `${file} filters on purpose`);
    assert.ok(!/"purpose" IS/.test(src), `${file} filters on purpose in SQL`);
    const calls = transactionCalls(src).filter((c) => /type:\s*"(income|expense)"/.test(c.arg));
    assert.ok(calls.length >= 1, `${file}: expected at least one income/expense query`);
  });
}

test("ledgerReconcile.js (if present) keeps savings rows too", () => {
  const p = path.join(SRC, "utils", "ledgerReconcile.js");
  if (!fs.existsSync(p)) return;
  assert.ok(!/NO_PURPOSE|NOT_SAVINGS|purpose/.test(fs.readFileSync(p, "utf8")), "ledgerReconcile filters on purpose");
});

// ══ 10. THE SPEND GATE ═════════════════════════════════════════════════════
section("10. executeTransfer refuses to spend what is set aside, and knows nothing else about savings");

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
  assert.ok(/err\.availableBalance = balance/.test(after), "INSUFFICIENT_BALANCE does not name the spendable figure");
  assert.ok(/err\.moneyMoved = false/.test(after), "INSUFFICIENT_BALANCE does not set moneyMoved = false");
  assert.ok(/^const \{ getReservedBalance, netSpendable \} = require\("\.\/savingsReserve"\);/m.test(et), "savingsReserve import");
  // One gate: the reserve is read exactly once, next to the bank read.
  assert.strictEqual(countOf(et, "getReservedBalance("), 1);
  assert.ok(gateIdx < et.indexOf("anchor.createBookTransfer("), "the gate must precede the book transfer");
  assert.ok(gateIdx < et.indexOf("anchor.createTransfer("), "the gate must precede the NIP transfer");
});

test("the Transaction row stores providerTxnId (Anchor transfer id) and the return carries it", () => {
  const createIdx = et.indexOf("prisma.transaction.create(");
  assert.ok(createIdx > 0, "no prisma.transaction.create");
  const create = callArg(et, createIdx + "prisma.transaction.create".length);
  assert.ok(/providerTxnId:\s*providerTransferId/.test(create), "create does not store providerTxnId from providerTransferId");
  assert.ok(/providerTransferId = nip\?\.transferId/.test(et), "NIP transfer id is not captured");
  assert.ok(/providerTransferId = book\?\.transferId/.test(et), "book transfer id is not captured");
  assert.ok(/return \{ reference: ref, route, transactionId: txn\.id, transaction: txn, fee, totalCost, providerTransferId \}/.test(et), "return does not carry providerTransferId and totalCost");
});

test("executeTransfer has NO purpose parameter, books no purpose, and routes nothing to a pot", () => {
  const params = et.slice(et.indexOf("async function executeTransfer({"), et.indexOf("} = {}) {"));
  assert.ok(params.length > 0 && params.length < 3000, "could not isolate the parameter list");
  assert.ok(!/\bpurpose\b/.test(params), "executeTransfer must not accept a purpose");
  const create = callArg(et, et.indexOf("prisma.transaction.create(") + "prisma.transaction.create".length);
  assert.ok(!/\bpurpose\b/.test(create), "executeTransfer must not stamp a purpose (only the fee sweep does)");
  assert.ok(!/BAD_PURPOSE|SAVINGS_DEST_USE_DEPOSIT|savingsPot|savingsMovement|savings_deposit/.test(et), "a PiggyVest-era branch survived");
  assert.ok(/const internalDest = await prisma\.business\.findFirst\(/.test(et), "route detection must be unconditional again");
});

test("savingsReserve never imports executeTransfer, sums only ACTIVE pots, and knows no pot backing", () => {
  const src = read("src/utils/savingsReserve.js");
  assert.ok(!/require\(["'][^"']*executeTransfer/.test(src), "savingsReserve imports executeTransfer: circular");
  const agg = fnBody(src, "async function getReservedBalance(");
  assert.ok(/savingsPot\.aggregate\(/.test(agg), "reserve must be one aggregate");
  assert.ok(/where: \{ businessId, status: "active" \}/.test(agg), "reserve must sum only ACTIVE pots of THIS business");
  assert.ok(/_sum: \{ balance: true \}/.test(agg));
  assert.ok(/Math\.max\(0, Number\(agg\._sum\.balance \|\| 0\)\)/.test(agg), "an empty aggregate is zero, never NaN");
  assert.ok(!/backing/.test(src), "there is one kind of pot now; a `backing` filter would be a query on a column that no longer exists");
  const spend = fnBody(src, "async function getSpendableBalance(");
  assert.ok(/source: "none"/.test(spend) && /spendable: 0/.test(spend), "no bank account → nothing spendable, not a throw");
  assert.ok(/spendable: netSpendable\(gross, reserved\)/.test(spend));
});

// ══ 11. THE SERVICE ════════════════════════════════════════════════════════
section("11. nothing moves: deposits and withdrawals are single guarded writes under the business lock");

test("savings.js calls no transfer path: the only Anchor call is the fee sweep's book transfer", () => {
  // The header comment may NAME executeTransfer (the gate the reserve relies
  // on); the code must never require or call it.
  assert.ok(!/require\([^)]*executeTransfer|executeTransfer\(|anchor\.createTransfer\(|createCounterparty|verifyCounterparty|transferToBank/.test(sv), "a pot must never move money");
  const anchorCalls = [...sv.matchAll(/\banchor\.(\w+)\(/g)].map((m) => m[1]);
  assert.deepStrictEqual(anchorCalls, ["createBookTransfer"], `anchor calls in savings.js: ${anchorCalls}`);
  const fee = fnBody(sv, "async function collectSavingsFee(");
  assert.ok(/anchor\.createBookTransfer\(/.test(fee), "the one book transfer must live in collectSavingsFee");
  assert.ok(!/anchor\.getAccountBalance/.test(fnBody(sv, "async function depositToPot(")), "the deposit reads the bank through getSpendableBalance only");
});

test("depositToPot: lock → freeze check → idempotency → live spendable → one $transaction with a guarded claim", () => {
  const body = fnBody(sv, "async function depositToPot(");
  mustPrecede(body, "prisma.withBusinessLock(biz.id", "await assertNotFrozen(biz)", "deposit");
  mustPrecede(body, "await assertNotFrozen(biz)", "prisma.savingsMovement.findUnique({ where: { reference } })", "deposit");
  mustPrecede(body, "prisma.savingsMovement.findUnique({ where: { reference } })", "getSpendableBalance(biz)", "deposit");
  mustPrecede(body, "getSpendableBalance(biz)", "prisma.$transaction(async (px)", "deposit");
  mustPrecede(body, "prisma.$transaction(async (px)", "px.savingsPot.updateMany({", "deposit");
  assert.strictEqual(countOf(body, "prisma.$transaction("), 1, "one $transaction");
  assert.strictEqual(countOf(body, "px.savingsPot.updateMany("), 1, "one claim");
  assert.ok(/where: \{ id: fresh\.id, status: "active" \},\s*data: \{ balance: \{ increment: amt \} \}/.test(body), "deposit claim");
  assert.ok(/if \(claim\.count !== 1\) throw new SavingsError/.test(body), "the claim count is not checked");
  assert.ok(/px\.savingsMovement\.create\(/.test(body) && /type: "deposit", amount: amt, fee, status: "completed", reference, completedAt: new Date\(\)/.test(body), "the movement row is written in the same $transaction, completed, with its fee");
  assert.ok(/const \{ fee \} = computeDepositFee\(\);/.test(body), "the deposit fee comes from config/fees.js");
  assert.ok(/if \(fee > 0\) \{\s*await collectSavingsFee\(result\.movement\.id\)\.catch\(/.test(body), "the deposit fee is swept right after the deposit and never fails it");
  mustPrecede(body, "prisma.$transaction(async (px)", "await collectSavingsFee(result.movement.id)", "deposit");
  assert.ok(/action: "SAVINGS_DEPOSIT", [^\n]*metadata: \{ amount: amt, reference, fee \} \}\);/.test(body), "the audit row names the fee");
  assert.ok(body.indexOf("px.savingsPot.updateMany(") < body.indexOf("px.savingsMovement.create("), "claim before the movement row");
});

test("depositToPot: BALANCE_UNAVAILABLE fails closed, spendable gates the amount, idempotency replays", () => {
  const body = fnBody(sv, "async function depositToPot(");
  assert.ok(/try \{ live = await getSpendableBalance\(biz\); \}/.test(body), "the bank read is wrapped");
  assert.ok(/"BALANCE_UNAVAILABLE", 503/.test(body), "an unreadable bank must refuse with 503, never deposit on a guess");
  assert.ok(/"NO_BANKING", 503/.test(body), "ANCHOR_NOT_CONFIGURED maps to NO_BANKING 503");
  mustPrecede(body, "BALANCE_UNAVAILABLE", "prisma.$transaction(async (px)", "deposit");
  assert.ok(/if \(live\.spendable \+ MONEY_EPS < amt \+ fee\)/.test(body), "deposit must refuse beyond spendable, the fee on top (with the kobo tolerance)");
  assert.ok(/const maxDeposit = Math\.max\(0, toKobo\(live\.spendable\) - toKobo\(fee\)\) \/ 100;/.test(body), "the refusal says the most that can be deposited, in kobo");
  assert.ok(/"INSUFFICIENT_BALANCE", 400, \{ availableBalance: live\.spendable, reserved: live\.reserved, fee, maxDeposit \}/.test(body), "INSUFFICIENT_BALANCE names spendable, reserved, the fee and the most that fits");
  assert.ok(/return replayOutcome\(existing, amt, fresh\)/.test(body), "replay must go through replayOutcome");
  assert.ok(/IDEMPOTENCY_REUSED/.test(body), "a key reused on another pot is refused");
  mustPrecede(body, "IDEMPOTENCY_REUSED", "return replayOutcome(existing, amt, fresh)", "deposit");
  assert.ok(/fresh\.businessId !== biz\.id/.test(body), "the pot must belong to the business (re-checked under the lock)");
  assert.ok(/fresh\.status !== "active"/.test(body), "only an active pot takes money");
});

test("withdrawFromPot: lock → freeze check → idempotency → lockAllows → one guarded claim with the balance predicate", () => {
  const body = fnBody(sv, "async function withdrawFromPot(");
  mustPrecede(body, "prisma.withBusinessLock(biz.id", "await assertNotFrozen(biz)", "withdraw");
  mustPrecede(body, "await assertNotFrozen(biz)", "prisma.savingsMovement.findUnique({ where: { reference } })", "withdraw");
  mustPrecede(body, "prisma.savingsMovement.findUnique({ where: { reference } })", "lockAllows(fresh", "withdraw");
  mustPrecede(body, "lockAllows(fresh", "px.savingsPot.updateMany({", "withdraw");
  mustPrecede(body, "lockAllows(fresh", "prisma.$transaction(async (px)", "withdraw");
  assert.ok(/lockAllows\(fresh, \{ confirmEarly \}\)/.test(body), "lockAllows must see the merchant's confirmation");
  assert.strictEqual(countOf(body, "px.savingsPot.updateMany("), 1, "one claim");
  assert.ok(/where: \{ id: fresh\.id, status: "active", balance: \{ gte: amt - MONEY_EPS \} \},\s*data: \{ balance: \{ decrement: amt \} \}/.test(body), "withdrawal claim must require balance >= amount and decrement it");
  assert.ok(/if \(claim\.count !== 1\) throw new SavingsError\(/.test(body) && /INSUFFICIENT_POT_BALANCE/.test(body), "the claim count is checked and named");
  assert.ok(/type: "withdrawal", amount: amt, fee, status: "completed", reference, completedAt: new Date\(\)/.test(body), "the movement row carries the fee and is completed");
  assert.ok(/updatedPot\.balance < 0 && updatedPot\.balance > -MONEY_EPS/.test(body), "a sub-kobo negative is clamped to zero, a real negative is not hidden");
  assert.ok(/return replayOutcome\(existing, amt, fresh\)/.test(body), "replay must go through replayOutcome");
});

test("withdrawFromPot: the fee is charged on early withdrawals only, quoted in the confirmation, swept at once", () => {
  const w = fnBody(sv, "async function withdrawFromPot(");
  assert.ok(/const breakFee = lock\.early \|\| lock\.code === "EARLY_WITHDRAWAL_CONFIRM" \? computeBreakFee\(amt\) : \{ fee: 0, bps: 0 \}/.test(w), "the fee is computed for the quote and the charge, nothing else");
  assert.ok(/const fee = lock\.early \? breakFee\.fee : 0/.test(w), "fee only when the lock is broken early");
  // feeBps is 0 whenever nothing will be charged, so the app never shows a
  // rate for a free withdrawal.
  assert.ok(/\{ lockUntil: fresh\.lockUntil, fee: breakFee\.fee, feeBps: breakFee\.fee > 0 \? breakFee\.bps : 0 \}/.test(w), "EARLY_WITHDRAWAL_CONFIRM carries the fee and the rate (0 when free)");
  assert.ok(/"EARLY_WITHDRAWAL_CONFIRM", 409,/.test(w), "the confirmation ask is 409");
  // An Unbreakable pot: 423 with the opening moment and nothing else (no price,
  // because nothing opens it early), worded with the day it opens.
  assert.ok(/throw new SavingsError\(`This pot is unbreakable\. It opens on \$\{when\}\.`, "POT_LOCKED", 423, \{ lockUntil: fresh\.lockUntil \}\)/.test(w), "POT_LOCKED: the words, 423, { lockUntil } only");
  assert.ok(/const when = dayWords\(lock\.until\)/.test(w), "the day is worded in Lagos time");
  assert.ok(/This pot opens on \$\{when\}\. Withdrawing \$\{[^}]+\} early costs \$\{[^}]+\}\. Confirm to continue\./.test(w), "the Breakable confirmation names the day and what it costs");
  assert.ok(/This pot opens on \$\{when\}\. Confirm to withdraw early\./.test(w), "a free early withdrawal still asks");
  mustPrecede(w, 'lock.code === "POT_LOCKED"', "const fee = lock.early ? breakFee.fee : 0", "withdraw");
  mustPrecede(w, "if (!lock.ok) {", "const fee = lock.early ? breakFee.fee : 0", "withdraw");
  assert.ok(/if \(fee > 0\) \{\s*await collectSavingsFee\(result\.movement\.id\)\.catch\(/.test(w), "the sweep runs right after the withdrawal and never fails it");
  mustPrecede(w, "prisma.$transaction(async (px)", "await collectSavingsFee(result.movement.id)", "withdraw");
  assert.ok(/early: !!lock\.early, fee \}/.test(w), "the audit row names early and the fee");
});

test("collectSavingsFee: feeCollectedAt is claimed BEFORE the book transfer, the row is a savings_fee expense, a failure stays claimed", () => {
  const body = fnBody(sv, "async function collectSavingsFee(");
  const claim = "where: { id: mv.id, feeCollectedAt: null }, data: { feeCollectedAt: new Date() }";
  mustPrecede(body, claim, "anchor.createBookTransfer(", "break fee");
  assert.ok(/if \(claim\.count !== 1\) return "skipped"/.test(body), "the claim count is checked");
  assert.strictEqual(countOf(body, "anchor.createBookTransfer("), 1, "exactly one book transfer: a claimed fee is never re-sent by itself");
  // Nothing to collect, or nowhere to collect it → out before the claim.
  mustPrecede(body, '!FEE_TYPES.includes(mv.type) || mv.status !== "completed" || !(Number(mv.fee) > 0) || mv.feeCollectedAt', claim, "fee");
  // The two kinds: a withdrawal's keeps every name it always had.
  assert.ok(/withdrawal: \{\s*suffix: "_bfee", words: "early-withdrawal fee", reason: "Savings early withdrawal fee",\s*title: "Savings break fee", alertKey: "savings-break-fee", audit: "SAVINGS_BREAK_FEE",\s*\}/.test(sv), "the withdrawal fee's names are unchanged");
  assert.ok(/deposit: \{\s*suffix: "_dfee", words: "deposit fee", reason: "Savings deposit fee",\s*title: "Savings deposit fee", alertKey: "savings-deposit-fee", audit: "SAVINGS_DEPOSIT_FEE",\s*\}/.test(sv), "the deposit fee has its own names");
  assert.ok(/const FEE_TYPES = Object\.keys\(FEE_KINDS\);/.test(sv));
  mustPrecede(body, "process.env.ANCHOR_FEE_ACCOUNT_ID", claim, "break fee");
  mustPrecede(body, 'if (!biz?.anchorAccountId) return "skipped"', claim, "break fee");
  // The transfer: merchant → fee account, under the movement's own reference.
  const xfer = callArg(body, body.indexOf("(", body.indexOf("anchor.createBookTransfer(")));
  assert.ok(/fromAccountId: biz\.anchorAccountId/.test(xfer) && /toAccountId: feeAccount/.test(xfer) && /amount: fee/.test(xfer), "merchant → fee account, the fee");
  assert.ok(/reference,/.test(xfer) && /const reference = `\$\{mv\.reference\}\$\{kind\.suffix\}`/.test(body), "the sweep's reference derives from the movement's (Anchor dedups on it)");
  assert.ok(/reason: kind\.reason,/.test(xfer), "the transfer's reason names no pot");
  // The ledger row, written by bookSavingsFee once the transfer is through.
  mustPrecede(body, "anchor.createBookTransfer(", "await bookSavingsFee(biz, fee, reference, book?.transferId, kind)", "break fee");
  const row = fnBody(sv, "async function bookSavingsFee(");
  assert.ok(/purpose: "savings_fee"/.test(row), "the fee row carries purpose savings_fee");
  assert.ok(/type: "expense"/.test(row) && /category: "transfer"/.test(row) && /paymentMethod: "bank"/.test(row) && /source: "anchor"/.test(row), "the fee row is a bank expense the ledger counts");
  assert.ok(/providerTxnId: transferId \|\| undefined/.test(row), "the fee row stores Anchor's transfer id");
  assert.ok(/amount: fee/.test(row));
  assert.ok(/if \(e\?\.code === "P2002"\) return;/.test(row), "a duplicate ledger row (a second write of the same fee) is a no-op");
  assert.ok(/if \(attempt >= 2\) throw e;/.test(row), "a failed row write is tried once more, then reported");
  assert.ok(/adjustBalance\(biz\.id, -fee\)/.test(body), "the balance cache drops by the fee");
  assert.ok(/const fee = Math\.round\(Number\(mv\.fee\) \* 100\) \/ 100/.test(body), "the swept fee is the stored fee, to the kobo");
  // Never un-claimed, whatever happens after the claim.
  assert.ok(!/feeCollectedAt: null \}/.test(body.slice(body.indexOf(claim) + claim.length)), "a failed sweep must stay claimed (never charged twice)");
});

test("collectSavingsFee: a refusal, an unknown outcome and a missing row are three different alerts", () => {
  const body = fnBody(sv, "async function collectSavingsFee(");
  const transferCatch = body.slice(body.indexOf("} catch (e) {"), body.indexOf("await bookSavingsFee(biz, fee, reference, book?.transferId, kind)"));
  // The bank refused it: nothing moved, nothing is booked, collect it by hand.
  const refused = transferCatch.slice(transferCatch.indexOf("if (bankRefused(e)) {"), transferCatch.indexOf("// The fee may have moved"));
  assert.ok(/action: `\$\{kind\.audit\}_FAILED`/.test(refused) && /severity: "alert"/.test(refused), "a refused sweep is audited at alert severity");
  assert.ok(/collect it by hand/.test(refused) && /refused/.test(refused), "a refused sweep asks for the fee by hand");
  assert.ok(!/bookSavingsFee/.test(refused), "a refused sweep books nothing");
  assert.ok(/return "failed"/.test(refused));
  // Unknown: booked anyway (the safe side), and check the bank first.
  const unknown = transferCatch.slice(transferCatch.indexOf("// The fee may have moved"));
  assert.ok(/await bookSavingsFee\(biz, fee, reference, null, kind\)/.test(unknown), "an unknown outcome is booked as charged");
  assert.ok(/action: `\$\{kind\.audit\}_UNCONFIRMED`/.test(unknown) && /severity: "alert"/.test(unknown));
  assert.ok(/may have moved\. Check Anchor for that reference before collecting anything\./.test(unknown), "the alert says to check the bank first");
  assert.ok(/return "failed"/.test(unknown));
  // The transfer went through but the row did not: never collect again.
  const rowFail = body.slice(body.indexOf("await bookSavingsFee(biz, fee, reference, book?.transferId, kind)"));
  assert.ok(/action: `\$\{kind\.audit\}_BOOKKEEPING_FAILED`/.test(rowFail) && /transferId: book\?\.transferId \|\| null/.test(rowFail));
  assert.ok(/WAS swept/.test(rowFail) && /Do not collect it again: add the savings_fee row\./.test(rowFail), "a missing row is never collected again");
  // One alert key per fee, whichever it is.
  assert.ok(/const alertKey = `\$\{kind\.alertKey\}-\$\{mv\.id\}`/.test(body));
});

test("bankRefused: only a definite refusal (or no bank at all) means nothing moved", () => {
  for (const s of [400, 401, 403, 404, 422]) {
    assert.strictEqual(savings.bankRefused(Object.assign(new Error("x"), { httpStatus: s })), true, `httpStatus ${s}`);
    assert.strictEqual(savings.bankRefused({ status: s }), true, `status ${s}`);
  }
  assert.strictEqual(savings.bankRefused(Object.assign(new Error("Anchor is not configured on this server."), { code: "ANCHOR_NOT_CONFIGURED" })), true);
  // These may have moved the money.
  for (const e of [{ httpStatus: 409 }, { httpStatus: 500 }, { httpStatus: 502 }, { httpStatus: 504 }, new TypeError("fetch failed"), new Error("Anchor returned non-JSON (502): <html>"), {}, null, undefined]) {
    assert.strictEqual(savings.bankRefused(e), false, JSON.stringify(e && (e.httpStatus || e.message)));
  }
});

test("collectSavingsFee: an account under review waits, before the bank is read or anything claimed, with no alert", () => {
  const body = fnBody(sv, "async function collectSavingsFee(");
  const claim = "where: { id: mv.id, feeCollectedAt: null }, data: { feeCollectedAt: new Date() }";
  assert.ok(/select: \{[^}]*accountStatus: true[^}]*\}/.test(body), "the business is read with its accountStatus (else the freeze test reads undefined and passes)");
  const frozen = 'if (await frozenSubject(biz)) return "deferred";';
  assert.ok(body.includes(frozen), "a frozen business or owner defers the fee");
  mustPrecede(body, 'if (!biz?.anchorAccountId) return "skipped"', frozen, "break fee");
  mustPrecede(body, frozen, "getSpendableBalance(biz)", "break fee");
  mustPrecede(body, frozen, claim, "break fee");
  mustPrecede(body, frozen, "alertFeeWaiting(", "break fee: the freeze is already with a human, so no fee-waiting alert");
});

test("the fee's bank row names no pot: staff with bank access read it, and pots are the owner's", () => {
  const body = fnBody(sv, "async function collectSavingsFee(");
  const row = fnBody(sv, "async function bookSavingsFee(");
  assert.ok(/description: `\$\{kind\.reason\} · Ref: \$\{reference\}`/.test(row), "the row's description");
  assert.ok(/reason: "Savings early withdrawal fee"/.test(sv) && /reason: "Savings deposit fee"/.test(sv), "both reasons name no pot");
  for (const [label, text] of [["collectSavingsFee", body], ["bookSavingsFee", row]]) {
    assert.ok(!/pot\?\.name|mv\.pot|include: \{ pot/.test(text), `${label} must not read or write the pot's name`);
  }
});

test("collectSavingsFee: the fee comes only out of spendable money; short or unreadable, it waits (deferred) and alerts once a day", () => {
  const body = fnBody(sv, "async function collectSavingsFee(");
  const claim = "where: { id: mv.id, feeCollectedAt: null }, data: { feeCollectedAt: new Date() }";
  // Spendable (the bank minus every pot) is read BEFORE the claim, so a fee
  // that would eat into another pot is never claimed, let alone swept.
  mustPrecede(body, "getSpendableBalance(biz)", claim, "break fee");
  assert.ok(/if \(!live \|\| live\.spendable \+ MONEY_EPS < fee\) \{/.test(body), "spendable must cover the fee (an unreadable bank defers too)");
  const short = body.slice(body.indexOf("if (!live || live.spendable"), body.indexOf(claim));
  assert.ok(/return "deferred"/.test(short), "a short fee is deferred");
  assert.ok(/alertFeeWaiting\(mv, biz, fee, now\)/.test(short), "a waiting fee may alert");
  assert.ok(!/feeCollectedAt|createBookTransfer/.test(short), "a deferred fee is neither claimed nor swept");
  // Exactly the four answers, and true/false are gone (callers compare strings).
  const answers = [...body.matchAll(/return ("\w+"|\w+);/g)].map((m) => m[1]);
  assert.deepStrictEqual([...new Set(answers)].sort(), ['"collected"', '"deferred"', '"failed"', '"skipped"'], `returns: ${answers}`);
  // The caller holds the business lock: taking it again here would deadlock
  // (withBusinessLock is not re-entrant), so the sweep never takes it.
  assert.ok(!/withBusinessLock/.test(body), "collectSavingsFee must not take the business lock itself");
  // Once a day after a day of waiting: the alert engine's own cooldown is an hour.
  const wait = fnBody(sv, "async function alertFeeWaiting(");
  assert.ok(/if \(!\(now - since >= DAY_MS\)\) return false/.test(wait), "only after a day of waiting");
  assert.ok(/now - new Date\(last\.lastFiredAt\) < DAY_MS\) return false/.test(wait), "at most once a day");
  assert.ok(/`\$\{kind\.alertKey\}-waiting-\$\{mv\.id\}`/.test(wait), "one alert key per fee");
});

test("collectSavingsFee runs only under the business lock: inside the withdrawal's lock and the loop's per-fee lock", () => {
  const calls = [...sv.matchAll(/collectSavingsFee\(/g)].length;
  // The definition plus one call each in depositToPot and withdrawFromPot.
  assert.strictEqual(calls, 3, `collectSavingsFee( appears ${calls} times in savings.js`);
  const w = fnBody(sv, "async function withdrawFromPot(");
  mustPrecede(w, "prisma.withBusinessLock(biz.id", "await collectSavingsFee(result.movement.id)", "withdraw");
  const d = fnBody(sv, "async function depositToPot(");
  mustPrecede(d, "prisma.withBusinessLock(biz.id", "await collectSavingsFee(result.movement.id)", "deposit");
  const recon = read("src/utils/savingsReconcile.js");
  assert.ok(/await prisma\.withBusinessLock\(m\.businessId, \(\) => savings\.collectSavingsFee\(m\.id\)\)/.test(recon), "the loop sweeps each fee under its business's lock");
  for (const f of walk(SRC).filter((p) => p.endsWith(".js") && !/[\\/]utils[\\/]savings(Reconcile)?\.js$/.test(p))) {
    assert.ok(!/collectSavingsFee\(/.test(fs.readFileSync(f, "utf8")), `${path.relative(ROOT, f)} calls collectSavingsFee`);
  }
});

test("every pot is Breakable or Unbreakable (owner, 2026-10-15): none is made without a lock, and none loses it", () => {
  const create = fnBody(sv, "async function createPot(");
  assert.ok(/if \(!lockUntil && !lockMode\) throw new SavingsError\("Choose Breakable or Unbreakable and the day the pot opens\.", "LOCK_REQUIRED", 400\);/.test(create), "a pot with neither is refused");
  mustPrecede(create, '"LOCK_REQUIRED", 400', "prisma.savingsPot.create(", "create");
  const update = fnBody(sv, "async function updatePot(");
  assert.ok(!/data\.lockUntil = null/.test(update) && !/data\.lockMode = null/.test(update), "an edit never clears a lock");
  assert.ok(/"LOCK_REQUIRED", 400\);/.test(update), "removing a lock is refused with its own code");
});

test("updatePot decides under the business lock, from the pot as it is now", () => {
  const body = fnBody(sv, "async function updatePot(");
  mustPrecede(body, "prisma.withBusinessLock(pot.businessId", "prisma.savingsPot.findUnique({ where: { id: pot.id } })", "update");
  mustPrecede(body, "prisma.savingsPot.findUnique({ where: { id: pot.id } })", "const lockedNow =", "update");
  assert.ok(/const lockedNow = !!fresh\.lockUntil && new Date\(fresh\.lockUntil\) > now/.test(body), "not opened yet, from the fresh row");
  assert.ok(/const unbreakable = lockedNow && fresh\.lockMode === "strict"/.test(body), "Unbreakable-and-locked comes from the fresh row");
  // A Breakable pot with money in it keeps its day too: removing the lock or
  // moving it earlier would take the money out without the fee.
  assert.ok(/const kept = unbreakable \|\| \(lockedNow && toKobo\(fresh\.balance\) > 0\)/.test(body), "kept: Unbreakable, or Breakable with money in it, from the fresh row");
  assert.ok(!/pot\.lockMode|pot\.lockUntil|pot\.status|pot\.balance/.test(body), "nothing is decided from the row the route read before the lock");
  assert.ok(/fresh\.status !== "active"/.test(body) && /"POT_CLOSED", 409/.test(body), "a pot closed meanwhile is refused");
  // Every empty lockUntil is a removal (0 and false included), decided before validateLock.
  assert.ok(/if \(!lockUntil\) \{/.test(body), "null, \"\", 0 and false all ask to remove the lock");
  mustPrecede(body, "if (!lockUntil) {", "validateLock(", "update");
  // Unbreakable: never removed, relaxed or moved earlier (three refusals).
  assert.ok(/if \(unbreakable && lock\.lockMode !== "strict"\)/.test(body), "never relaxed");
  assert.strictEqual(countOf(body, '"LOCK_CANNOT_SHORTEN", 409'), 3, "removed, relaxed, earlier: three refusals");
  // Kept (either kind): never removed or moved earlier, even on the way to Unbreakable.
  assert.ok(/if \(kept\) throw breakableLockKept\(current\);/.test(body), "a Breakable pot with money cannot drop its lock");
  assert.ok(/if \(kept && lock\.lockUntil < current\)/.test(body), "never earlier, whatever mode is asked for");
  assert.strictEqual(countOf(body, "throw breakableLockKept(current)"), 2, "removed, earlier: two Breakable refusals");
  assert.ok(/lagosDay\(lock\.lockUntil\) !== lagosDay\(current\)/.test(body), "the pot's own day sent back is no change, not a refusal");
  mustPrecede(body, "const fresh =", "prisma.savingsPot.update({ where: { id: fresh.id }, data })", "update");
  // The lock before the edit goes back to the route, for the audit row.
  assert.ok(/const before = \{ lockUntil: fresh\.lockUntil, lockMode: fresh\.lockMode \}/.test(body));
  assert.ok(/return \{ pot: fresh, before \}/.test(body) && /return \{ pot: await prisma\.savingsPot\.update\(\{ where: \{ id: fresh\.id \}, data \}\), before \}/.test(body), "updatePot answers { pot, before }");
  // The Breakable refusal has its own code, carries the day, and only names a fee that is charged.
  const kept = fnBody(sv, "function breakableLockKept(");
  assert.ok(/"BREAKABLE_LOCK_KEPT", 409, \{ lockUntil: current \}/.test(kept), "its own code, 409, with the day");
  assert.ok(/breakFeeView\(\)\.enabled \?/.test(kept), "the fee is named only when one is charged");
});

test("only utils/savings.js writes pots or movements", () => {
  const writes = /\bsavings(Pot|Movement)\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/;
  const hits = [];
  for (const f of [path.join(ROOT, "server.js"), ...walk(SRC).filter((p) => p.endsWith(".js"))]) {
    if (/[\\/]utils[\\/]savings\.js$/.test(f)) continue;
    for (const l of linesMatching(fs.readFileSync(f, "utf8"), writes)) hits.push(`${path.relative(ROOT, f).replace(/\\/g, "/")}:${l}`);
  }
  assert.deepStrictEqual(hits, [], `pot writes outside the service: ${hits.join(", ")}`);
  assert.ok(writes.test(sv), "the service itself writes pots (the scan is not blind)");
});

test("closePot: under the lock, only an empty, active pot, by a guarded claim", () => {
  const body = fnBody(sv, "async function closePot(");
  mustPrecede(body, "prisma.withBusinessLock(pot.businessId", "toKobo(fresh.balance) > 0", "close");
  assert.ok(/"POT_NOT_EMPTY", 409/.test(body), "a pot with money cannot be closed");
  mustPrecede(body, "POT_NOT_EMPTY", 'where: { id: pot.id, status: "active" }', "close");
  assert.ok(/status: "closed", balance: 0, closedAt: new Date\(\)/.test(body));
  assert.ok(/if \(r\.count !== 1\) throw new SavingsError/.test(body), "the close claim count is checked");
});

test("assertNotFrozen checks the business and the owner, and runs inside the lock on both money paths", () => {
  const who = fnBody(sv, "async function frozenSubject(");
  assert.ok(/biz\?\.accountStatus && biz\.accountStatus !== "active"\) return "business"/.test(who), "business freeze");
  assert.ok(/owner\?\.accountStatus && owner\.accountStatus !== "active"\) return "owner"/.test(who), "owner freeze");
  assert.ok(/return null;/.test(who));
  const body = fnBody(sv, "async function assertNotFrozen(");
  assert.ok(/const who = await frozenSubject\(biz\)/.test(body), "one rule for the money routes and the fee sweep");
  assert.strictEqual(countOf(body, '"FROZEN", 423'), 2);
  for (const fn of ["depositToPot", "withdrawFromPot"]) {
    const b = fnBody(sv, `async function ${fn}(`);
    assert.ok(b.indexOf("prisma.withBusinessLock(biz.id") < b.indexOf("await assertNotFrozen(biz)"), `${fn}: freeze check must be inside the lock`);
  }
});

test("amounts are positive, 2-dp numbers; references derive from the client key with a per-prefix namespace", () => {
  const va = fnBody(sv, "function validateAmount(");
  assert.ok(/if \(!\(n > 0\) \|\| !Number\.isFinite\(n\)\) throw/.test(va) && /if \(!money2dp\(n\)\) throw/.test(va));
  assert.ok(/return toKobo\(n\) \/ 100;/.test(va), "an amount is stored as whole kobo");
  assert.ok(/const money2dp = \(n\) => Number\.isFinite\(Number\(n\)\) && twoDecimals\(Number\(n\)\);/.test(sv), "money2dp is the codebase's twoDecimals rule");
  assert.ok(/return toKobo\(t\) \/ 100;/.test(fnBody(sv, "function validateTarget(")), "a target is stored as whole kobo");
  assert.ok(/validateTarget\(targetAmount\)/.test(fnBody(sv, "async function createPot(")) && /validateTarget\(targetAmount\)/.test(fnBody(sv, "async function updatePot(")), "both target paths use validateTarget");
  assert.ok(/const depositRef = \(key\) => keyedRef\(DEPOSIT_REF_PREFIX, key\)/.test(sv));
  assert.ok(/const withdrawalRef = \(key\) => keyedRef\(WITHDRAWAL_REF_PREFIX, key\)/.test(sv));
  assert.ok(/replace\(\/\[\^a-zA-Z0-9\]\/g, ""\)\.slice\(0, 40\)/.test(sv), "the client key is sanitised and bounded");
  assert.ok(/crypto\.randomBytes\(8\)\.toString\("hex"\)/.test(sv), "a missing key gets a random reference (no accidental replay)");
});

test("every kobo amount is an amount: 19.99, 4.35, 1.10, 0.07, 2500.07 and the rest pass; three decimals, Infinity and NaN do not", () => {
  // Each of these failed `Math.round(n * 100) === n * 100`.
  for (const ok of [19.99, 4.35, 4.36, 1.1, "1.10", "19.99", 0.07, 0.14, 0.28, 0.29, 0.55, 0.58, 2500.07, 2500.55, 35.02, 10000.55, 155408456.92, 150000000.02, 0.1 + 0.2]) {
    assert.strictEqual(savings.money2dp(ok), true, `money2dp(${JSON.stringify(ok)})`);
  }
  // Float leftovers of kobo arithmetic near their own size are kobo too.
  for (const leftover of [1000.05 + 1500.02, 0.020000000000003126, 100 - 99.93]) {
    assert.strictEqual(savings.money2dp(leftover), true, `money2dp(${leftover})`);
  }
  // A residue left by a large subtraction is not, so the pot JSON carries its
  // balance as whole kobo: the figure the app shows can always be sent back.
  const residue = (1000.05 + 1500.02) - 2500;
  assert.strictEqual(residue, 0.06999999999970896);
  assert.strictEqual(savings.money2dp(residue), false);
  const shown = savings.publicPot({ id: "p", balance: residue }).balance;
  assert.strictEqual(shown, 0.07);
  assert.strictEqual(savings.money2dp(shown), true);
  assert.strictEqual(savings.publicPot({ id: "p", balance: 1000.05 + 1500.02 }).balance, 2500.07);
  assert.ok(Object.is(savings.publicPot({ id: "p", balance: -2.7e-13 }).balance, 0), "a hair below zero shows as 0, never -0");
  // ("" and null read as 0, which has two decimals; zero is refused by the
  // amount and target checks themselves.)
  for (const bad of [10.005, 0.005, 1.001, 2500.555, NaN, Infinity, -Infinity, "1e999", "abc", undefined, {}]) {
    assert.strictEqual(savings.money2dp(bad), false, `money2dp(${JSON.stringify(bad)})`);
  }
});

test("money2dp accepts every one of the million kobo amounts from 0.01 to 10,000.00", () => {
  let refused = 0;
  const first = [];
  for (let k = 1; k <= 1_000_000; k++) {
    if (!savings.money2dp(k / 100)) { refused++; if (first.length < 5) first.push(k / 100); }
  }
  assert.strictEqual(refused, 0, `refused ${refused}, first ${first.join(", ")}`);
});

test("validateAmount and validateTarget store whole kobo, and refuse what is not money", () => {
  assert.strictEqual(savings.validateAmount(0.1 + 0.2), 0.3, "client float noise is booked as the kobo it means");
  assert.strictEqual(savings.validateAmount("2500.07"), 2500.07);
  assert.strictEqual(savings.validateAmount(1000.05 + 1500.02), 2500.07, "a pot's own float balance, sent back, is its kobo");
  assert.strictEqual(savings.validateAmount(19.99), 19.99);
  const refused = (fn, v, re) => assert.throws(() => fn(v), (e) => e instanceof savings.SavingsError && e.code === "BAD_AMOUNT" && e.status === 400 && (!re || re.test(e.message)), `${fn.name}(${JSON.stringify(v)})`);
  for (const v of [0, -5, "abc", Infinity, "1e999", NaN]) refused(savings.validateAmount, v, /Enter an amount/);
  for (const v of [10.005, 0.005]) refused(savings.validateAmount, v, /more than 2 decimal places/);
  assert.strictEqual(savings.validateTarget(19.99), 19.99);
  assert.strictEqual(savings.validateTarget("4.35"), 4.35);
  assert.strictEqual(savings.validateTarget(savings.MAX_TARGET), 1e13, "the ceiling itself is allowed");
  for (const v of [0, -1, 10.005, Infinity, "Infinity", "1e999", NaN, "abc"]) refused(savings.validateTarget, v, /positive amount with at most 2 decimals/);
  for (const v of [1e13 + 0.01, 1e14, 1e300]) refused(savings.validateTarget, v, /too large/);
  assert.strictEqual(savings.MAX_TARGET, 1e13, "the same ceiling as sales and items");
});

// ══ 12. THE ROUTE ══════════════════════════════════════════════════════════
section("12. owner only, PIN before money, no AML, no OTP");

const rt = read("src/routes/savings.js");

test("router is auth + requireUnfrozen + ownerOnly for every endpoint", () => {
  const head = rt.slice(0, rt.indexOf('router.get("/"'));
  assert.ok(head.length > 0, "router.get(\"/\") not found");
  assert.ok(/router\.use\(auth\);/.test(head), "auth middleware");
  assert.ok(/router\.use\(requireUnfrozen\);/.test(head), "requireUnfrozen middleware");
  assert.ok(/router\.use\(ownerOnly\(/.test(head), "ownerOnly middleware");
  mustPrecede(head, "router.use(auth);", "router.use(requireUnfrozen);", "route order");
  mustPrecede(head, "router.use(requireUnfrozen);", "router.use(ownerOnly(", "route order");
  assert.ok(/const \{ ownerOnly \} = require\("\.\.\/middleware\/requirePermission"\)/.test(head), "ownerOnly from requirePermission");
  assert.ok(!/requirePermission\(/.test(rt), "no per-permission grant can reach savings: owner only");
});

test("deposit: checkPin precedes depositToPot, a failed PIN stops the handler", () => {
  const body = handlerBody(rt, "post", "/pots/:id/deposit");
  mustPrecede(body, "await checkPin(req, res)", "savings.depositToPot(", "deposit route");
  assert.ok(/if \(!\(await checkPin\(req, res\)\)\) return;/.test(body), "a failed PIN must stop the handler");
  assert.ok(/savings\.depositToPot\(\{ biz, user: \{ id: req\.user\.id \}, pot, amount, idempotencyKey, req \}\)/.test(body), "depositToPot call shape");
  assert.ok(/replay: !!result\.replay/.test(body), "the response says when it is a replay");
});

test("withdraw: checkPin precedes withdrawFromPot, confirmEarly is a strict boolean", () => {
  const body = handlerBody(rt, "post", "/pots/:id/withdraw");
  mustPrecede(body, "await checkPin(req, res)", "savings.withdrawFromPot(", "withdraw route");
  assert.ok(/if \(!\(await checkPin\(req, res\)\)\) return;/.test(body), "a failed PIN must stop the handler");
  assert.ok(/confirmEarly: confirmEarly === true/.test(body), "confirmEarly must be a strict boolean");
  assert.ok(!/acceptInterestForfeit/.test(rt), "there is no interest to forfeit any more");
  assert.ok(/replay: !!result\.replay/.test(body));
});

test("PATCH: any lock field needs the PIN, after ownership and before the lock; a rename does not", () => {
  const body = handlerBody(rt, "patch", "/pots/:id");
  assert.ok(/const lockAsked = lockUntil !== undefined \|\| lockMode !== undefined;/.test(body), "lockUntil alone (which keeps the pot's mode) asks for the PIN too");
  assert.ok(/if \(lockAsked && !\(await checkPin\(req, res\)\)\) return;/.test(body), "a failed PIN stops the handler");
  mustPrecede(body, "await loadPot(req, req.params.id", "await checkPin(req, res)", "PATCH: ownership is refused for itself, whatever PIN is sent");
  mustPrecede(body, 'code: "POT_CLOSED"', "await checkPin(req, res)", "PATCH: a closed pot answers first");
  mustPrecede(body, "await checkPin(req, res)", "savings.updatePot(", "PATCH: the PIN before the business lock");
  assert.ok(/const \{ pot: updated, before \} = await savings\.updatePot\(/.test(body), "the lock before the edit comes from under the lock");
});

test("PATCH and POST /pots audit bounded rows: the fields read, the lock before and after, never the body's keys", () => {
  assert.ok(!/Object\.keys\(req\.body/.test(rt), "no audit row copies the request body's keys (the audit log is append-only)");
  const body = handlerBody(rt, "patch", "/pots/:id");
  assert.ok(/const fields = Object\.entries\(\{ name, targetAmount, lockUntil, lockMode \}\)\.filter\(\(\[, v\]\) => v !== undefined\)\.map\(\(\[k\]\) => k\);/.test(body), "only the four fields the route reads");
  assert.ok(/const after = \{ lockUntil: updated\.lockUntil, lockMode: updated\.lockMode \};/.test(body));
  assert.ok(/metadata: lockAsked \? \{ fields, before, after \} : \{ fields \}/.test(body), "a lock change records the lock before and after");
  assert.ok(/severity: lockAsked && after\.lockMode === "strict" \? "warn" : "info"/.test(body), "an Unbreakable lock is audited at warn");
  const create = handlerBody(rt, "post", "/pots");
  assert.ok(/metadata: \{ lockMode: pot\.lockMode \|\| null, lockUntil: pot\.lockUntil \|\| null \}/.test(create), "a new pot's lock is recorded whole");
});

test("checkPin audits PIN_FAILED and uses verifyTransactionPin", () => {
  const body = fnBody(rt, "async function checkPin(");
  assert.ok(/verifyTransactionPin\(req\.user\.id, req\.body\?\.pin\)/.test(body));
  assert.ok(/action: "PIN_FAILED"/.test(body));
  assert.ok(/return false/.test(body) && /return true/.test(body));
});

test("no AML pipeline, no OTP, no BVN, no partner in the route", () => {
  assert.ok(!/runPreTransferChecks|dispatchOtp|amlChecks|TRANSFER_OTP_TYPE|otpTarget|otpIdentifier/.test(rt), "the route must not run the transfer AML/OTP pipeline");
  assert.ok(!/kycBvn|bvn/i.test(rt), "route file must not touch the BVN");
  assert.ok(!/profile|ensureProfile|SavingsProfile/i.test(rt), "no partner profile");
});

test("GET /savings reports the switch, the reserve and the break-fee schedule; a pot id is scoped to the caller's business", () => {
  const body = handlerBody(rt, "get", "/");
  assert.ok(/enabled: savings\.isEnabled\(\)/.test(body));
  assert.ok(/totals: \{ saved, reserved \}/.test(body));
  assert.ok(/breakFee: savings\.breakFeeView\(\)/.test(body), "the fee view is the service's (all zeros when no fee is charged)");
  assert.ok(!/breakFeeConfig/.test(rt), "the route builds no fee view of its own");
  assert.ok(/status: \{ not: "closed" \}/.test(body), "closed pots are not listed");
  const load = fnBody(rt, "async function loadPot(");
  assert.ok(/pot\.businessId !== String\(businessId\)/.test(load) && /loadBusiness\(req, pot\.businessId\)/.test(load), "loadPot must prove the pot belongs to a business the caller owns");
  assert.ok(/userId: req\.user\.id/.test(fnBody(rt, "async function loadBusiness(")), "loadBusiness must scope to the owner");
  const errs = fnBody(rt, "function sendError(");
  assert.ok(/stack: _s, name: _n, \.\.\.extra/.test(errs), "SavingsError extras (fee, lockUntil, availableBalance) reach the app; the stack never does");
});

// ══ 13. WIRING ═════════════════════════════════════════════════════════════
section("13. loop, heartbeat, delete guards, balance readers, match guard, server mounts");

const rec = read("src/utils/savingsReconcile.js");

test("withCronLock(4014) / SAVINGS_RECONCILE_LOCK = 4014 appears exactly once, and 4014 is not another loop's key", () => {
  assert.strictEqual(countOf(rec, "SAVINGS_RECONCILE_LOCK = 4014"), 1, "SAVINGS_RECONCILE_LOCK = 4014 must appear once");
  assert.strictEqual(countOf(rec, "4014"), 2, "4014 appears in the constant and the header comment only");
  assert.ok(/withCronLock\(SAVINGS_RECONCILE_LOCK,/.test(rec), "the loop must take the cron lock");
  assert.strictEqual(countOf(rec.replace(/\/\/[^\n]*/g, ""), "withCronLock("), 1, "one cron lock (code, not the header comment)");
  const others = ["server.js", ...fs.readdirSync(path.join(SRC, "utils")).map((f) => `src/utils/${f}`)].filter((f) => f !== "src/utils/savingsReconcile.js" && f.endsWith(".js"));
  // Code only: server.js mentions 4014 in a comment next to the loop start.
  for (const f of others) assert.ok(!/\.withCronLock\(\s*4014/.test(read(f)), `${f} also locks 4014`);
  assert.strictEqual(countOf(read("server.js").replace(/\/\/[^\n]*/g, ""), "4014"), 0, "server.js code must not use 4014 itself");
});

test("the loop heartbeats \"savings-reconcile\" on success and on error, and never overlaps itself", () => {
  assert.ok(/recordHeartbeat\("savings-reconcile", "ok"\)/.test(rec), "heartbeat on success");
  assert.ok(/recordHeartbeat\("savings-reconcile", "error"/.test(rec), "heartbeat on error");
  const loop = fnBody(rec, "function startSavingsReconcileLoop(");
  assert.ok(/if \(running\) return;/.test(loop) && /running = false/.test(loop), "re-entrancy guard");
  assert.ok(/setInterval\(tick, intervalMs\)/.test(loop) && /return \(\) => clearInterval\(t\)/.test(loop));
  assert.ok(/module\.exports = \{ reconcileSavings, startSavingsReconcileLoop, SAVINGS_RECONCILE_LOCK \}/.test(rec));
});

test("the loop does exactly three things: uncollected fees, pot drift, over-reserve", () => {
  const body = fnBody(rec, "async function reconcileSavings(");
  assert.ok(/stats = \{ feesCollected: 0, feesDeferred: 0, drift: 0, overReserved: 0, errors: 0 \}/.test(body), "stats shape");
  // 1. fee backstop: waiting and orphaned fees of active accounts, least
  // recently tried first, 50 a tick, one at a time under each business's lock.
  assert.ok(/type: \{ in: \["deposit", "withdrawal"\] \}, status: "completed", fee: \{ gt: 0 \}, feeCollectedAt: null,/.test(body), "backstop selects completed deposits and withdrawals with an unswept fee");
  assert.ok(/business: \{ accountStatus: "active", user: \{ accountStatus: "active" \} \}/.test(body), "a frozen or closed account's fee is not swept (and does not take a place in the 50)");
  assert.ok(/select: \{ id: true, businessId: true \}/.test(body), "the business is known, so its lock can be taken");
  assert.ok(/orderBy: \[\{ updatedAt: "asc" \}, \{ id: "asc" \}\]/.test(body), "least recently tried first");
  assert.ok(/take: 50/.test(body), "50 a tick");
  assert.ok(/await prisma\.withBusinessLock\(m\.businessId, \(\) => savings\.collectSavingsFee\(m\.id\)\)/.test(body), "each sweep under its business's lock, through collectSavingsFee (which claims first)");
  assert.ok(!/Promise\.all/.test(body), "one at a time");
  assert.ok(/if \(outcome === "collected"\) stats\.feesCollected\+\+/.test(body) && /if \(outcome === "deferred"\) \{\s*stats\.feesDeferred\+\+;/.test(body), "collected and deferred are counted apart");
  // The queue turns: a business whose fee waits is not read again this tick,
  // and every fee looked at that still waits goes to the back.
  assert.ok(/if \(waitingBusinesses\.has\(m\.businessId\)\) \{/.test(body) && /waitingBusinesses\.add\(m\.businessId\)/.test(body), "one bank read per waiting business a tick");
  assert.ok(/else stillWaiting\.push\(m\.id\)/.test(body), "a fee not collected is queued again");
  assert.ok(/await savings\.requeueSavingsFees\(stillWaiting\)/.test(body), "the fees still waiting go to the back");
  mustPrecede(body, "for (const m of uncollected)", "savings.requeueSavingsFees(stillWaiting)", "requeue after the sweep");
  const requeue = fnBody(sv, "async function requeueSavingsFees(");
  assert.ok(/where: \{ id: \{ in: list \}, type: \{ in: FEE_TYPES \}, feeCollectedAt: null \}/.test(requeue), "only fees still waiting are touched (a claimed one is never turned back)");
  assert.ok(/data: \{ updatedAt: now \}/.test(requeue), "only the time it was last tried changes");
  // 2. drift, compared in kobo
  assert.ok(/inK - outK !== toKobo\(pot\.balance\)/.test(body), "drift compares in kobo");
  assert.ok(/fireAlert\(`savings-ledger-drift-\$\{pot\.id\}`/.test(body), "drift alerts");
  assert.ok(/status: "completed"/.test(body), "only completed movements count");
  // 3. over-reserve
  assert.ok(/Number\(r\._sum\.balance\) > gross \+ MONEY_EPS/.test(body), "over-reserve compares against the bank with the kobo tolerance");
  assert.ok(/fireAlert\(`savings-overreserved-\$\{biz\.id\}`/.test(body), "over-reserve alerts");
  assert.ok(/action: "SAVINGS_OVERRESERVED"/.test(body) && /severity: "alert"/.test(body), "over-reserve is audited");
  assert.ok(/e\.code === "ANCHOR_NOT_CONFIGURED"\) break/.test(body), "an unconfigured bank stops the reserve check, not the loop");
  // No partner: no verify, no inflow pairing, no interest, no wallet.
  assert.ok(!/verifyTransaction|pairInflows|interest|wallet|inflow|applyWithdrawalOutcome|activatePot/i.test(body), "a PiggyVest-era pass survived");
  assert.ok(!/updateMany|\.update\(|\.create\(/.test(body), "the loop only reads, sweeps through collectSavingsFee, and alerts; it never edits a pot");
});

test('healthCheck.js knows the "savings-reconcile" heartbeat at the loop\'s cadence', () => {
  const hc = read("src/utils/healthCheck.js");
  const m = hc.match(/"savings-reconcile":\s*(\d+)/);
  assert.ok(m, 'healthCheck.js lacks "savings-reconcile"');
  const minutes = Number(m[1]);
  const loopMinutes = Number(read("server.js").match(/startSavingsReconcileLoop\((\d+) \* 60 \* 1000\)/)?.[1]);
  assert.ok(loopMinutes > 0, "server.js must start the loop with an explicit minute interval");
  assert.ok(minutes >= loopMinutes, `healthCheck expects a heartbeat every ${minutes} min but the loop runs every ${loopMinutes}`);
});

test("routes/auth.js: /delete-account refuses with the shared 409 while a pot holds money, before anything is deleted", () => {
  const src = read("src/routes/auth.js");
  const body = handlerBody(src, "post", "/delete-account");
  assert.ok(/const block = await savings\.savingsBlockingDeletion\(businesses\.map\(\(b\) => b\.id\)\)/.test(body), "every one of the owner's businesses is checked");
  assert.ok(/if \(block\) return res\.status\(409\)\.json\(savings\.savingsRemainingBody\(block, "account"\)\)/.test(body), "the shared refusal, 409");
  mustPrecede(body, "savingsBlockingDeletion(", "prisma.$transaction(", "delete-account: the guard must run before anything is deleted");
  // The bank-balance guard is the one DELETE /businesses/:id uses too.
  assert.ok(/const bankBlock = await bankBalanceBlockingDeletion\(businesses, "account"\)/.test(body), "the shared bank-balance guard");
  assert.ok(/if \(bankBlock\) return res\.status\(bankBlock\.status\)\.json\(bankBlock\.body\)/.test(body));
  mustPrecede(body, "savingsBlockingDeletion(", "bankBalanceBlockingDeletion(", "delete-account: savings is named before the bank balance");
  mustPrecede(body, "bankBalanceBlockingDeletion(", "prisma.$transaction(", "delete-account: the bank guard runs before anything is deleted");
  assert.ok(!/getAccountBalance|computeLedgerBalance/.test(body), "no hand-rolled bank read: the shared guard decides");
  assert.ok(!/savingsPot\./.test(body), "no hand-rolled pot query: the shared guard decides");
  assert.ok(!/savingsMovement/.test(body), "there are no in-flight movements to wait for any more");
});

test("routes/auth.js /me: features.savings is retired (always false), savingsPots is the switch, savingsVisible is owner-only and never hides money", () => {
  const src = read("src/routes/auth.js");
  const me = handlerBody(src, "get", "/me");
  assert.ok(/\bsavings: false,/.test(me), "features.savings must stay false for good (older app copies lack the Unbreakable warning)");
  assert.ok(!/savings: process\.env\.SAVINGS_ENABLED/.test(src), "the old flag must not follow the switch any more");
  assert.ok(/const savingsPots = savings\.isEnabled\(\)/.test(me), "savingsPots is SAVINGS_ENABLED, through the one reader");
  assert.ok(/const savingsVisible = user\.accountType !== "STAFF" && \(savingsPots \|\| /.test(me), "visible: an owner, and the switch on or ...");
  assert.ok(/where: \{ business: \{ userId: user\.id \}, status: "active", balance: savings\.POT_HOLDS_MONEY \}/.test(me), "... an active pot of the owner's that holds money");
  assert.ok(/features: \{[\s\S]*?savingsPots,\s*\/\/[^\n]*\n\s*savingsVisible,\s*\}/.test(me), "both new flags are sent");
  assert.deepStrictEqual(savings.POT_HOLDS_MONEY, { gt: 0.004 }, "half a kobo or more is money");
  assert.ok(!/savingsInterest/.test(src), "features.savingsInterest is gone");
});

test("routes/businesses.js: DELETE /:id is ownership first (404), then the savings check and the delete under the business lock; the balance route reports spendable", () => {
  const bz = read("src/routes/businesses.js");
  const del = handlerBody(bz, "delete", "/:id");
  assert.ok(/const biz = await prisma\.business\.findFirst\(\{\s*where: \{ id: String\(req\.params\.id\), userId: req\.user\.id \}/.test(del), "the business is looked up as the caller's");
  assert.ok(/if \(!biz\) return res\.status\(404\)\.json\(\{ error: "Business not found" \}\)/.test(del), "not the caller's → 404");
  mustPrecede(del, "if (!biz) return res.status(404)", "savingsBlockingDeletion(", "ownership before anything about the pots");
  assert.ok(!/req\.params\.id/.test(del.slice(del.indexOf("if (!biz) return"))), "after the ownership check only the owned row's id is used");
  mustPrecede(del, "prisma.withBusinessLock(biz.id", "savingsBlockingDeletion([biz.id])", "the check runs under the lock");
  mustPrecede(del, "savingsBlockingDeletion([biz.id])", "prisma.business.deleteMany(", "the check precedes the delete");
  const locked = callArg(del, del.indexOf("(", del.indexOf("prisma.withBusinessLock(")));
  assert.ok(/prisma\.business\.deleteMany\(/.test(locked), "the delete runs inside the lock");
  assert.ok(/\{ refusal: \{ status: 409, body: savingsRemainingBody\(block, "business"\) \} \}/.test(del), "the shared savings refusal, 409");
  assert.ok(/res\.status\(outcome\.refusal\.status\)\.json\(outcome\.refusal\.body\)/.test(del));
  assert.ok(!/savingsPot\./.test(del), "no hand-rolled pot query: the shared guard decides");
  // Never around a bank balance either: the guard /auth/delete-account uses,
  // inside the same lock, after the savings check and before the delete.
  assert.ok(/const bankBlock = await bankBalanceBlockingDeletion\(\[biz\], "business"\);/.test(locked), "the bank-balance guard runs inside the lock");
  assert.ok(/if \(bankBlock\) return \{ refusal: bankBlock \};/.test(locked), "and its refusal stops the delete");
  mustPrecede(del, "savingsBlockingDeletion([biz.id])", "bankBalanceBlockingDeletion([biz]", "savings is named before the bank balance");
  mustPrecede(del, "if (bankBlock) return { refusal: bankBlock };", "prisma.business.deleteMany(", "the bank guard precedes the delete");
  assert.ok(/select: \{ id: true, name: true, country: true, anchorAccountId: true, providerAccountId: true, baseCurrency: true \}/.test(del), "the business is read with what the bank guard needs");
  assert.ok(!/getAccountBalance|computeLedgerBalance/.test(del), "no hand-rolled bank read: the shared guard decides");
  mustPrecede(del, "prisma.business.deleteMany(", 'action: "BUSINESS_DELETED"', "a deletion is audited");
  const bal = handlerBody(bz, "get", "/:id/balance");
  assert.ok(/balance: netSpendable\(gross, reserved\), grossBalance: gross, savingsReserved: reserved/.test(bal), "businesses balance route");
  assert.ok(/getReservedBalance\(biz\.id\)/.test(bal), "the reserve is read fresh, never cached");
  assert.ok(/balance: 0, grossBalance: 0, savingsReserved: 0, hasAccount: false/.test(bal), "no account → zeros");
});

testAsync("deletionGuard: a bank balance refuses (400 BALANCE_REMAINING), an unreadable bank fails closed (503), no bank account is nothing to check", async () => {
  // The bank is stubbed; for an Anchor business the guard reads nothing else.
  const anchorMod = require("../src/utils/anchor");
  const { bankBalanceBlockingDeletion } = require("../src/utils/deletionGuard");
  const real = anchorMod.getAccountBalance;
  const reads = [];
  anchorMod.getAccountBalance = async (id) => {
    reads.push(id);
    if (id === "acct-down") throw Object.assign(new Error("Anchor 502"), { httpStatus: 502 });
    if (id === "acct-unconfigured") throw Object.assign(new Error("no anchor"), { code: "ANCHOR_NOT_CONFIGURED" });
    return { balance: { "acct-full": 5_000, "acct-kobo": 0.01 }[id] ?? 0 };
  };
  const b = (id, anchorAccountId, name = id) => ({ id, name, country: "NG", anchorAccountId, providerAccountId: null, baseCurrency: "NGN" });
  try {
    const full = await bankBalanceBlockingDeletion([b("1", "acct-full", "Ada Stores")], "business");
    assert.deepStrictEqual(full, { status: 400, body: { code: "BALANCE_REMAINING", error: "Ada Stores still has money in its bank account. Transfer it out first, then delete this business." } });
    const acct = await bankBalanceBlockingDeletion([b("1", "acct-full", "Ada Stores")], "account");
    assert.strictEqual(acct.body.error, "Ada Stores still has money in its bank account. Transfer it out first, then delete your account.");
    assert.strictEqual((await bankBalanceBlockingDeletion([b("6", "acct-kobo")], "business"))?.body.code, "BALANCE_REMAINING", "a kobo is money");
    reads.length = 0;
    assert.strictEqual(await bankBalanceBlockingDeletion([b("2", "acct-empty"), b("3", null)], "business"), null, "an empty account, and no account, may go");
    assert.deepStrictEqual(reads, ["acct-empty"], "a business with no bank account is not read");
    const down = await bankBalanceBlockingDeletion([b("4", "acct-down")], "business");
    assert.strictEqual(down.status, 503, "an unreadable bank fails closed");
    assert.strictEqual(down.body.code, "BALANCE_UNAVAILABLE");
    assert.strictEqual(await bankBalanceBlockingDeletion([b("5", "acct-unconfigured")], "business"), null, "no banking in this environment: nothing to read");
    assert.strictEqual(await bankBalanceBlockingDeletion([], "business"), null);
  } finally {
    anchorMod.getAccountBalance = real;
  }
});

test("routes/transfers.js and salaryRunner.js pay from spendable", () => {
  const tr = read("src/routes/transfers.js");
  assert.ok(/getSpendableBalance\(biz\)/.test(tr) && /balance: spendable, grossBalance: gross, savingsReserved: reserved/.test(tr), "transfers balance route");
  const sr = read("src/utils/salaryRunner.js");
  assert.ok(/getSpendableBalance\(biz\)\)\.spendable/.test(sr), "salary runner must pay from spendable");
});

test("routes/transactions.js: the expense loader refuses the break fee (already a bank charge); the credit loader needs no check", () => {
  const src = read("src/routes/transactions.js");
  const debit = fnBody(src, "async function loadMatchableDebit(");
  assert.ok(/if \(isSavingsRow\(tx\)\)/.test(debit), "loadMatchableDebit does not check isSavingsRow");
  assert.ok(/SAVINGS_ROW_NOT_MATCHABLE/.test(debit), "loadMatchableDebit does not answer SAVINGS_ROW_NOT_MATCHABLE");
  const answer = debit.slice(debit.indexOf("isSavingsRow(tx)"), debit.indexOf("isSavingsRow(tx)") + 260);
  assert.ok(/status\(409\)/.test(answer), "savings rows must be 409");
  assert.ok(/Bank Fees and Charges/.test(answer), "the refusal says where the fee already counts");
  assert.ok(!/into your savings/.test(src), "a pot deposit moves no money, so no bank row is ever a transfer into savings");
  // The only savings row is an expense, and the credit loader answers
  // NOT_INCOMING for every expense before anything else, so a savings check
  // there could never run (and any purpose is refused just below it anyway).
  const credit = fnBody(src, "async function loadMatchableCredit(");
  assert.ok(!/isSavingsRow|SAVINGS_ROW_NOT_MATCHABLE|returning from your savings/.test(credit), "the unreachable credit-side check is gone");
  mustPrecede(credit, 'tx.type !== "income"', "tx.purpose || tx.accountId", "credit loader");
  assert.ok(/isSavingsRow\s*\}\s*=\s*require\("\.\.\/config\/moneySources"\)/.test(src), "isSavingsRow must come from moneySources");
});

test("scripts/reset-for-business-kyb.js refuses while any pot holds money, before it changes anything", () => {
  const src = read("scripts/reset-for-business-kyb.js");
  assert.ok(/savingsBlockingDeletion\(bizIds\)/.test(src), "the shared guard over all the user's businesses");
  mustPrecede(src, "savingsBlockingDeletion(bizIds)", "prisma.user.update(", "the guard precedes the KYC reset");
  mustPrecede(src, "savingsBlockingDeletion(bizIds)", "prisma.business.updateMany(", "the guard precedes the account detach");
  mustPrecede(src, "prisma.withBusinessLock(bizIds", "savingsBlockingDeletion(bizIds)", "under the business locks");
  assert.ok(/if \(found\) return found;/.test(src), "a blocking pot stops the reset");
  assert.ok(/process\.exitCode = 1/.test(src), "and the script fails");
});

test("no admin path can open, release or edit a pot: the admin API and the admin SPA never mention savings", () => {
  const files = ["src/routes/admin.js", ...fs.readdirSync(path.join(ROOT, "public", "admin")).filter((f) => /\.(js|html)$/.test(f)).map((f) => `public/admin/${f}`)];
  assert.ok(files.includes("public/admin/app.js") && files.includes("src/routes/admin.js"), `admin files: ${files}`);
  for (const f of files) {
    const text = read(f);
    assert.ok(!/savings|savingsPot|SavingsPot|savingsMovement|lockUntil|lockMode|POT_LOCKED/i.test(text), `${f} mentions savings`);
  }
  // And the money router itself admits only the owner: no role check, no grant.
  assert.ok(!/role|ADMIN|isAdmin/.test(rt), "no admin bypass in routes/savings.js");
});

test("anchor.getTransfer is gone (its only caller was the removed savings deposit settlement)", () => {
  const anchorSrc = read("src/utils/anchor.js");
  assert.ok(!/getTransfer/.test(anchorSrc), "getTransfer still in utils/anchor.js");
  assert.strictEqual(require("../src/utils/anchor").getTransfer, undefined);
  const hits = [];
  for (const f of [path.join(ROOT, "server.js"), ...walk(SRC).filter((p) => p.endsWith(".js"))]) {
    for (const l of linesMatching(fs.readFileSync(f, "utf8"), /\bgetTransfer\b/)) hits.push(`${path.relative(ROOT, f).replace(/\\/g, "/")}:${l}`);
  }
  assert.deepStrictEqual(hits, [], `found in: ${hits.join(", ")}`);
});

test("executeTransfer's moneyMoved note names its real reader, not the savings service", () => {
  assert.ok(!/the savings service/.test(et), "executeTransfer still says the savings service books a movement before calling it");
  assert.ok(/moneyMoved:false so a caller can tell a refusal/.test(et));
});

test("server.js: /savings is mounted behind apiLimiter, the loop is started, and there is no PiggyVest webhook", () => {
  const src = read("server.js");
  assert.ok(/app\.use\("\/savings", apiLimiter\)/.test(src), "/savings must be rate limited");
  assert.ok(/app\.use\("\/savings", require\("\.\/src\/routes\/savings"\)\)/.test(src), "/savings router not mounted");
  assert.ok(src.indexOf('app.use("/savings", apiLimiter)') < src.indexOf('app.use("/savings", require('), "limiter must precede the router");
  assert.ok(/require\("\.\/src\/utils\/savingsReconcile"\)\.startSavingsReconcileLoop\(/.test(src), "reconcile loop not started");
  assert.ok(!/webhooks\/piggyvest|piggyvestWebhook/i.test(src), "the PiggyVest webhook must be gone");
  assert.ok(!/express\.raw\([^)]*\)[^\n]*savings/i.test(src), "nothing savings-related takes a raw body");
});

// ══ 14. THE PARTNER IS GONE ════════════════════════════════════════════════
section("14. nothing of the PiggyVest integration is left");

test("the removed modules do not exist", () => {
  for (const rel of ["src/services/piggyvest.js", "src/routes/piggyvestWebhook.js", "src/utils/savingsCredit.js"]) {
    assert.ok(!fs.existsSync(path.join(ROOT, rel)), `${rel} still exists`);
  }
});

// "piggyvest" is matched case-insensitively (the partner's name in any
// spelling). The rest are identifiers and are matched exactly: the audit
// actions SAVINGS_DEPOSIT / SAVINGS_WITHDRAWAL are the live feature's own
// names and are not the dead purposes savings_deposit / savings_withdrawal.
const FORBIDDEN = [
  { label: "piggyvest (any case)", re: /piggyvest/i },
  { label: "pvWalletId", re: /pvWalletId/ },
  { label: "savingsCredit", re: /savingsCredit/ },
  { label: "savings_withdrawal", re: /savings_withdrawal/ },
  { label: "savings_deposit", re: /savings_deposit/ },
  { label: "savings_interest", re: /savings_interest/ },
];
const SWEEP_FILES = [path.join(ROOT, "server.js"), ...walk(SRC)];

for (const { label, re } of FORBIDDEN) {
  test(`no file under src/ or server.js mentions ${label}`, () => {
    const hits = [];
    for (const f of SWEEP_FILES) {
      const lines = linesMatching(fs.readFileSync(f, "utf8"), re);
      for (const l of lines) hits.push(`${path.relative(ROOT, f).replace(/\\/g, "/")}:${l}`);
    }
    assert.deepStrictEqual(hits, [], `found in: ${hits.join(", ")}`);
  });
}

test("no live code reads a PiggyVest env var, and the env validator has forgotten it", () => {
  const hits = [];
  for (const f of SWEEP_FILES) {
    const lines = linesMatching(fs.readFileSync(f, "utf8"), /PVB_|PIGGY/);
    for (const l of lines) hits.push(`${path.relative(ROOT, f).replace(/\\/g, "/")}:${l}`);
  }
  assert.deepStrictEqual(hits, [], `found in: ${hits.join(", ")}`);
  assert.ok(!/PVB_|piggy/i.test(read("src/utils/validateEnv.js")));
});

// ══ 14b. WHAT COUNTS AS AN AMOUNT ═════════════════════════════════════════
section("14b. an amount is a number or a plain decimal string, nothing else");

test("validateAmount and validateTarget refuse true, arrays, hex, exponents, objects and blanks", () => {
  for (const v of [true, [5], [3], "0x10", "1e3", {}, null, "", "  ", "-5", Infinity, NaN, "5,000"]) {
    assert.throws(() => savings.validateAmount(v), (e) => e.code === "BAD_AMOUNT", `amount ${JSON.stringify(v)}`);
    assert.throws(() => savings.validateTarget(v), (e) => e.code === "BAD_AMOUNT", `target ${JSON.stringify(v)}`);
  }
});

test("validateAmount takes numbers and plain decimal strings, kept to the kobo", () => {
  assert.strictEqual(savings.validateAmount(2500.07), 2500.07);
  assert.strictEqual(savings.validateAmount("4.35"), 4.35);
  assert.strictEqual(savings.validateAmount(" 100 "), 100);
  assert.strictEqual(savings.validateAmount(0.1 + 0.2), 0.3);
});

// ══ 15. THE DELETION REFUSAL ═══════════════════════════════════════════════
section("15. deleting around a pot with money: refused, naming the pot and the day it opens");

{
  const NOW = new Date("2026-10-15T10:00:00.000Z");
  const OPENS_SOON = new Date("2026-12-31T23:00:00.000Z"); // 00:00 Lagos, 1 Jan 2027
  const OPENS_LATE = new Date("2028-03-14T23:00:00.000Z"); // 00:00 Lagos, 15 Mar 2028
  const pot = (over) => ({ id: "p", businessId: "b1", name: "Pot", lockUntil: null, lockMode: null, ...over });

  test("no pot with money → nothing blocks", () => {
    assert.strictEqual(savings.pickBlockingPot([], NOW), null);
    assert.strictEqual(savings.pickBlockingPot(null, NOW), null);
  });

  test("an Unbreakable pot that has not opened is named first, the one opening last, with its Lagos day", () => {
    const b = savings.pickBlockingPot([
      pot({ id: "a", name: "Open pot" }),
      pot({ id: "b", name: "Soon", lockMode: "strict", lockUntil: OPENS_SOON }),
      pot({ id: "c", name: "School fees", lockMode: "strict", lockUntil: OPENS_LATE, businessId: "b2" }),
      pot({ id: "d", name: "Breakable", lockMode: "flexible", lockUntil: OPENS_LATE }),
    ], NOW);
    assert.deepStrictEqual(b, { potId: "c", businessId: "b2", businessName: null, potName: "School fees", unbreakable: true, opensOn: "2028-03-15" });
    // The pot's business name comes with it when it was read (savingsBlockingDeletion selects it).
    const named = savings.pickBlockingPot([pot({ name: "Rent", business: { name: "Jegede Stores" } })], NOW);
    assert.strictEqual(named.businessName, "Jegede Stores");
  });

  test("otherwise the first pot with money; opensOn is its day while it is locked, null once open or unlocked", () => {
    assert.deepStrictEqual(savings.pickBlockingPot([pot({ id: "a", name: "Rent" }), pot({ id: "b" })], NOW),
      { potId: "a", businessId: "b1", businessName: null, potName: "Rent", unbreakable: false, opensOn: null });
    assert.deepStrictEqual(savings.pickBlockingPot([pot({ name: "Holiday", lockMode: "flexible", lockUntil: OPENS_SOON })], NOW),
      { potId: "p", businessId: "b1", businessName: null, potName: "Holiday", unbreakable: false, opensOn: "2027-01-01" });
    // An Unbreakable pot whose day has come is open: anyone may empty it now.
    assert.deepStrictEqual(savings.pickBlockingPot([pot({ name: "Done", lockMode: "strict", lockUntil: new Date(NOW.getTime() - 1) })], NOW),
      { potId: "p", businessId: "b1", businessName: null, potName: "Done", unbreakable: false, opensOn: null });
    // At its very moment it is open too.
    assert.strictEqual(savings.pickBlockingPot([pot({ lockMode: "strict", lockUntil: NOW })], NOW).unbreakable, false);
  });

  test("savingsRemainingBody: the Unbreakable refusal names the pot and the day, nobody, not even KashBook", () => {
    const block = { potName: "School fees", unbreakable: true, opensOn: "2028-03-15", potId: "c", businessId: "b2", businessName: "Jegede Stores" };
    const acct = savings.savingsRemainingBody(block, "account");
    // The refusal goes only to the pot's owner (delete-account reads the
    // caller's own businesses; DELETE /businesses checks ownership first), and
    // names the owner's own business so the app opens that one's savings. The
    // pot id never leaves.
    assert.deepStrictEqual(Object.keys(acct).sort(), ["businessId", "businessName", "code", "error", "opensOn", "potName", "unbreakable"], "the contract's fields, the owner's own business, never the pot id");
    assert.strictEqual(acct.businessId, "b2");
    assert.strictEqual(acct.businessName, "Jegede Stores");
    assert.strictEqual(acct.code, "SAVINGS_REMAINING");
    assert.strictEqual(acct.potName, "School fees");
    assert.strictEqual(acct.opensOn, "2028-03-15");
    assert.strictEqual(acct.unbreakable, true);
    assert.strictEqual(acct.error, 'Your savings pot "School fees" is unbreakable and opens on 15 Mar 2028. Nobody, not even KashBook, can take the money out before then. After that, take it out and close the pot, then delete your account.');
    const biz = savings.savingsRemainingBody(block, "business");
    assert.strictEqual(biz.error, 'The savings pot "School fees" is unbreakable and opens on 15 Mar 2028. Nobody, not even KashBook, can take the money out before then. After that, take it out and close the pot, then delete this business.');
  });

  test("savingsRemainingBody: any other pot asks to take the money out and close it first", () => {
    const acct = savings.savingsRemainingBody({ potName: "Rent", unbreakable: false, opensOn: null }, "account");
    assert.deepStrictEqual(acct, { code: "SAVINGS_REMAINING", error: 'Your savings pot "Rent" still has money in it. Take it out and close the pot first, then delete your account.', potName: "Rent", opensOn: null, unbreakable: false, businessId: null, businessName: null });
    const biz = savings.savingsRemainingBody({ potName: "Van", unbreakable: false, opensOn: "2027-01-01" }, "business");
    assert.strictEqual(biz.error, 'The savings pot "Van" still has money in it. Take it out and close the pot first, then delete this business.');
    assert.strictEqual(biz.opensOn, "2027-01-01", "a Breakable pot's day is still reported");
    assert.strictEqual(biz.unbreakable, false);
  });

  test("savingsBlockingDeletion reads open pots with money of exactly the given businesses, oldest first", () => {
    const body = fnBody(sv, "async function savingsBlockingDeletion(");
    assert.ok(/where: \{ businessId: \{ in: ids \}, status: \{ not: "closed" \}, balance: POT_HOLDS_MONEY \}/.test(body), "pot query");
    assert.ok(/orderBy: \[\{ createdAt: "asc" \}, \{ id: "asc" \}\]/.test(body), "oldest first, so the answer is stable");
    assert.ok(/if \(!ids\.length\) return null/.test(body), "no business, nothing to check (and no query)");
    assert.ok(/return pickBlockingPot\(pots, now\)/.test(body));
  });
}

(async () => {
  if (asyncTests.length) section("16. the tests that wait on a stubbed bank");
  for (const [name, fn] of asyncTests) {
    try { await fn(); console.log(`  PASS  ${name}`); passed++; }
    catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); failed++; }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
