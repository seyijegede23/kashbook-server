const prisma = require("./db");

/**
 * Send a push notification + persist the in-app notification row.
 * Used by webhook handlers AND the periodic reconciliation job.
 *
 * `data` (optional, a plain object) rides with the push as the Expo message's
 * `data`, for the app to act on when it arrives: a cash deposit's credit sends
 * { kind: "cash_deposit", depositId } (utils/cashDeposits.js). The in-app row
 * keeps the title and body only.
 */
async function pushTo(userId, title, body, data) {
  if (!userId) return;
  await prisma.appNotification.create({ data: { userId, title, body } });
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { expoPushToken: true, notificationsEnabled: true },
  });
  if (user?.expoPushToken && user?.notificationsEnabled) {
    const extra = data && typeof data === "object" && !Array.isArray(data) ? { data } : {};
    fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to: user.expoPushToken,
        title,
        body,
        sound: "default",
        ...extra,
      }),
    }).catch(() => {});
  }
}

module.exports = { pushTo };
