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
const { fireAlert } = require("./alerts");

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
    // Say WHAT failed, not just Fincra's one-word message. "Unauthorized" on its
    // own cost an afternoon on 2026-09-10: it is the API gateway rejecting the
    // api-key itself, which a sandbox key against the live host produces
    // byte-for-byte, and nothing in the old line said status, host or cause.
    let host = "?";
    try { host = new URL(process.env.FINCRA_BASE_URL || "https://sandboxapi.fincra.com").hostname; } catch { /* keep ? */ }
    const auth = e.status === 401 || e.status === 403;
    logger.warn?.(
      `[fincra-reconcile] list failed: HTTP ${e.status ?? "n/a"} ${e.errorType || ""} "${e.message}" host=${host}` +
      (auth
        ? " — the api-key was rejected by this host. Check FINCRA_SECRET_KEY / FINCRA_PUBLIC_KEY / FINCRA_BUSINESS_ID on Render are the LIVE values for api.fincra.com (a sandbox key returns exactly this; an IP block would say ACCESS_DENIED instead)."
        : ""),
    );
    if (auth) {
      // fireAlert dedups per key for an hour, so this pages once, not every 5 min.
      fireAlert("fincra-auth", "Fincra credentials rejected",
        `GET /collections on ${host} returned HTTP ${e.status} (${e.message}). EUR inbound reconcile is dead and every EUR account request will fail until the keys are fixed.`,
      ).catch(() => {});
    }
    return { scanned, backfilled, error: `HTTP ${e.status ?? "n/a"} ${e.message}`.trim() };
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
        const credits = await reconcileFincraCollections();
        const { recordHeartbeat } = require("./snapshots");
        if (credits.error) {
          // The heartbeat records the FAILURE. It used to be written "ok" before
          // the call, so the health page showed a healthy cron through hours of
          // 401s. With no "ok" beat the existing cron_stale rule fires in ~10
          // minutes, and lastError carries the reason.
          await recordHeartbeat("fincra-reconcile", "error", credits.error).catch(() => {});
          // Nothing else runs on a dead credential. Retrying payouts now would
          // read "cannot list payouts" as "no payout exists" and pay again.
          return { credits, conversions: null };
        }
        await recordHeartbeat("fincra-reconcile", "ok").catch(() => {});
        // Euro conversions whose naira payout did not complete (a crash or a
        // Fincra error between "converted" and "paid"). The merchant's euros are
        // already gone from their balance at that point, so this is the net that
        // guarantees the naira still arrives. Idempotent by customerReference.
        const conversions = await require("./fcyConversion").retryStuckConversions();
        return { credits, conversions };
      });
      const c = total?.credits, v = total?.conversions;
      if (c?.backfilled || v?.retried || v?.flagged) {
        console.log(
          `[fincra-reconcile] credits backfilled=${c?.backfilled || 0}; ` +
          `conversions retried=${v?.retried || 0} completed=${v?.completed || 0} flagged=${v?.flagged || 0}`,
        );
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
