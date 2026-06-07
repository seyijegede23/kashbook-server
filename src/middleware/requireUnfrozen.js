// Rejects write requests when the user's accountStatus is anything other
// than "active". Read paths (GET) are allowed through so the user can
// still see their data. Mount AFTER authMiddleware on routes that take
// money / customer data / KYB action.

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function requireUnfrozen(req, res, next) {
  if (READ_METHODS.has(req.method)) return next();
  if (!req.frozen) return next();

  return res.status(423).json({
    error: "Your account is under review. Contact support to resolve.",
    code: "FROZEN",
    reason: req.user?.complianceFreezeReason || null,
    supportEmail: process.env.COMPLIANCE_SUPPORT_EMAIL || "compliance@kashbook.com",
  });
}

module.exports = requireUnfrozen;
