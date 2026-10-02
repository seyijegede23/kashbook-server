// Savings: pots ring-fenced in the merchant's own KashBook bank account.
//
// A pot moves no money. Its balance is a reserve that every spend path
// subtracts first (utils/savingsReserve.js, enforced in executeTransfer's
// balance gate under the caller's business lock), so Send Money, approvals,
// payroll and recurring debits can only spend what is not set aside. Putting
// money in and taking it out are one atomic database write each, under the
// same per-business lock, so a deposit and a send can never both pass the gate
// on the same naira.
//
// Locks: `strict` cannot be broken before its date by anyone; `flexible` can,
// after the merchant confirms, for a fee (config/fees.js computeBreakFee) that
// is swept to KashBook's fee account as a book transfer and booked as a
// Transaction with purpose "savings_fee" (the ledger counts it, reports skip it).
//
// Interest-earning pots held at an external savings partner were built and
// then removed on 2026-10-02 after the partner declined the API request. The
// backup branch dated 2026-10-02 in both repos holds that code.
const crypto = require("crypto");
const prisma = require("./db");
const anchor = require("./anchor");
const { getSpendableBalance } = require("./savingsReserve");
const { computeBreakFee, MONEY_EPS } = require("../config/fees");
const { formatAmountForBusiness } = require("../config/amlLimits");
const { audit } = require("./audit");
const { toKobo, sameMoney } = require("./money");
const balanceCache = require("./balanceCache");

class SavingsError extends Error {
  constructor(message, code, status = 400, extra = {}) {
    super(message);
    this.code = code;
    this.status = status;
    Object.assign(this, extra);
  }
}

const MAX_POTS = 10;
const DEPOSIT_REF_PREFIX = "kb_sv_";
const WITHDRAWAL_REF_PREFIX = "kb_svw_";

// Creation and deposits are behind the switch; reads, withdrawals, the reserve
// and the reconcile loop run whenever a pot exists, so turning the switch off
// never traps money.
const isEnabled = () => process.env.SAVINGS_ENABLED === "true";

// ── Pure helpers (tested without a DB) ──────────────────────────────────────

// May this withdrawal go ahead against the pot's lock?
//   { ok: true } | { ok: true, early: true } |
//   { ok: false, code: "POT_LOCKED" | "EARLY_WITHDRAWAL_CONFIRM", until }
function lockAllows(pot, { now = new Date(), confirmEarly = false } = {}) {
  if (!pot?.lockUntil) return { ok: true };
  const until = new Date(pot.lockUntil);
  if (!(until > now)) return { ok: true };
  if (pot.lockMode === "strict") return { ok: false, code: "POT_LOCKED", until };
  return confirmEarly ? { ok: true, early: true } : { ok: false, code: "EARLY_WITHDRAWAL_CONFIRM", until };
}

const money2dp = (n) => Math.round(Number(n) * 100) === Number(n) * 100;

function sanitizeKey(key) {
  return key ? String(key).replace(/[^a-zA-Z0-9]/g, "").slice(0, 40) : "";
}
// The client key becomes the reference verbatim (sanitised), like /transfers
// send does with kbtf_. Keys are minted per attempt from a clock plus random
// letters, so two merchants colliding is not a real risk, and a reference the
// merchant can read back in the movement list is worth more than a hash.
const keyedRef = (prefix, key) => `${prefix}${sanitizeKey(key) || crypto.randomBytes(8).toString("hex")}`;
const depositRef = (key) => keyedRef(DEPOSIT_REF_PREFIX, key);
const withdrawalRef = (key) => keyedRef(WITHDRAWAL_REF_PREFIX, key);

// The answer to a repeated request: the row it already made, never a second
// one. A different amount under the same key is a client bug, named as such.
function replayOutcome(existing, amt, pot) {
  if (!sameMoney(existing.amount, amt)) {
    throw new SavingsError("That request key was already used for a different amount.", "IDEMPOTENCY_MISMATCH", 409);
  }
  return { movement: existing, pot, replay: true };
}

// ── Views ────────────────────────────────────────────────────────────────────

function publicPot(pot) {
  if (!pot) return null;
  return {
    id: pot.id,
    businessId: pot.businessId,
    name: pot.name,
    targetAmount: pot.targetAmount,
    status: pot.status,
    balance: Number(pot.balance) || 0,
    lockUntil: pot.lockUntil,
    lockMode: pot.lockMode,
    locked: !!(pot.lockUntil && new Date(pot.lockUntil) > new Date()),
    createdAt: pot.createdAt,
    closedAt: pot.closedAt,
  };
}

function publicMovement(m) {
  if (!m) return null;
  return {
    id: m.id,
    potId: m.potId,
    type: m.type,
    amount: Number(m.amount) || 0,
    fee: Number(m.fee) || 0,
    status: m.status,
    reference: m.reference,
    createdAt: m.createdAt,
    completedAt: m.completedAt,
  };
}

// ── Freeze ───────────────────────────────────────────────────────────────────
// Same gate as sending money. Checked INSIDE the business lock, in addition to
// requireUnfrozen on the route, because a freeze can land in between.
async function assertNotFrozen(biz) {
  if (biz?.accountStatus && biz.accountStatus !== "active") {
    throw new SavingsError("This business is under review. Contact support to resolve.", "FROZEN", 423);
  }
  const owner = await prisma.user.findUnique({ where: { id: biz.userId }, select: { accountStatus: true } });
  if (owner?.accountStatus && owner.accountStatus !== "active") {
    throw new SavingsError("Your account is under review. Contact support to resolve.", "FROZEN", 423);
  }
}

// ── Pots ─────────────────────────────────────────────────────────────────────

function validateLock({ lockUntil, lockMode }) {
  if (!lockUntil) return { lockUntil: null, lockMode: null };
  const d = new Date(lockUntil);
  if (Number.isNaN(d.getTime())) throw new SavingsError("Lock date is invalid.", "BAD_LOCK", 400);
  if (!(d > new Date())) throw new SavingsError("Lock date must be in the future.", "BAD_LOCK", 400);
  if (d > new Date(Date.now() + 5 * 366 * 86400000)) throw new SavingsError("Lock date is too far away (5 years at most).", "BAD_LOCK", 400);
  if (!["strict", "flexible"].includes(lockMode)) throw new SavingsError("Choose a lock type: strict or flexible.", "BAD_LOCK", 400);
  return { lockUntil: d, lockMode };
}

async function createPot({ biz, name, targetAmount, lockUntil, lockMode }) {
  if (!isEnabled()) throw new SavingsError("Savings is not available yet.", "SAVINGS_DISABLED", 403);
  const cleanName = String(name || "").trim().slice(0, 40);
  if (cleanName.length < 1) throw new SavingsError("Give the pot a name.", "BAD_NAME", 400);
  let target = null;
  if (targetAmount !== undefined && targetAmount !== null && targetAmount !== "") {
    target = Number(targetAmount);
    if (!(target > 0) || !money2dp(target)) throw new SavingsError("Target must be a positive amount with at most 2 decimals.", "BAD_AMOUNT", 400);
  }
  if (!lockUntil && lockMode) throw new SavingsError("Send lockUntil with lockMode.", "BAD_LOCK", 400);
  const lock = validateLock({ lockUntil, lockMode });
  if (!(biz.providerAccountId || biz.anchorAccountId)) {
    throw new SavingsError("Open your KashBook bank account first, then start saving.", "NO_BANKING", 400);
  }
  const open = await prisma.savingsPot.count({ where: { businessId: biz.id, status: { not: "closed" } } });
  if (open >= MAX_POTS) throw new SavingsError(`You can have up to ${MAX_POTS} pots. Close one to add another.`, "POT_LIMIT", 409);
  return prisma.savingsPot.create({
    data: { businessId: biz.id, userId: biz.userId, name: cleanName, targetAmount: target, status: "active", ...lock },
  });
}

async function updatePot({ pot, name, targetAmount, lockUntil, lockMode }) {
  const data = {};
  if (name !== undefined) {
    const cleanName = String(name || "").trim().slice(0, 40);
    if (!cleanName) throw new SavingsError("Give the pot a name.", "BAD_NAME", 400);
    data.name = cleanName;
  }
  if (targetAmount !== undefined) {
    if (targetAmount === null || targetAmount === "") data.targetAmount = null;
    else {
      const t = Number(targetAmount);
      if (!(t > 0) || !money2dp(t)) throw new SavingsError("Target must be a positive amount with at most 2 decimals.", "BAD_AMOUNT", 400);
      data.targetAmount = t;
    }
  }
  if (lockUntil !== undefined) {
    const now = new Date();
    const strictActive = pot.lockMode === "strict" && pot.lockUntil && new Date(pot.lockUntil) > now;
    if (lockUntil === null || lockUntil === "") {
      if (strictActive) throw new SavingsError("A strict lock cannot be removed before its date.", "LOCK_CANNOT_SHORTEN", 409);
      data.lockUntil = null; data.lockMode = null;
    } else {
      const lock = validateLock({ lockUntil, lockMode: lockMode || pot.lockMode || "flexible" });
      if (strictActive && (lock.lockUntil < new Date(pot.lockUntil) || lock.lockMode !== "strict")) {
        throw new SavingsError("A strict lock can be extended but not shortened or relaxed.", "LOCK_CANNOT_SHORTEN", 409);
      }
      data.lockUntil = lock.lockUntil; data.lockMode = lock.lockMode;
    }
  } else if (lockMode !== undefined) {
    throw new SavingsError("Send lockUntil with lockMode.", "BAD_LOCK", 400);
  }
  if (!Object.keys(data).length) return pot;
  return prisma.savingsPot.update({ where: { id: pot.id }, data });
}

// Close only an empty pot. Under the lock, so a deposit cannot slip in between
// the balance check and the close.
async function closePot(pot) {
  return prisma.withBusinessLock(pot.businessId, async () => {
    const fresh = await prisma.savingsPot.findUnique({ where: { id: pot.id } });
    if (!fresh || fresh.status === "closed") return fresh;
    if (toKobo(fresh.balance) > 0) throw new SavingsError("Take the money out before closing this pot.", "POT_NOT_EMPTY", 409, { balance: fresh.balance });
    const r = await prisma.savingsPot.updateMany({
      where: { id: pot.id, status: "active" },
      data: { status: "closed", balance: 0, closedAt: new Date() },
    });
    if (r.count !== 1) throw new SavingsError("Pot changed while closing. Try again.", "CONFLICT", 409);
    return prisma.savingsPot.findUnique({ where: { id: pot.id } });
  });
}

// ── Deposits ─────────────────────────────────────────────────────────────────

function validateAmount(amount) {
  const n = Number(amount);
  if (!(n > 0)) throw new SavingsError("Enter an amount.", "BAD_AMOUNT", 400);
  if (!money2dp(n)) throw new SavingsError("Amount cannot have more than 2 decimal places.", "BAD_AMOUNT", 400);
  return n;
}

async function depositToPot({ biz, user, pot, amount, idempotencyKey, req = null }) {
  if (!isEnabled()) throw new SavingsError("Savings is not available yet.", "SAVINGS_DISABLED", 403);
  const amt = validateAmount(amount);
  const reference = depositRef(idempotencyKey);

  return prisma.withBusinessLock(biz.id, async () => {
    await assertNotFrozen(biz);
    const fresh = await prisma.savingsPot.findUnique({ where: { id: pot.id } });
    if (!fresh || fresh.businessId !== biz.id) throw new SavingsError("Pot not found.", "NOT_FOUND", 404);
    if (fresh.status !== "active") throw new SavingsError("This pot is not open.", "POT_NOT_READY", 409);

    // Idempotency: the same key answers for the same movement, never a second.
    const existing = await prisma.savingsMovement.findUnique({ where: { reference } });
    if (existing) {
      if (existing.potId !== fresh.id) throw new SavingsError("That request key was already used for another pot.", "IDEMPOTENCY_REUSED", 409);
      return replayOutcome(existing, amt, fresh);
    }

    // The money stays put; the only check is that it exists and is not
    // already promised. Fail closed if the bank cannot be read.
    let live;
    try { live = await getSpendableBalance(biz); }
    catch (e) {
      if (e.code === "ANCHOR_NOT_CONFIGURED") throw new SavingsError("Banking is not configured on this server.", "NO_BANKING", 503);
      throw new SavingsError("Could not read your bank balance right now. Try again shortly.", "BALANCE_UNAVAILABLE", 503);
    }
    if (live.spendable + MONEY_EPS < amt) {
      throw new SavingsError(
        `Only ${formatAmountForBusiness(biz, live.spendable)} is available to set aside${live.reserved > 0 ? ` (${formatAmountForBusiness(biz, live.reserved)} is already in savings)` : ""}.`,
        "INSUFFICIENT_BALANCE", 400, { availableBalance: live.spendable, reserved: live.reserved },
      );
    }
    const result = await prisma.$transaction(async (px) => {
      const claim = await px.savingsPot.updateMany({
        where: { id: fresh.id, status: "active" },
        data: { balance: { increment: amt } },
      });
      if (claim.count !== 1) throw new SavingsError("Pot changed while saving. Try again.", "CONFLICT", 409);
      const movement = await px.savingsMovement.create({
        data: { potId: fresh.id, businessId: biz.id, userId: user?.id || biz.userId, type: "deposit", amount: amt, status: "completed", reference, completedAt: new Date() },
      });
      const updatedPot = await px.savingsPot.findUnique({ where: { id: fresh.id } });
      return { movement, pot: updatedPot };
    });
    await audit({ req, action: "SAVINGS_DEPOSIT", resourceType: "savingsPot", resourceId: fresh.id, metadata: { amount: amt, reference } });
    return result;
  });
}

// ── Withdrawals ──────────────────────────────────────────────────────────────

async function withdrawFromPot({ biz, user, pot, amount, idempotencyKey, confirmEarly = false, req = null }) {
  const amt = validateAmount(amount);
  const reference = withdrawalRef(idempotencyKey);

  return prisma.withBusinessLock(biz.id, async () => {
    await assertNotFrozen(biz);
    const fresh = await prisma.savingsPot.findUnique({ where: { id: pot.id } });
    if (!fresh || fresh.businessId !== biz.id) throw new SavingsError("Pot not found.", "NOT_FOUND", 404);
    if (fresh.status !== "active") throw new SavingsError("This pot is not open.", "POT_NOT_READY", 409);

    const existing = await prisma.savingsMovement.findUnique({ where: { reference } });
    if (existing) {
      if (existing.potId !== fresh.id) throw new SavingsError("That request key was already used for another pot.", "IDEMPOTENCY_REUSED", 409);
      return replayOutcome(existing, amt, fresh);
    }

    const lock = lockAllows(fresh, { confirmEarly });
    // Breaking a flexible lock costs a share of the amount (config/fees.js).
    // The refusal that asks for confirmation carries the figure, so the app
    // can say "taking ₦50,000 out early costs ₦1,000" before the merchant agrees.
    const breakFee = lock.early || lock.code === "EARLY_WITHDRAWAL_CONFIRM" ? computeBreakFee(amt) : { fee: 0, bps: 0 };
    if (!lock.ok) {
      const when = lock.until.toLocaleDateString("en-NG", { day: "numeric", month: "short", year: "numeric" });
      throw new SavingsError(
        lock.code === "POT_LOCKED"
          ? `This pot is locked until ${when}.`
          : breakFee.fee > 0
            ? `This pot is meant to stay untouched until ${when}. Taking ${formatAmountForBusiness(biz, amt)} out early costs ${formatAmountForBusiness(biz, breakFee.fee)}. Confirm to continue.`
            : `This pot is meant to stay untouched until ${when}. Confirm to take money out early.`,
        lock.code, lock.code === "POT_LOCKED" ? 423 : 409,
        // feeBps is 0 when nothing will be charged (fees off), so a client that
        // derives the rate from it never shows 2% for a free withdrawal.
        { lockUntil: fresh.lockUntil, fee: breakFee.fee, feeBps: breakFee.fee > 0 ? breakFee.bps : 0 },
      );
    }
    const fee = lock.early ? breakFee.fee : 0;

    const result = await prisma.$transaction(async (px) => {
      const claim = await px.savingsPot.updateMany({
        where: { id: fresh.id, status: "active", balance: { gte: amt - MONEY_EPS } },
        data: { balance: { decrement: amt } },
      });
      if (claim.count !== 1) throw new SavingsError(`This pot has ${formatAmountForBusiness(biz, fresh.balance)}.`, "INSUFFICIENT_POT_BALANCE", 400, { potBalance: fresh.balance });
      const movement = await px.savingsMovement.create({
        data: { potId: fresh.id, businessId: biz.id, userId: user?.id || biz.userId, type: "withdrawal", amount: amt, fee, status: "completed", reference, completedAt: new Date() },
      });
      const updatedPot = await px.savingsPot.findUnique({ where: { id: fresh.id } });
      // A float drifting a hair below zero is a rounding artefact, not money.
      if (updatedPot.balance < 0 && updatedPot.balance > -MONEY_EPS) {
        await px.savingsPot.update({ where: { id: fresh.id }, data: { balance: 0 } });
        updatedPot.balance = 0;
      }
      return { movement, pot: updatedPot };
    });
    await audit({ req, action: "SAVINGS_WITHDRAWAL", resourceType: "savingsPot", resourceId: fresh.id, metadata: { amount: amt, reference, early: !!lock.early, fee } });
    // The money is in the Anchor account already, so the fee is swept now.
    // Best effort: a failed sweep alerts a human and never blocks the
    // withdrawal the merchant just confirmed.
    if (fee > 0) {
      await collectBreakFee(result.movement.id).catch((e) => console.error(`[savings] break fee ${reference}:`, e.message));
      result.movement = await prisma.savingsMovement.findUnique({ where: { id: result.movement.id } });
    }
    return result;
  });
}

// Sweep the early-withdrawal fee to KashBook's fee account. Called right after
// the withdrawal, and by the reconcile loop for any fee a crash left behind.
//
// The claim comes BEFORE the transfer. A double sweep would charge the
// merchant twice; a missed one costs KashBook a fee. So on a failure the row
// stays claimed, nothing retries by itself, and a human settles it from the
// alert (Anchor dedups on the reference for 24h anyway).
async function collectBreakFee(movementId) {
  const mv = await prisma.savingsMovement.findUnique({ where: { id: movementId }, include: { pot: { select: { name: true } } } });
  if (!mv || mv.type !== "withdrawal" || mv.status !== "completed" || !(Number(mv.fee) > 0) || mv.feeCollectedAt) return false;
  const feeAccount = process.env.ANCHOR_FEE_ACCOUNT_ID;
  if (!feeAccount) return false;
  const biz = await prisma.business.findUnique({
    where: { id: mv.businessId },
    select: { id: true, userId: true, name: true, anchorAccountId: true, baseCurrency: true, country: true },
  });
  if (!biz?.anchorAccountId) return false;
  const claim = await prisma.savingsMovement.updateMany({ where: { id: mv.id, feeCollectedAt: null }, data: { feeCollectedAt: new Date() } });
  if (claim.count !== 1) return false;
  const reference = `${mv.reference}_bfee`;
  const fee = Math.round(Number(mv.fee) * 100) / 100;
  try {
    const book = await anchor.createBookTransfer({
      fromAccountId: biz.anchorAccountId,
      toAccountId: feeAccount,
      amount: fee,
      reason: `Savings early withdrawal fee · ${mv.pot?.name || "pot"}`,
      reference,
    });
    // The ledger row: real money off the account (computeLedgerBalance counts
    // it), left out of the reports by its purpose.
    await prisma.transaction.create({
      data: {
        businessId: biz.id, userId: biz.userId, type: "expense", amount: fee,
        description: `Early withdrawal fee · ${mv.pot?.name || "savings"} · Ref: ${reference}`,
        category: "transfer", paymentMethod: "bank", date: new Date(), source: "anchor",
        reference, providerTxnId: book?.transferId || undefined, purpose: "savings_fee",
        currency: biz.baseCurrency || "NGN",
      },
    }).catch((e) => { if (e.code !== "P2002") throw e; });
    try { balanceCache.adjustBalance(biz.id, -fee); } catch { /* noop */ }
    await audit({ action: "SAVINGS_BREAK_FEE", resourceType: "savingsMovement", resourceId: mv.id, metadata: { fee, reference } });
    return true;
  } catch (e) {
    console.error(`[savings] break fee sweep failed for ${mv.reference}:`, e.message);
    await audit({ action: "SAVINGS_BREAK_FEE_FAILED", resourceType: "savingsMovement", resourceId: mv.id, severity: "alert", metadata: { fee, reference, error: String(e.message || "").slice(0, 200) } });
    require("./alerts").fireAlert(`savings-break-fee-${mv.id}`, "Savings break fee not collected", `The ₦${fee} early-withdrawal fee on ${mv.reference} (${biz.name}) could not be swept: ${String(e.message || "").slice(0, 120)}. The row is marked collected so it is never charged twice; collect it by hand.`).catch(() => {});
    return false;
  }
}

module.exports = {
  SavingsError,
  MAX_POTS,
  DEPOSIT_REF_PREFIX,
  WITHDRAWAL_REF_PREFIX,
  isEnabled,
  // pure
  lockAllows,
  replayOutcome,
  // views
  publicPot,
  publicMovement,
  // money paths
  assertNotFrozen,
  createPot,
  updatePot,
  closePot,
  depositToPot,
  withdrawFromPot,
  collectBreakFee,
};
