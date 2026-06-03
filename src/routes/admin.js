const router = require("express").Router();
const auth = require("../middleware/auth");
const adminAuth = require("../middleware/adminAuth");
const prisma = require("../utils/db");

router.use(auth, adminAuth);

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
    res.json({ ok: true });
  } catch (err) {
    console.error("PATCH /admin/users/downgrade error:", err.message);
    res.status(500).json({ error: "Failed to downgrade user" });
  }
});

// GET /admin-api/revenue  (last 30 days, grouped by day)
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

// POST /admin-api/notify  — saves in-app notification for all users (or one user)
router.post("/notify", async (req, res) => {
  const { userId, title, body } = req.body;
  if (!title || !body) {
    return res.status(400).json({ error: "title and body required" });
  }

  try {
    if (userId) {
      // Single user
      await prisma.appNotification.create({ data: { userId, title, body } });
      return res.json({ saved: 1 });
    }

    // Broadcast: get all user IDs and create a notification for each
    const users = await prisma.user.findMany({ select: { id: true } });
    await prisma.appNotification.createMany({
      data: users.map((u) => ({ userId: u.id, title, body })),
    });
    res.json({ saved: users.length });
  } catch (err) {
    console.error("POST /admin/notify error:", err.message);
    res.status(500).json({ error: "Failed to send notification" });
  }
});

module.exports = router;
