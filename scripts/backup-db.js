#!/usr/bin/env node
/**
 * Logical backup / replication for the KashBook Postgres database.
 *
 * WHY THIS EXISTS
 *   The database is the ledger of record for real customer money, and there were
 *   no backups at all (docs/GO_LIVE_CHECKLIST.md, unchecked). A single bad
 *   migration — `prisma migrate deploy` runs on every boot — or a Render
 *   incident would be unrecoverable.
 *
 * WHY PURE JS (no pg_dump)
 *   Neither the Render Node runtime nor a typical dev box has postgres client
 *   binaries. This uses only `pg`, which is already a dependency, so the same
 *   command runs locally, in a Render Cron Job, or in CI.
 *
 * HOW IT IS LOSSLESS
 *   Rows are dumped with `json_agg(t)::text` and restored with
 *   `json_populate_recordset(null::"Table", $1::json)`. The payload is moved as
 *   TEXT and is never parsed by JavaScript, so numerics, timestamps, JSONB and
 *   arrays round-trip through Postgres' own type system with no float/precision
 *   drift.
 *
 * FK ORDERING
 *   `session_replication_role = replica` is denied to the app role on Render, so
 *   the restore cannot simply disable constraint checks. Tables are instead
 *   topologically sorted from the live foreign-key graph (parents first), and
 *   deleted in reverse for a clean reload.
 *
 * TWO LAYERS, AND WHY BOTH
 *   --replicate keeps a live MIRROR for fast recovery if the primary is lost.
 *   --snapshot  keeps DATED point-in-time copies. A mirror alone does not
 *               protect you: if a bad migration or a bug corrupts the primary,
 *               the next replication faithfully copies that corruption over the
 *               last good data. Snapshots are what let you go back.
 *
 * USAGE (from server/, with -r dotenv/config to load .env)
 *   Dated snapshot into the standby, keeping the newest 60:
 *     node -r dotenv/config scripts/backup-db.js --snapshot --keep 60
 *   List stored snapshots:
 *     node -r dotenv/config scripts/backup-db.js --snapshots
 *   Mirror the primary into the standby (REPLACES the standby's contents):
 *     node -r dotenv/config scripts/backup-db.js --replicate
 *   Compare primary vs standby row counts:
 *     node -r dotenv/config scripts/backup-db.js --verify
 *   Dump to a local file:
 *     node -r dotenv/config scripts/backup-db.js --dump --out ../backups
 *   Restore (DR or rehearsal) — target is explicit and never implied:
 *     node -r dotenv/config scripts/backup-db.js --restore-snapshot latest --target postgres://...
 *     node -r dotenv/config scripts/backup-db.js --restore <file>.ndjson.gz  --target postgres://...
 *
 * SAFETY
 *   Writes NEVER default to DATABASE_URL. Every write mode refuses to run when
 *   the destination resolves to the same database as the source; restoring onto
 *   the live database requires an explicit --force-into-source.
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { Client } = require("pg");

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d = null) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const SOURCE_URL = process.env.DATABASE_URL;
const BATCH = 1000;

// Tables intentionally excluded: high-churn, self-regenerating, and never the
// reason you restore a backup.
const SKIP_TABLES = new Set(["_prisma_migrations", "MetricSnapshot", "ProcessedWebhook"]);

function log(...a) { console.log(...a); }

// Throws rather than exiting: this module is also called in-process by the
// nightly cron in server.js, where process.exit() would take the live API down.
// The CLI wrapper at the bottom turns the throw back into a non-zero exit.
function fail(msg) { throw new Error(msg); }

async function connect(url, label) {
  if (!url) fail(`${label} connection string is not set.`);
  // Render requires SSL; a local rehearsal target usually doesn't offer it.
  let local = false;
  try {
    const h = new URL(url).hostname;
    local = h === "localhost" || h === "127.0.0.1" || h === "::1";
  } catch { /* non-URL DSN — assume remote */ }
  const c = new Client({
    connectionString: url,
    ...(local ? {} : { ssl: { rejectUnauthorized: false } }),
  });
  await c.connect();
  return c;
}

async function dbIdentity(client) {
  const r = await client.query(
    `SELECT current_database() AS db, inet_server_addr()::text AS host, inet_server_port() AS port`,
  );
  return `${r.rows[0].db}@${r.rows[0].host || "local"}:${r.rows[0].port}`;
}

async function listTables(client) {
  const r = await client.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name`);
  return r.rows.map((x) => x.table_name).filter((t) => !SKIP_TABLES.has(t));
}

// child → parent edges from the live FK graph.
async function fkEdges(client) {
  const r = await client.query(`
    SELECT tc.table_name AS child, ccu.table_name AS parent
    FROM information_schema.table_constraints tc
    JOIN information_schema.constraint_column_usage ccu
      ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'`);
  return r.rows.filter((e) => e.child !== e.parent); // self-refs can't be ordered away
}

// Parents before children. Cycles (rare) are appended as-is and reported.
function topoSort(tables, edges) {
  const set = new Set(tables);
  const parentsOf = new Map(tables.map((t) => [t, new Set()]));
  for (const { child, parent } of edges) {
    if (set.has(child) && set.has(parent)) parentsOf.get(child).add(parent);
  }
  const out = [];
  const done = new Set();
  let progress = true;
  while (progress && out.length < tables.length) {
    progress = false;
    for (const t of tables) {
      if (done.has(t)) continue;
      if ([...parentsOf.get(t)].every((p) => done.has(p))) {
        out.push(t); done.add(t); progress = true;
      }
    }
  }
  const cyclic = tables.filter((t) => !done.has(t));
  if (cyclic.length) {
    log(`  ⚠ circular FK dependency, appending: ${cyclic.join(", ")}`);
    out.push(...cyclic);
  }
  return out;
}

async function rowCount(client, table) {
  const r = await client.query(`SELECT count(*)::int AS c FROM "${table}"`);
  return r.rows[0].c;
}

// Open a consistent point-in-time snapshot for the whole dump.
//
// Without this, each table is read in its own implicit transaction: a row
// inserted between two table reads yields a backup where a child references a
// parent that was never captured, and the restore fails FK checks. REPEATABLE
// READ pins one snapshot across every table, which is what pg_dump does.
// READ ONLY additionally guarantees the source cannot be modified.
async function beginSnapshot(client) {
  await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
}

// Yields JSON text batches. The payload is never parsed in JS — lossless.
// ORDER BY ctid gives stable paging; OFFSET without an order is free to return
// the same row twice, or skip one, across batches.
async function* readBatches(client, table) {
  const total = await rowCount(client, table);
  for (let off = 0; off < total; off += BATCH) {
    const r = await client.query(
      `SELECT COALESCE(json_agg(t)::text, '[]') AS j
       FROM (SELECT * FROM "${table}" ORDER BY ctid OFFSET $1 LIMIT $2) t`,
      [off, BATCH],
    );
    yield r.rows[0].j;
  }
}

async function writeTable(client, table, jsonText) {
  await client.query(
    `INSERT INTO "${table}" SELECT * FROM json_populate_recordset(null::"${table}", $1::json)`,
    [jsonText],
  );
}

// ── dump production (shared by --dump and --snapshot) ───────────────────────

/**
 * Stream a full consistent dump into `gz`. Returns the manifest.
 * The source is left inside its read-only snapshot; caller commits.
 */
async function produceDump(src, gz, { quiet = false } = {}) {
  const write = (obj) =>
    new Promise((res) => { gz.write(JSON.stringify(obj) + "\n") ? res() : gz.once("drain", res); });

  const tables = topoSort(await listTables(src), await fkEdges(src));
  const manifest = {};
  await write({ __meta: { createdAt: new Date().toISOString(), tables, format: "ndjson-v1" } });
  for (const t of tables) {
    const n = await rowCount(src, t);
    manifest[t] = n;
    for await (const batch of readBatches(src, t)) await write({ table: t, rows: batch });
    if (!quiet) log(`  ${t.padEnd(28)} ${String(n).padStart(6)} rows`);
  }
  await write({ __manifest: manifest });
  await new Promise((res) => gz.end(res));
  return manifest;
}

const totalRows = (m) => Object.values(m).reduce((a, b) => a + b, 0);

// ── modes ───────────────────────────────────────────────────────────────────

async function doDump() {
  const outDir = path.resolve(val("--out", "../backups"));
  fs.mkdirSync(outDir, { recursive: true });
  const src = await connect(SOURCE_URL, "DATABASE_URL");
  log(`source: ${await dbIdentity(src)}`);
  await beginSnapshot(src);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(outDir, `kashbook-${stamp}.ndjson.gz`);
  const gz = zlib.createGzip({ level: 9 });
  const done = new Promise((res, rej) => {
    const out = fs.createWriteStream(file);
    gz.pipe(out); out.on("finish", res); out.on("error", rej);
  });
  const manifest = await produceDump(src, gz);
  await done;
  await src.query("COMMIT"); // releases the read-only snapshot
  await src.end();

  const size = fs.statSync(file).size;
  log(`\n✔ dump complete: ${file} (${(size / 1024).toFixed(0)} KB, ${totalRows(manifest)} rows)`);
  fs.writeFileSync(file.replace(/\.ndjson\.gz$/, ".manifest.json"), JSON.stringify(manifest, null, 2));
}

// ── point-in-time snapshots, stored in the standby DB ───────────────────────
//
// WHY, given --replicate already exists: replication is a MIRROR. If a bad
// migration or a code bug corrupts the primary, the next replication copies the
// corruption over the last good copy and both are gone. Dated snapshots are the
// only thing that lets you go back to before the damage. They live as rows in
// the standby so there is no extra service to pay for or forget about — the
// whole dump is ~100 KB gzipped, so a year of dailies is a few tens of MB.

const SNAP_TABLE = "_backup_snapshot";

async function ensureSnapTable(dst) {
  await dst.query(`
    CREATE TABLE IF NOT EXISTS "${SNAP_TABLE}" (
      id          bigserial PRIMARY KEY,
      created_at  timestamptz NOT NULL DEFAULT now(),
      source      text        NOT NULL,
      row_count   integer     NOT NULL,
      byte_size   integer     NOT NULL,
      manifest    jsonb       NOT NULL,
      payload     bytea       NOT NULL
    )`);
}

async function doSnapshot() {
  const keep = parseInt(val("--keep", "60"), 10);
  const targetUrl = val("--target", process.env.BACKUP_DATABASE_URL);
  const src = await connect(SOURCE_URL, "DATABASE_URL");
  const dst = await connect(targetUrl, "BACKUP_DATABASE_URL");
  const [sId, dId] = [await dbIdentity(src), await dbIdentity(dst)];
  log(`source: ${sId}\nstore:  ${dId}`);
  if (sId === dId) fail("Snapshot store is the SAME database as the source — that protects nothing.");

  await beginSnapshot(src);
  const chunks = [];
  const gz = zlib.createGzip({ level: 9 });
  gz.on("data", (c) => chunks.push(c));
  const done = new Promise((res, rej) => { gz.on("end", res); gz.on("error", rej); gz.resume(); });
  const manifest = await produceDump(src, gz, { quiet: true });
  await done;
  await src.query("COMMIT");
  await src.end();

  const payload = Buffer.concat(chunks);
  await ensureSnapTable(dst);
  const ins = await dst.query(
    `INSERT INTO "${SNAP_TABLE}" (source, row_count, byte_size, manifest, payload)
     VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at`,
    [sId, totalRows(manifest), payload.length, JSON.stringify(manifest), payload],
  );
  const { id, created_at: at } = ins.rows[0];
  log(`\n✔ snapshot #${id} stored — ${totalRows(manifest)} rows, ${(payload.length / 1024).toFixed(0)} KB, at ${at.toISOString()}`);

  if (keep > 0) {
    const del = await dst.query(
      `DELETE FROM "${SNAP_TABLE}" WHERE id NOT IN (
         SELECT id FROM "${SNAP_TABLE}" ORDER BY created_at DESC LIMIT $1) RETURNING id`,
      [keep],
    );
    if (del.rowCount) log(`  retention: pruned ${del.rowCount} snapshot(s), keeping newest ${keep}`);
  }
  await dst.end();
}

async function doSnapshots() {
  const dst = await connect(val("--target", process.env.BACKUP_DATABASE_URL), "BACKUP_DATABASE_URL");
  await ensureSnapTable(dst);
  const r = await dst.query(
    `SELECT id, created_at, row_count, byte_size FROM "${SNAP_TABLE}" ORDER BY created_at DESC LIMIT 50`);
  if (!r.rowCount) log("no snapshots stored yet — run --snapshot");
  else {
    log(`${r.rowCount} snapshot(s), newest first:\n`);
    for (const s of r.rows) {
      log(`  #${String(s.id).padStart(4)}  ${s.created_at.toISOString()}  ${String(s.row_count).padStart(7)} rows  ${(s.byte_size / 1024).toFixed(0).padStart(5)} KB`);
    }
    log(`\nrestore one with:  node scripts/backup-db.js --restore-snapshot <id> --target <url>`);
  }
  await dst.end();
}

async function loadInto(target, tables, getBatches, { quiet = false } = {}) {
  // TRUNCATE, not DELETE, for two reasons:
  //   1. AuditLog carries an append-only BEFORE UPDATE OR DELETE row trigger
  //      (migration 20260803170000). DELETE is refused by design; TRUNCATE is a
  //      table-level operation that never fires row triggers, which is correct
  //      here — the target is a replica being rebuilt, not an audit trail being
  //      tampered with.
  //   2. One statement listing every table resolves FK order by itself, and is
  //      far faster than per-table DELETE.
  // No CASCADE: if a table outside this list references one inside it, we want a
  // loud error rather than silently truncating something we never enumerated.
  const list = tables.map((t) => `"${t}"`).join(", ");
  await target.query(`TRUNCATE TABLE ${list}`);
  for (const t of tables) {
    let n = 0;
    for await (const batch of getBatches(t)) {
      if (batch && batch !== "[]") {
        await writeTable(target, t, batch);
        n += JSON.parse(batch).length;
      }
    }
    if (!quiet) log(`  ${t.padEnd(28)} ${String(n).padStart(6)} rows`);
  }
}

async function doReplicate() {
  const targetUrl = val("--target", process.env.BACKUP_DATABASE_URL);
  const src = await connect(SOURCE_URL, "DATABASE_URL");
  const dst = await connect(targetUrl, "BACKUP_DATABASE_URL");
  const [sId, dId] = [await dbIdentity(src), await dbIdentity(dst)];
  log(`source: ${sId}\ntarget: ${dId}`);
  if (sId === dId) fail("Target is the SAME database as the source — refusing to overwrite production.");

  const tables = topoSort(await listTables(src), await fkEdges(src));
  log(`\nreplicating ${tables.length} tables (target contents are replaced)…`);
  await beginSnapshot(src);
  await dst.query("BEGIN");
  try {
    await loadInto(dst, tables, (t) => readBatches(src, t));
    await dst.query("COMMIT");
  } catch (e) {
    await dst.query("ROLLBACK");
    fail(`replication failed, target rolled back unchanged: ${e.message}`);
  }
  // Verify against the SAME snapshot the copy was taken from, so rows written
  // during replication don't read as data loss.
  let ok = true;
  for (const t of tables) {
    const [a, b] = [await rowCount(src, t), await rowCount(dst, t)];
    if (a !== b) { ok = false; log(`  ✖ ${t}: source ${a} vs target ${b}`); }
  }
  await src.query("COMMIT");
  await src.end(); await dst.end();
  log(ok ? "\n✔ replication verified — row counts match on every table." : "\n✖ MISMATCH after replication (see above).");
  if (!ok) process.exit(1);
}

async function doVerify() {
  const targetUrl = val("--target", process.env.BACKUP_DATABASE_URL);
  const src = await connect(SOURCE_URL, "DATABASE_URL");
  const dst = await connect(targetUrl, "BACKUP_DATABASE_URL");
  log(`source: ${await dbIdentity(src)}\ntarget: ${await dbIdentity(dst)}\n`);
  const tables = await listTables(src);
  let drift = 0;
  for (const t of tables) {
    const a = await rowCount(src, t);
    let b;
    try { b = await rowCount(dst, t); } catch { b = "MISSING"; }
    const same = a === b;
    if (!same) drift++;
    log(`  ${same ? " " : "✖"} ${t.padEnd(28)} source ${String(a).padStart(6)}  target ${String(b).padStart(6)}`);
  }
  await src.end(); await dst.end();
  log(drift ? `\n✖ ${drift} table(s) differ — run --replicate.` : `\n✔ standby is in sync.`);
  if (drift) fail(`${drift} table(s) out of sync`);
}

// Guard every write path: never let a restore land on the live database by
// accident. Requires an explicit flag to override, for the real DR case.
async function assertNotLive(dst, dId) {
  if (!SOURCE_URL) return;
  const src = await connect(SOURCE_URL, "DATABASE_URL");
  const sId = await dbIdentity(src);
  await src.end();
  if (sId === dId && !has("--force-into-source")) {
    fail(`Target is the LIVE database (${dId}). Pass --force-into-source only for a deliberate production restore.`);
  }
}

async function restoreFromBuffer(dst, buf, label) {
  const lines = zlib.gunzipSync(buf).toString("utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const meta = lines.find((l) => l.__meta)?.__meta;
  if (!meta) fail("snapshot has no __meta header — wrong file?");
  // Group batches by table; the dump is already in parent-first order.
  const byTable = new Map(meta.tables.map((t) => [t, []]));
  for (const l of lines) if (l.table) byTable.get(l.table)?.push(l.rows);

  await dst.query("BEGIN");
  try {
    await loadInto(dst, meta.tables, async function* (t) { yield* byTable.get(t) || []; });
    await dst.query("COMMIT");
  } catch (e) {
    await dst.query("ROLLBACK");
    fail(`restore failed, target rolled back unchanged: ${e.message}`);
  }
  log(`\n✔ restore complete from ${label} (snapshot taken ${meta.createdAt}).`);
}

async function doRestore() {
  const file = val("--restore");
  const targetUrl = val("--target");
  if (!file || !fs.existsSync(file)) fail("--restore <file> not found");
  if (!targetUrl) fail("--target <connection string> is required for a restore");
  const dst = await connect(targetUrl, "--target");
  const dId = await dbIdentity(dst);
  await assertNotLive(dst, dId);
  log(`target: ${dId}\nreading ${file}…`);
  await restoreFromBuffer(dst, fs.readFileSync(file), path.basename(file));
  await dst.end();
}

async function doRestoreSnapshot() {
  const id = val("--restore-snapshot");
  const targetUrl = val("--target");
  if (!targetUrl) fail("--target <connection string> is required for a restore");
  const store = await connect(process.env.BACKUP_DATABASE_URL, "BACKUP_DATABASE_URL");
  const r = await store.query(
    id === "latest"
      ? `SELECT id, created_at, payload FROM "${SNAP_TABLE}" ORDER BY created_at DESC LIMIT 1`
      : `SELECT id, created_at, payload FROM "${SNAP_TABLE}" WHERE id = $1`,
    id === "latest" ? [] : [id],
  );
  if (!r.rowCount) fail(`snapshot ${id} not found — list them with --snapshots`);
  const snap = r.rows[0];
  await store.end();

  const dst = await connect(targetUrl, "--target");
  const dId = await dbIdentity(dst);
  await assertNotLive(dst, dId);
  log(`target: ${dId}\nrestoring snapshot #${snap.id} from ${snap.created_at.toISOString()}…`);
  await restoreFromBuffer(dst, snap.payload, `snapshot #${snap.id}`);
  await dst.end();
}

/**
 * Nightly job: dated snapshot first, then refresh the mirror.
 *
 * Order matters. The snapshot is the copy that survives logical corruption, so
 * it is taken BEFORE the mirror is overwritten — if the primary is already
 * corrupt, the previous mirror is at least still intact until the snapshot of
 * record exists.
 *
 * Returns a small summary; throws on failure so the caller can alert.
 */
async function scheduledBackup({ keep = 60 } = {}) {
  if (!process.env.BACKUP_DATABASE_URL) {
    return { skipped: "BACKUP_DATABASE_URL not set" };
  }
  const src = await connect(SOURCE_URL, "DATABASE_URL");
  const dst = await connect(process.env.BACKUP_DATABASE_URL, "BACKUP_DATABASE_URL");
  try {
    const [sId, dId] = [await dbIdentity(src), await dbIdentity(dst)];
    if (sId === dId) fail("BACKUP_DATABASE_URL points at the live database");

    // 1. Dated snapshot.
    await beginSnapshot(src);
    const chunks = [];
    const gz = zlib.createGzip({ level: 9 });
    gz.on("data", (c) => chunks.push(c));
    const done = new Promise((res, rej) => { gz.on("end", res); gz.on("error", rej); gz.resume(); });
    const manifest = await produceDump(src, gz, { quiet: true });
    await done;
    const payload = Buffer.concat(chunks);
    await ensureSnapTable(dst);
    const ins = await dst.query(
      `INSERT INTO "${SNAP_TABLE}" (source, row_count, byte_size, manifest, payload)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [sId, totalRows(manifest), payload.length, JSON.stringify(manifest), payload],
    );
    await dst.query(
      `DELETE FROM "${SNAP_TABLE}" WHERE id NOT IN (
         SELECT id FROM "${SNAP_TABLE}" ORDER BY created_at DESC LIMIT $1)`, [keep]);

    // 2. Refresh the mirror from the SAME snapshot, so both layers agree.
    const tables = topoSort(await listTables(src), await fkEdges(src));
    await dst.query("BEGIN");
    try {
      await loadInto(dst, tables, (t) => readBatches(src, t), { quiet: true });
      await dst.query("COMMIT");
    } catch (e) {
      await dst.query("ROLLBACK");
      throw e;
    }
    await src.query("COMMIT");

    return { snapshotId: ins.rows[0].id, rows: totalRows(manifest), bytes: payload.length, tables: tables.length };
  } finally {
    await src.end().catch(() => {});
    await dst.end().catch(() => {});
  }
}

module.exports = { scheduledBackup };

// CLI entry point — only when run directly, not when required by server.js.
if (require.main === module) {
  (async () => {
    if (has("--dump")) return doDump();
    if (has("--snapshot")) return doSnapshot();
    if (has("--snapshots")) return doSnapshots();
    if (has("--replicate")) return doReplicate();
    if (has("--verify")) return doVerify();
    if (has("--restore-snapshot")) return doRestoreSnapshot();
    if (has("--restore")) return doRestore();
    console.log(fs.readFileSync(__filename, "utf8").split("*/")[0].replace(/^#!.*\n/, ""));
  })().catch((e) => { console.error(`\n✖ ${e.message}\n`); process.exit(1); });
}
