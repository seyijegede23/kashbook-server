// AWS SNS SMS adapter — South Africa, Egypt fallback. Stub for Stage 1:
// console-logs the OTP and warns if AWS env vars aren't set. Real SDK
// integration is a Stage 2 task — the cheap fallback (email) covers most
// users in those markets meanwhile.

async function sendSms(phone, message) {
  console.log(`\n============================`);
  console.log(`📱 OTP SMS (AWS SNS) → ${phone}`);
  console.log(`   ${message}`);
  console.log(`============================\n`);

  const key = process.env.AWS_ACCESS_KEY_ID;
  if (!key) {
    console.warn(
      "[AWS SNS] AWS_ACCESS_KEY_ID not set — SMS not sent. Users in ZA/EG will only receive OTPs by email until credentials are configured.",
    );
    return;
  }
  console.warn("[AWS SNS] real SDK not wired in Stage 1; printing only.");
}

module.exports = { sendSms };
