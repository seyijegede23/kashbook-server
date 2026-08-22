// Staff Payments — the pure parts: pay-date arithmetic, period keys, consent
// matching, expiry. No database, no network, so all of it is unit-testable
// without a Postgres (see scripts/salary-schedule-test.js).
//
// This deliberately does NOT use computeNextDue() from recurringSchedule.js.
// That function is naive interval addition on the HOST clock: a monthly rule
// anchored on the 31st becomes Mar 2/3 and stays there forever, and every date
// it produces is a host-timezone date rather than a Lagos one. A salary date is
// contractual — "the 25th" must be the 25th in every month, and February must
// pay in February.

// West Africa Time is a fixed UTC+01:00 with no daylight saving, so the civil
// date needs no timezone library — just the offset. (The daily-report cron
// relies on the same fact.)
const LAGOS_OFFSET_MS = 60 * 60 * 1000;

// Approvals for a salary can sit longer than the 24h a staff transfer gets:
// payday is a known event, an owner may be travelling, and — crucially —
// expiry here does NOT destroy the obligation. The period stays `owed`.
const SALARY_APPROVAL_TTL_MS = 72 * 60 * 60 * 1000;

const FREQUENCIES = new Set(["monthly", "weekly"]);

// Read a UTC instant as its Lagos civil date. Always read the result with
// getUTC* — never getMonth()/getDate(), which use the host clock and are a day
// out at month boundaries on a UTC server.
function lagosParts(date) {
  const d = new Date(date.getTime() + LAGOS_OFFSET_MS);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth(), // 0-11
    day: d.getUTCDate(),
    weekday: d.getUTCDay(), // 0 = Sunday
  };
}

// The UTC instant of 00:00 on a given Lagos civil date.
function lagosMidnightUtc(year, month, day) {
  return new Date(Date.UTC(year, month, day) - LAGOS_OFFSET_MS);
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

// Weekend paydays pay EARLY, never late. A payday that lands on Saturday and
// pays Monday is experienced by the staff member as being paid late; paying
// Friday is never a complaint. It also lands the approval on a day the owner
// is actually working, which an approve-first design needs.
//
// Public holidays are deliberately NOT handled: Nigerian holidays include
// moveable Islamic dates gazetted only days ahead, so a hardcoded table would
// go stale silently and shift a payday with nobody noticing. A stale holiday
// table is strictly worse than no holiday table. The 72h approval window
// absorbs a holiday as "the owner approved a day later".
function shiftForWeekend(date, rule) {
  if (rule === "exact") return date;
  const { weekday } = lagosParts(date);
  if (weekday !== 0 && weekday !== 6) return date;
  const days = rule === "after"
    ? (weekday === 6 ? 2 : 1) // Sat → Mon, Sun → Mon
    : (weekday === 6 ? -1 : -2); // Sat → Fri, Sun → Fri
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

// The next pay date strictly AFTER `from`.
//
// Monthly CLAMPS to the month's length instead of rolling forward: an anchor of
// 31 pays 28 Feb (29 in a leap year) and then 31 Mar again. Because the anchor
// lives on the schedule row and is re-applied fresh each period, nothing is
// derived from the last payment and there is no drift to accumulate.
function computeNextPayDate({ frequency, anchorDay, businessDayRule = "before", from }) {
  const base = from instanceof Date ? from : new Date(from);
  if (Number.isNaN(base.getTime())) throw new Error("computeNextPayDate: invalid `from`");
  if (!FREQUENCIES.has(frequency)) throw new Error(`computeNextPayDate: bad frequency ${frequency}`);

  if (frequency === "weekly") {
    const target = ((Number(anchorDay) % 7) + 7) % 7;
    const { year, month, day, weekday } = lagosParts(base);
    let ahead = (target - weekday + 7) % 7;
    if (ahead === 0) ahead = 7; // strictly after
    const raw = lagosMidnightUtc(year, month, day + ahead);
    return shiftForWeekend(raw, businessDayRule);
  }

  // monthly
  const wanted = Math.min(Math.max(Number(anchorDay) || 1, 1), 31);
  const { year, month } = lagosParts(base);
  // Compare the SHIFTED candidate against `from`, not the raw anchor date.
  // The weekend rule moves a payday BACKWARD, so the date this function returns
  // can be earlier than the anchor day — and feeding that back in as `from`
  // would otherwise resolve to the same month forever. (A 25th anchor whose
  // July date is a Saturday returns Friday the 24th; asking again from the 24th
  // would answer "the 25th" and the schedule would never leave July.)
  for (let i = 0; i < 4; i++) {
    const y = year + Math.floor((month + i) / 12);
    const m = (month + i) % 12;
    const payDay = Math.min(wanted, daysInMonth(y, m));
    const candidate = shiftForWeekend(lagosMidnightUtc(y, m, payDay), businessDayRule);
    if (candidate.getTime() > base.getTime()) return candidate;
  }
  throw new Error("computeNextPayDate: could not resolve a date");
}

// The identity of a pay period. This — not the cron tick — is what makes a
// payment unique, which is why a resumed schedule produces named periods
// instead of one payment per catch-up tick.
function periodKeyFor(date, frequency) {
  const { year, month, day } = lagosParts(date);
  if (frequency === "weekly") {
    // ISO week, computed on the Lagos civil date.
    const d = new Date(Date.UTC(year, month, day));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
    return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
  }
  return `${year}-${String(month + 1).padStart(2, "0")}`;
}

// A deterministic payout reference: derivable from data alone (no row id), so
// the same period always produces the same string. Stable across every retry,
// distinct across every period. This is the opposite of the recurring engine's
// reference, which embeds the tick's timestamp and therefore differs on every
// catch-up fire — which is exactly why idempotency cannot collapse a backlog
// there.
function referenceFor(scheduleId, periodKey) {
  const compact = String(scheduleId).replace(/-/g, "").slice(0, 16);
  return `kbsal_${compact}_${String(periodKey).replace(/-/g, "")}`;
}

// Consent is bound to BOTH the amount and the payee. The runner calls this
// before minting anything: a schedule whose amount no longer matches what the
// PIN authorised pays nobody. Fail closed on a missing authorisation — the same
// discipline as a null staff cap meaning "nothing", not "unlimited".
function consentMatches(schedule) {
  if (!schedule) return false;
  if (typeof schedule.authorizedAmount !== "number") return false;
  if (!schedule.authorizedPayee) return false;
  const payee = `${schedule.accountNumber}:${schedule.bankCode}`;
  // Kobo-integer compare: a float === on money is a bug waiting for a decimal.
  const sameAmount =
    Math.round(schedule.authorizedAmount * 100) === Math.round(schedule.amount * 100);
  return sameAmount && schedule.authorizedPayee === payee;
}

function payeeKey(accountNumber, bankCode) {
  return `${accountNumber}:${bankCode}`;
}

// Expiry is evaluated on READ as well as in the claim, so a reaper that stops
// running can never make something approvable that shouldn't be.
function isLapsed(payment, now = new Date()) {
  return (
    payment?.status === "pending" &&
    payment?.expiresAt != null &&
    new Date(payment.expiresAt).getTime() <= now.getTime()
  );
}

module.exports = {
  LAGOS_OFFSET_MS,
  SALARY_APPROVAL_TTL_MS,
  FREQUENCIES,
  lagosParts,
  lagosMidnightUtc,
  daysInMonth,
  shiftForWeekend,
  computeNextPayDate,
  periodKeyFor,
  referenceFor,
  consentMatches,
  payeeKey,
  isLapsed,
};
