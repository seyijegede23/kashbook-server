/**
 * Instagram DM integration — authenticated API + OAuth callback.
 *
 * Mounted at /instagram (see server.js). The OAuth CALLBACK is PUBLIC — it's hit
 * by the merchant's browser redirect from Instagram and carries no JWT, so it is
 * authenticated by the signed `state` (HMAC over { businessId, userId }) instead.
 * Everything else requires auth.
 *
 * Path A — Instagram Login (graph.instagram.com). See docs/INSTAGRAM_API_SPEC.md.
 */
const router = require("express").Router();
const auth = require("../middleware/auth");
const prisma = require("../utils/db");
const ig = require("../utils/instagram");
const { encrypt, decrypt } = require("../utils/crypto");
const { audit } = require("../utils/audit");

// ── Helpers ──────────────────────────────────────────────────────────────────

// The owner whose businesses we scope to (staff act on their employer's).
function ownerId(req) {
  return req.user.accountType === "staff" ? req.user.employerId : req.user.id;
}

async function resolveBusiness(req, businessId) {
  if (!businessId) return null;
  return prisma.business.findFirst({ where: { id: businessId, userId: ownerId(req) } });
}

// Decrypt the live token, or throw a 409 "reconnect" error if missing/expired.
function liveToken(business) {
  if (!business?.instagramAccessToken) {
    const e = new Error("Instagram is not connected for this business.");
    e.statusCode = 409; e.reconnect = true; throw e;
  }
  if (business.igTokenExpiresAt && new Date(business.igTokenExpiresAt) <= new Date()) {
    const e = new Error("Your Instagram connection has expired — please reconnect.");
    e.statusCode = 409; e.reconnect = true; throw e;
  }
  return decrypt(business.instagramAccessToken);
}

// Map a thrown error to an HTTP response.
function fail(res, err, fallback = "Something went wrong with Instagram.") {
  const status = err.statusCode || (err.status && err.status >= 400 && err.status < 500 ? 400 : 502);
  const payload = { error: err.message || fallback };
  if (err.reconnect) payload.reconnect = true;
  return res.status(status).json(payload);
}

// Parse a Meta time value (unix seconds/ms, numeric string, or ISO) to a Date or
// null. Used only to seed lastMessageAt on first sync — precision isn't critical.
function parseMetaTime(v) {
  if (v == null) return null;
  if (typeof v === "number") return new Date(v < 1e12 ? v * 1000 : v);
  const s = String(v).trim();
  if (/^\d+$/.test(s)) { const n = Number(s); return new Date(n < 1e12 ? n * 1000 : n); }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

// Minimal HTML page for the OAuth callback (rendered inside the mobile WebView).
function resultHtml({ ok, message }) {
  const color = ok ? "#16A34A" : "#DC2626";
  const title = ok ? "Instagram connected" : "Connection failed";
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title></head>
<body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#F4F6F9;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center">
<div style="background:#fff;border:1px solid #E8ECF0;border-radius:16px;padding:28px 24px;max-width:340px;text-align:center">
<div style="font-size:40px;margin-bottom:8px">${ok ? "✅" : "⚠️"}</div>
<h2 style="color:${color};margin:0 0 8px">${title}</h2>
<p style="color:#475569;font-size:15px;margin:0">${message}</p>
<p style="color:#94A3B8;font-size:13px;margin-top:16px">You can close this window and return to KashBook.</p>
</div></body></html>`;
}

// ── PUBLIC: OAuth callback (no auth — verified via signed state) ──────────────
// Instagram redirects the merchant's browser here with ?code=&state= (or ?error=).
router.get("/callback", async (req, res) => {
  res.type("html");

  if (req.query.error) {
    return res.status(200).send(resultHtml({
      ok: false,
      message: "You cancelled the Instagram connection. No changes were made.",
    }));
  }

  const state = ig.verifyState(req.query.state);
  if (!state) {
    return res.status(400).send(resultHtml({ ok: false, message: "This link has expired. Please start again from KashBook." }));
  }
  // Strip the trailing "#_" Instagram sometimes appends to the auth code.
  const code = String(req.query.code || "").replace(/#_$/, "").trim();
  if (!code) {
    return res.status(400).send(resultHtml({ ok: false, message: "Missing authorization code." }));
  }

  try {
    const business = await prisma.business.findFirst({
      where: { id: state.businessId, userId: state.userId },
    });
    if (!business) {
      return res.status(404).send(resultHtml({ ok: false, message: "Business not found." }));
    }

    // code -> short-lived -> long-lived -> account info.
    const short = await ig.exchangeCodeForToken(code);
    if (!short.accessToken) throw new Error("Instagram did not return an access token.");
    const long = await ig.getLongLivedToken(short.accessToken);
    if (!long.accessToken) throw new Error("Could not obtain a long-lived token.");
    const account = await ig.getAccountInfo(long.accessToken);
    const igId = account.userId || short.userId;
    if (!igId) throw new Error("Could not read your Instagram account id.");

    // One IG account ↔ one business (webhook routing is by this id).
    const claimed = await prisma.business.findFirst({
      where: { instagramBusinessAccountId: igId, NOT: { id: business.id } },
      select: { id: true },
    });
    if (claimed) {
      return res.status(409).send(resultHtml({
        ok: false,
        message: "This Instagram account is already connected to another KashBook business.",
      }));
    }

    // Subscribe this account to the `messages` webhook — retry, since a transient
    // failure here means inbound DMs silently never arrive (#1 silent-failure
    // point). We persist the outcome (igWebhookSubscribed) so the app can warn +
    // offer a reconnect when a connection has no working inbound feed.
    let subscribed = false;
    for (let attempt = 1; attempt <= 2 && !subscribed; attempt++) {
      try { subscribed = await ig.subscribeWebhooks(long.accessToken); }
      catch (e) { console.error(`[instagram/callback] subscribe attempt ${attempt} failed:`, e.message); }
    }

    const expiresAt = new Date(Date.now() + (long.expiresIn || ig.SIXTY_DAYS_SEC) * 1000);
    try {
      await prisma.business.update({
        where: { id: business.id },
        data: {
          instagramAccessToken: encrypt(long.accessToken),
          instagramBusinessAccountId: igId,
          instagramUsername: account.username || null,
          igTokenExpiresAt: expiresAt,
          igConnectionStatus: "connected",
          igWebhookSubscribed: subscribed,
        },
      });
    } catch (e) {
      // Unique-constraint backstop for the claim race: another business grabbed
      // this IG id between our check and write.
      if (e.code === "P2002") {
        return res.status(409).send(resultHtml({
          ok: false,
          message: "This Instagram account is already connected to another KashBook business.",
        }));
      }
      throw e;
    }

    await audit({
      action: "INSTAGRAM_CONNECTED", resourceType: "business", resourceId: business.id,
      actorOverride: { type: "user", id: state.userId }, severity: "info",
      metadata: { igId, username: account.username, subscribed },
    });

    return res.status(200).send(resultHtml({
      ok: true,
      message: account.username
        ? `@${account.username} is now linked to ${business.name}.`
        : `Instagram is now linked to ${business.name}.`,
    }));
  } catch (err) {
    console.error("[instagram/callback]", err.message);
    return res.status(200).send(resultHtml({
      ok: false,
      message: "We couldn't complete the Instagram connection. Please try again.",
    }));
  }
});

// ── Everything below requires auth ───────────────────────────────────────────
router.use(auth);

// GET /instagram/connect-url?businessId= → { url }
router.get("/connect-url", async (req, res) => {
  try {
    if (!ig.isConfigured()) {
      return res.status(503).json({ error: "Instagram connect isn't available yet." });
    }
    if (req.user.accountType === "staff") {
      return res.status(403).json({ error: "Only the business owner can connect Instagram." });
    }
    const business = await resolveBusiness(req, req.query.businessId);
    if (!business) return res.status(404).json({ error: "Business not found." });

    const state = ig.signState({ businessId: business.id, userId: req.user.id });
    return res.json({ url: ig.buildConnectUrl(state) });
  } catch (err) { return fail(res, err); }
});

// GET /instagram/status?businessId= → connection status (never returns the token)
router.get("/status", async (req, res) => {
  try {
    const business = await resolveBusiness(req, req.query.businessId);
    if (!business) return res.status(404).json({ error: "Business not found." });
    const expired = business.igTokenExpiresAt && new Date(business.igTokenExpiresAt) <= new Date();
    return res.json({
      connected: business.igConnectionStatus === "connected" && !expired,
      status: expired ? "expired" : (business.igConnectionStatus || "disconnected"),
      username: business.instagramUsername || null,
      expiresAt: business.igTokenExpiresAt || null,
      // false → OAuth ok but the messages webhook isn't subscribed, so inbound
      // DMs won't arrive. The app prompts a reconnect to fix it.
      subscribed: !!business.igWebhookSubscribed,
    });
  } catch (err) { return fail(res, err); }
});

// POST /instagram/disconnect { businessId }
router.post("/disconnect", async (req, res) => {
  try {
    if (req.user.accountType === "staff") {
      return res.status(403).json({ error: "Only the business owner can disconnect Instagram." });
    }
    const business = await resolveBusiness(req, req.body.businessId);
    if (!business) return res.status(404).json({ error: "Business not found." });
    await prisma.business.update({
      where: { id: business.id },
      data: {
        instagramAccessToken: null,
        instagramBusinessAccountId: null,
        instagramUsername: null,
        igTokenExpiresAt: null,
        igConnectionStatus: "disconnected",
        igWebhookSubscribed: false,
      },
    });
    await audit({
      req, action: "INSTAGRAM_DISCONNECTED", resourceType: "business", resourceId: business.id,
      severity: "info",
    });
    return res.json({ ok: true });
  } catch (err) { return fail(res, err); }
});

// GET /instagram/conversations?businessId= → cached inbox (newest first)
router.get("/conversations", async (req, res) => {
  try {
    const business = await resolveBusiness(req, req.query.businessId);
    if (!business) return res.status(404).json({ error: "Business not found." });
    const rows = await prisma.igConversation.findMany({
      where: { businessId: business.id },
      orderBy: { lastMessageAt: "desc" },
      take: 100,
      include: { messages: { orderBy: { sentAt: "desc" }, take: 1 } },
    });
    return res.json({
      conversations: rows.map((c) => ({
        id: c.id,
        participantUsername: c.participantUsername,
        participantIgId: c.participantIgId,
        lastMessageAt: c.lastMessageAt,
        lastInboundAt: c.lastInboundAt,
        unread: c.unread,
        expectedAmount: c.expectedAmount,
        lastPaymentConfirmedAt: c.lastPaymentConfirmedAt,
        preview: c.messages[0]?.text?.slice(0, 120) || "",
      })),
    });
  } catch (err) { return fail(res, err); }
});

// POST /instagram/sync { businessId } → pull conversations from Meta + backfill
// participant usernames (the webhook only delivers IGSIDs, not handles) and seed
// threads that predate the connection. The local cache stays the inbox's source
// of truth; this only enriches it. The app calls it on inbox focus.
router.post("/sync", async (req, res) => {
  try {
    const business = await resolveBusiness(req, req.body.businessId);
    if (!business) return res.status(404).json({ error: "Business not found." });
    if (!ig.isConfigured()) return res.status(503).json({ error: "Instagram isn't available right now." });
    const token = liveToken(business);
    const myId = business.instagramBusinessAccountId;

    const convos = await ig.listConversations(token);
    let synced = 0;
    for (const c of convos) {
      // The "other" participant is the customer (skip our own account).
      const customer = (c.participants || []).find((p) => p.id && p.id !== myId);
      if (!customer) continue;
      const seededAt = parseMetaTime(c.updatedTime) || new Date();
      await prisma.igConversation.upsert({
        where: { businessId_participantIgId: { businessId: business.id, participantIgId: customer.id } },
        create: {
          businessId: business.id,
          participantIgId: customer.id,
          participantUsername: customer.username || null,
          igThreadId: c.id || null,
          lastMessageAt: seededAt,
        },
        // Only enrich username/threadId — never clobber webhook-owned
        // lastMessageAt / lastInboundAt / unread.
        update: {
          participantUsername: customer.username || undefined,
          igThreadId: c.id || undefined,
        },
      });
      synced++;
    }
    return res.json({ ok: true, synced });
  } catch (err) {
    console.error("[instagram/sync]", err.message);
    return fail(res, err, "Couldn't sync your Instagram conversations.");
  }
});

// GET /instagram/conversations/:id/messages → cached thread; marks read
router.get("/conversations/:id/messages", async (req, res) => {
  try {
    const convo = await prisma.igConversation.findUnique({ where: { id: req.params.id } });
    if (!convo) return res.status(404).json({ error: "Conversation not found." });
    const business = await resolveBusiness(req, convo.businessId);
    if (!business) return res.status(404).json({ error: "Conversation not found." });

    const messages = await prisma.igMessage.findMany({
      where: { conversationId: convo.id },
      orderBy: { sentAt: "asc" },
      take: 200,
    });
    if (convo.unread) {
      await prisma.igConversation.update({ where: { id: convo.id }, data: { unread: false } });
    }
    return res.json({
      conversation: {
        id: convo.id,
        participantUsername: convo.participantUsername,
        lastInboundAt: convo.lastInboundAt,
        expectedAmount: convo.expectedAmount,
        lastPaymentConfirmedAt: convo.lastPaymentConfirmedAt,
      },
      messages: messages.map((m) => ({
        id: m.id, direction: m.direction, text: m.text, sentAt: m.sentAt,
      })),
    });
  } catch (err) { return fail(res, err); }
});

// Shared send path for reply + send-payment. Window-gated (24h / 7d HUMAN_AGENT).
async function sendInConversation({ business, convo, text }) {
  if (!ig.isConfigured()) {
    const e = new Error("Instagram isn't available right now."); e.statusCode = 503; throw e;
  }
  const hoursSince = convo.lastInboundAt
    ? (Date.now() - new Date(convo.lastInboundAt).getTime()) / 3_600_000
    : Infinity;
  if (hoursSince > 24 * 7) {
    const e = new Error("It's been over 7 days since this customer messaged you — they need to message you again before you can reply.");
    e.statusCode = 422; throw e;
  }
  const token = liveToken(business);
  const result = await ig.sendMessage(
    token, business.instagramBusinessAccountId, convo.participantIgId, text,
    { humanAgent: hoursSince > 24 },
  );
  // Cache the outbound message + bump the thread.
  await prisma.igMessage.create({
    data: {
      conversationId: convo.id,
      igMessageId: result.messageId || `out_${Date.now()}_${Math.round(hoursSince)}`,
      direction: "out",
      text,
    },
  }).catch(() => {}); // a duplicate mid (retry) is harmless
  await prisma.igConversation.update({
    where: { id: convo.id },
    data: { lastMessageAt: new Date(), unread: false },
  });
  return result;
}

// POST /instagram/conversations/:id/reply { text }
router.post("/conversations/:id/reply", async (req, res) => {
  try {
    const text = String(req.body.text || "").trim();
    if (!text) return res.status(400).json({ error: "Message can't be empty." });
    const convo = await prisma.igConversation.findUnique({ where: { id: req.params.id } });
    if (!convo) return res.status(404).json({ error: "Conversation not found." });
    const business = await resolveBusiness(req, convo.businessId);
    if (!business) return res.status(404).json({ error: "Conversation not found." });

    await prisma.withBusinessLock(business.id, () => sendInConversation({ business, convo, text }));
    return res.json({ ok: true });
  } catch (err) {
    console.error("[instagram/reply]", err.message);
    return fail(res, err, "Couldn't send your reply.");
  }
});

// POST /instagram/conversations/:id/send-payment → DM the merchant's NUBAN
router.post("/conversations/:id/send-payment", async (req, res) => {
  try {
    const amount = Number(req.body.amount) || 0;
    const convo = await prisma.igConversation.findUnique({ where: { id: req.params.id } });
    if (!convo) return res.status(404).json({ error: "Conversation not found." });
    const business = await resolveBusiness(req, convo.businessId);
    if (!business) return res.status(404).json({ error: "Conversation not found." });

    const text = ig.buildPaymentText(business, { amount, note: req.body.note });
    if (!text) {
      return res.status(400).json({ error: "Add a bank account (NUBAN) to this business first." });
    }
    await prisma.withBusinessLock(business.id, async () => {
      // Light double-send guard: skip if the same payment text went out in the last 30s.
      const recent = await prisma.igMessage.findFirst({
        where: {
          conversationId: convo.id, direction: "out", text,
          sentAt: { gte: new Date(Date.now() - 30_000) },
        },
      });
      if (recent) return;
      await sendInConversation({ business, convo, text });
      // Arm auto-confirmation: remember the requested amount so a matching inbound
      // NUBAN credit can auto-reply "payment received". Only when an amount is set.
      if (amount > 0) {
        await prisma.igConversation.update({
          where: { id: convo.id },
          data: { expectedAmount: amount, expectedSince: new Date() },
        });
      }
    });
    return res.json({ ok: true, armed: amount > 0 });
  } catch (err) {
    console.error("[instagram/send-payment]", err.message);
    return fail(res, err, "Couldn't send your payment details.");
  }
});

module.exports = router;
