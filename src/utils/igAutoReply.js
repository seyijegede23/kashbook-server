/**
 * Instagram auto-replies.
 *  - Inbound DM: greeting (first contact) > keyword > away-hours. One reply per
 *    message, rate-capped, within Meta's 24h window (customer just messaged).
 *  - Comment: DM the commenter (private reply via recipient.comment_id) when a
 *    "comment" rule matches (keyword optional — null matches any comment).
 * Best-effort; never throws into the webhook.
 */
const crypto = require("crypto");
const prisma = require("./db");
const ig = require("./instagram");
const { decrypt } = require("./crypto");

function tokenLive(business) {
  return (
    business?.instagramAccessToken &&
    business.igConnectionStatus === "connected" &&
    (!business.igTokenExpiresAt || new Date(business.igTokenExpiresAt) > new Date())
  );
}

// Current hour (0-23) in Africa/Lagos (WAT, no DST) — matches the app's crons.
function lagosHour() {
  return Number(
    new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Lagos", hour: "2-digit", hourCycle: "h23" }).format(new Date()),
  );
}
function inAwayWindow(h, from, to) {
  if (from == null || to == null) return true; // no window set → treat as always-away
  if (from === to) return h === from;          // degenerate = that single hour
  return from < to ? (h >= from && h < to) : (h >= from || h < to); // handles overnight windows
}

async function handleInbound({ business, convo, text, isFirstInbound }) {
  if (!ig.isConfigured() || !business || !convo || !tokenLive(business)) return;

  const rules = await prisma.igAutoReply.findMany({ where: { businessId: business.id, enabled: true } });
  if (rules.length === 0) return;

  let replyText = null;
  if (isFirstInbound) {
    const greeting = rules.find((r) => r.kind === "greeting");
    if (greeting) replyText = greeting.text;
  }
  if (!replyText && text) {
    const lower = text.toLowerCase();
    const kw = rules.find((r) => r.kind === "keyword" && r.keyword && lower.includes(r.keyword.toLowerCase()));
    if (kw) replyText = kw.text;
  }
  if (!replyText) {
    const away = rules.find((r) => r.kind === "away");
    if (away && inAwayWindow(lagosHour(), away.fromHour, away.toHour)) replyText = away.text;
  }
  if (!replyText) return;

  // Rate cap: never fire more than a few auto-replies to one conversation in a
  // short window (guards against a spammy customer / rapid messages).
  const recentOut = await prisma.igMessage.count({
    where: { conversationId: convo.id, direction: "out", sentAt: { gte: new Date(Date.now() - 60_000) } },
  });
  if (recentOut >= 3) return;

  try {
    const token = decrypt(business.instagramAccessToken);
    const res = await ig.sendMessage(
      token, business.instagramBusinessAccountId, convo.participantIgId, replyText, {},
    );
    await prisma.igMessage.create({
      data: {
        conversationId: convo.id,
        igMessageId: res.messageId || `out_auto_${crypto.randomUUID()}`,
        direction: "out",
        text: replyText,
      },
    }).catch(() => {});
    await prisma.igConversation.update({
      where: { id: convo.id }, data: { lastMessageAt: new Date() },
    }).catch(() => {});
  } catch (e) {
    console.warn(`[ig-autoreply] send failed for business ${business.id}: ${e.message}`);
  }
}

// Comment → private-reply DM. Dedup is handled by the webhook (ProcessedWebhook).
async function handleComment({ business, commentId, text, fromId }) {
  if (!ig.isConfigured() || !business || !commentId || !tokenLive(business)) return;
  // Never reply to our own comment.
  if (fromId && business.instagramBusinessAccountId && String(fromId) === String(business.instagramBusinessAccountId)) return;

  const rules = await prisma.igAutoReply.findMany({
    where: { businessId: business.id, enabled: true, kind: "comment" },
  });
  if (rules.length === 0) return;

  const lower = (text || "").toLowerCase();
  const rule = rules.find((r) => !r.keyword || lower.includes(r.keyword.toLowerCase()));
  if (!rule) return;

  try {
    const token = decrypt(business.instagramAccessToken);
    await ig.sendPrivateReply(token, business.instagramBusinessAccountId, commentId, rule.text);
  } catch (e) {
    console.warn(`[ig-comment] private reply failed for business ${business.id}: ${e.message}`);
  }
}

module.exports = { handleInbound, handleComment };
