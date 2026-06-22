// Applies a single hand-written Prisma migration via the `pg` driver and records
// it in _prisma_migrations — used because the Prisma migrate engine can't reach
// the Render DB from local dev (verify-full TLS / engine networking), while the
// pg driver connects fine (same connection the app uses).
//
// SAFETY: before recording anything, it recomputes the checksum of an already
// APPLIED migration and compares it to the value Prisma stored. If they don't
// match, the checksum algorithm is wrong and we ABORT (so we never write a row
// that would later make `prisma migrate deploy` reject the history in prod).
//
// Usage: node -r dotenv/config scripts/apply-migration.js <migration_dir_name>

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}
function readMigration(name) {
  const p = path.join(__dirname, "..", "prisma", "migrations", name, "migration.sql");
  return { sqlText: fs.readFileSync(p, "utf8"), bytes: fs.readFileSync(p) };
}
function splitStatements(sql) {
  return sql
    .replace(/^\s*--.*$/gm, "") // strip comment lines
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

(async () => {
  const name = process.argv[2];
  if (!name) {
    console.error("usage: node scripts/apply-migration.js <migration_dir_name>");
    process.exit(1);
  }
  const target = readMigration(name);
  const targetChecksum = sha256Hex(target.bytes);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    // 1) Verify checksum algorithm against the most recent applied migration.
    const applied = await pool.query(
      `SELECT migration_name, checksum FROM "_prisma_migrations" WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1`
    );
    if (applied.rows.length) {
      const ref = applied.rows[0];
      let refChecksum = null;
      try {
        refChecksum = sha256Hex(readMigration(ref.migration_name).bytes);
      } catch {
        console.log(`[verify] reference migration ${ref.migration_name} file not found locally — skipping algorithm check`);
      }
      if (refChecksum) {
        if (refChecksum === ref.checksum) {
          console.log(`[verify] checksum algorithm OK (matched ${ref.migration_name})`);
        } else {
          console.error(`[verify] CHECKSUM ALGORITHM MISMATCH for ${ref.migration_name}`);
          console.error(`  db:  ${ref.checksum}`);
          console.error(`  ours:${refChecksum}`);
          console.error("ABORTING — refusing to record a migration with a possibly-wrong checksum.");
          process.exit(2);
        }
      }
    }

    // 2) Already applied?
    const existing = await pool.query(`SELECT migration_name, checksum, finished_at FROM "_prisma_migrations" WHERE migration_name=$1`, [name]);
    if (existing.rows.length && existing.rows[0].finished_at) {
      const match = existing.rows[0].checksum === targetChecksum;
      console.log(`[apply] ${name} already applied ${match ? "(checksum matches)" : "(!! CHECKSUM MISMATCH)"}`);
      return;
    }

    // 3) Apply statements + record, atomically.
    const statements = splitStatements(target.sqlText);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const st of statements) {
        try {
          await client.query(st);
        } catch (e) {
          if (/already exists/i.test(e.message)) {
            console.log(`[apply] skip (already exists): ${st.slice(0, 70)}…`);
          } else {
            throw e;
          }
        }
      }
      await client.query(
        `INSERT INTO "_prisma_migrations" (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
         VALUES ($1,$2,now(),$3,NULL,NULL,now(),$4)`,
        [crypto.randomUUID(), targetChecksum, name, statements.length]
      );
      await client.query("COMMIT");
      console.log(`[apply] APPLIED + RECORDED ${name} (${statements.length} statement(s), checksum ${targetChecksum.slice(0, 12)}…)`);
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  } catch (e) {
    console.error("[apply] FAILED:", e.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
