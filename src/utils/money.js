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

module.exports = { toKobo, sameMoney, closeMoney };
