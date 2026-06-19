// Sentry server-side initialization.
//
// MUST be required before express / any route module (see server.js line ~2) so
// Sentry can auto-instrument HTTP + Express. Gated on SENTRY_DSN: with no DSN the
// SDK is disabled and every Sentry call becomes a no-op — nothing breaks in dev
// or before the DSN is set on Render. Paste your DSN into SENTRY_DSN to activate.
//
// Required env (set on Render):
//   SENTRY_DSN                  project DSN from sentry.io (Settings → Projects → Client Keys)
// Optional:
//   SENTRY_ENV                  environment tag (default NODE_ENV || "development")
//   SENTRY_TRACES_SAMPLE_RATE   0..1 share of requests traced for performance (default 0.1)
//   SENTRY_RELEASE              release/version tag (default RENDER_GIT_COMMIT if present)
const Sentry = require("@sentry/node");

const dsn = process.env.SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENV || process.env.NODE_ENV || "development",
    release: process.env.SENTRY_RELEASE || process.env.RENDER_GIT_COMMIT || undefined,
    // Performance tracing — sample a slice of requests. Set to 0 to disable.
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0.1),
    // We are a fintech app — never let Sentry collect bodies/PII by default.
    sendDefaultPii: false,
    // Belt-and-braces scrub: drop request body, cookies, and auth headers from
    // every event before it leaves the process (covers PINs, tokens, BVN, etc.).
    beforeSend(event) {
      if (event.request) {
        delete event.request.data;
        delete event.request.cookies;
        if (event.request.headers) {
          delete event.request.headers.authorization;
          delete event.request.headers.Authorization;
          delete event.request.headers.cookie;
        }
      }
      return event;
    },
  });
  console.log(`[Sentry] initialized (env=${process.env.SENTRY_ENV || process.env.NODE_ENV || "development"})`);
} else {
  console.log("[Sentry] disabled (no SENTRY_DSN set)");
}

module.exports = Sentry;
