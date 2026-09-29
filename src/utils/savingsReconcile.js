// Savings reconcile loop: the backstop that makes every savings state settle
// from the partners' own records, whether or not a webhook arrived.
//
// Runs every 5 minutes under withCronLock(4014), heartbeat "savings-reconcile".
// Each step is idempotent and claims its state changes with guarded
// updateMany calls, so a webhook handler running the same step at the same
// moment settles nothing twice. Steps that need PiggyVest are skipped when the
// partner is not configured; the ledger-pot checks run regardless, because
// ledger pots exist without any partner.
//
// Steps:
//   1. provisioning pots     wallet reserved → active (or aged out → error)
//   2. pending deposits      Anchor row proves "sent"; PiggyVest inflow proves
//                            "completed"; Anchor's transfer record fails a
//                            sent deposit the bank bounced; stale unknowns →
//                            needs_review
//   3. open withdrawals      GET /transaction/verify decides completed|failed
//   4. unlanded withdrawals  completed at PiggyVest but no Anchor credit yet →
//                            alert (never auto-tagged on amount alone)
//   5. wallet resync         balance, withdrawal count, rate from the wallet
//   6. interest              accrued month-to-date (hourly)
//   7. stray inflows         interest / external deposits booked as movements
//   8. ledger integrity      pot balance vs movements; reserve vs bank (hourly)
//   9. closed pots           a closed PiggyVest pot with a balance is reopened
const prisma = require("./db");
const piggyvest = require("../services/piggyvest");
const anchor = require("./anchor");
const savings = require("./savings");
const { fireAlert } = require("./alerts");
const { pushTo } = require("./pushNotification");
const { audit } = require("./audit");
const { formatAmountForBusiness } = require("../config/amlLimits");
const { toKobo } = require("./money");
const { MONEY_EPS } = require("../config/fees");

const SAVINGS_RECONCILE_LOCK = 4014;
const PROVISION_TIMEOUT_MS = 10 * 60 * 1000;
const RESERVE_TIMEOUT_MS = 60 * 60 * 1000;
const UNKNOWN_DEPOSIT_REVIEW_MS = 30 * 60 * 1000;
const SENT_DEPOSIT_RECHECK_MS = 15 * 60 * 1000;
const SENT_DEPOSIT_REVIEW_MS = 6 * 60 * 60 * 1000;
const UNLANDED_ALERT_MS = 2 * 60 * 60 * 1000;
const WITHDRAWAL_STUCK_MS = 60 * 60 * 1000;

const isAuthError = (e) => e?.status === 401 || e?.status === 403;

async function reconcileSavings({ walletId = null, full = false, logger = console } = {}) {
  const stats = { provisioned: 0, depositsSent: 0, depositsCompleted: 0, depositsFailed: 0, depositsReviewed: 0, withdrawalsSettled: 0, strays: 0, drift: 0, overReserved: 0, reopened: 0, errors: 0 };
  const pvOn = piggyvest.isConfigured();
  const potScope = walletId ? { pvWalletId: walletId } : {};

  // 1. Provisioning pots.
  if (pvOn) {
    const provisioning = await prisma.savingsPot.findMany({ where: { backing: "piggyvest", status: "provisioning", ...potScope } });
    for (const pot of provisioning) {
      try {
        const age = Date.now() - new Date(pot.createdAt).getTime();
        if (!pot.pvWalletId) {
          if (age > PROVISION_TIMEOUT_MS) {
            await prisma.savingsPot.updateMany({ where: { id: pot.id, status: "provisioning" }, data: { status: "error", error: "No wallet was created within 10 minutes" } });
            await fireAlert(`savings-provision-${pot.id}`, "Savings pot never got a wallet", `Pot ${pot.id} (${pot.name}) has no PiggyVest wallet id after 10 minutes. Check the PiggyVest dashboard for an orphan wallet named "${pot.name}".`);
          }
          continue;
        }
        const updated = await savings.activatePot(pot);
        if (updated?.status === "active") { stats.provisioned++; continue; }
        // A wallet that exists but never gets its funding account is a state
        // nothing else can leave; give it an hour, then hand it to a human.
        if (age > RESERVE_TIMEOUT_MS && (!updated || updated.status === "provisioning")) {
          await prisma.savingsPot.updateMany({ where: { id: pot.id, status: "provisioning" }, data: { status: "error", error: "PiggyVest never reserved an account number for this wallet" } });
          await fireAlert(`savings-reserve-${pot.id}`, "Savings pot wallet has no account number", `Pot ${pot.id} (${pot.name}) wallet ${pot.pvWalletId} has had no reserved funding account for an hour. Check it in the PiggyVest dashboard.`);
        }
      } catch (e) {
        if (isAuthError(e)) throw e;
        stats.errors++;
        logger.warn?.(`[savings-reconcile] provisioning ${pot.id}: ${e.message}`);
      }
    }
  }

  // 2 + 7. Deposits and stray inflows, per active wallet.
  const pvPots = pvOn
    ? await prisma.savingsPot.findMany({ where: { backing: "piggyvest", status: "active", pvWalletId: { not: null }, ...potScope } })
    : [];
  for (const pot of pvPots) {
    try {
      // needs_review rows stay in the set for REFERENCE pairing only: a late
      // inflow that names them completes them; they never pair on amount.
      const pending = await prisma.savingsMovement.findMany({
        where: { potId: pot.id, type: "deposit", status: { in: ["initiated", "sent", "unknown", "needs_review"] } },
        orderBy: { createdAt: "asc" },
      });
      // 2a. Anchor's own record settles "did the money leave": a Transaction
      // carrying the reference exists only if executeTransfer got past the
      // bank call and booked it.
      for (const d of pending.filter((m) => m.status !== "sent")) {
        const txn = await prisma.transaction.findFirst({ where: { businessId: pot.businessId, reference: d.reference }, select: { id: true, providerTxnId: true, fee: true } });
        if (txn) {
          const r = await prisma.savingsMovement.updateMany({
            where: { id: d.id, status: { in: ["initiated", "unknown", "needs_review"] } },
            data: { status: "sent", transactionId: txn.id, providerTransferId: txn.providerTxnId || undefined, fee: Number(txn.fee) || d.fee, error: null },
          });
          if (r.count === 1) { d.status = "sent"; d.transactionId = txn.id; d.providerTransferId = txn.providerTxnId || d.providerTransferId; stats.depositsSent++; }
        }
      }
      // 2b. PiggyVest's inflows settle "did the money arrive". Inflows already
      // booked as a movement (a deposit, interest, an outside deposit) are out
      // of the running before pairing, so an amount match can never claim a
      // transaction another row already owns.
      const inflows = await piggyvest.listCreditTransactions(pot.pvWalletId, { limit: 50 });
      const known = new Set(
        (await prisma.savingsMovement.findMany({ where: { pvTxnId: { in: inflows.map((i) => i.id) } }, select: { pvTxnId: true } })).map((r) => r.pvTxnId),
      );
      const fresh = inflows.filter((i) => !known.has(i.id));
      const { pairs, leftoverInflows } = savings.pairInflows(pending, fresh);
      const settled = new Set();
      for (const p of pairs) {
        const inflow = fresh.find((i) => i.id === p.inflowId);
        try {
          const r = await prisma.savingsMovement.updateMany({
            where: { id: p.depositId, status: { in: ["initiated", "sent", "unknown", "needs_review"] } },
            data: { status: "completed", pvTxnId: inflow.id, landedAmount: inflow.amount, completedAt: new Date(), error: null },
          });
          if (r.count === 1) {
            settled.add(p.depositId);
            stats.depositsCompleted++;
            const d = pending.find((m) => m.id === p.depositId);
            const biz = await prisma.business.findUnique({ where: { id: pot.businessId }, select: { userId: true, country: true } });
            await pushTo(biz?.userId, "Savings deposit arrived", `${formatAmountForBusiness(biz, d?.amount)} is now in "${pot.name}".`).catch(() => {});
          }
        } catch (e) {
          if (e.code !== "P2002") throw e; // that inflow settled another row between the read and the claim
        }
      }
      // 2c. What nothing settled: ask the bank about sent deposits, age out the
      // rest.
      const now = Date.now();
      for (const d of pending) {
        if (settled.has(d.id)) continue;
        const age = now - new Date(d.createdAt).getTime();
        if (d.status === "sent") {
          if (age > SENT_DEPOSIT_RECHECK_MS && d.providerTransferId) {
            // The bank bounced it and the webhook never came: Anchor's transfer
            // record is the truth. Only a definite failure moves the row.
            try {
              const t = await anchor.getTransfer(d.providerTransferId);
              if (t.status === "failed") {
                if (await savings.failDepositAtBank(d, { source: `reported ${t.rawStatus || "failed"} by the bank`, reason: t.reason })) stats.depositsFailed++;
                continue;
              }
            } catch (e) {
              if (e.code !== "ANCHOR_NOT_CONFIGURED") logger.warn?.(`[savings-reconcile] transfer check ${d.reference}: ${e.message}`);
            }
          }
          if (age > SENT_DEPOSIT_REVIEW_MS) {
            await fireAlert(`savings-deposit-stuck-${d.id}`, "Savings deposit left the bank but never arrived", `Deposit ${d.reference} (₦${d.amount}) debited the Anchor account ${Math.round(age / 3600000)}h ago and PiggyVest shows no inflow. Check both dashboards.`);
          }
        } else if (["initiated", "unknown"].includes(d.status) && age > UNKNOWN_DEPOSIT_REVIEW_MS) {
          const r = await prisma.savingsMovement.updateMany({ where: { id: d.id, status: { in: ["initiated", "unknown"] } }, data: { status: "needs_review", error: (d.error ? d.error + " · " : "") + "no bank record after 30 minutes" } });
          if (r.count === 1) {
            stats.depositsReviewed++;
            await fireAlert(`savings-deposit-review-${d.id}`, "Savings deposit needs review", `Deposit ${d.reference} (₦${d.amount}) for pot ${pot.id} has no Anchor row and no PiggyVest inflow after 30 minutes.`);
          }
        }
      }
      // 7. Whatever inflow is not one of our deposits: interest or an outside
      // deposit. Each partner transaction is booked once (pvTxnId unique). An
      // inflow that matches an open deposit's amount waits for that deposit
      // to be proven sent rather than being booked as somebody else's money.
      const openAmounts = new Set(pending.filter((m) => !settled.has(m.id) && m.status !== "needs_review").map((m) => toKobo(m.amount)));
      for (const inflow of leftoverInflows.filter((i) => i.amount > 0)) {
        const kind = savings.classifyUnattributedInflow(inflow);
        if (kind !== "interest" && openAmounts.has(toKobo(inflow.amount))) continue;
        try {
          await prisma.$transaction(async (px) => {
            await px.savingsMovement.create({
              data: {
                potId: pot.id, businessId: pot.businessId, userId: pot.userId, type: kind, backing: "piggyvest",
                amount: inflow.amount, status: "completed", reference: `kb_svi_${inflow.id}`.slice(0, 80), pvTxnId: inflow.id,
                narration: String(inflow.narration || "").slice(0, 200), completedAt: inflow.createdAt ? new Date(inflow.createdAt) : new Date(),
              },
            });
            if (kind === "interest") {
              await px.savingsPot.update({ where: { id: pot.id }, data: { interestEarned: { increment: inflow.amount } } });
            }
          });
          stats.strays++;
          const biz = await prisma.business.findUnique({ where: { id: pot.businessId }, select: { userId: true, country: true } });
          await pushTo(
            biz?.userId,
            kind === "interest" ? "Interest paid" : "Savings received",
            kind === "interest"
              ? `${formatAmountForBusiness(biz, inflow.amount)} interest was added to "${pot.name}".`
              : `${formatAmountForBusiness(biz, inflow.amount)} was paid into "${pot.name}".`,
          ).catch(() => {});
        } catch (e) {
          if (e.code !== "P2002") throw e;
        }
      }
      // 5. Wallet resync.
      const w = await piggyvest.getWallet(pot.pvWalletId);
      await prisma.savingsPot.updateMany({
        where: { id: pot.id, status: "active" },
        data: {
          balance: w.balance,
          interestRate: w.interestRate ?? pot.interestRate,
          ...(Number.isFinite(w.withdrawalCount) ? { withdrawalCountMonth: w.withdrawalCount, withdrawalMonth: savings.monthKey() } : {}),
        },
      });
      // 6. Interest accrued this month (hourly, or when asked about one wallet).
      if (full || walletId) {
        const start = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
        const rows = await piggyvest.getAccruedInterest(pot.pvWalletId, { from: start.toISOString().slice(0, 10) }).catch(() => []);
        const mtd = rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
        const rate = rows.length && rows[rows.length - 1].rate != null ? rows[rows.length - 1].rate : null;
        await prisma.savingsPot.updateMany({ where: { id: pot.id }, data: { interestAccruedMtd: Math.round(mtd * 100) / 100, ...(rate != null ? { interestRate: rate } : {}) } });
      }
    } catch (e) {
      if (isAuthError(e)) throw e;
      stats.errors++;
      logger.warn?.(`[savings-reconcile] pot ${pot.id}: ${e.message}`);
    }
  }

  // 3. Open withdrawals.
  if (pvOn) {
    const open = await prisma.savingsMovement.findMany({
      where: { type: "withdrawal", backing: "piggyvest", status: { in: ["processing", "unknown", "requested"] }, ...(walletId ? { pot: { pvWalletId: walletId } } : {}) },
      orderBy: { createdAt: "asc" },
      take: 100,
    });
    for (const m of open) {
      try {
        // A `requested` row means the process died between create and claim:
        // the partner call never ran. Fail it; the merchant can retry.
        if (m.status === "requested") {
          if (Date.now() - new Date(m.createdAt).getTime() > 5 * 60 * 1000) {
            await prisma.savingsMovement.updateMany({ where: { id: m.id, status: "requested" }, data: { status: "failed", error: "Withdrawal was never sent" } });
            stats.withdrawalsSettled++;
          }
          continue;
        }
        // Verify by our reference first; if PiggyVest keys the record by the
        // reference it gave back, try that before calling it missing.
        let verify = await piggyvest.verifyTransaction(m.reference);
        if (verify.status === "not_found" && m.pvReference && m.pvReference !== m.reference) {
          verify = await piggyvest.verifyTransaction(m.pvReference);
        }
        const next = await savings.applyWithdrawalOutcome(m, verify);
        if (next) {
          stats.withdrawalsSettled++;
          const pot = await prisma.savingsPot.findUnique({ where: { id: m.potId } });
          if (pot?.pvWalletId) {
            const w = await piggyvest.getWallet(pot.pvWalletId).catch(() => null);
            if (w) await prisma.savingsPot.updateMany({ where: { id: pot.id, status: "active" }, data: { balance: w.balance } });
          }
        } else if (Date.now() - new Date(m.createdAt).getTime() > WITHDRAWAL_STUCK_MS) {
          // Still open after an hour of pending/absent answers: say so once,
          // because the merchant sees only 409s until it settles.
          await fireAlert(`savings-withdrawal-stuck-${m.id}`, "Savings withdrawal still open after an hour", `Withdrawal ${m.reference} (₦${m.amount}) has been ${m.status} for over an hour (last verify: ${verify.status}). Check PiggyVest.`);
        }
      } catch (e) {
        if (isAuthError(e)) throw e;
        stats.errors++;
        logger.warn?.(`[savings-reconcile] withdrawal ${m.reference}: ${e.message}`);
      }
    }
    // 3b. Early-withdrawal fees the landing path did not sweep (a crash between
    // the landing and the sweep). collectBreakFee claims before it transfers,
    // so this can never charge twice.
    const uncollected = await prisma.savingsMovement.findMany({
      where: {
        type: "withdrawal", fee: { gt: 0 }, feeCollectedAt: null,
        OR: [{ backing: "ledger", status: "completed" }, { backing: "piggyvest", landedTransactionId: { not: null } }],
      },
      select: { id: true },
      take: 50,
    });
    for (const m of uncollected) {
      await savings.collectBreakFee(m.id).catch((e) => logger.warn?.(`[savings-reconcile] break fee ${m.id}: ${e.message}`));
    }
    // 4. Completed at PiggyVest, but the Anchor credit never showed up (or was
    // booked as plain income because nothing tied it to us). Alert; a human
    // matches it. Amount alone is never enough to re-tag a customer's payment.
    const unlanded = await prisma.savingsMovement.findMany({
      where: { type: "withdrawal", backing: "piggyvest", status: "completed", landedTransactionId: null, completedAt: { lt: new Date(Date.now() - UNLANDED_ALERT_MS) } },
      take: 50,
    });
    for (const m of unlanded) {
      await fireAlert(`savings-unlanded-${m.id}`, "Savings withdrawal has not landed", `Withdrawal ${m.reference} (₦${m.amount}) completed at PiggyVest over 2h ago and no Anchor credit was attributed to it. If it was booked as income, tag it by hand.`);
    }
  }

  // 8. Ledger integrity (hourly).
  if (full) {
    const ledgerPots = await prisma.savingsPot.findMany({ where: { backing: "ledger", status: "active" } });
    for (const pot of ledgerPots) {
      const agg = await prisma.savingsMovement.groupBy({ by: ["type"], where: { potId: pot.id, status: "completed" }, _sum: { amount: true } });
      const inK = toKobo(agg.find((a) => a.type === "deposit")?._sum.amount || 0) + toKobo(agg.find((a) => a.type === "external_deposit")?._sum.amount || 0) + toKobo(agg.find((a) => a.type === "interest")?._sum.amount || 0);
      const outK = toKobo(agg.find((a) => a.type === "withdrawal")?._sum.amount || 0);
      if (inK - outK !== toKobo(pot.balance)) {
        stats.drift++;
        await fireAlert(`savings-ledger-drift-${pot.id}`, "Savings pot balance drift", `Pot ${pot.id} (${pot.name}) balance ₦${pot.balance} but movements sum to ₦${(inK - outK) / 100}.`);
      }
    }
    const reserved = await prisma.savingsPot.groupBy({ by: ["businessId"], where: { backing: "ledger", status: "active" }, _sum: { balance: true } });
    for (const r of reserved.filter((x) => Number(x._sum.balance) > 0)) {
      const biz = await prisma.business.findUnique({ where: { id: r.businessId }, select: { id: true, name: true, anchorAccountId: true, providerAccountId: true, baseCurrency: true } });
      if (!biz?.anchorAccountId) continue;
      try {
        const { balance: gross } = await anchor.getAccountBalance(biz.anchorAccountId);
        if (Number(r._sum.balance) > gross + MONEY_EPS) {
          stats.overReserved++;
          await fireAlert(`savings-overreserved-${biz.id}`, "Savings reserve exceeds bank balance", `${biz.name}: ₦${r._sum.balance} set aside in pots but only ₦${gross} at the bank. Money left by a path the reserve did not gate, or the bank is behind.`);
          await audit({ action: "SAVINGS_OVERRESERVED", resourceType: "business", resourceId: biz.id, severity: "alert", metadata: { reserved: r._sum.balance, gross } });
        }
      } catch (e) {
        if (e.code === "ANCHOR_NOT_CONFIGURED") break;
        logger.warn?.(`[savings-reconcile] reserve check ${biz.id}: ${e.message}`);
      }
    }
    // 9. Closed PiggyVest pots that somehow hold money (a late inflow).
    if (pvOn) {
      const closed = await prisma.savingsPot.findMany({ where: { backing: "piggyvest", status: "closed", pvWalletId: { not: null } }, take: 100 });
      for (const pot of closed) {
        try {
          const w = await piggyvest.getWallet(pot.pvWalletId);
          if (toKobo(w.balance) > 0) {
            const r = await prisma.savingsPot.updateMany({ where: { id: pot.id, status: "closed" }, data: { status: "active", closedAt: null, balance: w.balance, error: "Reopened: the wallet still held money" } });
            if (r.count === 1) {
              stats.reopened++;
              await fireAlert(`savings-closed-balance-${pot.id}`, "Closed savings pot holds money", `Pot ${pot.id} (${pot.name}) was closed but its PiggyVest wallet holds ₦${w.balance}. Reopened so the merchant can withdraw it.`);
              await pushTo(pot.userId, "Savings pot reopened", `"${pot.name}" still had ${formatAmountForBusiness({ country: "NG" }, w.balance)} in it, so it is open again.`).catch(() => {});
            }
          }
        } catch (e) {
          if (isAuthError(e)) throw e;
          logger.warn?.(`[savings-reconcile] closed pot ${pot.id}: ${e.message}`);
        }
      }
    }
  }
  return stats;
}

let tickCount = 0;
function startSavingsReconcileLoop(intervalMs = 5 * 60 * 1000) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await prisma.withCronLock(SAVINGS_RECONCILE_LOCK, async () => {
        const { recordHeartbeat } = require("./snapshots");
        const full = tickCount % 12 === 0; // hourly at a 5-minute cadence
        tickCount++;
        try {
          const s = await reconcileSavings({ full });
          await recordHeartbeat("savings-reconcile", "ok").catch(() => {});
          if (Object.values(s).some((v) => v > 0)) console.log(`[savings-reconcile] ${JSON.stringify(s)}`);
        } catch (e) {
          if (isAuthError(e)) {
            // A dead credential settles nothing. The "error" beat keeps the
            // reason on the health page (healthCheck treats an error status as
            // stale) and the alert pages once an hour.
            await recordHeartbeat("savings-reconcile", "error", `PiggyVest HTTP ${e.status}`).catch(() => {});
            fireAlert("savings-pvb-auth", "PiggyVest credentials rejected", `PiggyVest returned HTTP ${e.status} (${e.message}). Savings deposits and withdrawals will not settle until PVB_SECRET_KEY on Render is fixed.`).catch(() => {});
            return;
          }
          throw e;
        }
      });
    } catch (e) {
      console.error("[savings-reconcile] tick error:", e.message);
      require("./snapshots").recordHeartbeat("savings-reconcile", "error", String(e.message || "").slice(0, 200)).catch(() => {});
    } finally {
      running = false;
    }
  };
  const t = setInterval(tick, intervalMs);
  setTimeout(tick, 45 * 1000); // first pass shortly after boot, after Anchor's
  return () => clearInterval(t);
}

module.exports = { reconcileSavings, startSavingsReconcileLoop, SAVINGS_RECONCILE_LOCK };
