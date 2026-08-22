// Staff Payments — the scheduler.
//
// This runner MINTS approval rows. It never moves money: `executeTransfer`
// appears exactly once in this feature, inside the PIN-gated approve route.
// That is the whole shape of the design — the owner approves every payment, so
// the cron's only job is to put the right rows in front of them on the right
// day.
//
// Three consequences worth knowing, all of them improvements on the
// recurring-expense runner this is modelled on:
//   • No provider calls in the loop, so it cannot be rate-limited and needs no
//     inter-item sleep. The payee name was verified at setup.
//   • The unique key is the PAY PERIOD, not the tick. Ten cron fires, an
//     instance restart mid-loop, or a pause/resume replay all produce at most
//     one payment for September.
//   • `nextRunDate` advances AFTER the row is created, so a crash between the
//     two re-attempts and the unique key absorbs it. (The recurring runner
//     advances its cursor unconditionally, even on error — the unsafe
//     direction: that is how a period gets skipped forever.)
const prisma = require("./db");
const { audit } = require("./audit");
const { pushTo } = require("./pushNotification");
const { getProvider } = require("../providers");
const { computeTransferFee } = require("../config/fees");
const { resolveBusinessLimits, formatAmountForBusiness } = require("../config/amlLimits");
const { MONEY_OUT_SOURCES } = require("./amlChecks");
const { computeLedgerBalance } = require("./ledgerBalance");
const {
  computeNextPayDate,
  periodKeyFor,
  referenceFor,
  consentMatches,
  SALARY_APPROVAL_TTL_MS,
} = require("./salarySchedule");

// How much this business has already sent in the rolling 24h. The SAME query
// shape the AML pipeline uses, deliberately: a pre-flight that measured "today"
// differently from the authoritative check would produce deferrals the owner
// cannot understand.
async function spentLast24h(businessId) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const agg = await prisma.transaction.aggregate({
    where: {
      businessId,
      type: "expense",
      category: "transfer",
      source: { in: MONEY_OUT_SOURCES },
      date: { gte: since },
    },
    _sum: { amount: true, fee: true },
  });
  return Number(agg._sum.amount || 0) + Number(agg._sum.fee || 0);
}

async function availableBalance(biz) {
  try {
    const provider = getProvider(biz);
    if (provider.pooledWallet) {
      return await computeLedgerBalance(biz.id, biz.baseCurrency || "NGN");
    }
    const anchor = require("./anchor");
    const r = await anchor.getAccountBalance(biz.providerAccountId || biz.anchorAccountId);
    return Number(r?.balance ?? r ?? 0);
  } catch (e) {
    console.warn("[salary] balance lookup failed:", e.message);
    return null; // unknown — warn about limits only
  }
}

// Mint the rows due for one business, then tell the owner once.
//
// The aggregate pre-flight is why this is grouped by business rather than
// iterated flat: 15 staff at ₦180,000 is ₦2.7m against a ₦2m daily cap, and the
// owner needs to know that BEFORE they start approving, not as three silent
// failures after twelve payments have gone.
//
// It deliberately mints all the rows anyway and warns once. Refusing to mint
// would hide the payroll; auto-splitting would decide for the owner who gets
// paid last. Each approval is still individually gated by the authoritative AML
// check at execution — the pre-flight is a consent control, not a safety one.
async function processBusiness(biz, schedules, now) {
  const minted = [];

  for (const s of schedules) {
    // Consent must still describe the row. A schedule whose amount no longer
    // matches what the PIN authorised pays nobody — this is the check that
    // makes a future code path writing `amount` without a PIN harmless.
    if (!consentMatches(s)) {
      await prisma.salarySchedule.update({
        where: { id: s.id },
        data: { status: "suspended", pausedReason: "amount_or_payee_unauthorized" },
      });
      await pushTo(
        s.ownerId,
        "Staff payment paused",
        `${s.staffNameSnapshot}'s payment needs your PIN again before it can run.`,
      ).catch(() => {});
      continue;
    }
    if (!s.nameVerified) {
      await prisma.salarySchedule.update({
        where: { id: s.id },
        data: { status: "suspended", pausedReason: "payee_unverified" },
      });
      continue;
    }

    const periodKey = periodKeyFor(s.nextRunDate, s.frequency);
    const reference = referenceFor(s.id, periodKey);

    let created = null;
    try {
      created = await prisma.salaryPayment.create({
        data: {
          scheduleId: s.id,
          businessId: s.businessId,
          ownerId: s.ownerId,
          staffUserId: s.staffUserId,
          staffNameSnapshot: s.staffNameSnapshot,
          amount: s.amount,
          currency: s.currency,
          payoutKind: s.payoutKind,
          accountNumber: s.accountNumber,
          bankCode: s.bankCode,
          bankName: s.bankName,
          accountName: s.accountName,
          nameVerified: s.nameVerified,
          periodKey,
          scheduledFor: s.nextRunDate,
          reference,
          expiresAt: new Date(now.getTime() + SALARY_APPROVAL_TTL_MS),
        },
      });
    } catch (e) {
      // P2002 = this period already has a payment. That is SUCCESS, not an
      // error: it is the constraint doing exactly its job, and swallowing it
      // here is what makes the whole runner re-entrant.
      if (e.code !== "P2002") throw e;
    }

    // Advance AFTER the create, never before.
    await prisma.salarySchedule.update({
      where: { id: s.id },
      data: {
        nextRunDate: computeNextPayDate({
          frequency: s.frequency,
          anchorDay: s.anchorDay,
          businessDayRule: s.businessDayRule,
          from: s.nextRunDate,
        }),
        lastRunAt: now,
        lastRunStatus: created ? "queued" : "already_queued",
      },
    });

    if (created) minted.push(created);
  }

  if (minted.length === 0) return 0;

  // ── Aggregate pre-flight ──
  const limits = resolveBusinessLimits(biz);
  const total = minted.reduce((sum, p) => sum + Number(p.amount), 0);
  // Worst-case fees: over-estimating refuses slightly early, under-estimating
  // overshoots the cap.
  const fees = minted.reduce((sum, p) => {
    try { return sum + Number(computeTransferFee(Number(p.amount), "nip")?.totalCost || 0); }
    catch { return sum; }
  }, 0);
  const batchCost = total + fees;

  const [alreadySpent, balance] = await Promise.all([
    spentLast24h(biz.id).catch(() => 0),
    availableBalance(biz),
  ]);

  const overLimit = limits?.daily && alreadySpent + batchCost > limits.daily;
  const shortBalance = balance != null && balance < batchCost;

  const money = (n) => formatAmountForBusiness(biz, n);
  let body = minted.length === 1
    ? `${money(total)} for ${minted[0].staffNameSnapshot} needs your approval.`
    : `${minted.length} staff payments (${money(total)}) need your approval.`;

  if (overLimit) {
    body += ` That's above your ${money(limits.daily)} daily limit — approve what you can today and the rest tomorrow.`;
    await audit({
      action: "SALARY_OVER_DAILY_LIMIT", resourceType: "business", resourceId: biz.id,
      severity: "warn",
      metadata: { count: minted.length, total, fees, alreadySpent, dailyLimit: limits.daily },
    }).catch(() => {});
  } else if (shortBalance) {
    body += ` Your balance is ${money(balance)} — top up before approving.`;
  }

  // ONE push per business, never one per staff member. Fifteen notifications at
  // 7am is how an owner turns notifications off.
  await pushTo(biz.userId, "Staff payments due", body).catch(() => {});
  return minted.length;
}

async function processSalaryPayments({ now = new Date() } = {}) {
  const due = await prisma.salarySchedule.findMany({
    where: { status: "active", nextRunDate: { lte: now } },
    orderBy: { createdAt: "asc" },
  });
  if (due.length === 0) return 0;

  // Group by business: the pre-flight is a property of the day and the account,
  // not of any one schedule.
  const byBusiness = new Map();
  for (const s of due) {
    if (!byBusiness.has(s.businessId)) byBusiness.set(s.businessId, []);
    byBusiness.get(s.businessId).push(s);
  }

  let total = 0;
  for (const [businessId, schedules] of byBusiness) {
    try {
      const biz = await prisma.business.findUnique({ where: { id: businessId } });
      if (!biz) continue;
      total += await processBusiness(biz, schedules, now);
    } catch (err) {
      console.error(`[salary] business ${businessId} failed:`, err.message);
      await audit({
        action: "SALARY_RUN_FAILED", resourceType: "business", resourceId: businessId,
        severity: "alert", metadata: { error: err.message },
      }).catch(() => {});
    }
  }
  return total;
}

// ── Reaper ──────────────────────────────────────────────────────────────────
// Expiry is already enforced on read and inside the approve claim, so this is
// bookkeeping rather than enforcement: if it stops running, nothing becomes
// approvable that shouldn't be.
async function expireStaleSalaryPayments(now = new Date()) {
  const stale = await prisma.salaryPayment.findMany({
    where: { status: "pending", expiresAt: { lte: now } },
    select: { id: true, ownerId: true, staffNameSnapshot: true },
    take: 200,
  });
  if (stale.length === 0) return 0;
  // `owed` deliberately stays TRUE: an expired approval does not cancel the
  // obligation, it just means nobody acted in time. The period stays visible.
  const r = await prisma.salaryPayment.updateMany({
    where: { id: { in: stale.map((s) => s.id) }, status: "pending" },
    data: { status: "expired", reason: "Nobody approved it in time" },
  });
  for (const s of stale) {
    await pushTo(
      s.ownerId,
      "Staff payment expired",
      `${s.staffNameSnapshot}'s payment wasn't approved in time and wasn't sent.`,
    ).catch(() => {});
  }
  return r.count;
}

// A row stuck mid-approval is AMBIGUOUS: an instance killed just after the
// provider accepted the payout looks identical from here to one killed just
// before. It is parked as `failed` for a human to reconcile, and NEVER returned
// to pending, because re-offering it is how you pay twice.
async function sweepStuckSalaryApprovals(now = new Date()) {
  const cutoff = new Date(now.getTime() - 15 * 60 * 1000);
  const stuck = await prisma.salaryPayment.findMany({
    where: { status: "approving", decidedAt: { lte: cutoff } },
    select: { id: true, businessId: true, amount: true, reference: true },
    take: 100,
  });
  if (stuck.length === 0) return 0;
  const r = await prisma.salaryPayment.updateMany({
    where: { id: { in: stuck.map((s) => s.id) }, status: "approving" },
    data: {
      status: "failed",
      claimToken: null,
      failureReason: "The approval was interrupted. Check with the bank whether this payment went out before sending it again.",
    },
  });
  for (const s of stuck) {
    console.error(`[salary] stranded approval ${s.id} (ref ${s.reference}) parked as failed — reconcile against the provider`);
    await audit({
      action: "SALARY_APPROVAL_STRANDED", resourceType: "salaryPayment", resourceId: s.id,
      severity: "alert", metadata: { businessId: s.businessId, amount: s.amount, reference: s.reference },
    }).catch(() => {});
  }
  return r.count;
}

module.exports = {
  processSalaryPayments,
  expireStaleSalaryPayments,
  sweepStuckSalaryApprovals,
  spentLast24h,
};
