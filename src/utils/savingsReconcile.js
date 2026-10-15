// Savings integrity loop: the checks that keep the reserve honest.
//
// Runs every 30 minutes under withCronLock(4014), heartbeat "savings-reconcile".
//   1. fees           a deposit or early-withdrawal fee still waiting (the
//                     money not set aside did not cover it yet) or one a crash
//                     left behind is swept, least recently tried first, each
//                     under its business's lock (collectSavingsFee claims before it
//                     transfers, so never twice); an account under review or
//                     closed is left out, and a fee that still waits goes to
//                     the back of the queue, so no business holds up another
//   2. pot drift      each open pot's balance equals the sum of its movements,
//                     to the kobo, or an alert fires
//   3. over-reserve   a business with more set aside than the bank holds means
//                     money left by a path the reserve did not gate, or the
//                     bank is behind; either way a human should look
const prisma = require("./db");
const anchor = require("./anchor");
const savings = require("./savings");
const { fireAlert } = require("./alerts");
const { audit } = require("./audit");
const { toKobo } = require("./money");
const { MONEY_EPS } = require("../config/fees");

const SAVINGS_RECONCILE_LOCK = 4014;

async function reconcileSavings({ logger = console } = {}) {
  const stats = { feesCollected: 0, feesDeferred: 0, drift: 0, overReserved: 0, errors: 0 };

  // 1. Fees the deposit or withdrawal could not sweep: one at a time, 50 a
  // tick, each under the same business lock they sweep under, so the spendable
  // figure the sweep reads cannot change before the transfer. Only accounts
  // that are active: a frozen or closed account moves no money (collectSavingsFee
  // checks again under the lock, for a freeze that lands meanwhile). The least
  // recently tried come first, and every fee looked at that still waits goes
  // to the back (savings.requeueSavingsFees), so fees that cannot be swept for a
  // long while never keep newer ones, of any business, out of the 50. A
  // business whose fee waits is not read again this tick: one bank read each.
  const uncollected = await prisma.savingsMovement.findMany({
    where: {
      type: { in: ["deposit", "withdrawal"] }, status: "completed", fee: { gt: 0 }, feeCollectedAt: null,
      business: { accountStatus: "active", user: { accountStatus: "active" } },
    },
    select: { id: true, businessId: true },
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    take: 50,
  });
  const waitingBusinesses = new Set();
  const stillWaiting = [];
  for (const m of uncollected) {
    if (waitingBusinesses.has(m.businessId)) {
      stats.feesDeferred++;
      stillWaiting.push(m.id);
      continue;
    }
    try {
      const outcome = await prisma.withBusinessLock(m.businessId, () => savings.collectSavingsFee(m.id));
      if (outcome === "collected") stats.feesCollected++;
      else stillWaiting.push(m.id);
      if (outcome === "deferred") {
        stats.feesDeferred++;
        waitingBusinesses.add(m.businessId);
      }
      // A failed sweep stays claimed and has already alerted a human.
      else if (outcome === "failed") stats.errors++;
    } catch (e) {
      stats.errors++;
      stillWaiting.push(m.id);
      logger.warn?.(`[savings-reconcile] fee ${m.id}: ${e.message}`);
    }
  }
  try { await savings.requeueSavingsFees(stillWaiting); }
  catch (e) { stats.errors++; logger.warn?.(`[savings-reconcile] requeue: ${e.message}`); }

  // 2. Pot balance vs its movements.
  const pots = await prisma.savingsPot.findMany({ where: { status: "active" } });
  for (const pot of pots) {
    const agg = await prisma.savingsMovement.groupBy({ by: ["type"], where: { potId: pot.id, status: "completed" }, _sum: { amount: true } });
    const inK = toKobo(agg.find((a) => a.type === "deposit")?._sum.amount || 0);
    const outK = toKobo(agg.find((a) => a.type === "withdrawal")?._sum.amount || 0);
    if (inK - outK !== toKobo(pot.balance)) {
      stats.drift++;
      await fireAlert(`savings-ledger-drift-${pot.id}`, "Savings pot balance drift", `Pot ${pot.id} (${pot.name}) balance ₦${pot.balance} but movements sum to ₦${(inK - outK) / 100}.`);
    }
  }

  // 3. Reserve vs the bank.
  const reserved = await prisma.savingsPot.groupBy({ by: ["businessId"], where: { status: "active" }, _sum: { balance: true } });
  for (const r of reserved.filter((x) => Number(x._sum.balance) > 0)) {
    const biz = await prisma.business.findUnique({ where: { id: r.businessId }, select: { id: true, name: true, anchorAccountId: true } });
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
      stats.errors++;
      logger.warn?.(`[savings-reconcile] reserve check ${biz.id}: ${e.message}`);
    }
  }
  return stats;
}

function startSavingsReconcileLoop(intervalMs = 30 * 60 * 1000) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await prisma.withCronLock(SAVINGS_RECONCILE_LOCK, async () => {
        const { recordHeartbeat } = require("./snapshots");
        const s = await reconcileSavings();
        await recordHeartbeat("savings-reconcile", "ok").catch(() => {});
        if (Object.values(s).some((v) => v > 0)) console.log(`[savings-reconcile] ${JSON.stringify(s)}`);
      });
    } catch (e) {
      console.error("[savings-reconcile] tick error:", e.message);
      require("./snapshots").recordHeartbeat("savings-reconcile", "error", String(e.message || "").slice(0, 200)).catch(() => {});
    } finally {
      running = false;
    }
  };
  const t = setInterval(tick, intervalMs);
  setTimeout(tick, 60 * 1000); // first pass a minute after boot
  return () => clearInterval(t);
}

module.exports = { reconcileSavings, startSavingsReconcileLoop, SAVINGS_RECONCILE_LOCK };
