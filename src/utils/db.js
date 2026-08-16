const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");
const { Pool } = require("pg");

// Render's INTERNAL Postgres serves a SELF-SIGNED cert over its private network,
// which `sslmode=verify-full` rejects ("self-signed certificate"). Drop any
// sslmode from the URL and connect with SSL but WITHOUT CA verification — safe
// because the internal link is Render's private network (and the external/local
// connection tolerates it too). The traffic is still encrypted.
function dbConnectionString() {
  const raw = process.env.DATABASE_URL || "";
  try {
    const u = new URL(raw);
    u.searchParams.delete("sslmode");
    return u.toString();
  } catch {
    return raw;
  }
}

// A local Postgres is not built with SSL support, so forcing it there fails the
// connection outright ("The server does not support SSL connections") — which
// blocked running the money-path tests against a scratch database. Only
// localhost is exempted; every hosted database keeps SSL exactly as before.
function isLocalDb() {
  try {
    const h = new URL(process.env.DATABASE_URL || "").hostname;
    return h === "localhost" || h === "127.0.0.1" || h === "::1";
  } catch {
    return false;
  }
}

const pool = new Pool({
  connectionString: dbConnectionString(),
  ssl: process.env.DATABASE_URL && !isLocalDb() ? { rejectUnauthorized: false } : undefined,
  keepAlive: true,                // TCP keepalive — stop NAT/idle drops on Render
  idleTimeoutMillis: 30000,       // recycle idle clients before the DB/network kills the socket
  connectionTimeoutMillis: 10000, // fail fast instead of hanging on a bad connect
  // Pool size PER INSTANCE. Render Postgres allows 103 connections, so keep
  // (instances × max) comfortably under that — e.g. 4 instances × 25 = 100.
  // Tunable via env (no code change) for load testing / scaling.
  max: Number(process.env.DB_POOL_MAX) || 25,
});

// CRITICAL: node-postgres emits an 'error' on the POOL when an *idle* client's
// connection is dropped (Render Postgres / the network closes idle sockets).
// With no listener, Node rethrows it as an uncaughtException and the whole API
// crashes — which is the "Connection terminated unexpectedly" → restart loop
// seen in the Render logs. Handling it here keeps a dead idle socket from taking
// the process down; the pool simply discards that client and opens a fresh one.
pool.on("error", (err) => {
  console.error("[db] idle pool client error (handled, non-fatal):", err.message);
});

// The pool's 'error' above only covers IDLE clients. When a connection dies on a
// client that is currently CHECKED OUT (mid-query, e.g. Prisma using it), pg does
// `client.emit('error', …)` — and Node THROWS if that client has no 'error'
// listener, surfacing as an uncaughtException (pg client.js:180 "Connection
// terminated unexpectedly") that crashes the process. Attaching a listener to
// every client the moment it connects protects it for its whole life (idle AND
// in-use), so a dropped socket is logged instead of crashing. Pending queries
// still reject normally and propagate to the caller — this only stops the throw.
pool.on("connect", (client) => {
  client.on("error", (err) => {
    console.error("[db] pg client error (handled, non-fatal):", err.message);
  });
});

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
// Accepts one key or several. SEVERAL KEYS ARE TAKEN ON THE SAME CONNECTION,
// deliberately, and this matters more than it looks.
//
// A staff transfer needs two critical sections at once: per-business (the
// balance and AML read-then-spend) and per-staff (the daily cap, which sums
// across every business that staff member acts for). The obvious way to get
// both is to nest two withBusinessLock calls — and that is a trap. Each call
// checks out a pooled client and holds it idle-in-transaction for the whole of
// fn(), while the Prisma work INSIDE fn() draws from that same pool (max 25).
// Nesting doubles the held connections per request, and enough concurrent staff
// sends would leave every connection parked waiting for one that can never be
// freed — a self-inflicted deadlock, on the money path.
//
// Taking both locks in one transaction costs one connection instead of two and
// removes the lock-ordering question entirely: a single transaction acquires
// them in the order given, so there is no cycle to construct.
//
//   - pg_advisory_xact_lock auto-releases on COMMIT/ROLLBACK or if the
//     connection drops (process crash) — the lock can never leak.
//   - SET LOCAL statement_timeout bounds ONLY the lock-acquisition wait, so a
//     stuck holder can't pin a business's money-out forever (the waiter aborts).
//     While fn() runs, this connection is idle-in-transaction (no statement),
//     so the timeout doesn't kill the in-flight work.
async function withBusinessLock(businessId, fn) {
  const keys = (Array.isArray(businessId) ? businessId : [businessId]).filter(Boolean);
  if (!keys.length) return fn();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = '25000'");
    for (const k of keys) {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [String(k)]);
    }
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
