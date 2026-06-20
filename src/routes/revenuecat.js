/**
 * RevenueCat webhook handler.
 *
 * Keeps User.plan in sync with the customer's subscription so SERVER-gated
 * Pro features (e.g. staff creation, which checks the DB plan) unlock on
 * purchase without admin intervention. Client-gated features already react
 * to the live entitlement via the SDK; this closes the server-side gap.
 *
 * Auth: RevenueCat sends the Authorization header value you configure under
 * Project settings → Integrations → Webhooks. We compare it to
 * REVENUECAT_WEBHOOK_AUTH. No body signature, so this route uses the normal
 * JSON parser (mounted after express.json in server.js).
 *
 * app_user_id is the ID we pass to Purchases.logIn() on the client — the
 * KashBook user id. Anonymous RevenueCat ids ($RCAnonymousID:…) are ignored.
 *
 * Event reference: https://www.revenuecat.com/docs/webhooks/event-types-and-fields
 */
const router = require("express").Router();
const crypto = require("crypto");
const prisma = require("../utils/db");
const { audit } = require("../utils/audit");
const { pushTo } = require("../utils/pushNotification");

// Events that mean "the customer has active paid access right now".
const GRANT = new Set([
  "INITIAL_PURCHASE",
  "RENEWAL",
  "UNCANCELLATION",
  "NON_RENEWING_PURCHASE",
  "PRODUCT_CHANGE",
  "SUBSCRIPTION_EXTENDED",
]);
// Access has actually ended. CANCELLATION and BILLING_ISSUE are NOT here —
// the user keeps access until the period expires / grace period ends.
const REVOKE = new Set(["EXPIRATION"]);

router.post("/", async (req, res) => {
  // 1. Authenticate
  const expected = process.env.REVENUECAT_WEBHOOK_AUTH;
  if (!expected) {
    console.warn("[RevenueCat webhook] REVENUECAT_WEBHOOK_AUTH not set — rejecting");
    return res.sendStatus(401);
  }
  const provided = Buffer.from(req.headers.authorization || "");
  const expectedBuf = Buffer.from(expected);
  if (provided.length !== expectedBuf.length || !crypto.timingSafeEqual(provided, expectedBuf)) {
    console.warn("[RevenueCat webhook] auth mismatch — rejecting");
    return res.sendStatus(401);
  }

  const event = req.body?.event;
  if (!event) return res.sendStatus(400);

  // Ack fast so RevenueCat doesn't retry while we work.
  res.sendStatus(200);

  try {
    const type = event.type;
    if (type === "TEST") {
      console.log("[RevenueCat webhook] TEST event received — auth OK");
      return;
    }

    const appUserId = event.app_user_id || "";
    // Collect every id RevenueCat associates with this customer, skip anon ids.
    const candidateIds = [appUserId, event.original_app_user_id, ...(event.aliases || [])]
      .filter((id) => id && !id.startsWith("$RCAnonymousID:"));
    if (candidateIds.length === 0) {
      console.warn(`[RevenueCat webhook] ${type} for anonymous user — skipped`);
      return;
    }

    const user = await prisma.user.findFirst({
      where: { id: { in: candidateIds } },
      select: { id: true, plan: true, expoPushToken: true, notificationsEnabled: true },
    });
    if (!user) {
      console.warn(`[RevenueCat webhook] ${type} — no user for ${candidateIds.join(",")}`);
      return;
    }

    const targetPlan = GRANT.has(type) ? "PREMIUM" : REVOKE.has(type) ? "FREE" : null;
    if (!targetPlan) {
      console.log(`[RevenueCat webhook] ${type} — no plan change`);
      return;
    }
    if (user.plan === targetPlan) {
      console.log(`[RevenueCat webhook] ${type} — ${user.id} already ${targetPlan}`);
      return;
    }

    await prisma.user.update({ where: { id: user.id }, data: { plan: targetPlan } });
    await audit({
      action: targetPlan === "PREMIUM" ? "SUBSCRIPTION_GRANTED" : "SUBSCRIPTION_EXPIRED",
      resourceType: "user",
      resourceId: user.id,
      severity: "info",
      actorOverride: { type: "system", id: "revenuecat" },
      metadata: { eventType: type, productId: event.product_id || null },
    }).catch(() => {});

    if (targetPlan === "PREMIUM") {
      await pushTo(
        user.id,
        "Welcome to KashBook Pro 🎉",
        "Your subscription is active — all premium features are unlocked.",
      ).catch(() => {});
    }
    console.log(`[RevenueCat webhook] ${type} → ${user.id} set to ${targetPlan}`);
  } catch (err) {
    console.error("[RevenueCat webhook] processing error:", err.message);
  }
});

module.exports = router;
