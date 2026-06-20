// Africa's Talking SMS adapter — Kenya, Uganda, Rwanda. Stub: throws a
// not-configured warning until AFRICAS_TALKING_KEY and AFRICAS_TALKING_USER
// are set. Console-prints the message in dev so the OTP is still visible.

async function sendSms(phone, message) {
  if (process.env.NODE_ENV !== "production") {
    console.log(`\n============================`);
    console.log(`📱 OTP SMS (Africa's Talking) → ${phone}`);
    console.log(`   ${message}`);
    console.log(`============================\n`);
  } else {
    console.log(`📱 OTP SMS (Africa's Talking) → ${String(phone).replace(/\d(?=\d{4})/g, "*")}`);
  }

  const apiKey   = process.env.AFRICAS_TALKING_KEY;
  const username = process.env.AFRICAS_TALKING_USER;
  if (!apiKey || !username) {
    console.warn(
      "[AfricasTalking] AFRICAS_TALKING_KEY / AFRICAS_TALKING_USER not set — SMS not sent. Users in KE/UG/RW will only receive OTPs by email until credentials are configured.",
    );
    return;
  }

  // E.164 normalisation — Africa's Talking expects + prefix.
  const to = String(phone).startsWith("+") ? phone : `+${String(phone).replace(/\D/g, "")}`;

  try {
    const params = { username, to, message };
    // Only set a sender ID if one is REGISTERED with Africa's Talking. An
    // unregistered alphanumeric sender is rejected on live in many countries;
    // omitting `from` lets AT use its default/pooled sender so delivery still works.
    if (process.env.AFRICAS_TALKING_SENDER) params.from = process.env.AFRICAS_TALKING_SENDER;

    const base = process.env.AFRICAS_TALKING_BASE || "https://api.africastalking.com/version1/messaging";
    const body = new URLSearchParams(params);
    const res = await fetch(base, {
      method: "POST",
      headers: {
        "apiKey": apiKey,
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json",
      },
      body,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error(`[AfricasTalking error] ${res.status}: ${JSON.stringify(data)}`);
      return;
    }
    console.log(`[AfricasTalking SMS sent] ${JSON.stringify(data?.SMSMessageData?.Recipients || [])}`);
  } catch (err) {
    console.error(`[AfricasTalking error] ${err.message}`);
  }
}

module.exports = { sendSms };
