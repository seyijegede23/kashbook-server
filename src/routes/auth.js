const router  = require("express").Router();
const bcrypt  = require("@node-rs/bcrypt"); // native (off-thread) — hash()/verify(); $2a$/$2b$/$2y$ cross-compatible
const { body, validationResult } = require("express-validator");

const prisma         = require("../utils/db");
const cloudinary     = require("../config/cloudinary");
const { signToken }  = require("../utils/jwt");
const { dispatchOtp, verifyOtp, peekOtp, hashOtp, sendEmail } = require("../utils/otp");
const { validateDataUri, IMAGE_TYPES } = require("../utils/uploadGuard");
const authMiddleware = require("../middleware/auth");
const { audit } = require("../utils/audit");
const { verifyTransactionPin } = require("../utils/transactionPin");

// Hard ceiling on what an owner can delegate in a rolling 24h, in the business's
// own currency. Not a security boundary — the owner's AML tier limits are still
// the real ceiling — but a typo guard: an extra zero on a staff member's daily
// limit is a plausible mistake with a very expensive tail.
const MAX_STAFF_DAILY_CAP = 50_000_000;

// Resolve what a user may do, for the CLIENT's benefit only — it decides which
// buttons to render. Enforcement lives in authMiddleware + requirePermission and
// re-runs on every request; nothing here is trusted by the server.
//
// Mirrors authMiddleware exactly, including the employer cross-check and the
// strict === true, because a client that believes it has a capability the server
// refuses produces a button that fails, and a client that believes it lacks one
// produces a feature the owner paid for and cannot find.
const NO_PERMISSIONS = Object.freeze({
  canViewBalance: false, canTransfer: false, canViewReports: false, canManagePayables: false,
});
const ALL_PERMISSIONS = Object.freeze({
  canViewBalance: true, canTransfer: true, canViewReports: true, canManagePayables: true,
});
function resolvePermissions(user) {
  if (String(user.accountType).toUpperCase() !== "STAFF") {
    return { permissions: ALL_PERMISSIONS, dailyTransferCap: null };
  }
  // `undefined` means the caller forgot `include: { staffPermission: true }`,
  // which is different from `null` (loaded, no grant). Both fail closed, but the
  // first is a bug that would look like "permissions don't stick" — say so
  // loudly rather than letting it read as a legitimately empty grant.
  if (user.staffPermission === undefined) {
    console.warn(`[auth] resolvePermissions: staffPermission not loaded for staff ${user.id} — permissions will read as none`);
  }
  const g = user.staffPermission;
  const usable = g && user.employerId && g.employerId === user.employerId ? g : null;
  if (!usable) return { permissions: NO_PERMISSIONS, dailyTransferCap: 0 };
  return {
    permissions: {
      canViewBalance: usable.canViewBalance === true,
      canTransfer: usable.canTransfer === true,
      canViewReports: usable.canViewReports === true,
      canManagePayables: usable.canManagePayables === true,
    },
    dailyTransferCap: Number(usable.dailyTransferCap ?? 0) || 0,
  };
}

// Any endpoint that hands back a whole user object must hand back a COMPLETE
// one. AppContext applies these with `setUser(updatedUser)` — a wholesale
// replace, not a merge — so a payload missing `permissions` doesn't leave the
// old value in place, it erases it. Saving a setting or editing a profile would
// silently strip every granted capability from the running app until the
// ten-minute /auth/me poll restored it.
//
// Also normalises accountType to lower case, because the raw column is "STAFF"
// while every client comparison is against "staff".
function safeUser(user) {
  const { password: _p, transactionPin: _t, transactionPinFailedCount: _c,
          transactionPinLockedUntil: _l, staffPermission: _s, ...safe } = user;
  const { permissions, dailyTransferCap } = resolvePermissions(user);
  return {
    ...safe,
    accountType: String(safe.accountType || "").toLowerCase(),
    hasTransactionPin: !!user.transactionPin,
    permissions,
    dailyTransferCap,
  };
}

// ── Helper: safe user response ────────────────────────────────────────────────
function userResponse(user, token) {
  const { permissions, dailyTransferCap } = resolvePermissions(user);
  return {
    token,
    user: {
      id:           user.id,
      // What this staff member may do, and how much they may move in a rolling
      // 24h before it needs the owner's approval. Owners get every capability
      // and a null cap (the concept doesn't apply to them).
      permissions,
      dailyTransferCap,
      // GET /auth/me returns this but login/register did not, so straight after
      // signing in the client saw `undefined` and sent anyone with a PIN through
      // the "set a PIN" flow on their first transfer — until the 10-minute
      // refresh happened to correct it.
      hasTransactionPin: !!user.transactionPin,
      firstName:    user.firstName,
      lastName:     user.lastName,
      businessName: user.businessName,
      email:        user.email,
      phone:        user.phone,
      plan:         user.plan,
      role:         user.role,
      accountType:  user.accountType.toLowerCase(),
      employerId:   user.employerId ?? null,
      avatarUrl:    user.avatarUrl,
      profileImage: user.profileImage ?? null,
      settings: {
        language:             user.language             ?? "en",
        currency:             user.currency             ?? "NGN",
        notificationsEnabled: user.notificationsEnabled ?? true,
        biometricEnabled:     user.biometricEnabled     ?? false,
      },
    },
  };
}

// Normalise a phone number to E.164. If the user picked a country at
// registration / login, the client passes its calling code so 0-prefixed
// local numbers route to the correct country. Falls back to +234 (Nigeria)
// when no calling code is provided — preserves legacy single-country
// behaviour for existing routes that don't yet pass it.
function normalizePhone(phone = "", callingCode = "234") {
  const p = phone.replace(/\s+/g, "").trim();
  if (p.startsWith("+")) return p;
  const cc = String(callingCode || "234").replace(/^\+/, "");
  if (p.startsWith("0")) return `+${cc}${p.slice(1)}`;
  return p;
}

function splitName(fullName = "") {
  const parts = fullName.trim().split(/\s+/);
  return { firstName: parts[0] || "", lastName: parts.slice(1).join(" ") || parts[0] || "" };
}

async function ensurePrimaryBusiness(userId, businessName, country) {
  // Serialize per user + re-check inside the lock so two concurrent callers
  // (e.g. register and a racing OTP-verify) can't both pass the existence check
  // and create duplicate primary businesses.
  return prisma.withBusinessLock(userId, async () => {
    const exists = await prisma.business.findFirst({ where: { userId } });
    if (exists) return;
    const { getCountryConfig } = require("../config/countries");
    const cfg = getCountryConfig(country || "NG");
    await prisma.business.create({
      data: {
        userId,
        name: businessName,
        emoji: "🛍️",
        color: "#6C3FC5",
        country: cfg.code,
        baseCurrency: cfg.currency.code,
      },
    });
  });
}

// ─────────────────────────────────────────────
// POST /auth/register
// ─────────────────────────────────────────────
// Password strength is enforced HERE, not only in the app. The signup screen
// shows the same five rules live, but a client is not a control: anything that
// posts straight to this endpoint would otherwise set a one-character password
// on an account that holds a real bank balance.
//
// Deliberately NOT applied to login or to existing accounts: 15 users already
// have passwords predating this, and rejecting them at login would lock them out
// of their own money. Existing accounts upgrade when they next reset.
const PASSWORD_RULES = [
  { test: (v) => v.length >= 8,        message: "at least 8 characters" },
  { test: (v) => /[A-Z]/.test(v),      message: "an uppercase letter" },
  { test: (v) => /[a-z]/.test(v),      message: "a lowercase letter" },
  { test: (v) => /[0-9]/.test(v),      message: "a number" },
  { test: (v) => /[^A-Za-z0-9]/.test(v), message: "a special character" },
];

function passwordProblems(password = "") {
  return PASSWORD_RULES.filter((r) => !r.test(String(password))).map((r) => r.message);
}

router.post("/register", body("password").custom((v) => {
  const missing = passwordProblems(v);
  if (missing.length) throw new Error(`Password needs ${missing.join(", ")}`);
  return true;
}), async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { firstName, middleName, lastName, name, businessName, email, password, phone, identifier, otpCode, country, callingCode, gender, referredByCode, marketingOptIn } = req.body;
  const fn  = firstName?.trim() || splitName(name).firstName;
  const ln  = lastName?.trim()  || splitName(name).lastName;
  const biz = businessName?.trim() || "My Business";
  const rawIdentifier = identifier || email || phone || "";
  const isEmail = rawIdentifier.includes("@");
  const iden = isEmail ? rawIdentifier.trim().toLowerCase() : normalizePhone(rawIdentifier, callingCode);
  // Country is the source of truth for currency + language + KYC scheme.
  // Every country we hold config for can register and keep books; whether we can
  // also issue them a LOCAL receiving account is a separate question answered by
  // supportsLocalAccount(). A country we hold no config for is still refused
  // rather than silently rewritten to NG, which would hand that merchant naira,
  // Nigerian AML limits and a KYC form demanding a BVN they cannot hold.
  const { getCountryConfig, isSupported, listEnabledCountries } = require("../config/countries");
  let countryCode = "NG";
  if (country) {
    if (!isSupported(country)) {
      return res.status(400).json({
        code: "COUNTRY_NOT_SUPPORTED",
        error: `KashBook isn't available in that country yet. Available in: ${listEnabledCountries().map((c) => c.name).join(", ")}.`,
      });
    }
    countryCode = String(country).toUpperCase();
  }
  const countryCfg = getCountryConfig(countryCode);

  if (!fn)      return res.status(400).json({ error: "First name is required" });
  if (!iden)    return res.status(400).json({ error: "Email or phone number is required" });
  if (!otpCode) return res.status(400).json({ error: "Verification code is required" });

  // SECURITY: the OTP purpose is pinned server-side. Letting the caller choose
  // (req.body.type) meant any code issued for ANY purpose — a password-reset
  // code, a transfer step-up code — counted as proof of registration.
  const otpValid = await verifyOtp(iden, otpCode, "phone_register");
  if (!otpValid) return res.status(400).json({ error: "Invalid or expired verification code" });

  try {
    // Check BOTH channels, not just the one the OTP was sent to.
    //
    // Registration now collects an email AND a phone number, so the *other*
    // channel can collide with an existing account. Checking only the identifier
    // let that through to user.create, where the unique index threw P2002 and
    // became a generic "account already exists" — after the user had already
    // spent their verification code, and without saying which field was the
    // problem. P2002 is still handled below as the race backstop.
    const cleanEmail = email?.includes("@") ? email.trim().toLowerCase() : (isEmail ? iden : null);
    const cleanPhone = phone ? normalizePhone(phone, callingCode || countryCfg.callingCode) : (isEmail ? null : iden);

    const clash = await prisma.user.findFirst({
      where: { OR: [cleanEmail ? { email: cleanEmail } : null, cleanPhone ? { phone: cleanPhone } : null].filter(Boolean) },
      select: { email: true, phone: true },
    });
    if (clash) {
      const onEmail = cleanEmail && clash.email === cleanEmail;
      return res.status(409).json({
        code: "ACCOUNT_EXISTS",
        field: onEmail ? "email" : "phone",
        error: onEmail
          ? "An account with this email already exists. Please log in or reset your password."
          : "An account with this phone number already exists. Please log in or reset your password.",
      });
    }
    // SECURITY: registration must NEVER mutate an existing account. It used to
    // fall through for passwordless rows (social-login/legacy users) and
    // overwrite their name, business and password — outright takeover. Any
    // existing identifier is a conflict, handled by the clash check above;
    // recovery belongs to forgot-password, never to register.

    const hashed = await bcrypt.hash(password, 12);
    // Both channels are stored when supplied. The verified identifier is always
    // one of them; the second is unverified at this point but gives the account a
    // recovery route if the first is ever lost.
    const data = { firstName: fn, lastName: ln, businessName: biz, password: hashed };
    if (cleanEmail) data.email = cleanEmail;
    if (cleanPhone) data.phone = cleanPhone;
    // Legal middle name, as printed on the ID. Optional: many Nigerian IDs carry
    // none, and Anchor/Fincra KYC match on first + last.
    if (middleName?.trim()) data.middleName = middleName.trim();
    // Collected at signup because KYC needs it later; asking once here beats
    // interrupting the merchant mid-onboarding for it.
    if (gender && ["male", "female", "other"].includes(String(gender).toLowerCase())) {
      data.gender = String(gender).toLowerCase();
    }
    // Stored raw and UNVALIDATED — nothing consumes it yet. Capped so a pasted
    // essay cannot bloat the row.
    if (referredByCode?.trim()) data.referredByCode = referredByCode.trim().slice(0, 32);
    // Consent records. Terms acceptance is stamped server-side rather than taking
    // a client timestamp, so the record reflects when we actually created the
    // account. Marketing defaults to false: silence is never consent.
    data.marketingOptIn = marketingOptIn === true;
    data.termsAcceptedAt = new Date();
    // Currency is derived from country — country is the lock.
    data.country  = countryCode;
    data.currency = countryCfg.currency.code;
    data.language = countryCfg.language;

    // Create only — the update branch was the takeover path (see the 409 above).
    // A race on the unique index surfaces as P2002 and is handled below.
    const user = await prisma.user.create({ data });

    await ensurePrimaryBusiness(user.id, biz, countryCode);
    const token = signToken({ userId: user.id, tokenVersion: user.tokenVersion ?? 0 });
    res.status(201).json(userResponse(user, token));
  } catch (err) {
    // Concurrent signups with the same identifier: report the conflict, not a 500.
    if (err.code === "P2002") {
      return res.status(409).json({
        error: "An account with these details already exists. Please log in or reset your password.",
        code: "ACCOUNT_EXISTS",
      });
    }
    console.error(err);
    res.status(500).json({ error: "Registration failed" });
  }
});

// ─────────────────────────────────────────────
// POST /auth/login
// ─────────────────────────────────────────────
router.post("/login", body("identifier").notEmpty(), body("password").notEmpty(), async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { identifier, password } = req.body;
  try {
    const isEmailLike = identifier.includes("@");
    const user = await prisma.user.findFirst({
      where: isEmailLike ? { email: identifier.trim().toLowerCase() } : { phone: normalizePhone(identifier) },
      // Staff log in here too, and userResponse reports what they may do. Without
      // this the app would open with every capability hidden until the 10-minute
      // /auth/me poll corrected it.
      include: { staffPermission: true },
    });
    if (!user) return res.status(401).json({ error: "Invalid credentials" });
    if (!user.password) {
      // Legacy users who signed up via Google/Apple before social sign-in
      // was removed don't have a password. Steer them to the OTP-based
      // password-set flow rather than locking them out.
      return res.status(401).json({
        code: "PASSWORD_NOT_SET",
        error: "Reset your password to continue using this account",
        identifier: isEmailLike ? user.email : user.phone,
      });
    }

    // ── Account lockout check ────────────────────────────────────────────
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      const secsLeft = Math.ceil((user.lockedUntil - Date.now()) / 1000);
      return res.status(429).json({ error: `Account locked. Try again in ${secsLeft} seconds.` });
    }

    const valid = await bcrypt.verify(password, user.password);
    if (!valid) {
      const attempts = user.failedLoginAttempts + 1;
      // Lock for 15 min after 10 failed attempts
      const lockedUntil = attempts >= 10 ? new Date(Date.now() + 15 * 60 * 1000) : null;
      await prisma.user.update({
        where: { id: user.id },
        data: { failedLoginAttempts: attempts, ...(lockedUntil ? { lockedUntil } : {}) },
      });
      await audit({
        req,
        action: "LOGIN_FAILED",
        resourceType: "user",
        resourceId: user.id,
        severity: lockedUntil ? "alert" : "warn",
        actorOverride: { type: "user", id: user.id },
        metadata: { attempts, locked: !!lockedUntil },
      });
      if (lockedUntil) return res.status(429).json({ error: "Too many failed attempts. Account locked for 15 minutes." });
      return res.status(401).json({ error: "Invalid credentials" });
    }

    // Successful login — reset counter
    await prisma.user.update({
      where: { id: user.id },
      data: { failedLoginAttempts: 0, lockedUntil: null },
    });

    await audit({
      req,
      action: "LOGIN_SUCCESS",
      resourceType: "user",
      resourceId: user.id,
      actorOverride: { type: "user", id: user.id },
    });

    const token = signToken({ userId: user.id, tokenVersion: user.tokenVersion ?? 0 });
    res.json(userResponse(user, token));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Login failed" });
  }
});

// ─────────────────────────────────────────────
// POST /auth/send-otp
// ─────────────────────────────────────────────
// SECURITY: this endpoint is UNAUTHENTICATED, so the OTP purpose must be
// allowlisted. A caller-chosen `type` let anyone mint an `email_change` /
// `phone_change` / `TRANSFER_STEP_UP` code for an identifier they control and
// then drive the matching confirm endpoint — bypassing the password re-auth on
// the request step entirely. Only signup/reset codes may originate here;
// identifier-change codes are issued exclusively by request-*-change (which
// verifies the current password), and step-up codes only by the transfer flow.
const SENDABLE_OTP_TYPES = new Set(["phone_register", "phone_reset"]);

router.post("/send-otp", async (req, res) => {
  const { phone, email, identifier, type = "phone_register" } = req.body;
  const rawIden = identifier || email || phone || "";
  if (!rawIden) return res.status(400).json({ error: "Identifier required" });
  if (!SENDABLE_OTP_TYPES.has(type))
    return res.status(400).json({ error: "Unsupported verification type" });
  const iden = rawIden.includes("@") ? rawIden.trim().toLowerCase() : normalizePhone(rawIden);
  try {
    await dispatchOtp(iden, type);
    res.json({ message: "OTP sent" });
  } catch (err) {
    if (err.status === 429) return res.status(429).json({ error: err.message });
    console.error("send-otp error:", err.message ?? err);
    res.status(500).json({ error: "Failed to send verification code. Please try again." });
  }
});

// ─────────────────────────────────────────────
// POST /auth/check-otp (validates without consuming)
// ─────────────────────────────────────────────
// SECURITY: this endpoint deliberately does NOT consume the code (reset-password
// does), which made it a free brute-force oracle. Two containments:
//   1. `type` is no longer caller-chosen across all purposes — only the reset
//      flow the app actually uses. It can never probe email_change, phone_change
//      or TRANSFER_STEP_UP codes.
//   2. peekOtp charges every miss to the same 5-attempt budget as verifyOtp, so
//      guessing here burns the code exactly as it would anywhere else.
const CHECKABLE_OTP_TYPES = new Set(["phone_reset"]);

router.post("/check-otp", async (req, res) => {
  const { phone, email, identifier, code, type = "phone_reset" } = req.body;
  const rawIden = identifier || email || phone || "";
  if (!rawIden || !code) return res.status(400).json({ error: "Identifier and code required" });
  if (!CHECKABLE_OTP_TYPES.has(type))
    return res.status(400).json({ error: "Invalid or expired code" });
  const iden = rawIden.includes("@") ? rawIden.trim().toLowerCase() : normalizePhone(rawIden);
  const valid = await peekOtp(iden, code, type);
  if (!valid) return res.status(400).json({ error: "Invalid or expired code" });
  res.json({ valid: true });
});

// ─────────────────────────────────────────────
// POST /auth/verify-otp (legacy)
// ─────────────────────────────────────────────
router.post("/verify-otp", async (req, res) => {
  const { phone, email, identifier, code, name, businessName } = req.body;
  const rawIden = identifier || email || phone || "";
  if (!rawIden || !code) return res.status(400).json({ error: "Identifier and code required" });
  const isEmail = rawIden.includes("@");
  const iden = isEmail ? rawIden.trim().toLowerCase() : normalizePhone(rawIden);
  try {
    const valid = await verifyOtp(iden, code, "phone_register");
    if (!valid) return res.status(400).json({ error: "Invalid or expired code" });
    const { firstName, lastName } = splitName(name || "KashBook User");
    let user = await prisma.user.findFirst({
      where: isEmail ? { email: iden } : { phone: iden },
      include: { staffPermission: true }, // an existing staff account can sign in this way too
    });
    if (!user) {
      user = await prisma.user.create({
        data: { firstName, lastName, businessName: businessName?.trim() || "My Business",
          ...(isEmail ? { email: iden } : { phone: iden }) },
      });
    }
    await ensurePrimaryBusiness(user.id, user.businessName || "My Business");
    const token = signToken({ userId: user.id, tokenVersion: user.tokenVersion ?? 0 });
    res.json(userResponse(user, token));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "OTP verification failed" });
  }
});

// ─────────────────────────────────────────────
// POST /auth/forgot-password
// ─────────────────────────────────────────────
router.post("/forgot-password", async (req, res) => {
  const { phone, email, identifier } = req.body;
  const rawIden = identifier || email || phone || "";
  if (!rawIden) return res.status(400).json({ error: "Identifier required" });
  const isEmail = rawIden.includes("@");
  const iden = isEmail ? rawIden.trim().toLowerCase() : normalizePhone(rawIden);
  try {
    const user = await prisma.user.findFirst({ where: isEmail ? { email: iden } : { phone: iden } });
    // Respond identically and immediately whether or not the account exists, then
    // dispatch the code AFTER responding — so neither the message nor the response
    // time (SMS/email latency) reveals which identifiers are registered.
    res.json({ message: "If that account exists, a reset code was sent." });
    if (user) {
      dispatchOtp(iden, "phone_reset").catch((e) =>
        console.error("[forgot-password] dispatch failed:", e.message),
      );
    }
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: "Failed to process request" });
  }
});

// ─────────────────────────────────────────────
// POST /auth/reset-password
// ─────────────────────────────────────────────
router.post("/reset-password", async (req, res) => {
  const { phone, email, identifier, code, newPassword } = req.body;
  const rawIden = identifier || email || phone || "";
  if (!rawIden || !code || !newPassword) return res.status(400).json({ error: "Identifier, code and newPassword required" });
  if (newPassword.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters" });
  const isEmail = rawIden.includes("@");
  const iden = isEmail ? rawIden.trim().toLowerCase() : normalizePhone(rawIden);
  try {
    const valid = await verifyOtp(iden, code, "phone_reset");
    if (!valid) return res.status(400).json({ error: "Invalid or expired code" });
    await prisma.user.updateMany({
      where: isEmail ? { email: iden } : { phone: iden },
      // Bump tokenVersion so any tokens issued before the reset stop working.
      data: { password: await bcrypt.hash(newPassword, 12), tokenVersion: { increment: 1 } },
    });
    res.json({ message: "Password updated successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to reset password" });
  }
});

// ─────────────────────────────────────────────
// GET /auth/me
// ─────────────────────────────────────────────
router.get("/me", authMiddleware, async (req, res) => {
  try {
    // This is the endpoint the client re-polls every 10 minutes, so it is also
    // how a revoked permission reaches a running app.
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      include: { staffPermission: true },
    });
    if (!user) return res.status(404).json({ error: "User not found" });
    // Strip raw secret-like fields before sending the user object.
    const { password: _, transactionPin: _pin, transactionPinFailedCount: _c, transactionPinLockedUntil: _l, staffPermission: _sp, ...safe } = user;
    const { permissions, dailyTransferCap } = resolvePermissions(user);
    res.json({
      user: {
        ...safe,
        permissions,
        dailyTransferCap,
        hasTransactionPin: !!user.transactionPin,
        accountType: safe.accountType.toLowerCase(),
        settings: {
          language: safe.language,
          currency: safe.currency,
          notificationsEnabled: safe.notificationsEnabled,
          biometricEnabled: safe.biometricEnabled,
        },
      },
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch user" });
  }
});

// ─────────────────────────────────────────────
// PATCH /auth/push-token
// ─────────────────────────────────────────────
router.patch("/push-token", authMiddleware, async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: "token required" });
  // Must be a real Expo push token — we POST it to exp.host, so an arbitrary
  // string/URL here would be an SSRF / data-exfil vector.
  if (!/^ExponentPushToken\[[A-Za-z0-9_-]+\]$/.test(token)) {
    return res.status(400).json({ error: "invalid push token" });
  }
  try {
    // A device token belongs to exactly ONE account — whoever logged in on
    // the device last. Without this, every account ever used on a shared
    // device keeps the token and a broadcast hits that device once per
    // account (observed: one phone receiving 6 copies).
    await prisma.user.updateMany({
      where: { expoPushToken: token, NOT: { id: req.user.id } },
      data: { expoPushToken: null },
    });
    await prisma.user.update({ where: { id: req.user.id }, data: { expoPushToken: token } });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to save push token" });
  }
});

// ─────────────────────────────────────────────
// Transaction PIN (4-digit) — required before outbound transfers.
// Locked for 15 min after 5 consecutive failures.
// ─────────────────────────────────────────────
const { PIN_REGEX } = require("../utils/transactionPin");

// POST /auth/set-pin   body: { password, pin }
// Used both for first-time setup AND to overwrite an existing PIN — password
// is the source of truth for the user's identity so we always require it.
router.post("/set-pin", authMiddleware, async (req, res) => {
  const { password, pin } = req.body;
  if (!password) return res.status(400).json({ error: "Password is required" });
  if (!PIN_REGEX.test(String(pin || "")))
    return res.status(400).json({ error: "PIN must be 4 digits" });
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user) return res.status(404).json({ error: "User not found" });
    if (!user.password)
      return res.status(400).json({ error: "Set a password first to enable PIN" });
    const valid = await bcrypt.verify(password, user.password);
    if (!valid) return res.status(401).json({ error: "Password is incorrect" });
    await prisma.user.update({
      where: { id: req.user.id },
      data: {
        transactionPin: await bcrypt.hash(String(pin), 10),
        transactionPinFailedCount: 0,
        transactionPinLockedUntil: null,
      },
    });
    await audit({
      req,
      action: "PIN_SET",
      resourceType: "user",
      resourceId: req.user.id,
      severity: "warn",
    });
    res.json({ message: "Transaction PIN set" });
  } catch (err) {
    console.error("[set-pin]", err);
    res.status(500).json({ error: "Failed to set PIN" });
  }
});

// ─────────────────────────────────────────────
// POST /auth/change-password
// ─────────────────────────────────────────────
router.post("/change-password", authMiddleware, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: "currentPassword and newPassword are required" });
  if (newPassword.length < 8) return res.status(400).json({ error: "New password must be at least 8 characters" });
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user) return res.status(404).json({ error: "User not found" });
    if (!user.password) {
      return res.status(400).json({
        code: "PASSWORD_NOT_SET",
        error: "No password is set on this account. Use the forgot-password flow to set one.",
      });
    }
    const match = await bcrypt.verify(currentPassword, user.password);
    if (!match) return res.status(401).json({ error: "Current password is incorrect" });
    await prisma.user.update({
      where: { id: req.user.id },
      // Invalidate every existing token (incl. other devices) on password change.
      data: { password: await bcrypt.hash(newPassword, 12), tokenVersion: { increment: 1 } },
    });
    res.json({ message: "Password updated successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to change password" });
  }
});

// ─────────────────────────────────────────────
// POST /auth/logout — sign out of ALL devices (bumps tokenVersion so every
// previously-issued JWT is rejected by authMiddleware on its next use).
// ─────────────────────────────────────────────
router.post("/logout", authMiddleware, async (req, res) => {
  try {
    await prisma.user.update({
      where: { id: req.user.id },
      data: { tokenVersion: { increment: 1 } },
    });
    await audit({ req, action: "LOGOUT_ALL", resourceType: "user", resourceId: req.user.id });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to log out" });
  }
});

// ─────────────────────────────────────────────
// POST /auth/delete-account — permanent, self-service (app-store requirement).
// Fintech deletion = anonymize the PERSON, retain the LEDGER: financial and
// KYC records stay (CBN/AML retention) but become unreachable — credentials
// are scrambled, every session (incl. staff) is revoked, businesses close,
// and social connections (IG/WA) are severed so webhooks stop routing.
// Refuses while any business NUBAN still holds funds (fail-closed if the
// balance can't be verified).
// ─────────────────────────────────────────────
router.post("/delete-account", authMiddleware, async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: "Enter your password to confirm." });
  try {
    if (req.user.accountType === "staff") {
      return res.status(403).json({ error: "Staff accounts are removed by the business owner from Staff Management." });
    }
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user) return res.status(404).json({ error: "User not found" });
    if (!user.password) {
      return res.status(400).json({ error: "Set a password first (use Forgot password), then try again." });
    }
    const match = await bcrypt.verify(password, user.password);
    if (!match) return res.status(401).json({ error: "Password is incorrect." });

    // Money-out guard: never delete around a bank balance. Fincra pools all VAs
    // into one merchant wallet, so a Fincra business's cash-at-bank is its ledger
    // (providerAccountId + pooledWallet), while Anchor exposes a per-account
    // balance. Cover BOTH — a fail-closed guard that skipped Fincra would let a
    // funded business be deleted (fail-open).
    const businesses = await prisma.business.findMany({
      where: { userId: user.id },
      select: { id: true, name: true, country: true, anchorAccountId: true, providerAccountId: true, baseCurrency: true },
    });
    const anchor = require("../utils/anchor");
    const { getProvider } = require("../providers");
    const { computeLedgerBalance } = require("../utils/ledgerBalance");
    for (const biz of businesses.filter((b) => b.providerAccountId || b.anchorAccountId)) {
      try {
        const provider = getProvider(biz);
        const balance = provider.pooledWallet
          ? await computeLedgerBalance(biz.id, biz.baseCurrency || "NGN")
          : (await anchor.getAccountBalance(biz.anchorAccountId)).balance;
        if (balance > 0) {
          return res.status(400).json({
            code: "BALANCE_REMAINING",
            error: `${biz.name} still has money in its bank account. Transfer it out first, then delete your account.`,
          });
        }
      } catch (err) {
        if (err.code === "ANCHOR_NOT_CONFIGURED") continue; // no live banking in this environment
        return res.status(503).json({ error: "We couldn't verify your bank balance right now — try again in a few minutes." });
      }
    }

    const crypto = require("crypto");
    const scrambledPw = await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 12);
    const stamp = (id) => `deleted_${id.slice(0, 8)}_${Date.now()}`;
    const staff = await prisma.user.findMany({
      where: { employerId: user.id },
      select: { id: true },
    });

    await prisma.$transaction([
      prisma.user.update({
        where: { id: user.id },
        data: {
          firstName: "Deleted",
          lastName: "User",
          email: `${stamp(user.id)}@deleted.invalid`,
          phone: stamp(user.id),
          password: scrambledPw,
          transactionPin: null,
          expoPushToken: null,
          profileImage: null,
          avatarUrl: null,
          plan: "FREE",
          accountStatus: "closed",
          tokenVersion: { increment: 1 },
        },
      }),
      // Staff logins die with the owner — scramble each (unique email/phone
      // need per-row values; otherwise a staff password-reset via OTP would
      // reopen access to the retained books).
      ...staff.map((s) =>
        prisma.user.update({
          where: { id: s.id },
          data: {
            email: `${stamp(s.id)}@deleted.invalid`,
            phone: stamp(s.id),
            password: scrambledPw,
            expoPushToken: null,
            accountStatus: "closed",
            tokenVersion: { increment: 1 },
          },
        }),
      ),
      prisma.business.updateMany({
        where: { userId: user.id },
        data: {
          accountStatus: "closed",
          instagramAccessToken: null,
          igConnectionStatus: "disconnected",
          waAccessToken: null,
          waPhoneNumberId: null,
        },
      }),
    ]);
    await audit({ req, action: "ACCOUNT_DELETED", resourceType: "user", resourceId: user.id });
    res.json({ ok: true });
  } catch (err) {
    console.error("[delete-account]", err.message);
    res.status(500).json({ error: "Failed to delete the account — try again." });
  }
});

// ─────────────────────────────────────────────
// PATCH /auth/profile
// ─────────────────────────────────────────────
router.patch("/profile", authMiddleware, async (req, res) => {
  const { firstName, lastName, businessName, profileImage, dateOfBirth, gender } = req.body;
  // Staff can update their own name/photo, but identity and business fields
  // belong to the owner — strip them rather than failing the whole save.
  const isStaff = req.user.accountType === "staff";
  // SECURITY: email/phone are DELIBERATELY not settable here. They are the
  // account-recovery identifiers — letting a bearer token rewrite them turns any
  // stolen/borrowed session into permanent account takeover (change email →
  // forgot-password → reset). Identifier changes must go through
  // request-/confirm-email-change and request-/confirm-phone-change, which
  // verify an OTP AND the current password, and revoke every existing session.
  try {
    const data = {};
    if (firstName)                 data.firstName    = firstName.trim();
    if (lastName)                  data.lastName     = lastName.trim();
    if (businessName && !isStaff)  data.businessName = businessName.trim();
    if (profileImage !== undefined) data.profileImage = profileImage;
    if (dateOfBirth !== undefined) {
      const dob = dateOfBirth ? new Date(dateOfBirth) : null;
      if (dob && isNaN(dob.getTime()))
        return res.status(400).json({ error: "Invalid dateOfBirth" });
      data.dateOfBirth = dob;
    }
    if (gender !== undefined) {
      if (gender !== null && !["Male", "Female"].includes(gender))
        return res.status(400).json({ error: "gender must be 'Male' or 'Female'" });
      data.gender = gender;
    }

    // Business name is editable normally (individual KYC — the name is just the
    // virtual-account display label, not bound to a verified KYB identity).

    const user = await prisma.user.update({
      where: { id: req.user.id },
      data,
      include: { staffPermission: true },
    });
    res.json({ user: safeUser(user) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update profile" });
  }
});

// ─────────────────────────────────────────────
// PATCH /auth/profile-image
// ─────────────────────────────────────────────
router.patch("/profile-image", authMiddleware, async (req, res) => {
  const { profileImage } = req.body;
  try {
    await prisma.user.update({ where: { id: req.user.id }, data: { profileImage: profileImage ?? null } });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to save profile image" });
  }
});

// ─────────────────────────────────────────────
// POST /auth/upload-avatar
// ─────────────────────────────────────────────
router.post("/upload-avatar", authMiddleware, async (req, res) => {
  const { imageBase64 } = req.body;
  try {
    let profileImage = null;
    if (imageBase64) {
      // Public by design (avatars render in-app), but validated: real image
      // types only, size-capped, and never a remote URL for Cloudinary to fetch.
      let meta;
      try {
        meta = validateDataUri(imageBase64, { allow: IMAGE_TYPES, maxBytes: 3 * 1024 * 1024 });
      } catch (e) {
        return res.status(e.httpStatus || 400).json({ error: e.message, code: e.code });
      }
      const result = await cloudinary.uploader.upload(imageBase64, {
        folder: "kashbook/avatars", public_id: `user_${req.user.id}`, overwrite: true,
        resource_type: meta.resourceType,
        // Strip EXIF/GPS: a photographed document can carry the location it was
        // taken, which we have no reason to store or serve.
        image_metadata: false,
        allowed_formats: ["png", "jpg", "jpeg", "webp"],
        transformation: [{ width: 400, height: 400, crop: "fill", gravity: "face" }],
      });
      profileImage = result.secure_url;
    } else {
      await cloudinary.uploader.destroy(`kashbook/avatars/user_${req.user.id}`).catch(() => {});
    }
    const user = await prisma.user.update({ where: { id: req.user.id }, data: { profileImage } });
    res.json({ profileImage: user.profileImage });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to upload avatar" });
  }
});

// ─────────────────────────────────────────────
// PATCH /auth/settings
// ─────────────────────────────────────────────
router.patch("/settings", authMiddleware, async (req, res) => {
  const { language, currency, notificationsEnabled, biometricEnabled, autoDebitEnabled } = req.body;
  try {
    const data = {};
    if (language             !== undefined) data.language             = language;
    // Currency is locked to country — silently normalize any incoming value
    // back to the country's currency so a stale client can't drift the row.
    if (currency !== undefined) {
      const { getBaseCurrency } = require("../config/countries");
      const me = await prisma.user.findUnique({ where: { id: req.user.id }, select: { country: true } });
      data.currency = getBaseCurrency(me?.country);
    }
    if (notificationsEnabled !== undefined) data.notificationsEnabled = notificationsEnabled;
    if (biometricEnabled     !== undefined) data.biometricEnabled     = biometricEnabled;
    if (autoDebitEnabled     !== undefined) data.autoDebitEnabled     = !!autoDebitEnabled;
    const user = await prisma.user.update({
      where: { id: req.user.id },
      data,
      include: { staffPermission: true },
    });
    res.json({ user: safeUser(user) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to save settings" });
  }
});

// ─────────────────────────────────────────────
// POST /auth/verify-password
// Confirms the user's current password (used before sensitive changes)
// ─────────────────────────────────────────────
router.post("/verify-password", authMiddleware, async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: "Password required" });
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user?.password) return res.status(400).json({ error: "No password set on this account" });
    const match = await bcrypt.verify(password, user.password);
    if (!match) return res.status(401).json({ error: "Incorrect password" });
    res.json({ verified: true });
  } catch (err) {
    res.status(500).json({ error: "Verification failed" });
  }
});

// ─────────────────────────────────────────────
// POST /auth/request-email-change
// Sends OTP to the new email address
// ─────────────────────────────────────────────
router.post("/request-email-change", authMiddleware, async (req, res) => {
  if (req.user.accountType === "staff")
    return res.status(403).json({ error: "Only the business owner can change account details.", code: "STAFF_FORBIDDEN" });
  const { newEmail, currentPassword } = req.body;
  if (!newEmail?.includes("@")) return res.status(400).json({ error: "Valid email required" });
  const email = newEmail.trim().toLowerCase();
  try {
    // Re-authenticate: the OTP only proves control of the NEW address (which an
    // attacker holding a stolen token owns). The password proves it's the owner.
    const me = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!me) return res.status(404).json({ error: "Account not found" });
    // Legacy rows with no password (social/OTP-only signups) can't be asked for
    // one — tell them to set a password rather than locking them out forever.
    if (!me.password)
      return res.status(403).json({
        error: "Set a password first, then you can change your email or phone number.",
        code: "PASSWORD_NOT_SET",
      });
    if (!currentPassword || !(await bcrypt.verify(currentPassword, me.password)))
      return res.status(401).json({ error: "Current password is incorrect", code: "PASSWORD_REQUIRED" });
    const existing = await prisma.user.findFirst({ where: { email } });
    if (existing && existing.id !== req.user.id)
      return res.status(409).json({ error: "Email already in use" });
    await dispatchOtp(email, "email_change");
    res.json({ message: "Verification code sent" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to send verification code" });
  }
});

// ─────────────────────────────────────────────
// PATCH /auth/confirm-email-change
// Verifies OTP and updates the email
// ─────────────────────────────────────────────
router.patch("/confirm-email-change", authMiddleware, async (req, res) => {
  if (req.user.accountType === "staff")
    return res.status(403).json({ error: "Only the business owner can change account details.", code: "STAFF_FORBIDDEN" });
  const { newEmail, otpCode } = req.body;
  if (!newEmail?.includes("@") || !otpCode)
    return res.status(400).json({ error: "Email and verification code required" });
  const email = newEmail.trim().toLowerCase();
  try {
    const valid = await verifyOtp(email, otpCode, "email_change");
    if (!valid) return res.status(400).json({ error: "Invalid or expired code" });
    const before = await prisma.user.findUnique({ where: { id: req.user.id }, select: { email: true } });
    // Revoke every existing session on an identifier change — a token stolen
    // before the change must not survive it.
    const user = await prisma.user.update({
      where: { id: req.user.id },
      data: { email, tokenVersion: { increment: 1 } },
    });
    // Tell the OLD address, so an unauthorised change is visible to the real owner.
    if (before?.email && before.email !== email) {
      sendEmail(
        before.email,
        "Your KashBook email was changed",
        `<p>The email on your KashBook account was just changed to <b>${email}</b>.</p>
         <p>If this wasn't you, contact support immediately — your account may be compromised.</p>`,
      ).catch((e) => console.warn("[email-change] old-address notice failed:", e.message));
    }
    const token = signToken({ userId: user.id, tokenVersion: user.tokenVersion });
    const { password: _, ...safe } = user;
    res.json({ user: safe, token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update email" });
  }
});

// ─────────────────────────────────────────────
// POST /auth/request-phone-change
// Sends OTP SMS to the new phone number
// ─────────────────────────────────────────────
router.post("/request-phone-change", authMiddleware, async (req, res) => {
  if (req.user.accountType === "staff")
    return res.status(403).json({ error: "Only the business owner can change account details.", code: "STAFF_FORBIDDEN" });
  const { newPhone, currentPassword } = req.body;
  if (!newPhone) return res.status(400).json({ error: "Phone number required" });
  try {
    const me = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!me) return res.status(404).json({ error: "Account not found" });
    // Legacy rows with no password (social/OTP-only signups) can't be asked for
    // one — tell them to set a password rather than locking them out forever.
    if (!me.password)
      return res.status(403).json({
        error: "Set a password first, then you can change your email or phone number.",
        code: "PASSWORD_NOT_SET",
      });
    if (!currentPassword || !(await bcrypt.verify(currentPassword, me.password)))
      return res.status(401).json({ error: "Current password is incorrect", code: "PASSWORD_REQUIRED" });
    // Normalize BEFORE the uniqueness check. Raw trim() let "08012345678" slip
    // past a stored "+2348012345678", after which the SMS layer normalized it
    // back to the victim's handset — an OTP delivered to someone else's phone.
    const { getCountryConfig } = require("../config/countries");
    const phone = normalizePhone(newPhone, getCountryConfig(me.country || "NG").callingCode);
    if (!phone) return res.status(400).json({ error: "Valid phone number required" });
    const existing = await prisma.user.findFirst({ where: { phone } });
    if (existing && existing.id !== req.user.id)
      return res.status(409).json({ error: "Phone number already in use" });
    await dispatchOtp(phone, "phone_change");
    res.json({ message: "Verification code sent" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to send verification code" });
  }
});

// ─────────────────────────────────────────────
// PATCH /auth/confirm-phone-change
// Verifies OTP and updates the phone number
// ─────────────────────────────────────────────
router.patch("/confirm-phone-change", authMiddleware, async (req, res) => {
  if (req.user.accountType === "staff")
    return res.status(403).json({ error: "Only the business owner can change account details.", code: "STAFF_FORBIDDEN" });
  const { newPhone, otpCode } = req.body;
  if (!newPhone || !otpCode)
    return res.status(400).json({ error: "Phone and verification code required" });
  try {
    const me = await prisma.user.findUnique({ where: { id: req.user.id }, select: { country: true } });
    // Must normalize identically to request-phone-change or the OTP lookup misses.
    const { getCountryConfig } = require("../config/countries");
    const phone = normalizePhone(newPhone, getCountryConfig(me?.country || "NG").callingCode);
    if (!phone) return res.status(400).json({ error: "Valid phone number required" });
    const valid = await verifyOtp(phone, otpCode, "phone_change");
    if (!valid) return res.status(400).json({ error: "Invalid or expired code" });
    const user = await prisma.user.update({
      where: { id: req.user.id },
      data: { phone, tokenVersion: { increment: 1 } }, // revoke sessions on identifier change
    });
    const token = signToken({ userId: user.id, tokenVersion: user.tokenVersion });
    const { password: _, ...safe } = user;
    res.json({ user: safe, token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update phone number" });
  }
});

// ─────────────────────────────────────────────
// GET /auth/staff
// ─────────────────────────────────────────────
router.get("/staff", authMiddleware, async (req, res) => {
  if (req.user.accountType === "staff") return res.status(403).json({ error: "Forbidden" });
  try {
    const staffList = await prisma.user.findMany({
      where: { employerId: req.user.id },
      select: {
        id: true, firstName: true, lastName: true, phone: true, email: true,
        accountType: true, createdAt: true,
        // So the list can show what each person can do without an N+1 fetch.
        staffPermission: {
          select: {
            canViewBalance: true, canTransfer: true, canViewReports: true,
            canManagePayables: true, dailyTransferCap: true, employerId: true,
          },
        },
      },
    });
    // Flatten, and apply the SAME cross-check authMiddleware does: a grant row
    // naming a different employer is ignored there, so it must not be displayed
    // as active here. A settings screen that disagrees with what the server
    // enforces is worse than one that shows nothing.
    res.json(
      staffList.map(({ staffPermission, ...s }) => {
        const g = staffPermission && staffPermission.employerId === req.user.id ? staffPermission : null;
        return {
          ...s,
          permissions: {
            canViewBalance: g?.canViewBalance === true,
            canTransfer: g?.canTransfer === true,
            canViewReports: g?.canViewReports === true,
            canManagePayables: g?.canManagePayables === true,
          },
          dailyTransferCap: Number(g?.dailyTransferCap ?? 0) || 0,
        };
      }),
    );
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch staff list" });
  }
});

// ─────────────────────────────────────────────
// POST /auth/staff
// ─────────────────────────────────────────────
router.post("/staff", authMiddleware, async (req, res) => {
  if (req.user.accountType === "staff") return res.status(403).json({ error: "Forbidden: Staff cannot create staff" });
  if (req.user.plan !== "PREMIUM") return res.status(403).json({ error: "Staff accounts require a Pro plan. Upgrade to add team members.", code: "PRO_REQUIRED" });

  // Staff sign in with an identifier — phone OR email works for /auth/login,
  // so either is enough here. The client form offers both.
  const { firstName, lastName, phone, email, password } = req.body;
  if (!firstName || !password || (!phone && !email)) {
    return res.status(400).json({ error: "First name, password, and a phone number or email are required" });
  }
  // Same minimum as every other password entry point (register/reset/change).
  if (String(password).length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters" });
  }
  const ph = phone ? normalizePhone(phone) : null;
  const em = email ? String(email).trim().toLowerCase() : null;
  if (em && !/\S+@\S+\.\S+/.test(em)) {
    return res.status(400).json({ error: "Enter a valid email address" });
  }
  try {
    if (ph) {
      const exists = await prisma.user.findUnique({ where: { phone: ph } });
      if (exists) return res.status(409).json({ error: "An account with this phone number already exists" });
    }
    if (em) {
      const exists = await prisma.user.findUnique({ where: { email: em } });
      if (exists) return res.status(409).json({ error: "An account with this email already exists" });
    }
    const owner = await prisma.user.findUnique({ where: { id: req.user.id } });
    const newStaff = await prisma.user.create({
      data: {
        firstName: firstName.trim(),
        lastName: lastName?.trim() || "",
        businessName: owner.businessName,
        phone: ph,
        email: em,
        password: await bcrypt.hash(password, 12),
        accountType: "STAFF",
        employerId: req.user.id,
      },
    });
    await audit({
      req,
      action: "STAFF_CREATED",
      resourceType: "user",
      resourceId: newStaff.id,
      severity: "warn",
      // A new staff account starts with NO permissions — there is no grant row,
      // and authMiddleware reads a missing row as nothing granted. Recorded so
      // the trail shows the starting point every later grant departs from.
      metadata: { staffName: `${firstName} ${lastName || ""}`.trim(), staffEmail: em, staffPhone: ph, permissions: "none" },
    }).catch(() => {});

    // Never return the password hash to the client.
    const { password: _pw, ...safe } = newStaff;
    res.status(201).json({
      ...safe,
      permissions: { canViewBalance: false, canTransfer: false, canViewReports: false, canManagePayables: false },
      dailyTransferCap: 0,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create staff account" });
  }
});

// ─────────────────────────────────────────────
// PATCH /auth/staff/:id/permissions
//
// The grant surface. Three gates, and all three are deliberate:
//   1. owner-only        — a staff member must never be able to widen their own
//                          access, nor a colleague's
//   2. Pro plan          — staff are a paid feature; permissions are part of it
//   3. transaction PIN   — the same proof required to move money, because
//                          granting canTransfer IS granting the ability to move
//                          money. A password-authenticated session that has been
//                          left open on a shop counter must not be enough.
// ─────────────────────────────────────────────
router.patch("/staff/:id/permissions", authMiddleware, async (req, res) => {
  if (req.user.accountType === "staff")
    return res.status(403).json({ error: "Only the business owner can change staff permissions.", code: "OWNER_ONLY" });

  const { pin, permissions = {}, dailyTransferCap } = req.body || {};

  // Pro gates GRANTING, never REVOKING.
  //
  // A flat plan check here creates a trap: enforcement in authMiddleware does
  // not care about the plan, so when a subscription lapses the staff member
  // keeps every capability — including sending money — while the owner is
  // locked out of the only screen that could take it away. Their own billing
  // status must never be able to strand them with access they want removed.
  const wantsAny =
    permissions.canViewBalance === true || permissions.canTransfer === true ||
    permissions.canViewReports === true || permissions.canManagePayables === true;
  if (req.user.plan !== "PREMIUM" && wantsAny)
    return res.status(403).json({ error: "Staff permissions require a Pro plan.", code: "PRO_REQUIRED" });

  try {
    const staff = await prisma.user.findUnique({
      where: { id: req.params.id },
      select: { id: true, employerId: true, accountType: true, firstName: true, lastName: true },
    });
    if (!staff || staff.employerId !== req.user.id)
      return res.status(404).json({ error: "Staff not found" });
    if (staff.accountType !== "STAFF")
      return res.status(400).json({ error: "That account is not a staff member." });

    const pinCheck = await verifyTransactionPin(req.user.id, pin);
    if (!pinCheck.ok) {
      await audit({
        req, action: "PIN_FAILED", resourceType: "user", resourceId: req.user.id,
        severity: "warn", metadata: { code: pinCheck.code, context: "grant_staff_permissions" },
      }).catch(() => {});
      return res.status(pinCheck.status || 401).json({ error: pinCheck.error, code: pinCheck.code });
    }

    // Strict booleans only. A missing key means false, not "leave it alone":
    // this endpoint sets the whole grant, so a partial body can never leave a
    // capability switched on by accident.
    const next = {
      canViewBalance: permissions.canViewBalance === true,
      canTransfer: permissions.canTransfer === true,
      canViewReports: permissions.canViewReports === true,
      canManagePayables: permissions.canManagePayables === true,
    };

    // A cap is meaningless without the permission it bounds, and a negative or
    // non-finite cap would be read as 0 downstream anyway — reject it here so
    // the owner sees the problem instead of silently getting a zero.
    let cap = null;
    if (dailyTransferCap !== undefined && dailyTransferCap !== null && dailyTransferCap !== "") {
      cap = Number(dailyTransferCap);
      if (!Number.isFinite(cap) || cap < 0)
        return res.status(400).json({ error: "Enter a valid daily limit." });
      if (cap > MAX_STAFF_DAILY_CAP)
        return res.status(400).json({ error: `The daily limit can't be more than ${MAX_STAFF_DAILY_CAP.toLocaleString()}.` });
    }

    const before = await prisma.staffPermission.findUnique({ where: { userId: staff.id } });

    const grant = await prisma.staffPermission.upsert({
      where: { userId: staff.id },
      create: { userId: staff.id, employerId: req.user.id, ...next, dailyTransferCap: cap, grantedById: req.user.id },
      // employerId is rewritten on every update so a grant can never keep
      // pointing at a previous employer — authMiddleware refuses a mismatched
      // row outright, which would look like a permission that won't stick.
      update: { employerId: req.user.id, ...next, dailyTransferCap: cap, grantedById: req.user.id },
    });

    // One row per change, at warn severity, naming what moved. Granting the
    // ability to move someone else's money is exactly the kind of event that
    // has to be reconstructable months later.
    const changed = Object.keys(next).filter((k) => (before?.[k] === true) !== next[k]);
    const capChanged = Number(before?.dailyTransferCap ?? 0) !== Number(cap ?? 0);
    if (changed.length || capChanged || !before) {
      await audit({
        req,
        action: changed.some((k) => next[k]) || capChanged ? "STAFF_PERMISSION_GRANTED" : "STAFF_PERMISSION_REVOKED",
        resourceType: "user",
        resourceId: staff.id,
        severity: "warn",
        metadata: {
          staffUserId: staff.id,
          granted: Object.keys(next).filter((k) => next[k]),
          revoked: Object.keys(next).filter((k) => !next[k] && before?.[k] === true),
          dailyTransferCapBefore: Number(before?.dailyTransferCap ?? 0) || 0,
          dailyTransferCapAfter: Number(cap ?? 0) || 0,
        },
      }).catch(() => {});
    }

    // Permissions are read from the database on every request and never cached
    // in the JWT, so this takes effect on the staff member's very next call —
    // no logout required, which is what makes a revoke actually a revoke.
    res.json({
      id: staff.id,
      permissions: next,
      dailyTransferCap: Number(grant.dailyTransferCap ?? 0) || 0,
    });
  } catch (err) {
    console.error("[auth/staff/permissions]", err);
    res.status(500).json({ error: "Failed to update permissions" });
  }
});

// ─────────────────────────────────────────────
// DELETE /auth/staff/:id
// ─────────────────────────────────────────────
router.delete("/staff/:id", authMiddleware, async (req, res) => {
  if (req.user.accountType === "staff") return res.status(403).json({ error: "Forbidden" });
  try {
    const staff = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!staff) return res.status(404).json({ error: "Staff not found" });
    if (staff.employerId !== req.user.id) return res.status(403).json({ error: "Not authorized" });

    // Close anything they left in the approval queue BEFORE the delete. The
    // approve route refuses a request from a departed staff member anyway, but
    // leaving live-looking rows in the owner's pending list invites them to tap
    // approve on money for someone who no longer works there.
    await prisma.staffTransferRequest.updateMany({
      where: { requestedById: staff.id, status: "pending" },
      data: { status: "cancelled", reason: "The staff member was removed from the business.", decidedAt: new Date() },
    }).catch(() => {});

    await prisma.user.delete({ where: { id: req.params.id } });

    // Staff removal wrote no audit row at all until now — the one event most
    // worth having when reconstructing who could do what, and when.
    await audit({
      req,
      action: "STAFF_DELETED",
      resourceType: "user",
      resourceId: staff.id,
      severity: "warn",
      metadata: { staffName: `${staff.firstName || ""} ${staff.lastName || ""}`.trim(), staffEmail: staff.email || null },
    }).catch(() => {});

    res.json({ message: "Staff account successfully removed" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete staff account" });
  }
});

module.exports = router;
