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

// ── Account-request lifecycle ────────────────────────────────────────────────
// The webhook is the primary channel for virtualaccount.approved / issued /
// declined, and it is not enough on its own: on 2026-09-12 Fincra's dashboard
// showed the first live EUR request DECLINED while our row still read
// "pending", because no webhook ever arrived (none has, ever, as of that day).
// A merchant would have waited on "In progress" forever with no reason shown.
//
// So every tick also asks Fincra directly for each request we still consider
// open and applies whatever it says, through the SAME handleEvent the webhook
// uses, so the two paths cannot drift. It only acts on a real change, so a
// webhook that does arrive later is a harmless no-op, and nobody gets pushed
// twice.

// Pure: given our row and Fincra's GET /profile/virtual-accounts/:id record,
// which lifecycle event (if any) should be applied. Exported for tests.
function decideAccountTransition(fa, d = {}) {
  const status = String(d.status || "").toLowerCase();
  const info = d.accountInformation || {};
  const hasDetails = !!(info.accountNumber || info.otherInfo?.accountNumber || info.otherInfo?.iban || d.accountNumber);
  const issued = d.isActive === true || (status === "approved" && hasDetails);
  if (["declined", "rejected"].includes(status)) return fa.status === "declined" ? null : "account_declined";
  if (status === "closed") return fa.status === "closed" ? null : "account_closed";
  if (issued) return fa.status === "issued" ? null : "account_issued";
  if (status === "approved") return fa.status === "pending" ? "account_approved" : null;
  return null;
}

// Fincra spells the decline reason inconsistently across payloads; take the
// first non-empty of the spellings seen or documented.
function declineReasonOf(d = {}) {
  for (const k of ["reason", "declineReason", "rejectionReason", "declinedReason", "comment", "note", "message"]) {
    const v = d[k];
    if (v && typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

async function reconcileFincraAccountRequests({ logger = console } = {}) {
  const { handleEvent } = require("../routes/fincra");
  const rows = await prisma.foreignAccount.findMany({
    where: { status: { in: ["pending", "approved"] }, fincraRequestId: { not: null } },
    select: { id: true, status: true, currency: true, fincraRequestId: true, fincraAccountId: true },
    take: 50,
  });
  let checked = 0, changed = 0;
  for (const fa of rows) {
    let res;
    try {
      res = await fincra.getVirtualAccount(fa.fincraAccountId || fa.fincraRequestId);
    } catch (e) {
      logger.warn?.(`[fincra-reconcile] account ${fa.currency} ${fa.id.slice(0, 8)}: status fetch failed HTTP ${e.status ?? "n/a"} ${e.message}`);
      continue;
    }
    checked++;
    const d = (res && res.data) || res || {};
    const kind = decideAccountTransition(fa, d);
    if (!kind) continue;
    // Guarantee findForeignAccount lands on OUR row whatever id Fincra echoes.
    const data = { ...d, _id: d._id || d.id || fa.fincraRequestId, reference: fa.fincraRequestId, reason: declineReasonOf(d) };
    if (kind === "account_declined" && !data.reason) {
      // Learn the shape rather than guess at it: keys only, no values.
      logger.warn?.(`[fincra-reconcile] declined with no reason field; keys=${Object.keys(d).join(",")}`);
    }
    await handleEvent({ kind, event: `poll:${kind}`, data });
    changed++;
    logger.log?.(`[fincra-reconcile] account ${fa.currency} ${fa.id.slice(0, 8)}: ${fa.status} → ${kind.replace("account_", "")} (polled; no webhook)` + (data.reason ? ` reason="${data.reason.slice(0, 160)}"` : ""));
  }
  return { checked, changed };
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
        // Open account requests, checked against Fincra directly. The webhook
        // has never delivered a lifecycle event to us; this is what moves a row
        // off "pending" when Fincra decides.
        const accounts = await reconcileFincraAccountRequests().catch((e) => {
          console.error("[fincra-reconcile] account requests:", e.message);
          return { checked: 0, changed: 0 };
        });
        return { credits, conversions, accounts };
      });
      const c = total?.credits, v = total?.conversions, a = total?.accounts;
      if (c?.backfilled || v?.retried || v?.flagged || a?.changed) {
        console.log(
          `[fincra-reconcile] credits backfilled=${c?.backfilled || 0}; ` +
          `conversions retried=${v?.retried || 0} completed=${v?.completed || 0} flagged=${v?.flagged || 0}; ` +
          `account requests changed=${a?.changed || 0} of ${a?.checked || 0}`,
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

module.exports = {
  reconcileFincraCollections,
  reconcileFincraAccountRequests,
  decideAccountTransition,
  declineReasonOf,
  startFincraReconcileLoop,
};
