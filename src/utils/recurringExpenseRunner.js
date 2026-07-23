// Background processor for recurring expenses.
//
// Behaviour for every item:
//   - Bookkeeping-only items (autoSend=false): create the Expense row, advance
//     nextDue. Same as before.
//   - Auto-debit items (autoSend=true): run the auto-debit transfer FIRST. If
//     it succeeds, executeTransfer writes a Transaction row that IS the
//     bookkeeping entry — we never create a separate Expense row. If the
//     transfer fails (insufficient balance, AML block, Anchor error), NOTHING
//     hits the books. The user's "Sent today" / outgoing totals only reflect
//     money that actually moved.
//   - nextDue advances either way (so we don't busy-loop).
//
// Per-item failures are caught, logged, and audited; the loop continues.
// The 1.5s throttle between items matches anchorReconcile.js so we stay
// under Anchor's rate limit on big fan-outs.

const prisma = require("./db");
const { computeNextDue } = require("./recurringSchedule");
const { runPreTransferChecks } = require("./amlChecks");
const { executeTransfer } = require("./executeTransfer");
const { audit } = require("./audit");
const { pushTo } = require("./pushNotification");
const { getThresholds, formatAmountForBusiness } = require("../config/amlLimits");
const { getProvider } = require("../providers");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function processRecurringExpenses({ now = new Date() } = {}) {
  const due = await prisma.recurringExpense.findMany({
    where: { active: true, nextDue: { lte: now } },
    include: { user: true, business: true },
  });

  let createdExpenses = 0;
  let autoDebited = 0;
  let autoDebitErrors = 0;

  for (let i = 0; i < due.length; i++) {
    const rec = due[i];
    const isAutoDebit = !!(rec.autoSend && rec.payeeAccountNumber && rec.business);
    try {
      if (isAutoDebit) {
        // Auto-debit branch: try the transfer first. The bookkeeping entry
        // (a Transaction row) is only written by executeTransfer if Anchor
        // accepts the transfer. A failed transfer leaves the books untouched
        // so "Sent today" stays accurate.
        const result = await runAutoDebit(rec, now);
        if (result.ok) autoDebited++;
        else autoDebitErrors++;
      } else {
        // Bookkeeping-only branch: just record the Expense row as before.
        await prisma.expense.create({
          data: {
            userId: rec.userId,
            businessId: rec.businessId,
            category: rec.category,
            amount: rec.amount,
            paymentMethod: rec.paymentMethod,
            notes: rec.notes,
            date: now,
          },
        });
        createdExpenses++;
      }
    } catch (err) {
      console.error(`[recurring] ${rec.id} failed:`, err.message || err);
      await audit({
        action: "RECURRING_FAILED",
        resourceType: "recurringExpense",
        resourceId: rec.id,
        severity: "alert",
        actorOverride: { type: "system", id: null },
        metadata: { error: err.message || String(err), userId: rec.userId },
      });
    }

    // 3. Advance nextDue (always — even on error so we don't busy-loop).
    try {
      await prisma.recurringExpense.update({
        where: { id: rec.id },
        data: { nextDue: computeNextDue(rec.frequency, rec.nextDue) },
      });
    } catch (err) {
      console.error(`[recurring] ${rec.id} nextDue update failed:`, err.message);
    }

    // Be nice to Anchor on big batches.
    if (i < due.length - 1) await sleep(1500);
  }

  if (due.length > 0) {
    console.log(
      `[recurring] processed ${due.length} due item(s): ` +
      `${createdExpenses} bookkeeping rows, ${autoDebited} auto-debited, ${autoDebitErrors} auto-debit errors`,
    );
  }

  return { processed: due.length, createdExpenses, autoDebited, autoDebitErrors };
}

// Run the auto-debit pipeline for one recurring item.
// Returns { ok: true } on success, { ok: false, reason } on any failure.
async function runAutoDebit(rec, now) {
  const { user, business } = rec;

  // Per-user global kill-switch.
  if (user && user.autoDebitEnabled === false) {
    await prisma.recurringExpense.update({
      where: { id: rec.id },
      data: { lastAutoSendStatus: "skipped_paused", lastAutoSendAt: now },
    });
    await audit({
      action: "RECURRING_SKIPPED_USER_PAUSED",
      resourceType: "recurringExpense",
      resourceId: rec.id,
      severity: "info",
      actorOverride: { type: "system", id: null },
      metadata: { userId: rec.userId },
    });
    return { ok: false, reason: "user_paused" };
  }

  // Country gate — Stage 1 only NG has a real BaaS.
  if (!getProvider(business).supportsBanking) {
    await prisma.recurringExpense.update({
      where: { id: rec.id },
      data: { lastAutoSendStatus: "blocked_aml", lastAutoSendAt: now },
    });
    return { ok: false, reason: "bookkeeping_only_country" };
  }

  // Above-cap short-circuit — recurring auto-debit must stay within the AML
  // single-cap. Anything bigger needs interactive PIN+OTP via Send Money.
  const thresholds = getThresholds(business);
  if (Number(rec.amount) > thresholds.singleFlagAbove) {
    // No-op heuristic — we still gate on the actual singleMax below; this
    // is just an early signal in metadata.
  }

  // 1. AML pre-check (frozen, tier limit, single-cap, rules engine).
  //    bypassOtp=true skips the interactive OTP gate; the AML pipeline
  //    still enforces every other rule.
  const amlCheck = await runPreTransferChecks({
    req: null,
    user,
    business,
    amount: Number(rec.amount),
    otp: null,
    bypassOtp: true,
  });

  // Even with bypassOtp, the pipeline can still gate above the single-cap
  // via the `BLOCKED_SINGLE_CAP` code (the bypass only applies to the OTP
  // step; the single-cap check runs unchanged).
  if (!amlCheck.ok) {
    const status =
      amlCheck.code === "BLOCKED_SINGLE_CAP" ? "above_cap"
      : amlCheck.code === "FROZEN" ? "blocked_aml"
      : amlCheck.code === "BLOCKED_LIMIT" ? "blocked_aml"
      : amlCheck.code === "HELD_FOR_REVIEW" ? "blocked_aml"
      : "blocked_aml";

    await prisma.recurringExpense.update({
      where: { id: rec.id },
      data: {
        lastAutoSendStatus: status,
        lastAutoSendAt: now,
        consecutiveFailures: { increment: 1 },
      },
    });

    await pushTo(
      rec.userId,
      status === "above_cap" ? "Confirm Recurring Transfer" : "Auto-debit blocked",
      status === "above_cap"
        ? `${formatAmountForBusiness(business, rec.amount)} is above your auto-debit cap. Confirm manually in Send Money.`
        : `Auto-debit blocked: ${amlCheck.error || amlCheck.code}`,
    );

    return { ok: false, reason: amlCheck.code };
  }

  // 2. Deterministic reference for idempotency.
  const reference = `kashbook_rec_${rec.id}_${new Date(rec.nextDue).getTime()}`;

  // 3. Execute the transfer UNDER the per-business advisory lock — the same lock
  // the interactive /send holds (routes/transfers.js). Without it a cron auto-debit
  // and a manual send (or two auto-debits) could both read computeLedgerBalance
  // before either books its expense, both pass the gate, and overdraw the pool.
  try {
    await prisma.withBusinessLock(business.id, () =>
      executeTransfer({
        business,
        userId: rec.userId,
        amount: Number(rec.amount),
        accountNumber: rec.payeeAccountNumber,
        bankCode: rec.payeeBankCode,
        accountName: rec.payeeAccountName,
        bankName: rec.payeeBankName,
        narration: rec.notes
          ? `Auto-debit · ${rec.notes}`
          : `Auto-debit · recurring ${rec.category}`,
        reference,
        amlCheck,
        req: null,
        notify: true,
      }),
    );

    await prisma.recurringExpense.update({
      where: { id: rec.id },
      data: {
        lastAutoSendStatus: "ok",
        lastAutoSendAt: now,
        lastAutoSendRef: reference,
        consecutiveFailures: 0,
      },
    });

    return { ok: true };
  } catch (err) {
    if (err.code === "INSUFFICIENT_BALANCE") {
      const newCount = (rec.consecutiveFailures || 0) + 1;
      const pause = newCount >= 2;
      await prisma.recurringExpense.update({
        where: { id: rec.id },
        data: {
          lastAutoSendStatus: "insufficient_balance",
          lastAutoSendAt: now,
          consecutiveFailures: newCount,
          ...(pause ? { active: false } : {}),
        },
      });
      await pushTo(
        rec.userId,
        pause ? "Auto-debit paused" : "Auto-debit retry tomorrow",
        pause
          ? `Top up and re-enable. ${formatAmountForBusiness(business, rec.amount)} couldn't be sent.`
          : `Not enough balance for ${formatAmountForBusiness(business, rec.amount)}. We'll retry on the next due date.`,
      );
      await audit({
        action: pause ? "RECURRING_PAUSED_INSUFFICIENT_BALANCE" : "RECURRING_INSUFFICIENT_BALANCE",
        resourceType: "recurringExpense",
        resourceId: rec.id,
        severity: pause ? "warn" : "info",
        actorOverride: { type: "system", id: null },
        metadata: { available: err.availableBalance, required: rec.amount, consecutiveFailures: newCount },
      });
      return { ok: false, reason: "insufficient_balance" };
    }

    if (err.code === "RECIPIENT_UNVERIFIED" || err.code === "UNKNOWN_BANK") {
      // Permanent failure for this payee — pause until the user fixes it.
      await prisma.recurringExpense.update({
        where: { id: rec.id },
        data: {
          lastAutoSendStatus: "blocked_aml",
          lastAutoSendAt: now,
          consecutiveFailures: { increment: 1 },
          active: false,
        },
      });
      await pushTo(
        rec.userId,
        "Auto-debit paused — recipient invalid",
        "Update the payee bank details to resume.",
      );
      return { ok: false, reason: err.code };
    }

    // Transient (Anchor 5xx, timeout). Don't pause; next cron tick retries.
    const newCount = (rec.consecutiveFailures || 0) + 1;
    const pause = newCount >= 3;
    await prisma.recurringExpense.update({
      where: { id: rec.id },
      data: {
        lastAutoSendStatus: "anchor_error",
        lastAutoSendAt: now,
        consecutiveFailures: newCount,
        ...(pause ? { active: false } : {}),
      },
    });
    if (pause) {
      await pushTo(
        rec.userId,
        "Auto-debit paused — repeated failures",
        "Couldn't reach the bank after multiple tries. Re-enable when ready.",
      );
    }
    await audit({
      action: "RECURRING_FAILED",
      resourceType: "recurringExpense",
      resourceId: rec.id,
      severity: pause ? "alert" : "warn",
      actorOverride: { type: "system", id: null },
      metadata: { error: err.message, code: err.code, consecutiveFailures: newCount },
    });
    return { ok: false, reason: err.code || "anchor_error" };
  }
}

module.exports = { processRecurringExpenses };
