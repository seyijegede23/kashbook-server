// READ-ONLY capacity benchmark of the REAL Postgres behind KashBook.
//
// Runs the queries the hot endpoints actually run (transaction list, business
// fetch, dashboard aggregate) at an increasing concurrency ramp and reports
// queries/sec + latency percentiles — so we see the DB's real read capacity,
// not just /health's SELECT 1.
//
// SAFETY: read-only (SELECT) only. Checks max_connections + current usage first
// and CAPS its own concurrency to leave headroom for the live app. Moves no
// money, writes nothing.
//
// Run locally against the external Render URL (network-RTT caveated):
//   cd server && node -r dotenv/config scripts/db-bench.js
// Run IN the Render Shell for true same-region numbers (no client RTT):
//   node scripts/db-bench.js
//
// Optional args:  node scripts/db-bench.js <maxConc> <durationSec>

const { Pool } = require("pg");

function connString() {
  const raw = process.env.DATABASE_URL || "";
  try { const u = new URL(raw); u.searchParams.delete("sslmode"); return u.toString(); } catch { return raw; }
}

const REQ_MAX = Number(process.argv[2]) || 16;   // requested max concurrency (auto-capped below)
const DUR = Number(process.argv[3]) || 10;        // seconds per ramp rung
const RAMP = [1, 4, 8, 16, 24, 32];

const pct = (arr, p) => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!process.env.DATABASE_URL) { console.error("DATABASE_URL not set"); process.exit(1); }
  const host = (() => { try { return new URL(process.env.DATABASE_URL).hostname; } catch { return "?"; } })();
  const sameRegion = !/render\.com$/.test(host) || /\binternal\b/.test(host) || host.endsWith("-a"); // internal Render host has no region subdomain
  console.log(`DB host: ${host}`);

  // Recon pool (tiny).
  const recon = new Pool({ connectionString: connString(), ssl: { rejectUnauthorized: false }, max: 2, connectionTimeoutMillis: 10000 });
  const maxConn = Number((await recon.query("SHOW max_connections")).rows[0].max_connections);
  const curConn = Number((await recon.query("SELECT count(*)::int AS n FROM pg_stat_activity")).rows[0].n);
  const available = maxConn - curConn;
  // Use at most half the free headroom, never more than requested, and never within 10 of the limit.
  const cap = Math.max(1, Math.min(REQ_MAX, available - 10, Math.floor(available * 0.5)));
  console.log(`max_connections=${maxConn}  current=${curConn}  available=${available}  -> concurrency cap=${cap}`);

  // Pick the busiest business for realistic, non-trivial query cost.
  const busiest = (await recon.query(
    `SELECT "businessId" AS id, count(*)::int AS n FROM "Transaction" GROUP BY "businessId" ORDER BY n DESC LIMIT 1`
  )).rows[0] || null;
  const counts = {};
  for (const t of ["User", "Business", "Transaction", "Customer", "InventoryItem"]) {
    try { counts[t] = Number((await recon.query(`SELECT count(*)::int AS n FROM "${t}"`)).rows[0].n); } catch { counts[t] = "n/a"; }
  }
  console.log("row counts:", JSON.stringify(counts));
  if (!busiest) { console.error("No transactions found to benchmark against."); await recon.end(); process.exit(1); }
  console.log(`benchmark business: ${busiest.id} (${busiest.n} transactions)\n`);
  await recon.end();

  // The realistic hot-path queries.
  const QUERIES = {
    "txn-list (GET /transactions)": {
      sql: `SELECT id, type, amount, description, category, "paymentMethod", date FROM "Transaction" WHERE "businessId" = $1 ORDER BY date DESC LIMIT 50`,
      params: [busiest.id],
    },
    "dashboard-agg (income/expense sums)": {
      sql: `SELECT type, COALESCE(SUM(amount), 0) AS total, count(*)::int AS n FROM "Transaction" WHERE "businessId" = $1 GROUP BY type`,
      params: [busiest.id],
    },
  };

  const pool = new Pool({ connectionString: connString(), ssl: { rejectUnauthorized: false }, max: cap, connectionTimeoutMillis: 10000 });
  // Warm the pool.
  await Promise.all(Array.from({ length: Math.min(cap, 4) }, () => pool.query("SELECT 1")));

  for (const [name, q] of Object.entries(QUERIES)) {
    console.log(`########## ${name} ##########`);
    console.log(`conc │   q/s  │  p50   │  p95   │  p99   │  max   │ errors`);
    for (const c of RAMP.filter((x) => x <= cap)) {
      const deadline = Date.now() + DUR * 1000;
      const lat = []; let errors = 0;
      const worker = async () => {
        while (Date.now() < deadline) {
          const t = process.hrtime.bigint();
          try { await pool.query(q.sql, q.params); lat.push(Number(process.hrtime.bigint() - t) / 1e6); }
          catch { errors++; }
        }
      };
      await Promise.all(Array.from({ length: c }, worker));
      const qps = (lat.length / DUR).toFixed(0);
      console.log(
        `${String(c).padStart(4)} │ ${String(qps).padStart(6)} │ ${pct(lat, 50).toFixed(0).padStart(5)}ms │ ${pct(lat, 95).toFixed(0).padStart(5)}ms │ ${pct(lat, 99).toFixed(0).padStart(5)}ms │ ${Math.max(0, ...lat).toFixed(0).padStart(5)}ms │ ${errors}`
      );
      await sleep(500);
    }
    console.log();
  }

  await pool.end();
  console.log(sameRegion
    ? "Note: same-region run — latency reflects true DB time."
    : "Note: run from OUTSIDE Render — per-query latency includes client<->Oregon network RTT; q/s per connection is RTT-bound. For true DB capacity, run this in the Render Shell.");
  process.exit(0);
})().catch((e) => { console.error("bench error:", e.message); process.exit(1); });
