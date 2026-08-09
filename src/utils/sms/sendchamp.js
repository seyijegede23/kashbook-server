// Sendchamp SMS adapter — Nigeria (and international). Same shape as termii.js:
// KashBook still generates + stores + verifies the OTP itself (utils/otp.js);
// Sendchamp is only the delivery pipe, so switching providers never touches the
// single-use / throttle / expiry guarantees.
//
// API: POST https://api.sendchamp.com/api/v1/sms/send
// Auth: Authorization: Bearer <public/access key>  (Account Settings → API Keys)
//
// NOTE: this uses Node's native `https` (not global fetch/undici). From Render,
// fetch() to the Cloudflare-fronted Sendchamp host failed with a bare, code-less
// undici "fetch failed"; the classic https stack with family:4 (force IPv4) both
// sidesteps that and, on any real failure, surfaces a proper error code
// (ECONNRESET / ETIMEDOUT / cert…) so the cause is diagnosable.
const https = require("https");

// Sendchamp wants international format WITHOUT a leading "+" (e.g. 2348012345678).
function normalizePhoneForSendchamp(phone) {
  if (!phone) return "";
  const digits = String(phone).replace(/\D/g, "");
  if (digits.startsWith("234")) return digits;
  if (digits.length === 11 && digits.startsWith("0")) return "234" + digits.slice(1);
  if (digits.length === 10) return "234" + digits;
  return digits;
}

// Minimal JSON POST over the native https stack. Forces IPv4 and returns
// { status, body } or rejects with a coded socket/TLS error.
function httpsPostJson({ urlStr, headers, body, timeoutMs = 15000 }) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(urlStr);
    } catch (e) {
      return reject(e);
    }
    const payload = Buffer.from(body);
    const req = https.request(
      {
        method: "POST",
        hostname: u.hostname,
        path: u.pathname + (u.search || ""),
        port: u.port || 443,
        family: 4, // force IPv4 — Cloudflare publishes AAAA; Render has no IPv6 egress
        timeout: timeoutMs,
        headers: { ...headers, "Content-Length": payload.length },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (d) => (data += d));
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      },
    );
    req.on("timeout", () =>
      req.destroy(Object.assign(new Error("request timeout"), { code: "ETIMEDOUT" })),
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// Deliver an OTP over Sendchamp's WHATSAPP channel via their Verification API.
// KEY DETAIL: meta_data.token lets US supply the code, so KashBook's own OTP
// engine (OtpCode table, atomic single-use verifyOtp, throttle) stays the
// authority — Sendchamp only delivers. We never call their /verification/confirm.
// WhatsApp delivery sidesteps the NG DND filter and sender-ID registration that
// silently drop SMS from unregistered senders.
// Returns { ok } — callers fall back to SMS when not ok.
async function sendWhatsAppOtp(phone, code) {
  const apiKey = process.env.SENDCHAMP_PUBLIC_KEY || process.env.SENDCHAMP_API_KEY;
  if (!apiKey || process.env.SENDCHAMP_WA_OTP === "false") return { ok: false };

  const to = normalizePhoneForSendchamp(phone);
  const base = process.env.SENDCHAMP_BASE_URL || "https://api.sendchamp.com/api/v1";
  const body = JSON.stringify({
    channel: "whatsapp",
    sender: process.env.SENDCHAMP_WA_SENDER || process.env.SENDCHAMP_SENDER_ID || "KashBook",
    customer_mobile_number: to,
    token_type: "numeric",
    token_length: String(code).length,
    expiration_time: 10, // minutes — matches our OtpCode expiry
    meta_data: { token: String(code) },
  });
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  try {
    // Sendchamp's verification endpoint routinely takes 15-20s to answer while
    // it dispatches the WhatsApp message (delivery itself succeeds) — a short
    // timeout misreads that as failure and double-sends via SMS. Give it 30s.
    const { status, body: resBody } = await httpsPostJson({
      urlStr: `${base}/verification/create`,
      headers,
      body,
      timeoutMs: 30000,
    });
    let data = {};
    try {
      data = resBody ? JSON.parse(resBody) : {};
    } catch {}
    const ok =
      status >= 200 && status < 300 &&
      (data.status === "success" || String(data.status) === "200" || String(data.code) === "200");
    if (!ok) {
      console.warn(`[Sendchamp WA-OTP] http ${status}: ${String(resBody).slice(0, 250)} — falling back to SMS`);
      return { ok: false };
    }
    console.log(`[Sendchamp WA-OTP sent] → ${String(phone).replace(/\d(?=\d{4})/g, "*")}`);
    return { ok: true };
  } catch (err) {
    console.warn(`[Sendchamp WA-OTP] ${err.code || err.message} — falling back to SMS`);
    return { ok: false };
  }
}

// Send an APPROVED WhatsApp template message.
//
// This is a different Sendchamp product from sendWhatsAppOtp above. That one
// uses /verification/create, which can only ever deliver a token — it renders
// Sendchamp's own OTP wording, so it cannot carry a debt reminder. Arbitrary
// business-initiated WhatsApp messages must go through an approved template:
//
//   POST /whatsapp/message/send  { sender, recipient, template_code,
//                                  type: "template", custom_data: { body: {...} } }
//
// `vars` is positional, matching the {{1}}, {{2}}… placeholders in the template
// registered on the Sendchamp dashboard. Order is defined by that template, so
// changing the template means changing the caller.
//
// Returns { ok, reference } — callers fall back to SMS when not ok, exactly as
// the OTP path does.
async function sendWhatsAppTemplate(phone, templateCode, vars = []) {
  const apiKey = process.env.SENDCHAMP_PUBLIC_KEY || process.env.SENDCHAMP_API_KEY;
  const sender = process.env.SENDCHAMP_WA_SENDER;
  if (!apiKey || !templateCode || !sender) {
    return { ok: false, error: "NOT_CONFIGURED" };
  }

  const base = process.env.SENDCHAMP_BASE_URL || "https://api.sendchamp.com/api/v1";
  const body = JSON.stringify({
    sender,
    recipient: normalizePhoneForSendchamp(phone),
    template_code: templateCode,
    type: "template",
    // Sendchamp keys template variables by 1-based position, as strings.
    custom_data: {
      body: vars.reduce((acc, v, i) => ({ ...acc, [String(i + 1)]: String(v ?? "") }), {}),
    },
  });

  try {
    const { status, body: resBody } = await httpsPostJson({
      urlStr: `${base}/whatsapp/message/send`,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body,
      timeoutMs: 30000, // same allowance as the OTP path; WA dispatch is slow
    });
    let data = {};
    try { data = resBody ? JSON.parse(resBody) : {}; } catch {}
    const ok =
      status >= 200 && status < 300 &&
      (data.status === "success" || String(data.code) === "200");
    if (!ok) {
      console.warn(`[Sendchamp WA-template] http ${status}: ${String(resBody).slice(0, 250)}`);
      return { ok: false, error: `HTTP_${status}` };
    }
    return { ok: true, reference: data?.data?.provider_reference || null };
  } catch (err) {
    console.warn(`[Sendchamp WA-template] ${err.code || err.message}`);
    return { ok: false, error: err.code || "REQUEST_FAILED" };
  }
}

async function sendSms(phone, message, opts = {}) {
  // OTP delivery order: WhatsApp first (no DND/sender-ID pitfalls), SMS as the
  // fallback. Only possible when the caller passes the raw code (opts.otpCode);
  // plain notification texts go straight to SMS.
  if (opts.otpCode) {
    const wa = await sendWhatsAppOtp(phone, opts.otpCode);
    if (wa.ok) return;
  }

  // Dev: print the code to the console so it's visible. Prod: never log the
  // message (contains the code) or the full number (PII) — mask all but last 4.
  if (process.env.NODE_ENV !== "production") {
    console.log(`\n============================`);
    console.log(`📱 OTP SMS (Sendchamp) → ${phone}`);
    console.log(`   ${message}`);
    console.log(`============================\n`);
  } else {
    console.log(`📱 OTP SMS (Sendchamp) → ${String(phone).replace(/\d(?=\d{4})/g, "*")}`);
  }

  const apiKey = process.env.SENDCHAMP_PUBLIC_KEY || process.env.SENDCHAMP_API_KEY;
  if (!apiKey) {
    console.warn("[Sendchamp] SENDCHAMP_PUBLIC_KEY not set — SMS not sent");
    return;
  }

  const to = normalizePhoneForSendchamp(phone);
  const sender_name = process.env.SENDCHAMP_SENDER_ID || "Sendchamp";
  // Route: "dnd" is the transactional route that reaches numbers on Nigeria's DND
  // list — REQUIRED for OTP. Override with SENDCHAMP_ROUTE ("non_dnd" / "international").
  const route = process.env.SENDCHAMP_ROUTE || "dnd";
  const base = process.env.SENDCHAMP_BASE_URL || "https://api.sendchamp.com/api/v1";
  const url = `${base}/sms/send`;
  const body = JSON.stringify({ to: [to], message, sender_name, route });
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  // Retry once on a network-level failure (transient connect blip). A real HTTP
  // response (even 4xx/5xx) is NOT retried.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const { status, body: resBody } = await httpsPostJson({ urlStr: url, headers, body });
      let data = {};
      try {
        data = resBody ? JSON.parse(resBody) : {};
      } catch {
        /* non-JSON body — leave data empty, handled below */
      }
      const ok =
        status >= 200 &&
        status < 300 &&
        (data.status === "success" || String(data.status) === "200" || String(data.code) === "200");
      if (!ok) {
        console.error(`[Sendchamp SMS error] http ${status}: ${String(resBody).slice(0, 300)}`);
        return; // real response — do not retry
      }
      const id = data?.data?.id || data?.data?.[0]?.id || data?.data?.reference;
      console.log(`[Sendchamp SMS sent]${id ? ` id=${id}` : ""}`);
      return;
    } catch (err) {
      console.error(
        `[Sendchamp SMS error] attempt ${attempt}/2 (https): ${err.code || err.message}`,
      );
      if (attempt < 2) await new Promise((r) => setTimeout(r, 800));
    }
  }
}

module.exports = { sendSms, sendWhatsAppOtp, sendWhatsAppTemplate };
