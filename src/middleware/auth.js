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
        accountStatus: true, complianceFreezeReason: true,
      },
    });

    if (!user) return res.status(401).json({ error: "User no longer exists" });

    // For staff, feature limits are governed by the employer's plan
    let effectivePlan = user.plan ?? "FREE";
    if (user.accountType === "STAFF" && user.employerId) {
      const employer = await prisma.user.findUnique({
        where: { id: user.employerId },
        select: { plan: true },
      });
      effectivePlan = employer?.plan ?? "FREE";
    }

    // PAYWALL DISABLED — every user is treated as PREMIUM regardless of their
    // actual plan. Revert this block (use `user.plan ?? "FREE"` and the real
    // `effectivePlan` above) to re-enable the paywall.
    req.user = {
      id:            user.id,
      accountType:   user.accountType.toLowerCase(),
      employerId:    user.employerId ?? null,
      name:          `${user.firstName} ${user.lastName}`.trim(),
      role:          user.role,
      plan:          "PREMIUM",
      effectivePlan: "PREMIUM",
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
