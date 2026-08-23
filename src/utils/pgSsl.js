// One place that decides how we speak TLS to Postgres.
//
// WHY THIS EXISTS
// Render's Postgres serves a SELF-SIGNED certificate over its private network.
// Our connection strings carry `sslmode=verify-full`, and node-postgres lets the
// connection string WIN: given both a `sslmode` in the URL and an explicit
// `ssl` option, pg 8.19 resolves the ssl config from the URL and DISCARDS the
// option outright. So this:
//
//   new Client({ connectionString: ".../db?sslmode=verify-full",
//                ssl: { rejectUnauthorized: false } })
//
// does NOT skip verification — it verifies, and dies on the self-signed cert.
// The fix is to remove `sslmode` from the URL and pass the ssl config as an
// option, which is what this module does.
//
// This lived only inside db.js, and the nightly backup grew its own copy that
// set the ssl option WITHOUT stripping sslmode. The backup therefore failed
// every night with "self-signed certificate" while the API connected fine.
// Both now call this, so the two cannot drift apart again.
//
// Note: pg 8.19 also aliases `require` and `verify-ca` to `verify-full`, so any
// sslmode at all is stripped, not just verify-full.
//
// The traffic is still encrypted; only CA verification is skipped, which is
// what a self-signed cert on a private network requires.

function isLocalHost(url) {
  try {
    const h = new URL(url).hostname;
    return h === "localhost" || h === "127.0.0.1" || h === "::1";
  } catch {
    return false; // non-URL DSN — assume remote and keep SSL on
  }
}

// Strip every sslmode parameter so the explicit `ssl` option below is the thing
// pg actually honours.
function stripSslMode(url) {
  try {
    const u = new URL(url);
    u.searchParams.delete("sslmode");
    return u.toString();
  } catch {
    return url;
  }
}

// Returns the pair to spread into a pg Client/Pool config.
// A local Postgres is usually built without SSL support, and forcing it there
// fails outright ("The server does not support SSL connections"), so localhost
// gets no ssl at all. Every hosted database keeps SSL, minus CA verification.
function pgConnectionConfig(url) {
  if (!url) return { connectionString: url, ssl: undefined };
  if (isLocalHost(url)) return { connectionString: stripSslMode(url), ssl: undefined };
  return { connectionString: stripSslMode(url), ssl: { rejectUnauthorized: false } };
}

module.exports = { pgConnectionConfig, stripSslMode, isLocalHost };
