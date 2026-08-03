const prisma = require("./db");
const crypto = require("crypto");
const nodemailer = require("nodemailer");
const { renderOtpEmail } = require("./emailLayout");

// ── Generate a 6-digit OTP ──────────────────────────────────────────────────
// crypto.randomInt, NOT Math.random: V8's PRNG is xorshift128+, whose internal
// state is recoverable from a modest run of observed outputs. Since an attacker
// can mint codes freely on identifiers they control, a predictable generator
// would leak a victim's next code — including the transfer step-up OTP.
function generateCode() {
  return String(crypto.randomInt(100000, 1000000));
}

// ── OTP at-rest hashing ─────────────────────────────────────────────────────
// Codes are stored as HMAC-SHA256(identifier:code) keyed with JWT_SECRET, never
// in plaintext: a leaked OtpCode table alone can't be used to log in (an
// unsalted hash of a 6-digit code would brute-force offline instantly — the
// server-side secret is what makes the stored value useless to an attacker).
// The plaintext code exists only in the delivery message (WhatsApp/SMS/email).
function hashOtp(identifier, code) {
  return crypto
    .createHmac("sha256", process.env.JWT_SECRET || "kb-otp-pepper")
    .update(`${identifier}:${code}`)
    .digest("hex");
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
    data: { identifier, code: hashOtp(identifier, code), type, expiresAt },
  });
  return code;
}

// ── Verify OTP ──────────────────────────────────────────────────────────────
// Atomic single-use: a conditional UPDATE claims the code in one statement, so
// two concurrent verifications of the same code can't both succeed (the second
// finds used=false no longer true → count 0). The code is single-use precisely
// because exactly one caller can flip used:false → used:true.
// Max wrong guesses before the code is burned. Without this the only limit on
// brute-forcing a 6-digit code was per-IP request rate — defeated by a proxy pool.
const MAX_OTP_ATTEMPTS = 5;

async function verifyOtp(identifier, code, type) {
  const { count } = await prisma.otpCode.updateMany({
    where: {
      identifier,
      code: hashOtp(identifier, code),
      type,
      used: false,
      expiresAt: { gt: new Date() },
      attempts: { lt: MAX_OTP_ATTEMPTS },
    },
    data: { used: true },
  });
  if (count === 1) return true;

  // Miss: charge the attempt against the live code for this identifier+type and
  // burn it once the budget is spent, so guessing can't continue on that code.
  const live = await prisma.otpCode.findFirst({
    where: { identifier, type, used: false, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
    select: { id: true, attempts: true },
  });
  if (live) {
    const attempts = live.attempts + 1;
    await prisma.otpCode.update({
      where: { id: live.id },
      data: { attempts, ...(attempts >= MAX_OTP_ATTEMPTS ? { used: true } : {}) },
    });
    if (attempts >= MAX_OTP_ATTEMPTS) {
      console.warn(
        `[otp] code burned after ${MAX_OTP_ATTEMPTS} failed attempts for ${String(identifier).replace(/.(?=.{4})/g, "*")} (${type})`,
      );
    }
  }
  return false;
}

// Non-consuming check, used by the password-reset UI to validate a code before
// showing the new-password step. It must NOT mark the code used (reset-password
// consumes it) — but it MUST charge failed guesses to the same attempt budget as
// verifyOtp, otherwise it's a free brute-force oracle.
async function peekOtp(identifier, code, type) {
  const hit = await prisma.otpCode.findFirst({
    where: {
      identifier,
      code: hashOtp(identifier, code),
      type,
      used: false,
      expiresAt: { gt: new Date() },
      attempts: { lt: MAX_OTP_ATTEMPTS },
    },
    select: { id: true },
  });
  if (hit) return true;

  const live = await prisma.otpCode.findFirst({
    where: { identifier, type, used: false, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
    select: { id: true, attempts: true },
  });
  if (live) {
    const attempts = live.attempts + 1;
    await prisma.otpCode.update({
      where: { id: live.id },
      data: { attempts, ...(attempts >= MAX_OTP_ATTEMPTS ? { used: true } : {}) },
    });
  }
  return false;
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
    const html = renderOtpEmail(code);
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
      // Country-aware SMS router. Passing the raw code lets the Sendchamp
      // adapter deliver it over WhatsApp first (no DND/sender-ID pitfalls)
      // and fall back to SMS — verification stays local either way.
      const smsRouter = require("./sms");
      await smsRouter.sendSms(identifier, message, { country, otpCode: code });
    }
  }

  return code;
}

module.exports = { dispatchOtp, verifyOtp, peekOtp, sendSms, sendEmail, hashOtp, MAX_OTP_ATTEMPTS };
