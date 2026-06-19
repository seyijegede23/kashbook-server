// In-house error tracking (a lightweight "Sentry"): capture exceptions with a
// stack + redacted request context, fingerprint them so the same bug groups
// into one row, and count occurrences. Read back via /admin-api/errors.
//
// Design rules:
//   • captureError MUST NEVER throw or block the response — fire-and-forget,
//     swallow its own failures (same discipline as utils/audit.js).
//   • NEVER persist secrets/PII — request body/query/params are redacted.
const crypto = require("crypto");
const prisma = require("./db");

// Keys whose values must never be stored.
const SECRET_KEY = /pass|pin|token|secret|key|bvn|cac|auth|otp|cvv|card|ssn|nin/i;

// Strip volatile bits so the same logical error groups together.
function normalizeMessage(msg) {
  return String(msg || "")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "<email>")
    .replace(/\b\d[\d,.]*\b/g, "<n>")
    .trim()
    .slice(0, 300);
}

// First stack frame that lives in our own code (skip node internals / deps).
function topAppFrame(stack) {
  if (!stack) return "";
  const lines = String(stack).split("\n").slice(1);
  const appLine =
    lines.find((l) => /[\\/](src|server\.js)/.test(l) && !/node_modules/.test(l)) ||
    lines.find((l) => !/node_modules|node:internal/.test(l)) ||
    lines[0] ||
    "";
  const m = appLine.match(/\(([^)]+)\)/) || appLine.match(/at\s+(.+)$/);
  let frame = (m ? m[1] : appLine).trim();
  const rel = frame.match(/(src[\\/].+)/);
  if (rel) frame = rel[1];
  return frame.slice(0, 200);
}

function fingerprint(name, normMsg, frame) {
  return crypto.createHash("sha1").update(`${name}|${normMsg}|${frame}`).digest("hex");
}

function redact(value, depth = 0) {
  if (value == null || depth > 4) return undefined;
  if (typeof value === "string") return value.slice(0, 500);
  if (typeof value !== "object") return value;
  const out = Array.isArray(value) ? [] : {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_KEY.test(k) ? "<redacted>" : redact(v, depth + 1);
  }
  return out;
}

function requestContext(req) {
  if (!req) return {};
  return {
    query: redact(req.query),
    body: redact(req.body),
    params: redact(req.params),
  };
}

// Capture an error. Always resolves; never rejects.
async function captureError(err, { req, level = "error", context = {} } = {}) {
  try {
    const e = err instanceof Error ? err : new Error(typeof err === "string" ? err : "Non-error thrown");
    const name = e.name || "Error";
    const rawMsg = (e.message || String(e)).slice(0, 500);
    const frame = topAppFrame(e.stack);
    const fp = fingerprint(name, normalizeMessage(rawMsg), frame);
    const route = req
      ? `${req.method || ""} ${req.baseUrl || ""}${req.route?.path || req.path || ""}`.trim()
      : null;

    const group = await prisma.errorGroup.upsert({
      where: { fingerprint: fp },
      create: { fingerprint: fp, name, message: rawMsg, where: frame || route || null, level, count: 1 },
      update: { count: { increment: 1 }, lastSeen: new Date(), message: rawMsg },
    });
    // A new occurrence reopens a resolved group; "ignored" stays ignored.
    if (group.status === "resolved") {
      await prisma.errorGroup.update({ where: { id: group.id }, data: { status: "open" } });
    }

    await prisma.errorEvent.create({
      data: {
        groupId: group.id,
        message: rawMsg,
        stack: e.stack ? String(e.stack).slice(0, 8000) : null,
        route,
        method: req?.method || null,
        statusCode: context.statusCode ?? null,
        userId: req?.user?.id || null,
        ip: (req?.ip || req?.headers?.["x-forwarded-for"] || "").toString().slice(0, 60) || null,
        userAgent: (req?.headers?.["user-agent"] || "").toString().slice(0, 300) || null,
        context: { ...requestContext(req), ...redact(context) },
      },
    });
  } catch (capErr) {
    // The tracker must never take down a request.
    console.error("[errorTracker] capture failed:", capErr.message);
  }
}

module.exports = { captureError, _internal: { normalizeMessage, topAppFrame, fingerprint, redact } };
