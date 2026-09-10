// Fincra inbound-credit reconcile — the durability net for money-in. A webhook is
// a single point of failure: if Fincra ever fails to deliver a collection.successful
// (or we 500 on it), that credit is silently lost. This periodically polls Fincra's
// /collections feed and backfills any successful collection we never recorded.
//
// Safe by construction:
//   • idempotent — recordFincraInboundCredit is gated by Transaction
//     @@unique([businessId, reference]), so it can never double-credit a webhook.
//   • conservative — only collections with an EXPLICIT success status are recorded;
//     unknown/pending/failed are skipped (never book phantom income).
//   • leader-elected — withCronLock so only one instance reconciles per tick.
//
// ⚠️ The collection item shape (status field name, account/amount paths) is
// confirmed against a REAL collection when the first one lands (the webhook probe
// prints its keys). recordFincraInboundCredit already extracts fields multi-path.
const prisma = require("./db");
const fincra = require("../services/fincra");
const { recordFincraInboundCredit } = require("./fincraCredit");

const SUCCESS = new Set(["successful", "success", "completed", "paid", "received"]);
// "approved" is DELIBERATELY absent. Fincra uses it to mean "accepted for
// processing" (see virtualaccount.approved), not "settled". Treating it as
// success would book money that has not actually landed.
//
// The PAYOUT half of this module was removed on 2026-09-09. Fincra is
// receive-only (providers/index.js), so there is no KashBook payout for it to
// reconcile, and the code it depended on — backfillFincraPayout — computed a fee
// with computeFincraTransferFee, which no longer exists in config/fees.js. It
// would have thrown the first time it ran, on a money path. Restoring a send
// path means restoring that fee function too; see branch backup/fincra-2026-08-27.
const FINCRA_RECONCILE_LOCK = 4005;

// One /collections call returns collections across all currencies (each item
// carries its own currency, which recordFincraInboundCredit reads). Status isn't
// a server filter, so we filter to explicit successes client-side.
async function reconcileFincraCollections({ perPage = 50, logger = console } = {}) {
  let scanned = 0;
  let backfilled = 0;
  let res;
  try {
    res = await fincra.listCollections({ perPage });
  } catch (e) {
    logger.warn?.(`[fincra-reconcile] list failed: ${e.message}`);
    return { scanned, backfilled };
  }
  const items = res?.data?.results || (Array.isArray(res?.data) ? res.data : []);
  for (const item of items) {
    scanned++;
    const status = String(item.status || item.transactionStatus || "").toLowerCase();
    if (!SUCCESS.has(status)) continue; // only explicit successes; unknown → skip (safe)
    try {
      const r = await recordFincraInboundCredit(item);
      if (r.recorded) {
        backfilled++;
        logger.log?.(`[fincra-reconcile] backfilled credit ref=${item.reference || item.id} biz=${r.businessId}`);
      }
    } catch (e) {
      logger.warn?.(`[fincra-reconcile] record failed for ref=${item.reference || item.id}: ${e.message}`);
    }
  }
  return { scanned, backfilled };
}

// The outbound-payout reconciler lived here. It was removed on 2026-09-09 with
// the rest of the send path: Fincra now issues EUR receive accounts only, so
// there is no KashBook payout to reconcile, and every branch of it was
// unreachable. It is NOT commented out on purpose — dead money-out code that
// still compiles is how a payout gets booked by accident. Recover it from
// branch backup/fincra-2026-08-27 if a send path is ever added, and restore
// computeFincraTransferFee alongside it.

// Start the periodic reconcile. Returns a stopper. No-op if Fincra isn't configured.
function startFincraReconcileLoop(intervalMs = 5 * 60 * 1000) {
  if (!fincra.isConfigured()) {
    console.warn("[fincra-reconcile] skipped: Fincra not configured");
    return () => {};
  }
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const total = await prisma.withCronLock(FINCRA_RECONCILE_LOCK, async () => {
        await require("./snapshots").recordHeartbeat("fincra-reconcile").catch(() => {});
        const credits = await reconcileFincraCollections();
        return { credits };
      });
      const c = total?.credits;
      if (c?.backfilled) {
        console.log(`[fincra-reconcile] credits backfilled=${c.backfilled}`);
      }
    } catch (e) {
      console.error("[fincra-reconcile] tick error:", e.message);
    } finally {
      running = false;
    }
  };
  const id = setInterval(tick, intervalMs);
  tick(); // run once at boot to backfill anything missed during the deploy window
  return () => clearInterval(id);
}

module.exports = { reconcileFincraCollections, startFincraReconcileLoop };
