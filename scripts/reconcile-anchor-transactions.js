/**
 * Reconcile inbound Anchor credits with our local Transaction table.
 *
 * For every business with anchorAccountId, fetch the most-recent Anchor
 * transactions (BookTransaction + NIPTransaction). For each Credit (inbound),
 * insert a local Transaction(type="income") if we don't already have one
 * matching that Anchor reference.
 *
 * Idempotent — re-running is safe (dedup is per-business by reference).
 *
 * Usage:
 *   $env:DATABASE_URL = "<render postgres>"
 *   $env:ANCHOR_BASE_URL = "https://api.sandbox.getanchor.co/api/v1"
 *   $env:ANCHOR_API_KEY = "<key>"
 *   node scripts/reconcile-anchor-transactions.js
 */

const prisma = require("../src/utils/db");

const BASE = () => process.env.ANCHOR_BASE_URL;
const KEY = () => process.env.ANCHOR_API_KEY;

async function fetchAnchorTransactions(accountId, size = 50) {
  const res = await fetch(
    `${BASE()}/transactions?accountId=${encodeURIComponent(accountId)}&size=${size}`,
    { headers: { "x-anchor-key": KEY(), Accept: "application/json" } },
  );
  const data = await res.json();
  return data.data || [];
}

function normalizeAmount(raw) {
  // Anchor returns amounts in kobo. Divide by 100 to naira.
  const n = Number(raw || 0);
  if (!n) return 0;
  return n > 10000 ? n / 100 : n; // values <= 10000 are already naira (e.g. ₦100)
}

async function reconcileBusiness(biz) {
  const txs = await fetchAnchorTransactions(biz.anchorAccountId);
  let created = 0;
  for (const t of txs) {
    const a = t.attributes || {};
    const dir = (a.direction || a.transactionType || "").toLowerCase();
    if (dir !== "credit") continue;
    const amount = normalizeAmount(a.amount);
    if (amount <= 0) continue;

    const reference =
      a.reference || a.sessionId || a.transactionReference || t.id;
    if (!reference) continue;

    // Dedup: skip if we've already recorded this reference for this business
    const existing = await prisma.transaction.findFirst({
      where: {
        businessId: biz.id,
        source: "anchor",
        description: { contains: reference },
      },
    });
    if (existing) continue;

    const senderName =
      a.senderName ||
      a.sourceAccountName ||
      a.fromAccountName ||
      "another user";
    const senderBank = a.sourceBank || a.senderBank || "";
    const narration = a.narration || a.reason || "";
    let description = `Transfer received from ${senderName}`;
    if (senderBank) description += ` (${senderBank})`;
    if (narration) description += ` · "${narration}"`;
    description += ` · Ref: ${reference}`;

    await prisma.transaction.create({
      data: {
        businessId: biz.id,
        userId: biz.userId,
        type: "income",
        amount,
        description,
        category: "transfer",
        paymentMethod: "bank",
        date: a.createdAt ? new Date(a.createdAt) : new Date(),
        source: "anchor",
      },
    });
    created++;
    console.log(
      `  + ${biz.name} ← ₦${amount.toLocaleString("en-NG")} ref=${reference}`,
    );
  }
  return created;
}

async function main() {
  const bizs = await prisma.business.findMany({
    where: { anchorAccountId: { not: null } },
    select: { id: true, userId: true, name: true, anchorAccountId: true },
  });
  console.log(`Reconciling ${bizs.length} business(es)…\n`);
  let total = 0;
  for (const biz of bizs) {
    console.log(`── ${biz.name} (${biz.anchorAccountId})`);
    const n = await reconcileBusiness(biz);
    if (!n) console.log(`  (no new credits)`);
    total += n;
  }
  console.log(`\nInserted ${total} income transaction(s).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
