// Savings (ledger pots): the pure parts, plus structural guards. No network, no DB.
//   node scripts/savings-test.js
//
// A pot moves no money. Its balance is a reserve that executeTransfer subtracts
// in its balance gate; deposits and withdrawals are single atomic writes under
// the business lock; breaking a flexible lock early costs a fee that is swept
// to KashBook's fee account and booked as a Transaction with purpose
// "savings_fee". What CAN be pinned here is everything a wrong answer would
// silently mis-book: the reserve arithmetic behind the spend gate, lock
// semantics, the break-fee schedule, the idempotent replay, which rows reports
// skip and the ledger keeps; and, read from the source as text, that the
// guards sit in the order the design names, that the migration matches the
// schema, and that nothing of the removed PiggyVest integration is left.
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
function section(t) { console.log(`\n── ${t} ${"─".repeat(Math.max(0, 56 - t.length))}`); }

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "src");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const savings = require("../src/utils/savings");
const { netSpendable } = require("../src/utils/savingsReserve");
const fees = require("../src/config/fees");
const { MONEY_EPS } = fees;
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
section("2. a strict lock is server-enforced, a flexible one asks");

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

// ══ 3. BREAKING A FLEXIBLE LOCK ════════════════════════════════════════════
section("3. breaking a flexible lock costs 2%, at least ₦100, never more than the amount");

const withFeeEnv = (env, fn) => {
  const keys = ["ANCHOR_FEE_ACCOUNT_ID", "SAVINGS_BREAK_FEE_BPS", "SAVINGS_BREAK_FEE_MIN"];
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

test("floored at ₦100, capped at the amount itself", () => withFeeEnv(FEE_ENV, () => {
  assert.strictEqual(fees.computeBreakFee(1_000).fee, 100);
  assert.strictEqual(fees.computeBreakFee(4_999).fee, 100);
  assert.strictEqual(fees.computeBreakFee(5_000).fee, 100);
  assert.strictEqual(fees.computeBreakFee(5_050).fee, 101);
  assert.strictEqual(fees.computeBreakFee(60).fee, 60, "a ₦60 withdrawal cannot cost ₦100");
  assert.strictEqual(fees.computeBreakFee(100).fee, 100);
  assert.strictEqual(fees.computeBreakFee(0.01).fee, 0.01);
  assert.strictEqual(fees.computeBreakFee(0).fee, 0);
  assert.strictEqual(fees.computeBreakFee(-5).fee, 0);
  assert.strictEqual(fees.computeBreakFee("abc").fee, 0);
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
  assert.strictEqual(fees.breakFeeConfig().min, 100);
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

test("moneySources: SAVINGS_PURPOSES === [\"savings_fee\"], frozen", () => {
  assert.deepStrictEqual([...moneySources.SAVINGS_PURPOSES], ["savings_fee"]);
  assert.ok(Object.isFrozen(moneySources.SAVINGS_PURPOSES), "SAVINGS_PURPOSES must be frozen");
  assert.deepStrictEqual(moneySources.NOT_SAVINGS, { purpose: null });
  assert.ok(Object.isFrozen(moneySources.NOT_SAVINGS), "NOT_SAVINGS must be frozen (it is spread into many where clauses)");
  assert.strictEqual(moneySources.SQL_NOT_SAVINGS, 'AND "purpose" IS NULL');
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

test("the app's matchedCredit.js lists exactly [\"savings_fee\"] and skips savings rows in reports", () => {
  const client = fs.readFileSync(path.join(ROOT, "..", "src", "utils", "matchedCredit.js"), "utf8");
  const m = client.match(/export const SAVINGS_PURPOSES\s*=\s*(\[[^\]]*\])/);
  assert.ok(m, "the app's matchedCredit.js must export SAVINGS_PURPOSES");
  assert.deepStrictEqual(JSON.parse(m[1].replace(/'/g, '"')), ["savings_fee"]);
  assert.ok(/export const isSavingsRow/.test(client), "the app must export isSavingsRow");
  assert.ok(/isExcludedFromReports[\s\S]*isSavingsRow\(t\)/.test(client), "report sums must drop savings rows");
  assert.ok(!/savings_deposit|savings_withdrawal|savings_interest/.test(client), "the app must not know the dead purposes");
});

// ══ 6. THE SWITCH ══════════════════════════════════════════════════════════
section("6. SAVINGS_ENABLED gates creation and deposits only, on the literal \"true\"");

const sv = read("src/utils/savings.js");

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
  assert.ok(!/isEnabled\(\)/.test(fnBody(sv, "async function collectBreakFee(")), "the fee sweep must run with the switch off");
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

// ══ 9. REPORTING EXCLUDES SAVINGS, THE LEDGER KEEPS THEM ═══════════════════
section("9. savings rows are left out of reports and kept in the ledger, AML windows and the staff cap");

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
    // outbound transfers (snapshots.js ops telemetry) is not a money figure,
    // so counts are not in scope here.
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

// Since 2026-10-09 the daily report totals through the books rule, which counts
// nothing for a bank row that carries a purpose (savings rows included).
test("dailyReport.js: totals come from booksFor, and the books rule drops purpose rows", () => {
  const src = read("src/utils/dailyReport.js");
  assert.ok(/booksFor\(/.test(src), "dailyReport does not use booksFor");
  assert.strictEqual(transactionCalls(src).length, 0, "dailyReport queries bank rows directly again");
  const { bankCountedAmount } = require("../src/utils/books");
  assert.strictEqual(bankCountedAmount({ type: "expense", amount: 100, purpose: "savings_fee" }), 0);
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
  const fee = fnBody(sv, "async function collectBreakFee(");
  assert.ok(/anchor\.createBookTransfer\(/.test(fee), "the one book transfer must live in collectBreakFee");
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
  assert.ok(/px\.savingsMovement\.create\(/.test(body) && /type: "deposit", amount: amt, status: "completed", reference, completedAt: new Date\(\)/.test(body), "the movement row is written in the same $transaction, completed");
  assert.ok(body.indexOf("px.savingsPot.updateMany(") < body.indexOf("px.savingsMovement.create("), "claim before the movement row");
});

test("depositToPot: BALANCE_UNAVAILABLE fails closed, spendable gates the amount, idempotency replays", () => {
  const body = fnBody(sv, "async function depositToPot(");
  assert.ok(/try \{ live = await getSpendableBalance\(biz\); \}/.test(body), "the bank read is wrapped");
  assert.ok(/"BALANCE_UNAVAILABLE", 503/.test(body), "an unreadable bank must refuse with 503, never deposit on a guess");
  assert.ok(/"NO_BANKING", 503/.test(body), "ANCHOR_NOT_CONFIGURED maps to NO_BANKING 503");
  mustPrecede(body, "BALANCE_UNAVAILABLE", "prisma.$transaction(async (px)", "deposit");
  assert.ok(/if \(live\.spendable \+ MONEY_EPS < amt\)/.test(body), "deposit must refuse beyond spendable (with the kobo tolerance)");
  assert.ok(/"INSUFFICIENT_BALANCE", 400, \{ availableBalance: live\.spendable, reserved: live\.reserved \}/.test(body), "INSUFFICIENT_BALANCE names spendable and reserved");
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
  assert.ok(/lock\.code === "POT_LOCKED" \? 423 : 409/.test(w), "POT_LOCKED is 423, the confirmation ask is 409");
  mustPrecede(w, "if (!lock.ok) {", "const fee = lock.early ? breakFee.fee : 0", "withdraw");
  assert.ok(/if \(fee > 0\) \{\s*await collectBreakFee\(result\.movement\.id\)\.catch\(/.test(w), "the sweep runs right after the withdrawal and never fails it");
  mustPrecede(w, "prisma.$transaction(async (px)", "await collectBreakFee(result.movement.id)", "withdraw");
  assert.ok(/early: !!lock\.early, fee \}/.test(w), "the audit row names early and the fee");
});

test("collectBreakFee: feeCollectedAt is claimed BEFORE the book transfer, the row is a savings_fee expense, a failure stays claimed", () => {
  const body = fnBody(sv, "async function collectBreakFee(");
  const claim = "where: { id: mv.id, feeCollectedAt: null }, data: { feeCollectedAt: new Date() }";
  mustPrecede(body, claim, "anchor.createBookTransfer(", "break fee");
  assert.ok(/if \(claim\.count !== 1\) return false/.test(body), "the claim count is checked");
  assert.strictEqual(countOf(body, "anchor.createBookTransfer("), 1, "exactly one book transfer");
  // Nothing to collect, or nowhere to collect it → out before the claim.
  mustPrecede(body, 'mv.type !== "withdrawal" || mv.status !== "completed" || !(Number(mv.fee) > 0) || mv.feeCollectedAt', claim, "break fee");
  mustPrecede(body, "process.env.ANCHOR_FEE_ACCOUNT_ID", claim, "break fee");
  mustPrecede(body, "if (!biz?.anchorAccountId) return false", claim, "break fee");
  // The transfer and its ledger row.
  const xfer = callArg(body, body.indexOf("(", body.indexOf("anchor.createBookTransfer(")));
  assert.ok(/fromAccountId: biz\.anchorAccountId/.test(xfer) && /toAccountId: feeAccount/.test(xfer) && /amount: fee/.test(xfer), "merchant → fee account, the fee");
  assert.ok(/reference,/.test(xfer) && /const reference = `\$\{mv\.reference\}_bfee`/.test(body), "the sweep's reference derives from the movement's (Anchor dedups on it)");
  const create = callArg(body, body.indexOf("(", body.indexOf("prisma.transaction.create(")));
  assert.ok(/purpose: "savings_fee"/.test(create), "the fee row carries purpose savings_fee");
  assert.ok(/type: "expense"/.test(create) && /category: "transfer"/.test(create) && /paymentMethod: "bank"/.test(create) && /source: "anchor"/.test(create), "the fee row is a bank expense the ledger counts");
  assert.ok(/providerTxnId: book\?\.transferId/.test(create), "the fee row stores Anchor's transfer id");
  assert.ok(/amount: fee/.test(create));
  assert.ok(/e\.code !== "P2002"/.test(body), "a duplicate ledger row (retry) is tolerated");
  assert.ok(/adjustBalance\(biz\.id, -fee\)/.test(body), "the balance cache drops by the fee");
  // Failure: alert + audit, never un-claim, never retry.
  const after = body.slice(body.indexOf("} catch (e) {"));
  assert.ok(/SAVINGS_BREAK_FEE_FAILED/.test(after) && /severity: "alert"/.test(after), "a failed sweep is audited at alert severity");
  assert.ok(/fireAlert\(`savings-break-fee-\$\{mv\.id\}`/.test(after), "a failed sweep pages a human");
  assert.ok(!/feeCollectedAt: null \}/.test(after), "a failed sweep must stay claimed (never charged twice)");
  assert.ok(/return false/.test(after), "a failed sweep returns false");
  assert.ok(/const fee = Math\.round\(Number\(mv\.fee\) \* 100\) \/ 100/.test(body), "the swept fee is the stored fee, to the kobo");
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
  const body = fnBody(sv, "async function assertNotFrozen(");
  assert.ok(/biz\?\.accountStatus && biz\.accountStatus !== "active"/.test(body), "business freeze");
  assert.ok(/owner\?\.accountStatus && owner\.accountStatus !== "active"/.test(body), "owner freeze");
  assert.strictEqual(countOf(body, '"FROZEN", 423'), 2);
  for (const fn of ["depositToPot", "withdrawFromPot"]) {
    const b = fnBody(sv, `async function ${fn}(`);
    assert.ok(b.indexOf("prisma.withBusinessLock(biz.id") < b.indexOf("await assertNotFrozen(biz)"), `${fn}: freeze check must be inside the lock`);
  }
});

test("amounts are positive, 2-dp numbers; references derive from the client key with a per-prefix namespace", () => {
  const va = fnBody(sv, "function validateAmount(");
  assert.ok(/if \(!\(n > 0\)\) throw/.test(va) && /if \(!money2dp\(n\)\) throw/.test(va));
  assert.ok(/const depositRef = \(key\) => keyedRef\(DEPOSIT_REF_PREFIX, key\)/.test(sv));
  assert.ok(/const withdrawalRef = \(key\) => keyedRef\(WITHDRAWAL_REF_PREFIX, key\)/.test(sv));
  assert.ok(/replace\(\/\[\^a-zA-Z0-9\]\/g, ""\)\.slice\(0, 40\)/.test(sv), "the client key is sanitised and bounded");
  assert.ok(/crypto\.randomBytes\(8\)\.toString\("hex"\)/.test(sv), "a missing key gets a random reference (no accidental replay)");
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
  assert.ok(/breakFee: breakFeeView\(\)/.test(body));
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

test("the loop does exactly three things: uncollected break fees, pot drift, over-reserve", () => {
  const body = fnBody(rec, "async function reconcileSavings(");
  assert.ok(/stats = \{ feesCollected: 0, drift: 0, overReserved: 0, errors: 0 \}/.test(body), "stats shape");
  // 1. fee backstop
  assert.ok(/type: "withdrawal", status: "completed", fee: \{ gt: 0 \}, feeCollectedAt: null/.test(body), "backstop selects completed withdrawals with an unswept fee");
  assert.ok(/savings\.collectBreakFee\(m\.id\)/.test(body), "the backstop goes through collectBreakFee (which claims first)");
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
  assert.ok(!/updateMany|\.update\(|\.create\(/.test(body), "the loop only reads, sweeps through collectBreakFee, and alerts; it never edits a pot");
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

test("routes/auth.js: /delete-account refuses while a pot holds money, and /me reports features.savings", () => {
  const src = read("src/routes/auth.js");
  const body = handlerBody(src, "post", "/delete-account");
  assert.ok(/prisma\.savingsPot\.findFirst\(\{\s*where: \{ businessId: \{ in: bizIds \}, status: \{ not: "closed" \}, balance: \{ gt: 0\.004 \} \}/.test(body), "pot balance guard");
  assert.ok(/code: "SAVINGS_REMAINING"/.test(body), "SAVINGS_REMAINING code");
  mustPrecede(body, 'code: "SAVINGS_REMAINING"', "prisma.$transaction(", "delete-account: the guard must run before anything is deleted");
  assert.ok(!/savingsMovement/.test(body), "there are no in-flight movements to wait for any more");
  assert.ok(/savings: process\.env\.SAVINGS_ENABLED === "true"/.test(src), "features.savings");
  assert.ok(!/savingsInterest/.test(src), "features.savingsInterest is gone");
});

test("routes/businesses.js: DELETE /:id refuses while a pot holds money; the balance route reports spendable", () => {
  const bz = read("src/routes/businesses.js");
  const del = handlerBody(bz, "delete", "/:id");
  assert.ok(/prisma\.savingsPot\.findFirst\(\{\s*where: \{ businessId: req\.params\.id, status: \{ not: "closed" \}, balance: \{ gt: 0\.004 \} \}/.test(del), "pot balance guard");
  assert.ok(/code: "SAVINGS_REMAINING"/.test(del), "SAVINGS_REMAINING code");
  mustPrecede(del, 'code: "SAVINGS_REMAINING"', "prisma.business.deleteMany(", "DELETE /:id: the guard must run before the delete");
  const bal = handlerBody(bz, "get", "/:id/balance");
  assert.ok(/balance: netSpendable\(gross, reserved\), grossBalance: gross, savingsReserved: reserved/.test(bal), "businesses balance route");
  assert.ok(/getReservedBalance\(biz\.id\)/.test(bal), "the reserve is read fresh, never cached");
  assert.ok(/balance: 0, grossBalance: 0, savingsReserved: 0, hasAccount: false/.test(bal), "no account → zeros");
});

test("routes/transfers.js and salaryRunner.js pay from spendable", () => {
  const tr = read("src/routes/transfers.js");
  assert.ok(/getSpendableBalance\(biz\)/.test(tr) && /balance: spendable, grossBalance: gross, savingsReserved: reserved/.test(tr), "transfers balance route");
  const sr = read("src/utils/salaryRunner.js");
  assert.ok(/getSpendableBalance\(biz\)\)\.spendable/.test(sr), "salary runner must pay from spendable");
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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
