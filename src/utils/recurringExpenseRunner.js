// Background processor for recurring expenses.
//
// Behaviour for every item:
//   - Bookkeeping-only items (autoSend=false): create the Expense row, advance
//     nextDue. Same as before.
//   - Bookkeeping-only items on credit (chart of accounts release 2): an
//     unpaid bill instead of the Expense row (recordRuleBill), as an expense
//     saved on credit becomes one (scripts/backfill-r2.js). An expense on
//     credit sat in Accounts Payable with nothing to settle it, and counted as
//     spending though nothing was paid; a bill is paid off in Bills. A rule
//     that cannot make one (no business, or an account that is not spending)
//     is paused and its owner told. A rule that names the account it is paid
//     from records the Expense row as before: the books took that as paid.
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
const chart = require("./chart");
const { ensureChart, invalidateLedger } = require("./ledgerData");
const { toKobo } = require("./money");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// What an auto-debit was for, written on its bank row as POST
// /transactions/:id/categorize writes it: the rule's account, and purpose
// "account" when that account is on the balance sheet (a loan repaid, the
// owner's drawings), so the books leave the debit out of spending and the
// ledger posts it to that account; spending counts as it always has. A rule
// that names no account (or one gone from the chart) leaves the row to the
// rule's category (utils/chart.js bankRowAccount).
async function ruleAccountOnRow(rec, businessId) {
  if (!rec.accountId) return { accountId: null, purpose: null };
  const acc = await prisma.ledgerAccount.findFirst({
    where: { id: rec.accountId, businessId },
    select: { id: true, type: true },
  });
  const cls = acc ? chart.classOf(acc.type) : null;
  if (cls === "expense") return { accountId: acc.id, purpose: null };
  if (cls && !chart.isProfitClass(cls)) return { accountId: acc.id, purpose: "account" };
  return { accountId: null, purpose: null };
}

// "credit" in any spelling, as the ledger reads a payment method
// (chart.methodAccountKey).
const isCredit = (method) => String(method == null ? "" : method).trim().toLowerCase() === "credit";

// Whether a rule names the account it is paid from. The ledger takes an
// expense's money from that account before its method (chart.moneyAccount),
// so the expense such a rule records was booked as paid from there, never as
// owed, even on credit (scripts/backfill-r2.js leaves those expenses too).
async function namesPaidFrom(rec) {
  if (!rec.paidThroughAccountId || !rec.businessId) return false;
  const acc = await prisma.ledgerAccount.findFirst({
    where: { id: rec.paidThroughAccountId, businessId: rec.businessId },
    select: { systemKey: true },
  });
  return !!acc && acc.systemKey !== chart.SYS.AP;
}

// Text cut to `max` characters, whole ones (never half an emoji).
const cut = (text, max) => Array.from(text).slice(0, max).join("");

// Who a rule's bill is from: the first line of the rule's note, else the payee
// it names, else its account (the rule never said), as scripts/backfill-r2.js
// names a bill made from an expense. At most 120 characters, as POST /bills.
function ruleVendor(rec, account) {
  const first = String(rec.notes || "").split(/\r?\n/).map((s) => s.trim()).find(Boolean);
  return cut(first || String(rec.payeeAccountName || "").trim() || account.name, 120);
}

// A rule on credit, when due: an unpaid bill dated now (as its expense was),
// for the rule's amount, with the rule's note, on the account its expense
// would have been booked to (the rule's own, else its category's, which
// ensureChart sets up, else Other Expenses: chart.expenseAccount). Only on
// spending that the engine does not keep by itself: a bill on the balance
// sheet (a loan, equipment, rent paid ahead) would mean something else, as
// scripts/backfill-r2.js leaves such an expense. Written under the business
// lock, which an account merge or delete also takes (routes/ledger.js), as
// POST /bills does. Returns { ok: true, bill }, or { ok: false, reason,
// accountId } with nothing written.
async function recordRuleBill(rec, now) {
  const businessId = rec.businessId;
  // A bill belongs to one of the owner's businesses: a rule left without one
  // (its business was deleted) has nowhere to put it.
  if (!businessId || !rec.business || rec.business.userId !== rec.userId) {
    return { ok: false, reason: "no_business", accountId: null };
  }
  const amountK = toKobo(rec.amount);
  if (!(amountK > 0)) throw new Error(`the rule's amount (${rec.amount}) is not above zero`);
  await ensureChart(businessId);
  const made = await prisma.withBusinessLock(businessId, () =>
    prisma.$transaction(async (px) => {
      const accounts = await px.ledgerAccount.findMany({
        where: { businessId },
        select: { id: true, type: true, name: true, systemKey: true, categorySlug: true, aliasSlugs: true },
      });
      const account = chart.expenseAccount(chart.indexChart(accounts), { accountId: rec.accountId, category: rec.category });
      if (!account || chart.classOf(account.type) !== "expense" || chart.CONTROLLED.includes(account.systemKey)) {
        return { ok: false, reason: "account_not_spending", accountId: account ? account.id : null };
      }
      const note = String(rec.notes || "").trim();
      const bill = await px.businessDebt.create({
        data: {
          userId: rec.userId,
          businessId,
          name: ruleVendor(rec, account),
          type: account.categorySlug || "other",
          originalAmount: amountK / 100,
          remainingAmount: amountK / 100,
          status: "unpaid",
          billDate: now,
          note: note ? cut(note, 500) : null,
          accountId: account.id,
          estimated: false,
          createdById: rec.userId,
        },
      });
      return { ok: true, bill };
    }),
  );
  if (made.ok) {
    invalidateLedger(businessId);
    await audit({
      action: "BILL_CREATE",
      resourceType: "bill",
      resourceId: made.bill.id,
      actorOverride: { type: "system", id: null },
      metadata: { businessId, amount: made.bill.originalAmount, accountId: made.bill.accountId, recurringExpenseId: rec.id },
    });
  }
  return made;
}

// A rule on credit that cannot make a bill is paused, and its owner told,
// rather than record an expense on credit again. Turned back on, it tries
// again on its next due date.
async function pauseCreditRule(rec, made) {
  await prisma.recurringExpense.update({ where: { id: rec.id }, data: { active: false } });
  await pushTo(
    rec.userId,
    "Recurring expense paused",
    `${formatAmountForBusiness(rec.business, rec.amount)} on credit can no longer be recorded as an expense. ` +
      "Add it in Bills, or choose how it is paid and turn it back on.",
  );
  await audit({
    action: "RECURRING_PAUSED_CREDIT",
    resourceType: "recurringExpense",
    resourceId: rec.id,
    severity: "warn",
    actorOverride: { type: "system", id: null },
    metadata: { userId: rec.userId, businessId: rec.businessId || null, reason: made.reason, accountId: made.accountId },
  });
}

async function processRecurringExpenses({ now = new Date() } = {}) {
  const due = await prisma.recurringExpense.findMany({
    where: { active: true, nextDue: { lte: now } },
    include: { user: true, business: true },
  });

  let createdExpenses = 0;
  let createdBills = 0;
  let pausedCreditRules = 0;
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
      } else if (isCredit(rec.paymentMethod) && !(await namesPaidFrom(rec))) {
        // On credit: an unpaid bill, never an expense (see the top).
        const made = await recordRuleBill(rec, now);
        if (made.ok) createdBills++;
        else {
          await pauseCreditRule(rec, made);
          pausedCreditRules++;
        }
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
            // The rule's accounts, when it names them (chart of accounts).
            accountId: rec.accountId || null,
            paidThroughAccountId: rec.paidThroughAccountId || null,
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
      `${createdExpenses} bookkeeping rows, ${createdBills} bills, ${pausedCreditRules} credit rules paused, ` +
      `${autoDebited} auto-debited, ${autoDebitErrors} auto-debit errors`,
    );
  }

  return { processed: due.length, createdExpenses, createdBills, pausedCreditRules, autoDebited, autoDebitErrors };
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
  // The rule's account goes on the bank row with the money (chart of accounts).
  const booking = await ruleAccountOnRow(rec, business.id);

  // 3. Execute the transfer UNDER the per-business advisory lock — the same lock
  // the interactive /send holds (routes/transfers.js). Without it a cron auto-debit
  // and a manual send (or two auto-debits) could both read computeLedgerBalance
  // before either books its expense, both pass the gate, and overdraw the pool.
  try {
    const sent = await prisma.withBusinessLock(business.id, () =>
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
        accountId: booking.accountId,
      }),
    );
    // The purpose in step with the account, for an older app copy that reads
    // only the purpose (the books and the ledger read the account, already on
    // the row). The money has moved: a failure here is logged, never the run's.
    if (booking.purpose && sent && sent.transactionId) {
      await prisma.transaction
        .update({ where: { id: sent.transactionId }, data: { purpose: booking.purpose } })
        .catch((e) => console.error(`[recurring] ${rec.id}: purpose not written on ${sent.transactionId}:`, e.message));
    }

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
