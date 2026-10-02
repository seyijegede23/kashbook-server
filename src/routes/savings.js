// Savings pots — owner only. Staff never see or move savings.
//
//   GET    /savings?businessId=              pots + totals + the break fee
//   POST   /savings/pots                     create
//   PATCH  /savings/pots/:id                 rename, target, lock (extend only)
//   DELETE /savings/pots/:id                 close an empty pot
//   POST   /savings/pots/:id/deposit         put money in (PIN)
//   POST   /savings/pots/:id/withdraw        take money out (PIN)
//   GET    /savings/pots/:id/movements       history, newest first
//
// Money paths live in utils/savings.js. This file does what every money route
// does before the lock: ownership, input shape, and the PIN (audited on
// failure). No AML pipeline here: a pot moves no money, and the only debit the
// feature makes is KashBook's own break fee.
const router = require("express").Router();
const prisma = require("../utils/db");
const auth = require("../middleware/auth");
const requireUnfrozen = require("../middleware/requireUnfrozen");
const { ownerOnly } = require("../middleware/requirePermission");
const { verifyTransactionPin } = require("../utils/transactionPin");
const { audit } = require("../utils/audit");
const { getReservedBalance } = require("../utils/savingsReserve");
const { breakFeeConfig } = require("../config/fees");
const savings = require("../utils/savings");

router.use(auth);
router.use(requireUnfrozen);
router.use(ownerOnly("Only the business owner can manage savings."));

function sendError(res, err) {
  if (err instanceof savings.SavingsError) {
    const { message, code, status, stack: _s, name: _n, ...extra } = err;
    return res.status(status || 400).json({ error: message, code, ...extra });
  }
  if (err?.code === "ANCHOR_NOT_CONFIGURED") {
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

const breakFeeView = () => {
  const brk = breakFeeConfig();
  return { enabled: brk.enabled && brk.bps > 0, bps: brk.bps, pct: brk.bps / 100, min: brk.min };
};

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
    const saved = pots.reduce((t, p) => t + (Number(p.balance) || 0), 0);
    res.json({
      enabled: savings.isEnabled(),
      pots: pots.map(savings.publicPot),
      totals: { saved, reserved },
      hasBankAccount: !!(biz.providerAccountId || biz.anchorAccountId),
      // What breaking a flexible lock costs, so the app can say so up front.
      breakFee: breakFeeView(),
    });
  } catch (err) {
    sendError(res, err);
  }
});

// POST /savings/pots
router.post("/pots", async (req, res) => {
  try {
    const { businessId, name, targetAmount, lockUntil, lockMode } = req.body || {};
    const biz = await loadBusiness(req, businessId);
    if (!biz) return res.status(404).json({ error: "Business not found" });
    const pot = await savings.createPot({ biz, name, targetAmount, lockUntil, lockMode });
    await audit({ req, action: "SAVINGS_POT_CREATED", resourceType: "savingsPot", resourceId: pot.id, metadata: { lockMode: pot.lockMode || null } });
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

// POST /savings/pots/:id/deposit  { businessId, amount, pin, idempotencyKey? }
router.post("/pots/:id/deposit", async (req, res) => {
  try {
    const { businessId, amount, idempotencyKey } = req.body || {};
    if (amount === undefined || amount === null || amount === "") return res.status(400).json({ error: "Enter an amount.", code: "BAD_AMOUNT" });
    if (!(await checkPin(req, res))) return;
    const { pot, biz, error } = await loadPot(req, req.params.id, businessId);
    if (error) return res.status(error.status).json(error.body);
    const result = await savings.depositToPot({ biz, user: { id: req.user.id }, pot, amount, idempotencyKey, req });
    const reserved = await getReservedBalance(biz.id);
    res.json({
      movement: savings.publicMovement(result.movement),
      pot: savings.publicPot(result.pot),
      reserved,
      replay: !!result.replay,
    });
  } catch (err) {
    sendError(res, err);
  }
});

// POST /savings/pots/:id/withdraw  { businessId, amount, pin, idempotencyKey?, confirmEarly? }
router.post("/pots/:id/withdraw", async (req, res) => {
  try {
    const { businessId, amount, idempotencyKey, confirmEarly } = req.body || {};
    if (amount === undefined || amount === null || amount === "") return res.status(400).json({ error: "Enter an amount.", code: "BAD_AMOUNT" });
    if (!(await checkPin(req, res))) return;
    const { pot, biz, error } = await loadPot(req, req.params.id, businessId);
    if (error) return res.status(error.status).json(error.body);
    const result = await savings.withdrawFromPot({
      biz, user: { id: req.user.id }, pot, amount, idempotencyKey, confirmEarly: confirmEarly === true, req,
    });
    const reserved = await getReservedBalance(biz.id);
    res.json({
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
