/**
 * Instagram auto payment confirmation.
 *
 * When a merchant sends a "Request ₦X" in an IG thread (POST send-payment with an
 * amount), that conversation stores expectedAmount + expectedSince. This matcher
 * runs whenever an inbound NUBAN credit is recorded (Anchor webhook + reconcile):
 * if EXACTLY ONE conversation for that business is awaiting that exact amount
 * within the last 48h, we auto-reply "payment received" in the DM, clear the
 * flag, stamp lastPaymentConfirmedAt, and notify the merchant.
 *
 * Mirrors tryMatchInvoice() in anchorReconcile.js. Safe to call more than once
 * per credit — the first match consumes the flag, so a repeat call finds nothing.
 */
const prisma = require("./db");
const ig = require("./instagram");
const { decrypt } = require("./crypto");
const { pushTo } = require("./pushNotification");

const WINDOW_MS = 48 * 60 * 60 * 1000; // how long an armed "Request ₦X" stays matchable

async function tryMatchIgPayment(biz, amount) {
  if (!biz?.id || !ig.isConfigured()) return;
  const amt = Number(amount);
  if (!(amt > 0)) return;

  const since = new Date(Date.now() - WINDOW_MS);
  const candidates = await prisma.igConversation.findMany({
    where: { businessId: biz.id, expectedAmount: { not: null }, expectedSince: { gte: since } },
    select: {
      id: true, participantIgId: true, participantUsername: true,
      expectedAmount: true, lastInboundAt: true,
    },
  });
  const matches = candidates.filter((c) => Math.abs((c.expectedAmount || 0) - amt) < 0.01);
  if (matches.length !== 1) return; // 0 = no match; >1 = ambiguous → let the merchant confirm
  const convo = matches[0];

  const business = await prisma.business.findUnique({
    where: { id: biz.id },
    select: {
      userId: true, baseCurrency: true,
      instagramAccessToken: true, instagramBusinessAccountId: true,
      igConnectionStatus: true, igTokenExpiresAt: true,
    },
  });
  const tokenLive =
    business?.instagramAccessToken &&
    business.igConnectionStatus === "connected" &&
    (!business.igTokenExpiresAt || new Date(business.igTokenExpiresAt) > new Date());

  const amtLabel = ig.formatAmount(amt, business?.baseCurrency);
  const who = convo.participantUsername ? `@${convo.participantUsername}` : "your Instagram customer";

  // Best-effort auto-reply, inside Meta's 24h / 7d messaging window.
  let dmSent = false;
  if (tokenLive) {
    const hoursSince = convo.lastInboundAt
      ? (Date.now() - new Date(convo.lastInboundAt).getTime()) / 3_600_000
      : Infinity;
    if (hoursSince <= 24 * 7) {
      try {
        const token = decrypt(business.instagramAccessToken);
        const text = `✅ We've received your payment of ${amtLabel}. Thank you! 🎉`;
        const res = await ig.sendMessage(
          token, business.instagramBusinessAccountId, convo.participantIgId, text,
          { humanAgent: hoursSince > 24 },
        );
        await prisma.igMessage.create({
          data: {
            conversationId: convo.id,
            igMessageId: res.messageId || `out_pay_${Date.now()}_${convo.id}`,
            direction: "out",
            text,
          },
        }).catch(() => {});
        dmSent = true;
      } catch (e) {
        console.warn(`[ig-pay] auto-reply failed for business ${biz.id}: ${e.message}`);
      }
    }
  }

  // Consume the armed flag regardless (the payment DID arrive) and stamp it.
  await prisma.igConversation.update({
    where: { id: convo.id },
    data: {
      expectedAmount: null,
      expectedSince: null,
      lastPaymentConfirmedAt: new Date(),
      ...(dmSent ? { lastMessageAt: new Date() } : {}),
    },
  });

  await pushTo(
    business.userId,
    dmSent ? "✅ Instagram payment confirmed" : "✅ Payment received (Instagram)",
    dmSent
      ? `Auto-replied to ${who} — ${amtLabel} received.`
      : `${amtLabel} matched ${who}'s request. Open the chat to reply.`,
  ).catch(() => {});
}

module.exports = { tryMatchIgPayment };
