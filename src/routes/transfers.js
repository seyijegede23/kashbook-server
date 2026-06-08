const router = require("express").Router();
const auth = require("../middleware/auth");
const requireUnfrozen = require("../middleware/requireUnfrozen");
const prisma = require("../utils/db");
const anchor = require("../utils/anchor");
const { verifyTransactionPin } = require("../utils/transactionPin");
const { runPreTransferChecks } = require("../utils/amlChecks");
const { audit } = require("../utils/audit");
const { dispatchOtp } = require("../utils/otp");
const { executeTransfer } = require("../utils/executeTransfer");
const { STEP_UP_OTP_ABOVE, TRANSFER_OTP_TYPE } = require("../config/amlLimits");

router.use(auth);
router.use(requireUnfrozen);

// GET /transfers/banks
router.get("/banks", async (_req, res) => {
  try {
    const banks = await anchor.getBanks();
    res.json(banks);
  } catch (err) {
    if (err.code === "ANCHOR_NOT_CONFIGURED")
      return res.status(503).json({ error: "Transfers not configured on this server." });
    res.status(500).json({ error: err.message || "Failed to fetch banks" });
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
        anchorAccountId: { not: null },
      },
      select: { name: true, virtualAccountName: true },
    });
    if (internal) {
      return res.json({
        accountName: internal.virtualAccountName || internal.name,
        internal: true,
      });
    }

    const ne = await anchor.verifyCounterparty({ accountNumber, bankCode });
    if (!ne.accountName)
      return res.status(400).json({ error: "Account not found" });
    res.json({ accountName: ne.accountName, internal: false });
  } catch (err) {
    if (err.code === "ANCHOR_NOT_CONFIGURED")
      return res.status(503).json({ error: "Transfers not configured on this server." });
    res
      .status(400)
      .json({ error: err.message || "Could not verify account. Check the number and bank." });
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
    if (!biz.anchorAccountId) return res.json({ balance: 0 });

    const { balance } = await anchor.getAccountBalance(biz.anchorAccountId);
    res.json({ balance });
  } catch (err) {
    if (err.code === "ANCHOR_NOT_CONFIGURED") return res.json({ balance: 0 });
    res.status(500).json({ error: err.message || "Failed to fetch balance" });
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

    if (!biz.anchorAccountId)
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
            return res.status(503).json({
              error: "Could not send the verification code. Please try again.",
              code: "OTP_DISPATCH_FAILED",
            });
          }
        }
      }
      return res
        .status(amlCheck.status || 400)
        .json({
          error: amlCheck.error,
          code: amlCheck.code,
          ...(amlCheck.otpIdentifier ? { otpIdentifier: amlCheck.otpIdentifier } : {}),
        });
    }

    // Hand off to the shared executor — same code path the cron uses.
    const { reference, route } = await executeTransfer({
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

    res.json({ status: "success", reference, route });
  } catch (err) {
    if (err.code === "ANCHOR_NOT_CONFIGURED")
      return res.status(503).json({ error: "Transfers not configured on this server." });
    if (err.code === "INSUFFICIENT_BALANCE")
      return res.status(400).json({ error: err.message, code: err.code });
    if (err.code === "RECIPIENT_UNVERIFIED" || err.code === "UNKNOWN_BANK")
      return res.status(400).json({ error: err.message, code: err.code });
    console.error("Transfer error:", err);
    res.status(400).json({ error: err.message || "Transfer failed" });
  }
});

module.exports = router;
