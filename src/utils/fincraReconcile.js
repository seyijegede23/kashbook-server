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
const { recordFincraPayoutOutcome, backfillFincraPayout } = require("./fincraPayout");

const SUCCESS = new Set(["successful", "success", "approved", "completed", "paid", "received"]);
const PAYOUT_SUCCESS = new Set(["successful", "success", "completed", "paid", "approved"]);
const PAYOUT_FAIL = new Set(["failed", "reversed", "declined", "cancelled", "returned"]);
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

// Reconcile OUTBOUND payouts against Fincra's authoritative status — the money-out
// durability net. Only touches payouts we can ATTRIBUTE (customerReference of the
// form kb_tf_<bizId>_…, written by executeFincraPayout):
//   • Fincra FAILED  + we booked it  → reverse (money never left). Idempotent.
//   • Fincra SUCCESS + no expense    → backfill (a send whose booking we lost to a
//     timeout; the money DID leave). Attributed to the bizId in the ref.
//   • Fincra SUCCESS + we have it, or still processing → leave alone.
// Bounded by TIME, not a fixed item count: because Fincra's payout feed is
// merchant-wide (pooled across all businesses), a fixed page cap could let an
// orphaned success sink past the window under load and never get backfilled. We
// page (newest-first) until an item is older than the look-back, so every recent
// payout is covered regardless of merchant-wide volume. maxPages is a runaway cap.
async function reconcileFincraPayouts({ perPage = 100, lookbackMs = 48 * 60 * 60 * 1000, maxPages = 100, logger = console } = {}) {
  let scanned = 0, reversed = 0, backfilled = 0;
  const cutoff = Date.now() - lookbackMs;
  let cursor;
  let page = 0;
  for (; page < maxPages; page++) {
    let res;
    try { res = await fincra.listPayouts({ perPage, cursor }); }
    catch (e) { logger.warn?.(`[fincra-reconcile] payouts list failed: ${e.message}`); break; }
    const items = res?.data?.results || (Array.isArray(res?.data) ? res.data : []);
    if (!items.length) break;
    for (const p of items) {
      scanned++;
      const ref = p.customerReference;
      if (!ref || !String(ref).startsWith("kb_tf_")) continue; // not our attributable payout
      const status = String(p.status || "").toLowerCase();
      const expense = await prisma.transaction.findFirst({
        where: { source: "fincra", type: "expense", reference: String(ref) },
      });

      if (PAYOUT_SUCCESS.has(status) && !expense) {
        // Orphaned success — book the send we lost (money left the pooled wallet).
        const r = await backfillFincraPayout({
          reference: ref, amount: p.amountSent || p.amount, currency: p.sourceCurrency, beneficiaryName: p.beneficiaryName,
        });
        if (r.handled) { backfilled++; logger.log?.(`[fincra-reconcile] backfilled payout ref=${ref} biz=${r.businessId} amount=${r.amount}`); }
      } else if (PAYOUT_FAIL.has(status) && expense) {
        // We booked it but Fincra failed it — reverse (idempotent via :reversal ref).
        const r = await recordFincraPayoutOutcome({ customerReference: ref }, "failed");
        if (r.handled && r.outcome === "failed") { reversed++; logger.log?.(`[fincra-reconcile] reversed failed payout ref=${ref} biz=${r.businessId}`); }
      }
      // processing / pending / unknown → not final, leave alone
    }
    // Stop once we've paged back past the look-back window (feed is newest-first).
    const oldest = items[items.length - 1]?.createdAt;
    const oldestMs = oldest ? new Date(oldest).getTime() : 0;
    cursor = res?.data?.nextCursor;
    if (!cursor || (oldestMs && oldestMs < cutoff)) break;
  }
  if (page >= maxPages) logger.warn?.(`[fincra-reconcile] payout scan hit maxPages=${maxPages} (${scanned} scanned) — some older payouts may be uncovered; raise the cap`);
  return { scanned, reversed, backfilled };
}

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
        const payouts = await reconcileFincraPayouts();
        return { credits, payouts };
      });
      const c = total?.credits, p = total?.payouts;
      if (c?.backfilled || p?.reversed || p?.backfilled) {
        console.log(`[fincra-reconcile] credits backfilled=${c.backfilled}; payouts reversed=${p.reversed} backfilled=${p.backfilled}`);
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

module.exports = { reconcileFincraCollections, reconcileFincraPayouts, startFincraReconcileLoop };
