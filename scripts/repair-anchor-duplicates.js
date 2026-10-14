// Removes Anchor credits the reconcile poller booked a second time (found
// 2026-10-14). The webhook books a credit as anc_pay_<paymentId> with its
// sender; Anchor's /transactions list often carries no Payment link, so before
// the fix in utils/anchorReconcile.js (claimWebhookTwin) the poller booked the
// same money again as "Anonymous sender" under anc_txn_<id>. The money came
// once; the books and the KashBook Account counted it twice.
//
// A pair is: a poller row (source anchor, income, reference anc_txn_, no
// sender) and a webhook row (anc_pay_, not yet claimed by another list id) in
// the same business, for the same exact amount, dated within five minutes of
// each other (live pairs are 0 to 3 seconds apart). Pairs are made one to one,
// closest first, so a genuine second credit of the same amount is never taken
// for a duplicate. For each pair, in one transaction under the business lock
// and only if both rows are still as they were read:
//   - the webhook row records the poller's list id in providerTxnId (so the
//     fixed poller recognises it and never books that credit again), and
//   - the poller row is deleted,
// with an AuditLog row (actor "system", action ANCHOR_DUPLICATE_REMOVED)
// holding the deleted row whole.
//
// A poller row anything points at (a match, a purpose, an account, a payment
// on an invoice, debt or bill, a compliance flag) is listed and left for a
// person to look at. So is one dated on or before its business's books lock,
// unless --include-locked is given. It prints ids and amounts, never names.
//
//   node scripts/repair-anchor-duplicates.js --dry-run          # lists the pairs, writes nothing
//   node scripts/repair-anchor-duplicates.js                    # removes the duplicates
//   node scripts/repair-anchor-duplicates.js --include-locked   # also inside a books lock
//
// Run it only after the fixed poller is live (else the old poller may book a
// removed credit again while it is still in Anchor's latest 50). Uses
// DATABASE_URL (swap sslmode=verify-full for sslmode=require on Render).
// Exits 1 when a pair failed, 2 on bad arguments.
const prisma = require("../src/utils/db");
const { dayKey } = require("../src/utils/books");
const { TWIN_WINDOW_MS } = require("../src/utils/anchorReconcile");

const args = process.argv.slice(2);
const known = new Set(["--dry-run", "--include-locked"]);
const bad = args.filter((a) => !known.has(a));
if (bad.length) {
  console.error(`unknown argument(s): ${bad.join(" ")}`);
  process.exit(2);
}
const dryRun = args.includes("--dry-run");
const includeLocked = args.includes("--include-locked");

const ROW = {
  id: true, businessId: true, type: true, amount: true, reference: true, providerTxnId: true, source: true,
  senderName: true, description: true, date: true, createdAt: true, matchedSaleId: true, matchedCustomerId: true,
  matchedExpenseId: true, matchedInvoiceId: true, matchedBillId: true, matchedAmount: true, purpose: true,
  accountId: true, fee: true, currency: true, complianceStatus: true, flagSeverity: true,
};
// The business's books lock as its Lagos day (Business.booksLockDate is
// "YYYY-MM-DD"); one that cannot be read locks everything, so nothing is
// removed by mistake.
const lockDayOf = (v) => (v == null || v === "" ? null : /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? String(v) : "9999-12-31");
const unclaimed = (w) => !w.providerTxnId || w.reference === `anc_pay_${w.providerTxnId}`;

// What points at a poller row (it is left when anything does).
async function linksOf(px, d) {
  const out = [];
  for (const k of ["matchedSaleId", "matchedCustomerId", "matchedExpenseId", "matchedInvoiceId", "matchedBillId", "purpose", "accountId"]) {
    if (d[k]) out.push(k);
  }
  if (d.matchedAmount) out.push("matchedAmount");
  const [inv, debt, bill, flag] = await Promise.all([
    px.invoicePayment.count({ where: { transactionId: d.id } }),
    px.debtPayment.count({ where: { transactionId: d.id } }),
    px.billPayment.count({ where: { transactionId: d.id } }),
    px.complianceFlag.count({ where: { transactionId: d.id } }),
  ]);
  if (inv) out.push(`invoicePayments:${inv}`);
  if (debt) out.push(`debtPayments:${debt}`);
  if (bill) out.push(`billPayments:${bill}`);
  if (flag) out.push(`complianceFlags:${flag}`);
  return out;
}

(async () => {
  const dups = await prisma.transaction.findMany({
    where: { source: "anchor", type: "income", reference: { startsWith: "anc_txn_" }, senderName: null },
    select: ROW,
  });
  const twins = dups.length
    ? await prisma.transaction.findMany({
        where: {
          source: "anchor",
          type: "income",
          reference: { startsWith: "anc_pay_" },
          businessId: { in: [...new Set(dups.map((d) => d.businessId))] },
        },
        select: ROW,
      })
    : [];

  // Every candidate pair, closest first; then one to one.
  const cands = [];
  for (const d of dups) {
    for (const w of twins) {
      if (w.businessId !== d.businessId || w.amount !== d.amount || !unclaimed(w)) continue;
      const gap = Math.abs(new Date(w.date).getTime() - new Date(d.date).getTime());
      if (gap <= TWIN_WINDOW_MS) cands.push({ d, w, gap });
    }
  }
  cands.sort((a, b) => a.gap - b.gap);
  const usedD = new Set();
  const usedW = new Set();
  const pairs = [];
  for (const c of cands) {
    if (usedD.has(c.d.id) || usedW.has(c.w.id)) continue;
    usedD.add(c.d.id);
    usedW.add(c.w.id);
    pairs.push(c);
  }

  const locks = new Map(
    (await prisma.business.findMany({
      where: { id: { in: [...new Set(pairs.map((p) => p.d.businessId))] } },
      select: { id: true, booksLockDate: true },
    })).map((b) => [b.id, lockDayOf(b.booksLockDate)]),
  );

  let removed = 0;
  let left = 0;
  let failed = 0;
  let total = 0;
  for (const { d, w, gap } of pairs) {
    const tag = `business ${d.businessId} ₦${d.amount} ${dayKey(d.date)}: poller row ${d.id} (${d.reference}) = webhook row ${w.id} (${w.reference}), ${Math.round(gap / 1000)}s apart`;
    const links = await linksOf(prisma, d);
    const lock = locks.get(d.businessId);
    const locked = !!lock && dayKey(d.date) <= lock;
    if (links.length) {
      left++;
      console.log(`LEFT   ${tag}: linked (${links.join(", ")})`);
      continue;
    }
    if (locked && !includeLocked) {
      left++;
      console.log(`LEFT   ${tag}: on or before the books lock ${lock} (--include-locked to remove)`);
      continue;
    }
    if (dryRun) {
      removed++;
      total += d.amount;
      console.log(`WOULD  ${tag}${locked ? " (inside the books lock)" : ""}`);
      continue;
    }
    try {
      const listId = d.providerTxnId || d.reference.replace(/^anc_txn_/, "");
      const done = await prisma.withBusinessLock(d.businessId, () =>
        prisma.$transaction(async (px) => {
          const [dNow, wNow] = await Promise.all([
            px.transaction.findUnique({ where: { id: d.id }, select: ROW }),
            px.transaction.findUnique({ where: { id: w.id }, select: ROW }),
          ]);
          if (!dNow || !wNow || dNow.reference !== d.reference || dNow.amount !== d.amount || !unclaimed(wNow)) return false;
          if ((await linksOf(px, dNow)).length) return false;
          await px.transaction.update({ where: { id: w.id }, data: { providerTxnId: listId } });
          await px.transaction.delete({ where: { id: d.id } });
          await px.auditLog.create({
            data: {
              actorType: "system",
              action: "ANCHOR_DUPLICATE_REMOVED",
              resourceType: "transaction",
              resourceId: d.id,
              severity: "warn",
              metadata: { deleted: JSON.parse(JSON.stringify(dNow)), keptRowId: w.id, keptReference: w.reference, listId, gapMs: gap },
            },
          });
          return true;
        // A remote database's first round trips can pass Prisma's 5 s default.
        }, { timeout: 30000, maxWait: 30000 }),
      );
      if (done) {
        removed++;
        total += d.amount;
        console.log(`REMOVED ${tag}`);
      } else {
        left++;
        console.log(`LEFT   ${tag}: changed since it was read (run again)`);
      }
    } catch (e) {
      failed++;
      console.log(`FAILED ${tag}: ${e.message}`);
    }
  }
  const unpaired = dups.filter((d) => !usedD.has(d.id)).length;
  console.log(
    `RESULT ${JSON.stringify({ dryRun, pollerRows: dups.length, pairs: pairs.length, [dryRun ? "wouldRemove" : "removed"]: removed, amount: Math.round(total * 100) / 100, left, failed, unpairedPollerRows: unpaired })}`,
  );
  await prisma.$disconnect();
  process.exit(failed ? 1 : 0);
})().catch(async (e) => {
  console.error(e.stack || e.message);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
