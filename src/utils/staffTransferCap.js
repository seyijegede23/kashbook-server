// Per-staff daily transfer cap.
//
// This is the control that makes `canTransfer` safe to grant. Without it, the
// permission is equivalent to handing over the bank account: the owner's own AML
// limits are the only ceiling, and those are sized for the OWNER.
//
// Design notes, because each of these is a bug someone will otherwise reintroduce:
//
//   * The window is a ROLLING 24 hours, not a calendar day. A calendar day
//     resets at midnight, so a staff member could spend the full cap at 23:59
//     and the full cap again at 00:01 — 2x the authorised amount inside two
//     minutes. Rolling has no such edge. It also matches the AML pipeline's
//     existing 24h/7d/30d windows, so the two ceilings agree about what "today"
//     means.
//
//   * Spend is measured from Transaction.recordedBy — the same row as the money.
//     NOT from the audit log: audit() is fire-and-forget and swallows its own
//     failures, so a dropped audit write would silently reset a staff member's
//     spend to zero. The cap has to be derived from a record that cannot exist
//     without the money having moved.
//
//   * Fees count. They leave the account exactly like the principal does, and a
//     cap that ignores them lets a run of small transfers drain more than the
//     owner authorised.
//
//   * Default cap is 0. authMiddleware coalesces a missing/null grant to 0, so a
//     staff member who has been granted canTransfer but not given a number can
//     send nothing at all. That is what lets this ship ahead of the approval
//     queue: the fail-closed direction is "refuse", never "send".

const { MONEY_OUT_SOURCES } = require("./amlChecks");

const WINDOW_MS = 24 * 60 * 60 * 1000;

// How much this staff member has moved out in the trailing 24h, across every
// business they act for. Employer-scoped for free: a staff account belongs to
// exactly one employer, so every row bearing their recordedBy is that employer's.
async function staffSpendLast24h(prisma, actorId, now = Date.now()) {
  if (!actorId) return 0;
  const rows = await prisma.transaction.findMany({
    where: {
      recordedBy: actorId,
      type: "expense",
      category: "transfer",
      source: { in: MONEY_OUT_SOURCES },
      date: { gte: new Date(now - WINDOW_MS) },
    },
    select: { amount: true, fee: true },
  });
  return rows.reduce((s, t) => s + Number(t.amount || 0) + Number(t.fee || 0), 0);
}

// Pure decision, split out from the query so it can be tested without a DB and
// reused by the approval queue (which asks the same question about a transfer
// that has been sitting in the hold list).
//
// Strictly greater-than: spending exactly up to the cap is allowed, so a cap of
// 50,000 permits a 50,000 transfer. Anything else makes the number a lie.
function decideStaffCap({ cap, spent, amount, fee = 0 }) {
  const capN = Number(cap) || 0;
  const spentN = Number(spent) || 0;
  const cost = (Number(amount) || 0) + (Number(fee) || 0);
  const remaining = Math.max(0, capN - spentN);
  // Tolerance of a hundredth of a minor unit absorbs float noise from summing
  // many rows, so a transfer that is exactly at the cap isn't refused because
  // 49999.999999 !== 50000.
  const allowed = spentN + cost <= capN + 0.005;
  return { allowed, cap: capN, spent: spentN, cost, remaining };
}

module.exports = { staffSpendLast24h, decideStaffCap, WINDOW_MS };
