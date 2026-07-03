/**
 * WhatsApp Business (Cloud API) — authenticated API + Embedded Signup pages.
 *
 * Mounted at /whatsapp (see server.js). Two PUBLIC endpoints — the hosted
 * Embedded Signup page and its callback — are authenticated by the signed
 * `state` (HMAC over { businessId, userId }), exactly like the IG OAuth
 * callback. Everything else requires auth. See docs/WHATSAPP_API_SPEC.md.
 */
const router = require("express").Router();
const auth = require("../middleware/auth");
const prisma = require("../utils/db");
const wa = require("../utils/whatsappCloud");
const ig = require("../utils/instagram"); // formatAmount/buildPaymentText are channel-agnostic
const { encrypt, decrypt } = require("../utils/crypto");
const { audit } = require("../utils/audit");

// ── Helpers (same patterns as routes/instagram.js) ───────────────────────────
function ownerId(req) {
  return req.user.accountType === "staff" ? req.user.employerId : req.user.id;
}

async function resolveBusiness(req, businessId) {
  if (!businessId) return null;
  return prisma.business.findFirst({ where: { id: businessId, userId: ownerId(req) } });
}

function liveToken(business) {
  if (!business?.waAccessToken || business.waConnectionStatus !== "connected") {
    const e = new Error("WhatsApp is not connected for this business.");
    e.statusCode = 409; e.reconnect = true; throw e;
  }
  return decrypt(business.waAccessToken);
}

function fail(res, err, fallback = "Something went wrong with WhatsApp.") {
  const status = err.statusCode || (err.status && err.status >= 400 && err.status < 500 ? 400 : 502);
  const payload = { error: err.message || fallback };
  if (err.reconnect) payload.reconnect = true;
  return res.status(status).json(payload);
}

function parseAmount(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n <= 1e12 ? n : null;
}

// ── PUBLIC: hosted Embedded Signup page (opened in the app's WebView) ─────────
// Loads the Facebook JS SDK, launches Embedded Signup with our config id,
// captures the exchangeable code + session info (waba_id, phone_number_id) and
// POSTs them to /whatsapp/callback. Route-scoped CSP allows the FB SDK.
router.get("/connect-page", (req, res) => {
  const cfg = wa.getConfig();
  const state = String(req.query.state || "");
  if (!cfg || !cfg.configId) return res.status(503).type("html").send("<p>WhatsApp connect isn't available yet.</p>");
  // The signed state is base64url.hex — reject anything else before embedding.
  if (!/^[A-Za-z0-9_\-]+\.[a-f0-9]{64}$/.test(state) || !wa.verifyState(state)) {
    return res.status(400).type("html").send("<p>This link has expired. Please start again from KashBook.</p>");
  }

  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' 'unsafe-inline' https://connect.facebook.net; " +
    "connect-src 'self' https://*.facebook.com https://*.facebook.net; " +
    "frame-src https://*.facebook.com; style-src 'unsafe-inline'; img-src * data:;",
  );
  res.type("html").send(`<!doctype html><html><head>
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect WhatsApp</title></head>
<body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#F4F6F9;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center">
<div style="background:#fff;border:1px solid #E8ECF0;border-radius:16px;padding:28px 24px;max-width:360px;text-align:center">
<div style="font-size:40px;margin-bottom:8px">💬</div>
<h2 style="margin:0 0 8px;color:#111827">Connect WhatsApp</h2>
<p id="status" style="color:#475569;font-size:15px;margin:0 0 16px">Link your WhatsApp Business number so you can manage chats and payments from KashBook.</p>
<button id="go" onclick="launch()" style="background:#25D366;color:#fff;border:0;border-radius:12px;padding:13px 26px;font-size:15px;font-weight:700;cursor:pointer">Continue with Facebook</button>
</div>
<script>
  var STATE = ${JSON.stringify(state)};
  var sessionInfo = null;
  function setStatus(t){ document.getElementById('status').textContent = t; }
  window.addEventListener('message', function (event) {
    if (typeof event.origin !== 'string' || event.origin.indexOf('facebook.com') === -1) return;
    try {
      var data = JSON.parse(event.data);
      if (data && data.type === 'WA_EMBEDDED_SIGNUP' && data.data) sessionInfo = data.data;
    } catch (e) {}
  });
  window.fbAsyncInit = function () {
    FB.init({ appId: ${JSON.stringify(cfg.appId)}, autoLogAppEvents: true, xfbml: true, version: ${JSON.stringify(cfg.version)} });
  };
  function launch() {
    if (!window.FB) { setStatus('Still loading — try again in a second.'); return; }
    document.getElementById('go').disabled = true;
    FB.login(function (response) {
      var code = response && response.authResponse && response.authResponse.code;
      if (!code) { setStatus('Signup was cancelled. You can close this window.'); document.getElementById('go').disabled = false; return; }
      setStatus('Finishing up…');
      fetch('/whatsapp/callback', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          state: STATE, code: code,
          wabaId: sessionInfo && sessionInfo.waba_id,
          phoneNumberId: sessionInfo && sessionInfo.phone_number_id,
        }),
      }).then(function (r) { return r.json(); }).then(function (j) {
        setStatus(j.ok ? '✅ WhatsApp connected! You can close this window and return to KashBook.' : ('⚠️ ' + (j.error || 'Could not complete the connection.')));
        if (!j.ok) document.getElementById('go').disabled = false;
      }).catch(function () { setStatus('⚠️ Network error — please try again.'); document.getElementById('go').disabled = false; });
    }, { config_id: ${JSON.stringify(cfg.configId)}, response_type: 'code', override_default_response_type: true, extras: { setup: {}, sessionInfoVersion: '3' } });
  }
</script>
<script async defer crossorigin="anonymous" src="https://connect.facebook.net/en_US/sdk.js"></script>
</body></html>`);
});

// ── PUBLIC: Embedded Signup callback (state-verified) ────────────────────────
router.post("/callback", async (req, res) => {
  try {
    if (!wa.isConfigured()) return res.status(503).json({ ok: false, error: "WhatsApp isn't available right now." });
    const state = wa.verifyState(req.body.state);
    if (!state) return res.status(400).json({ ok: false, error: "This link has expired — start again from KashBook." });

    const code = String(req.body.code || "").trim();
    const wabaId = req.body.wabaId != null ? String(req.body.wabaId) : null;
    const phoneNumberId = req.body.phoneNumberId != null ? String(req.body.phoneNumberId) : null;
    if (!code) return res.status(400).json({ ok: false, error: "Missing signup code." });
    if (!wabaId || !phoneNumberId) {
      return res.status(400).json({ ok: false, error: "Signup didn't finish — please run the flow again to the end." });
    }

    const business = await prisma.business.findFirst({
      where: { id: state.businessId, userId: state.userId },
    });
    if (!business) return res.status(404).json({ ok: false, error: "Business not found." });

    const { accessToken } = await wa.exchangeCodeForToken(code);
    if (!accessToken) throw new Error("WhatsApp did not return an access token.");

    // Subscribe our app to the WABA (retry — without it inbound never arrives).
    let subscribed = false;
    for (let attempt = 1; attempt <= 2 && !subscribed; attempt++) {
      try { subscribed = await wa.subscribeWaba(accessToken, wabaId); }
      catch (e) { console.error(`[whatsapp/callback] subscribe attempt ${attempt} failed:`, e.message); }
    }

    // Register the number for Cloud API sends (best-effort; "already" = ok).
    let registered = false;
    try { registered = await wa.registerPhone(accessToken, phoneNumberId, wa.derivePin(business.id)); }
    catch (e) { console.error("[whatsapp/callback] register failed:", e.message); }

    let displayPhone = null;
    try { displayPhone = (await wa.getPhoneInfo(accessToken, phoneNumberId)).displayPhoneNumber; } catch { /* cosmetic */ }

    try {
      await prisma.business.update({
        where: { id: business.id },
        data: {
          waAccessToken: encrypt(accessToken),
          wabaId,
          waPhoneNumberId: phoneNumberId,
          waPhoneNumber: displayPhone,
          waConnectionStatus: "connected",
          waWebhookSubscribed: subscribed,
        },
      });
    } catch (e) {
      if (e.code === "P2002") {
        return res.status(409).json({ ok: false, error: "This WhatsApp number is already connected to another KashBook business." });
      }
      throw e;
    }

    await audit({
      action: "WHATSAPP_CONNECTED", resourceType: "business", resourceId: business.id,
      actorOverride: { type: "user", id: state.userId }, severity: "info",
      metadata: { wabaId, phoneNumberId, displayPhone, subscribed, registered },
    });
    return res.json({ ok: true });
  } catch (err) {
    console.error("[whatsapp/callback]", err.message);
    return res.status(502).json({ ok: false, error: "We couldn't complete the WhatsApp connection. Please try again." });
  }
});

// ── Everything below requires auth ───────────────────────────────────────────
router.use(auth);

// GET /whatsapp/connect-url?businessId= → { url } (the hosted signup page)
router.get("/connect-url", async (req, res) => {
  try {
    if (!wa.isConfigured() || !wa.getConfig().configId) {
      return res.status(503).json({ error: "WhatsApp connect isn't available yet." });
    }
    if (req.user.accountType === "staff") return res.status(403).json({ error: "Only the business owner can connect WhatsApp." });
    const business = await resolveBusiness(req, req.query.businessId);
    if (!business) return res.status(404).json({ error: "Business not found." });
    const base = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
    if (!base) return res.status(503).json({ error: "WhatsApp connect isn't available yet." });
    const state = wa.signState({ businessId: business.id, userId: req.user.id });
    return res.json({ url: `${base}/whatsapp/connect-page?state=${encodeURIComponent(state)}` });
  } catch (err) { return fail(res, err); }
});

// GET /whatsapp/status?businessId=
router.get("/status", async (req, res) => {
  try {
    const business = await resolveBusiness(req, req.query.businessId);
    if (!business) return res.status(404).json({ error: "Business not found." });
    return res.json({
      connected: business.waConnectionStatus === "connected",
      status: business.waConnectionStatus || "disconnected",
      phoneNumber: business.waPhoneNumber || null,
      subscribed: !!business.waWebhookSubscribed,
    });
  } catch (err) { return fail(res, err); }
});

// POST /whatsapp/disconnect { businessId }
router.post("/disconnect", async (req, res) => {
  try {
    if (req.user.accountType === "staff") return res.status(403).json({ error: "Only the business owner can disconnect WhatsApp." });
    const business = await resolveBusiness(req, req.body.businessId);
    if (!business) return res.status(404).json({ error: "Business not found." });
    await prisma.business.update({
      where: { id: business.id },
      data: {
        waAccessToken: null, wabaId: null, waPhoneNumberId: null, waPhoneNumber: null,
        waConnectionStatus: "disconnected", waWebhookSubscribed: false,
      },
    });
    await audit({ req, action: "WHATSAPP_DISCONNECTED", resourceType: "business", resourceId: business.id, severity: "info" });
    return res.json({ ok: true });
  } catch (err) { return fail(res, err); }
});

// GET /whatsapp/conversations?businessId=
router.get("/conversations", async (req, res) => {
  try {
    const business = await resolveBusiness(req, req.query.businessId);
    if (!business) return res.status(404).json({ error: "Business not found." });
    const rows = await prisma.waConversation.findMany({
      where: { businessId: business.id },
      orderBy: { lastMessageAt: "desc" },
      take: 100,
      include: { messages: { orderBy: { sentAt: "desc" }, take: 1 } },
    });
    return res.json({
      conversations: rows.map((c) => ({
        id: c.id,
        participantName: c.participantName,
        participantPhone: c.participantPhone,
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

// GET /whatsapp/conversations/:id/messages → cached thread; marks read
router.get("/conversations/:id/messages", async (req, res) => {
  try {
    const convo = await prisma.waConversation.findUnique({ where: { id: req.params.id } });
    if (!convo) return res.status(404).json({ error: "Conversation not found." });
    const business = await resolveBusiness(req, convo.businessId);
    if (!business) return res.status(404).json({ error: "Conversation not found." });
    const messages = await prisma.waMessage.findMany({
      where: { conversationId: convo.id }, orderBy: { sentAt: "asc" }, take: 200,
    });
    if (convo.unread) {
      await prisma.waConversation.update({ where: { id: convo.id }, data: { unread: false } });
    }
    return res.json({
      conversation: {
        id: convo.id,
        participantName: convo.participantName,
        participantPhone: convo.participantPhone,
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

// Shared send path — 24h free-form window (no HUMAN_AGENT equivalent on WhatsApp;
// outside the window needs a paid template, which v1 doesn't do).
const crypto = require("crypto");
async function sendInWaConversation({ business, convo, text }) {
  if (!wa.isConfigured()) {
    const e = new Error("WhatsApp isn't available right now."); e.statusCode = 503; throw e;
  }
  const hoursSince = convo.lastInboundAt
    ? (Date.now() - new Date(convo.lastInboundAt).getTime()) / 3_600_000
    : Infinity;
  if (hoursSince > 24) {
    const e = new Error("It's been over 24 hours since this customer messaged you — WhatsApp only allows replies within 24 hours, so they need to message you again first.");
    e.statusCode = 422; throw e;
  }
  const token = liveToken(business);
  const r = await wa.sendText(token, business.waPhoneNumberId, convo.participantPhone, text);
  await prisma.waMessage.create({
    data: {
      conversationId: convo.id,
      waMessageId: r.messageId || `out_${crypto.randomUUID()}`,
      direction: "out",
      text,
    },
  }).catch((e) => { if (e.code !== "P2002") throw e; });
  await prisma.waConversation.update({
    where: { id: convo.id },
    data: { lastMessageAt: new Date(), unread: false },
  });
  return r;
}

// POST /whatsapp/conversations/:id/reply { text }
router.post("/conversations/:id/reply", async (req, res) => {
  try {
    const text = String(req.body.text || "").trim();
    if (!text) return res.status(400).json({ error: "Message can't be empty." });
    const convo = await prisma.waConversation.findUnique({ where: { id: req.params.id } });
    if (!convo) return res.status(404).json({ error: "Conversation not found." });
    const business = await resolveBusiness(req, convo.businessId);
    if (!business) return res.status(404).json({ error: "Conversation not found." });
    await prisma.withBusinessLock(business.id, () => sendInWaConversation({ business, convo, text }));
    return res.json({ ok: true });
  } catch (err) {
    console.error("[whatsapp/reply]", err.message);
    return fail(res, err, "Couldn't send your reply.");
  }
});

// POST /whatsapp/conversations/:id/send-payment { amount?, note? } — DM the NUBAN,
// optionally arming auto payment confirmation (waPaymentMatch).
router.post("/conversations/:id/send-payment", async (req, res) => {
  try {
    const amount = parseAmount(req.body.amount) || 0;
    const convo = await prisma.waConversation.findUnique({ where: { id: req.params.id } });
    if (!convo) return res.status(404).json({ error: "Conversation not found." });
    const business = await resolveBusiness(req, convo.businessId);
    if (!business) return res.status(404).json({ error: "Conversation not found." });
    const text = ig.buildPaymentText(business, { amount, note: req.body.note });
    if (!text) return res.status(400).json({ error: "Add a bank account (NUBAN) to this business first." });
    await prisma.withBusinessLock(business.id, async () => {
      const recent = await prisma.waMessage.findFirst({
        where: { conversationId: convo.id, direction: "out", text, sentAt: { gte: new Date(Date.now() - 30_000) } },
      });
      if (recent) return;
      await sendInWaConversation({ business, convo, text });
      if (amount > 0) {
        await prisma.waConversation.update({
          where: { id: convo.id },
          data: { expectedAmount: amount, expectedSince: new Date() },
        });
      }
    });
    return res.json({ ok: true, armed: amount > 0 });
  } catch (err) {
    console.error("[whatsapp/send-payment]", err.message);
    return fail(res, err, "Couldn't send your payment details.");
  }
});

// GET /whatsapp/unread-count?businessId=
router.get("/unread-count", async (req, res) => {
  try {
    const business = await resolveBusiness(req, req.query.businessId);
    if (!business) return res.json({ count: 0 });
    const count = await prisma.waConversation.count({ where: { businessId: business.id, unread: true } });
    return res.json({ count });
  } catch { return res.json({ count: 0 }); }
});

module.exports = router;
