const router  = require("express").Router();
const bcrypt  = require("@node-rs/bcrypt"); // native (off-thread) — hash()/verify(); $2a$/$2b$/$2y$ cross-compatible
const { body, validationResult } = require("express-validator");

const prisma         = require("../utils/db");
const cloudinary     = require("../config/cloudinary");
const { signToken }  = require("../utils/jwt");
const { dispatchOtp, verifyOtp } = require("../utils/otp");
const authMiddleware = require("../middleware/auth");
const { audit } = require("../utils/audit");

// ── Helper: safe user response ────────────────────────────────────────────────
function userResponse(user, token) {
  return {
    token,
    user: {
      id:           user.id,
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
router.post("/register", body("password").isLength({ min: 8 }).withMessage("Password must be at least 8 characters"), async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { firstName, lastName, name, businessName, email, password, phone, identifier, otpCode, country, callingCode } = req.body;
  const fn  = firstName?.trim() || splitName(name).firstName;
  const ln  = lastName?.trim()  || splitName(name).lastName;
  const biz = businessName?.trim() || "My Business";
  const rawIdentifier = identifier || email || phone || "";
  const isEmail = rawIdentifier.includes("@");
  const iden = isEmail ? rawIdentifier.trim().toLowerCase() : normalizePhone(rawIdentifier, callingCode);
  // Country is the source of truth for currency + language + KYC scheme.
  // Default to NG if the client didn't send one (legacy registration flow).
  const { getCountryConfig, isSupported } = require("../config/countries");
  const countryCode = (country && isSupported(country)) ? String(country).toUpperCase() : "NG";
  const countryCfg = getCountryConfig(countryCode);

  if (!fn)      return res.status(400).json({ error: "First name is required" });
  if (!iden)    return res.status(400).json({ error: "Email or phone number is required" });
  if (!otpCode) return res.status(400).json({ error: "Verification code is required" });

  const type = req.body.type || "phone_register";
  const otpValid = await verifyOtp(iden, otpCode, type);
  if (!otpValid) return res.status(400).json({ error: "Invalid or expired verification code" });

  try {
    const exists = await prisma.user.findFirst({ where: isEmail ? { email: iden } : { phone: iden } });
    if (exists?.password) return res.status(409).json({ error: "Account already registered" });

    const hashed = await bcrypt.hash(password, 12);
    const data = { firstName: fn, lastName: ln, businessName: biz, password: hashed,
      ...(isEmail ? { email: iden } : { phone: iden }) };
    if (email?.includes("@")) data.email = email.trim().toLowerCase();
    if (phone) data.phone = normalizePhone(phone, callingCode || countryCfg.callingCode);
    // Currency is derived from country — country is the lock.
    data.country  = countryCode;
    data.currency = countryCfg.currency.code;
    data.language = countryCfg.language;

    const user = exists
      ? await prisma.user.update({ where: { id: exists.id }, data })
      : await prisma.user.create({ data });

    await ensurePrimaryBusiness(user.id, biz, countryCode);
    const token = signToken({ userId: user.id, tokenVersion: user.tokenVersion ?? 0 });
    res.status(201).json(userResponse(user, token));
  } catch (err) {
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
router.post("/send-otp", async (req, res) => {
  const { phone, email, identifier, type = "phone_register" } = req.body;
  const rawIden = identifier || email || phone || "";
  if (!rawIden) return res.status(400).json({ error: "Identifier required" });
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
router.post("/check-otp", async (req, res) => {
  const { phone, email, identifier, code, type = "phone_reset" } = req.body;
  const rawIden = identifier || email || phone || "";
  if (!rawIden || !code) return res.status(400).json({ error: "Identifier and code required" });
  const iden = rawIden.includes("@") ? rawIden.trim().toLowerCase() : normalizePhone(rawIden);
  const record = await prisma.otpCode.findFirst({
    where: { identifier: iden, code, type, used: false, expiresAt: { gt: new Date() } },
  });
  if (!record) return res.status(400).json({ error: "Invalid or expired code" });
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
    let user = await prisma.user.findFirst({ where: isEmail ? { email: iden } : { phone: iden } });
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
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user) return res.status(404).json({ error: "User not found" });
    // Strip raw secret-like fields before sending the user object.
    const { password: _, transactionPin: _pin, transactionPinFailedCount: _c, transactionPinLockedUntil: _l, ...safe } = user;
    res.json({
      user: {
        ...safe,
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

    // Money-out guard: never delete around a bank balance.
    const businesses = await prisma.business.findMany({
      where: { userId: user.id },
      select: { id: true, name: true, anchorAccountId: true, baseCurrency: true },
    });
    const anchor = require("../utils/anchor");
    for (const biz of businesses.filter((b) => b.anchorAccountId)) {
      try {
        const { balance } = await anchor.getAccountBalance(biz.anchorAccountId);
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
  const { firstName, lastName, businessName, phone, email, profileImage, dateOfBirth, gender } = req.body;
  // Staff can update their own name/photo, but identity and business fields
  // belong to the owner — strip them rather than failing the whole save.
  const isStaff = req.user.accountType === "staff";
  try {
    const data = {};
    if (firstName)                 data.firstName    = firstName.trim();
    if (lastName)                  data.lastName     = lastName.trim();
    if (businessName && !isStaff)  data.businessName = businessName.trim();
    if (phone && !isStaff)         data.phone        = phone.trim();
    if (email && !isStaff)         data.email        = email.trim().toLowerCase();
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

    const user = await prisma.user.update({ where: { id: req.user.id }, data });
    const { password: _, ...safe } = user;
    res.json({ user: safe });
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
      const result = await cloudinary.uploader.upload(imageBase64, {
        folder: "kashbook/avatars", public_id: `user_${req.user.id}`, overwrite: true,
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
    const user = await prisma.user.update({ where: { id: req.user.id }, data });
    const { password: _, ...safe } = user;
    res.json({ user: safe });
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
  const { newEmail } = req.body;
  if (!newEmail?.includes("@")) return res.status(400).json({ error: "Valid email required" });
  const email = newEmail.trim().toLowerCase();
  try {
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
    const user = await prisma.user.update({
      where: { id: req.user.id },
      data: { email },
    });
    const { password: _, ...safe } = user;
    res.json({ user: safe });
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
  const { newPhone } = req.body;
  if (!newPhone) return res.status(400).json({ error: "Phone number required" });
  const phone = newPhone.trim();
  try {
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
  const phone = newPhone.trim();
  try {
    const valid = await verifyOtp(phone, otpCode, "phone_change");
    if (!valid) return res.status(400).json({ error: "Invalid or expired code" });
    const user = await prisma.user.update({
      where: { id: req.user.id },
      data: { phone },
    });
    const { password: _, ...safe } = user;
    res.json({ user: safe });
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
      select: { id: true, firstName: true, lastName: true, phone: true, email: true, accountType: true, createdAt: true },
    });
    res.json(staffList);
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
    // Never return the password hash to the client.
    const { password: _pw, ...safe } = newStaff;
    res.status(201).json(safe);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create staff account" });
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
    await prisma.user.delete({ where: { id: req.params.id } });
    res.json({ message: "Staff account successfully removed" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete staff account" });
  }
});

module.exports = router;
