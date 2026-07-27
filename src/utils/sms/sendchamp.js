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
  const url = `${base}/sms/send`;
  const payload = JSON.stringify({ to: [to], message, sender_name, route });

  // Retry once on a NETWORK-level failure ("fetch failed" = the request never
  // reached Sendchamp — a transient DNS/connect blip, common right after a cold
  // boot). A real HTTP response (even 4xx/5xx) is NOT retried. On failure we log
  // err.cause (the undici reason: ENOTFOUND / ECONNREFUSED / connect timeout, …),
  // not just "fetch failed", so a persistent problem is diagnosable.
  for (let attempt = 1; attempt <= 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: payload,
        signal: controller.signal,
      });
      clearTimeout(timer);
      const data = await res.json().catch(() => ({}));
      const ok =
        res.ok &&
        (data.status === "success" || String(data.status) === "200" || String(data.code) === "200");
      if (!ok) {
        console.error(`[Sendchamp SMS error] http ${res.status}: ${JSON.stringify(data)}`);
        return; // real response — do not retry
      }
      const id = data?.data?.id || data?.data?.[0]?.id || data?.data?.reference;
      console.log(`[Sendchamp SMS sent]${id ? ` id=${id}` : ""}`);
      return;
    } catch (err) {
      clearTimeout(timer);
      // Dig the full reason out of err.cause (undici wraps the socket error, and
      // when multiple addresses are tried it's an AggregateError with .errors[]).
      const c = err?.cause;
      const parts = [];
      if (c?.code) parts.push(`code=${c.code}`);
      if (c?.name && c.name !== "Error") parts.push(`name=${c.name}`);
      if (c?.message) parts.push(`msg=${c.message}`);
      if (Array.isArray(c?.errors)) {
        parts.push(
          "errors=[" +
            c.errors.map((e) => `${e?.code || e?.name || ""}${e?.address ? "@" + e.address : ""}`).filter(Boolean).join("; ") +
            "]",
        );
      }
      const detail = parts.length ? parts.join(" ") : c ? String(c) : "";
      console.error(
        `[Sendchamp SMS error] attempt ${attempt}/2: ${err.message}${detail ? ` (cause: ${detail})` : ""}`,
      );
      if (attempt < 2) await new Promise((r) => setTimeout(r, 800));
    }
  }
}

module.exports = { sendSms };
