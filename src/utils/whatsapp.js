 // WhatsApp OTP delivery via Meta's WhatsApp Cloud API.
//
// We generate + verify the code ourselves (see otp.js saveOtp/verifyOtp); Meta
// only DELIVERS it. So WhatsApp is just another delivery channel — verification
// is unchanged. If the env isn't configured, sendWhatsAppOtp returns
// { ok: false, error: "NOT_CONFIGURED" } and the caller falls back to SMS, so
// nothing breaks until the WABA + template + token are in place.
//
// Required env (set on Render + locally):
//   WHATSAPP_PHONE_NUMBER_ID   the Cloud API phone-number id (NOT the phone number)
//   WHATSAPP_ACCESS_TOKEN      a permanent system-user token with whatsapp_business_messaging
//   WHATSAPP_OTP_TEMPLATE      name of your APPROVED authentication-category template
// Optional:
//   WHATSAPP_TEMPLATE_LANG     template language code (default "en_US")
//   WHATSAPP_API_VERSION       Graph API version (default "v21.0")
//
// The template MUST be an AUTHENTICATION-category template with one body
// variable (the code) and a copy-code button — that's what Meta generates by
// default for authentication templates. The send payload below matches that
// shape (body param = code, button param = code).

const TIMEOUT_MS = 8_000;

// Meta wants digits only, international format, no "+" (e.g. 2348012345678).
function normalizeMsisdn(phone) {
  if (!phone) return "";
  const digits = String(phone).replace(/\D/g, "");
  if (digits.startsWith("234")) return digits;
  if (digits.length === 11 && digits.startsWith("0")) return "234" + digits.slice(1);
  if (digits.length === 10) return "234" + digits;
  return digits;
}

function getConfig() {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const template = process.env.WHATSAPP_OTP_TEMPLATE;
  if (!phoneNumberId || !token || !template) return null;
  return {
    phoneNumberId,
    token,
    template,
    lang: process.env.WHATSAPP_TEMPLATE_LANG || "en_US",
    version: process.env.WHATSAPP_API_VERSION || "v21.0",
  };
}

function isConfigured() {
  return getConfig() !== null;
}

// Deliver `code` to `phone` over WhatsApp. Resolves to:
//   { ok: true, messageId }
//   { ok: false, error: "NOT_CONFIGURED" | "SEND_FAILED" | "NETWORK", status?, message? }
// Never throws — the caller treats any non-ok as "fall back to SMS".
async function sendWhatsAppOtp(phone, code) {
  const cfg = getConfig();
  if (!cfg) return { ok: false, error: "NOT_CONFIGURED" };

  const to = normalizeMsisdn(phone);
  if (!to) return { ok: false, error: "SEND_FAILED", message: "no recipient" };

  const url = `https://graph.facebook.com/${cfg.version}/${cfg.phoneNumberId}/messages`;
  const body = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "template",
    template: {
      name: cfg.template,
      language: { code: cfg.lang },
      components: [
        // Body variable {{1}} → the code.
        { type: "body", parameters: [{ type: "text", text: String(code) }] },
        // Copy-code button → the code (authentication templates require it).
        {
          type: "button",
          sub_type: "url",
          index: "0",
          parameters: [{ type: "text", text: String(code) }],
        },
      ],
    },
  };

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, error: "NETWORK", message: err.message || String(err) };
  }

  let data;
  try { data = await res.json(); } catch { data = null; }

  if (!res.ok) {
    const message = data?.error?.message || `WhatsApp send failed (${res.status})`;
    console.error(`[WhatsApp OTP] ${res.status}: ${message}`);
    return { ok: false, error: "SEND_FAILED", status: res.status, message };
  }

  const messageId = data?.messages?.[0]?.id || null;
  console.log(`[WhatsApp OTP] sent to ${to} (message_id=${messageId})`);
  return { ok: true, messageId };
}

module.exports = { sendWhatsAppOtp, isConfigured };
