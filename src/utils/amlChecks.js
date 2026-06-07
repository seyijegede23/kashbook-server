// Pre-transfer AML pipeline. Used by /transfers/send before the Anchor
// call. Returns { ok, error?, code?, status?, flags?, maxSeverity? }
// where status defaults to 400 unless explicitly set.
//
// On `ok === false`: caller MUST reject the request and NOT proceed to
// Anchor. On `ok === true`: caller may proceed, but should attach
// `flags` + `maxSeverity` to the resulting Transaction row and persist a
// ComplianceFlag per entry.
const prisma = require("./db");
const {
  resolveBusinessLimits,
  STEP_UP_OTP_ABOVE,
  TRANSFER_OTP_TYPE,
  SINGLE_FLAG_ABOVE,
} = require("../config/amlLimits");
const { runRules } = require("./amlRules");
const { audit } = require("./audit");
const { verifyOtp } = require("./otp");

// Pick the identifier we'll send the step-up OTP to. Email is preferred
// (free, faster to deliver in this market); phone is the fallback when no
// email is on file. Caller is responsible for actually dispatching.
function pickOtpIdentifier(user) {
  if (!user) return null;
  if (user.email) return user.email;
  if (user.phone) return user.phone;
  return null;
}

// Return a partially-masked identifier so the client can render
// "code sent to a••a@gmail.com" without exposing the full address in the
// API response.
function maskIdentifier(id) {
  if (!id) return "";
  if (id.includes("@")) {
    const [local, domain] = id.split("@");
    if (local.length <= 2) return `${local[0] || ""}*@${domain}`;
    return `${local[0]}${"*".repeat(Math.max(1, local.length - 2))}${local.slice(-1)}@${domain}`;
  }
  // Phone — mask all but the last 4 digits.
  return id.length <= 4 ? id : `${"*".repeat(id.length - 4)}${id.slice(-4)}`;
}

async function runPreTransferChecks({ req, user, business, amount, otp }) {
  // 1. Frozen check ------------------------------------------------------
  if (user?.accountStatus && user.accountStatus !== "active") {
    await audit({
      req,
      action: "BLOCKED_FROZEN",
      resourceType: "user",
      resourceId: user.id,
      severity: "warn",
      metadata: { reason: user.complianceFreezeReason, amount },
    });
    return {
      ok: false,
      status: 423,
      code: "FROZEN",
      error: "Your account is under review. Contact support to resolve.",
    };
  }
  if (business?.accountStatus && business.accountStatus !== "active") {
    await audit({
      req,
      action: "BLOCKED_FROZEN",
      resourceType: "business",
      resourceId: business.id,
      severity: "warn",
      metadata: { amount },
    });
    return {
      ok: false,
      status: 423,
      code: "FROZEN",
      error: "This business is under review. Contact support to resolve.",
    };
  }

  // 2. Tier limit check --------------------------------------------------
  const limits = resolveBusinessLimits(business);

  if (limits.daily === 0) {
    await audit({
      req,
      action: "BLOCKED_LIMIT",
      resourceType: "business",
      resourceId: business.id,
      severity: "info",
      metadata: { reason: "unverified", amount },
    });
    return {
      ok: false,
      status: 400,
      code: "BLOCKED_UNVERIFIED",
      error:
        "Complete KYC verification before sending money. Open the Bank Account tab to get started.",
    };
  }

  // 3. Single-transfer cap ----------------------------------------------
  if (amount > limits.singleMax) {
    await audit({
      req,
      action: "BLOCKED_SINGLE_CAP",
      resourceType: "business",
      resourceId: business.id,
      severity: "warn",
      metadata: { amount, singleMax: limits.singleMax },
    });
    return {
      ok: false,
      status: 400,
      code: "BLOCKED_SINGLE_CAP",
      error: `Single transfer cap is ₦${limits.singleMax.toLocaleString("en-NG")}. Split into smaller transfers.`,
    };
  }

  // Sum outbound history (anchor expense transfers only).
  const now = Date.now();
  const since24h = new Date(now - 24 * 60 * 60 * 1000);
  const since7d  = new Date(now - 7  * 24 * 60 * 60 * 1000);
  const since30d = new Date(now - 30 * 24 * 60 * 60 * 1000);

  const recent30 = await prisma.transaction.findMany({
    where: {
      businessId: business.id,
      type: "expense",
      category: "transfer",
      source: "anchor",
      date: { gte: since30d },
    },
    select: { amount: true, date: true },
    orderBy: { date: "asc" },
  });

  const sum = (since, list = recent30) =>
    list.filter((t) => t.date >= since).reduce((s, t) => s + t.amount, 0);

  const dailySoFar   = sum(since24h);
  const weeklySoFar  = sum(since7d);
  const monthlySoFar = sum(since30d);

  function over(limit, used) {
    return used + amount > limit;
  }

  if (over(limits.daily, dailySoFar)) {
    await audit({
      req,
      action: "BLOCKED_LIMIT",
      resourceType: "business",
      resourceId: business.id,
      severity: "warn",
      metadata: { window: "daily", used: dailySoFar, amount, limit: limits.daily },
    });
    return {
      ok: false,
      status: 400,
      code: "BLOCKED_LIMIT",
      error: `This would bring today's transfers to ₦${(dailySoFar + amount).toLocaleString("en-NG")}. Your daily limit is ₦${limits.daily.toLocaleString("en-NG")}.`,
    };
  }
  if (over(limits.weekly, weeklySoFar)) {
    await audit({
      req,
      action: "BLOCKED_LIMIT",
      resourceType: "business",
      resourceId: business.id,
      severity: "warn",
      metadata: { window: "weekly", used: weeklySoFar, amount, limit: limits.weekly },
    });
    return {
      ok: false,
      status: 400,
      code: "BLOCKED_LIMIT",
      error: `This would exceed your 7-day limit of ₦${limits.weekly.toLocaleString("en-NG")}.`,
    };
  }
  if (over(limits.monthly, monthlySoFar)) {
    await audit({
      req,
      action: "BLOCKED_LIMIT",
      resourceType: "business",
      resourceId: business.id,
      severity: "warn",
      metadata: { window: "monthly", used: monthlySoFar, amount, limit: limits.monthly },
    });
    return {
      ok: false,
      status: 400,
      code: "BLOCKED_LIMIT",
      error: `This would exceed your 30-day limit of ₦${limits.monthly.toLocaleString("en-NG")}.`,
    };
  }

  // 4. Step-up: one-time code on top of the PIN for large transfers ------
  if (amount > STEP_UP_OTP_ABOVE) {
    const identifier = pickOtpIdentifier(user);
    if (!identifier) {
      await audit({
        req,
        action: "STEP_UP_OTP_NO_IDENTIFIER",
        resourceType: "user",
        resourceId: user.id,
        severity: "warn",
        metadata: { amount },
      });
      return {
        ok: false,
        status: 400,
        code: "STEP_UP_NO_IDENTIFIER",
        error: "Add a verified email or phone number to send transfers above ₦1,000,000.",
      };
    }
    if (!otp) {
      await audit({
        req,
        action: "STEP_UP_OTP_REQUIRED",
        resourceType: "business",
        resourceId: business.id,
        severity: "info",
        metadata: { amount, threshold: STEP_UP_OTP_ABOVE, identifier },
      });
      return {
        ok: false,
        status: 401,
        code: "OTP_REQUIRED",
        error: "We've sent a 6-digit code to confirm this transfer.",
        otpIdentifier: maskIdentifier(identifier),
      };
    }
    const valid = await verifyOtp(identifier, String(otp).trim(), TRANSFER_OTP_TYPE);
    if (!valid) {
      await audit({
        req,
        action: "STEP_UP_OTP_INVALID",
        resourceType: "business",
        resourceId: business.id,
        severity: "warn",
        metadata: { amount, identifier },
      });
      return {
        ok: false,
        status: 401,
        code: "OTP_INVALID",
        error: "Wrong code. Check the email or SMS and try again.",
        otpIdentifier: maskIdentifier(identifier),
      };
    }
    await audit({
      req,
      action: "STEP_UP_OTP_SATISFIED",
      resourceType: "business",
      resourceId: business.id,
      severity: "info",
      metadata: { amount },
    });
  }

  // 5. Rules engine ------------------------------------------------------
  const history24h = recent30.filter((t) => t.date >= since24h);
  const businessAgeDays = Math.max(
    1,
    Math.floor((now - new Date(business.createdAt || now).getTime()) / (24 * 60 * 60 * 1000)),
  );
  const { maxSeverity, flags } = runRules({
    amount,
    history24h,
    history30d: recent30,
    now,
    businessAgeDays,
  });

  // High-severity flags HOLD the transfer; medium / low just attach.
  if (maxSeverity === "high") {
    await audit({
      req,
      action: "HELD_FOR_REVIEW",
      resourceType: "business",
      resourceId: business.id,
      severity: "alert",
      metadata: { amount, flags: flags.map((f) => f.ruleCode) },
    });
    return {
      ok: false,
      status: 423,
      code: "HELD_FOR_REVIEW",
      error: "This transfer is held for review. Our team will contact you shortly.",
      flags,
      maxSeverity,
    };
  }

  return { ok: true, flags, maxSeverity, limits, dailySoFar, weeklySoFar, monthlySoFar };
}

// Called AFTER a transfer succeeds. Persists ComplianceFlag rows for any
// flagged outcome and ensures CTR-style auto-flag if amount ≥ threshold.
async function recordComplianceFlags({ userId, businessId, transactionId, amount, flags }) {
  const augmented = [...(flags || [])];

  // Belt-and-braces CTR auto-flag — runRules already produces SINGLE_LARGE
  // for the same threshold; this guards against any rule-engine bypass.
  if (amount >= SINGLE_FLAG_ABOVE && !augmented.some((f) => f.ruleCode === "SINGLE_LARGE")) {
    augmented.push({
      ruleCode: "CTR_THRESHOLD",
      severity: "medium",
      description: `Transfer of ₦${amount.toLocaleString("en-NG")} meets the CTR auto-flag threshold.`,
      metadata: { amount, threshold: SINGLE_FLAG_ABOVE },
    });
  }

  if (augmented.length === 0) return;

  await prisma.complianceFlag.createMany({
    data: augmented.map((f) => ({
      userId,
      businessId,
      transactionId,
      ruleCode: f.ruleCode,
      severity: f.severity,
      description: f.description,
      metadata: f.metadata || {},
    })),
  });
}

module.exports = { runPreTransferChecks, recordComplianceFlags };
