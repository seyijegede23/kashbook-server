// TLS config for Postgres connections. No network, no DB.
//   node scripts/pg-ssl-test.js
//
// Guards the bug that silently broke the nightly backup: pg lets a `sslmode` in
// the connection string OVERRIDE and discard an explicit `ssl` option, so
// setting rejectUnauthorized:false while leaving sslmode=verify-full in the URL
// verifies the certificate anyway and dies on Render's self-signed cert.
//
// These assert on what pg ACTUALLY RESOLVES, not on what we passed in — that
// distinction is the whole bug.
const assert = require("assert");
const { Client } = require("pg");
const { pgConnectionConfig, stripSslMode, isLocalHost } = require("../src/utils/pgSsl");

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); failed++; }
}
function section(t) { console.log(`\n── ${t} ${"─".repeat(Math.max(0, 56 - t.length))}`); }

// What pg will really use once it has parsed the connection string.
const resolved = (url) => new Client(pgConnectionConfig(url)).connectionParameters.ssl;

const RENDER = "postgresql://placeholder:placeholder@dpg-abc123-a.oregon-postgres.render.com/kashbook";
const INTERNAL = "postgresql://placeholder:placeholder@dpg-abc123-a/kashbook";

// ══ 1. THE REGRESSION ══════════════════════════════════════════════════════
section("1. the bug that broke the nightly backup");

test("verify-full in the URL does NOT survive into the resolved config", () => {
  const ssl = resolved(`${RENDER}?sslmode=verify-full`);
  assert.strictEqual(typeof ssl, "object", "ssl should be an object, got " + typeof ssl);
  assert.strictEqual(ssl.rejectUnauthorized, false,
    "sslmode=verify-full leaked through and re-enabled CA verification");
});

test("the naive form — ssl option WITHOUT stripping — really is broken", () => {
  // Proves the bug is real rather than theoretical, and that pg still behaves
  // this way. If a future pg makes the explicit option win, this test fails and
  // tells us the workaround is no longer needed.
  const naive = new Client({
    connectionString: `${RENDER}?sslmode=verify-full`,
    ssl: { rejectUnauthorized: false },
  }).connectionParameters.ssl;
  assert.notStrictEqual(naive?.rejectUnauthorized, false,
    "pg now honours the explicit ssl option — pgSsl's strip may be removable");
});

test("require is stripped too (pg aliases it to verify-full)", () => {
  assert.strictEqual(resolved(`${RENDER}?sslmode=require`).rejectUnauthorized, false);
});

test("verify-ca is stripped too", () => {
  assert.strictEqual(resolved(`${RENDER}?sslmode=verify-ca`).rejectUnauthorized, false);
});

test("no sslmode at all still disables CA verification", () => {
  assert.strictEqual(resolved(RENDER).rejectUnauthorized, false);
});

test("Render's INTERNAL hostname (the one the cron uses) is covered", () => {
  assert.strictEqual(resolved(`${INTERNAL}?sslmode=verify-full`).rejectUnauthorized, false);
});

// ══ 2. SSL STAYS ON ════════════════════════════════════════════════════════
section("2. TLS is skipped for verification only, never turned off");

test("a hosted database still gets an ssl config", () => {
  assert.ok(pgConnectionConfig(RENDER).ssl, "hosted DB must still use TLS");
});

test("stripping sslmode leaves the rest of the URL intact", () => {
  const out = stripSslMode(`${RENDER}?sslmode=verify-full&application_name=kb`);
  assert.ok(out.includes("application_name=kb"), "other params were dropped: " + out);
  assert.ok(!out.includes("sslmode"), "sslmode survived: " + out);
  assert.ok(out.includes("oregon-postgres.render.com"), "host was mangled: " + out);
});

test("credentials survive the rewrite", () => {
  const out = stripSslMode(`${RENDER}?sslmode=verify-full`);
  assert.ok(out.includes("placeholder:placeholder@"), "user/password lost: " + out);
});

// ══ 3. LOCAL ═══════════════════════════════════════════════════════════════
section("3. localhost gets no SSL (it is not built with it)");

for (const host of ["localhost", "127.0.0.1"]) {
  test(`${host} → ssl undefined`, () => {
    const cfg = pgConnectionConfig(`postgresql://placeholder:placeholder@${host}:5432/scratch`);
    assert.strictEqual(cfg.ssl, undefined);
  });
  test(`${host} is detected as local`, () => {
    assert.strictEqual(isLocalHost(`postgresql://placeholder:placeholder@${host}:5432/scratch`), true);
  });
}

test("a hosted host is NOT treated as local", () => {
  assert.strictEqual(isLocalHost(RENDER), false);
});

// ══ 4. JUNK ════════════════════════════════════════════════════════════════
section("4. malformed input fails safe");

test("an unparseable DSN keeps SSL on rather than silently dropping it", () => {
  const cfg = pgConnectionConfig("host=foo user=bar");
  assert.ok(cfg.ssl, "a DSN we cannot parse must not lose TLS");
});

test("empty/undefined URL does not throw", () => {
  assert.doesNotThrow(() => pgConnectionConfig(undefined));
  assert.doesNotThrow(() => pgConnectionConfig(""));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
