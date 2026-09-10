// Euro → naira conversion: the pure parts, plus structural guards. No network,
// no DB.
//   node scripts/fcy-conversion-test.js
//
// The money path itself (quote → PIN → convert → pay out → land) needs Fincra
// and Postgres and is exercised against sandbox by hand. What CAN be pinned
// here is everything a wrong answer would silently mis-pay: the margin
// arithmetic, matching Anchor's bank name to Fincra's bank code, the name
// check on the payout target, and that the table the code writes to is the
// table the migration creates.
const assert = require("assert");
const fs = require("fs");
const path = require("path");

process.env.JWT_SECRET = process.env.JWT_SECRET || "x".repeat(48);
process.env.CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || "testcloud";
process.env.CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY || "123456789012345";
process.env.CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET || "test_secret_value";

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); failed++; }
}
function section(t) { console.log(`\n── ${t} ${"─".repeat(Math.max(0, 56 - t.length))}`); }

const fcy = require("../src/utils/fcyConversion");
const SRC = path.join(__dirname, "..", "src");

// ══ 1. MARGIN ══════════════════════════════════════════════════════════════
section("1. the merchant is never paid a kobo we did not receive");

test("default margin is zero: merchant gets Fincra's full amount", () => {
  delete process.env.FCY_CONVERSION_MARGIN_BPS;
  assert.strictEqual(fcy.applyMargin(150000), 150000);
  assert.strictEqual(fcy.applyMargin(1234.56), 1234.56);
});

test("margin in basis points comes off the naira side", () => {
  assert.strictEqual(fcy.applyMargin(100000, 100), 99000);   // 1%
  assert.strictEqual(fcy.applyMargin(100000, 50), 99500);    // 0.5%
});

test("result is FLOORED to the kobo, never rounded up", () => {
  assert.strictEqual(fcy.applyMargin(100.005, 0), 100);
  assert.strictEqual(fcy.applyMargin(99.999, 0), 99.99);
  assert.strictEqual(fcy.applyMargin(1000, 33), 996.7);      // 996.7 exactly, not 996.71
});

test("a runaway margin in the env is capped at 5%", () => {
  process.env.FCY_CONVERSION_MARGIN_BPS = "5000"; // "50%" typo
  assert.strictEqual(fcy.applyMargin(100000), 95000);
  process.env.FCY_CONVERSION_MARGIN_BPS = "-100";
  assert.strictEqual(fcy.applyMargin(100000), 100000);
  process.env.FCY_CONVERSION_MARGIN_BPS = "garbage";
  assert.strictEqual(fcy.applyMargin(100000), 100000);
  delete process.env.FCY_CONVERSION_MARGIN_BPS;
});

// ══ 2. BANK MATCHING ═══════════════════════════════════════════════════════
section("2. Anchor's bank name resolves to exactly one Fincra bank code");

const BANKS = [
  { code: "120001", name: "9 Payment Service Bank" },
  { code: "000023", name: "Providus Bank" },
  { code: "000013", name: "Guaranty Trust Bank" },
  { code: "000014", name: "Access Bank" },
  { code: "000005", name: "Access Bank (Diamond)" },
  { code: "090110", name: "VFD Microfinance Bank" },
];

for (const [held, expect] of [
  ["Providus Bank", "000023"],
  ["PROVIDUS BANK PLC", "000023"],
  ["Providus", "000023"],
  ["9 Payment Service Bank", "120001"],
  ["9PSB", "120001"],
  ["9 PAYMENT SERVICE BANK LIMITED", "120001"],
  ["Guaranty Trust Bank", "000013"],
  ["GTBank", null],            // not spelled that way in the list; refuse, do not guess
  ["Access Bank", "000014"],   // exact beats the "(Diamond)" partial
  ["VFD MFB", "090110"],
]) {
  test(`"${held}" → ${expect === null ? "no match (refuse)" : expect}`, () => {
    assert.strictEqual(fcy.matchBankCode(BANKS, held), expect);
  });
}

test("Fincra spelling 9PSB matches our 9 Payment Service Bank", () => {
  const banks = [{ code: "120001", name: "9PSB" }, { code: "000023", name: "Providus Bank" }];
  assert.strictEqual(fcy.matchBankCode(banks, "9 Payment Service Bank"), "120001");
});

test("ambiguity refuses rather than picking the first", () => {
  const banks = [{ code: "1", name: "Union Bank" }, { code: "2", name: "Union Bank" }];
  assert.strictEqual(fcy.matchBankCode(banks, "Union Bank"), null);
});

test("empty inputs refuse", () => {
  assert.strictEqual(fcy.matchBankCode(BANKS, ""), null);
  assert.strictEqual(fcy.matchBankCode(BANKS, null), null);
  assert.strictEqual(fcy.matchBankCode([], "Providus Bank"), null);
  assert.strictEqual(fcy.matchBankCode(null, "Providus Bank"), null);
});

// ══ 3. NAME CHECK ══════════════════════════════════════════════════════════
section("3. the payout target must be the same person");

for (const [a, b, expect] of [
  ["SEYI EMMANUEL JEGEDE", "Jegede Seyi", true],
  ["Ada Obi", "OBI ADA CHIOMA", true],
  ["Ada Stores", "ADA STORES LTD", true],
  ["Ada Obi", "Chukwu Emeka", false],
  ["JOHN SMITH", "Jon Smyth", false],
  ["Ada Obi", "", true],           // nothing to compare: do not block on missing data
  ["", "Ada Obi", true],
]) {
  test(`"${a}" vs "${b}" → ${expect ? "same" : "DIFFERENT"}`, () => {
    assert.strictEqual(fcy.namesOverlap(a, b), expect);
  });
}

// ══ 4. STRUCTURE ═══════════════════════════════════════════════════════════
section("4. the table the code writes is the table the migration creates");

function migrationColumns() {
  const dir = path.join(__dirname, "..", "prisma", "migrations");
  const folder = fs.readdirSync(dir).find((f) => f.endsWith("_fcy_conversions"));
  assert.ok(folder, "no *_fcy_conversions migration folder");
  const sql = fs.readFileSync(path.join(dir, folder, "migration.sql"), "utf8");
  // Start AFTER the opening paren, or the table name itself reads as a column.
  const open = sql.indexOf('"FcyConversion" (') + '"FcyConversion" ('.length;
  const body = sql.slice(open, sql.indexOf("CONSTRAINT \"FcyConversion_pkey\""));
  return new Set([...body.matchAll(/^\s*"(\w+)"\s+/gm)].map((m) => m[1]));
}

function modelFields() {
  const schema = fs.readFileSync(path.join(__dirname, "..", "prisma", "schema.prisma"), "utf8");
  const start = schema.indexOf("model FcyConversion {");
  assert.ok(start >= 0, "FcyConversion model missing from schema.prisma");
  const body = schema.slice(start, schema.indexOf("\n}", start));
  return new Set(
    [...body.matchAll(/^\s+(\w+)\s+(String|Int|Float|DateTime|Boolean|Json)/gm)].map((m) => m[1]),
  );
}

test("every Prisma field has a column, and every column a field", () => {
  const cols = migrationColumns();
  const fields = modelFields();
  const missingCols = [...fields].filter((f) => !cols.has(f));
  const missingFields = [...cols].filter((c) => !fields.has(c));
  assert.deepStrictEqual(missingCols, [], `fields with no column: ${missingCols}`);
  assert.deepStrictEqual(missingFields, [], `columns with no field: ${missingFields}`);
});

test("the migration is additive: no DROP, no ALTER of an existing table", () => {
  const dir = path.join(__dirname, "..", "prisma", "migrations");
  const folder = fs.readdirSync(dir).find((f) => f.endsWith("_fcy_conversions"));
  const sql = fs.readFileSync(path.join(dir, folder, "migration.sql"), "utf8");
  assert.ok(!/\bDROP\b/i.test(sql), "migration contains DROP");
  const alters = [...sql.matchAll(/ALTER TABLE\s+"(\w+)"/gi)].map((m) => m[1]);
  assert.deepStrictEqual([...new Set(alters)], ["FcyConversion"], `ALTER touches other tables: ${alters}`);
});

test("both references are unique in the model (a retry can never pay twice)", () => {
  const schema = fs.readFileSync(path.join(__dirname, "..", "prisma", "schema.prisma"), "utf8");
  const body = schema.slice(schema.indexOf("model FcyConversion {"));
  assert.ok(/customerReference\s+String\s+@unique/.test(body), "customerReference not @unique");
  assert.ok(/payoutCustomerReference\s+String\s+@unique/.test(body), "payoutCustomerReference not @unique");
});

// ══ 5. THE LEDGER STAYS HONEST ═════════════════════════════════════════════
section("5. naira is never booked before it lands");

test("fcyConversion writes only the EUR leg; the naira row is Anchor's", () => {
  const src = fs.readFileSync(path.join(SRC, "utils", "fcyConversion.js"), "utf8");
  const creates = [...src.matchAll(/prisma\.transaction\.create\(\{[\s\S]*?\}\)/g)].map((m) => m[0]);
  assert.strictEqual(creates.length, 1, `expected exactly one ledger write, found ${creates.length}`);
  assert.ok(/type:\s*"expense"/.test(creates[0]), "the one ledger write must be the EUR expense");
  assert.ok(/currency:\s*row\.sourceCurrency/.test(creates[0]), "the EUR row must carry the source currency");
  assert.ok(!/type:\s*"income"/.test(src), "fcyConversion must never book income");
});

test("AML money-out windows are currency-scoped (a EUR conversion is not naira velocity)", () => {
  for (const rel of ["utils/amlChecks.js", "routes/transfers.js"]) {
    const src = fs.readFileSync(path.join(SRC, rel), "utf8");
    const idx = src.indexOf("source: { in: MONEY_OUT_SOURCES }");
    assert.ok(idx > 0, `${rel}: MONEY_OUT_SOURCES query not found`);
    const window = src.slice(Math.max(0, idx - 400), idx);
    assert.ok(/currency:/.test(window), `${rel}: the money-out window has no currency filter`);
  }
});

test("the payout webhook routes conversion refs to the recorder, not the warning", () => {
  const src = fs.readFileSync(path.join(SRC, "routes", "fincra.js"), "utf8");
  assert.ok(/recordConversionPayoutOutcome\(d,\s*outcome\)/.test(src), "payout events do not reach recordConversionPayoutOutcome");
});

test("isConversionPayoutRef recognises only our payout references", () => {
  assert.strictEqual(fcy.isConversionPayoutRef("kb_cvp_abc"), true);
  assert.strictEqual(fcy.isConversionPayoutRef("kb_cv_abc"), false);
  assert.strictEqual(fcy.isConversionPayoutRef("kb_tf_abc"), false);
  assert.strictEqual(fcy.isConversionPayoutRef(""), false);
  assert.strictEqual(fcy.isConversionPayoutRef(null), false);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
