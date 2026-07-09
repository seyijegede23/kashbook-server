const router = require("express").Router();
const auth = require("../middleware/auth");
const adminAuth = require("../middleware/adminAuth");
const prisma = require("../utils/db");
const { audit } = require("../utils/audit");
const { pushTo } = require("../utils/pushNotification");
const { collectHealth } = require("../utils/healthCheck");
const { getMetrics } = require("../utils/metrics");
const { decrypt } = require("../utils/crypto");
const {
  validateVirtualAccountInput,
  executeVirtualAccountProvisioning,
} = require("../services/virtualAccountProvisioning");

// CSRF defense-in-depth. Admin auth is Bearer-token (already CSRF-resistant since
// a cross-site page can't set the Authorization header), but we additionally
// reject cross-origin state-changing requests. Requests with no Origin header
// (non-browser tools) still pass — they remain gated by the Bearer token.
function adminCsrfGuard(req, res, next) {
  if (["POST", "PATCH", "PUT", "DELETE"].includes(req.method)) {
    const origin = req.headers.origin;
    if (origin) {
      const allowed = (process.env.ALLOWED_ORIGIN || "")
        .split(",").map((s) => s.trim()).filter(Boolean);
      let sameHost = false;
      try { sameHost = new URL(origin).host === req.headers.host; } catch {}
      if (!sameHost && !allowed.includes(origin)) {
        return res.status(403).json({ error: "Cross-origin request blocked" });
      }
    }
  }
  next();
}

router.use(auth, adminAuth, adminCsrfGuard);

// GET /admin-api/stats
router.get("/stats", async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [totalUsers, premiumUsers, newToday, totalInvoices, revenueAgg] =
      await Promise.all([
        prisma.user.count(),
        prisma.user.count({ where: { plan: "PREMIUM" } }),
        prisma.user.count({ where: { createdAt: { gte: today } } }),
        prisma.invoice.count(),
        prisma.transaction.aggregate({
          where: { type: "income" },
          _sum: { amount: true },
        }),
      ]);

    res.json({
      totalUsers,
      premiumUsers,
      newToday,
      totalInvoices,
      totalRevenue: revenueAgg._sum.amount || 0,
    });
  } catch (err) {
    console.error("GET /admin/stats error:", err.message);
    res.status(500).json({ error: "Failed to fetch stats" });
  }
});

// GET /admin-api/users
router.get("/users", async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        plan: true,
        role: true,
        accountStatus: true,
        createdAt: true,
        expoPushToken: true,
        _count: { select: { businesses: true } },
      },
    });

    res.json(
      users.map((u) => ({
        id: u.id,
        name: `${u.firstName} ${u.lastName}`.trim(),
        email: u.email,
        plan: u.plan,
        role: u.role,
        accountStatus: u.accountStatus,
        createdAt: u.createdAt,
        businessCount: u._count.businesses,
        hasToken: !!u.expoPushToken,
      }))
    );
  } catch (err) {
    console.error("GET /admin/users error:", err.message);
    res.status(500).json({ error: "Failed to fetch users" });
  }
});

// GET /admin-api/activity
router.get("/activity", async (req, res) => {
  try {
    const transactions = await prisma.transaction.findMany({
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true,
        type: true,
        amount: true,
        currency: true,
        description: true,
        date: true,
        business: { select: { name: true } },
        user: { select: { firstName: true, lastName: true } },
      },
    });

    res.json(
      transactions.map((t) => ({
        id: t.id,
        type: t.type,
        amount: t.amount,
        currency: t.currency,
        description: t.description,
        date: t.date,
        businessName: t.business?.name || "—",
        userName: t.user
          ? `${t.user.firstName} ${t.user.lastName}`.trim()
          : "—",
      }))
    );
  } catch (err) {
    console.error("GET /admin/activity error:", err.message);
    res.status(500).json({ error: "Failed to fetch activity" });
  }
});

// PATCH /admin-api/users/:id/upgrade
router.patch("/users/:id/upgrade", async (req, res) => {
  try {
    await prisma.user.update({
      where: { id: req.params.id },
      data: { plan: "PREMIUM" },
    });
    await audit({
      req,
      action: "ADMIN_PLAN_UPGRADE",
      resourceType: "user",
      resourceId: req.params.id,
      severity: "info",
    });
    res.json({ ok: true });
  } catch (err) {
    console.error("PATCH /admin/users/upgrade error:", err.message);
    res.status(500).json({ error: "Failed to upgrade user" });
  }
});

// PATCH /admin-api/users/:id/downgrade
router.patch("/users/:id/downgrade", async (req, res) => {
  try {
    await prisma.user.update({
      where: { id: req.params.id },
      data: { plan: "FREE" },
    });
    await audit({
      req,
      action: "ADMIN_PLAN_DOWNGRADE",
      resourceType: "user",
      resourceId: req.params.id,
      severity: "info",
    });
    res.json({ ok: true });
  } catch (err) {
    console.error("PATCH /admin/users/downgrade error:", err.message);
    res.status(500).json({ error: "Failed to downgrade user" });
  }
});

// GET /admin-api/revenue  (last 30 days, grouped by day)
// POST /admin-api/users/:id/clear-kyc-attempts
// Wipe the KycCheckAttempt rows that are blocking a user from re-submitting
// their KYB. Used when a legitimate user got stuck on the rate-limit (e.g.
// they typo'd their BVN three times). Append-only audit trail is preserved
// because we also write a KYC_ATTEMPTS_CLEARED row with the count + admin
// actor before deleting.
router.post("/users/:id/clear-kyc-attempts", async (req, res) => {
  try {
    const userId = req.params.id;
    const u = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true },
    });
    if (!u) return res.status(404).json({ error: "User not found" });

    // Only clear rate-limit-relevant rows (non-ok results). The "ok" rows
    // stay so we keep the historical record of successful checks.
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const { count } = await prisma.kycCheckAttempt.deleteMany({
      where: {
        userId,
        createdAt: { gt: since },
        result: { notIn: ["ok"] },
      },
    });

    await audit({
      req,
      action: "KYC_ATTEMPTS_CLEARED",
      resourceType: "user",
      resourceId: userId,
      severity: "warn",
      metadata: { cleared: count, userEmail: u.email },
    });

    res.json({ cleared: count });
  } catch (err) {
    console.error("[clear-kyc-attempts]", err);
    res.status(500).json({ error: "Failed to clear KYC attempts" });
  }
});

router.get("/revenue", async (req, res) => {
  try {
    const since = new Date();
    since.setDate(since.getDate() - 29);
    since.setHours(0, 0, 0, 0);

    const transactions = await prisma.transaction.findMany({
      where: { type: "income", date: { gte: since } },
      select: { amount: true, date: true },
      orderBy: { date: "asc" },
    });

    // Group by YYYY-MM-DD
    const map = {};
    for (let i = 0; i < 30; i++) {
      const d = new Date(since);
      d.setDate(d.getDate() + i);
      const key = d.toISOString().slice(0, 10);
      map[key] = 0;
    }
    transactions.forEach((t) => {
      const key = new Date(t.date).toISOString().slice(0, 10);
      if (key in map) map[key] += t.amount;
    });

    res.json(
      Object.entries(map).map(([date, total]) => ({ date, total }))
    );
  } catch (err) {
    console.error("GET /admin/revenue error:", err.message);
    res.status(500).json({ error: "Failed to fetch revenue" });
  }
});

// POST /admin-api/run-monthly-report — manually trigger last month's P&L email
// (testing / re-send after an outage). Same code path as the 1st-of-month cron.
// Optional body { monthOffset } — 1 = last month (default), 2 = the month before.
router.post("/run-monthly-report", async (req, res) => {
  try {
    const monthOffset = Math.min(24, Math.max(1, parseInt(req.body?.monthOffset, 10) || 1));
    const result = await require("../utils/monthlyReport").sendMonthlyReports({ monthOffset });
    await audit({
      req,
      action: "ADMIN_MONTHLY_REPORT_TRIGGERED",
      resourceType: "system",
      resourceId: "monthly-report",
      severity: "info",
      metadata: result,
    });
    res.json(result);
  } catch (err) {
    console.error("[admin/run-monthly-report]", err);
    res.status(500).json({ error: "Failed to run monthly report" });
  }
});

// POST /admin-api/run-daily-report — manually trigger the 8pm daily business
// report (testing / re-send after an outage). Same code path as the cron.
router.post("/run-daily-report", async (req, res) => {
  try {
    const result = await require("../utils/dailyReport").sendDailyReports();
    await audit({
      req,
      action: "ADMIN_DAILY_REPORT_TRIGGERED",
      resourceType: "system",
      resourceId: "daily-report",
      severity: "info",
      metadata: result,
    });
    res.json(result);
  } catch (err) {
    console.error("[admin/run-daily-report]", err);
    res.status(500).json({ error: "Failed to run daily report" });
  }
});

// POST /admin-api/notify — in-app notification + device push for all users
// (or one user). pushTo() writes the AppNotification row AND sends the Expo
// push when the user has a registered token and notifications enabled —
// users without a token still get the in-app entry.
router.post("/notify", async (req, res) => {
  const { userId, title, body } = req.body;
  if (!title || !body) {
    return res.status(400).json({ error: "title and body required" });
  }

  try {
    if (userId) {
      await pushTo(userId, title, body);
      return res.json({ saved: 1 });
    }

    // Broadcast — chunked so a large user base doesn't fire thousands of
    // concurrent Expo calls at once.
    const users = await prisma.user.findMany({ select: { id: true } });
    const CHUNK = 20;
    for (let i = 0; i < users.length; i += CHUNK) {
      await Promise.allSettled(
        users.slice(i, i + CHUNK).map((u) => pushTo(u.id, title, body)),
      );
    }
    res.json({ saved: users.length });
  } catch (err) {
    console.error("POST /admin/notify error:", err.message);
    res.status(500).json({ error: "Failed to send notification" });
  }
});

// ── KYC review queue (admin approval gate before Anchor) ──────────────────
// Account-opening requests are parked as KycSubmission(PENDING) by
// businesses.js. Nothing reached Anchor yet. The admin approves (→ replay the
// stored payload to Anchor) or declines (with a reason the user sees).

// GET /admin-api/kyc-submissions?status=PENDING
router.get("/kyc-submissions", async (req, res) => {
  try {
    const status = String(req.query.status || "PENDING").toUpperCase();
    const valid = ["PENDING", "APPROVED", "DECLINED", "FAILED"];
    const where = valid.includes(status) ? { status } : {};
    const [submissions, pendingCount] = await Promise.all([
      prisma.kycSubmission.findMany({
        where,
        orderBy: { createdAt: "asc" }, // FIFO — oldest waiting reviewed first
        take: 200,
        select: {
          id: true, status: true, businessType: true, businessKyb: true,
          summary: true, declineReason: true, processError: true,
          createdAt: true, reviewedAt: true, processedAt: true,
          business: { select: { id: true, name: true, country: true } },
          user: { select: { id: true, firstName: true, lastName: true, email: true, phone: true } },
        },
      }),
      prisma.kycSubmission.count({ where: { status: "PENDING" } }),
    ]);
    res.json({ submissions, pendingCount });
  } catch (err) {
    console.error("GET /admin/kyc-submissions error:", err.message);
    res.status(500).json({ error: "Failed to fetch submissions" });
  }
});

// POST /admin-api/kyc-submissions/:id/approve
// Replays the stored payload → Anchor (create customer + trigger KYC/KYB).
router.post("/kyc-submissions/:id/approve", async (req, res) => {
  try {
    const submission = await prisma.kycSubmission.findUnique({ where: { id: req.params.id } });
    if (!submission) return res.status(404).json({ error: "Submission not found" });
    if (!["PENDING", "FAILED"].includes(submission.status)) {
      return res.status(409).json({ error: `This request was already ${submission.status.toLowerCase()}.` });
    }

    const [biz, user] = await Promise.all([
      prisma.business.findUnique({ where: { id: submission.businessId } }),
      prisma.user.findUnique({ where: { id: submission.userId } }),
    ]);
    if (!biz || !user) return res.status(404).json({ error: "Business or user no longer exists" });

    // Idempotency: if a NUBAN already exists (e.g. double-approve), just close it out.
    if (biz.virtualAccountNumber) {
      await prisma.kycSubmission.update({
        where: { id: submission.id },
        data: { status: "APPROVED", reviewedById: req.user.id, reviewedAt: new Date(), processedAt: new Date(), payload: null },
      });
      return res.json({ status: "already_provisioned" });
    }
    if (!submission.payload) {
      return res.status(400).json({ error: "The stored request is missing — ask the user to resubmit." });
    }

    // Atomically CLAIM the row before doing any Anchor work, so a concurrent
    // double-approve (or an approve racing a resubmit) can't run provisioning
    // twice. Only one caller flips PENDING/FAILED → APPROVED; the loser sees
    // count 0 and backs off. We revert to FAILED/DECLINED below on any error.
    const claim = await prisma.kycSubmission.updateMany({
      where: { id: submission.id, status: { in: ["PENDING", "FAILED"] } },
      data: { status: "APPROVED", reviewedById: req.user.id, reviewedAt: new Date() },
    });
    if (claim.count !== 1) {
      return res.status(409).json({ error: "This request is already being processed." });
    }

    let body;
    try {
      body = JSON.parse(decrypt(submission.payload));
    } catch {
      await prisma.kycSubmission.update({
        where: { id: submission.id },
        data: { status: "FAILED", processError: "Could not read the stored request." },
      });
      return res.status(500).json({ error: "Could not read the stored request." });
    }

    // Re-validate — a racing business may have claimed this BVN/CAC since submit.
    // A hard validation failure here is the USER's to fix, not a retryable Anchor
    // error, so auto-DECLINE with the reason (they see it + can resubmit) rather
    // than leaving them stuck on "under review".
    const v = await validateVirtualAccountInput({ body, user, biz });
    if (!v.ok) {
      await prisma.kycSubmission.update({
        where: { id: submission.id },
        data: { status: "DECLINED", declineReason: v.error, payload: null },
      });
      pushTo(
        user.id,
        "Account request needs attention",
        `${v.error} — please update your details and resubmit.`,
      ).catch(() => {});
      return res.status(v.httpStatus).json({ error: v.error, code: v.code });
    }

    let result;
    try {
      result = await executeVirtualAccountProvisioning({ biz, user, body, req });
    } catch (e) {
      console.error("[admin approve] provisioning failed:", e.message);
      const msg = e.code === "ANCHOR_NOT_CONFIGURED"
        ? "Anchor is not configured on this server."
        : (e.message || "Provisioning failed");
      // Transient/Anchor failure — keep the payload so the admin can retry.
      await prisma.kycSubmission.update({
        where: { id: submission.id },
        data: { status: "FAILED", processError: String(msg).slice(0, 500) },
      });
      return res.status(400).json({ error: msg });
    }

    // Status is already APPROVED from the claim; just finalise + drop the payload.
    await prisma.kycSubmission.update({
      where: { id: submission.id },
      data: { processedAt: new Date(), processError: null, payload: null },
    });

    pushTo(
      user.id,
      "Account approved 🎉",
      "Your account request was approved. We're setting it up now — your account number will be ready shortly.",
    ).catch(() => {});

    await audit({
      req, action: "KYC_APPROVE", resourceType: "business", resourceId: biz.id,
      severity: "info", metadata: { submissionId: submission.id },
    });

    res.json({ status: "approved", result: result.body });
  } catch (err) {
    console.error("POST /admin/kyc-submissions/approve error:", err.message);
    res.status(500).json({ error: "Failed to approve submission" });
  }
});

// POST /admin-api/kyc-submissions/:id/decline  body: { reason }
router.post("/kyc-submissions/:id/decline", async (req, res) => {
  try {
    const reason = String(req.body.reason || "").trim();
    if (!reason) return res.status(400).json({ error: "A decline reason is required." });

    const submission = await prisma.kycSubmission.findUnique({ where: { id: req.params.id } });
    if (!submission) return res.status(404).json({ error: "Submission not found" });
    if (!["PENDING", "FAILED"].includes(submission.status)) {
      return res.status(409).json({ error: `This request was already ${submission.status.toLowerCase()}.` });
    }

    // Atomic claim (mutually exclusive with a concurrent approve) so we can't
    // decline a request that is simultaneously being provisioned at Anchor.
    const claim = await prisma.kycSubmission.updateMany({
      where: { id: submission.id, status: { in: ["PENDING", "FAILED"] } },
      // Drop the payload — no need to retain raw BVNs on a declined request.
      data: { status: "DECLINED", declineReason: reason.slice(0, 500), reviewedById: req.user.id, reviewedAt: new Date(), payload: null },
    });
    if (claim.count !== 1) {
      return res.status(409).json({ error: "This request is already being processed." });
    }

    pushTo(
      submission.userId,
      "Account request not approved",
      `${reason} — you can update your details and resubmit.`,
    ).catch(() => {});

    await audit({
      req, action: "KYC_DECLINE", resourceType: "business", resourceId: submission.businessId,
      severity: "warning", metadata: { submissionId: submission.id, reason },
    });

    res.json({ status: "declined" });
  } catch (err) {
    console.error("POST /admin/kyc-submissions/decline error:", err.message);
    res.status(500).json({ error: "Failed to decline submission" });
  }
});

// ── Compliance: flag queue ────────────────────────────────────────────────
// GET /admin-api/compliance/flags?status=open&severity=high&limit=50
router.get("/compliance/flags", async (req, res) => {
  try {
    const { status = "open", severity, limit = "100" } = req.query;
    const where = {};
    if (status) where.status = status;
    if (severity) where.severity = severity;
    const flags = await prisma.complianceFlag.findMany({
      where,
      take: Math.min(Number(limit) || 100, 500),
      orderBy: [
        // High severity + most recent first
        { severity: "desc" },
        { createdAt: "desc" },
      ],
    });
    // Join user + business + transaction summaries on the server so the
    // admin SPA stays a simple fetch+render.
    const enriched = await Promise.all(
      flags.map(async (f) => {
        const [user, business, transaction] = await Promise.all([
          prisma.user.findUnique({
            where: { id: f.userId },
            select: { id: true, firstName: true, lastName: true, email: true, phone: true, country: true, accountStatus: true },
          }),
          f.businessId
            ? prisma.business.findUnique({
                where: { id: f.businessId },
                select: { id: true, name: true, country: true, riskCategory: true, industry: true, virtualAccountNumber: true },
              })
            : null,
          f.transactionId
            ? prisma.transaction.findUnique({
                where: { id: f.transactionId },
                select: { id: true, amount: true, currency: true, type: true, description: true, date: true, complianceStatus: true },
              })
            : null,
        ]);
        return { ...f, user, business, transaction };
      }),
    );
    res.json(enriched);
  } catch (err) {
    console.error("[admin/compliance/flags]", err);
    res.status(500).json({ error: "Failed to load flags" });
  }
});

// PATCH /admin-api/compliance/flags/:id   body: { status, reviewerNote }
router.patch("/compliance/flags/:id", async (req, res) => {
  try {
    const { status, reviewerNote } = req.body;
    const allowed = ["cleared", "escalated", "frozen"];
    if (!allowed.includes(status)) {
      return res.status(400).json({ error: `status must be one of ${allowed.join(", ")}` });
    }
    const flag = await prisma.complianceFlag.update({
      where: { id: req.params.id },
      data: {
        status,
        reviewedBy: req.user.id,
        reviewedAt: new Date(),
        reviewerNote: reviewerNote || null,
      },
    });
    await audit({
      req,
      action: `FLAG_${status.toUpperCase()}`,
      resourceType: "complianceFlag",
      resourceId: flag.id,
      severity: "info",
      metadata: { reviewerNote },
    });
    res.json(flag);
  } catch (err) {
    console.error("[admin/compliance/flags PATCH]", err);
    res.status(500).json({ error: "Failed to update flag" });
  }
});

// ── Freeze workflow ───────────────────────────────────────────────────────
// POST /admin-api/users/:id/freeze   body: { reason }
router.post("/users/:id/freeze", async (req, res) => {
  try {
    const { reason } = req.body;
    if (!reason || !reason.trim()) {
      return res.status(400).json({ error: "A freeze reason is required for the audit trail." });
    }
    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: {
        accountStatus: "frozen",
        complianceFreezeReason: reason.trim(),
        complianceFrozenAt: new Date(),
        complianceFrozenBy: req.user.id,
      },
      select: { id: true, accountStatus: true, complianceFreezeReason: true },
    });
    await audit({
      req,
      action: "ADMIN_FREEZE",
      resourceType: "user",
      resourceId: user.id,
      severity: "alert",
      metadata: { reason: reason.trim() },
    });
    res.json(user);
  } catch (err) {
    console.error("[admin/freeze]", err);
    res.status(500).json({ error: "Failed to freeze account" });
  }
});

// POST /admin-api/users/:id/unfreeze   body: { note? }
router.post("/users/:id/unfreeze", async (req, res) => {
  try {
    const { note } = req.body;
    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: {
        accountStatus: "active",
        complianceFreezeReason: null,
        complianceFrozenAt: null,
        complianceFrozenBy: null,
      },
      select: { id: true, accountStatus: true },
    });
    await audit({
      req,
      action: "ADMIN_UNFREEZE",
      resourceType: "user",
      resourceId: user.id,
      severity: "warn",
      metadata: { note: note || null },
    });
    res.json(user);
  } catch (err) {
    console.error("[admin/unfreeze]", err);
    res.status(500).json({ error: "Failed to unfreeze account" });
  }
});

// ── Audit log lookup ──────────────────────────────────────────────────────
// GET /admin-api/audit-log?actorId=...&action=...&from=YYYY-MM-DD&to=YYYY-MM-DD&limit=100
router.get("/audit-log", async (req, res) => {
  try {
    const { actorId, action, severity, from, to, limit = "100" } = req.query;
    const where = {};
    if (actorId) where.actorId = actorId;
    if (action) where.action = action;
    if (severity) where.severity = severity;
    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt.gte = new Date(from);
      if (to) where.createdAt.lte = new Date(to);
    }
    const logs = await prisma.auditLog.findMany({
      where,
      take: Math.min(Number(limit) || 100, 500),
      orderBy: { createdAt: "desc" },
    });
    res.json(logs);
  } catch (err) {
    console.error("[admin/audit-log]", err);
    res.status(500).json({ error: "Failed to load audit log" });
  }
});

// ── Transaction lookup ────────────────────────────────────────────────────
// GET /admin-api/transactions/lookup?reference=...&userId=...&minAmount=...&limit=50
router.get("/transactions/lookup", async (req, res) => {
  try {
    const { reference, userId, minAmount, complianceStatus, limit = "50" } = req.query;
    const where = {};
    if (userId) where.userId = userId;
    if (reference) where.description = { contains: reference };
    if (minAmount) where.amount = { gte: Number(minAmount) };
    if (complianceStatus) where.complianceStatus = complianceStatus;
    const txns = await prisma.transaction.findMany({
      where,
      take: Math.min(Number(limit) || 50, 200),
      orderBy: { date: "desc" },
    });
    res.json(txns);
  } catch (err) {
    console.error("[admin/transactions/lookup]", err);
    res.status(500).json({ error: "Failed to look up transactions" });
  }
});

// ── Observability: health + live request metrics ──────────────────────────────
// (Exception tracking is handled by Sentry — see server/src/instrument.js — so
//  there are no in-house /errors endpoints. View errors in the Sentry dashboard.)
router.get("/health", async (_req, res) => {
  try { res.json(await collectHealth()); }
  catch (err) { console.error("GET /admin/health error:", err.message); res.status(500).json({ error: "Failed to collect health" }); }
});

router.get("/metrics", (_req, res) => {
  try { res.json(getMetrics()); }
  catch (err) { res.status(500).json({ error: "Failed to read metrics" }); }
});

// ── Observability: analytics history (charts read this; current KPIs via /stats) ──
// GET /admin-api/analytics?days=30
router.get("/analytics", async (req, res) => {
  try {
    const days = Math.min(180, Math.max(1, Number(req.query.days) || 30));
    const since = new Date(Date.now() - days * 86400000);
    const history = await prisma.metricSnapshot.findMany({
      where: { kind: "analytics", takenAt: { gte: since } },
      orderBy: { takenAt: "asc" },
    });
    res.json({ days, history });
  } catch (err) {
    console.error("GET /admin/analytics error:", err.message);
    res.status(500).json({ error: "Failed to fetch analytics" });
  }
});

module.exports = router;
