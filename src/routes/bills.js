// Bill payments — airtime, data, electricity, cable TV — funded from the
// business's NUBAN via Anchor. Mirrors the /transfers middleware chain:
// auth → requireUnfrozen → staff-block → PIN → AML → executeBillPayment.
const router = require("express").Router();
const auth = require("../middleware/auth");
const requireUnfrozen = require("../middleware/requireUnfrozen");
const prisma = require("../utils/db");
const anchor = require("../utils/anchor");
const { verifyTransactionPin } = require("../utils/transactionPin");
const { runPreTransferChecks } = require("../utils/amlChecks");
const { audit } = require("../utils/audit");
const { dispatchOtp } = require("../utils/otp");
const { executeBillPayment } = require("../utils/executeBillPayment");
const { computeBillFee } = require("../config/fees");
const { TRANSFER_OTP_TYPE } = require("../config/amlLimits");

router.use(auth);
router.use(requireUnfrozen);

const VALID_CATEGORIES = new Set(["airtime", "data", "electricity", "cabletv"]);

// GET /bills/billers?category=airtime
router.get("/billers", async (req, res) => {
  const category = String(req.query.category || "").toLowerCase();
  if (!VALID_CATEGORIES.has(category))
    return res.status(400).json({ error: "Unknown bill category" });
  try {
    res.json(await anchor.listBillers(category));
  } catch (err) {
    console.error("[bills/billers]", err.message);
    res.status(502).json({ error: "Could not load billers right now." });
  }
});

// GET /bills/billers/:id/products
router.get("/billers/:id/products", async (req, res) => {
  try {
    res.json(await anchor.getBillerProducts(req.params.id));
  } catch (err) {
    console.error("[bills/products]", err.message);
    res.status(502).json({ error: "Could not load plans right now." });
  }
});

// GET /bills/fee-quote?amount=&category=
router.get("/fee-quote", async (req, res) => {
  const amount = Number(req.query.amount);
  const category = String(req.query.category || "").toLowerCase();
  if (!amount || amount <= 0) return res.status(400).json({ error: "amount required" });
  const { total, breakdown } = computeBillFee(amount, category);
  res.json({ fee: total, breakdown, total: amount + total });
});

// POST /bills/pay
// body: { businessId, category, customerId, amount, productSlug?, billerName?, pin, otp? }
router.post("/pay", async (req, res) => {
  if (req.user.accountType === "staff")
    return res.status(403).json({ error: "Staff cannot pay bills" });

  const { businessId, category, customerId, amount, productSlug, billerName, pin, otp } = req.body;
  if (!businessId || !category || !customerId || !amount)
    return res.status(400).json({ error: "Missing required fields" });
  if (!VALID_CATEGORIES.has(String(category).toLowerCase()))
    return res.status(400).json({ error: "Unknown bill category" });
  if (isNaN(amount) || Number(amount) <= 0)
    return res.status(400).json({ error: "Invalid amount" });

  const pinCheck = await verifyTransactionPin(req.user.id, pin);
  if (!pinCheck.ok) {
    await audit({
      req, action: "PIN_FAILED", resourceType: "user", resourceId: req.user.id,
      severity: "warn", metadata: { code: pinCheck.code, context: "bill" },
    });
    return res.status(pinCheck.status || 401).json({ error: pinCheck.error, code: pinCheck.code });
  }

  try {
    const biz = await prisma.business.findFirst({ where: { id: businessId, userId: req.user.id } });
    if (!biz) return res.status(404).json({ error: "Business not found" });

    const { getProvider } = require("../providers");
    if (!getProvider(biz).supportsBanking) {
      return res.status(400).json({
        error: "Banking isn't available in your country yet.",
        code: "BANKING_NOT_AVAILABLE",
      });
    }
    if (!biz.anchorAccountId)
      return res.status(400).json({ error: "This business has no bank account. Set one up first." });

    // Same AML pipeline as transfers — bills are money out of the NUBAN.
    const userFull = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { id: true, accountStatus: true, complianceFreezeReason: true, email: true, phone: true },
    });
    const amlCheck = await runPreTransferChecks({
      req, user: userFull, business: biz, amount: Number(amount), otp,
    });
    if (!amlCheck.ok) {
      if (amlCheck.code === "OTP_REQUIRED") {
        const target = userFull.email || userFull.phone;
        if (target) {
          try {
            await dispatchOtp(target, TRANSFER_OTP_TYPE, { country: biz.country });
          } catch (err) {
            console.error("[bills] OTP dispatch failed:", err.message);
            return res.status(503).json({ error: "Could not send the verification code. Please try again.", code: "OTP_DISPATCH_FAILED" });
          }
        }
      }
      return res.status(amlCheck.status || 400).json({
        error: amlCheck.error, code: amlCheck.code,
        ...(amlCheck.otpIdentifier ? { otpIdentifier: amlCheck.otpIdentifier } : {}),
      });
    }

    const { reference, fee, token, transactionId } = await executeBillPayment({
      business: biz,
      userId: req.user.id,
      category: String(category).toLowerCase(),
      customerId,
      amount: Number(amount),
      productSlug,
      billerName,
      amlCheck,
      req,
      notify: false, // client shows its own success state
    });

    res.json({ status: "success", reference, fee, token, transactionId });
  } catch (err) {
    if (err.code === "INSUFFICIENT_BALANCE")
      return res.status(400).json({ error: err.message, code: err.code });
    if (err.code === "NO_BANKING")
      return res.status(400).json({ error: err.message, code: err.code });
    console.error("Bill payment error:", err);
    res.status(400).json({ error: err.message || "Bill payment failed" });
  }
});

module.exports = router;
