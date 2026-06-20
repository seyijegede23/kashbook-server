const prisma = require("./db");
const nodemailer = require("nodemailer");

// ── Generate a 6-digit OTP ──────────────────────────────────────────────────
function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// Per-identifier throttle (independent of the per-IP limiter) so one phone/email
// can't be spammed with codes and so a NAT/proxy can't enumerate accounts by
// blasting many identifiers from one IP.
const OTP_MIN_INTERVAL_MS = 30 * 1000; // min gap between codes for an identifier
const OTP_MAX_PER_HOUR = 5;

async function assertOtpQuota(identifier) {
  const now = Date.now();
  const recent = await prisma.otpCode.findMany({
    where: { identifier, createdAt: { gte: new Date(now - 60 * 60 * 1000) } },
    select: { createdAt: true },
    orderBy: { createdAt: "desc" },
  });
  if (recent.length && now - new Date(recent[0].createdAt).getTime() < OTP_MIN_INTERVAL_MS) {
    const err = new Error("Please wait a moment before requesting another code.");
    err.status = 429;
    throw err;
  }
  if (recent.length >= OTP_MAX_PER_HOUR) {
    const err = new Error("Too many code requests. Please try again later.");
    err.status = 429;
    throw err;
  }
}

// ── Save OTP to DB (invalidates previous ones of same type) ────────────────
async function saveOtp(identifier, type) {
  await assertOtpQuota(identifier);
  const code = generateCode();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

  // Invalidate any previous unused OTPs for this identifier + type
  await prisma.otpCode.updateMany({
    where: { identifier, type, used: false },
    data: { used: true },
  });

  await prisma.otpCode.create({
    data: { identifier, code, type, expiresAt },
  });
  return code;
}

// ── Verify OTP ──────────────────────────────────────────────────────────────
// Atomic single-use: a conditional UPDATE claims the code in one statement, so
// two concurrent verifications of the same code can't both succeed (the second
// finds used=false no longer true → count 0). The code is single-use precisely
// because exactly one caller can flip used:false → used:true.
async function verifyOtp(identifier, code, type) {
  const { count } = await prisma.otpCode.updateMany({
    where: {
      identifier,
      code,
      type,
      used: false,
      expiresAt: { gt: new Date() },
    },
    data: { used: true },
  });
  return count === 1;
}

// Termii expects phone numbers in 234XXXXXXXXXX format (no plus, no leading 0)
function normalizePhoneForTermii(phone) {
  if (!phone) return "";
  const digits = String(phone).replace(/\D/g, "");
  if (digits.startsWith("234")) return digits;
  if (digits.length === 11 && digits.startsWith("0")) return "234" + digits.slice(1);
  if (digits.length === 10) return "234" + digits;
  return digits;
}

// ── Send SMS via Termii ─────────────────────────────────────────────────────
async function sendSms(phone, message) {
  // In dev, print the message so the OTP is visible in the console. In
  // production never log the message (contains the code) or the full phone (PII).
  if (process.env.NODE_ENV !== "production") {
    console.log(`\n============================`);
    console.log(`📱 OTP SMS → ${phone}`);
    console.log(`   ${message}`);
    console.log(`============================\n`);
  } else {
    console.log(`📱 OTP SMS → ${String(phone).replace(/\d(?=\d{4})/g, "*")}`);
  }

  const apiKey = process.env.TERMII_API_KEY;
  if (!apiKey) {
    console.warn("[Termii] TERMII_API_KEY not set — SMS not sent");
    return;
  }

  const to = normalizePhoneForTermii(phone);
  // Use a registered Sender ID if available, otherwise Termii's generic default.
  // Unregistered sender IDs will be replaced with "N-Alert" or similar by Termii.
  const from = process.env.TERMII_SENDER_ID || "N-Alert";

  try {
    const res = await fetch("https://v3.api.termii.com/api/sms/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        to,
        from,
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

// ── Send Email via Nodemailer ───────────────────────────────────────────────
async function sendEmail(to, subject, html) {
  const configs = [
    { port: Number(process.env.SMTP_PORT) || 587, secure: false, requireTLS: true },
  ];

  // Deduplicate so we don't retry the same config twice
  const seen = new Set();
  const attempts = configs.filter(({ port, secure }) => {
    const key = `${port}:${secure}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  let lastErr;
  for (const cfg of attempts) {
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: cfg.port,
      secure: cfg.secure,
      requireTLS: cfg.requireTLS ?? false,
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });

    try {
      await transporter.sendMail({ from: process.env.EMAIL_FROM, to, subject, html });
      return; // success
    } catch (err) {
      console.error(`[Nodemailer Error] port ${cfg.port}: ${err.message}`);
      lastErr = err;
    }
  }

  const isTimeout = lastErr?.message?.includes("ETIMEDOUT") || lastErr?.message?.includes("timeout");
  throw new Error(
    isTimeout
      ? "Email server timed out. Check your inbox anyway or try Phone SMS instead."
      : lastErr.message,
  );
}

// ── Dispatch OTP (Save + Send via Email or SMS) ─────────────────────────────
// `country` is an optional ISO 3166-1 alpha-2 code that routes the SMS to
// the right provider (Termii for NG, Africa's Talking for KE/UG/RW, AWS SNS
// for ZA/EG). Email always uses the existing SMTP transport regardless of
// country.
async function dispatchOtp(identifier, type, { country } = {}) {
  const code = await saveOtp(identifier, type);
  const isEmail = identifier.includes("@");
  const message = `Your KashBook verification code is: ${code}. Valid for 10 minutes.`;

  if (isEmail) {
    const html = `
      <!DOCTYPE html>
      <html>
      <head><meta charset="utf-8"><title>KashBook Verification</title></head>
      <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background:#f4f4f5; margin:0; padding:20px 0;">
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;">
          <tr><td align="center" style="padding:20px;">
            <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#fff;border-radius:12px;overflow:hidden;">
              <tr><td style="background:#6C3FC5;padding:32px 40px;text-align:center;">
                <h1 style="color:#fff;margin:0;font-size:28px;font-weight:700;">KashBook</h1>
              </td></tr>
              <tr><td style="padding:40px;color:#3f3f46;line-height:1.6;">
                <p style="margin:0 0 20px;font-size:16px;">Hello,</p>
                <p style="margin:0 0 20px;font-size:16px;">Please use the verification code below to access your KashBook account.</p>
                <table width="100%" cellpadding="0" cellspacing="0" style="margin:32px 0;">
                  <tr><td align="center" style="background:#f3e8ff;border:1px solid #d8b4fe;border-radius:8px;padding:24px;">
                    <span style="font-size:36px;font-weight:800;color:#6C3FC5;letter-spacing:8px;">${code}</span>
                  </td></tr>
                </table>
                <p style="margin:0;font-size:16px;">This code expires in <strong>10 minutes</strong>.</p>
              </td></tr>
              <tr><td style="background:#fafafa;padding:24px 40px;text-align:center;border-top:1px solid #e4e4e7;">
                <p style="margin:0;color:#71717a;font-size:14px;">&copy; ${new Date().getFullYear()} KashBook. All rights reserved.</p>
              </td></tr>
            </table>
          </td></tr>
        </table>
      </body></html>`;
    await sendEmail(identifier, "Your KashBook Verification Code", html);
  } else {
    // Phone identifier: prefer WhatsApp (Meta Cloud API) when it's configured,
    // and fall back to SMS on any failure or when WhatsApp isn't set up. We
    // generated `code` above, so verification (verifyOtp) is identical
    // regardless of which channel delivered it.
    const { sendWhatsAppOtp, isConfigured } = require("./whatsapp");
    let delivered = false;
    if (isConfigured()) {
      const wa = await sendWhatsAppOtp(identifier, code);
      delivered = wa.ok;
      if (!wa.ok) {
        console.warn(`[OTP] WhatsApp delivery failed (${wa.error}) — falling back to SMS`);
      }
    }
    if (!delivered) {
      // Country-aware SMS router; Termii adapter stays available as a direct
      // export for anything that still imports sendSms() from this file.
      const smsRouter = require("./sms");
      await smsRouter.sendSms(identifier, message, { country });
    }
  }

  return code;
}

module.exports = { dispatchOtp, verifyOtp, sendSms, sendEmail };
