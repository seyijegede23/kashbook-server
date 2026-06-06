/**
 * Reconcile inbound Anchor credits with our local Transaction table.
 *
 * For every business with an anchorAccountId, fetch the latest Anchor
 * transactions and insert a local income Transaction for any credit we don't
 * already have. Dedup is per-business by Anchor reference.
 *
 * Used by:
 *   - scripts/reconcile-anchor-transactions.js (one-shot CLI)
 *   - server.js (periodic safety net — runs every 2 min in case webhooks drop)
 */

const prisma = require("./db");
const { pushTo } = require("./pushNotification");

const BASE = () => process.env.ANCHOR_BASE_URL;
const KEY = () => process.env.ANCHOR_API_KEY;

async function fetchAnchorTransactions(accountId, size = 50) {
  if (!BASE() || !KEY()) throw new Error("Anchor env not configured");
  const res = await fetch(
    `${BASE()}/transactions?accountId=${encodeURIComponent(accountId)}&size=${size}`,
    { headers: { "x-anchor-key": KEY(), Accept: "application/json" } },
  );
  if (!res.ok) {
    throw new Error(`Anchor transactions fetch failed (${res.status})`);
  }
  const data = await res.json();
  return data.data || [];
}

function normalizeAmount(raw) {
  // Anchor's transactions API returns amounts in kobo. Divide by 100.
  // Values <= 10000 are treated as already-in-naira (e.g. tiny test amounts).
  const n = Number(raw || 0);
  if (!n) return 0;
  return n > 10000 ? n / 100 : n;
}

async function reconcileBusiness(biz, { onCreate } = {}) {
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
    const notifBody = `₦${amount.toLocaleString("en-NG", {
      minimumFractionDigits: 2,
    })} from ${senderName} → ${biz.name}`;
    await pushTo(biz.userId, "Payment Received 🎉", notifBody);
    created++;
    if (onCreate) onCreate({ biz, amount, reference });
  }
  return created;
}

async function reconcileAll({ onCreate, logger } = {}) {
  const bizs = await prisma.business.findMany({
    where: { anchorAccountId: { not: null } },
    select: { id: true, userId: true, name: true, anchorAccountId: true },
  });
  let total = 0;
  for (const biz of bizs) {
    try {
      const n = await reconcileBusiness(biz, { onCreate });
      total += n;
    } catch (err) {
      if (logger) logger(`[reconcile] ${biz.name}: ${err.message}`);
    }
  }
  return total;
}

/**
 * Start a background loop that calls reconcileAll() every `intervalMs`.
 * Logs new credits to console. Returns a stopper function.
 */
function startReconciliationLoop(intervalMs = 2 * 60 * 1000) {
  if (!BASE() || !KEY()) {
    console.warn("[reconcile] skipped: Anchor not configured");
    return () => {};
  }
  console.log(`[reconcile] started, interval=${intervalMs}ms`);
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const total = await reconcileAll({
        onCreate: ({ biz, amount, reference }) => {
          console.log(
            `[reconcile] +${biz.name} ←₦${amount.toLocaleString("en-NG")} ref=${reference}`,
          );
        },
        logger: (msg) => console.warn(msg),
      });
      if (total > 0) console.log(`[reconcile] inserted ${total} credit(s)`);
    } catch (err) {
      console.error("[reconcile] loop error:", err.message);
    } finally {
      running = false;
    }
  };
  const id = setInterval(tick, intervalMs);
  // Run once at boot so we don't wait for the first interval to backfill any
  // events missed during the deploy window.
  setTimeout(tick, 5_000);
  return () => clearInterval(id);
}

module.exports = {
  reconcileAll,
  reconcileBusiness,
  startReconciliationLoop,
};
