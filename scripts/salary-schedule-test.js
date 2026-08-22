// Staff Payments — pure tests. No DB, no network.
//   node scripts/salary-schedule-test.js
//
// What these protect, in order of how much money is at stake:
//   1. pay-date arithmetic (a drifting payday pays the wrong month, forever)
//   2. period identity (the anti-double-pay key is derived from it)
//   3. consent matching (a drifted amount must pay nobody)
const assert = require("assert");

const {
  computeNextPayDate,
  periodKeyFor,
  referenceFor,
  consentMatches,
  isLapsed,
  lagosParts,
  shiftForWeekend,
} = require("../src/utils/salarySchedule");

let passed = 0, failed = 0;
const unhandled = [];
process.on("unhandledRejection", (e) => unhandled.push(e));

function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); failed++; }
}
function section(t) { console.log(`\n── ${t} ${"─".repeat(Math.max(0, 58 - t.length))}`); }

// Render a UTC instant as its Lagos civil date, for readable assertions.
const lagos = (d) => {
  const p = lagosParts(d);
  return `${p.year}-${String(p.month + 1).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
};
// A Lagos-midnight instant for a given civil date.
const at = (y, m, d) => new Date(Date.UTC(y, m - 1, d) - 60 * 60 * 1000);

// ══ 1. MONTHLY ANCHORING ═══════════════════════════════════════════════════
section("1. monthly anchoring — clamp, never roll forward");

test("the 25th of each month is the 25th", () => {
  const next = computeNextPayDate({ frequency: "monthly", anchorDay: 25, businessDayRule: "exact", from: at(2026, 9, 1) });
  assert.strictEqual(lagos(next), "2026-09-25");
});

test("a 31st anchor pays 28 Feb in a common year", () => {
  const next = computeNextPayDate({ frequency: "monthly", anchorDay: 31, businessDayRule: "exact", from: at(2026, 2, 1) });
  assert.strictEqual(lagos(next), "2026-02-28");
});

test("a 31st anchor pays 29 Feb in a leap year", () => {
  const next = computeNextPayDate({ frequency: "monthly", anchorDay: 31, businessDayRule: "exact", from: at(2028, 2, 1) });
  assert.strictEqual(lagos(next), "2028-02-29");
});

test("a 31st anchor RETURNS to the 31st in March — it does not drift", () => {
  // This is the whole point. recurringSchedule.js's setMonth(+1) from Jan 31
  // lands on Mar 2/3 and stays there for the life of the rule.
  const next = computeNextPayDate({ frequency: "monthly", anchorDay: 31, businessDayRule: "exact", from: at(2026, 2, 28) });
  assert.strictEqual(lagos(next), "2026-03-31");
});

test("a 30th anchor never rolls into the following month", () => {
  const next = computeNextPayDate({ frequency: "monthly", anchorDay: 30, businessDayRule: "exact", from: at(2026, 2, 1) });
  assert.strictEqual(lagos(next), "2026-02-28");
});

test("24 consecutive months from a 31st anchor never leave their own month", () => {
  let cursor = at(2026, 1, 1);
  for (let i = 0; i < 24; i++) {
    const next = computeNextPayDate({ frequency: "monthly", anchorDay: 31, businessDayRule: "exact", from: cursor });
    const p = lagosParts(next);
    const expectedMonth = (0 + i) % 12; // Jan + i
    assert.strictEqual(p.month, expectedMonth, `month ${i}: got ${lagos(next)}`);
    cursor = next;
  }
});

test("the date is strictly AFTER `from` (no same-day re-fire)", () => {
  const next = computeNextPayDate({ frequency: "monthly", anchorDay: 25, businessDayRule: "exact", from: at(2026, 9, 25) });
  assert.strictEqual(lagos(next), "2026-10-25");
});

// ══ 2. LAGOS CIVIL DATE ════════════════════════════════════════════════════
section("2. Lagos civil date, not host clock");

test("23:30 UTC on 30 Sep is already 1 Oct in Lagos", () => {
  // WAT is UTC+1, so this is the boundary that a host-clock implementation
  // gets wrong by a whole month.
  assert.strictEqual(periodKeyFor(new Date("2026-09-30T23:30:00Z"), "monthly"), "2026-10");
});

test("00:30 UTC and 23:30 UTC on the same Lagos day agree", () => {
  const a = computeNextPayDate({ frequency: "monthly", anchorDay: 15, businessDayRule: "exact", from: new Date("2026-09-10T00:30:00Z") });
  const b = computeNextPayDate({ frequency: "monthly", anchorDay: 15, businessDayRule: "exact", from: new Date("2026-09-10T22:30:00Z") });
  assert.strictEqual(lagos(a), lagos(b));
});

test("a pay date is Lagos midnight, not host midnight", () => {
  const next = computeNextPayDate({ frequency: "monthly", anchorDay: 25, businessDayRule: "exact", from: at(2026, 9, 1) });
  assert.strictEqual(next.toISOString(), "2026-09-24T23:00:00.000Z");
});

// ══ 3. WEEKEND RULE ════════════════════════════════════════════════════════
section("3. weekend rule — pay early");

test("a Saturday payday moves to the preceding Friday", () => {
  // 2026-08-01 is a Saturday.
  const sat = at(2026, 8, 1);
  assert.strictEqual(lagosParts(sat).weekday, 6, "fixture must be a Saturday");
  assert.strictEqual(lagos(shiftForWeekend(sat, "before")), "2026-07-31");
});

test("a Sunday payday moves to the preceding Friday", () => {
  const sun = at(2026, 8, 2);
  assert.strictEqual(lagosParts(sun).weekday, 0, "fixture must be a Sunday");
  assert.strictEqual(lagos(shiftForWeekend(sun, "before")), "2026-07-31");
});

test("a weekday payday is untouched", () => {
  const wed = at(2026, 8, 5);
  assert.strictEqual(lagos(shiftForWeekend(wed, "before")), "2026-08-05");
});

test("a weekend-shifted date ADVANCES when fed back in — it does not stick", () => {
  // Regression. The shift moves a payday BACKWARD, so the returned date can be
  // earlier than the anchor day. Comparing the raw anchor against `from` made
  // the next call answer with the same month again, and a schedule anchored on
  // the 25th froze in July 2026 (the 25th is a Saturday) forever.
  const first = computeNextPayDate({ frequency: "monthly", anchorDay: 25, from: at(2026, 7, 1) });
  assert.strictEqual(lagos(first), "2026-07-24", "25 Jul 2026 is a Saturday, so pay Friday");
  const second = computeNextPayDate({ frequency: "monthly", anchorDay: 25, from: first });
  assert.ok(second.getTime() > first.getTime(), `stuck: ${lagos(first)} → ${lagos(second)}`);
  assert.strictEqual(lagos(second), "2026-08-25");
});

test("36 months of a weekend-prone anchor always move forward", () => {
  // The property that matters more than any single date: the cursor is
  // monotonic. A schedule that stops advancing stops paying, silently.
  let cursor = at(2026, 1, 1);
  for (let i = 0; i < 36; i++) {
    const next = computeNextPayDate({ frequency: "monthly", anchorDay: 25, from: cursor });
    assert.ok(next.getTime() > cursor.getTime(), `month ${i} did not advance: ${lagos(cursor)} → ${lagos(next)}`);
    cursor = next;
  }
});

test("a weekly schedule always advances when fed its own output", () => {
  let cursor = at(2026, 7, 1);
  for (let i = 0; i < 20; i++) {
    const next = computeNextPayDate({ frequency: "weekly", anchorDay: 5, from: cursor });
    assert.ok(next.getTime() > cursor.getTime(), `week ${i} did not advance: ${lagos(cursor)} → ${lagos(next)}`);
    cursor = next;
  }
});

test("rule 'exact' never shifts, even on a Sunday", () => {
  const sun = at(2026, 8, 2);
  assert.strictEqual(lagos(shiftForWeekend(sun, "exact")), "2026-08-02");
});

// ══ 4. PERIOD IDENTITY ═════════════════════════════════════════════════════
section("4. period identity + reference");

test("the period key is the month, so every tick in September agrees", () => {
  assert.strictEqual(periodKeyFor(at(2026, 9, 1), "monthly"), "2026-09");
  assert.strictEqual(periodKeyFor(at(2026, 9, 25), "monthly"), "2026-09");
  assert.strictEqual(periodKeyFor(at(2026, 9, 30), "monthly"), "2026-09");
});

test("September and October produce DIFFERENT references", () => {
  const id = "a3f9c2b1-d4e5-f607-8899-aabbccddeeff";
  assert.notStrictEqual(referenceFor(id, "2026-09"), referenceFor(id, "2026-10"));
});

test("the same period produces the SAME reference on every call", () => {
  // Stability across retries is what lets executeTransfer's existing-reference
  // short-circuit collapse a double-approve into one payment.
  const id = "a3f9c2b1-d4e5-f607-8899-aabbccddeeff";
  assert.strictEqual(referenceFor(id, "2026-09"), referenceFor(id, "2026-09"));
});

test("the reference contains no timestamp", () => {
  const ref = referenceFor("a3f9c2b1-d4e5-f607", "2026-09");
  assert.ok(!/\d{13}/.test(ref), `reference looks like it embeds a timestamp: ${ref}`);
});

// ══ 5. CONSENT ═════════════════════════════════════════════════════════════
section("5. consent is amount- AND payee-bound");

const goodSchedule = {
  amount: 50000,
  accountNumber: "0123456789",
  bankCode: "058",
  authorizedAmount: 50000,
  authorizedPayee: "0123456789:058",
};

test("matching amount and payee is consent", () => {
  assert.strictEqual(consentMatches(goodSchedule), true);
});

test("a one-kobo amount change breaks consent", () => {
  assert.strictEqual(consentMatches({ ...goodSchedule, amount: 50000.01 }), false);
});

test("a raised salary with a stale authorisation pays nobody", () => {
  assert.strictEqual(consentMatches({ ...goodSchedule, amount: 500000 }), false);
});

test("changing only the bank code breaks consent", () => {
  assert.strictEqual(consentMatches({ ...goodSchedule, bankCode: "011" }), false);
});

test("changing only the account number breaks consent", () => {
  assert.strictEqual(consentMatches({ ...goodSchedule, accountNumber: "9999999999" }), false);
});

test("a null authorizedAmount fails CLOSED", () => {
  assert.strictEqual(consentMatches({ ...goodSchedule, authorizedAmount: null }), false);
});

test("a missing authorizedPayee fails CLOSED", () => {
  assert.strictEqual(consentMatches({ ...goodSchedule, authorizedPayee: null }), false);
});

test("an undefined schedule fails CLOSED", () => {
  assert.strictEqual(consentMatches(undefined), false);
});

// ══ 6. EXPIRY ══════════════════════════════════════════════════════════════
section("6. expiry evaluated on read");

const now = new Date("2026-09-25T12:00:00Z");

test("a pending payment past its expiry reads as lapsed", () => {
  assert.strictEqual(isLapsed({ status: "pending", expiresAt: new Date("2026-09-25T11:59:00Z") }, now), true);
});

test("a pending payment before its expiry is live", () => {
  assert.strictEqual(isLapsed({ status: "pending", expiresAt: new Date("2026-09-25T12:01:00Z") }, now), false);
});

test("an ALREADY PAID payment is never 'lapsed', whatever its expiry", () => {
  // Expiry must never re-open or re-label a terminal state.
  assert.strictEqual(isLapsed({ status: "paid", expiresAt: new Date("2020-01-01T00:00:00Z") }, now), false);
});

test("a payment mid-approval is not swept by expiry", () => {
  assert.strictEqual(isLapsed({ status: "approving", expiresAt: new Date("2020-01-01T00:00:00Z") }, now), false);
});

// ── done ──
setTimeout(() => {
  if (unhandled.length) {
    console.log(`\n  FAIL  no unhandled promise rejections\n        ${unhandled.length} found`);
    failed++;
  } else {
    console.log("\n  PASS  no unhandled promise rejections");
    passed++;
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}, 50);
