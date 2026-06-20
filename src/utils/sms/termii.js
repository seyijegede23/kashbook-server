// Termii SMS adapter — Nigeria. Lifted verbatim from the original
// implementation in utils/otp.js so behaviour is unchanged for NG users.

function normalizePhoneForTermii(phone) {
  if (!phone) return "";
  const digits = String(phone).replace(/\D/g, "");
  if (digits.startsWith("234")) return digits;
  if (digits.length === 11 && digits.startsWith("0")) return "234" + digits.slice(1);
  if (digits.length === 10) return "234" + digits;
  return digits;
}

async function sendSms(phone, message) {
  if (process.env.NODE_ENV !== "production") {
    console.log(`\n============================`);
    console.log(`📱 OTP SMS (Termii) → ${phone}`);
    console.log(`   ${message}`);
    console.log(`============================\n`);
  } else {
    console.log(`📱 OTP SMS (Termii) → ${String(phone).replace(/\d(?=\d{4})/g, "*")}`);
  }

  const apiKey = process.env.TERMII_API_KEY;
  if (!apiKey) {
    console.warn("[Termii] TERMII_API_KEY not set — SMS not sent");
    return;
  }

  const to = normalizePhoneForTermii(phone);
  const from = process.env.TERMII_SENDER_ID || "N-Alert";

  try {
    const res = await fetch("https://v3.api.termii.com/api/sms/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        to, from,
        sms: message,
        type: "plain",
        channel: "generic",
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.code !== "ok") {
      console.error(`[Termii SMS error] ${res.status}: ${JSON.stringify(data)}`);
      return;
    }
    console.log(`[Termii SMS sent] message_id=${data.message_id}`);
  } catch (err) {
    console.error(`[Termii SMS error] ${err.message}`);
  }
}

module.exports = { sendSms };
