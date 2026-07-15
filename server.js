require("dotenv").config();
// Sentry must initialize before express/route modules so it can auto-instrument
// HTTP + Express. No-op when SENTRY_DSN is unset. Also registers its own
// unhandledRejection / uncaughtException handlers (captures + flushes + exits).
const Sentry = require("./src/instrument");
// Fail fast on insecure/missing config before anything starts listening.
require("./src/utils/validateEnv").validateEnv();

// Last-resort safety net. A dropped Postgres socket can surface as an
// uncaughtException ("Connection terminated unexpectedly") from deep inside pg's
// event emitters (e.g. during the reconcile cron's DB writes). Swallow ONLY that
// benign, self-healing case so the API stays up — the pool reconnects on the next
// query. Anything else is reported to Sentry and the process exits so Render
// restarts cleanly. (Paired with the per-client error listener in utils/db.js.)
process.on("uncaughtException", (err) => {
  if (/Connection terminated/i.test((err && err.message) || "")) {
    console.error("[uncaught] pg connection dropped (handled, non-fatal):", err.message);
    return;
  }
  console.error("[uncaught] fatal:", err);
  try { Sentry.captureException(err); } catch { /* noop */ }
  Sentry.flush(2000).catch(() => {}).finally(() => process.exit(1));
});
process.on("unhandledRejection", (reason) => {
  const msg = (reason && (reason.message || String(reason))) || "";
  if (/Connection terminated/i.test(msg)) {
    console.error("[unhandledRejection] pg connection dropped (handled, non-fatal):", msg);
    return;
  }
  console.error("[unhandledRejection]", reason);
});

const express = require("express");
const cors = require("cors");
const path = require("path");
const prisma = require("./src/utils/db");
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");
const morgan = require("morgan");
const { metricsMiddleware } = require("./src/utils/metrics");

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
const fincraWebhookRoute = require("./src/routes/fincra");
const instagramRoutes = require("./src/routes/instagram");
const instagramWebhookRoute = require("./src/routes/instagramWebhook");
const whatsappRoutes = require("./src/routes/whatsapp");
const whatsappWebhookRoute = require("./src/routes/whatsappWebhook");
const transferRoutes = require("./src/routes/transfers");
const syncRoutes = require("./src/routes/sync");
const recurringExpenseRoutes = require("./src/routes/recurringExpenses").router;
const recurringInvoiceRoutes = require("./src/routes/recurringInvoices");
const insightsRoutes = require("./src/routes/insights");

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

// Per-request latency + status metrics (in-memory; read via /admin-api/metrics).
app.use(metricsMiddleware);

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

// Webhooks: per-IP flood guard. Legitimate providers (Anchor/RevenueCat) come
// from a small set of IPs well under this; an attacker flooding from one IP is cut off.
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests." },
});

// Admin SPA HTML serve — static file, just stop hammering.
const adminSpaLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

// ── Security headers ──────────────────────────────────────────────────────────
// Strips X-Powered-By, sets XSS-Protection, HSTS, Content-Type-Options, etc.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // No 'unsafe-inline' — the admin SPA's JS lives in /admin/app.js (served
        // from 'self') and has no inline <script> or inline event handlers.
        scriptSrc: [
          "'self'",
          "cdn.tailwindcss.com",
          "cdn.jsdelivr.net",
        ],
        // styleSrc keeps 'unsafe-inline' because the Tailwind Play CDN injects
        // generated styles at runtime (style injection, not script execution).
        styleSrc: ["'self'", "'unsafe-inline'", "cdn.tailwindcss.com"],
        imgSrc: ["'self'", "data:"],
        scriptSrcAttr: ["'none'"],
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
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGIN || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
// In production an explicit allowlist is REQUIRED — never fall back to reflecting
// any origin (that would let any site make credentialed cross-origin calls).
if (process.env.NODE_ENV === "production" && ALLOWED_ORIGINS.length === 0) {
  throw new Error("ALLOWED_ORIGIN must be set in production (comma-separated list of origins)");
}
const corsOptions = ALLOWED_ORIGINS.length
  ? {
      origin: ALLOWED_ORIGINS,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization"],
      credentials: true,
    }
  : {}; // dev only — reflect any origin so ngrok/local testing works
app.use(cors(corsOptions));
// Paystack webhook needs the raw body for HMAC-SHA512 verification — mount with
// express.raw BEFORE express.json so the JSON parser doesn't consume the stream.
app.use(
  "/webhooks/anchor",
  webhookLimiter,
  express.raw({ type: "application/json", limit: "1mb" }),
  anchorWebhookRoute,
);
// Fincra webhook — same raw-body-before-json requirement so the HMAC-SHA512
// signature verifies against the exact bytes Fincra signed (header `signature`).
app.use(
  "/webhooks/fincra",
  webhookLimiter,
  express.raw({ type: "application/json", limit: "1mb" }),
  fincraWebhookRoute,
);
// Instagram messaging webhook — same raw-body-before-json requirement so the
// X-Hub-Signature-256 HMAC verifies against the exact bytes Meta sent. The GET
// handshake carries no body, so express.raw is a no-op for it.
app.use(
  "/webhooks/instagram",
  webhookLimiter,
  express.raw({ type: "application/json", limit: "1mb" }),
  instagramWebhookRoute,
);
// WhatsApp Cloud API webhook — same raw-body-before-json requirement (signature
// is HMAC over the exact bytes, keyed on the FB app secret).
app.use(
  "/webhooks/whatsapp",
  webhookLimiter,
  express.raw({ type: "application/json", limit: "1mb" }),
  whatsappWebhookRoute,
);
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
// RevenueCat webhook — header-token auth (no body signature), so it's fine
// after express.json. Keeps User.plan in sync with subscriptions.
app.use("/webhooks/revenuecat", webhookLimiter, require("./src/routes/revenuecat"));
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
app.use("/recurring-invoices", apiLimiter);
app.use("/insights", apiLimiter);
app.use("/sync", apiLimiter);
app.use("/instagram", apiLimiter);
app.use("/whatsapp", apiLimiter);
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
app.use("/recurring-invoices", recurringInvoiceRoutes);
app.use("/insights", insightsRoutes);
app.use("/sync", syncRoutes);
app.use("/instagram", instagramRoutes);
app.use("/whatsapp", whatsappRoutes);

// ── Public hosted invoice page (no auth) ──────────────────────────────────────
// GET /i/:token — what merchants share with customers via WhatsApp / link.
app.use("/", require("./src/routes/publicInvoice"));

// ── Admin panel (serves SPA) ──────────────────────────────────────────────────
app.get("/admin", adminSpaLimiter, (_req, res) =>
  res.sendFile(path.join(__dirname, "public", "admin", "index.html")),
);

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/health", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: "ok", uptime: Math.round(process.uptime()) });
  } catch {
    res.status(503).json({ status: "degraded" });
  }
});

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: "Route not found" }));

// ── Error handling ────────────────────────────────────────────────────────────
// Sentry's error handler must come before any other error middleware — it
// captures the exception (no-op without a DSN) then passes it on to ours.
Sentry.setupExpressErrorHandler(app);

app.use((err, req, res, _next) => {
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

// ── Background cron: daily business report at 8pm Lagos time ─────────────────
// Summary of today's money in/out per user, or a nudge if nothing was
// recorded. node-cron handles the timezone; WAT has no DST.
cron.schedule(
  "0 20 * * *",
  async () => {
    try {
      await prisma.withCronLock(4001, async () => {
        await require("./src/utils/snapshots").recordHeartbeat("dailyReport");
        await require("./src/utils/dailyReport").sendDailyReports();
      });
    } catch (err) {
      console.error("[cron dailyReport]", err.message);
    }
  },
  { timezone: "Africa/Lagos" },
);

// ── Background cron: monthly P&L email — 1st of the month, 08:00 Lagos ───────
// Last month's income/expenses/net per business, emailed to every owner with
// activity. See src/utils/monthlyReport.js; manual trigger via
// POST /admin-api/run-monthly-report.
cron.schedule(
  "0 8 1 * *",
  async () => {
    try {
      await prisma.withCronLock(4009, async () => {
        await require("./src/utils/snapshots").recordHeartbeat("monthlyReport");
        const r = await require("./src/utils/monthlyReport").sendMonthlyReports();
        console.log(`[Cron] monthly report — ${r.users} email(s) (${r.month || ""})`);
      });
    } catch (err) {
      console.error("[Cron] monthly report error:", err.message);
    }
  },
  { timezone: "Africa/Lagos" },
);

// ── Background cron: low stock push notifications (every hour) ───────────────
cron.schedule("0 * * * *", async () => {
  try {
    await prisma.withCronLock(4002, async () => {
    await require("./src/utils/snapshots").recordHeartbeat("lowStock");
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
    });
  } catch (err) {
    console.error("[Cron] Low stock check error:", err);
  }
});

// ── Background cron: process due recurring expenses (daily at 00:05) ─────────
// For each due item: writes the bookkeeping Expense row + optionally fires the
// auto-debit transfer if enabled. Full pipeline (AML / frozen / single-cap /
// rules engine) runs on every auto-debit. See utils/recurringExpenseRunner.js.
const { processRecurringExpenses } = require("./src/utils/recurringExpenseRunner");
cron.schedule("5 0 * * *", async () => {
  try {
    await prisma.withCronLock(4003, async () => {
      await require("./src/utils/snapshots").recordHeartbeat("recurringExpenses");
      await processRecurringExpenses();
    });
  } catch (err) {
    console.error("[Cron] Recurring expenses error:", err);
  }
});

// ── Background cron: process due recurring invoices (daily at 00:15) ─────────
// For each due PREMIUM rule: creates the SENT invoice + share link and pushes
// the owner. See utils/recurringInvoiceRunner.js.
cron.schedule("15 0 * * *", async () => {
  try {
    await prisma.withCronLock(4010, async () => {
      await require("./src/utils/snapshots").recordHeartbeat("recurringInvoices");
      await require("./src/utils/recurringInvoiceRunner").processRecurringInvoices();
    });
  } catch (err) {
    console.error("[Cron] Recurring invoices error:", err);
  }
});

// ── Observability: health snapshot + alerts every 10 min; analytics hourly ───
cron.schedule("*/10 * * * *", async () => {
  try {
    await prisma.withCronLock(4005, async () => {
      const snaps = require("./src/utils/snapshots");
      const { checkAlerts } = require("./src/utils/alerts");
      await snaps.recordHeartbeat("snapshot");
      const health = await snaps.takeHealthSnapshot();
      await checkAlerts(health);
      if (new Date().getMinutes() < 10) await snaps.takeAnalyticsSnapshot(); // ~hourly at :00
    });
  } catch (err) {
    console.error("[Cron] observability snapshot error:", err);
  }
});

// ── Observability: retention purge (daily 01:10) ─────────────────────────────
cron.schedule("10 1 * * *", async () => {
  try {
    await prisma.withCronLock(4006, () => require("./src/utils/snapshots").purgeRetention());
  } catch (err) {
    console.error("[Cron] retention purge error:", err);
  }
});

// ── KYC cache retention: drop normalized KYC/identity data past TTL (daily 02:00 Lagos) ──
// NDPA data-minimization — the purge entry point existed but was never scheduled.
cron.schedule(
  "0 2 * * *",
  async () => {
    try {
      await prisma.withCronLock(4007, async () => {
        await require("./src/utils/snapshots").recordHeartbeat("kycPurge");
        await require("./src/utils/kycCheck").purgeStaleCache();
      });
    } catch (err) {
      console.error("[Cron] KYC cache purge error:", err.message);
    }
  },
  { timezone: "Africa/Lagos" },
);

// ── Background cron: refresh Instagram long-lived tokens (daily 03:30 Lagos) ──
// IG User tokens last 60 days; refresh any within ~10 days of expiry while still
// valid. Already-expired ones are flagged for re-OAuth. See instagramJobs.js.
cron.schedule(
  "30 3 * * *",
  async () => {
    try {
      await prisma.withCronLock(4008, async () => {
        await require("./src/utils/snapshots").recordHeartbeat("instagramTokenRefresh");
        const r = await require("./src/utils/instagramJobs").refreshExpiringTokens();
        if (r.refreshed || r.expired || r.failed) {
          console.log(`[Cron] IG tokens — refreshed ${r.refreshed}, expired ${r.expired}, failed ${r.failed}`);
        }
      });
    } catch (err) {
      console.error("[Cron] IG token refresh error:", err.message);
    }
  },
  { timezone: "Africa/Lagos" },
);

// ── Background cron: send pending reminders every 5 minutes ──────────────────
// Reminders are scheduled at user-chosen times and rarely time-critical to
// the minute. 5min cadence cuts cron-driven DB queries by 80%.
cron.schedule("*/5 * * * *", async () => {
  try {
    await require("./src/utils/snapshots").recordHeartbeat("reminders");
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
