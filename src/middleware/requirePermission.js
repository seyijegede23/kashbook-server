// Staff capability gate. Mount AFTER authMiddleware, which is what puts
// `req.user.permissions` in place.
//
// This answers exactly ONE question: may this actor use this capability at all?
// It says nothing about WHICH business — ownership scoping stays with
// ownerIdOf(req) in the route. Both are required, and neither substitutes for
// the other: a permission check without scoping would let a permitted staff
// member act on someone else's business.

const { audit } = require("../utils/audit");

const PERMISSIONS = Object.freeze([
  "canViewBalance",
  "canTransfer",
  "canViewReports",
  "canManagePayables",
]);

// Written for the person who hits the wall, so they know who can lift it.
const MESSAGES = {
  canViewBalance:
    "You don't have access to the bank account or balance. Ask the business owner to turn it on for you.",
  canTransfer:
    "You don't have permission to send money. Ask the business owner to turn it on for you.",
  canViewReports:
    "You don't have access to reports and insights. Ask the business owner to turn it on for you.",
  canManagePayables:
    "You don't have access to bills and payables. Ask the business owner to turn it on for you.",
};

/**
 * @param {string} permission one of PERMISSIONS
 * @param {{ auditDenials?: boolean }} [opts] audit refusals — money routes only,
 *        so a staff member probing the send endpoint leaves a trail, without
 *        filling the log with routine reads.
 */
function requirePermission(permission, opts = {}) {
  // A misspelled permission must CRASH AT BOOT rather than silently deny (which
  // is merely confusing) or silently allow (which is a breach). This one line is
  // why this is a factory returning middleware and not a plain middleware.
  if (!PERMISSIONS.includes(permission)) {
    throw new Error(
      `requirePermission: unknown permission "${permission}". Valid: ${PERMISSIONS.join(", ")}`,
    );
  }

  return function permissionGate(req, res, next) {
    if (!req.user) return res.status(401).json({ error: "No token provided" });

    // Owners hold every capability over their own data implicitly.
    if (req.user.accountType !== "staff") return next();

    // STRICT identity comparison. `!== false` or a truthiness test would let a
    // missing key, the string "false", or an undefined permissions object
    // through — and this is the money gate.
    if (req.user.permissions?.[permission] === true) return next();

    if (opts.auditDenials) {
      audit({
        req,
        action: "STAFF_PERMISSION_DENIED",
        resourceType: "user",
        resourceId: req.user.id,
        severity: "warn",
        metadata: { permission, method: req.method, path: req.originalUrl },
      }).catch(() => {});
    }

    return res.status(403).json({
      error: MESSAGES[permission],
      code: "PERMISSION_DENIED",
      permission,
    });
  };
}

/**
 * For surfaces no permission can ever unlock: anything that submits the owner's
 * identity documents, changes their credentials, or grants privileges. Kept
 * separate from requirePermission so those routes can never be "upgraded" to a
 * grantable capability by mistake.
 */
function ownerOnly(message = "Only the business owner can do this.") {
  return function ownerGate(req, res, next) {
    if (req.user?.accountType === "staff") {
      return res.status(403).json({ error: message, code: "OWNER_ONLY" });
    }
    next();
  };
}

module.exports = { requirePermission, ownerOnly, PERMISSIONS };
