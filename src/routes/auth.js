const router  = require("express").Router();
const bcrypt  = require("bcryptjs");
const { OAuth2Client } = require("google-auth-library");
const { body, validationResult } = require("express-validator");

const prisma         = require("../utils/db");
const cloudinary     = require("../config/cloudinary");
const { signToken }  = require("../utils/jwt");
const { dispatchOtp, verifyOtp } = require("../utils/otp");
const authMiddleware = require("../middleware/auth");
const { audit } = require("../utils/audit");

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

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
    const token = signToken({ userId: user.id });
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
    if (!user.password) return res.status(401).json({ error: "This account uses Google sign-in" });

    // ── Account lockout check ────────────────────────────────────────────
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      const secsLeft = Math.ceil((user.lockedUntil - Date.now()) / 1000);
      return res.status(429).json({ error: `Account locked. Try again in ${secsLeft} seconds.` });
    }

    const valid = await bcrypt.compare(password, user.password);
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

    const token = signToken({ userId: user.id });
    res.json(userResponse(user, token));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Login failed" });
  }
});

// ─────────────────────────────────────────────
// POST /auth/google
// ─────────────────────────────────────────────
router.post("/google", async (req, res) => {
  const { idToken } = req.body;
  if (!idToken) return res.status(400).json({ error: "idToken required" });
  try {
    const ticket = await googleClient.verifyIdToken({ idToken, audience: process.env.GOOGLE_CLIENT_ID });
    const { sub: googleId, email, name, picture } = ticket.getPayload();
    const { firstName, lastName } = splitName(name);

    let user = await prisma.user.findFirst({ where: { OR: [{ googleId }, { email }] } });
    if (user) {
      if (!user.googleId) user = await prisma.user.update({ where: { id: user.id }, data: { googleId } });
    } else {
      user = await prisma.user.create({
        data: { firstName, lastName, businessName: "My Business", email, googleId, avatarUrl: picture },
      });
    }
    await ensurePrimaryBusiness(user.id, user.businessName || "My Business");
    const token = signToken({ userId: user.id });
    res.json(userResponse(user, token));
  } catch (err) {
    console.error(err);
    res.status(401).json({ error: "Google token verification failed" });
  }
});

// ─────────────────────────────────────────────
// POST /auth/apple
// body: { idToken, firstName?, lastName? }
//   - idToken: the JWT returned by expo-apple-authentication / native Sign In with Apple
//   - firstName/lastName: Apple only includes the user's name on FIRST sign-in.
//     Client should pass them through if the SDK returned them.
// ─────────────────────────────────────────────
const appleSignin = require("apple-signin-auth");
router.post("/apple", async (req, res) => {
  const { idToken, firstName: clientFirstName, lastName: clientLastName } = req.body;
  if (!idToken) return res.status(400).json({ error: "idToken required" });
  try {
    const claims = await appleSignin.verifyIdToken(idToken, {
      // The "audience" must match the Bundle ID (iOS) or Service ID (web)
      // registered with Apple. We accept both env vars to allow either.
      audience: process.env.APPLE_CLIENT_ID || process.env.APPLE_BUNDLE_ID,
      ignoreExpiration: false,
    });
    const appleId = claims.sub;
    const email = claims.email || null;

    let user = await prisma.user.findFirst({
      where: {
        OR: [{ appleId }, email ? { email } : { id: "__never__" }],
      },
    });
    if (user) {
      if (!user.appleId) {
        user = await prisma.user.update({
          where: { id: user.id },
          data: { appleId },
        });
      }
    } else {
      const firstName = (clientFirstName || "").trim() || "Apple";
      const lastName = (clientLastName || "").trim() || "User";
      user = await prisma.user.create({
        data: {
          firstName,
          lastName,
          businessName: "My Business",
          email,
          appleId,
        },
      });
    }
    await ensurePrimaryBusiness(user.id, user.businessName || "My Business");
    const token = signToken({ userId: user.id });
    res.json(userResponse(user, token));
  } catch (err) {
    console.error("[apple sign-in]", err.message || err);
    res.status(401).json({ error: "Apple token verification failed" });
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
    console.error("send-otp error:", err.message ?? err);
    res.status(500).json({ error: `Failed to send OTP: ${err.message ?? "unknown error"}` });
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
    const token = signToken({ userId: user.id });
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
    if (!user) return res.json({ message: "If that account exists, a reset code was sent." });
    await dispatchOtp(iden, "phone_reset");
    res.json({ message: "If that account exists, a reset code was sent." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to process request" });
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
      data: { password: await bcrypt.hash(newPassword, 12) },
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
  try {
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
    const valid = await bcrypt.compare(password, user.password);
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
    if (!user.password) return res.status(400).json({ error: "This account uses Google sign-in and has no password" });
    const match = await bcrypt.compare(currentPassword, user.password);
    if (!match) return res.status(401).json({ error: "Current password is incorrect" });
    await prisma.user.update({ where: { id: req.user.id }, data: { password: await bcrypt.hash(newPassword, 12) } });
    res.json({ message: "Password updated successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to change password" });
  }
});

// ─────────────────────────────────────────────
// PATCH /auth/profile
// ─────────────────────────────────────────────
router.patch("/profile", authMiddleware, async (req, res) => {
  const { firstName, lastName, businessName, phone, email, profileImage, dateOfBirth, gender } = req.body;
  try {
    const data = {};
    if (firstName)                 data.firstName    = firstName.trim();
    if (lastName)                  data.lastName     = lastName.trim();
    if (businessName)              data.businessName = businessName.trim();
    if (phone)                     data.phone        = phone.trim();
    if (email)                     data.email        = email.trim().toLowerCase();
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
  const { language, currency, notificationsEnabled, biometricEnabled } = req.body;
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
    const match = await bcrypt.compare(password, user.password);
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
  if (req.user.plan !== "PREMIUM") return res.status(403).json({ error: "Staff accounts require a Pro plan. Upgrade to add team members." });
  const { firstName, lastName, phone, password } = req.body;
  if (!firstName || !phone || !password) return res.status(400).json({ error: "First Name, Phone, and Password required" });
  const ph = normalizePhone(phone);
  try {
    const exists = await prisma.user.findUnique({ where: { phone: ph } });
    if (exists) return res.status(409).json({ error: "An account with this phone number already exists" });
    const owner = await prisma.user.findUnique({ where: { id: req.user.id } });
    const newStaff = await prisma.user.create({
      data: { firstName: firstName.trim(), lastName: lastName?.trim() || "", businessName: owner.businessName,
        phone: ph, password: await bcrypt.hash(password, 12), accountType: "STAFF", employerId: req.user.id },
    });
    res.status(201).json(newStaff);
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
