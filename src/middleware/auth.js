const { verifyToken } = require("../utils/jwt");
const prisma = require("../utils/db");

// Frozen so nothing downstream can mutate a shared object and grant itself a
// capability. An owner holds every capability over their own data; a staff
// member holds none until their employer says otherwise.
const OWNER_PERMISSIONS = Object.freeze({
  canViewBalance: true,
  canTransfer: true,
  canViewReports: true,
  canManagePayables: true,
});

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
        lastName: true, role: true, plan: true, country: true,
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

    // For staff, feature limits are governed by the employer's plan, and their
    // capabilities come from a grant row the owner controls. Both are resolved
    // in the SAME branch, so owners pay no extra query at all.
    //
    // Permissions are read fresh from the database on every request and NEVER
    // put in the JWT: a revoke must take effect on the staff member's next
    // request, not whenever their token happens to expire.
    let effectivePlan = user.plan ?? "FREE";
    let permissions = OWNER_PERMISSIONS;
    let dailyTransferCap = null;

    if (user.accountType === "STAFF") {
      const [employer, grant] = await Promise.all([
        user.employerId
          ? prisma.user.findUnique({ where: { id: user.employerId }, select: { plan: true } })
          : null,
        prisma.staffPermission.findUnique({
          where: { userId: user.id },
          select: {
            employerId: true, dailyTransferCap: true,
            canViewBalance: true, canTransfer: true,
            canViewReports: true, canManagePayables: true,
          },
        }),
      ]);
      effectivePlan = employer?.plan ?? "FREE";

      // Fail closed, three ways over:
      //   1. no grant row at all                → nothing
      //   2. a key missing from the row         → `=== true` refuses it
      //   3. the grant names a DIFFERENT employer than the User row does
      //      (staff reassigned, or a stale row) → the whole grant is ignored
      const usable =
        grant && user.employerId && grant.employerId === user.employerId ? grant : null;

      permissions = Object.freeze({
        canViewBalance:    usable?.canViewBalance    === true,
        canTransfer:       usable?.canTransfer       === true,
        canViewReports:    usable?.canViewReports    === true,
        canManagePayables: usable?.canManagePayables === true,
      });
      dailyTransferCap = Number(usable?.dailyTransferCap ?? 0) || 0;
    }

    // `plan` is this user's own plan; `effectivePlan` is what gates features
    // (staff inherit their employer's plan, resolved above).
    req.user = {
      id:            user.id,
      accountType:   user.accountType.toLowerCase(),
      employerId:    user.employerId ?? null,
      name:          `${user.firstName} ${user.lastName}`.trim(),
      role:          user.role,
      // transfers.js reads req.user.country in three places to pick the payment
      // provider and the bank list, but nothing ever set it — so every caller
      // silently fell back to "NG". A Ghanaian merchant was being shown Nigerian
      // banks and routed to the Nigerian provider.
      country:       user.country || "NG",
      plan:          user.plan ?? "FREE",
      effectivePlan,
      // Always present, always all four keys, always a real boolean — so no
      // route ever has to defend against `undefined` on a money gate.
      permissions,
      // Owners: null (the concept doesn't apply). Staff: a number >= 0, where
      // 0 means every transfer needs approval.
      dailyTransferCap,
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
