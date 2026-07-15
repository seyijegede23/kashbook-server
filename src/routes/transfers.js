const router = require("express").Router();
const auth = require("../middleware/auth");
const requireUnfrozen = require("../middleware/requireUnfrozen");
const prisma = require("../utils/db");
const anchor = require("../utils/anchor");
const { getProvider } = require("../providers");
const { getCountryConfig } = require("../config/countries");
const { computeLedgerBalance } = require("../utils/ledgerBalance");
const { verifyTransactionPin } = require("../utils/transactionPin");
const { runPreTransferChecks } = require("../utils/amlChecks");
const { audit } = require("../utils/audit");
const { dispatchOtp } = require("../utils/otp");
const { executeTransfer } = require("../utils/executeTransfer");
const { computeTransferFee, NIP_FEE, STAMP_DUTY, STAMP_DUTY_THRESHOLD, PLATFORM_MARGIN } = require("../config/fees");
const {
  STEP_UP_OTP_ABOVE,
  TRANSFER_OTP_TYPE,
  resolveBusinessLimits,
  getThresholds,
} = require("../config/amlLimits");

router.use(auth);
router.use(requireUnfrozen);

// GET /transfers/banks
// Bank list for the sender's country/currency, via their payment provider
// (Fincra bank `code` is the payout bankCode; Anchor returns CBN codes). Sending
// is local, so the sender's country drives which banks + which code namespace.
router.get("/banks", async (req, res) => {
  try {
    const country = req.user.country || "NG";
    const provider = getProvider(country);
    if (!provider.supportsBanking) return res.json([]);
    const currency = getCountryConfig(country).currency.code;
    const banks = await provider.getBanks(currency);
    res.json(banks);
  } catch (err) {
    if (err.code === "ANCHOR_NOT_CONFIGURED" || err.code === "NOT_IMPLEMENTED")
      return res.status(503).json({ error: "Transfers not configured on this server." });
    console.error("[transfers/banks]", err.message);
    res.status(500).json({ error: "Failed to fetch banks" });
  }
});

// POST /transfers/verify-account
// body: { accountNumber, bankCode } — bankCode is the CBN bank code
// Two-step lookup:
//   1. Check our DB for an internal KashBook business with that NUBAN. Anchor's
//      /payments/verify-account doesn't know about its own virtual NUBANs, so
//      external-only enquiry returns "Account not found" for KashBook→KashBook.
//   2. Fall back to Anchor's name enquiry for external banks.
router.post("/verify-account", async (req, res) => {
  const { accountNumber, bankCode } = req.body;
  if (!accountNumber || !bankCode)
    return res.status(400).json({ error: "accountNumber and bankCode are required" });

  try {
    const internal = await prisma.business.findFirst({
      where: {
        virtualAccountNumber: accountNumber,
        OR: [{ providerAccountId: { not: null } }, { anchorAccountId: { not: null } }],
      },
      select: { name: true, virtualAccountName: true },
    });
    if (internal) {
      return res.json({
        accountName: internal.virtualAccountName || internal.name,
        internal: true,
      });
    }

    const country = req.user.country || "NG";
    const provider = getProvider(country);
    const currency = getCountryConfig(country).currency.code;
    const ne = await provider.verifyRecipient({ accountNumber, bankCode, currency });
    if (!ne.accountName)
      return res.status(400).json({ error: "Account not found" });
    res.json({ accountName: ne.accountName, internal: false });
  } catch (err) {
    if (err.code === "ANCHOR_NOT_CONFIGURED" || err.code === "NOT_IMPLEMENTED")
      return res.status(503).json({ error: "Transfers not configured on this server." });
    console.error("[transfers/verify-account]", err.message);
    res
      .status(400)
      .json({ error: "Could not verify account. Check the number and bank." });
  }
});

// GET /transfers/balance?businessId=
// Live held-funds balance from Anchor for the business's deposit account.
router.get("/balance", async (req, res) => {
  try {
    const { businessId } = req.query;
    if (!businessId) return res.status(400).json({ error: "businessId required" });

    const userId =
      req.user.accountType === "staff" ? req.user.employerId : req.user.id;
    const biz = await prisma.business.findFirst({
      where: { id: businessId, userId },
    });
    if (!biz) return res.status(404).json({ error: "Business not found" });
    const bankingId = biz.providerAccountId || biz.anchorAccountId;
    if (!bankingId) return res.json({ balance: 0 });

    const provider = getProvider(biz);
    // Pooled-wallet providers (Fincra) have no per-business balance — derive it
    // from our ledger. Anchor exposes a real per-account balance.
    if (provider.pooledWallet) {
      return res.json({ balance: await computeLedgerBalance(biz.id, biz.baseCurrency || "NGN") });
    }
    const { balance } = await anchor.getAccountBalance(bankingId);
    res.json({ balance });
  } catch (err) {
    if (err.code === "ANCHOR_NOT_CONFIGURED") return res.json({ balance: 0 });
    console.error("[transfers/balance]", err.message);
    res.status(500).json({ error: "Failed to fetch balance" });
  }
});

// GET /transfers/limits?businessId=
//
// Returns the resolved AML tier limits for the business plus how much has
// already been sent today / this week / this month, so the client can show
// the user where they stand. Includes:
//
//   singleMax            biggest individual transfer allowed today
//   daily / weekly /     per-window caps from the country config
//     monthly
//   dailySoFar /         outbound transfers already counted against each
//     weeklySoFar /        window (anchor expense transfers only)
//     monthlySoFar
//   dailyRemaining /     daily - dailySoFar (etc.), floored at 0 — what the
//     weeklyRemaining /    user can still send before tripping a hard block
//     monthlyRemaining
//   stepUpOtpAbove       transfers above this require an OTP step-up
//   tierKey, country,    metadata so the UI can show "Sole proprietor · NG"
//     currencyCode
//
// Treats no-NUBAN businesses as the "unverified" tier (all zeros). The
// client is also expected to gate access to this screen, but a hard-coded
// zero here means even a bad client can't show stale limits.
router.get("/limits", async (req, res) => {
  try {
    const { businessId } = req.query;
    if (!businessId) return res.status(400).json({ error: "businessId required" });

    const userId =
      req.user.accountType === "staff" ? req.user.employerId : req.user.id;
    const biz = await prisma.business.findFirst({ where: { id: businessId, userId } });
    if (!biz) return res.status(404).json({ error: "Business not found" });

    const limits = resolveBusinessLimits(biz);
    const thresholds = getThresholds(biz);

    // Mirror the windowing used by runPreTransferChecks so the numbers a user
    // sees here match the gate they're about to hit on /send.
    const now = Date.now();
    const since24h = new Date(now - 24 * 60 * 60 * 1000);
    const since7d  = new Date(now - 7  * 24 * 60 * 60 * 1000);
    const since30d = new Date(now - 30 * 24 * 60 * 60 * 1000);
    const recent30 = await prisma.transaction.findMany({
      where: {
        businessId: biz.id,
        type: "expense",
        category: "transfer",
        source: "anchor",
        date: { gte: since30d },
      },
      select: { amount: true, date: true },
      orderBy: { date: "asc" },
    });
    const sumSince = (since) =>
      recent30.filter((t) => t.date >= since).reduce((s, t) => s + t.amount, 0);

    const dailySoFar   = sumSince(since24h);
    const weeklySoFar  = sumSince(since7d);
    const monthlySoFar = sumSince(since30d);
    const remaining = (cap, used) => Math.max(0, cap - used);

    res.json({
      tierKey: limits.tierKey,
      riskCategory: limits.riskCategory,
      countryCode: limits.countryCode,
      currencyCode: limits.currencyCode,
      currencySymbol: limits.currencySymbol,
      currencyLocale: limits.currencyLocale,

      singleMax: limits.singleMax,
      daily: limits.daily,
      weekly: limits.weekly,
      monthly: limits.monthly,

      dailySoFar,
      weeklySoFar,
      monthlySoFar,

      dailyRemaining:   remaining(limits.daily,   dailySoFar),
      weeklyRemaining:  remaining(limits.weekly,  weeklySoFar),
      monthlyRemaining: remaining(limits.monthly, monthlySoFar),

      stepUpOtpAbove: thresholds.stepUpOtpAbove,
      singleFlagAbove: thresholds.singleFlagAbove,

      hasBankingAccount: !!biz.virtualAccountNumber,

      // Fee schedule for the limits sheet. Per-transfer quotes come from
      // GET /transfers/fee-quote; this is just display copy material.
      feeSchedule: {
        nip: NIP_FEE,
        stampDuty: STAMP_DUTY,
        stampDutyThreshold: STAMP_DUTY_THRESHOLD,
        platform: PLATFORM_MARGIN,
      },
    });
  } catch (err) {
    console.error("[transfers/limits]", err);
    res.status(500).json({ error: "Failed to fetch transfer limits" });
  }
});

// GET /transfers/beneficiaries?businessId=<id>
// Top recent transfer recipients for the Send Money "Recents" chips.
router.get("/beneficiaries", async (req, res) => {
  try {
    const { businessId } = req.query;
    if (!businessId) return res.status(400).json({ error: "businessId required" });
    const userId =
      req.user.accountType === "staff" ? req.user.employerId : req.user.id;
    const biz = await prisma.business.findFirst({ where: { id: businessId, userId } });
    if (!biz) return res.status(404).json({ error: "Business not found" });

    const beneficiaries = await prisma.beneficiary.findMany({
      where: { businessId },
      orderBy: { lastUsedAt: "desc" },
      take: 5,
      select: {
        id: true, accountNumber: true, bankCode: true,
        bankName: true, accountName: true, timesUsed: true,
      },
    });
    res.json(beneficiaries);
  } catch (err) {
    console.error("[transfers/beneficiaries]", err);
    res.status(500).json({ error: "Failed to fetch beneficiaries" });
  }
});

// GET /transfers/fee-quote?amount=<n>&accountNumber=<10-digit>
// Returns the fee the user will pay for this transfer, detected the same way
// executeTransfer routes it: a KashBook-internal destination is a free book
// transfer; anything else is NIP (₦51 / ₦101 above ₦10,000). Server is
// authoritative — the client never computes fees itself.
router.get("/fee-quote", async (req, res) => {
  try {
    const amount = Number(req.query.amount);
    const accountNumber = String(req.query.accountNumber || "").trim();
    if (!amount || amount <= 0)
      return res.status(400).json({ error: "amount required" });

    // Fincra payouts currently carry no KashBook fee (executeFincraPayout books
    // fee 0), so quote 0 for Fincra countries — otherwise the confirm screen
    // shows an Anchor NIP fee that is never charged. Reprice in B9.
    const provider = getProvider(req.user.country || "NG");
    if (provider.unifiedProvisioning) {
      return res.json({ fee: 0, breakdown: null, route: "payout", total: amount });
    }

    let route = "nip";
    if (/^\d{10}$/.test(accountNumber)) {
      const internalDest = await prisma.business.findFirst({
        where: {
          virtualAccountNumber: accountNumber,
          anchorAccountId: { not: null },
        },
        select: { id: true },
      });
      if (internalDest) route = "book";
    }

    const { total, breakdown } = computeTransferFee(amount, route);
    res.json({ fee: total, breakdown, route, total: amount + total });
  } catch (err) {
    console.error("[transfers/fee-quote]", err);
    res.status(500).json({ error: "Failed to quote fee" });
  }
});

// POST /transfers/send
// body: { businessId, accountNumber, bankCode, amount, narration, accountName, bankName }
router.post("/send", async (req, res) => {
  if (req.user.accountType === "staff")
    return res.status(403).json({ error: "Staff cannot initiate transfers" });

  const { businessId, accountNumber, bankCode, amount, narration, accountName, bankName, pin, otp } = req.body;
  if (!businessId || !accountNumber || !bankCode || !amount)
    return res.status(400).json({ error: "Missing required fields" });
  if (isNaN(amount) || Number(amount) <= 0)
    return res.status(400).json({ error: "Invalid amount" });

  // Require a valid transaction PIN before processing.
  const pinCheck = await verifyTransactionPin(req.user.id, pin);
  if (!pinCheck.ok) {
    await audit({
      req,
      action: "PIN_FAILED",
      resourceType: "user",
      resourceId: req.user.id,
      severity: "warn",
      metadata: { code: pinCheck.code },
    });
    return res
      .status(pinCheck.status || 401)
      .json({ error: pinCheck.error, code: pinCheck.code });
  }

  try {
    const biz = await prisma.business.findFirst({
      where: { id: businessId, userId: req.user.id },
    });
    if (!biz) return res.status(404).json({ error: "Business not found" });

    // Banking gate — bookkeeping-only countries can't move money.
    const { getProvider } = require("../providers");
    const provider = getProvider(biz);
    if (!provider.supportsBanking) {
      return res.status(400).json({
        error: "Banking isn't available in your country yet. You can still use KashBook for invoicing and bookkeeping.",
        code: "BANKING_NOT_AVAILABLE",
      });
    }

    if (!biz.providerAccountId && !biz.anchorAccountId)
      return res.status(400).json({
        error: "This business has no bank account. Set one up first.",
      });

    // ── AML pre-transfer pipeline ─────────────────────────────────────
    // Runs frozen + tier limit + single cap + step-up + rules engine in
    // order. Writes audit rows for each gate and returns early on block.
    const userFull = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true, accountStatus: true, complianceFreezeReason: true,
        email: true, phone: true,
      },
    });
    // Serialize money-out per business: the AML cumulative-limit read and the
    // execution must be atomic, or two concurrent transfers could both pass the
    // limit/balance gate and overshoot. Different businesses still run in
    // parallel. Early-returns become outcome values handled after the lock.
    const outcome = await prisma.withBusinessLock(biz.id, async () => {
      const amlCheck = await runPreTransferChecks({
        req,
        user: userFull,
        business: biz,
        amount: Number(amount),
        otp,
      });
      if (!amlCheck.ok) {
        // On the first attempt of a large transfer, the pipeline returns
        // OTP_REQUIRED before any code has been issued. Dispatch one now so
        // the user can collect it from email/SMS, then surface the request
        // to the client with the masked identifier.
        if (amlCheck.code === "OTP_REQUIRED") {
          const target = userFull.email || userFull.phone;
          if (target) {
            try {
              await dispatchOtp(target, TRANSFER_OTP_TYPE, { country: biz.country });
            } catch (err) {
              console.error("[transfers] OTP dispatch failed:", err.message);
              return { status: 503, body: { error: "Could not send the verification code. Please try again.", code: "OTP_DISPATCH_FAILED" } };
            }
          }
        }
        return {
          status: amlCheck.status || 400,
          body: {
            error: amlCheck.error,
            code: amlCheck.code,
            ...(amlCheck.otpIdentifier ? { otpIdentifier: amlCheck.otpIdentifier } : {}),
          },
        };
      }

      // Hand off to the shared executor — same code path the cron uses.
      const exec = await executeTransfer({
        business: biz,
        userId: req.user.id,
        amount: Number(amount),
        accountNumber,
        bankCode,
        accountName,
        bankName,
        narration,
        amlCheck,
        req,
        notify: false, // route doesn't push — client UI shows the success state itself
      });
      return { exec };
    });

    if (outcome.status) return res.status(outcome.status).json(outcome.body);
    const { reference, route, fee } = outcome.exec;

    // Optimistically reflect the debit (amount + fee) in the cached "cash at
    // bank" so the dashboard shows the new balance immediately on its next
    // refetch, instead of the up-to-60s-stale value. Reconciles with Anchor when
    // the cache entry expires. Never let a display-cache tweak affect the result.
    try {
      require("../utils/balanceCache").adjustBalance(biz.id, -(Number(amount) + Number(fee || 0)));
    } catch { /* noop */ }

    // Remember the recipient — powers the Send Money "Recents" chips.
    // Best-effort: a failed upsert must never fail a successful transfer.
    prisma.beneficiary
      .upsert({
        where: {
          businessId_accountNumber_bankCode: {
            businessId: biz.id,
            accountNumber,
            bankCode,
          },
        },
        create: {
          businessId: biz.id,
          accountNumber,
          bankCode,
          bankName: bankName || null,
          accountName: accountName || null,
        },
        update: {
          lastUsedAt: new Date(),
          timesUsed: { increment: 1 },
          ...(accountName ? { accountName } : {}),
          ...(bankName ? { bankName } : {}),
        },
      })
      .catch((e) => console.warn("[transfers] beneficiary upsert failed:", e.message));

    res.json({ status: "success", reference, route, fee });

    // Detailed debit alert — fire-and-forget, never affects the transfer result.
    if (userFull.email) {
      const counterparty =
        [accountName, bankName].filter(Boolean).join(" · ") || String(accountNumber);
      require("../utils/transactionEmail").sendTransactionEmail({
        to: userFull.email,
        direction: "debit",
        amount: Number(amount),
        currency: biz.currency || "NGN",
        counterparty,
        narration,
        fee,
        reference,
        businessName: biz.name,
        dateLabel: new Date().toLocaleString("en-NG", { dateStyle: "medium", timeStyle: "short" }),
      });
    }
  } catch (err) {
    if (err.code === "ANCHOR_NOT_CONFIGURED")
      return res.status(503).json({ error: "Transfers not configured on this server." });
    if (err.code === "INSUFFICIENT_BALANCE")
      return res.status(400).json({ error: err.message, code: err.code });
    if (err.code === "RECIPIENT_UNVERIFIED" || err.code === "UNKNOWN_BANK")
      return res.status(400).json({ error: err.message, code: err.code });
    console.error("Transfer error:", err);
    res.status(400).json({ error: "Transfer failed" });
  }
});

module.exports = router;
