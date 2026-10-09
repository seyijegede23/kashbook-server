// A payment recorded by hand (cash, another bank, a debt repayment) that was
// later LINKED to the KashBook credit it really was. The link rewrites the
// payment (transactionId, the credit's date, method "bank" for invoices), so
// what it was before is kept here, written in the same database transaction
// as the link. Unmatching the credit then gives the payment back as it was,
// still counted, instead of deleting it like a payment the match created.
// No schema change: the record is an AuditLog row (append-only already).
const ACTION = "PAYMENT_LINK";

// kind: "invoice_payment" | "debt_payment"
async function recordLink(px, { req, kind, payment, transactionId }) {
  await px.auditLog.create({
    data: {
      actorType: "user",
      actorId: (req && req.user && req.user.id) || null,
      action: ACTION,
      resourceType: kind,
      resourceId: payment.id,
      metadata: {
        transactionId,
        method: payment.method || null,
        date: payment.date ? new Date(payment.date).toISOString() : null,
      },
    },
  });
}

// What the payment was before it was linked to this credit, or null when the
// credit's match created it.
async function linkedFrom(px, kind, paymentId, transactionId) {
  const row = await px.auditLog.findFirst({
    where: { action: ACTION, resourceType: kind, resourceId: paymentId },
    orderBy: { createdAt: "desc" },
  });
  const m = row && row.metadata;
  if (!m || m.transactionId !== transactionId) return null;
  return { method: m.method, date: m.date };
}

module.exports = { recordLink, linkedFrom };
