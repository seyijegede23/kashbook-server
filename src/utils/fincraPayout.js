// Fincra payout settlement handler. executeFincraPayout books the expense
// optimistically at send time (Fincra returns "processing"); Fincra later fires
// payout.successful or payout.failed/reversed.
//
// Unlike Anchor (whose balance is read LIVE and self-corrects), a Fincra
// business's balance IS our ledger, so a failed payout MUST be reversed or the
// balance stays understated forever. On failure we post a compensating reversal
// (idempotent) that restores computeLedgerBalance (income +X offsets the expense
// −X). On success there's nothing to do — the optimistic expense was correct.
const prisma = require("./db");
const { pushTo } = require("./pushNotification");
const balanceCache = require("./balanceCache");
const { audit } = require("./audit");
const { computeFincraTransferFee, computeKorapayTransferFee } = require("../config/fees");

async function recordFincraPayoutOutcome(d, outcome, source = "fincra") {
  const reference = d.customerReference || d.reference || d.merchantReference || d.id || d._id;
  if (!reference) return { handled: false, reason: "no_reference" };
  // Korapay carries the businessId in metadata (its reference is length-capped);
  // Fincra encodes it in the reference. Either way it attributes an orphan.
  const bizId = d.metadata?.business_id || d.metadata?.businessId || null;

  // The optimistic expense booked at send time (reference === the customerReference
  // we sent the provider). No match → we lost the booking (timeout /
  // bookkeepingFailed) OR it's a foreign/mis-parsed event.
  const expense = await prisma.transaction.findFirst({
    where: { source, type: "expense", reference: String(reference) },
  });

  if (outcome === "success") {
    if (expense) return { handled: true, outcome: "success", businessId: expense.businessId };
    // Orphaned success — the money left but our booking was lost. Backfill it here
    // (event-driven, no scan window) so the ledger isn't left overstated. A
    // non-attributable ref/metadata is a safe no-op.
    return backfillFincraPayout({
      reference,
      amount: d.amountSent || d.amount || d.amountReceived,
      currency: d.sourceCurrency || d.currency,
      beneficiaryName: d.beneficiaryName || d.accountHolderName || d.customer?.name,
      source,
      bizId,
    });
  }

  // FAILED / REVERSED with no local expense → nothing of ours to reverse.
  if (!expense) return { handled: false, reason: "no_expense", reference: String(reference) };

  // FAILED / REVERSED — the money is back in the wallet. Restore the ledger with a
  // compensating reversal of amount + fee (the sender was debited both).
  // Idempotent via @@unique([businessId, reference]).
  const restore = Number(expense.amount) + Number(expense.fee || 0);
  const reversalRef = `${reference}:reversal`;
  try {
    await prisma.transaction.create({
      data: {
        businessId: expense.businessId,
        userId: expense.userId,
        type: "income",
        amount: restore,
        currency: expense.currency,
        description: `Reversed: ${expense.description} (transfer failed — you were not charged)`.slice(0, 250),
        category: "transfer",
        paymentMethod: "bank",
        date: new Date(),
        source,
        reference: reversalRef,
      },
    });
  } catch (e) {
    if (e.code === "P2002") return { handled: false, reason: "already_reversed", businessId: expense.businessId };
    throw e;
  }

  try { balanceCache.adjustBalance(expense.businessId, restore); } catch { /* noop */ }
  pushTo(expense.userId, "Transfer failed", "Your transfer didn't go through — you were not charged.").catch(() => {});
  await audit({
    action: "TRANSFER_REVERSED",
    resourceType: "business",
    resourceId: expense.businessId,
    severity: "warning",
    metadata: { reference: String(reference), amount: Number(expense.amount), currency: expense.currency },
  }).catch(() => {});

  return { handled: true, outcome: "failed", businessId: expense.businessId, reversed: Number(expense.amount) };
}

// Recover the businessId from a payout customerReference of the form
// kb_tf_<32-hex-bizId>_<suffix> (see executeFincraPayout). Returns the UUID, or
// null for a legacy/foreign reference the reconcile shouldn't attribute.
function parseBizIdFromRef(ref) {
  const m = /^kb_tf_([0-9a-fA-F]{32})_/.exec(String(ref || ""));
  if (!m) return null;
  const h = m[1].toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// Book the expense for a SUCCESSFUL payout whose original booking we lost
// (timeout / bookkeepingFailed) — the money left the pooled wallet, so the ledger
// must reflect it. Shared by the payout.successful webhook AND the payout
// reconcile. Idempotent via @@unique([businessId, reference]); attributes via the
// businessId encoded in the reference (a non-attributable ref is a safe no-op).
async function backfillFincraPayout({ reference, amount, currency, beneficiaryName, source = "fincra", bizId = null }) {
  const ref = String(reference || "");
  const attributedBizId = bizId || parseBizIdFromRef(ref); // Korapay: from metadata; Fincra: from the ref
  if (!attributedBizId) return { handled: false, reason: "unattributable" };
  const biz = await prisma.business.findUnique({ where: { id: attributedBizId } });
  if (!biz) return { handled: false, reason: "no_business" };
  const amt = Number(amount || 0);
  if (amt <= 0) return { handled: false, reason: "no_amount" };
  const cur = currency || biz.baseCurrency || "NGN";
  // Fee must MATCH what the live send path books, or a backfilled payout leaves the
  // ledger overstated vs the pool: Fincra 1.5%, Korapay flat ₦50 (was wrongly 0).
  const { total: fee, breakdown } =
    source === "fincra" ? computeFincraTransferFee(amt, { internal: false })
    : source === "korapay" ? computeKorapayTransferFee(amt, { internal: false })
    : { total: 0, breakdown: null };
  try {
    await prisma.transaction.create({
      data: {
        businessId: biz.id, userId: biz.userId, type: "expense", amount: amt, currency: cur,
        description: `Transfer to ${beneficiaryName || "recipient"} · Ref: ${ref} (reconciled)`,
        category: "transfer", paymentMethod: "bank", date: new Date(), source,
        reference: ref, fee, feeBreakdown: breakdown,
      },
    });
  } catch (e) {
    if (e.code === "P2002") return { handled: false, reason: "already_booked", businessId: biz.id };
    throw e;
  }
  try { balanceCache.adjustBalance(biz.id, -(amt + fee)); } catch { /* noop */ }
  await audit({
    action: "TRANSFER_BACKFILLED", resourceType: "business", resourceId: biz.id, severity: "warning",
    metadata: { reference: ref, amount: amt, fee, currency: cur },
  }).catch(() => {});
  return { handled: true, outcome: "backfilled", businessId: biz.id, amount: amt, fee };
}

module.exports = { recordFincraPayoutOutcome, parseBizIdFromRef, backfillFincraPayout };
