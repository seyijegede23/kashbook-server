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

async function recordFincraPayoutOutcome(d, outcome) {
  const reference = d.customerReference || d.reference || d.merchantReference || d.id || d._id;
  if (!reference) return { handled: false, reason: "no_reference" };

  // The optimistic expense booked by executeFincraPayout (reference === the
  // customerReference we sent Fincra). No match → nothing of ours to settle (safe
  // no-op; also guards against a mis-parsed event acting on a random row).
  const expense = await prisma.transaction.findFirst({
    where: { source: "fincra", type: "expense", reference: String(reference) },
  });
  if (!expense) return { handled: false, reason: "no_expense", reference: String(reference) };

  if (outcome === "success") {
    // Money left as booked — nothing to correct.
    return { handled: true, outcome: "success", businessId: expense.businessId };
  }

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
        source: "fincra",
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
    metadata: { reference: String(reference), amount: expense.amount, currency: expense.currency },
  }).catch(() => {});

  return { handled: true, outcome: "failed", businessId: expense.businessId, reversed: Number(expense.amount) };
}

module.exports = { recordFincraPayoutOutcome };
