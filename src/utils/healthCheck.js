// Point-in-time health snapshot — reused by GET /admin-api/health, the snapshot
// cron (history), and the alerts engine. Keep the queries light + parallel so
// collecting health never itself stresses the pool.
const prisma = require("./db");
const { eventLoopLagMs } = require("./metrics");

// Nominal cadence per cron (minutes) → used to flag a cron as stale (> 2×).
const CRON_INTERVAL_MIN = {
  dailyReport: 24 * 60,
  lowStock: 60,
  recurringExpenses: 24 * 60,
  reminders: 5,
  reconcile: 5,
  snapshot: 10,
  kycPurge: 24 * 60,
};

async function pingDb() {
  const t = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { ok: true, latencyMs: Date.now() - t };
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - t, error: e.message };
  }
}

function depsConfigured() {
  return {
    anchor: !!(process.env.ANCHOR_BASE_URL && process.env.ANCHOR_API_KEY),
    dojah: !!(process.env.DOJAH_APP_ID && process.env.DOJAH_SECRET_KEY),
    smtp: !!(process.env.SMTP_HOST && process.env.SMTP_USER),
    whatsapp: !!(process.env.WHATSAPP_PHONE_NUMBER_ID && process.env.WHATSAPP_ACCESS_TOKEN),
    cloudinary: !!process.env.CLOUDINARY_CLOUD_NAME,
  };
}

async function collectHealth() {
  const now = Date.now();
  const since1h = new Date(now - 60 * 60 * 1000);
  const since24h = new Date(now - 24 * 60 * 60 * 1000);

  const [db, heartbeats, warn1h, alert1h, openFlags, heldTx, failed24h] =
    await Promise.all([
      pingDb(),
      prisma.cronHeartbeat.findMany(),
      prisma.auditLog.count({ where: { severity: "warn", createdAt: { gte: since1h } } }),
      prisma.auditLog.count({ where: { severity: "alert", createdAt: { gte: since1h } } }),
      prisma.complianceFlag.groupBy({ by: ["severity"], where: { status: "open" }, _count: true }),
      prisma.transaction.count({ where: { complianceStatus: "held" } }),
      prisma.auditLog.count({ where: { action: { contains: "FAILED" }, createdAt: { gte: since24h } } }),
    ]);

  const crons = heartbeats.map((h) => {
    const ageMin = (now - new Date(h.lastRunAt).getTime()) / 60000;
    const expected = CRON_INTERVAL_MIN[h.name] || 60;
    return {
      name: h.name,
      lastRunAt: h.lastRunAt,
      ageMin: Math.round(ageMin),
      status: h.lastStatus,
      stale: ageMin > expected * 2,
    };
  });

  const mem = process.memoryUsage();
  return {
    uptimeSec: Math.round(process.uptime()),
    memory: { rssMB: Math.round(mem.rss / 1048576), heapUsedMB: Math.round(mem.heapUsed / 1048576) },
    eventLoopLagMs: eventLoopLagMs(),
    pool: prisma.poolStats(),
    db,
    deps: depsConfigured(),
    crons,
    // Audit/compliance signals (exception tracking itself now lives in Sentry).
    errors: { warn1h, alert1h, failed24h },
    compliance: Object.fromEntries(openFlags.map((f) => [f.severity, f._count])),
    heldTransactions: heldTx,
  };
}

module.exports = { collectHealth, CRON_INTERVAL_MIN };
