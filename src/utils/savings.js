// Savings: the money paths. Pots, deposits, withdrawals, locks.
//
// Two backings behind one screen:
//   ledger     Nothing moves. The pot's balance is an amount the server refuses
//              to let the merchant spend from their Anchor account
//              (utils/savingsReserve.js, enforced in executeTransfer). Deposit
//              and withdrawal are one atomic database write each.
//   piggyvest  A PiggyVest Business wallet per pot. Deposit = a NIP transfer
//              from the Anchor account to the wallet's funding account (through
//              executeTransfer, stamped purpose "savings_deposit"). Withdrawal =
//              PiggyVest pays the wallet balance to the merchant's own NUBAN,
//              and that credit is classified by utils/savingsCredit.js when it
//              lands. Interest accrues at PiggyVest; utils/savingsReconcile.js
//              copies balances, interest and outcomes back into our rows.
//
// Every state change is a claim: updateMany guarded on the status it expects,
// with the count checked. Money leaves only after the row that will explain it
// exists, and no partner call is ever repeated for the same reference.
const crypto = require("crypto");
const prisma = require("./db");
const piggyvest = require("../services/piggyvest");
const anchor = require("./anchor");
const { executeTransfer } = require("./executeTransfer");
const { getSpendableBalance } = require("./savingsReserve");
const { computeTransferFee, MONEY_EPS } = require("../config/fees");
const { resolveBusinessLimits, formatAmountForBusiness } = require("../config/amlLimits");
const { decrypt } = require("./crypto");
const { matchBankCode, namesOverlap } = require("./fcyConversion");
const { pushTo } = require("./pushNotification");
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
// PiggyVest forfeits a month's interest on the FIFTH bank withdrawal, so the
// fourth is the last free one and the fifth needs the merchant to say yes.
const FREE_WITHDRAWALS_PER_MONTH = 4;

// Creation and deposits are behind the switch; reads, withdrawals, the reserve
// and the reconcile loop run whenever a pot exists, so turning the switch off
// never traps money.
const isEnabled = () => process.env.SAVINGS_ENABLED === "true";
const partnerAvailable = () => piggyvest.isConfigured();

// Calendar month in Lagos time (WAT = UTC+1, no DST): PiggyVest counts
// withdrawals per calendar month where the merchant lives, not in UTC.
const monthKey = (d = new Date()) => {
  const lagos = new Date(d.getTime() + 60 * 60 * 1000);
  return `${lagos.getUTCFullYear()}-${String(lagos.getUTCMonth() + 1).padStart(2, "0")}`;
};

// ── Pure helpers (tested without a DB) ──────────────────────────────────────

// Did executeTransfer fail BEFORE any money could have moved? Only then may a
// deposit row be failed outright; anything else parks it as unknown.
function isPreAnchorError(err) {
  if (!err) return false;
  if (err.moneyMoved === false) return true;
  return [
    "INSUFFICIENT_BALANCE", "RECIPIENT_UNVERIFIED", "UNKNOWN_BANK", "NO_BANKING",
    "SAVINGS_DEST_USE_DEPOSIT", "BAD_PURPOSE", "ANCHOR_NOT_CONFIGURED",
  ].includes(err.code);
}

// May this withdrawal go ahead against the pot's lock?
//   { ok: true } | { ok: false, code: "POT_LOCKED" | "EARLY_WITHDRAWAL_CONFIRM" }
function lockAllows(pot, { now = new Date(), confirmEarly = false } = {}) {
  if (!pot?.lockUntil) return { ok: true };
  const until = new Date(pot.lockUntil);
  if (!(until > now)) return { ok: true };
  if (pot.lockMode === "strict") return { ok: false, code: "POT_LOCKED", until };
  return confirmEarly ? { ok: true, early: true } : { ok: false, code: "EARLY_WITHDRAWAL_CONFIRM", until };
}

// What a verify answer does to a withdrawal in `processing` or `unknown`.
//   { next: "completed" | "failed" | "needs_review" | null, misses }
// `lastVerifiedAt` is the time of the last COUNTED miss (applyWithdrawalOutcome
// only advances it then), so two misses ten minutes apart are reachable at the
// loop's five-minute cadence. `accepted` = PiggyVest answered the POST with a
// reference: their record exists somewhere, so "not found" can never mean
// "never sent"; it escalates to a human instead of failing the row.
function decideWithdrawalOutcome({ status, verify, verifyMisses = 0, lastVerifiedAt = null, now = new Date(), accepted = false }) {
  if (!["processing", "unknown"].includes(status)) return { next: null, misses: verifyMisses };
  const v = verify?.status;
  if (v === "success") return { next: "completed", misses: 0 };
  if (v === "failed") return { next: "failed", misses: 0 };
  if (v === "not_found") {
    // The first miss always counts; a later one only ten minutes after the
    // last counted miss, so a webhook nudge right after a poll is not two.
    const last = lastVerifiedAt ? new Date(lastVerifiedAt).getTime() : 0;
    const spaced = verifyMisses === 0 || !last || now.getTime() - last >= 10 * 60 * 1000;
    const misses = spaced ? verifyMisses + 1 : verifyMisses;
    if (misses < 2) return { next: null, misses };
    return { next: accepted ? "needs_review" : "failed", misses };
  }
  return { next: null, misses: 0 }; // pending: keep waiting
}

// Pair pending deposits with wallet inflows. Oldest deposit first, each inflow
// consumed once. A deposit that has been SENT (money left Anchor) may pair on
// amount alone; one still `initiated`/`unknown` needs our reference in the
// inflow narration, because we do not know the money left.
//   → { pairs: [{ depositId, inflowId }], leftoverInflows: [...] }
function pairInflows(deposits, inflows) {
  const used = new Set();
  const pairs = [];
  const sorted = [...deposits].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  // An inflow cannot be the landing of a deposit made after it. Five minutes
  // of tolerance for clocks that disagree; an unparseable time is allowed.
  const notBefore = (i, d) => {
    const it = i.createdAt ? new Date(i.createdAt).getTime() : NaN;
    const dt = d.createdAt ? new Date(d.createdAt).getTime() : NaN;
    return !Number.isFinite(it) || !Number.isFinite(dt) || it >= dt - 5 * 60 * 1000;
  };
  for (const d of sorted) {
    const ref = String(d.reference || "").toLowerCase();
    let hit = inflows.find((i) => !used.has(i.id) && ref && String(i.narration || "").toLowerCase().includes(ref));
    if (!hit && d.status === "sent") {
      hit = inflows.find((i) => !used.has(i.id) && sameMoney(i.amount, d.amount) && notBefore(i, d) && !/interest/i.test(i.narration || "") && !/interest/i.test(i.category || ""));
    }
    if (hit) {
      used.add(hit.id);
      pairs.push({ depositId: d.id, inflowId: hit.id });
    }
  }
  return { pairs, leftoverInflows: inflows.filter((i) => !used.has(i.id)) };
}

// An inflow that matched no deposit of ours is either PiggyVest paying
// interest or someone paying the pot's account number directly.
function classifyUnattributedInflow(inflow) {
  const text = `${inflow?.category || ""} ${inflow?.narration || ""}`.toLowerCase();
  return /interest/.test(text) ? "interest" : "external_deposit";
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
const depositRef = (_businessId, key) => keyedRef(DEPOSIT_REF_PREFIX, key);
const withdrawalRef = (_businessId, key) => keyedRef(WITHDRAWAL_REF_PREFIX, key);

// The answer to a repeated request. A row still moving replays as it is; a
// row that finished badly answers with the ORIGINAL refusal, so the client
// mints a new key for a fresh attempt instead of reading "sent" off a
// failure; a different amount under the same key is a client bug.
const IN_FLIGHT = new Set(["initiated", "sent", "requested", "processing", "unknown"]);
function replayOutcome(existing, amt, pot) {
  if (!sameMoney(existing.amount, amt)) {
    throw new SavingsError("That request key was already used for a different amount.", "IDEMPOTENCY_MISMATCH", 409);
  }
  if (existing.status === "failed") {
    throw new SavingsError(existing.error || "The earlier attempt with this key failed. Try again.", existing.type === "deposit" ? "DEPOSIT_FAILED" : "WITHDRAWAL_REJECTED", 409, { replay: true });
  }
  if (existing.status === "needs_review") {
    throw new SavingsError("The earlier attempt with this key is being reviewed. Contact support before trying again.", "NEEDS_REVIEW", 409, { replay: true });
  }
  return { movement: existing, pot, replay: true, pending: IN_FLIGHT.has(existing.status) };
}

// The safe words for a client. Anything else executeTransfer or the bank said
// stays on the movement row for support and is replaced by one fixed line.
const CLIENT_SAFE_CODES = new Set(["INSUFFICIENT_BALANCE", "RECIPIENT_UNVERIFIED", "UNKNOWN_BANK", "NO_BANKING", "SAVINGS_DEST_USE_DEPOSIT", "BAD_PURPOSE"]);

// ── Views ────────────────────────────────────────────────────────────────────

function publicPot(pot) {
  if (!pot) return null;
  return {
    id: pot.id,
    businessId: pot.businessId,
    name: pot.name,
    targetAmount: pot.targetAmount,
    backing: pot.backing,
    status: pot.status,
    balance: Number(pot.balance) || 0,
    interestRate: pot.interestRate,
    interestAccruedMtd: Number(pot.interestAccruedMtd) || 0,
    interestEarned: Number(pot.interestEarned) || 0,
    withdrawalsThisMonth: pot.withdrawalMonth === monthKey() ? pot.withdrawalCountMonth : 0,
    freeWithdrawalsPerMonth: pot.backing === "piggyvest" ? FREE_WITHDRAWALS_PER_MONTH : null,
    lockUntil: pot.lockUntil,
    lockMode: pot.lockMode,
    locked: !!(pot.lockUntil && new Date(pot.lockUntil) > new Date()),
    fundingAccount: pot.backing === "piggyvest" && pot.status === "active" && pot.pvAccountNumber
      ? { accountNumber: pot.pvAccountNumber, bankName: pot.pvBankName, accountName: pot.pvAccountName }
      : null,
    error: pot.status === "error" ? pot.error : null,
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
    backing: m.backing,
    amount: Number(m.amount) || 0,
    fee: Number(m.fee) || 0,
    landedAmount: m.landedAmount,
    status: m.status,
    reference: m.reference,
    error: ["failed", "needs_review"].includes(m.status) ? m.error : null,
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

// ── PiggyVest customer ───────────────────────────────────────────────────────
// One per business, created on the first PiggyVest pot. Needs the business
// verified (a tier with a non-zero daily limit), the owner's email and phone,
// and the BVN we already hold encrypted. The BVN is decrypted here and passed
// straight to the partner; it is never logged or stored again.
async function ensureProfile(biz, user) {
  const existing = await prisma.savingsProfile.findUnique({ where: { businessId: biz.id } });
  if (existing?.status === "ready" && existing.pvCustomerId) return existing;
  if (existing?.status === "error") {
    throw new SavingsError(
      "PiggyVest could not verify this business's details. Contact support to resolve.",
      "KYC_MISMATCH", 409,
    );
  }
  if (!partnerAvailable()) throw new SavingsError("Interest savings are not available right now.", "SAVINGS_UNAVAILABLE", 503);

  const limits = resolveBusinessLimits(biz);
  if (!(limits.daily > 0)) {
    throw new SavingsError("Complete your business verification before opening an interest pot.", "SAVINGS_PROFILE_INCOMPLETE", 409, { missing: "kyc" });
  }
  if (!user?.email || !user?.phone) {
    throw new SavingsError("Add an email address and phone number to your profile first.", "SAVINGS_PROFILE_INCOMPLETE", 409, { missing: !user?.email ? "email" : "phone" });
  }
  let bvn = null;
  try { bvn = biz.kycBvn ? decrypt(biz.kycBvn) : null; } catch { bvn = null; }
  if (!bvn || !/^\d{11}$/.test(String(bvn))) {
    throw new SavingsError("Your BVN is not on file. Complete business verification first.", "SAVINGS_PROFILE_INCOMPLETE", 409, { missing: "bvn" });
  }

  const profile = existing || await prisma.savingsProfile.create({ data: { businessId: biz.id, status: "pending" } });
  try {
    const cust = await piggyvest.createCustomer({
      bvn,
      name: `${user.firstName || ""} ${user.lastName || ""}`.trim() || biz.name,
      email: user.email,
      phone: user.phone,
      thirdPartyId: user.id,
    });
    if (!cust.customerId) throw Object.assign(new Error("PiggyVest returned no customer id"), { status: 502 });
    return prisma.savingsProfile.update({
      where: { id: profile.id },
      data: { status: "ready", pvCustomerId: String(cust.customerId), pvDefaultWalletId: cust.walletId ? String(cust.walletId) : null, error: null },
    });
  } catch (e) {
    const definite = e.status >= 400 && e.status < 500 && e.status !== 429;
    if (definite) {
      // A 4xx is their answer, not a hiccup: the details did not match. No
      // automatic retry; support resets the profile after looking.
      await prisma.savingsProfile.update({ where: { id: profile.id }, data: { status: "error", error: String(e.message || "").slice(0, 300) } });
      await audit({ action: "SAVINGS_PROFILE_REJECTED", resourceType: "business", resourceId: biz.id, severity: "warn", metadata: { status: e.status, message: String(e.message || "").slice(0, 200) } });
      throw new SavingsError("PiggyVest could not verify this business's details. Contact support to resolve.", "KYC_MISMATCH", 409);
    }
    throw new SavingsError("PiggyVest is not reachable right now. Try again in a few minutes.", "SAVINGS_UNAVAILABLE", 503);
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

async function createPot({ biz, user, name, targetAmount, backing, lockUntil, lockMode }) {
  if (!isEnabled()) throw new SavingsError("Savings is not available yet.", "SAVINGS_DISABLED", 403);
  const cleanName = String(name || "").trim().slice(0, 40);
  if (cleanName.length < 1) throw new SavingsError("Give the pot a name.", "BAD_NAME", 400);
  if (!["ledger", "piggyvest"].includes(backing)) throw new SavingsError("Choose where to keep the money.", "BAD_BACKING", 400);
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
  if (backing === "piggyvest" && !partnerAvailable()) {
    throw new SavingsError("Interest savings are not available right now. Keep the money in your account instead.", "SAVINGS_UNAVAILABLE", 503);
  }
  const open = await prisma.savingsPot.count({ where: { businessId: biz.id, status: { not: "closed" } } });
  if (open >= MAX_POTS) throw new SavingsError(`You can have up to ${MAX_POTS} pots. Close one to add another.`, "POT_LIMIT", 409);

  if (backing === "ledger") {
    return prisma.savingsPot.create({
      data: { businessId: biz.id, userId: biz.userId, name: cleanName, targetAmount: target, backing, status: "active", ...lock },
    });
  }

  // PiggyVest: customer first, then the pot row (provisioning, no wallet yet),
  // THEN the single-attempt wallet create. The row exists before the partner
  // call so a crash in between leaves something the reconcile loop can age out,
  // never a wallet nobody knows about.
  const profile = await ensureProfile(biz, user);
  const pot = await prisma.savingsPot.create({
    data: { businessId: biz.id, userId: biz.userId, name: cleanName, targetAmount: target, backing, status: "provisioning", ...lock },
  });
  try {
    const w = await piggyvest.createSubAccount({ name: `KashBook ${biz.name} ${cleanName} ${pot.id.slice(0, 8)}`.slice(0, 60), customerId: profile.pvCustomerId, enableInterest: true });
    if (!w.walletId) throw Object.assign(new Error("PiggyVest returned no wallet id"), { status: 502 });
    const updated = await prisma.savingsPot.update({ where: { id: pot.id }, data: { pvWalletId: String(w.walletId) } });
    // Sometimes the funding account is already there; try once, quietly.
    return (await activatePot(updated).catch(() => null)) || updated;
  } catch (e) {
    const definite = e.status >= 400 && e.status < 500 && e.status !== 429 && e.status !== 408;
    if (definite) {
      await prisma.savingsPot.update({ where: { id: pot.id }, data: { status: "error", error: String(e.message || "").slice(0, 300) } });
      throw new SavingsError("PiggyVest could not open this pot. Contact support.", "POT_PROVISION_FAILED", 502);
    }
    // Transient or timeout: the wallet MAY exist. Leave the row provisioning;
    // the reconcile loop ages it to error after 10 minutes if no wallet id
    // ever arrives (the create-wallet webhook cannot name it, so it is lost to
    // us either way and support recovers it from the PiggyVest dashboard).
    await prisma.savingsPot.update({ where: { id: pot.id }, data: { error: `create pending: ${String(e.message || "").slice(0, 200)}` } });
    return prisma.savingsPot.findUnique({ where: { id: pot.id } });
  }
}

// Turn a provisioning PiggyVest pot into an active one: read its reserved
// funding account and map the rail's bank name to an ANCHOR bank code, because
// the deposit is an Anchor NIP transfer and Anchor's code namespace is what
// executeTransfer looks up. No code, no activation: fail closed to error.
async function activatePot(pot) {
  if (pot.status !== "provisioning" || !pot.pvWalletId) return null;
  const accounts = await piggyvest.getWalletAccounts(pot.pvWalletId);
  const acct = accounts[0];
  if (!acct) return null; // not reserved yet
  let banks = [];
  try { banks = await anchor.getBanks(); } catch (e) {
    console.warn(`[savings] bank list unavailable while activating pot ${pot.id}: ${e.message}`);
    return null; // try again next tick
  }
  const code = matchBankCode(banks, acct.bankName);
  if (!code) {
    await prisma.savingsPot.updateMany({
      where: { id: pot.id, status: "provisioning" },
      data: { status: "error", error: `Could not map wallet bank "${acct.bankName}" to a transfer bank code` },
    });
    await audit({ action: "SAVINGS_POT_BANK_UNMAPPED", resourceType: "savingsPot", resourceId: pot.id, severity: "alert", metadata: { bankName: acct.bankName } });
    return prisma.savingsPot.findUnique({ where: { id: pot.id } });
  }
  const r = await prisma.savingsPot.updateMany({
    where: { id: pot.id, status: "provisioning" },
    data: { status: "active", pvAccountNumber: acct.accountNumber, pvBankName: acct.bankName, pvBankCode: code, pvAccountName: acct.accountName, error: null },
  });
  if (r.count === 1) {
    await pushTo(pot.userId, "Savings pot ready", `"${pot.name}" is open. You can start putting money in.`).catch(() => {});
  }
  return prisma.savingsPot.findUnique({ where: { id: pot.id } });
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

// Close only an empty pot with nothing in flight. PiggyVest wallets are never
// deleted; a closed PiggyVest pot is re-checked daily for a stray balance.
async function closePot(pot) {
  return prisma.withBusinessLock(pot.businessId, async () => {
    const fresh = await prisma.savingsPot.findUnique({ where: { id: pot.id } });
    if (!fresh || fresh.status === "closed") return fresh;
    const inflight = await prisma.savingsMovement.count({
      where: { potId: pot.id, status: { in: ["initiated", "sent", "requested", "processing", "unknown"] } },
    });
    if (inflight > 0) throw new SavingsError("Wait for the pending movement to finish before closing this pot.", "MOVEMENT_IN_FLIGHT", 409);
    let balance = Number(fresh.balance) || 0;
    if (fresh.backing === "piggyvest" && fresh.pvWalletId && fresh.status === "active") {
      try { balance = (await piggyvest.getWallet(fresh.pvWalletId)).balance; }
      catch { throw new SavingsError("Could not confirm the pot is empty right now. Try again shortly.", "SAVINGS_UNAVAILABLE", 503); }
    }
    if (toKobo(balance) > 0) throw new SavingsError("Take the money out before closing this pot.", "POT_NOT_EMPTY", 409, { balance });
    const r = await prisma.savingsPot.updateMany({
      where: { id: pot.id, status: { not: "closed" } },
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

// `runChecks` runs INSIDE the business lock for PiggyVest deposits: the route
// supplies the AML pipeline (limits, step-up OTP) so its velocity read and the
// spend are atomic, exactly as /transfers/send does it. It returns
// { ok: true, amlCheck } or { ok: false, outcome } to hand back to the client.
async function depositToPot({ biz, user, pot, amount, idempotencyKey, req = null, runChecks = null }) {
  if (!isEnabled()) throw new SavingsError("Savings is not available yet.", "SAVINGS_DISABLED", 403);
  const amt = validateAmount(amount);
  const reference = depositRef(biz.id, idempotencyKey);

  return prisma.withBusinessLock(biz.id, async () => {
    await assertNotFrozen(biz);
    const fresh = await prisma.savingsPot.findUnique({ where: { id: pot.id } });
    if (!fresh || fresh.businessId !== biz.id) throw new SavingsError("Pot not found.", "NOT_FOUND", 404);
    if (fresh.status !== "active") {
      throw new SavingsError(
        fresh.status === "provisioning" ? "This pot is still being set up. Try again in a minute." : "This pot is not open.",
        "POT_NOT_READY", 409,
      );
    }

    // Idempotency: the same key answers for the same movement and is never
    // re-sent (replayOutcome says how a finished one answers).
    const existing = await prisma.savingsMovement.findUnique({ where: { reference } });
    if (existing) {
      if (existing.potId !== fresh.id) throw new SavingsError("That request key was already used for another pot.", "IDEMPOTENCY_REUSED", 409);
      return replayOutcome(existing, amt, fresh);
    }

    if (fresh.backing === "ledger") {
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
          where: { id: fresh.id, status: "active", backing: "ledger" },
          data: { balance: { increment: amt } },
        });
        if (claim.count !== 1) throw new SavingsError("Pot changed while saving. Try again.", "CONFLICT", 409);
        const movement = await px.savingsMovement.create({
          data: { potId: fresh.id, businessId: biz.id, userId: user?.id || biz.userId, type: "deposit", backing: "ledger", amount: amt, status: "completed", reference, completedAt: new Date() },
        });
        const updatedPot = await px.savingsPot.findUnique({ where: { id: fresh.id } });
        return { movement, pot: updatedPot };
      });
      await audit({ req, action: "SAVINGS_DEPOSIT", resourceType: "savingsPot", resourceId: fresh.id, metadata: { amount: amt, backing: "ledger", reference } });
      return result;
    }

    // PiggyVest: a real NIP transfer from the Anchor account to the wallet.
    if (!fresh.pvAccountNumber || !fresh.pvBankCode) throw new SavingsError("This pot has no funding account yet.", "POT_NOT_READY", 409);
    let amlCheck = {};
    if (runChecks) {
      const c = await runChecks();
      if (!c.ok) return { refused: c.outcome };
      amlCheck = c.amlCheck || {};
    }
    const quote = computeTransferFee(amt, "nip");
    const movement = await prisma.savingsMovement.create({
      data: {
        potId: fresh.id, businessId: biz.id, userId: user?.id || biz.userId, type: "deposit", backing: "piggyvest",
        amount: amt, fee: quote.totalCost || 0, status: "initiated", reference,
        payoutAccountNumber: fresh.pvAccountNumber, payoutBankCode: fresh.pvBankCode,
        narration: `Savings ${fresh.name} ${reference}`.slice(0, 100),
      },
    });
    let sent;
    try {
      sent = await executeTransfer({
        business: biz,
        userId: biz.userId,
        amount: amt,
        accountNumber: fresh.pvAccountNumber,
        bankCode: fresh.pvBankCode,
        accountName: fresh.pvAccountName || undefined,
        bankName: fresh.pvBankName || undefined,
        narration: `Savings ${fresh.name} ${reference}`.slice(0, 100),
        reference,
        amlCheck,
        req,
        notify: false,
        purpose: "savings_deposit",
      });
    } catch (e) {
      if (isPreAnchorError(e)) {
        // The bank was never asked: the row is failed, with the raw reason kept
        // for support and only the safe codes' words shown to the merchant.
        await prisma.savingsMovement.updateMany({
          where: { id: movement.id, status: "initiated" },
          data: { status: "failed", error: String(e.message || e.code || "failed").slice(0, 300) },
        });
        if (e.code === "ANCHOR_NOT_CONFIGURED") throw new SavingsError("Banking is not configured on this server.", "NO_BANKING", 503);
        if (CLIENT_SAFE_CODES.has(e.code)) {
          throw new SavingsError(e.message, e.code, e.code === "INSUFFICIENT_BALANCE" ? 400 : 502, { availableBalance: e.availableBalance, reserved: e.reserved });
        }
        console.error(`[savings] deposit ${reference} refused before the bank:`, e.code || e.message);
        throw new SavingsError("Could not send the deposit. Nothing left your account.", "DEPOSIT_FAILED", 502);
      }
      // Money may have moved. Park it; the reconcile loop resolves it from
      // Anchor's own record and PiggyVest's inflows. Never re-send. The cached
      // balance is dropped rather than adjusted: how much left is not known.
      await prisma.savingsMovement.updateMany({
        where: { id: movement.id, status: "initiated" },
        data: { status: "unknown", error: String(e.message || "").slice(0, 300) },
      });
      try { balanceCache.bustBalance(biz.id); } catch { /* noop */ }
      console.error(`[savings] deposit ${reference} outcome unknown:`, e.message);
      await audit({ req, action: "SAVINGS_DEPOSIT_UNKNOWN", resourceType: "savingsMovement", resourceId: movement.id, severity: "alert", metadata: { reference, amount: amt, error: String(e.message || "").slice(0, 200) } });
      const m = await prisma.savingsMovement.findUnique({ where: { id: movement.id } });
      return { movement: m, pot: fresh, pending: true };
    }
    // A claim, not a plain update: the NIP-failed webhook or the reconcile loop
    // may already have moved this row on while the bank call was in flight,
    // and a bare update would drag a `failed` or `completed` row back to sent.
    const feeBooked = Number(sent.fee ?? quote.total) + (quote.statutoryStamp || 0);
    const claimed = await prisma.savingsMovement.updateMany({
      where: { id: movement.id, status: { in: ["initiated", "unknown"] } },
      data: {
        status: "sent",
        transactionId: sent.transactionId || undefined,
        providerTransferId: sent.providerTransferId || undefined,
        fee: feeBooked,
        error: null,
      },
    });
    if (claimed.count !== 1) {
      // Already settled by another path; make sure the bank ids are on the row.
      await prisma.savingsMovement.updateMany({
        where: { id: movement.id, transactionId: null },
        data: { transactionId: sent.transactionId || undefined, providerTransferId: sent.providerTransferId || undefined },
      }).catch(() => {});
    }
    // The dashboard's cached bank figure is gross; take the debit off it now so
    // the next read does not show money that has left (the send route does
    // the same for ordinary transfers).
    try { balanceCache.adjustBalance(biz.id, -(amt + feeBooked)); } catch { /* noop */ }
    const m = await prisma.savingsMovement.findUnique({ where: { id: movement.id } });
    await audit({ req, action: "SAVINGS_DEPOSIT", resourceType: "savingsPot", resourceId: fresh.id, metadata: { amount: amt, backing: "piggyvest", reference, transactionId: sent.transactionId, providerTransferId: sent.providerTransferId } });
    if (claimed.count === 1) {
      await pushTo(biz.userId, "Savings deposit sent", `${formatAmountForBusiness(biz, amt)} is on its way to "${fresh.name}".`).catch(() => {});
    }
    return { movement: m, pot: fresh, pending: m?.status === "sent" };
  });
}

// A savings deposit the bank reports failed or reversed after it was sent.
// Shared by the NIP webhook and the reconcile loop's Anchor re-check, so both
// settle the row the same way and only the one that wins the claim alerts.
async function failDepositAtBank(mv, { source, reason } = {}) {
  const r = await prisma.savingsMovement.updateMany({
    where: { id: mv.id, status: { in: ["sent", "unknown", "initiated"] } },
    data: { status: "failed", error: `Bank transfer ${source || "failed"}: ${reason || "no reason given"}`.slice(0, 300) },
  });
  if (r.count !== 1) return false;
  await audit({ action: "SAVINGS_DEPOSIT_REVERSED", resourceType: "savingsMovement", resourceId: mv.id, severity: "warn", metadata: { source, reference: mv.reference, amount: mv.amount } });
  require("./alerts").fireAlert(`savings-deposit-reversed-${mv.id}`, "Savings deposit failed at the bank", `Deposit ${mv.reference} (₦${mv.amount}) was ${source || "failed"}. The Anchor debit row stays; the reversal credit is booked when Anchor sends it.`).catch(() => {});
  const pot = await prisma.savingsPot.findUnique({ where: { id: mv.potId }, select: { name: true, userId: true } });
  await pushTo(pot?.userId, "Savings deposit failed", `The bank could not send your deposit to "${pot?.name || "your pot"}". Nothing was taken from your savings.`).catch(() => {});
  try { balanceCache.bustBalance(mv.businessId); } catch { /* noop */ }
  return true;
}

// ── Withdrawals ──────────────────────────────────────────────────────────────

// Where PiggyVest should pay: the merchant's own NUBAN. Their rail needs THEIR
// bank code for it, resolved from the bank name Anchor gave us and confirmed
// by a name enquiry so a wrong mapping is caught before any money moves.
async function resolvePayoutTarget(biz) {
  const accountNumber = String(biz.virtualAccountNumber || "").trim();
  if (!/^\d{10}$/.test(accountNumber)) throw new SavingsError("Your KashBook bank account number is missing.", "NO_BANKING", 400);
  let banks;
  try { banks = await piggyvest.getBanks(); } catch { throw new SavingsError("PiggyVest is not reachable right now.", "SAVINGS_UNAVAILABLE", 503); }
  const bankCode = matchBankCode(banks, biz.virtualAccountBank);
  if (!bankCode) {
    await audit({ action: "SAVINGS_PAYOUT_BANK_UNMAPPED", resourceType: "business", resourceId: biz.id, severity: "alert", metadata: { bankName: biz.virtualAccountBank } });
    throw new SavingsError("We could not confirm your bank for the payout. Contact support.", "PAYOUT_TARGET_UNVERIFIED", 409);
  }
  let enquiry;
  try { enquiry = await piggyvest.nameEnquiry({ bankCode, accountNumber }); }
  catch { throw new SavingsError("Could not verify your account with PiggyVest right now.", "SAVINGS_UNAVAILABLE", 503); }
  if (!enquiry.accountName || !namesOverlap(enquiry.accountName, biz.virtualAccountName || biz.name)) {
    await audit({ action: "SAVINGS_PAYOUT_NAME_MISMATCH", resourceType: "business", resourceId: biz.id, severity: "alert", metadata: { bankCode, enquiryName: enquiry.accountName, expected: biz.virtualAccountName } });
    throw new SavingsError("The payout account name did not match your KashBook account. Contact support.", "PAYOUT_TARGET_UNVERIFIED", 409);
  }
  return { accountNumber, bankCode, accountName: enquiry.accountName };
}

async function withdrawFromPot({ biz, user, pot, amount, idempotencyKey, confirmEarly = false, acceptInterestForfeit = false, req = null }) {
  const amt = validateAmount(amount);
  const reference = withdrawalRef(biz.id, idempotencyKey);

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
    if (!lock.ok) {
      const when = lock.until.toLocaleDateString("en-NG", { day: "numeric", month: "short", year: "numeric" });
      throw new SavingsError(
        lock.code === "POT_LOCKED" ? `This pot is locked until ${when}.` : `This pot is meant to stay untouched until ${when}. Confirm to take money out early.`,
        lock.code, lock.code === "POT_LOCKED" ? 423 : 409, { lockUntil: fresh.lockUntil },
      );
    }

    if (fresh.backing === "ledger") {
      const result = await prisma.$transaction(async (px) => {
        const claim = await px.savingsPot.updateMany({
          where: { id: fresh.id, status: "active", backing: "ledger", balance: { gte: amt - MONEY_EPS } },
          data: { balance: { decrement: amt } },
        });
        if (claim.count !== 1) throw new SavingsError(`This pot has ${formatAmountForBusiness(biz, fresh.balance)}.`, "INSUFFICIENT_POT_BALANCE", 400, { potBalance: fresh.balance });
        const movement = await px.savingsMovement.create({
          data: { potId: fresh.id, businessId: biz.id, userId: user?.id || biz.userId, type: "withdrawal", backing: "ledger", amount: amt, status: "completed", reference, completedAt: new Date() },
        });
        const updatedPot = await px.savingsPot.findUnique({ where: { id: fresh.id } });
        // A float drifting a hair below zero is a rounding artefact, not money.
        if (updatedPot.balance < 0 && updatedPot.balance > -MONEY_EPS) {
          await px.savingsPot.update({ where: { id: fresh.id }, data: { balance: 0 } });
          updatedPot.balance = 0;
        }
        return { movement, pot: updatedPot };
      });
      await audit({ req, action: "SAVINGS_WITHDRAWAL", resourceType: "savingsPot", resourceId: fresh.id, metadata: { amount: amt, backing: "ledger", reference, early: !!lock.early } });
      return result;
    }

    // PiggyVest.
    if (!fresh.pvWalletId) throw new SavingsError("This pot has no wallet yet.", "POT_NOT_READY", 409);
    const inflight = await prisma.savingsMovement.count({
      where: { potId: fresh.id, type: "withdrawal", status: { in: ["requested", "processing", "unknown"] } },
    });
    if (inflight > 0) throw new SavingsError("A withdrawal from this pot is still being processed. Wait for it to finish.", "WITHDRAWAL_IN_FLIGHT", 409);

    let wallet;
    try { wallet = await piggyvest.getWallet(fresh.pvWalletId); }
    catch { throw new SavingsError("PiggyVest is not reachable right now. Try again in a few minutes.", "SAVINGS_UNAVAILABLE", 503); }
    if (wallet.balance + MONEY_EPS < amt) {
      throw new SavingsError(`This pot has ${formatAmountForBusiness(biz, wallet.balance)}.`, "INSUFFICIENT_POT_BALANCE", 400, { potBalance: wallet.balance });
    }
    const countThisMonth = Math.max(
      Number(wallet.withdrawalCount) || 0,
      fresh.withdrawalMonth === monthKey() ? fresh.withdrawalCountMonth : 0,
    );
    if (countThisMonth >= FREE_WITHDRAWALS_PER_MONTH && !acceptInterestForfeit) {
      throw new SavingsError(
        `This would be withdrawal ${countThisMonth + 1} this month. PiggyVest pays no interest on this pot for the month after the fourth. Confirm to continue.`,
        "INTEREST_FORFEIT_CONFIRM", 409, { withdrawalsThisMonth: countThisMonth },
      );
    }
    const target = await resolvePayoutTarget(biz);

    // Row first, claim second, partner call third. The claim is what makes a
    // second request on the same row impossible even if the lock were lost.
    const movement = await prisma.savingsMovement.create({
      data: {
        potId: fresh.id, businessId: biz.id, userId: user?.id || biz.userId, type: "withdrawal", backing: "piggyvest",
        amount: amt, status: "requested", reference,
        payoutAccountNumber: target.accountNumber, payoutBankCode: target.bankCode,
        narration: `KashBook savings ${reference}`,
      },
    });
    const claim = await prisma.savingsMovement.updateMany({ where: { id: movement.id, status: "requested" }, data: { status: "processing" } });
    if (claim.count !== 1) throw new SavingsError("Withdrawal changed while starting. Try again.", "CONFLICT", 409);

    // Optimistic figures; the reconcile loop re-reads the wallet every tick.
    await prisma.savingsPot.update({
      where: { id: fresh.id },
      data: {
        balance: Math.max(0, wallet.balance - amt),
        withdrawalMonth: monthKey(),
        withdrawalCountMonth: fresh.withdrawalMonth === monthKey() ? fresh.withdrawalCountMonth + 1 : 1,
        interestRate: wallet.interestRate ?? fresh.interestRate,
      },
    });

    try {
      const sent = await piggyvest.transferToBank({
        walletId: fresh.pvWalletId,
        amount: amt,
        accountNumber: target.accountNumber,
        bankCode: target.bankCode,
        reference,
        narration: `KashBook savings ${reference}`,
      });
      await prisma.savingsMovement.updateMany({ where: { id: movement.id, status: "processing" }, data: { pvReference: sent.pvReference || undefined } });
    } catch (e) {
      const definite = [400, 401, 403, 404, 422].includes(Number(e.status));
      if (definite) {
        await prisma.savingsMovement.updateMany({
          where: { id: movement.id, status: "processing" },
          data: { status: "failed", error: String(e.message || "").slice(0, 300) },
        });
        await prisma.savingsPot.update({ where: { id: fresh.id }, data: { balance: wallet.balance, withdrawalCountMonth: fresh.withdrawalMonth === monthKey() ? fresh.withdrawalCountMonth : 0 } }).catch(() => {});
        throw new SavingsError(`PiggyVest declined the withdrawal: ${String(e.message || "").slice(0, 120)}`, "WITHDRAWAL_REJECTED", 502);
      }
      // Timeout or 5xx: they may have accepted it. Unknown until verify says.
      await prisma.savingsMovement.updateMany({
        where: { id: movement.id, status: "processing" },
        data: { status: "unknown", error: String(e.message || "").slice(0, 300) },
      });
      console.error(`[savings] withdrawal ${reference} outcome unknown:`, e.message);
    }
    await audit({ req, action: "SAVINGS_WITHDRAWAL", resourceType: "savingsPot", resourceId: fresh.id, metadata: { amount: amt, backing: "piggyvest", reference, early: !!lock.early, forfeit: countThisMonth >= FREE_WITHDRAWALS_PER_MONTH } });
    const m = await prisma.savingsMovement.findUnique({ where: { id: movement.id } });
    const p = await prisma.savingsPot.findUnique({ where: { id: fresh.id } });
    return { movement: m, pot: p, pending: true };
  });
}

// Apply a verify answer to a withdrawal. Claims are guarded on the statuses
// that may still change, so a webhook and a poll landing together settle it
// once. Returns the new status or null.
async function applyWithdrawalOutcome(movement, verify, { now = new Date() } = {}) {
  const decision = decideWithdrawalOutcome({
    status: movement.status, verify, verifyMisses: movement.verifyMisses, lastVerifiedAt: movement.lastVerifiedAt, now,
    accepted: !!movement.pvReference,
  });
  if (!decision.next) {
    if (verify?.status === "not_found") {
      // lastVerifiedAt marks the last COUNTED miss; an uncounted one (a nudge
      // inside the ten-minute window) leaves the row untouched, or the window
      // would never elapse at the loop's own cadence.
      if (decision.misses !== movement.verifyMisses) {
        await prisma.savingsMovement.updateMany({
          where: { id: movement.id, status: { in: ["processing", "unknown"] } },
          data: { verifyMisses: decision.misses, lastVerifiedAt: now },
        });
      }
    } else if (["processing", "unknown"].includes(movement.status)) {
      // pending: the partner knows the request, so the miss streak is over.
      await prisma.savingsMovement.updateMany({
        where: { id: movement.id, status: { in: ["processing", "unknown"] } },
        data: { verifyMisses: 0, lastVerifiedAt: now },
      });
    }
    return null;
  }
  const errorText =
    decision.next === "needs_review" ? "PiggyVest accepted this withdrawal but has no record to verify against"
    : decision.next === "failed" ? (verify?.status === "not_found" ? "PiggyVest has no record of this withdrawal" : "PiggyVest reported the transfer failed")
    : null;
  const r = await prisma.savingsMovement.updateMany({
    where: { id: movement.id, status: { in: ["processing", "unknown"] } },
    data: {
      status: decision.next,
      completedAt: decision.next === "completed" ? now : undefined,
      error: errorText,
      pvReference: verify?.txnId ? String(verify.txnId) : undefined,
      lastVerifiedAt: now,
      verifyMisses: 0,
    },
  });
  if (r.count !== 1) return null;
  const biz = await prisma.business.findUnique({ where: { id: movement.businessId }, select: { id: true, userId: true, country: true, name: true } });
  const pot = await prisma.savingsPot.findUnique({ where: { id: movement.potId } });
  if (decision.next === "completed") {
    await pushTo(biz?.userId, "Savings withdrawal complete", `${formatAmountForBusiness(biz, movement.amount)} from "${pot?.name || "your pot"}" is on its way to your account.`).catch(() => {});
  } else if (decision.next === "failed") {
    await pushTo(biz?.userId, "Savings withdrawal failed", `${formatAmountForBusiness(biz, movement.amount)} from "${pot?.name || "your pot"}" could not be sent. The money is still in the pot.`).catch(() => {});
  } else {
    require("./alerts").fireAlert(`savings-withdrawal-review-${movement.id}`, "Savings withdrawal needs review", `Withdrawal ${movement.reference} (₦${movement.amount}) was accepted by PiggyVest (${movement.pvReference}) but verify finds no record. Check their dashboard before anything is retried.`).catch(() => {});
  }
  await audit({
    action: decision.next === "completed" ? "SAVINGS_WITHDRAWAL_COMPLETED" : decision.next === "failed" ? "SAVINGS_WITHDRAWAL_FAILED" : "SAVINGS_WITHDRAWAL_REVIEW",
    resourceType: "savingsMovement", resourceId: movement.id, severity: decision.next === "completed" ? "info" : "warn",
    metadata: { reference: movement.reference, amount: movement.amount, verify: verify?.status },
  });
  return decision.next;
}

module.exports = {
  SavingsError,
  MAX_POTS,
  FREE_WITHDRAWALS_PER_MONTH,
  DEPOSIT_REF_PREFIX,
  WITHDRAWAL_REF_PREFIX,
  isEnabled,
  partnerAvailable,
  monthKey,
  // pure
  isPreAnchorError,
  lockAllows,
  decideWithdrawalOutcome,
  pairInflows,
  classifyUnattributedInflow,
  // views
  publicPot,
  publicMovement,
  // money paths
  assertNotFrozen,
  ensureProfile,
  createPot,
  activatePot,
  updatePot,
  closePot,
  depositToPot,
  withdrawFromPot,
  applyWithdrawalOutcome,
  failDepositAtBank,
  resolvePayoutTarget,
  replayOutcome,
  IN_FLIGHT,
};
