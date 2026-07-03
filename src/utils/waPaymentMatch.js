/**
 * WhatsApp auto payment confirmation — mirror of igPaymentMatch.js with all of
 * its review fixes (atomic claim inside withBusinessLock, kobo-integer amount
 * compare, collision-resistant fallback ids, null-safe business fetch).
 *
 * A "Request ₦X" sent in a WhatsApp thread arms WaConversation.expectedAmount;
 * when a matching inbound NUBAN credit lands (webhook or reconcile), we CLAIM
 * exactly one armed conversation atomically, auto-reply "payment received"
 * inside the 24h window, and notify the merchant. Safe to call from multiple
 * credit sites — the claim consumes the flag.
 */
const crypto = require("crypto");
const prisma = require("./db");
const wa = require("./whatsappCloud");
const { formatAmount } = require("./instagram"); // channel-agnostic money label
const { decrypt } = require("./crypto");
const { pushTo } = require("./pushNotification");

const WINDOW_MS = 48 * 60 * 60 * 1000;

function sameMoney(a, b) {
  return Math.round((Number(a) || 0) * 100) === Math.round((Number(b) || 0) * 100);
}

async function tryMatchWaPayment(biz, amount) {
  if (!biz?.id || !wa.isConfigured()) return;
  const amt = Number(amount);
  if (!(amt > 0)) return;
  const since = new Date(Date.now() - WINDOW_MS);

  // Atomically CLAIM one armed conversation (consume the flag inside the lock).
  const convo = await prisma.withBusinessLock(biz.id, async () => {
    const candidates = await prisma.waConversation.findMany({
      where: { businessId: biz.id, expectedAmount: { not: null }, expectedSince: { gte: since } },
      select: { id: true, participantPhone: true, participantName: true, expectedAmount: true, lastInboundAt: true },
    });
    const matches = candidates.filter((c) => sameMoney(c.expectedAmount, amt));
    if (matches.length !== 1) return null; // 0 = none; >1 = ambiguous → merchant confirms
    const m = matches[0];
    await prisma.waConversation.update({
      where: { id: m.id },
      data: { expectedAmount: null, expectedSince: null, lastPaymentConfirmedAt: new Date() },
    });
    return m;
  });
  if (!convo) return;

  // Slow work OUTSIDE the lock.
  const business = await prisma.business.findUnique({
    where: { id: biz.id },
    select: {
      userId: true, baseCurrency: true,
      waAccessToken: true, waPhoneNumberId: true, waConnectionStatus: true,
    },
  });
  if (!business) return;

  const tokenLive = business.waAccessToken && business.waConnectionStatus === "connected";
  const amtLabel = formatAmount(amt, business.baseCurrency);
  const who = convo.participantName || (convo.participantPhone ? `+${convo.participantPhone}` : "your WhatsApp customer");

  // Best-effort auto-reply inside the 24h free-form window.
  let dmSent = false;
  if (tokenLive) {
    const hoursSince = convo.lastInboundAt
      ? (Date.now() - new Date(convo.lastInboundAt).getTime()) / 3_600_000
      : Infinity;
    if (hoursSince <= 24) {
      try {
        const token = decrypt(business.waAccessToken);
        const text = `✅ We've received your payment of ${amtLabel}. Thank you! 🎉`;
        const r = await wa.sendText(token, business.waPhoneNumberId, convo.participantPhone, text);
        await prisma.waMessage.create({
          data: {
            conversationId: convo.id,
            waMessageId: r.messageId || `out_pay_${crypto.randomUUID()}`,
            direction: "out",
            text,
          },
        }).catch(() => {});
        await prisma.waConversation.update({
          where: { id: convo.id }, data: { lastMessageAt: new Date() },
        }).catch(() => {});
        dmSent = true;
      } catch (e) {
        console.warn(`[wa-pay] auto-reply failed for business ${biz.id}: ${e.message}`);
      }
    }
  }

  await pushTo(
    business.userId,
    dmSent ? "✅ WhatsApp payment confirmed" : "✅ Payment received (WhatsApp)",
    dmSent
      ? `Auto-replied to ${who} — ${amtLabel} received.`
      : `${amtLabel} matched ${who}'s request. Open the chat to reply.`,
  ).catch(() => {});
}

module.exports = { tryMatchWaPayment };
