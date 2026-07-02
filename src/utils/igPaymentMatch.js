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
 * CONCURRENCY: the webhook AND the 5-min reconcile can both fire for the same
 * credit. We CLAIM (read + null the flag) atomically inside withBusinessLock so a
 * second caller finds nothing — no duplicate DMs. The slow Graph send happens
 * OUTSIDE the lock so we never hold a business's money-out lock across an
 * external HTTP call. Mirrors tryMatchInvoice() in anchorReconcile.js.
 */
const crypto = require("crypto");
const prisma = require("./db");
const ig = require("./instagram");
const { decrypt } = require("./crypto");
const { pushTo } = require("./pushNotification");

const WINDOW_MS = 48 * 60 * 60 * 1000; // how long an armed "Request ₦X" stays matchable

// Exact-to-the-kobo comparison — robust against IEEE-754 float representation
// (e.g. 500001 kobo / 100 = 5000.01, where `Math.abs(x - 5000) < 0.01` fails).
function sameMoney(a, b) {
  return Math.round((Number(a) || 0) * 100) === Math.round((Number(b) || 0) * 100);
}

async function tryMatchIgPayment(biz, amount) {
  if (!biz?.id || !ig.isConfigured()) return;
  const amt = Number(amount);
  if (!(amt > 0)) return;
  const since = new Date(Date.now() - WINDOW_MS);

  // ── Atomically CLAIM one armed conversation (inside the per-business lock) ──
  // Consuming the flag here is what makes double-firing safe: a concurrent caller
  // acquires the lock afterwards, re-queries, and finds nothing to match.
  const convo = await prisma.withBusinessLock(biz.id, async () => {
    const candidates = await prisma.igConversation.findMany({
      where: { businessId: biz.id, expectedAmount: { not: null }, expectedSince: { gte: since } },
      select: { id: true, participantIgId: true, participantUsername: true, expectedAmount: true, lastInboundAt: true },
    });
    const matches = candidates.filter((c) => sameMoney(c.expectedAmount, amt));
    if (matches.length !== 1) return null; // 0 = no match; >1 = ambiguous → merchant confirms
    const m = matches[0];
    await prisma.igConversation.update({
      where: { id: m.id },
      data: { expectedAmount: null, expectedSince: null, lastPaymentConfirmedAt: new Date() },
    });
    return m;
  });
  if (!convo) return;

  // ── Slow work, OUTSIDE the lock ────────────────────────────────────────────
  const business = await prisma.business.findUnique({
    where: { id: biz.id },
    select: {
      userId: true, baseCurrency: true,
      instagramAccessToken: true, instagramBusinessAccountId: true,
      igConnectionStatus: true, igTokenExpiresAt: true,
    },
  });
  if (!business) return; // business vanished (deleted) — the flag is already consumed

  const tokenLive =
    business.instagramAccessToken &&
    business.igConnectionStatus === "connected" &&
    (!business.igTokenExpiresAt || new Date(business.igTokenExpiresAt) > new Date());

  const amtLabel = ig.formatAmount(amt, business.baseCurrency);
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
            igMessageId: res.messageId || `out_pay_${crypto.randomUUID()}`,
            direction: "out",
            text,
          },
        }).catch(() => {});
        await prisma.igConversation.update({
          where: { id: convo.id }, data: { lastMessageAt: new Date() },
        }).catch(() => {});
        dmSent = true;
      } catch (e) {
        console.warn(`[ig-pay] auto-reply failed for business ${biz.id}: ${e.message}`);
      }
    }
  }

  await pushTo(
    business.userId,
    dmSent ? "✅ Instagram payment confirmed" : "✅ Payment received (Instagram)",
    dmSent
      ? `Auto-replied to ${who} — ${amtLabel} received.`
      : `${amtLabel} matched ${who}'s request. Open the chat to reply.`,
  ).catch(() => {});
}

module.exports = { tryMatchIgPayment };
