// Sendchamp SMS adapter — Nigeria (and international). Same shape as termii.js:
// KashBook still generates + stores + verifies the OTP itself (utils/otp.js);
// Sendchamp is only the delivery pipe, so switching providers never touches the
// single-use / throttle / expiry guarantees.
//
// API: POST https://api.sendchamp.com/api/v1/sms/send
// Auth: Authorization: Bearer <public/access key>  (Account Settings → API Keys)

// Sendchamp wants international format WITHOUT a leading "+" (e.g. 2348012345678).
function normalizePhoneForSendchamp(phone) {
  if (!phone) return "";
  const digits = String(phone).replace(/\D/g, "");
  if (digits.startsWith("234")) return digits;
  if (digits.length === 11 && digits.startsWith("0")) return "234" + digits.slice(1);
  if (digits.length === 10) return "234" + digits;
  return digits;
}

async function sendSms(phone, message) {
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
  // Registered Sender ID (request one on the dashboard) or Sendchamp's default.
  const sender_name = process.env.SENDCHAMP_SENDER_ID || "Sendchamp";
  // Route: "dnd" is the transactional route that reaches numbers on Nigeria's DND
  // list — REQUIRED for OTP so registered-DND users still get their code. Override
  // with SENDCHAMP_ROUTE ("non_dnd" cheaper but skips DND numbers, "international").
  const route = process.env.SENDCHAMP_ROUTE || "dnd";
  const base = process.env.SENDCHAMP_BASE_URL || "https://api.sendchamp.com/api/v1";

  try {
    const res = await fetch(`${base}/sms/send`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ to: [to], message, sender_name, route }),
    });
    const data = await res.json().catch(() => ({}));
    const ok = res.ok && (data.status === "success" || String(data.code) === "200");
    if (!ok) {
      console.error(`[Sendchamp SMS error] ${res.status}: ${JSON.stringify(data)}`);
      return;
    }
    const id = data?.data?.id || data?.data?.[0]?.id || data?.data?.reference;
    console.log(`[Sendchamp SMS sent]${id ? ` id=${id}` : ""}`);
  } catch (err) {
    console.error(`[Sendchamp SMS error] ${err.message}`);
  }
}

module.exports = { sendSms };
