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
const { recalcInvoiceStatus } = require("./invoiceStatus");
const { SINGLE_FLAG_ABOVE } = require("../config/amlLimits");
const {
  extractSender,
  buildInboundNotification,
  buildInboundDescription,
} = require("./inboundCreditNotification");

const BASE = () => process.env.ANCHOR_BASE_URL;
const KEY = () => process.env.ANCHOR_API_KEY;

async function fetchAnchorTransactions(accountId, size = 50) {
  if (!BASE() || !KEY()) throw new Error("Anchor env not configured");
  const res = await fetch(
    `${BASE()}/transactions?accountId=${encodeURIComponent(accountId)}&size=${size}`,
    { headers: { "x-anchor-key": KEY(), Accept: "application/json" } },
  );
  if (!res.ok) {
    const err = new Error(`Anchor transactions fetch failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  return data.data || [];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

    const sender = extractSender(a);
    const narration = a.narration || a.reason || "";
    const description = buildInboundDescription({ sender, narration, reference });

    // Read the owner's compliance status — inbound credits to a frozen
    // user or business still post (the money is already moved) but get
    // held/flagged for review.
    const owner = await prisma.user.findUnique({
      where: { id: biz.userId },
      select: { accountStatus: true },
    });
    const frozen =
      (owner?.accountStatus && owner.accountStatus !== "active") ||
      (biz.accountStatus && biz.accountStatus !== "active");
    const flagCTR = amount >= SINGLE_FLAG_ABOVE;
    const flagSeverity = frozen ? "high" : (flagCTR ? "medium" : null);
    const complianceStatus = frozen ? "held" : (flagCTR ? "flagged" : "clean");

    const txn = await prisma.transaction.create({
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
        flagSeverity,
        complianceStatus,
      },
    });

    // Persist ComplianceFlag rows for any inbound that warrants review.
    if (frozen || flagCTR) {
      await prisma.complianceFlag.create({
        data: {
          userId: biz.userId,
          businessId: biz.id,
          transactionId: txn.id,
          ruleCode: frozen ? "INBOUND_TO_FROZEN" : "CTR_THRESHOLD",
          severity: frozen ? "high" : "medium",
          description: frozen
            ? `Inbound credit of ₦${amount.toLocaleString("en-NG")} arrived on a frozen account.`
            : `Inbound credit of ₦${amount.toLocaleString("en-NG")} meets the CTR auto-flag threshold.`,
          metadata: { amount, senderName: sender.name || sender.label, senderBank: sender.bank, senderAccountNumber: sender.accountNumber },
        },
      });
    }

    const { title, body } = buildInboundNotification({
      business: biz,
      amount,
      sender,
      narration,
    });
    await pushTo(biz.userId, title, body);

    // Auto-reconcile: if exactly one open invoice matches the credited amount
    // within the last 90 days, record a payment and recalc status.
    await tryMatchInvoice(biz, amount, reference).catch((err) =>
      console.warn(`[reconcile] invoice match failed for ${biz.name}: ${err.message}`),
    );

    created++;
    if (onCreate) onCreate({ biz, amount, reference });
  }
  return created;
}

async function tryMatchInvoice(biz, amount, reference) {
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10);

  const candidates = await prisma.invoice.findMany({
    where: {
      businessId: biz.id,
      status: { in: ["SENT", "PARTIAL", "OVERDUE"] },
      issueDate: { gte: ninetyDaysAgo },
    },
    select: {
      id: true, invoiceNumber: true, total: true, amountPaid: true, dueDate: true, status: true,
    },
  });

  // Match candidates whose remaining balance equals the credited amount.
  const matches = candidates.filter(
    (c) => Math.abs((c.total - c.amountPaid) - amount) < 0.01,
  );
  if (matches.length !== 1) return; // 0 = no match; >1 = ambiguous, defer to user

  const inv = matches[0];
  await prisma.invoicePayment.create({
    data: {
      invoiceId: inv.id,
      amount,
      method: "bank",
      note: `NUBAN transfer · ${reference}`,
    },
  });

  const newAmountPaid = inv.amountPaid + amount;
  const newStatus = recalcInvoiceStatus({
    amountPaid: newAmountPaid,
    total: inv.total,
    dueDate: inv.dueDate,
    status: inv.status,
  });

  await prisma.invoice.update({
    where: { id: inv.id },
    data: { amountPaid: newAmountPaid, status: newStatus },
  });

  await pushTo(
    biz.userId,
    "Invoice Paid ✅",
    `${inv.invoiceNumber} marked ${newStatus.toLowerCase()} via NUBAN`,
  );
}

async function reconcileAll({ onCreate, logger, throttleMs = 1500 } = {}) {
  const bizs = await prisma.business.findMany({
    where: { anchorAccountId: { not: null } },
    select: {
      id: true, userId: true, name: true, anchorAccountId: true,
      accountStatus: true,
    },
  });
  let total = 0;
  let rateLimited = 0;
  let backoff = throttleMs;
  for (let i = 0; i < bizs.length; i++) {
    const biz = bizs[i];
    try {
      const n = await reconcileBusiness(biz, { onCreate });
      total += n;
      backoff = throttleMs;
    } catch (err) {
      if (err.status === 429) {
        rateLimited++;
        backoff = Math.min(backoff * 2, 30_000);
      } else if (logger) {
        logger(`[reconcile] ${biz.name}: ${err.message}`);
      }
    }
    if (i < bizs.length - 1) await sleep(backoff);
  }
  if (rateLimited > 0 && logger) {
    logger(`[reconcile] rate-limited on ${rateLimited}/${bizs.length} business(es) — will retry next cycle`);
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
      // Leader-elect across instances so only one reconciles per tick (the
      // in-process `running` guard above only covers reentrancy on one instance).
      const total = (await prisma.withCronLock(4004, async () => {
        await require("./snapshots").recordHeartbeat("reconcile");
        return reconcileAll({
          onCreate: ({ biz, amount, reference }) => {
            console.log(
              `[reconcile] +${biz.name} ←₦${amount.toLocaleString("en-NG")} ref=${reference}`,
            );
          },
          logger: (msg) => console.warn(msg),
        });
      })) || 0;
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
