// Staff Payments — scheduled salary, approved by the owner every time.
//
// NOT a payroll system. It sends the amount the owner typed and handles no
// PAYE, no pension, no NHF, no payslips. Those are regulated employer
// obligations in Nigeria, and a product that merely IMPLIES it remits them
// would be worse than one that doesn't offer them at all. The mobile copy says
// so explicitly at setup.
//
// OWNER-ONLY, AT THE ROUTER LEVEL. Not per-route: there is then no individual
// endpoint that can be shipped without the gate. This is the same class as
// submitting identity documents and granting permissions — surfaces no
// capability may ever unlock. `PERMISSIONS` in requirePermission.js is
// deliberately NOT extended: a staff member who could schedule a salary could
// schedule their own.
const router = require("express").Router();
const auth = require("../middleware/auth");
const requireUnfrozen = require("../middleware/requireUnfrozen");
const { ownerOnly } = require("../middleware/requirePermission");
const prisma = require("../utils/db");
const { getProvider } = require("../providers");
const { verifyTransactionPin } = require("../utils/transactionPin");
const { runPreTransferChecks } = require("../utils/amlChecks");
const { executeTransfer } = require("../utils/executeTransfer");
const { audit } = require("../utils/audit");
const { pushTo } = require("../utils/pushNotification");
const { randomUUID } = require("crypto");
const { resolveBusinessLimits, formatAmountForBusiness } = require("../config/amlLimits");
const {
  computeNextPayDate,
  periodKeyFor,
  referenceFor,
  consentMatches,
  payeeKey,
  isLapsed,
  FREQUENCIES,
} = require("../utils/salarySchedule");

router.use(auth);
router.use(requireUnfrozen);
router.use(ownerOnly("Only the business owner can manage staff payments."));

// ── Helpers ─────────────────────────────────────────────────────────────────

async function ownedBusiness(req, businessId) {
  if (!businessId) return null;
  return prisma.business.findFirst({ where: { id: businessId, userId: req.user.id } });
}

// The staff member must still BE this owner's staff. Re-checked at every write
// and again at approval time: a schedule outliving the employment is exactly
// how an ex-employee keeps getting paid.
async function ownedStaff(req, staffUserId) {
  if (!staffUserId) return null;
  const u = await prisma.user.findUnique({
    where: { id: staffUserId },
    select: { id: true, firstName: true, lastName: true, accountType: true, employerId: true },
  });
  if (!u) return null;
  if (String(u.accountType).toUpperCase() !== "STAFF") return null;
  if (u.employerId !== req.user.id) return null;
  return u;
}

const staffName = (u) =>
  `${u.firstName || ""} ${u.lastName || ""}`.trim() || "Staff member";

// Resolve the payee name from the BANK, never from the request body. A
// client-supplied name makes an approval screen look like oversight while
// providing none — the owner would be confirming a name the sender typed.
async function resolvePayeeName(biz, accountNumber, bankCode) {
  // Internal first: our own virtual NUBANs are not in the provider's enquiry.
  const internal = await prisma.business.findFirst({
    where: { virtualAccountNumber: accountNumber },
    select: { name: true, virtualAccountName: true },
  });
  if (internal) {
    return { accountName: internal.virtualAccountName || internal.name, verified: true };
  }
  try {
    const provider = getProvider(biz);
    const r = await provider.verifyRecipient({
      accountNumber,
      bankCode,
      currency: biz.baseCurrency || "NGN",
    });
    if (r?.accountName) return { accountName: r.accountName, verified: true };
  } catch (e) {
    console.warn("[payroll] name enquiry failed:", e.message);
  }
  return { accountName: null, verified: false };
}

const publicSchedule = (s) => ({
  id: s.id,
  businessId: s.businessId,
  staffUserId: s.staffUserId,
  staffName: s.staffNameSnapshot,
  amount: s.amount,
  currency: s.currency,
  frequency: s.frequency,
  anchorDay: s.anchorDay,
  nextRunDate: s.nextRunDate,
  status: s.status,
  pausedReason: s.pausedReason,
  bankName: s.bankName,
  accountName: s.accountName,
  // Masked: the owner set it and only needs to recognise it.
  accountNumber: s.accountNumber ? `••••${String(s.accountNumber).slice(-4)}` : null,
  nameVerified: s.nameVerified,
  lastRunAt: s.lastRunAt,
  lastRunStatus: s.lastRunStatus,
});

const publicPayment = (p) => ({
  id: p.id,
  scheduleId: p.scheduleId,
  staffUserId: p.staffUserId,
  staffName: p.staffNameSnapshot,
  amount: p.amount,
  currency: p.currency,
  periodKey: p.periodKey,
  scheduledFor: p.scheduledFor,
  // Expiry is applied on READ as well as in the claim, so a stalled reaper can
  // never leave something looking approvable that isn't.
  status: isLapsed(p) ? "expired" : p.status,
  reason: p.reason,
  failureReason: p.failureReason,
  owed: p.owed,
  bankName: p.bankName,
  accountName: p.accountName,
  accountNumber: p.accountNumber ? `••••${String(p.accountNumber).slice(-4)}` : null,
  nameVerified: p.nameVerified,
  expiresAt: p.expiresAt,
  paidAt: p.paidAt,
});

// ── Schedules ───────────────────────────────────────────────────────────────

// GET /payroll?businessId=
router.get("/", async (req, res) => {
  try {
    const where = { ownerId: req.user.id };
    if (req.query.businessId) where.businessId = String(req.query.businessId);
    const rows = await prisma.salarySchedule.findMany({
      where,
      orderBy: { nextRunDate: "asc" },
    });
    res.json(rows.map(publicSchedule));
  } catch (err) {
    console.error("[payroll list]", err.message);
    res.status(500).json({ error: "Failed to load staff payments" });
  }
});

// POST /payroll  { businessId, staffUserId, amount, frequency, anchorDay,
//                  accountNumber, bankCode, bankName, pin }
router.post("/", async (req, res) => {
  try {
    if (req.user.plan !== "PREMIUM") {
      return res.status(403).json({
        error: "Staff payments need a Pro plan.",
        code: "PRO_REQUIRED",
      });
    }
    const {
      businessId, staffUserId, amount, frequency = "monthly",
      anchorDay, accountNumber, bankCode, bankName, pin,
    } = req.body || {};

    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      return res.status(400).json({ error: "Enter a valid amount." });
    }
    if (!FREQUENCIES.has(frequency)) {
      return res.status(400).json({ error: "Choose monthly or weekly." });
    }
    const day = Number(anchorDay);
    const dayOk = frequency === "monthly"
      ? Number.isInteger(day) && day >= 1 && day <= 31
      : Number.isInteger(day) && day >= 0 && day <= 6;
    if (!dayOk) return res.status(400).json({ error: "Choose a payment day." });
    if (!/^\d{10}$/.test(String(accountNumber || ""))) {
      return res.status(400).json({ error: "Account number must be 10 digits." });
    }
    if (!bankCode) return res.status(400).json({ error: "Choose a bank." });

    const biz = await ownedBusiness(req, businessId);
    if (!biz) return res.status(404).json({ error: "Business not found" });

    const provider = getProvider(biz);
    if (!provider.supportsBanking) {
      return res.status(400).json({ error: "Banking isn't available in your country yet.", code: "BANKING_NOT_AVAILABLE" });
    }
    // Refuse now rather than on payday: a schedule on a business with no
    // account would fail every single period with nobody watching.
    if (!(biz.providerAccountId || biz.anchorAccountId)) {
      return res.status(400).json({ error: "Open your KashBook account first.", code: "NO_BANKING" });
    }

    const staff = await ownedStaff(req, staffUserId);
    if (!staff) return res.status(404).json({ error: "Staff member not found" });

    // Refusing an over-cap amount at SETUP beats failing every month. It also
    // keeps the unattended-OTP bypass honourable: the AML pipeline only honours
    // it at or below singleMax.
    const limits = resolveBusinessLimits(biz);
    if (limits?.singleMax && amt > limits.singleMax) {
      return res.status(400).json({
        error: `That's above your ${formatAmountForBusiness(biz, limits.singleMax)} single-transfer limit.`,
        code: "ABOVE_SINGLE_CAP",
      });
    }

    const pinCheck = await verifyTransactionPin(req.user.id, pin);
    if (!pinCheck.ok) {
      await audit({
        req, action: "PIN_FAILED", resourceType: "user", resourceId: req.user.id,
        severity: "warn", metadata: { code: pinCheck.code, context: "create_salary_schedule" },
      }).catch(() => {});
      return res.status(pinCheck.status || 401).json({ error: pinCheck.error, code: pinCheck.code });
    }

    // Name enquiry, server-side. Stricter than the staff-transfer hold path,
    // which stores an unverified name for a human to eyeball: on payday nobody
    // is eyeballing, so an unresolvable account is refused outright.
    const { accountName, verified } = await resolvePayeeName(biz, accountNumber, bankCode);
    if (!verified) {
      return res.status(400).json({
        error: "We couldn't confirm that account with the bank. Check the number and bank.",
        code: "RECIPIENT_UNVERIFIED",
      });
    }

    const nextRunDate = computeNextPayDate({ frequency, anchorDay: day, from: new Date() });

    const created = await prisma.salarySchedule.create({
      data: {
        businessId: biz.id,
        ownerId: req.user.id,
        staffUserId: staff.id,
        staffNameSnapshot: staffName(staff),
        accountNumber: String(accountNumber),
        bankCode: String(bankCode),
        bankName: bankName || null,
        accountName,
        nameVerified: true,
        amount: amt,
        currency: biz.baseCurrency || "NGN",
        frequency,
        anchorDay: day,
        nextRunDate,
        // Consent is bound to the amount AND the payee, and the runner reads it
        // back before minting anything.
        authorizedAt: new Date(),
        authorizedAmount: amt,
        authorizedPayee: payeeKey(accountNumber, bankCode),
      },
    }).catch((e) => {
      if (e.code === "P2002") return null;
      throw e;
    });

    if (!created) {
      return res.status(409).json({
        error: `${staffName(staff)} already has a scheduled payment.`,
        code: "ALREADY_SCHEDULED",
      });
    }

    await audit({
      req, action: "SALARY_SCHEDULE_CREATED", resourceType: "business", resourceId: biz.id,
      severity: "warn",
      metadata: { scheduleId: created.id, staffUserId: staff.id, amount: amt, frequency, anchorDay: day },
    }).catch(() => {});

    res.status(201).json(publicSchedule(created));
  } catch (err) {
    console.error("[payroll create]", err.message);
    res.status(500).json({ error: "Failed to schedule that payment" });
  }
});

// PATCH /payroll/:id  { amount?, accountNumber?, bankCode?, bankName?,
//                       anchorDay?, status?, pin? }
//
// A fresh PIN is required whenever the AMOUNT or the DESTINATION changes, or
// when a paused schedule is resumed. The amount trigger is the gap in the
// recurring-expense engine, where a plain PATCH can raise a standing payment
// with no re-authentication at all.
router.patch("/:id", async (req, res) => {
  try {
    const existing = await prisma.salarySchedule.findFirst({
      where: { id: req.params.id, ownerId: req.user.id },
    });
    if (!existing) return res.status(404).json({ error: "Not found" });

    const { amount, accountNumber, bankCode, bankName, anchorDay, status, pin } = req.body || {};

    const nextAmount = amount === undefined ? existing.amount : Number(amount);
    if (!Number.isFinite(nextAmount) || nextAmount <= 0) {
      return res.status(400).json({ error: "Enter a valid amount." });
    }
    const nextAccount = accountNumber === undefined ? existing.accountNumber : String(accountNumber);
    const nextBank = bankCode === undefined ? existing.bankCode : String(bankCode);
    if (!/^\d{10}$/.test(nextAccount)) {
      return res.status(400).json({ error: "Account number must be 10 digits." });
    }

    const amountChanged = Math.round(nextAmount * 100) !== Math.round(existing.amount * 100);
    const payeeChanged = nextAccount !== existing.accountNumber || nextBank !== existing.bankCode;
    const resuming = status === "active" && existing.status !== "active";
    const needsPin = amountChanged || payeeChanged || resuming;

    if (needsPin) {
      const pinCheck = await verifyTransactionPin(req.user.id, pin);
      if (!pinCheck.ok) {
        await audit({
          req, action: "PIN_FAILED", resourceType: "user", resourceId: req.user.id,
          severity: "warn", metadata: { code: pinCheck.code, context: "update_salary_schedule" },
        }).catch(() => {});
        return res.status(pinCheck.status || 401).json({ error: pinCheck.error, code: pinCheck.code });
      }
    }

    const data = {};
    if (anchorDay !== undefined) {
      const day = Number(anchorDay);
      const dayOk = existing.frequency === "monthly"
        ? Number.isInteger(day) && day >= 1 && day <= 31
        : Number.isInteger(day) && day >= 0 && day <= 6;
      if (!dayOk) return res.status(400).json({ error: "Choose a payment day." });
      data.anchorDay = day;
    }
    if (status !== undefined) {
      if (!["active", "paused"].includes(status)) {
        return res.status(400).json({ error: "Unknown status." });
      }
      data.status = status;
      data.pausedReason = status === "paused" ? "Paused by you" : null;
      if (status === "active") data.consecutiveUnpaidPeriods = 0;
    }

    let skippedPeriods = 0;
    if (payeeChanged) {
      const biz = await prisma.business.findFirst({ where: { id: existing.businessId, userId: req.user.id } });
      if (!biz) return res.status(404).json({ error: "Business not found" });
      const { accountName, verified } = await resolvePayeeName(biz, nextAccount, nextBank);
      if (!verified) {
        return res.status(400).json({
          error: "We couldn't confirm that account with the bank.",
          code: "RECIPIENT_UNVERIFIED",
        });
      }
      data.accountNumber = nextAccount;
      data.bankCode = nextBank;
      data.bankName = bankName ?? existing.bankName;
      data.accountName = accountName;
      data.nameVerified = true;
    }
    if (amountChanged) data.amount = nextAmount;

    // Re-authorise whenever a PIN was required, so consent always describes the
    // row as it now stands.
    if (needsPin) {
      data.authorizedAt = new Date();
      data.authorizedAmount = data.amount ?? existing.amount;
      data.authorizedPayee = payeeKey(data.accountNumber ?? existing.accountNumber, data.bankCode ?? existing.bankCode);
    }

    // Resuming NEVER backfills. A schedule paused for three months moves to the
    // next FUTURE date; the periods that passed are reported so the owner can
    // pay them deliberately, and can never silently become three payments.
    if (resuming) {
      const freq = existing.frequency;
      const day = data.anchorDay ?? existing.anchorDay;
      let cursor = existing.nextRunDate;
      const now = new Date();
      while (cursor <= now && skippedPeriods < 60) {
        cursor = computeNextPayDate({ frequency: freq, anchorDay: day, from: cursor });
        skippedPeriods++;
      }
      data.nextRunDate = cursor;
    } else if (data.anchorDay !== undefined) {
      data.nextRunDate = computeNextPayDate({
        frequency: existing.frequency, anchorDay: data.anchorDay, from: new Date(),
      });
    }

    const updated = await prisma.salarySchedule.update({ where: { id: existing.id }, data });

    if (amountChanged) {
      await audit({
        req, action: "SALARY_AMOUNT_CHANGED", resourceType: "business", resourceId: existing.businessId,
        severity: "warn",
        metadata: { scheduleId: existing.id, staffUserId: existing.staffUserId, from: existing.amount, to: nextAmount },
      }).catch(() => {});
    }

    res.json({ ...publicSchedule(updated), skippedPeriods });
  } catch (err) {
    console.error("[payroll update]", err.message);
    res.status(500).json({ error: "Failed to update that payment" });
  }
});

// DELETE /payroll/:id
// Cancels any pending payment BEFORE removing the schedule, so a queued
// approval can't outlive the instruction that created it. Paid history is
// untouched — SalaryPayment carries its own snapshots and has no FK to here.
router.delete("/:id", async (req, res) => {
  try {
    const existing = await prisma.salarySchedule.findFirst({
      where: { id: req.params.id, ownerId: req.user.id },
    });
    if (!existing) return res.status(404).json({ error: "Not found" });

    await prisma.salaryPayment.updateMany({
      where: { scheduleId: existing.id, status: "pending" },
      data: { status: "rejected", reason: "The schedule was removed.", owed: false, decidedById: req.user.id, decidedAt: new Date() },
    });
    await prisma.salarySchedule.delete({ where: { id: existing.id } });

    await audit({
      req, action: "SALARY_SCHEDULE_DELETED", resourceType: "business", resourceId: existing.businessId,
      severity: "warn", metadata: { scheduleId: existing.id, staffUserId: existing.staffUserId },
    }).catch(() => {});

    res.json({ deleted: true });
  } catch (err) {
    console.error("[payroll delete]", err.message);
    res.status(500).json({ error: "Failed to remove that payment" });
  }
});

// ── Payments ────────────────────────────────────────────────────────────────

// GET /payroll/payments?businessId=&status=
router.get("/payments", async (req, res) => {
  try {
    const where = { ownerId: req.user.id };
    if (req.query.businessId) where.businessId = String(req.query.businessId);
    if (req.query.status) where.status = String(req.query.status);
    const rows = await prisma.salaryPayment.findMany({
      where,
      orderBy: { scheduledFor: "desc" },
      take: 100,
    });
    res.json(rows.map(publicPayment));
  } catch (err) {
    console.error("[payroll payments]", err.message);
    res.status(500).json({ error: "Failed to load payments" });
  }
});

// POST /payroll/payments/:id/skip
// An EXPLICIT skip, audited, clearing `owed`. The recurring engine advanced its
// cursor past a skipped period and that money simply vanished from the record;
// here a period is only ever unpaid on purpose.
router.post("/payments/:id/skip", async (req, res) => {
  try {
    const claim = await prisma.salaryPayment.updateMany({
      where: { id: req.params.id, ownerId: req.user.id, status: "pending" },
      data: {
        status: "skipped", owed: false,
        reason: "Skipped by you",
        decidedById: req.user.id, decidedAt: new Date(),
      },
    });
    if (claim.count !== 1) {
      return res.status(409).json({ error: "That payment is no longer pending.", code: "NOT_PENDING" });
    }
    await audit({
      req, action: "SALARY_PAYMENT_SKIPPED", resourceType: "salaryPayment", resourceId: req.params.id,
      severity: "warn",
    }).catch(() => {});
    res.json({ skipped: true });
  } catch (err) {
    console.error("[payroll skip]", err.message);
    res.status(500).json({ error: "Failed to skip that payment" });
  }
});

// POST /payroll/payments/:id/reject
// Declining spends nothing, so no PIN. The period stays OWED and visible.
router.post("/payments/:id/reject", async (req, res) => {
  try {
    const claim = await prisma.salaryPayment.updateMany({
      where: { id: req.params.id, ownerId: req.user.id, status: "pending" },
      data: {
        status: "rejected",
        reason: String(req.body?.reason || "Declined by you").slice(0, 200),
        decidedById: req.user.id, decidedAt: new Date(),
      },
    });
    if (claim.count !== 1) {
      return res.status(409).json({ error: "That payment is no longer pending.", code: "NOT_PENDING" });
    }
    res.json({ rejected: true });
  } catch (err) {
    console.error("[payroll reject]", err.message);
    res.status(500).json({ error: "Failed to decline that payment" });
  }
});

// POST /payroll/approve  { businessId, paymentIds: [...], pin }
//
// ONE PIN, MANY PAYMENTS. The owner has just seen every name and amount on one
// screen and removed anyone they wanted to hold back, so a PIN per person would
// only add lockout risk (five wrong tries locks the PIN for 15 minutes).
//
// This is the ONLY place in the feature that moves money. The cron mints rows
// and never calls executeTransfer.
router.post("/approve", async (req, res) => {
  try {
    const { businessId, paymentIds, pin } = req.body || {};
    if (!Array.isArray(paymentIds) || paymentIds.length === 0) {
      return res.status(400).json({ error: "Choose at least one payment." });
    }
    if (paymentIds.length > 50) {
      return res.status(400).json({ error: "Approve at most 50 payments at a time." });
    }

    const pinCheck = await verifyTransactionPin(req.user.id, pin);
    if (!pinCheck.ok) {
      await audit({
        req, action: "PIN_FAILED", resourceType: "user", resourceId: req.user.id,
        severity: "warn", metadata: { code: pinCheck.code, context: "approve_salary" },
      }).catch(() => {});
      return res.status(pinCheck.status || 401).json({ error: pinCheck.error, code: pinCheck.code });
    }

    const biz = await ownedBusiness(req, businessId);
    if (!biz) return res.status(404).json({ error: "Business not found" });
    const provider = getProvider(biz);
    if (!provider.supportsBanking) {
      return res.status(400).json({ error: "Banking isn't available in your country yet.", code: "BANKING_NOT_AVAILABLE" });
    }

    const ownerFull = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true, accountStatus: true, complianceFreezeReason: true,
        email: true, phone: true, firstName: true, lastName: true,
      },
    });
    if (!ownerFull) return res.status(404).json({ error: "Owner not found" });
    const ownerName = `${ownerFull.firstName || ""} ${ownerFull.lastName || ""}`.trim() || null;

    // ── ATOMIC CLAIM ────────────────────────────────────────────────────────
    // One statement claims the whole batch and still yields per-row ownership
    // via the token: two devices double-tapping produce two tokens, and every
    // row belongs to exactly one of them. Everything before this is a read and
    // may legitimately race; nothing after it can run twice.
    //
    // expiresAt is re-checked HERE, not only when the list was read: between
    // that read and this line the batch survives a PIN verify, a business
    // lookup and a provider resolve.
    const claimToken = randomUUID();
    await prisma.salaryPayment.updateMany({
      where: {
        id: { in: paymentIds },
        ownerId: req.user.id,
        businessId: biz.id,
        status: "pending",
        expiresAt: { gt: new Date() },
      },
      data: { status: "approving", claimToken, decidedById: req.user.id, decidedAt: new Date() },
    });
    const mine = await prisma.salaryPayment.findMany({
      where: { claimToken, status: "approving" },
      orderBy: { createdAt: "asc" },
    });
    if (mine.length === 0) {
      return res.status(409).json({ error: "Those payments are no longer pending.", code: "NOT_PENDING" });
    }

    const results = [];
    for (const p of mine) {
      // The staff member may have left while the payment sat in the queue.
      const stillStaff = await ownedStaff(req, p.staffUserId);
      if (!stillStaff) {
        await prisma.salaryPayment.update({
          where: { id: p.id },
          data: { status: "rejected", owed: false, reason: "That person is no longer on your team.", claimToken: null },
        });
        results.push({ id: p.id, staffName: p.staffNameSnapshot, status: "rejected", error: "No longer on your team" });
        continue;
      }

      const outcome = await prisma.withBusinessLock(biz.id, async () => {
        const amlCheck = await runPreTransferChecks({
          req,
          user: ownerFull,   // compliance subject
          actor: ownerFull,  // the OWNER is approving
          business: biz,
          amount: Number(p.amount),
          // The owner has just PIN'd this specific batch — the same standing the
          // approval queue relies on. A second OTP would mean authenticating
          // twice for money they are already looking at.
          bypassOtp: true,
        });
        if (!amlCheck.ok) {
          // Back to pending so the owner can retry when the blocker clears
          // (typically the daily limit, tomorrow) rather than burning it.
          await prisma.salaryPayment.update({
            where: { id: p.id },
            data: { status: "pending", claimToken: null, decidedById: null, decidedAt: null, failureReason: amlCheck.error },
          });
          return { blocked: amlCheck };
        }

        const exec = await executeTransfer({
          business: biz,
          userId: p.ownerId,
          // recordedBy is the OWNER, never the payee. staffSpendLast24h sums
          // the rolling-24h staff cap BY recordedBy, so stamping the recipient
          // would consume their personal transfer cap with money they never
          // sent — and lock them out of their own sends for a day after payday.
          recordedBy: p.ownerId,
          recordedByName: ownerName,
          amount: Number(p.amount),
          accountNumber: p.accountNumber,
          bankCode: p.bankCode,
          // Only a BANK-CONFIRMED name. executeTransfer skips its own enquiry
          // whenever accountName is truthy, so an unverified string would both
          // skip verification and get stamped on the counterparty.
          accountName: p.nameVerified ? p.accountName : null,
          bankName: p.bankName,
          narration: `Salary · ${p.staffNameSnapshot} · ${p.periodKey}`,
          reference: p.reference,
          amlCheck,
          req,
          notify: false,
        });
        return { exec };
      });

      if (outcome.blocked) {
        results.push({
          id: p.id, staffName: p.staffNameSnapshot, status: "pending",
          error: outcome.blocked.error, code: outcome.blocked.code,
        });
        continue;
      }

      const { exec } = outcome;
      await prisma.salaryPayment.update({
        where: { id: p.id },
        data: {
          status: "paid",
          owed: false,
          paidAt: new Date(),
          claimToken: null,
          executedTransactionId: exec.transactionId || null,
          executedReference: exec.reference || null,
          feeCharged: Number(exec.fee || 0),
        },
      });
      await prisma.salarySchedule.updateMany({
        where: { id: p.scheduleId },
        data: { lastRunAt: new Date(), lastRunStatus: "paid", consecutiveUnpaidPeriods: 0 },
      });
      try {
        require("../utils/balanceCache").adjustBalance(biz.id, -(Number(p.amount) + Number(exec.fee || 0)));
      } catch { /* noop */ }

      results.push({
        id: p.id, staffName: p.staffNameSnapshot, status: "paid",
        reference: exec.reference, fee: exec.fee,
      });
    }

    const paid = results.filter((r) => r.status === "paid");
    await audit({
      req, action: "SALARY_APPROVED", resourceType: "business", resourceId: biz.id,
      severity: "warn",
      metadata: {
        requested: paymentIds.length,
        paid: paid.length,
        total: paid.reduce((s, r) => s + 0, 0) || undefined,
      },
    }).catch(() => {});

    res.json({ results, paidCount: paid.length, requested: paymentIds.length });
  } catch (err) {
    console.error("[payroll approve]", err.message);
    res.status(500).json({ error: "Failed to send those payments" });
  }
});

module.exports = router;
