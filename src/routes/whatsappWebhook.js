/**
 * WhatsApp Business (Cloud API) webhook.
 *
 * Mounted with `express.raw` BEFORE `express.json` in server.js so the
 * X-Hub-Signature-256 HMAC (keyed on META_APP_SECRET — the FB app secret)
 * verifies against the exact bytes Meta sent.
 *
 *   GET  /webhooks/whatsapp  → subscription handshake (echo hub.challenge)
 *   POST /webhooks/whatsapp  → inbound events (object:"whatsapp_business_account")
 *
 * Routing: changes[].value.metadata.phone_number_id → Business.waPhoneNumberId.
 * Dedup: ProcessedWebhook fast-path + WaMessage.waMessageId @unique as the TRUE
 * idempotency gate (a re-delivery never double-pings). Delivery/read `statuses`
 * events are ignored in v1. See docs/WHATSAPP_API_SPEC.md.
 */
const router = require("express").Router();
const prisma = require("../utils/db");
const wa = require("../utils/whatsappCloud");
const { pushTo } = require("../utils/pushNotification");

router.get("/", (req, res) => {
  const challenge = wa.verifyHandshake(req.query);
  if (challenge === null) return res.sendStatus(403);
  return res.status(200).type("text/plain").send(challenge);
});

router.post("/", async (req, res) => {
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}));

  if (!wa.verifyWebhookSignature(rawBody, req.headers)) {
    console.warn("[WA webhook] signature mismatch — rejecting");
    return res.sendStatus(403);
  }

  let event;
  try { event = JSON.parse(rawBody.toString("utf8")); } catch { return res.sendStatus(400); }

  // Ack fast (<5s) so Meta doesn't retry while we work.
  res.sendStatus(200);

  try {
    if (event.object !== "whatsapp_business_account" || !Array.isArray(event.entry)) return;

    for (const entry of event.entry) {
      for (const ch of Array.isArray(entry.changes) ? entry.changes : []) {
        if (ch.field !== "messages") continue;
        const value = ch.value || {};
        const phoneNumberId = value.metadata?.phone_number_id != null ? String(value.metadata.phone_number_id) : null;
        const messages = Array.isArray(value.messages) ? value.messages : [];
        if (!phoneNumberId || messages.length === 0) continue; // statuses-only events land here

        const business = await prisma.business.findFirst({
          where: { waPhoneNumberId: phoneNumberId },
          select: { id: true, userId: true },
        });
        if (!business) {
          console.warn(`[WA webhook] no business for phone-number-id ${phoneNumberId} — skipping`);
          continue;
        }

        for (const m of messages) {
          const wamid = m.id;
          const senderPhone = m.from != null ? String(m.from) : null;
          if (!wamid || !senderPhone) continue;

          // Fast-path dedup (the WaMessage unique below is the true gate).
          try {
            await prisma.processedWebhook.create({ data: { eventId: `wa:msg:${wamid}`, type: "whatsapp.message" } });
          } catch (dupErr) {
            if (dupErr.code === "P2002") continue; // already processed
            console.error("[WA webhook] dedup insert error:", dupErr.message);
          }

          // Text per message type. Media download needs an authenticated fetch +
          // re-hosting (later batch) — show a readable placeholder meanwhile.
          let text = "";
          if (m.type === "text") text = m.text?.body || "";
          else if (m.type === "image") text = m.image?.caption || "📷 Photo";
          else if (m.type === "audio") text = "🎤 Voice note";
          else if (m.type === "video") text = m.video?.caption || "🎬 Video";
          else if (m.type === "document") text = `📎 ${m.document?.filename || "Document"}`;
          else if (m.type === "location") text = "📍 Location";
          else text = `📎 ${m.type || "Message"}`;

          // WhatsApp sends unix SECONDS (as a string); IG sends ms. Magnitude
          // guard handles both.
          const tsNum = Number(m.timestamp);
          const sentAt = Number.isFinite(tsNum) && tsNum > 0
            ? new Date(tsNum < 1e12 ? tsNum * 1000 : tsNum)
            : new Date();

          const profileName =
            (value.contacts || []).find((c) => String(c.wa_id) === senderPhone)?.profile?.name || null;

          let convo;
          let stored = false;
          await prisma.withBusinessLock(business.id, async () => {
            const existing = await prisma.waConversation.findUnique({
              where: { businessId_participantPhone: { businessId: business.id, participantPhone: senderPhone } },
            });
            convo = existing || await prisma.waConversation.create({
              data: {
                businessId: business.id,
                participantPhone: senderPhone,
                participantName: profileName,
                lastMessageAt: sentAt,
                lastInboundAt: sentAt,
                unread: true,
              },
            });
            try {
              await prisma.waMessage.create({
                data: { conversationId: convo.id, waMessageId: wamid, direction: "in", text, sentAt },
              });
              stored = true;
            } catch (e) {
              if (e.code === "P2002") return; // re-delivery — leave stored=false
              throw e;
            }
            if (existing) {
              convo = await prisma.waConversation.update({
                where: { id: existing.id },
                data: {
                  lastMessageAt: sentAt,
                  lastInboundAt: sentAt,
                  unread: true,
                  ...(profileName && !existing.participantName ? { participantName: profileName } : {}),
                },
              });
            }
          });
          if (!stored) continue; // duplicate delivery — no double push

          const who = convo?.participantName || `+${senderPhone}`;
          const preview = (text || "sent you a message").slice(0, 140);
          await pushTo(business.userId, "📩 New WhatsApp message", `${who}: ${preview}`).catch(() => {});
        }
      }
    }
  } catch (err) {
    console.error("[WA webhook] processing error:", err.message);
  }
});

module.exports = router;
