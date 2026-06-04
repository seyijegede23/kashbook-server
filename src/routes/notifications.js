 const router = require("express").Router();
const auth = require("../middleware/auth");
const prisma = require("../utils/db");

router.use(auth);

// GET /notifications — fetch all for current user
router.get("/", async (req, res) => {
  try {
    const notifications = await prisma.appNotification.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    res.json(notifications);
  } catch (err) {
    console.error("GET /notifications error:", err.message);
    res.status(500).json({ error: "Failed to fetch notifications" });
  }
});

// PATCH /notifications/:id/read — mark one as read
router.patch("/:id/read", async (req, res) => {
  try {
    await prisma.appNotification.updateMany({
      where: { id: req.params.id, userId: req.user.id },
      data: { read: true },
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to mark read" });
  }
});

// PATCH /notifications/read-all — mark all as read
router.patch("/read-all", async (req, res) => {
  try {
    await prisma.appNotification.updateMany({
      where: { userId: req.user.id, read: false },
      data: { read: true },
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to mark all read" });
  }
});

module.exports = router;
