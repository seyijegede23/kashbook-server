// One money-comparison rule for the whole codebase. Amounts are naira floats
// derived from kobo integers, so compare in KOBO: `Math.abs(a - b) < 0.01`
// fails on IEEE-754 values like 5000.01, and raw === fails on any float drift.
// Three divergent comparators used to exist (kobo ints in igPaymentMatch, a
// 0.01 epsilon in the invoice matcher, raw equality in the webhook repair) —
// this is the single source of truth they all import now.
function toKobo(n) {
  return Math.round((Number(n) || 0) * 100);
}

function sameMoney(a, b) {
  return toKobo(a) === toKobo(b);
}

// Graded closeness for ranking and suggestions (fee-shaved or rounded
// transfers): true when the difference is within tolNaira, exclusive of
// exact — callers usually badge exact and close differently.
function closeMoney(a, b, tolNaira = 100) {
  return Math.abs(toKobo(a) - toKobo(b)) <= Math.round(tolNaira * 100);
}

// At most two decimals (naira and kobo). Float noise from a client's own
// arithmetic (0.1 + 0.2) is not a third decimal; 10.005 is. The tolerance is
// far above that noise and far below a tenth of a kobo for any amount under a
// billion naira. `Math.round(n * 100) === n * 100` is NOT this test: it
// refuses about one kobo amount in eight (2500.55 * 100 is 250054.99999999997).
// Store what passes as toKobo(n) / 100.
function twoDecimals(n) {
  const kobo = n * 100;
  return Math.abs(kobo - Math.round(kobo)) <= 1e-12 * Math.max(1, Math.abs(kobo));
}

module.exports = { toKobo, sameMoney, closeMoney, twoDecimals };
