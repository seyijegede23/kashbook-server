// Invoice auto-payment matcher — shared by every inbound-credit path.
//
// History: this lived in anchorReconcile.js and only ran on POLLER-booked
// credits; since the webhook books nearly every credit within seconds (and the
// poller skips those), the matcher was effectively dormant. It also ran with
// no lock (webhook + poller could double-record an InvoicePayment) and a 0.01
// float epsilon. Now: one implementation, kobo-exact compare, and the whole
// find→record→recalc runs inside the per-business advisory lock with the
// remaining balance re-checked in-lock — the same claim discipline as
// igPaymentMatch.
//
// Matching stays deliberately conservative: exactly ONE open invoice whose
// remaining balance equals the credit to the kobo, issued in the last 90
// days. Zero or several candidates → do nothing, the merchant decides.
const prisma = require("./db");
const { sameMoney } = require("./money");
const { pushTo } = require("./pushNotification");
const { recalcInvoiceStatus } = require("./invoiceStatus");

async function tryMatchInvoice(biz, amount, reference, { currency } = {}) {
  if (!biz?.id || !(Number(amount) > 0)) return;
  // Currency guard: FCY credits (Fincra USD/GHS) must never settle an NGN
  // invoice on numeric equality alone. Callers that know the credit's
  // currency pass it; a mismatch with the business's base currency bails.
  const base = biz.baseCurrency || "NGN";
  if (currency && currency !== base) return;
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10);

  const result = await prisma.withBusinessLock(biz.id, async () => {
    const candidates = await prisma.invoice.findMany({
      where: {
        businessId: biz.id,
        // Quotes take no payments (the manual route 403s QUOTE_NO_PAYMENT) —
        // the auto-matcher must not settle them either.
        type: "invoice",
        status: { in: ["SENT", "PARTIAL", "OVERDUE"] },
        issueDate: { gte: ninetyDaysAgo },
      },
      select: {
        id: true, invoiceNumber: true, total: true, amountPaid: true,
        dueDate: true, status: true,
      },
    });
    const matches = candidates.filter((c) =>
      sameMoney(c.total - c.amountPaid, amount),
    );
    if (matches.length !== 1) return null; // 0 = no match; >1 = ambiguous → merchant confirms

    const inv = matches[0];
    // Float hygiene: when the credit settles the invoice exactly (the only
    // way it matched), land amountPaid exactly ON total instead of total ±1
    // ulp, so the PAID threshold can never be missed by float drift.
    const newAmountPaid = sameMoney(inv.total - inv.amountPaid, amount)
      ? inv.total
      : inv.amountPaid + Number(amount);
    const newStatus = recalcInvoiceStatus({
      amountPaid: newAmountPaid,
      total: inv.total,
      dueDate: inv.dueDate,
      status: inv.status,
    });
    // One $transaction: the payment row and the invoice totals commit or fail
    // together — a crash between two autocommitted writes would leave an
    // orphan payment with the balance unchanged, and the next same-amount
    // credit would settle the invoice a second time.
    await prisma.$transaction([
      prisma.invoicePayment.create({
        data: {
          invoiceId: inv.id,
          amount,
          method: "bank",
          note: `NUBAN transfer · ${reference}`,
        },
      }),
      prisma.invoice.update({
        where: { id: inv.id },
        data: { amountPaid: newAmountPaid, status: newStatus },
      }),
    ]);
    return { inv, newStatus };
  });

  if (!result) return;
  // Slow work outside the lock.
  await pushTo(
    biz.userId,
    "Invoice Paid ✅",
    `${result.inv.invoiceNumber} marked ${result.newStatus.toLowerCase()} via NUBAN`,
  );
}

module.exports = { tryMatchInvoice };
