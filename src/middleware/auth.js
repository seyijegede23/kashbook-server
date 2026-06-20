const { verifyToken } = require("../utils/jwt");
const prisma = require("../utils/db");

async function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "No token provided" });
  }

  const token = header.slice(7);
  try {
    const payload = verifyToken(token);

    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: {
        id: true, accountType: true, employerId: true, firstName: true,
        lastName: true, role: true, plan: true,
        accountStatus: true, complianceFreezeReason: true, tokenVersion: true,
      },
    });

    if (!user) return res.status(401).json({ error: "User no longer exists" });

    // Session revocation: a token minted before a password change / logout-all
    // carries an older tokenVersion and is rejected here. (Legacy tokens with no
    // tokenVersion claim default to 0, matching a fresh account — no mass logout.)
    if ((payload.tokenVersion ?? 0) !== (user.tokenVersion ?? 0)) {
      return res.status(401).json({ error: "Session expired, please log in again" });
    }

    // For staff, feature limits are governed by the employer's plan
    let effectivePlan = user.plan ?? "FREE";
    if (user.accountType === "STAFF" && user.employerId) {
      const employer = await prisma.user.findUnique({
        where: { id: user.employerId },
        select: { plan: true },
      });
      effectivePlan = employer?.plan ?? "FREE";
    }

    // `plan` is this user's own plan; `effectivePlan` is what gates features
    // (staff inherit their employer's plan, resolved above).
    req.user = {
      id:            user.id,
      accountType:   user.accountType.toLowerCase(),
      employerId:    user.employerId ?? null,
      name:          `${user.firstName} ${user.lastName}`.trim(),
      role:          user.role,
      plan:          user.plan ?? "FREE",
      effectivePlan,
      accountStatus: user.accountStatus || "active",
      complianceFreezeReason: user.complianceFreezeReason || null,
    };
    // Surface frozen state so requireUnfrozen() can reject without another DB round-trip.
    req.frozen = req.user.accountStatus !== "active";
    void effectivePlan;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

module.exports = authMiddleware;
