require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const prisma = require("./src/utils/db");
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");
const morgan = require("morgan");

const authRoutes = require("./src/routes/auth");
const businessRoutes = require("./src/routes/businesses");
const customerRoutes = require("./src/routes/customers");
const inventoryRoutes = require("./src/routes/inventory");
const salesRoutes = require("./src/routes/sales");
const expenseRoutes = require("./src/routes/expenses");
const businessDebtRoutes = require("./src/routes/businessDebts");
const suggestionRoutes = require("./src/routes/suggestions");
const reminderRoutes = require("./src/routes/reminders");
const invoiceRoutes = require("./src/routes/invoices");
const adminRoutes = require("./src/routes/admin");
const notificationRoutes = require("./src/routes/notifications");
const anchorWebhookRoute = require("./src/routes/anchor");
const transferRoutes = require("./src/routes/transfers");
const syncRoutes = require("./src/routes/sync");
const recurringExpenseRoutes = require("./src/routes/recurringExpenses").router;
const { computeNextDue } = require("./src/routes/recurringExpenses");

const { sendSms } = require("./src/utils/otp");
const cron = require("node-cron");
const xss = require("xss");

const app = express();
app.set("trust proxy", 1);
const PORT = process.env.PORT || 3000;

// HTTP request logger — flushes immediately so Render logs see every request
app.use(
  morgan(":method :url :status :response-time ms - :res[content-length]", {
    immediate: false,
    stream: { write: (msg) => process.stdout.write(msg) },
  }),
);

// ── Rate limiters ─────────────────────────────────────────────────────────────

// Auth routes: strict — prevents brute-force on login/OTP/password reset
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // 20 attempts per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Too many attempts. Please wait 15 minutes and try again.",
  },
});

// OTP / SMS routes: very strict — each SMS costs money
const otpLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5, // 5 OTP requests per IP per hour
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Too many verification code requests. Please try again in 1 hour.",
  },
});

// General API: loose — just blocks DoS/runaway clients
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 120, // 120 requests per IP per minute (2/sec)
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please slow down." },
});

// ── Security headers ──────────────────────────────────────────────────────────
// Strips X-Powered-By, sets XSS-Protection, HSTS, Content-Type-Options, etc.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: [
          "'self'",
          "'unsafe-inline'",
          "cdn.tailwindcss.com",
          "cdn.jsdelivr.net",
        ],
        styleSrc: ["'self'", "'unsafe-inline'", "cdn.tailwindcss.com"],
        imgSrc: ["'self'", "data:"],
        scriptSrcAttr: ["'unsafe-inline'"],
        connectSrc: ["'self'", "cdn.tailwindcss.com", "cdn.jsdelivr.net"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
  }),
);

// ── Middleware ────────────────────────────────────────────────────────────────
// CORS: in production restrict to your actual domain via ALLOWED_ORIGIN env var
// e.g. ALLOWED_ORIGIN=https://api.kashbook.com
// In dev (no env var set) allow all origins so ngrok/local testing still works
const corsOptions = process.env.ALLOWED_ORIGIN
  ? {
      origin: process.env.ALLOWED_ORIGIN,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization"],
      credentials: true,
    }
  : {};
app.use(cors(corsOptions));
// Paystack webhook needs the raw body for HMAC-SHA512 verification — mount with
// express.raw BEFORE express.json so the JSON parser doesn't consume the stream.
app.use(
  "/webhooks/anchor",
  express.raw({ type: "application/json", limit: "1mb" }),
  anchorWebhookRoute,
);
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use((_req, res, next) => {
  res.setHeader("ngrok-skip-browser-warning", "1");
  next();
});
app.use(express.static(path.join(__dirname, "public")));

// ── Input sanitizer ───────────────────────────────────────────────────────────
// Strips null bytes and prevents __proto__ / constructor pollution from JSON body
function sanitizeObject(obj) {
  if (!obj || typeof obj !== "object") return;
  for (const key of Object.keys(obj)) {
    // Block prototype pollution keys
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      delete obj[key];
      continue;
    }
    const val = obj[key];
    if (typeof val === "string") {
      // Strip null bytes then strip all HTML tags (prevents stored XSS)
      obj[key] = xss(val.replace(/\x00/g, ""), {
        whiteList: {},
        stripIgnoreTag: true,
      });
    } else if (typeof val === "object") {
      sanitizeObject(val);
    }
  }
}

app.use((req, _res, next) => {
  if (req.body) sanitizeObject(req.body);
  if (req.query) sanitizeObject(req.query);
  next();
});

// ── Routes ────────────────────────────────────────────────────────────────────

// OTP endpoints — tightest limit (each sends an SMS)
app.use("/auth/send-otp", otpLimiter);
app.use("/auth/check-otp", otpLimiter);

// Auth endpoints — strict limit (prevents brute-force)
app.use("/auth", authLimiter);

// All other API routes — general DoS protection
app.use("/businesses", apiLimiter);
app.use("/customers", apiLimiter);
app.use("/inventory", apiLimiter);
app.use("/sales", apiLimiter);
app.use("/expenses", apiLimiter);
app.use("/business-debts", apiLimiter);
app.use("/suggestions", apiLimiter);
app.use("/reminders", apiLimiter);
app.use("/invoices", apiLimiter);
app.use("/notifications", apiLimiter);
app.use("/transfers", apiLimiter);
app.use("/recurring-expenses", apiLimiter);
app.use("/sync", apiLimiter);
app.use("/admin-api", authLimiter);

app.use("/auth", authRoutes);
app.use("/businesses", businessRoutes);
app.use("/customers", customerRoutes);
app.use("/inventory", inventoryRoutes);
app.use("/sales", salesRoutes);
app.use("/expenses", expenseRoutes);
app.use("/business-debts", businessDebtRoutes);
app.use("/suggestions", suggestionRoutes);
app.use("/reminders", reminderRoutes);
app.use("/invoices", invoiceRoutes);
app.use("/admin-api", adminRoutes);
app.use("/notifications", notificationRoutes);
app.use("/transfers", transferRoutes);
app.use("/recurring-expenses", recurringExpenseRoutes);
app.use("/sync", syncRoutes);

// ── Admin panel (serves SPA) ──────────────────────────────────────────────────
app.get("/admin", (_req, res) =>
  res.sendFile(path.join(__dirname, "public", "admin", "index.html")),
);

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({ status: "ok" }));

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: "Route not found" }));

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

// ── Start server (Prisma connects lazily — no explicit connect needed) ────────
app.listen(PORT, () => console.log(`KashBook API running on port ${PORT}`));

// ── Background loop: reconcile Anchor inbound credits every 5 min ────────────
// Belt-and-braces safety net so users still get credits + push notifications
// even when Anchor's webhook delivery drops or the event isn't subscribed.
// Per-business calls are throttled inside the loop to stay under Anchor's
// rate limit.
require("./src/utils/anchorReconcile").startReconciliationLoop(5 * 60 * 1000);

// ── Background cron: low stock push notifications (every hour) ───────────────
cron.schedule("0 * * * *", async () => {
  try {
    // Filter at the DB level so we only pull genuinely low rows (instead of
    // loading the entire inventory table into memory each hour).
    const actualLow = await prisma.$queryRaw`
      SELECT i.*
      FROM "InventoryItem" i
      WHERE i.quantity <= i."lowStockAlert"
    `;
    if (actualLow.length === 0) return;

    const userIds = [...new Set(actualLow.map((i) => i.userId).filter(Boolean))];
    const users = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, expoPushToken: true, notificationsEnabled: true },
    });
    const userById = new Map(users.map((u) => [u.id, u]));

    for (const item of actualLow) {
      item.user = userById.get(item.userId);
      if (!item.userId || !item.user?.notificationsEnabled) continue;
      const body = `${item.name} is running low — only ${item.quantity} ${item.unit || "unit(s)"} left`;

      // Always save in-app notification
      await prisma.appNotification.create({
        data: { userId: item.userId, title: "Low Stock Alert", body },
      });

      // Also send push if token is available
      if (item.user.expoPushToken) {
        fetch("https://exp.host/--/api/v2/push/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            to: item.user.expoPushToken,
            title: "Low Stock Alert",
            body,
            sound: "default",
            data: { screen: "Inventory" },
          }),
        }).catch(() => {});
      }
    }
    if (actualLow.length > 0)
      console.log(`[Cron] Low stock alerts sent for ${actualLow.length} item(s)`);
  } catch (err) {
    console.error("[Cron] Low stock check error:", err);
  }
});

// ── Background cron: create due recurring expenses (daily at 00:05) ──────────
cron.schedule("5 0 * * *", async () => {
  try {
    const now = new Date();
    const due = await prisma.recurringExpense.findMany({
      where: { active: true, nextDue: { lte: now } },
    });
    for (const rec of due) {
      await prisma.expense.create({
        data: {
          userId: rec.userId,
          businessId: rec.businessId,
          category: rec.category,
          amount: rec.amount,
          paymentMethod: rec.paymentMethod,
          notes: rec.notes,
          date: now,
        },
      });
      const nextDue = computeNextDue(rec.frequency, rec.nextDue);
      await prisma.recurringExpense.update({
        where: { id: rec.id },
        data: { nextDue },
      });
    }
    if (due.length > 0)
      console.log(`[Cron] Created ${due.length} recurring expense(s)`);
  } catch (err) {
    console.error("[Cron] Recurring expenses error:", err);
  }
});

// ── Background cron: send pending reminders every 5 minutes ──────────────────
// Reminders are scheduled at user-chosen times and rarely time-critical to
// the minute. 5min cadence cuts cron-driven DB queries by 80%.
cron.schedule("*/5 * * * *", async () => {
  try {
    const now = new Date();
    const pendingReminders = await prisma.reminder.findMany({
      where: { status: "pending", scheduledFor: { lte: now } },
    });

    if (pendingReminders.length > 0) {
      console.log(
        `[Cron] ${pendingReminders.length} pending reminder(s) to send.`,
      );
    }

    for (const reminder of pendingReminders) {
      try {
        if (!reminder.phone) {
          await prisma.reminder.update({
            where: { id: reminder.id },
            data: { status: "failed" },
          });
          continue;
        }
        await sendSms(reminder.phone, reminder.message || "KashBook reminder.");
        await prisma.reminder.update({
          where: { id: reminder.id },
          data: { status: "sent", sentAt: new Date() },
        });
      } catch (smsErr) {
        console.error(`[Cron] Failed SMS to ${reminder.phone}:`, smsErr);
        await prisma.reminder.update({
          where: { id: reminder.id },
          data: { status: "failed" },
        });
      }
    }
  } catch (err) {
    console.error("[Cron] Error processing reminders:", err);
  }
});
