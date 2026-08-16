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

// How long an owner has to act on a held transfer before it lapses. An approval
// granted days later, at a price and for a reason the owner no longer holds in
// mind, is worse than one that expired and had to be asked for again.
const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

// How much this staff member has moved out in the trailing 24h, across every
// business they act for. Employer-scoped for free: a staff account belongs to
// exactly one employer, so every row bearing their recordedBy is that employer's.
//
// Transfers the OWNER personally approved are excluded. The cap measures
// UNSUPERVISED spend — that is the whole thing it is for — and counting an
// approved transfer against it would mean a single owner-authorised large
// payment locks the staff member out of routine small ones for a day, which is
// not what the owner agreed to when they tapped approve.
//
// Excluded by transaction id rather than by sniffing the reference string: the
// Fincra path wraps the caller's reference (kb_tf_<biz>_<ref>) while the Anchor
// path uses it verbatim, so any prefix test would silently stop matching for one
// provider. If the id is ever missing the transfer simply counts, which refuses
// earlier — the safe direction.
async function staffSpendLast24h(prisma, actorId, now = Date.now()) {
  if (!actorId) return 0;
  const since = new Date(now - WINDOW_MS);

  const approved = await prisma.staffTransferRequest.findMany({
    where: {
      requestedById: actorId,
      status: "executed",
      executedTransactionId: { not: null },
      decidedAt: { gte: since },
    },
    select: { executedTransactionId: true },
  });
  const approvedIds = approved.map((r) => r.executedTransactionId).filter(Boolean);

  const rows = await prisma.transaction.findMany({
    where: {
      recordedBy: actorId,
      type: "expense",
      category: "transfer",
      source: { in: MONEY_OUT_SOURCES },
      date: { gte: since },
      ...(approvedIds.length ? { id: { notIn: approvedIds } } : {}),
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

// Lapse held transfers the owner never acted on.
//
// The read paths already treat a past-expiry pending request as expired, so this
// is bookkeeping rather than the enforcement itself — which is the right way
// round: if the reaper stops running, nothing becomes approvable that shouldn't
// be. It exists so the queue doesn't grow without bound and so the staff member
// gets told, rather than watching a request sit "pending" forever.
//
// Only "pending" is swept. A row mid-approval is "approving", and expiring one
// out from under an in-flight execution would leave money moved against a
// request marked expired.
async function expireStaleRequests(prisma, { pushTo } = {}) {
  const now = new Date();
  const stale = await prisma.staffTransferRequest.findMany({
    where: { status: "pending", expiresAt: { lte: now } },
    select: { id: true, requestedById: true, amount: true, currency: true },
    take: 500,
  });
  if (!stale.length) return 0;

  const { count } = await prisma.staffTransferRequest.updateMany({
    where: { id: { in: stale.map((r) => r.id) }, status: "pending" },
    data: { status: "expired", reason: "Expired without a decision", decidedAt: now },
  });

  if (pushTo) {
    for (const r of stale) {
      pushTo(
        r.requestedById,
        "Transfer request expired",
        "The business owner didn't action it in time. Send it again if it's still needed.",
      ).catch(() => {});
    }
  }
  return count;
}

module.exports = {
  staffSpendLast24h,
  decideStaffCap,
  expireStaleRequests,
  WINDOW_MS,
  APPROVAL_TTL_MS,
};
