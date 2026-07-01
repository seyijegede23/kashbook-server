/**
 * Instagram messaging webhook (Path A — graph.instagram.com).
 *
 * Mounted with `express.raw` BEFORE `express.json` in server.js so the
 * X-Hub-Signature-256 HMAC verifies against the exact bytes Meta sent.
 *
 *   GET  /webhooks/instagram  → subscription handshake (echo hub.challenge)
 *   POST /webhooks/instagram  → inbound DM events (object:"instagram", messaging[])
 *
 * Routing: entry[].id = the merchant's IG account id → the Business that stored
 * it (instagramBusinessAccountId). Dedup by message.mid (ProcessedWebhook).
 * Echoes of our own sends (is_echo) are filtered. See docs/INSTAGRAM_API_SPEC.md.
 */
const router = require("express").Router();
const prisma = require("../utils/db");
const ig = require("../utils/instagram");
const { pushTo } = require("../utils/pushNotification");

// ── GET: verification handshake ──────────────────────────────────────────────
router.get("/", (req, res) => {
  const challenge = ig.verifyHandshake(req.query);
  if (challenge === null) return res.sendStatus(403);
  return res.status(200).type("text/plain").send(challenge);
});

// ── POST: inbound events ─────────────────────────────────────────────────────
router.post("/", async (req, res) => {
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}));

  if (!ig.verifyWebhookSignature(rawBody, req.headers)) {
    console.warn("[IG webhook] signature mismatch — rejecting");
    return res.sendStatus(403);
  }

  let event;
  try { event = JSON.parse(rawBody.toString("utf8")); } catch { return res.sendStatus(400); }

  // Ack fast (<5s) so Meta doesn't retry while we work.
  res.sendStatus(200);

  try {
    if (event.object !== "instagram" || !Array.isArray(event.entry)) return;

    for (const entry of event.entry) {
      const merchantIgId = entry.id != null ? String(entry.id) : null;
      const items = Array.isArray(entry.messaging) ? entry.messaging : [];
      if (!merchantIgId || items.length === 0) continue;

      // Route to the business that connected this IG account.
      const business = await prisma.business.findFirst({
        where: { instagramBusinessAccountId: merchantIgId },
        select: { id: true, userId: true },
      });
      if (!business) {
        console.warn(`[IG webhook] no business for IG id ${merchantIgId} — skipping`);
        continue;
      }

      for (const m of items) {
        const msg = m.message;
        if (!msg) continue;                 // read/reaction/etc — not a message we cache
        if (msg.is_echo) continue;          // our own outbound, echoed back
        const mid = msg.mid;
        const senderIgsid = m.sender?.id != null ? String(m.sender.id) : null;
        if (!mid || !senderIgsid) continue;
        if (senderIgsid === merchantIgId) continue; // safety: not from ourselves

        // Idempotency: process each message id at most once.
        try {
          await prisma.processedWebhook.create({ data: { eventId: `ig:msg:${mid}`, type: "instagram.message" } });
        } catch (dupErr) {
          if (dupErr.code === "P2002") continue; // already processed
          console.error("[IG webhook] dedup insert error:", dupErr.message);
        }

        const text = msg.text || (Array.isArray(msg.attachments) && msg.attachments.length ? "📎 Attachment" : "");
        // Meta's IG messaging webhook sends `timestamp` in MILLISECONDS (the
        // documented example is 13 digits). Guard by magnitude so a 10-digit
        // seconds value (if Meta ever sends one) is still parsed correctly.
        const tsNum = typeof m.timestamp === "number" ? m.timestamp : null;
        const sentAt = tsNum ? new Date(tsNum < 1e12 ? tsNum * 1000 : tsNum) : new Date();

        // Serialize per-business so concurrent events for the same conversation
        // don't race the upsert.
        let convo;
        await prisma.withBusinessLock(business.id, async () => {
          convo = await prisma.igConversation.upsert({
            where: { businessId_participantIgId: { businessId: business.id, participantIgId: senderIgsid } },
            create: {
              businessId: business.id,
              participantIgId: senderIgsid,
              lastMessageAt: sentAt,
              lastInboundAt: sentAt,
              unread: true,
            },
            update: { lastMessageAt: sentAt, lastInboundAt: sentAt, unread: true },
          });
          await prisma.igMessage.create({
            data: { conversationId: convo.id, igMessageId: mid, direction: "in", text, sentAt },
          }).catch((e) => {
            if (e.code !== "P2002") throw e; // unique mid backstop — ignore re-delivery
          });
        });

        // Notify the business owner (in-app row + Expo push, respecting their
        // notification toggle). Only new messages reach here — duplicates were
        // dropped by the ProcessedWebhook dedup above, so no double-pings.
        const who = convo?.participantUsername ? `@${convo.participantUsername}` : "an Instagram customer";
        const preview = (text || "sent you a message").slice(0, 140);
        await pushTo(business.userId, "📩 New Instagram message", `${who}: ${preview}`).catch(() => {});
      }
    }
  } catch (err) {
    console.error("[IG webhook] processing error:", err.message);
  }
});

module.exports = router;
