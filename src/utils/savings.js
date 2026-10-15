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
// Locks, in the owner's words: an Unbreakable pot (lockMode "strict") cannot
// be opened before its day by anyone, not the owner and not a KashBook admin;
// a Breakable pot ("flexible") can, after the merchant confirms, for a fee
// (config/fees.js computeBreakFee) that is swept to KashBook's fee account as a
// book transfer and booked as a Transaction with purpose "savings_fee", which
// the books count as a Bank Fees and Charges expense (utils/books.js). A pot
// opens at the start of its chosen day, Lagos time (lockOpensAt). Until then
// its day can only move later while it is Unbreakable, or Breakable with money
// in it (updatePot), so editing the lock is never a way round the fee.
//
// Every deposit costs a flat fee too (config/fees.js computeDepositFee, ₦250 by
// the owner's word, 2026-10-15), on top of the amount: the pot gets what was
// typed, the deposit needs the amount plus the fee free, and the fee is swept
// and booked exactly like the early-withdrawal fee (collectSavingsFee).
//
// Interest-earning pots held at an external savings partner were built and
// then removed on 2026-10-02 after the partner declined the API request. The
// backup branch dated 2026-10-02 in both repos holds that code.
const crypto = require("crypto");
const prisma = require("./db");
const anchor = require("./anchor");
const { getSpendableBalance } = require("./savingsReserve");
const { computeBreakFee, breakFeeConfig, computeDepositFee, depositFeeConfig, MONEY_EPS } = require("../config/fees");
const { formatAmountForBusiness } = require("../config/amlLimits");
const { audit } = require("./audit");
const { toKobo, sameMoney, twoDecimals } = require("./money");
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
// The largest target a pot may name: the ceiling every other money field uses
// (routes/sales.js, utils/items.js).
const MAX_TARGET = 1e13;
const DEPOSIT_REF_PREFIX = "kb_sv_";
const WITHDRAWAL_REF_PREFIX = "kb_svw_";
// The furthest a pot may open: the same date this many years after today.
const MAX_LOCK_YEARS = 5;
// Lagos is UTC+1 all year (no daylight saving), so a Lagos day is a fixed
// offset from UTC. Render runs in UTC, which is why every day here is worked
// out from this offset and never from the server's own clock zone.
const LAGOS_OFFSET_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const BARE_DAY = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_WORDS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// A pot with less than half a kobo in it holds nothing.
const POT_HOLDS_MONEY = { gt: 0.004 };

// Creation and deposits are behind the switch; reads, withdrawals, the reserve
// and the reconcile loop run whenever a pot exists, so turning the switch off
// never traps money.
const isEnabled = () => process.env.SAVINGS_ENABLED === "true";

// ── Pure helpers (tested without a DB) ──────────────────────────────────────

// "YYYY-MM-DD" of an instant, in Lagos time. null when it is not a date.
function lagosDay(at) {
  if (at === null || at === undefined || at === "") return null;
  const t = at instanceof Date ? at.getTime() : new Date(at).getTime();
  if (!Number.isFinite(t)) return null;
  return new Date(t + LAGOS_OFFSET_MS).toISOString().slice(0, 10);
}

// 00:00 Lagos time on a "YYYY-MM-DD" day. null for a day the calendar does
// not have: the date parser rolls "2026-02-30" over to 2 March, so the result
// must give the same day back.
function lagosMidnight(day) {
  if (typeof day !== "string" || !BARE_DAY.test(day)) return null;
  const d = new Date(`${day}T00:00:00.000+01:00`);
  return Number.isFinite(d.getTime()) && lagosDay(d) === day ? d : null;
}

// The moment a lock request names: 00:00 Lagos on a bare day "YYYY-MM-DD",
// else the timestamp itself (an ISO string, a Date or epoch milliseconds).
// null when it is not a date.
function askedAt(input) {
  if (input === null || input === undefined || input === "") return null;
  if (typeof input === "string" && BARE_DAY.test(input.trim())) return lagosMidnight(input.trim());
  let t = NaN;
  if (input instanceof Date) t = input.getTime();
  else if (typeof input === "number") t = input;
  else if (typeof input === "string") t = Date.parse(input);
  const d = new Date(t);
  return Number.isFinite(d.getTime()) ? d : null;
}

// When a pot locked with `input` opens: always the start of a day, Lagos time.
//   a bare day "YYYY-MM-DD"    00:00 Lagos on that day
//   a timestamp (or a Date)    the next Lagos midnight at or after it, so a
//                              pot never opens earlier than the merchant asked
// null when the input is not a date.
function lockOpensAt(input) {
  const asked = askedAt(input);
  if (!asked) return null;
  const local = asked.getTime() + LAGOS_OFFSET_MS;
  const dayStart = Math.floor(local / DAY_MS) * DAY_MS;
  const opens = new Date((dayStart === local ? local : dayStart + DAY_MS) - LAGOS_OFFSET_MS);
  return Number.isFinite(opens.getTime()) ? opens : null;
}

// The latest moment a pot may open: 00:00 Lagos on the same date five years
// after today. A 29 February with no twin five years on rolls to 1 March.
function latestOpening(now = new Date()) {
  const [y, m, d] = lagosDay(now).split("-").map(Number);
  return new Date(Date.UTC(y + MAX_LOCK_YEARS, m - 1, d) - LAGOS_OFFSET_MS);
}

// "15 Mar 2027": a Lagos day in words, the same on every server. Takes a bare
// day or an instant (a pot's lockUntil).
function dayWords(at) {
  const day = typeof at === "string" && BARE_DAY.test(at) ? at : lagosDay(at);
  if (!day) return "";
  const [y, m, d] = day.split("-").map(Number);
  return `${d} ${MONTH_WORDS[m - 1]} ${y}`;
}

// May this withdrawal go ahead against the pot's lock? `until` is the moment
// the pot opens (lockOpensAt); from that moment on, a pot of either kind is open.
//   { ok: true } | { ok: true, early: true } |
//   { ok: false, code: "POT_LOCKED" | "EARLY_WITHDRAWAL_CONFIRM", until }
function lockAllows(pot, { now = new Date(), confirmEarly = false } = {}) {
  if (!pot?.lockUntil) return { ok: true };
  const until = new Date(pot.lockUntil);
  if (!(until > now)) return { ok: true };
  if (pot.lockMode === "strict") return { ok: false, code: "POT_LOCKED", until };
  return confirmEarly ? { ok: true, early: true } : { ok: false, code: "EARLY_WITHDRAWAL_CONFIRM", until };
}

// The lock a request asks for: when the pot opens and how it is held.
// `lockUntil` is a bare day (the opening day) or a timestamp (moved up to the
// next Lagos midnight). The day must come after today, Lagos time, and no
// later than the same date five years on. A timestamp already past is
// refused too, though it would round up to a later midnight: nobody means to
// lock money until a moment that has gone.
function validateLock({ lockUntil, lockMode }, { now = new Date() } = {}) {
  if (!lockUntil) return { lockUntil: null, lockMode: null };
  const asked = askedAt(lockUntil);
  const opens = lockOpensAt(lockUntil);
  if (!asked || !opens) throw new SavingsError("That date is not valid. Pick the day the pot opens.", "BAD_LOCK", 400);
  // opens is never earlier than asked, so this also keeps today's midnight out.
  if (!(asked > now)) throw new SavingsError("Pick a day after today for the pot to open.", "BAD_LOCK", 400);
  const latest = latestOpening(now);
  if (opens > latest) {
    throw new SavingsError(`Pick a day within ${MAX_LOCK_YEARS} years. The latest a pot can open is ${dayWords(latest)}.`, "BAD_LOCK", 400);
  }
  if (!["strict", "flexible"].includes(lockMode)) throw new SavingsError("Choose how the pot is locked: Unbreakable or Breakable.", "BAD_LOCK", 400);
  return { lockUntil: opens, lockMode };
}

// What breaking a Breakable pot early costs, as GET /savings tells the app.
// All zeros when no fee is charged (no fee account, or a rate of 0), so the
// app never shows a rate or a minimum for a withdrawal that costs nothing.
function breakFeeView() {
  const { bps, min, enabled } = breakFeeConfig();
  if (!enabled || !(bps > 0)) return { enabled: false, bps: 0, pct: 0, min: 0 };
  return { enabled: true, bps, pct: bps / 100, min };
}

// What each deposit costs, as GET /savings tells the app: { enabled, amount },
// all zeros when no fee is charged.
function depositFeeView() {
  const { amount, enabled } = depositFeeConfig();
  return enabled ? { enabled: true, amount } : { enabled: false, amount: 0 };
}

// At most two decimals, by the codebase's one money rule (utils/money.js
// twoDecimals). A plain `Math.round(n * 100) === n * 100` refused about one
// kobo amount in eight: 2500.07 * 100 is 250007.00000000003 in floating point,
// and it is still whole kobo. Infinity and NaN are not amounts.
const money2dp = (n) => Number.isFinite(Number(n)) && twoDecimals(Number(n));

// What a client sent as an amount, as a number: a finite number, or a string
// of plain digits with an optional decimal part. Anything else (true, [5],
// "0x10", "1e3", an object) is NaN, so it is refused rather than read as some
// other amount.
const PLAIN_DECIMAL = /^\s*\d+(\.\d+)?\s*$/;
function amountOf(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
  if (typeof value === "string" && PLAIN_DECIMAL.test(value)) return Number(value);
  return NaN;
}

// A pot's target: a positive amount of at most two decimals, no larger than
// MAX_TARGET, stored as whole kobo.
function validateTarget(value) {
  const t = amountOf(value);
  if (!(t > 0) || !money2dp(t)) throw new SavingsError("Target must be a positive amount with at most 2 decimals.", "BAD_AMOUNT", 400);
  if (t > MAX_TARGET) throw new SavingsError("That target is too large.", "BAD_AMOUNT", 400);
  return toKobo(t) / 100;
}

function sanitizeKey(key) {
  // An object or an array would all become "objectObject" and replay each
  // other: only a string or a number is a key.
  if (typeof key !== "string" && typeof key !== "number") return "";
  return String(key).replace(/[^a-zA-Z0-9]/g, "").slice(0, 40);
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

// A pot's balance is shown as whole kobo. The stored float can carry a residue
// of its own arithmetic (1000.05 + 1500.02 is 2500.0699999999997, and 2500 off
// that leaves 0.06999999999970896), and the app must be able to send the figure
// it shows straight back as an amount to take out.
function publicPot(pot) {
  if (!pot) return null;
  return {
    id: pot.id,
    businessId: pot.businessId,
    name: pot.name,
    targetAmount: pot.targetAmount,
    status: pot.status,
    balance: toKobo(pot.balance) / 100 || 0,
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

// Which of the two is under review: "business", "owner", or null when both are
// active. `biz` must carry accountStatus and userId. The one rule a deposit, a
// withdrawal and the fee sweep share; only the money routes throw on it.
async function frozenSubject(biz) {
  if (biz?.accountStatus && biz.accountStatus !== "active") return "business";
  const owner = await prisma.user.findUnique({ where: { id: biz.userId }, select: { accountStatus: true } });
  if (owner?.accountStatus && owner.accountStatus !== "active") return "owner";
  return null;
}

async function assertNotFrozen(biz) {
  const who = await frozenSubject(biz);
  if (who === "business") {
    throw new SavingsError("This business is under review. Contact support to resolve.", "FROZEN", 423);
  }
  if (who === "owner") {
    throw new SavingsError("Your account is under review. Contact support to resolve.", "FROZEN", 423);
  }
}

// ── Pots ─────────────────────────────────────────────────────────────────────

async function createPot({ biz, name, targetAmount, lockUntil, lockMode }) {
  if (!isEnabled()) throw new SavingsError("Savings is not available yet.", "SAVINGS_DISABLED", 403);
  const cleanName = String(name || "").replace(/[\u0000-\u001F\u007F]/g, "").trim().slice(0, 40);
  if (cleanName.length < 1) throw new SavingsError("Give the pot a name.", "BAD_NAME", 400);
  let target = null;
  if (targetAmount !== undefined && targetAmount !== null && targetAmount !== "") target = validateTarget(targetAmount);
  if (!lockUntil && lockMode) throw new SavingsError("Pick the day the pot opens.", "BAD_LOCK", 400);
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

// The refusal for a Breakable pot that holds money and has not opened: its day
// stays or moves later, because removing the lock or moving it earlier would
// take the money out early without the fee. Its own code, so the app words it
// apart from an Unbreakable pot (LOCK_CANNOT_SHORTEN).
function breakableLockKept(current) {
  const fee = breakFeeView().enabled ? " and pay the early withdrawal fee" : "";
  return new SavingsError(
    `This pot holds money and opens on ${dayWords(current)}. Until then its day can move later but not earlier. To take money out sooner, take it out early${fee}.`,
    "BREAKABLE_LOCK_KEPT", 409, { lockUntil: current },
  );
}

// Rename, retarget or re-lock a pot. The lock is decided under the business
// lock, from the pot as it is now (every write to a pot takes that lock, a
// deposit included), so two edits at once can never relax a lock between them.
// Until a pot opens, its day can only move later when it is Unbreakable (which
// it then stays), or when it is Breakable and holds money: removing that lock,
// or moving its day earlier, would skip the early-withdrawal fee. An empty
// Breakable pot's lock may change freely, since nothing in it can come out.
// Every empty lockUntil (null, "", 0, false) asks to remove the lock.
//
// Returns { pot, before }: the pot as saved, and its lock before the edit for
// the audit row.
async function updatePot({ pot, name, targetAmount, lockUntil, lockMode }) {
  const data = {};
  if (name !== undefined) {
    const cleanName = String(name || "").replace(/[\u0000-\u001F\u007F]/g, "").trim().slice(0, 40);
    if (!cleanName) throw new SavingsError("Give the pot a name.", "BAD_NAME", 400);
    data.name = cleanName;
  }
  if (targetAmount !== undefined) {
    if (targetAmount === null || targetAmount === "") data.targetAmount = null;
    else data.targetAmount = validateTarget(targetAmount);
  }
  if (lockUntil === undefined && lockMode !== undefined) throw new SavingsError("Pick the day the pot opens.", "BAD_LOCK", 400);

  return prisma.withBusinessLock(pot.businessId, async () => {
    const fresh = await prisma.savingsPot.findUnique({ where: { id: pot.id } });
    if (!fresh || fresh.businessId !== pot.businessId) throw new SavingsError("Pot not found.", "NOT_FOUND", 404);
    if (fresh.status !== "active") throw new SavingsError("This pot is closed.", "POT_CLOSED", 409);
    const before = { lockUntil: fresh.lockUntil, lockMode: fresh.lockMode };
    if (lockUntil !== undefined) {
      const now = new Date();
      const lockedNow = !!fresh.lockUntil && new Date(fresh.lockUntil) > now;
      const unbreakable = lockedNow && fresh.lockMode === "strict";
      // The day stays or moves later: Unbreakable, or Breakable with money in it.
      const kept = unbreakable || (lockedNow && toKobo(fresh.balance) > 0);
      const current = lockedNow ? new Date(fresh.lockUntil) : null;
      if (!lockUntil) {
        if (unbreakable) {
          throw new SavingsError(`This pot is unbreakable. It opens on ${dayWords(current)}, and its lock cannot be removed before then.`, "LOCK_CANNOT_SHORTEN", 409);
        }
        if (kept) throw breakableLockKept(current);
        data.lockUntil = null; data.lockMode = null;
      } else {
        const lock = validateLock({ lockUntil, lockMode: lockMode || fresh.lockMode || "flexible" }, { now });
        if (unbreakable && lock.lockMode !== "strict") {
          throw new SavingsError(`This pot is unbreakable until it opens on ${dayWords(current)}.`, "LOCK_CANNOT_SHORTEN", 409);
        }
        // Breakable to Unbreakable is allowed, but never on an earlier day.
        if (kept && lock.lockUntil < current) {
          // The pot's own opening day sent back changes nothing (a pot made
          // before opening days may open later in that day than midnight).
          if (lagosDay(lock.lockUntil) !== lagosDay(current)) {
            if (unbreakable) {
              throw new SavingsError(`This pot is unbreakable. It opens on ${dayWords(current)}, and that day can move later but never earlier.`, "LOCK_CANNOT_SHORTEN", 409);
            }
            throw breakableLockKept(current);
          }
          lock.lockUntil = current;
        }
        data.lockUntil = lock.lockUntil; data.lockMode = lock.lockMode;
      }
    }
    if (!Object.keys(data).length) return { pot: fresh, before };
    return { pot: await prisma.savingsPot.update({ where: { id: fresh.id }, data }), before };
  });
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

// A positive amount of at most two decimals, returned as whole kobo, so float
// noise from a client's own arithmetic (0.1 + 0.2) is booked as 0.3.
function validateAmount(amount) {
  const n = amountOf(amount);
  if (!(n > 0) || !Number.isFinite(n)) throw new SavingsError("Enter an amount.", "BAD_AMOUNT", 400);
  if (!money2dp(n)) throw new SavingsError("Amount cannot have more than 2 decimal places.", "BAD_AMOUNT", 400);
  return toKobo(n) / 100;
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
    // already promised, with the deposit fee on top (the pot gets the amount
    // typed; the fee leaves the money not set aside). Fail closed if the bank
    // cannot be read.
    const { fee } = computeDepositFee();
    let live;
    try { live = await getSpendableBalance(biz); }
    catch (e) {
      if (e.code === "ANCHOR_NOT_CONFIGURED") throw new SavingsError("Banking is not configured on this server.", "NO_BANKING", 503);
      throw new SavingsError("Could not read your bank balance right now. Try again shortly.", "BALANCE_UNAVAILABLE", 503);
    }
    if (live.spendable + MONEY_EPS < amt + fee) {
      // The most this deposit could be: what is free, less the fee.
      const maxDeposit = Math.max(0, toKobo(live.spendable) - toKobo(fee)) / 100;
      throw new SavingsError(
        fee > 0
          ? `Only ${formatAmountForBusiness(biz, live.spendable)} is available. Each deposit costs ${formatAmountForBusiness(biz, fee)}, so you can save up to ${formatAmountForBusiness(biz, maxDeposit)}.`
          : `Only ${formatAmountForBusiness(biz, live.spendable)} is available to set aside${live.reserved > 0 ? ` (${formatAmountForBusiness(biz, live.reserved)} is already in savings)` : ""}.`,
        "INSUFFICIENT_BALANCE", 400, { availableBalance: live.spendable, reserved: live.reserved, fee, maxDeposit },
      );
    }
    const result = await prisma.$transaction(async (px) => {
      const claim = await px.savingsPot.updateMany({
        where: { id: fresh.id, status: "active" },
        data: { balance: { increment: amt } },
      });
      if (claim.count !== 1) throw new SavingsError("Pot changed while saving. Try again.", "CONFLICT", 409);
      const movement = await px.savingsMovement.create({
        data: { potId: fresh.id, businessId: biz.id, userId: user?.id || biz.userId, type: "deposit", amount: amt, fee, status: "completed", reference, completedAt: new Date() },
      });
      const updatedPot = await px.savingsPot.findUnique({ where: { id: fresh.id } });
      return { movement, pot: updatedPot };
    });
    await audit({ req, action: "SAVINGS_DEPOSIT", resourceType: "savingsPot", resourceId: fresh.id, metadata: { amount: amt, reference, fee } });
    // The fee is swept now, still under this business's lock, from money the
    // gate just saw free. Best effort, as for a withdrawal: a fee that cannot
    // be swept yet waits for the reconcile loop, a failed sweep alerts a
    // human, and neither undoes the deposit.
    if (fee > 0) {
      await collectSavingsFee(result.movement.id).catch((e) => console.error(`[savings] deposit fee ${reference}:`, e.message));
      result.movement = await prisma.savingsMovement.findUnique({ where: { id: result.movement.id } });
    }
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
    // Breaking a Breakable pot early costs a share of the amount
    // (config/fees.js). The refusal that asks for confirmation carries the
    // figure, so the app can say "taking ₦50,000 out early costs ₦1,000"
    // before the merchant agrees.
    const breakFee = lock.early || lock.code === "EARLY_WITHDRAWAL_CONFIRM" ? computeBreakFee(amt) : { fee: 0, bps: 0 };
    if (!lock.ok) {
      const when = dayWords(lock.until);
      // An Unbreakable pot has no price: nothing opens it before its day.
      if (lock.code === "POT_LOCKED") {
        throw new SavingsError(`This pot is unbreakable. It opens on ${when}.`, "POT_LOCKED", 423, { lockUntil: fresh.lockUntil });
      }
      throw new SavingsError(
        breakFee.fee > 0
          ? `This pot opens on ${when}. Withdrawing ${formatAmountForBusiness(biz, amt)} early costs ${formatAmountForBusiness(biz, breakFee.fee)}. Confirm to continue.`
          : `This pot opens on ${when}. Confirm to withdraw early.`,
        "EARLY_WITHDRAWAL_CONFIRM", 409,
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
    // The money is in the Anchor account already, so the fee is swept now,
    // still under this business's lock. Best effort: a fee that cannot be
    // swept yet waits for the reconcile loop, a failed sweep alerts a human,
    // and neither ever blocks the withdrawal the merchant just confirmed.
    if (fee > 0) {
      await collectSavingsFee(result.movement.id).catch((e) => console.error(`[savings] break fee ${reference}:`, e.message));
      result.movement = await prisma.savingsMovement.findUnique({ where: { id: result.movement.id } });
    }
    return result;
  });
}

// What a failed book transfer says about the money, by executeTransfer's rule:
// a definite refusal (validation, auth, not found), or a bank that is not
// configured at all, means Anchor did not act. Anything else (a timeout, a 5xx,
// a 409 on the idempotency key, a page that is not JSON, a dropped connection)
// may have moved it.
const REFUSED_STATUSES = [400, 401, 403, 404, 422];
function bankRefused(e) {
  return e?.code === "ANCHOR_NOT_CONFIGURED" || REFUSED_STATUSES.includes(Number(e?.httpStatus || e?.status || 0));
}

// The two fees a movement can carry. A withdrawal's keeps the names it has
// always had (references, alert keys, audit actions), so nothing booked or
// alerted before changes meaning.
const FEE_KINDS = {
  withdrawal: {
    suffix: "_bfee", words: "early-withdrawal fee", reason: "Savings early withdrawal fee",
    title: "Savings break fee", alertKey: "savings-break-fee", audit: "SAVINGS_BREAK_FEE",
  },
  deposit: {
    suffix: "_dfee", words: "deposit fee", reason: "Savings deposit fee",
    title: "Savings deposit fee", alertKey: "savings-deposit-fee", audit: "SAVINGS_DEPOSIT_FEE",
  },
};
const FEE_TYPES = Object.keys(FEE_KINDS);

// The fee's ledger row: real money off the account (computeLedgerBalance
// counts it) and a Bank Fees and Charges expense in the books
// (utils/books.js). It names no pot: staff with bank access read every bank
// row, and pots are the owner's alone (the reference ties it to the movement).
// A write that fails is tried once more; the reference is unique per business,
// so a second write of the same fee is a no-op (P2002), never a second row.
async function bookSavingsFee(biz, fee, reference, transferId, kind = FEE_KINDS.withdrawal) {
  const data = {
    businessId: biz.id, userId: biz.userId, type: "expense", amount: fee,
    description: `${kind.reason} · Ref: ${reference}`,
    category: "transfer", paymentMethod: "bank", date: new Date(), source: "anchor",
    reference, providerTxnId: transferId || undefined, purpose: "savings_fee",
    currency: biz.baseCurrency || "NGN",
  };
  for (let attempt = 1; ; attempt++) {
    try {
      await prisma.transaction.create({ data });
      return;
    } catch (e) {
      if (e?.code === "P2002") return;
      if (attempt >= 2) throw e;
    }
  }
}

// Sweep a movement's fee (a deposit's, or an early withdrawal's) to KashBook's
// fee account. The CALLER HOLDS withBusinessLock for the movement's business:
// the deposit or withdrawal right after it commits, and the reconcile loop for
// a fee still waiting.
//
// The fee comes only out of money that is not set aside: when what is
// spendable does not cover it, it waits ("deferred") for a later sweep, so a
// fee never eats into another pot. A fee waiting over a day alerts a
// human once a day. An account under review moves no money in any direction,
// so its fee waits too, with no alert: the freeze is already with a human.
//
// The claim comes BEFORE the transfer. A double sweep would charge the
// merchant twice; a missed one costs KashBook a fee. So once claimed, nothing
// retries the transfer by itself, and a failure tells a human what is known
// (Anchor dedups on the reference for 24h):
//   the bank refused it      nothing moved and nothing is booked: collect it
//                            by hand with the reference
//   the outcome is unknown   the fee is booked anyway, the safe side, as
//                            executeTransfer does with its own fee: check the
//                            bank for the reference before collecting anything
//   the row did not write    the fee moved: never collect it again, add the row
//
// Returns "collected" | "deferred" | "skipped" (nothing to sweep) | "failed"
// (claimed, and a human has been alerted).
async function collectSavingsFee(movementId, { now = new Date() } = {}) {
  const mv = await prisma.savingsMovement.findUnique({ where: { id: movementId } });
  if (!mv || !FEE_TYPES.includes(mv.type) || mv.status !== "completed" || !(Number(mv.fee) > 0) || mv.feeCollectedAt) return "skipped";
  const kind = FEE_KINDS[mv.type];
  const feeAccount = process.env.ANCHOR_FEE_ACCOUNT_ID;
  if (!feeAccount) return "skipped";
  const biz = await prisma.business.findUnique({
    where: { id: mv.businessId },
    select: { id: true, userId: true, name: true, anchorAccountId: true, providerAccountId: true, baseCurrency: true, country: true, accountStatus: true },
  });
  if (!biz?.anchorAccountId) return "skipped";
  // Frozen: the fee waits until the review is over. Before the bank read and
  // the claim, so nothing is read, claimed or moved.
  if (await frozenSubject(biz)) return "deferred";
  const fee = Math.round(Number(mv.fee) * 100) / 100;

  // Spendable first: an unreadable bank defers the fee too, never guesses.
  let live = null;
  try { live = await getSpendableBalance(biz); }
  catch (e) { console.warn(`[savings] ${kind.words} ${mv.reference}: bank balance unreadable, the fee waits: ${e.message}`); }
  if (!live || live.spendable + MONEY_EPS < fee) {
    await alertFeeWaiting(mv, biz, fee, now).catch((e) => console.error(`[savings] waiting fee alert ${mv.reference}:`, e.message));
    return "deferred";
  }

  const claim = await prisma.savingsMovement.updateMany({ where: { id: mv.id, feeCollectedAt: null }, data: { feeCollectedAt: new Date() } });
  if (claim.count !== 1) return "skipped";
  const reference = `${mv.reference}${kind.suffix}`;
  const alertKey = `${kind.alertKey}-${mv.id}`;
  const fireAlert = (title, text) => require("./alerts").fireAlert(alertKey, title, text).catch(() => false);

  let book;
  try {
    book = await anchor.createBookTransfer({
      fromAccountId: biz.anchorAccountId,
      toAccountId: feeAccount,
      amount: fee,
      reason: kind.reason,
      reference,
    });
  } catch (e) {
    const error = String(e?.message || "").slice(0, 200);
    if (bankRefused(e)) {
      console.error(`[savings] ${kind.words} ${reference} refused by the bank:`, e.message);
      await audit({ action: `${kind.audit}_FAILED`, resourceType: "savingsMovement", resourceId: mv.id, severity: "alert", metadata: { fee, reference, error } });
      await fireAlert(`${kind.title} not collected`, `The bank refused the ₦${fee} ${kind.words} ${reference} (${biz.name}), so nothing moved. It is marked collected so it is never charged twice: collect it by hand with that reference. The bank said: ${error.slice(0, 120)}`);
      return "failed";
    }
    // The fee may have moved: book it, and let a human check the bank.
    let booked = true;
    try { await bookSavingsFee(biz, fee, reference, null, kind); }
    catch (rowErr) { booked = false; console.error(`[savings] ${kind.words} ${reference}: ledger row not written:`, rowErr.message); }
    try { balanceCache.bustBalance(biz.id); } catch { /* noop */ }
    console.error(`[savings] ${kind.words} ${reference}: outcome unknown:`, e.message);
    await audit({ action: `${kind.audit}_UNCONFIRMED`, resourceType: "savingsMovement", resourceId: mv.id, severity: "alert", metadata: { fee, reference, booked, error } });
    await fireAlert(`${kind.title} unconfirmed`, `The ₦${fee} ${kind.words} ${reference} (${biz.name}) may have moved. Check Anchor for that reference before collecting anything. ${booked
      ? "The books already count the fee, so collect it by hand only if the transfer is not there."
      : "Its ledger row could not be written either: if the transfer is there, add the savings_fee row; if not, collect it by hand and add the row."} The bank said: ${error.slice(0, 120)}`);
    return "failed";
  }

  try {
    await bookSavingsFee(biz, fee, reference, book?.transferId, kind);
  } catch (e) {
    // The fee WAS swept. Only its ledger row is missing.
    const error = String(e?.message || "").slice(0, 200);
    console.error(`[savings] ${kind.words} ${reference} swept but not booked:`, e.message);
    try { balanceCache.bustBalance(biz.id); } catch { /* noop */ }
    await audit({ action: `${kind.audit}_BOOKKEEPING_FAILED`, resourceType: "savingsMovement", resourceId: mv.id, severity: "alert", metadata: { fee, reference, transferId: book?.transferId || null, error } });
    await fireAlert(`${kind.title} not booked`, `The ₦${fee} ${kind.words} ${reference} (${biz.name}) WAS swept (Anchor transfer ${book?.transferId || "with that reference"}), but its ledger row could not be written. Do not collect it again: add the savings_fee row. The error: ${error.slice(0, 120)}`);
    return "failed";
  }
  try { balanceCache.adjustBalance(biz.id, -fee); } catch { /* noop */ }
  await audit({ action: kind.audit, resourceType: "savingsMovement", resourceId: mv.id, metadata: { fee, reference } });
  return "collected";
}

// The reconcile loop's queue turns: fees it looked at and that still wait go
// to the back (their updatedAt is the last time they were tried), so fees that
// cannot be swept for a long while never hold the front against newer ones.
// Only fees still unclaimed are touched.
async function requeueSavingsFees(ids, now = new Date()) {
  const list = [...new Set((ids || []).filter(Boolean).map(String))];
  if (!list.length) return 0;
  const r = await prisma.savingsMovement.updateMany({
    where: { id: { in: list }, type: { in: FEE_TYPES }, feeCollectedAt: null },
    data: { updatedAt: now },
  });
  return r.count;
}

// One alert a day for a fee that has waited more than a day. The alert
// engine's own cooldown is an hour, so the day is checked here.
async function alertFeeWaiting(mv, biz, fee, now = new Date()) {
  const since = new Date(mv.completedAt || mv.createdAt);
  if (!(now - since >= DAY_MS)) return false;
  const kind = FEE_KINDS[mv.type] || FEE_KINDS.withdrawal;
  const key = `${kind.alertKey}-waiting-${mv.id}`;
  const last = await prisma.alertState.findUnique({ where: { key } });
  if (last && now - new Date(last.lastFiredAt) < DAY_MS) return false;
  return require("./alerts").fireAlert(
    key,
    `${kind.title} waiting`,
    `The ₦${fee} ${kind.words} on ${mv.reference} (${biz.name}) has waited since ${dayWords(since)}: the money not set aside in pots does not cover it. It is swept by itself once it does.`,
  );
}

// ── Deletion ─────────────────────────────────────────────────────────────────
// A pot with money in it stops its business, and the owner's account, from
// being deleted: the money is the merchant's and would be stranded (a reserve
// with no account behind it).

// The pot to name in the refusal, from the pots that hold money: an
// Unbreakable pot that has not opened yet (the one opening last), because
// nobody can empty it before its day; else the first pot with money.
// `opensOn` is the Lagos day a still-locked pot opens, null when it is open.
function pickBlockingPot(pots, now = new Date()) {
  if (!pots || !pots.length) return null;
  const lockedNow = (p) => !!p.lockUntil && new Date(p.lockUntil) > now;
  const unbreakable = pots
    .filter((p) => p.lockMode === "strict" && lockedNow(p))
    .sort((a, b) => new Date(b.lockUntil) - new Date(a.lockUntil));
  const pot = unbreakable[0] || pots[0];
  return {
    potId: pot.id,
    businessId: pot.businessId,
    businessName: (pot.business && pot.business.name) || null,
    potName: pot.name,
    unbreakable: !!unbreakable[0],
    opensOn: lockedNow(pot) ? lagosDay(pot.lockUntil) : null,
  };
}

// Is a pot holding money in any of these businesses? The answer of
// pickBlockingPot, or null when deletion may go ahead.
async function savingsBlockingDeletion(businessIds, { now = new Date() } = {}) {
  const ids = [...new Set((Array.isArray(businessIds) ? businessIds : [businessIds]).filter(Boolean).map(String))];
  if (!ids.length) return null;
  const pots = await prisma.savingsPot.findMany({
    where: { businessId: { in: ids }, status: { not: "closed" }, balance: POT_HOLDS_MONEY },
    select: { id: true, businessId: true, name: true, lockUntil: true, lockMode: true, business: { select: { name: true } } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return pickBlockingPot(pots, now);
}

// The 409 body both deletion routes send. scope: "account" (POST
// /auth/delete-account) or "business" (DELETE /businesses/:id).
function savingsRemainingBody(block, scope = "account") {
  const ofAccount = scope !== "business";
  const pot = `${ofAccount ? "Your" : "The"} savings pot "${block.potName}"`;
  const then = ofAccount ? "delete your account" : "delete this business";
  const error = block.unbreakable && block.opensOn
    ? `${pot} is unbreakable and opens on ${dayWords(block.opensOn)}. Nobody, not even KashBook, can take the money out before then. After that, take it out and close the pot, then ${then}.`
    : `${pot} still has money in it. Take it out and close the pot first, then ${then}.`;
  return {
    code: "SAVINGS_REMAINING",
    error,
    potName: block.potName,
    opensOn: block.opensOn || null,
    unbreakable: !!block.unbreakable,
    // Which business the pot is in (the app opens that business's savings).
    businessId: block.businessId || null,
    businessName: block.businessName || null,
  };
}

module.exports = {
  SavingsError,
  MAX_POTS,
  MAX_LOCK_YEARS,
  MAX_TARGET,
  DEPOSIT_REF_PREFIX,
  WITHDRAWAL_REF_PREFIX,
  POT_HOLDS_MONEY,
  isEnabled,
  // pure
  lagosDay,
  lockOpensAt,
  latestOpening,
  dayWords,
  lockAllows,
  validateLock,
  money2dp,
  validateAmount,
  validateTarget,
  breakFeeView,
  depositFeeView,
  bankRefused,
  replayOutcome,
  pickBlockingPot,
  savingsRemainingBody,
  // views
  publicPot,
  publicMovement,
  // money paths
  frozenSubject,
  assertNotFrozen,
  createPot,
  updatePot,
  closePot,
  depositToPot,
  withdrawFromPot,
  collectSavingsFee,
  requeueSavingsFees,
  // deletion
  savingsBlockingDeletion,
};
