const prisma = require("./db");

/**
 * Send a push notification + persist the in-app notification row.
 * Used by webhook handlers AND the periodic reconciliation job.
 */
async function pushTo(userId, title, body) {
  if (!userId) return;
  await prisma.appNotification.create({ data: { userId, title, body } });
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { expoPushToken: true, notificationsEnabled: true },
  });
  if (user?.expoPushToken && user?.notificationsEnabled) {
    fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to: user.expoPushToken,
        title,
        body,
        sound: "default",
      }),
    }).catch(() => {});
  }
}

module.exports = { pushTo };
