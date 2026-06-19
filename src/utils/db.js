const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");
const { Pool } = require("pg");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// Serialize money-out (and other per-business critical sections) so concurrent
// requests for the SAME business run one-at-a-time, while different businesses
// stay fully parallel. Uses a transaction-scoped Postgres advisory lock on a
// dedicated pooled connection:
//   - pg_advisory_xact_lock auto-releases on COMMIT/ROLLBACK or if the
//     connection drops (process crash) — the lock can never leak.
//   - SET LOCAL statement_timeout bounds ONLY the lock-acquisition wait, so a
//     stuck holder can't pin a business's money-out forever (the waiter aborts).
//     While fn() runs, this connection is idle-in-transaction (no statement),
//     so the timeout doesn't kill the in-flight work.
async function withBusinessLock(businessId, fn) {
  if (!businessId) return fn();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = '25000'");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [businessId]);
    const result = await fn();
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch {}
    throw err;
  } finally {
    client.release();
  }
}
prisma.withBusinessLock = withBusinessLock;

// Run a periodic job on at most one instance at a time. Uses a session-level
// advisory lock held on a dedicated connection for the job's duration: if
// another instance already holds it, pg_try_advisory_lock returns false and we
// skip this tick. No-op safety on a single instance (always acquires).
// `lockKey` is a distinct integer per job.
async function withCronLock(lockKey, fn) {
  const client = await pool.connect();
  try {
    const { rows } = await client.query("SELECT pg_try_advisory_lock($1) AS ok", [lockKey]);
    if (!rows[0]?.ok) {
      console.log(`[cron] lock ${lockKey} held by another instance — skipping`);
      return;
    }
    try {
      return await fn();
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [lockKey]).catch(() => {});
    }
  } finally {
    client.release();
  }
}
prisma.withCronLock = withCronLock;

// Live connection-pool stats — the tightest scaling signal (max defaults to 10).
prisma.poolStats = () => ({
  total: pool.totalCount,
  idle: pool.idleCount,
  waiting: pool.waitingCount,
  max: pool.options?.max || 10,
});

module.exports = prisma;
