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

// Resolve the bookkeeping Customer linked to an IG conversation. Prefers the
// STORED link (convo.customerId) so we never mis-match on a shared display name;
// falls back to a deterministic name match; creates + links only on write flows.
async function resolveIgCustomer(business, convo, ownerUserId, { create = false } = {}) {
  if (convo.customerId) {
    const c = await prisma.customer.findFirst({ where: { id: convo.customerId, businessId: business.id } });
    if (c) return c;
  }
  const igName = convo.participantUsername ? `@${convo.participantUsername}` : "Instagram customer";
  let customer = await prisma.customer.findFirst({
    where: { businessId: business.id, name: igName }, orderBy: { createdAt: "asc" },
  });
  if (!customer && create && ownerUserId) {
    customer = await prisma.customer.create({ data: { userId: ownerUserId, businessId: business.id, name: igName } });
  }
  if (customer && create && convo.customerId !== customer.id) {
    await prisma.igConversation.update({ where: { id: convo.id }, data: { customerId: customer.id } }).catch(() => {});
  }
  return customer;
}

// Reject non-finite / absurd amounts (Infinity passes `> 0`). Returns a clean
// number or null.
function parseAmount(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n <= 1e12 ? n : null;
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
      // Update-only: enrich username/threadId on conversations the WEBHOOK already
      // created. We deliberately do NOT create here — a sync-seeded (message-less)
      // conversation would make the next inbound look like a repeat contact and
      // suppress the greeting auto-reply. Never clobber webhook-owned timestamps.
      const updated = await prisma.igConversation.updateMany({
        where: { businessId: business.id, participantIgId: customer.id },
        data: {
          participantUsername: customer.username || undefined,
          igThreadId: c.id || undefined,
        },
      });
      if (updated.count > 0) synced++;
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
        id: m.id, direction: m.direction, text: m.text, attachmentUrl: m.attachmentUrl, sentAt: m.sentAt,
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
    const amount = parseAmount(req.body.amount) || 0;
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

// ── Quick replies (saved canned messages) ────────────────────────────────────
// GET /instagram/quick-replies?businessId=
router.get("/quick-replies", async (req, res) => {
  try {
    const business = await resolveBusiness(req, req.query.businessId);
    if (!business) return res.status(404).json({ error: "Business not found." });
    const rows = await prisma.quickReply.findMany({
      where: { businessId: business.id }, orderBy: { createdAt: "asc" }, take: 50,
    });
    return res.json({ quickReplies: rows.map((r) => ({ id: r.id, text: r.text })) });
  } catch (err) { return fail(res, err); }
});

// POST /instagram/quick-replies { businessId, text }
router.post("/quick-replies", async (req, res) => {
  try {
    const text = String(req.body.text || "").trim();
    if (!text) return res.status(400).json({ error: "Message can't be empty." });
    if (text.length > 900) return res.status(400).json({ error: "Too long (max 900 characters)." });
    const business = await resolveBusiness(req, req.body.businessId);
    if (!business) return res.status(404).json({ error: "Business not found." });
    const row = await prisma.quickReply.create({ data: { businessId: business.id, text } });
    return res.json({ id: row.id, text: row.text });
  } catch (err) { return fail(res, err); }
});

// DELETE /instagram/quick-replies/:id
router.delete("/quick-replies/:id", async (req, res) => {
  try {
    const row = await prisma.quickReply.findUnique({ where: { id: req.params.id } });
    if (!row) return res.json({ ok: true }); // already gone
    const business = await resolveBusiness(req, row.businessId);
    if (!business) return res.status(404).json({ error: "Not found." });
    await prisma.quickReply.delete({ where: { id: row.id } });
    return res.json({ ok: true });
  } catch (err) { return fail(res, err); }
});

// ── Record a sale straight from a DM ──────────────────────────────────────────
// POST /instagram/conversations/:id/record-sale { amount, notes }
// Finds-or-creates a Customer for the IG handle and books a channel=instagram
// sale — turning a chat into recorded revenue (feeds the by-channel analytics).
router.post("/conversations/:id/record-sale", async (req, res) => {
  try {
    const amount = parseAmount(req.body.amount);
    if (!amount) return res.status(400).json({ error: "Enter a valid amount." });
    const convo = await prisma.igConversation.findUnique({ where: { id: req.params.id } });
    if (!convo) return res.status(404).json({ error: "Conversation not found." });
    const business = await resolveBusiness(req, convo.businessId);
    if (!business) return res.status(404).json({ error: "Conversation not found." });

    const ownerUserId = ownerId(req);
    // Serialize per-business so a double-tap / concurrent request can't create two
    // customers (withBusinessLock queues same-business calls via a pg advisory lock).
    const result = await prisma.withBusinessLock(business.id, async () => {
      const customer = await resolveIgCustomer(business, convo, ownerUserId, { create: true });
      const sale = await prisma.sales.create({
        data: {
          userId: ownerUserId,
          businessId: business.id,
          customerId: customer.id,
          amount,
          paymentMethod: "transfer",
          channel: "instagram",
          notes: String(req.body.notes || "").trim() || null,
          recordedBy: req.user.id,
          recordedByName: req.user.name,
        },
      });
      return { saleId: sale.id, customerId: customer.id };
    });
    return res.json({ ok: true, ...result });
  } catch (err) {
    console.error("[instagram/record-sale]", err.message);
    return fail(res, err, "Couldn't record the sale.");
  }
});

// ── Auto-replies (greeting + keyword) ────────────────────────────────────────
// GET /instagram/auto-replies?businessId=
router.get("/auto-replies", async (req, res) => {
  try {
    const business = await resolveBusiness(req, req.query.businessId);
    if (!business) return res.status(404).json({ error: "Business not found." });
    const rows = await prisma.igAutoReply.findMany({
      where: { businessId: business.id }, orderBy: { createdAt: "asc" }, take: 100,
    });
    return res.json({
      rules: rows.map((r) => ({ id: r.id, kind: r.kind, keyword: r.keyword, text: r.text, enabled: r.enabled, fromHour: r.fromHour, toHour: r.toHour })),
    });
  } catch (err) { return fail(res, err); }
});

// POST /instagram/auto-replies { businessId, kind, keyword?, text, fromHour?, toHour? }
// kinds: greeting | keyword | comment | away. One greeting + one away per business.
const AUTO_REPLY_KINDS = new Set(["greeting", "keyword", "comment", "away"]);
function mapRule(r) {
  return { id: r.id, kind: r.kind, keyword: r.keyword, text: r.text, enabled: r.enabled, fromHour: r.fromHour, toHour: r.toHour };
}
router.post("/auto-replies", async (req, res) => {
  try {
    const kind = AUTO_REPLY_KINDS.has(req.body.kind) ? req.body.kind : "keyword";
    const text = String(req.body.text || "").trim();
    const keyword = String(req.body.keyword || "").trim();
    if (!text) return res.status(400).json({ error: "Reply text can't be empty." });
    if (text.length > 900) return res.status(400).json({ error: "Too long (max 900 characters)." });
    if (kind === "keyword" && !keyword) return res.status(400).json({ error: "Enter a keyword to match." });
    const business = await resolveBusiness(req, req.body.businessId);
    if (!business) return res.status(404).json({ error: "Business not found." });

    let fromHour = null, toHour = null;
    if (kind === "away") {
      const parseHour = (v) => (v == null || v === "" ? null : parseInt(v, 10));
      fromHour = parseHour(req.body.fromHour);
      toHour = parseHour(req.body.toHour);
      const okHour = (h) => h == null || (Number.isInteger(h) && h >= 0 && h <= 23);
      if (!okHour(fromHour) || !okHour(toHour)) return res.status(400).json({ error: "Hours must be between 0 and 23." });
    }

    // One greeting / one away per business — update in place if it exists.
    if (kind === "greeting" || kind === "away") {
      const existing = await prisma.igAutoReply.findFirst({ where: { businessId: business.id, kind } });
      if (existing) {
        const row = await prisma.igAutoReply.update({
          where: { id: existing.id }, data: { text, enabled: true, fromHour, toHour },
        });
        return res.json(mapRule(row));
      }
    }
    const row = await prisma.igAutoReply.create({
      data: {
        businessId: business.id, kind, text, fromHour, toHour,
        keyword: (kind === "keyword" || kind === "comment") ? (keyword || null) : null,
      },
    });
    return res.json(mapRule(row));
  } catch (err) { return fail(res, err); }
});

// PATCH /instagram/auto-replies/:id { enabled }
router.patch("/auto-replies/:id", async (req, res) => {
  try {
    const row = await prisma.igAutoReply.findUnique({ where: { id: req.params.id } });
    if (!row) return res.status(404).json({ error: "Rule not found." });
    const business = await resolveBusiness(req, row.businessId);
    if (!business) return res.status(404).json({ error: "Rule not found." });
    const updated = await prisma.igAutoReply.update({ where: { id: row.id }, data: { enabled: !!req.body.enabled } });
    return res.json({ id: updated.id, enabled: updated.enabled });
  } catch (err) { return fail(res, err); }
});

// DELETE /instagram/auto-replies/:id
router.delete("/auto-replies/:id", async (req, res) => {
  try {
    const row = await prisma.igAutoReply.findUnique({ where: { id: req.params.id } });
    if (!row) return res.json({ ok: true });
    const business = await resolveBusiness(req, row.businessId);
    if (!business) return res.status(404).json({ error: "Not found." });
    await prisma.igAutoReply.delete({ where: { id: row.id } });
    return res.json({ ok: true });
  } catch (err) { return fail(res, err); }
});

// POST /instagram/conversations/:id/send-product { itemId } — DM a product's details
router.post("/conversations/:id/send-product", async (req, res) => {
  try {
    const convo = await prisma.igConversation.findUnique({ where: { id: req.params.id } });
    if (!convo) return res.status(404).json({ error: "Conversation not found." });
    const business = await resolveBusiness(req, convo.businessId);
    if (!business) return res.status(404).json({ error: "Conversation not found." });
    const item = await prisma.inventoryItem.findFirst({
      where: { id: String(req.body.itemId || ""), businessId: business.id },
    });
    if (!item) return res.status(404).json({ error: "Product not found." });

    const price = ig.formatAmount(item.price, business.baseCurrency);
    const lines = [`🛍️ ${item.name} — ${price}`];
    if (item.description) lines.push(item.description);
    if (item.quantity > 0) lines.push(`In stock: ${item.quantity} ${item.unit || "pcs"}`);
    lines.push("", "Reply to order 👍");
    const text = lines.join("\n");

    await prisma.withBusinessLock(business.id, () => sendInConversation({ business, convo, text }));
    return res.json({ ok: true });
  } catch (err) {
    console.error("[instagram/send-product]", err.message);
    return fail(res, err, "Couldn't send the product.");
  }
});

// GET /instagram/unread-count?businessId= → unread conversation count (badge)
router.get("/unread-count", async (req, res) => {
  try {
    const business = await resolveBusiness(req, req.query.businessId);
    if (!business) return res.json({ count: 0 });
    const count = await prisma.igConversation.count({ where: { businessId: business.id, unread: true } });
    return res.json({ count });
  } catch { return res.json({ count: 0 }); }
});

// GET /instagram/analytics?businessId= → inbox + DM→sale conversion stats
router.get("/analytics", async (req, res) => {
  try {
    const business = await resolveBusiness(req, req.query.businessId);
    if (!business) return res.status(404).json({ error: "Business not found." });
    const [conversations, unread, inbound, outbound, sales] = await Promise.all([
      prisma.igConversation.count({ where: { businessId: business.id } }),
      prisma.igConversation.count({ where: { businessId: business.id, unread: true } }),
      prisma.igMessage.count({ where: { conversation: { businessId: business.id }, direction: "in" } }),
      prisma.igMessage.count({ where: { conversation: { businessId: business.id }, direction: "out" } }),
      prisma.sales.aggregate({ where: { businessId: business.id, channel: "instagram" }, _count: true, _sum: { amount: true } }),
    ]);
    return res.json({
      conversations, unread, inbound, outbound,
      salesCount: sales._count || 0,
      salesTotal: sales._sum?.amount || 0,
    });
  } catch (err) { return fail(res, err); }
});

// GET /instagram/conversations/:id/customer-summary → the linked customer's bookkeeping snapshot
router.get("/conversations/:id/customer-summary", async (req, res) => {
  try {
    const convo = await prisma.igConversation.findUnique({ where: { id: req.params.id } });
    if (!convo) return res.status(404).json({ error: "Conversation not found." });
    const business = await resolveBusiness(req, convo.businessId);
    if (!business) return res.status(404).json({ error: "Conversation not found." });

    const customer = await resolveIgCustomer(business, convo, null, { create: false });
    if (!customer) return res.json({ linked: false });

    const agg = await prisma.sales.aggregate({
      where: { businessId: business.id, customerId: customer.id },
      _count: true, _sum: { amount: true },
    });
    return res.json({
      linked: true,
      customerId: customer.id,
      name: customer.name,
      totalOwed: customer.totalOwed || 0,
      salesCount: agg._count || 0,
      salesTotal: agg._sum?.amount || 0,
    });
  } catch (err) { return fail(res, err); }
});

// POST /instagram/conversations/:id/create-invoice { amount, description }
// Creates a SENT invoice (find-or-create customer) + share link and DMs the link.
router.post("/conversations/:id/create-invoice", async (req, res) => {
  try {
    const amount = parseAmount(req.body.amount);
    if (!amount) return res.status(400).json({ error: "Enter a valid amount." });
    const description = String(req.body.description || "").trim() || "Order";
    const convo = await prisma.igConversation.findUnique({ where: { id: req.params.id } });
    if (!convo) return res.status(404).json({ error: "Conversation not found." });
    const business = await resolveBusiness(req, convo.businessId);
    if (!business) return res.status(404).json({ error: "Conversation not found." });

    const ownerUserId = ownerId(req);
    const result = await prisma.withBusinessLock(business.id, async () => {
      const customer = await resolveIgCustomer(business, convo, ownerUserId, { create: true });
      const biz = await prisma.business.update({ where: { id: business.id }, data: { invoiceCounter: { increment: 1 } } });
      const invoiceNumber = `INV-${String(biz.invoiceCounter).padStart(3, "0")}`;
      const invoice = await prisma.invoice.create({
        data: {
          businessId: business.id, customerId: customer.id, userId: ownerUserId,
          invoiceNumber, type: "invoice", status: "SENT",
          issueDate: new Date().toISOString().slice(0, 10),
          currency: business.baseCurrency || "NGN",
          subtotal: amount, total: amount,
          items: { create: [{ name: description, quantity: 1, rate: amount, amount }] },
        },
      });
      const token = require("crypto").randomBytes(32).toString("base64url");
      await prisma.invoiceShareLink.create({ data: { invoiceId: invoice.id, token } });
      return { invoiceId: invoice.id, invoiceNumber, token };
    });

    const base = process.env.PUBLIC_BASE_URL || "";
    const url = base ? `${base.replace(/\/$/, "")}/i/${result.token}` : "";
    const amtLabel = ig.formatAmount(amount, business.baseCurrency);
    const text = `Here's your invoice ${result.invoiceNumber} for ${amtLabel} 🧾${url ? `\n${url}` : ""}\n\nTap the link to view and pay. Thank you!`;
    try {
      await prisma.withBusinessLock(business.id, () => sendInConversation({ business, convo, text }));
    } catch (e) {
      // Invoice was created; DM failed (e.g. outside the 24h window). Still a success.
      console.warn("[instagram/create-invoice] DM failed:", e.message);
    }
    return res.json({ ok: true, invoiceId: result.invoiceId, invoiceNumber: result.invoiceNumber });
  } catch (err) {
    console.error("[instagram/create-invoice]", err.message);
    return fail(res, err, "Couldn't create the invoice.");
  }
});

module.exports = router;
