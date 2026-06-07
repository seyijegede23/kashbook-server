// Audit log helper. Used from every state-changing or security-relevant
// route to write an append-only record. Failures here MUST NOT break the
// caller — we swallow and console.error so a busted log table never takes
// down the app.
const prisma = require("./db");

async function audit({
  req,
  action,
  resourceType,
  resourceId,
  metadata,
  severity = "info",
  actorOverride,
}) {
  try {
    const actorType =
      actorOverride?.type ||
      (req?.user?.role === "ADMIN" ? "admin" : req?.user ? "user" : "system");
    const actorId = actorOverride?.id || req?.user?.id || null;
    const ip =
      req?.ip ||
      (req?.headers?.["x-forwarded-for"] || "").toString().split(",")[0].trim() ||
      null;
    const userAgent = req?.headers?.["user-agent"] || null;

    await prisma.auditLog.create({
      data: {
        actorType,
        actorId,
        action,
        resourceType: resourceType || null,
        resourceId: resourceId || null,
        ip,
        userAgent,
        metadata: metadata == null ? null : metadata,
        severity,
      },
    });
  } catch (err) {
    console.error("[audit] write failed:", action, err.message || err);
  }
}

module.exports = { audit };
