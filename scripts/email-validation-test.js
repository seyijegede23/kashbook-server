// Email validation. No network, no DB.
//   node scripts/email-validation-test.js
//
// The bug: sign-up and login accepted emoji in the email field. Every server
// check was `includes("@")` or /\S+@\S+\.\S+/, and an emoji is not whitespace.
// These tests pin the shape we accept, and pin the app's copy of the validator
// to the server's so the two cannot drift.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { isValidEmail, normalizeEmail } = require("../src/utils/email");

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); failed++; }
}
function section(t) { console.log(`\n── ${t} ${"─".repeat(Math.max(0, 56 - t.length))}`); }

// ══ 1. ACCEPTED ════════════════════════════════════════════════════════════
section("1. real addresses are accepted");

for (const good of [
  "ada@example.com",
  "ada.obi@example.com",
  "ada+kashbook@example.com",
  "ada_obi%tag@example.co.uk",
  "ADA@EXAMPLE.COM",
  "a@b.co",
  "ada@sub.domain.example.ng",
  "ada@my-shop.com",
  "12345@example.com",
  "ada@example.photography", // long TLD
  "  ada@example.com  ",     // surrounding whitespace is trimmed
]) {
  test(`accepts ${JSON.stringify(good)}`, () => {
    assert.strictEqual(isValidEmail(good), true);
  });
}

// ══ 2. REJECTED ════════════════════════════════════════════════════════════
section("2. the reported bug and its neighbours are rejected");

for (const [label, bad] of [
  ["emoji local part",            "😀@example.com"],
  ["emoji domain",                "ada@😀.com"],
  ["emoji everywhere",            "😀@😀.😀"],
  ["emoji tucked inside",         "ada😀obi@example.com"],
  ["accented letter",             "adé@example.com"],
  ["Arabic script",               "عدا@example.com"],
  ["zero-width space",            "ada​@example.com"],
  ["non-breaking space",          "ada @example.com"],
  ["space inside",                "ada obi@example.com"],
  ["no @",                        "ada.example.com"],
  ["two @",                       "ada@@example.com"],
  ["@ twice apart",               "ada@obi@example.com"],
  ["no TLD",                      "ada@example"],
  ["single-letter TLD",           "ada@example.c"],
  ["numeric TLD",                 "ada@example.123"],
  ["leading dot in local",        ".ada@example.com"],
  ["trailing dot in local",       "ada.@example.com"],
  ["doubled dot in local",        "ada..obi@example.com"],
  ["leading dot in domain",       "ada@.example.com"],
  ["trailing dot in domain",      "ada@example.com."],
  ["doubled dot in domain",       "ada@example..com"],
  ["hyphen at label start",       "ada@-example.com"],
  ["hyphen at label end",         "ada@example-.com"],
  ["empty local",                 "@example.com"],
  ["empty domain",                "ada@"],
  ["empty string",                ""],
  ["whitespace only",             "   "],
  ["null",                        null],
  ["undefined",                   undefined],
  ["a number",                    12345],
  ["local part over 64",          "a".repeat(65) + "@example.com"],
  ["whole address over 254",      "a".repeat(64) + "@" + "b".repeat(63) + "." + "c".repeat(63) + "." + "d".repeat(63) + ".com"],
  ["angle-bracket form",          "<ada@example.com>"],
  ["display-name form",           "Ada Obi <ada@example.com>"],
  ["url, not an address",         "https://example.com"],
  ["phone number",                "+2348000000000"],
]) {
  test(`rejects ${label}`, () => {
    assert.strictEqual(isValidEmail(bad), false, `${JSON.stringify(bad)} was accepted`);
  });
}

// ══ 3. NORMALISATION ═══════════════════════════════════════════════════════
section("3. normalizeEmail");

test("lower-cases and trims a valid address", () => {
  assert.strictEqual(normalizeEmail("  Ada.Obi@Example.COM "), "ada.obi@example.com");
});
test("returns null, not a string, for an invalid one", () => {
  assert.strictEqual(normalizeEmail("😀@example.com"), null);
  assert.strictEqual(normalizeEmail(""), null);
  assert.strictEqual(normalizeEmail(undefined), null);
});
test("the plus tag survives (it is how people route mail)", () => {
  assert.strictEqual(normalizeEmail("ada+shop@example.com"), "ada+shop@example.com");
});

// ══ 4. THE APP AGREES WITH THE SERVER ══════════════════════════════════════
section("4. the mobile copy is identical");

test("src/utils/validators.js carries the same EMAIL_RE as the server", () => {
  const mobile = path.join(__dirname, "..", "..", "src", "utils", "validators.js");
  if (!fs.existsSync(mobile)) return; // server checked out alone
  const pick = (file) => {
    const m = fs.readFileSync(file, "utf8").match(/const EMAIL_RE = (\/.+\/[a-z]*);/);
    assert.ok(m, `no EMAIL_RE literal in ${path.basename(file)}`);
    return m[1];
  };
  const server = pick(path.join(__dirname, "..", "src", "utils", "email.js"));
  const app = pick(mobile);
  assert.strictEqual(app, server,
    "the app and the server disagree about what an email is:\n" +
    `        server ${server}\n        app    ${app}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
