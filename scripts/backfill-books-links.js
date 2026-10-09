// One-off for the books rule (2026-10-09): link invoice payments recorded
// before the rule to the KashBook credit they were, so the money counts once.
//
//   method "bank" without a link (old auto-matches) and method "transfer"
//   (before "transfer" meant "another bank") are linked when EXACTLY ONE
//   unexplained credit of the same business has the same amount, within two
//   days of the payment. A linked "transfer" becomes "bank". Anything else is
//   left alone and listed.
//
//   node scripts/backfill-books-links.js            # dry run: prints, writes nothing
//   node scripts/backfill-books-links.js --apply    # writes, one transaction per link
//
// Uses DATABASE_URL (swap sslmode=verify-full for sslmode=require on Render).
const prisma = require("../src/utils/db");

const APPLY = process.argv.includes("--apply");
const kobo = (n) => Math.round(Number(n) * 100);

(async () => {
  const payments = await prisma.invoicePayment.findMany({
    where: { transactionId: null, method: { in: ["bank", "transfer"] } },
    include: { invoice: { select: { id: true, businessId: true, invoiceNumber: true, type: true } } },
  });
  console.log(`${payments.length} unlinked bank/transfer invoice payment(s)${APPLY ? "" : " (dry run)"}`);
  let linked = 0;
  for (const p of payments) {
    if ((p.invoice.type || "invoice") !== "invoice") continue;
    const from = new Date(p.date.getTime() - 2 * 86400000);
    const to = new Date(p.date.getTime() + 2 * 86400000);
    const candidates = (
      await prisma.transaction.findMany({
        where: {
          businessId: p.invoice.businessId, type: "income", purpose: null,
          matchedSaleId: null, matchedCustomerId: null, matchedInvoiceId: null,
          date: { gte: from, lte: to },
        },
        select: { id: true, amount: true, date: true, senderName: true },
      })
    ).filter((t) => kobo(t.amount) === kobo(p.amount));
    const tag = `${p.invoice.invoiceNumber} ${p.method} ${p.amount} on ${p.date.toISOString().slice(0, 10)}`;
    if (candidates.length !== 1) {
      console.log(`  leave  ${tag}: ${candidates.length} matching credit(s)`);
      continue;
    }
    const tx = candidates[0];
    console.log(`  link   ${tag} -> credit ${tx.id} (${tx.senderName || "?"}, ${tx.date.toISOString().slice(0, 10)})`);
    if (!APPLY) continue;
    await prisma.withBusinessLock(p.invoice.businessId, () =>
      prisma.$transaction(async (px) => {
        const fresh = await px.transaction.findUnique({ where: { id: tx.id } });
        if (fresh.purpose || fresh.matchedSaleId || fresh.matchedCustomerId || fresh.matchedInvoiceId) return;
        await px.invoicePayment.update({
          where: { id: p.id },
          data: { transactionId: tx.id, method: "bank", date: fresh.date },
        });
        await px.transaction.update({
          where: { id: tx.id },
          data: { matchedInvoiceId: p.invoice.id, matchedAmount: Number(p.amount) },
        });
      }),
    );
    linked++;
  }
  console.log(APPLY ? `linked ${linked}` : "dry run: nothing written");
  await prisma.$disconnect();
  // The business lock holds its own pg connection; without this Node waits on it.
  process.exit(0);
})().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
