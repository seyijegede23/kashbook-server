// Savings pots — owner only. Staff never see or move savings.
//
//   GET    /savings?businessId=              pots + totals + partner status
//   POST   /savings/pots                     create (ledger | piggyvest)
//   PATCH  /savings/pots/:id                 rename, target, lock (extend only)
//   DELETE /savings/pots/:id                 close an empty pot
//   POST   /savings/pots/:id/deposit         put money in (PIN)
//   POST   /savings/pots/:id/withdraw        take money out (PIN)
//   GET    /savings/pots/:id/movements       history, newest first
//
// Money paths live in utils/savings.js. This file does what every money route
// does before the lock: ownership, input shape, the PIN (audited on failure),
// and for a PiggyVest deposit the same AML pipeline as /transfers/send, run
// INSIDE the business lock through the service's runChecks hook.
const router = require("express").Router();
const prisma = require("../utils/db");
const auth = require("../middleware/auth");
const requireUnfrozen = require("../middleware/requireUnfrozen");
const { ownerOnly } = require("../middleware/requirePermission");
const { verifyTransactionPin } = require("../utils/transactionPin");
const { audit } = require("../utils/audit");
const { runPreTransferChecks } = require("../utils/amlChecks");
const { dispatchOtp } = require("../utils/otp");
const { TRANSFER_OTP_TYPE } = require("../config/amlLimits");
const { getReservedBalance } = require("../utils/savingsReserve");
const savings = require("../utils/savings");

router.use(auth);
router.use(requireUnfrozen);
router.use(ownerOnly("Only the business owner can manage savings."));

function sendError(res, err) {
  if (err instanceof savings.SavingsError) {
    const { message, code, status, stack: _s, name: _n, ...extra } = err;
    return res.status(status || 400).json({ error: message, code, ...extra });
  }
  if (err?.code === "ANCHOR_NOT_CONFIGURED" || err?.code === "PVB_NOT_CONFIGURED") {
    return res.status(503).json({ error: "Savings is not configured on this server.", code: "SAVINGS_UNAVAILABLE" });
  }
  console.error("[savings]", err);
  return res.status(500).json({ error: "Something went wrong with savings. Please try again." });
}

async function loadBusiness(req, businessId) {
  if (!businessId) return null;
  return prisma.business.findFirst({ where: { id: String(businessId), userId: req.user.id } });
}

async function loadPot(req, potId, businessId) {
  const pot = await prisma.savingsPot.findUnique({ where: { id: String(potId) } });
  if (!pot) return { error: { status: 404, body: { error: "Pot not found." } } };
  if (businessId && pot.businessId !== String(businessId)) return { error: { status: 404, body: { error: "Pot not found." } } };
  const biz = await loadBusiness(req, pot.businessId);
  if (!biz) return { error: { status: 403, body: { error: "Forbidden" } } };
  return { pot, biz };
}

// Same PIN discipline as /transfers/send: verified BEFORE any lock or money
// read, a failure audited.
async function checkPin(req, res) {
  const pinCheck = await verifyTransactionPin(req.user.id, req.body?.pin);
  if (!pinCheck.ok) {
    await audit({ req, action: "PIN_FAILED", resourceType: "user", resourceId: req.user.id, severity: "warn", metadata: { code: pinCheck.code, where: "savings" } });
    res.status(pinCheck.status || 401).json({ error: pinCheck.error, code: pinCheck.code });
    return false;
  }
  return true;
}

// GET /savings?businessId=
router.get("/", async (req, res) => {
  try {
    const biz = await loadBusiness(req, req.query.businessId);
    if (!biz) return res.status(404).json({ error: "Business not found" });
    const pots = await prisma.savingsPot.findMany({
      where: { businessId: biz.id, status: { not: "closed" } },
      orderBy: { createdAt: "asc" },
    });
    const reserved = await getReservedBalance(biz.id);
    const totals = pots.reduce(
      (t, p) => {
        t.saved += Number(p.balance) || 0;
        t.interestEarned += Number(p.interestEarned) || 0;
        t.interestAccruedMtd += Number(p.interestAccruedMtd) || 0;
        return t;
      },
      { saved: 0, reserved, interestEarned: 0, interestAccruedMtd: 0 },
    );
    const profile = await prisma.savingsProfile.findUnique({ where: { businessId: biz.id }, select: { status: true } });
    const brk = require("../config/fees").breakFeeConfig();
    res.json({
      enabled: savings.isEnabled(),
      pots: pots.map(savings.publicPot),
      totals,
      partner: { available: savings.partnerAvailable(), status: profile?.status || "none", name: "PiggyVest" },
      hasBankAccount: !!(biz.providerAccountId || biz.anchorAccountId),
      // What breaking a flexible lock costs, so the app can say so up front.
      breakFee: { enabled: brk.enabled && brk.bps > 0, bps: brk.bps, pct: brk.bps / 100, min: brk.min },
    });
  } catch (err) {
    sendError(res, err);
  }
});

// POST /savings/pots
router.post("/pots", async (req, res) => {
  try {
    const { businessId, name, targetAmount, backing, lockUntil, lockMode } = req.body || {};
    const biz = await loadBusiness(req, businessId);
    if (!biz) return res.status(404).json({ error: "Business not found" });
    const user = await prisma.user.findUnique({ where: { id: req.user.id }, select: { id: true, firstName: true, lastName: true, email: true, phone: true } });
    const pot = await savings.createPot({ biz, user, name, targetAmount, backing, lockUntil, lockMode });
    await audit({ req, action: "SAVINGS_POT_CREATED", resourceType: "savingsPot", resourceId: pot.id, metadata: { backing: pot.backing, lockMode: pot.lockMode || null } });
    res.status(201).json({ pot: savings.publicPot(pot) });
  } catch (err) {
    sendError(res, err);
  }
});

// PATCH /savings/pots/:id
router.patch("/pots/:id", async (req, res) => {
  try {
    const { pot, biz, error } = await loadPot(req, req.params.id, req.body?.businessId);
    if (error) return res.status(error.status).json(error.body);
    if (pot.status === "closed") return res.status(409).json({ error: "This pot is closed.", code: "POT_CLOSED" });
    const { name, targetAmount, lockUntil, lockMode } = req.body || {};
    const updated = await savings.updatePot({ pot, name, targetAmount, lockUntil, lockMode });
    await audit({ req, action: "SAVINGS_POT_UPDATED", resourceType: "savingsPot", resourceId: pot.id, metadata: { fields: Object.keys(req.body || {}).filter((k) => k !== "businessId") } });
    res.json({ pot: savings.publicPot(updated), businessId: biz.id });
  } catch (err) {
    sendError(res, err);
  }
});

// DELETE /savings/pots/:id
router.delete("/pots/:id", async (req, res) => {
  try {
    const { pot, error } = await loadPot(req, req.params.id, req.query?.businessId);
    if (error) return res.status(error.status).json(error.body);
    await savings.closePot(pot);
    await audit({ req, action: "SAVINGS_POT_CLOSED", resourceType: "savingsPot", resourceId: pot.id });
    res.status(204).end();
  } catch (err) {
    sendError(res, err);
  }
});

// POST /savings/pots/:id/deposit  { businessId, amount, pin, idempotencyKey?, otp? }
router.post("/pots/:id/deposit", async (req, res) => {
  try {
    const { businessId, amount, idempotencyKey, otp } = req.body || {};
    if (amount === undefined || amount === null || amount === "") return res.status(400).json({ error: "Enter an amount.", code: "BAD_AMOUNT" });
    if (!(await checkPin(req, res))) return;
    const { pot, biz, error } = await loadPot(req, req.params.id, businessId);
    if (error) return res.status(error.status).json(error.body);
    const owner = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { id: true, accountStatus: true, complianceFreezeReason: true, email: true, phone: true, firstName: true, lastName: true },
    });

    // A PiggyVest deposit is a real outbound transfer: it passes the same AML
    // pipeline as Send Money (limits, velocity, step-up OTP), inside the lock.
    const runChecks = async () => {
      const amlCheck = await runPreTransferChecks({ req, user: owner, business: biz, amount: Number(amount), otp });
      if (amlCheck.ok) return { ok: true, amlCheck };
      if (amlCheck.code === "OTP_REQUIRED" && amlCheck.otpTarget) {
        try { await dispatchOtp(amlCheck.otpTarget, TRANSFER_OTP_TYPE, { country: biz.country }); }
        catch (e) {
          console.error("[savings] OTP dispatch failed:", e.message);
          return { ok: false, outcome: { status: 503, body: { error: "Could not send the verification code. Please try again.", code: "OTP_DISPATCH_FAILED" } } };
        }
      }
      // Whitelist: otpTarget is the unmasked destination and must not leave.
      return {
        ok: false,
        outcome: {
          status: amlCheck.status || 400,
          body: { error: amlCheck.error, code: amlCheck.code, ...(amlCheck.otpIdentifier ? { otpIdentifier: amlCheck.otpIdentifier } : {}) },
        },
      };
    };

    const result = await savings.depositToPot({ biz, user: owner, pot, amount, idempotencyKey, req, runChecks });
    if (result.refused) return res.status(result.refused.status).json(result.refused.body);
    const reserved = await getReservedBalance(biz.id);
    res.status(result.pending ? 202 : 200).json({
      movement: savings.publicMovement(result.movement),
      pot: savings.publicPot(result.pot),
      reserved,
      replay: !!result.replay,
    });
  } catch (err) {
    sendError(res, err);
  }
});

// POST /savings/pots/:id/withdraw  { businessId, amount, pin, idempotencyKey?, confirmEarly?, acceptInterestForfeit? }
router.post("/pots/:id/withdraw", async (req, res) => {
  try {
    const { businessId, amount, idempotencyKey, confirmEarly, acceptInterestForfeit } = req.body || {};
    if (amount === undefined || amount === null || amount === "") return res.status(400).json({ error: "Enter an amount.", code: "BAD_AMOUNT" });
    if (!(await checkPin(req, res))) return;
    const { pot, biz, error } = await loadPot(req, req.params.id, businessId);
    if (error) return res.status(error.status).json(error.body);
    const result = await savings.withdrawFromPot({
      biz, user: { id: req.user.id }, pot, amount, idempotencyKey,
      confirmEarly: confirmEarly === true, acceptInterestForfeit: acceptInterestForfeit === true, req,
    });
    const reserved = await getReservedBalance(biz.id);
    res.status(result.pending ? 202 : 200).json({
      movement: savings.publicMovement(result.movement),
      pot: savings.publicPot(result.pot),
      reserved,
      replay: !!result.replay,
    });
  } catch (err) {
    sendError(res, err);
  }
});

// GET /savings/pots/:id/movements?businessId=&cursor=
router.get("/pots/:id/movements", async (req, res) => {
  try {
    const { pot, error } = await loadPot(req, req.params.id, req.query?.businessId);
    if (error) return res.status(error.status).json(error.body);
    const take = 30;
    const cursor = req.query.cursor ? String(req.query.cursor) : null;
    const rows = await prisma.savingsMovement.findMany({
      where: { potId: pot.id },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: take + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const page = rows.slice(0, take);
    res.json({
      movements: page.map(savings.publicMovement),
      nextCursor: rows.length > take ? page[page.length - 1].id : null,
      pot: savings.publicPot(pot),
    });
  } catch (err) {
    sendError(res, err);
  }
});

module.exports = router;
