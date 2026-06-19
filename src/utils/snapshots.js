// Periodic history: writes health + analytics MetricSnapshots (so the dashboard
// can chart trends), records cron heartbeats, and purges old data. Driven by the
// observability cron in server.js (leader-elected via withCronLock).
const prisma = require("./db");
const { collectHealth } = require("./healthCheck");
const { getMetrics } = require("./metrics");

// Record that a cron ran (freshness signal read by collectHealth).
async function recordHeartbeat(name, status = "ok", error = null) {
  try {
    await prisma.cronHeartbeat.upsert({
      where: { name },
      create: { name, lastRunAt: new Date(), lastStatus: status, lastError: error },
      update: { lastRunAt: new Date(), lastStatus: status, lastError: error },
    });
  } catch (e) {
    console.error("[heartbeat]", name, e.message);
  }
}

async function takeHealthSnapshot() {
  const health = await collectHealth();
  const m = getMetrics();
  await prisma.metricSnapshot.create({
    data: {
      kind: "health",
      data: {
        pool: health.pool,
        memory: health.memory,
        eventLoopLagMs: health.eventLoopLagMs,
        dbLatencyMs: health.db?.latencyMs ?? null,
        errors: health.errors,
        heldTransactions: health.heldTransactions,
        requests: { total: m.totalRequests, errors5xx: m.errors5xx, errorRate5xx: m.errorRate5xx },
      },
    },
  });
  return health; // handed to the alert engine
}

async function collectAnalytics() {
  const since24h = new Date(Date.now() - 86400000);
  const [totalUsers, premiumUsers, newUsers24h, activeBusinesses, revAgg, transfers24h, bills24h, failedMoney24h, invoices] =
    await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { plan: "PREMIUM" } }),
      prisma.user.count({ where: { createdAt: { gte: since24h } } }),
      prisma.business.count({ where: { virtualAccountNumber: { not: null } } }),
      prisma.transaction.aggregate({ where: { type: "income" }, _sum: { amount: true } }),
      prisma.transaction.count({ where: { category: "transfer", type: "expense", createdAt: { gte: since24h } } }),
      prisma.transaction.count({ where: { category: "bill", createdAt: { gte: since24h } } }),
      prisma.auditLog.count({ where: { action: { contains: "FAILED" }, createdAt: { gte: since24h } } }),
      prisma.invoice.count(),
    ]);
  return {
    totalUsers,
    premiumUsers,
    newUsers24h,
    activeBusinesses,
    revenueTotal: revAgg._sum.amount || 0,
    transfers24h,
    bills24h,
    failedMoney24h,
    invoices,
    conversionPct: totalUsers ? Number(((premiumUsers / totalUsers) * 100).toFixed(1)) : 0,
  };
}

async function takeAnalyticsSnapshot() {
  const data = await collectAnalytics();
  await prisma.metricSnapshot.create({ data: { kind: "analytics", data } });
  return data;
}

// Keep ~90 days of metric snapshots. (Exception history now lives in Sentry,
// which manages its own retention.)
async function purgeRetention() {
  const snapCutoff = new Date(Date.now() - 90 * 86400000);
  await prisma.metricSnapshot.deleteMany({ where: { takenAt: { lt: snapCutoff } } });
}

module.exports = { recordHeartbeat, takeHealthSnapshot, takeAnalyticsSnapshot, collectAnalytics, purgeRetention };
