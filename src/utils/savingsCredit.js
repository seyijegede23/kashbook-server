// Classifying an inbound Anchor credit as a savings withdrawal landing.
//
// When a merchant takes money out of a PiggyVest pot, PiggyVest pays it by
// bank transfer into the merchant's Anchor NUBAN. That credit then arrives
// through the SAME two writers as a customer's payment (routes/anchor.js and
// utils/anchorReconcile.js), and left alone it would be booked as income,
// pushed as "Payment received", matched against an open invoice of the same
// amount, and emailed. All of that is wrong for the merchant's own money
// coming home, so both writers ask this module BEFORE prisma.transaction.create
// and, when it says so, book the row with purpose "savings_withdrawal" and skip
// the rest.
//
// Two tiers, deliberately narrow:
//   1. The narration carries our withdrawal reference (kb_svw_…). Certain.
//   2. The sender account is one of this business's pot funding accounts and
//      EXACTLY ONE un-landed withdrawal from that pot has this amount.
// Rail bank name plus amount alone is never enough: PiggyVest pays out from a
// pooled account that other people's money also comes from. Anything short of
// a tier match books as ordinary income; the reconcile loop later surfaces
// withdrawals that never found their credit as needs_review.
const prisma = require("./db");
const { sameMoney, toKobo } = require("./money");

const WITHDRAWAL_REF_RE = /kb_svw_[a-z0-9]+/i;

// Pure. `candidates` are this business's withdrawal movements that have not
// landed yet: [{ id, reference, amount, potAccountNumber }].
//   → { purpose: "savings_withdrawal", movementId, tier } | { purpose: null, review?: string }
function decideCreditPurpose({ narration, senderAccount, senderName: _senderName, amount, candidates = [] }) {
  const amt = Number(amount) || 0;
  if (!(amt > 0) || !candidates.length) return { purpose: null };

  // Tier 1: our reference survived into the narration.
  const m = String(narration || "").match(WITHDRAWAL_REF_RE);
  if (m) {
    const ref = m[0].toLowerCase();
    const hit = candidates.find((c) => String(c.reference || "").toLowerCase() === ref);
    // The landing may be a little UNDER the request (a fee taken on the way)
    // but never over: an over-payment against our reference is not ours.
    if (hit && toKobo(amt) <= toKobo(hit.amount)) {
      return { purpose: "savings_withdrawal", movementId: hit.id, tier: 1 };
    }
    if (hit) return { purpose: null, review: "reference_amount_over" };
  }

  // Tier 2: sender is a pot's funding account and exactly one open withdrawal
  // from that pot matches the amount to the kobo.
  const sender = String(senderAccount || "").replace(/\D/g, "");
  if (sender.length === 10) {
    const fromPot = candidates.filter((c) => String(c.potAccountNumber || "") === sender);
    if (fromPot.length) {
      const exact = fromPot.filter((c) => sameMoney(c.amount, amt));
      if (exact.length === 1) return { purpose: "savings_withdrawal", movementId: exact[0].id, tier: 2 };
      return { purpose: null, review: exact.length > 1 ? "ambiguous_amount" : "sender_no_amount_match" };
    }
  }
  // No sender to go on (the poller's /transactions feed often has none) and an
  // open withdrawal of exactly this amount: it MAY be ours. Not enough to tag,
  // but enough to keep the automatic matchers off it, so the webhook, which
  // does know the sender, can still re-tag the row cleanly a moment later.
  if (!sender && !String(_senderName || "").trim() && candidates.some((c) => sameMoney(c.amount, amt))) {
    return { purpose: null, review: "possible_savings_landing" };
  }
  return { purpose: null };
}

// Open withdrawals for a business, shaped for decideCreditPurpose. A
// completed withdrawal whose landing was never found stops being a candidate
// after a week: by then a human has been alerted, and leaving it in would make
// every later same-amount credit "ambiguous" forever.
async function loadCandidates(businessId) {
  const weekAgo = new Date(Date.now() - 7 * 86400000);
  const rows = await prisma.savingsMovement.findMany({
    where: {
      businessId,
      type: "withdrawal",
      backing: "piggyvest",
      landedTransactionId: null,
      OR: [
        { status: { in: ["processing", "unknown"] } },
        { status: "completed", createdAt: { gte: weekAgo } },
      ],
    },
    select: { id: true, reference: true, amount: true, pot: { select: { pvAccountNumber: true } } },
    take: 50,
  });
  return rows.map((r) => ({ id: r.id, reference: r.reference, amount: r.amount, potAccountNumber: r.pot?.pvAccountNumber || null }));
}

// DB-backed wrapper for the two credit writers. Never throws: a classifier
// failure must not stop a real credit from being booked, so any error reads
// as "not savings".
async function classifyInboundCredit(biz, { amount, sender, narration }) {
  try {
    if (!biz?.id) return { purpose: null };
    const candidates = await loadCandidates(biz.id);
    if (!candidates.length) return { purpose: null };
    const decision = decideCreditPurpose({
      narration,
      senderAccount: sender?.accountNumber,
      senderName: sender?.name,
      amount,
      candidates,
    });
    if (decision.review && decision.review !== "possible_savings_landing") {
      console.warn(`[savings] inbound ₦${amount} to ${biz.name} looks like a pot payout but was not attributed (${decision.review}); booked as income`);
    }
    return decision;
  } catch (e) {
    console.error("[savings] classifyInboundCredit failed:", e.message);
    return { purpose: null };
  }
}

// Record that the withdrawal's money reached the Anchor account. Guarded on
// landedTransactionId null so two writers (webhook + poller racing on the same
// credit) can only land it once; the Transaction's own unique reference stops
// the second row anyway. Landing is evidence, not completion: `completed` is
// still set only by verifyTransaction in the reconcile loop.
async function markLanded({ movementId, transactionId, amount }) {
  if (!movementId || !transactionId) return false;
  const r = await prisma.savingsMovement.updateMany({
    where: { id: movementId, landedTransactionId: null },
    data: { landedTransactionId: transactionId, landedAmount: Number(amount) || 0 },
  });
  return r.count === 1;
}

module.exports = { decideCreditPurpose, classifyInboundCredit, markLanded, loadCandidates, WITHDRAWAL_REF_RE };
