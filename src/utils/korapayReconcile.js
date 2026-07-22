// Korapay reconcile — the durability net for money-in AND money-out, now that
// Korapay is the sole active provider. The webhook (routes/korapay.js) is the
// primary path but a single point of failure: it acks 200 BEFORE processing, so a
// post-ack throw (or a dropped/undelivered event, or a deploy-window outage) loses
// the update with no automatic catch-up. This periodically polls Korapay's own
// feeds and backfills anything the webhook missed.
//
// Grounded in SANDBOX-VERIFIED shapes (2026-07-22), not guesses:
//   money-in : GET /pay-ins (list: reference/status/amount/payment_method) →
//              GET /charges/{reference} (detail incl. virtual_bank_account.account_number)
//   money-out: GET /payouts (list: reference/status) + getPayout(reference) (metadata)
//
// Safe by construction (same guarantees as fincraReconcile):
//   • idempotent — recordFincraInboundCredit + the reversal/backfill are gated by
//     Transaction @@unique([businessId, reference]); can never double-credit/double-reverse.
//   • conservative — only EXPLICIT success/failed statuses act; unknown/pending skipped.
//   • attributable-only on money-out — touches only payouts we booked (ref kbtf_*).
//   • leader-elected — withCronLock(4011) so one instance reconciles per tick.
const prisma = require("./db");
const korapay = require("../services/korapay");
const { recordFincraInboundCredit } = require("./fincraCredit");
const { recordFincraPayoutOutcome, backfillFincraPayout } = require("./fincraPayout");

const PAYOUT_SUCCESS = new Set(["success", "successful", "completed", "paid", "processed"]);
const PAYOUT_FAIL = new Set(["failed", "reversed", "declined", "cancelled", "returned", "expired"]);
const KORAPAY_RECONCILE_LOCK = 4011; // 4001-4010 taken; see server.js lock map

// Korapay dates look like "2026-07-22 00:59:09" (space, UTC) — parse defensively.
function toMs(s) {
  if (!s) return 0;
  const t = new Date(String(s).replace(" ", "T") + (String(s).includes("T") ? "" : "Z")).getTime();
  return Number.isNaN(t) ? 0 : t;
}

// MONEY-IN: backfill any successful VA pay-in the webhook never recorded. The list
// lacks the account_number, so for each UNRECORDED success we fetch the full charge
// (which carries virtual_bank_account.account_number) and hand it to the shared
// recorder — the exact same object shape the webhook passes, so dedup is identical.
async function reconcileKorapayPayins({ perPage = 50, lookbackMs = 48 * 60 * 60 * 1000, maxPages = 50, logger = console } = {}) {
  let scanned = 0, backfilled = 0;
  const cutoff = Date.now() - lookbackMs;
  for (let page = 1; page <= maxPages; page++) {
    let res;
    try { res = await korapay.listPayins({ page, limit: perPage }); }
    catch (e) { logger.warn?.(`[korapay-reconcile] pay-ins list failed: ${e.message}`); break; }
    const items = res?.data?.payins || [];
    if (!items.length) break;
    for (const p of items) {
      scanned++;
      const status = String(p.status || "").toLowerCase();
      if (status !== "success" && status !== "successful") continue; // explicit success only
      if (p.payment_method && p.payment_method !== "virtual_bank_account") continue; // VA credits only
      const ref = p.reference;
      if (!ref) continue;
      // Cheap dedup: skip the detail fetch if we already booked this reference.
      const seen = await prisma.transaction.findFirst({
        where: { source: "korapay", reference: String(ref) }, select: { id: true },
      });
      if (seen) continue;
      let charge;
      try { const cr = await korapay.getCharge(ref); charge = cr?.data; }
      catch (e) { logger.warn?.(`[korapay-reconcile] charge fetch failed ref=${ref}: ${e.message}`); continue; }
      if (!charge) continue;
      try {
        const r = await recordFincraInboundCredit(charge, "korapay");
        if (r.recorded) { backfilled++; logger.log?.(`[korapay-reconcile] backfilled credit ref=${ref} biz=${r.businessId}`); }
      } catch (e) {
        logger.warn?.(`[korapay-reconcile] record failed ref=${ref}: ${e.message}`);
      }
    }
    // Feed is newest-first; stop once there's no more or we've paged past the window.
    const oldestMs = toMs(items[items.length - 1]?.date_created);
    if (!res?.data?.has_more || (oldestMs && oldestMs < cutoff)) break;
  }
  return { scanned, backfilled };
}

// MONEY-OUT: reconcile our booked payouts against Korapay's authoritative status.
// Only touches payouts we can attribute (reference kbtf_*, from executeKorapayPayout):
//   • FAILED  + we booked the expense → reverse (money never left). Idempotent.
//   • SUCCESS + no expense (orphan)   → backfill (a send whose booking we lost); the
//     businessId rides in the payout metadata, so fetch the detail for it.
//   • processing / pending / unknown  → leave alone.
async function reconcileKorapayPayouts({ perPage = 50, lookbackMs = 48 * 60 * 60 * 1000, maxPages = 50, logger = console } = {}) {
  let scanned = 0, reversed = 0, backfilled = 0;
  const cutoff = Date.now() - lookbackMs;
  for (let page = 1; page <= maxPages; page++) {
    let res;
    try { res = await korapay.listPayouts({ page, limit: perPage }); }
    catch (e) { logger.warn?.(`[korapay-reconcile] payouts list failed: ${e.message}`); break; }
    const items = res?.data?.payouts || [];
    if (!items.length) break;
    for (const p of items) {
      scanned++;
      const ref = p.reference;
      if (!ref || !String(ref).startsWith("kbtf_")) continue; // our attributable payout only
      const status = String(p.status || "").toLowerCase();
      const expense = await prisma.transaction.findFirst({
        where: { source: "korapay", type: "expense", reference: String(ref) },
      });
      if (PAYOUT_FAIL.has(status) && expense) {
        const r = await recordFincraPayoutOutcome({ reference: ref }, "failed", "korapay");
        if (r.handled && r.outcome === "failed") { reversed++; logger.log?.(`[korapay-reconcile] reversed failed payout ref=${ref} biz=${r.businessId}`); }
      } else if (PAYOUT_SUCCESS.has(status) && !expense) {
        // Orphaned success — the businessId is only in the payout metadata; fetch it.
        let meta = null;
        try { const d = await korapay.getPayout(ref); meta = d?.data; } catch { /* leave meta null */ }
        const bizId = meta?.metadata?.business_id || meta?.metadata?.businessId || null;
        const r = await backfillFincraPayout({
          reference: ref, amount: p.amount, currency: p.currency,
          beneficiaryName: p.customer_name || meta?.customer?.name, source: "korapay", bizId,
        });
        if (r.handled) { backfilled++; logger.log?.(`[korapay-reconcile] backfilled payout ref=${ref} biz=${r.businessId} amount=${r.amount}`); }
      }
      // else: not final (processing/pending) or nothing of ours to do → skip
    }
    const oldestMs = toMs(items[items.length - 1]?.date_created || items[items.length - 1]?.completion_date);
    if (!res?.data?.has_more || (oldestMs && oldestMs < cutoff)) break;
  }
  return { scanned, reversed, backfilled };
}

// Start the periodic reconcile. Returns a stopper. No-op if Korapay isn't configured.
function startKorapayReconcileLoop(intervalMs = 5 * 60 * 1000) {
  if (!korapay.isConfigured()) {
    console.warn("[korapay-reconcile] skipped: Korapay not configured");
    return () => {};
  }
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const total = await prisma.withCronLock(KORAPAY_RECONCILE_LOCK, async () => {
        await require("./snapshots").recordHeartbeat("korapay-reconcile").catch(() => {});
        const credits = await reconcileKorapayPayins();
        const payouts = await reconcileKorapayPayouts();
        return { credits, payouts };
      });
      const c = total?.credits, p = total?.payouts;
      if (c?.backfilled || p?.reversed || p?.backfilled) {
        console.log(`[korapay-reconcile] credits backfilled=${c.backfilled}; payouts reversed=${p.reversed} backfilled=${p.backfilled}`);
      }
    } catch (e) {
      console.error("[korapay-reconcile] tick error:", e.message);
    } finally {
      running = false;
    }
  };
  const id = setInterval(tick, intervalMs);
  tick(); // run once at boot to backfill anything missed during the deploy window
  return () => clearInterval(id);
}

module.exports = { reconcileKorapayPayins, reconcileKorapayPayouts, startKorapayReconcileLoop };
