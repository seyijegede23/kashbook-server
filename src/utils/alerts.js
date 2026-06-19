// Alert engine — evaluates health thresholds and notifies admins (push + email)
// at most once per rule per cooldown window. Run from the observability cron.
const prisma = require("./db");
const { pushTo } = require("./pushNotification");
const { sendEmail } = require("./otp");
const { getMetrics } = require("./metrics");

const COOLDOWN_MS = 60 * 60 * 1000; // 1h per rule — avoids alert storms

// Fire an alert if it isn't within its cooldown. Returns true if it fired.
async function fire(key, title, body) {
  try {
    const now = new Date();
    const state = await prisma.alertState.findUnique({ where: { key } });
    if (state && now - new Date(state.lastFiredAt) < COOLDOWN_MS) return false;
    await prisma.alertState.upsert({
      where: { key },
      create: { key, lastFiredAt: now, lastValue: body.slice(0, 200) },
      update: { lastFiredAt: now, lastValue: body.slice(0, 200) },
    });
    const admins = await prisma.user.findMany({ where: { role: "ADMIN" }, select: { id: true } });
    for (const a of admins) pushTo(a.id, `⚠️ ${title}`, body).catch(() => {});
    const to = process.env.ADMIN_ALERT_EMAIL;
    if (to) sendEmail(to, `[KashBook alert] ${title}`, `<p>${body}</p>`).catch(() => {});
    console.warn(`[alert] ${key}: ${body}`);
    return true;
  } catch (e) {
    console.error("[alerts] fire failed:", e.message);
    return false;
  }
}

// `health` is the object from collectHealth() (passed by the snapshot cron).
async function checkAlerts(health = {}) {
  const fired = [];
  try {
    const m = getMetrics();

    if (health.pool && health.pool.waiting > 0) {
      if (await fire("pool_waiting", "DB pool saturated",
        `Connection pool has ${health.pool.waiting} request(s) waiting (max ${health.pool.max}). Requests are queueing — consider raising the pool or scaling.`))
        fired.push("pool_waiting");
    }
    if (m.totalRequests > 50 && m.errorRate5xx >= 5) {
      if (await fire("error_rate_5xx", "High 5xx error rate",
        `5xx error rate is ${m.errorRate5xx}% across ${m.totalRequests} requests since restart.`))
        fired.push("error_rate_5xx");
    }
    if (health.errors && health.errors.alert1h >= 5) {
      if (await fire("audit_alerts", "Audit alerts spiking",
        `${health.errors.alert1h} alert-severity audit events in the last hour.`))
        fired.push("audit_alerts");
    }
    const stale = (health.crons || []).find((c) => c.stale);
    if (stale) {
      if (await fire(`cron_stale_${stale.name}`, "A cron stopped running",
        `Cron "${stale.name}" last ran ${stale.ageMin} min ago.`))
        fired.push(`cron_stale_${stale.name}`);
    }
    if (health.heldTransactions > 0) {
      if (await fire("money_held", "Money events held for review",
        `${health.heldTransactions} transaction(s) are held for compliance review.`))
        fired.push("money_held");
    }
  } catch (e) {
    console.error("[alerts] checkAlerts failed:", e.message);
  }
  return fired;
}

module.exports = { checkAlerts };
