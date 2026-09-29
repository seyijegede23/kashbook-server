// PiggyVest Business webhook — fail-closed HMAC-SHA512 verify (header
// x-pvb-signature, keyed with the API secret), dedup on eventId via
// ProcessedWebhook, then a NUDGE: the payload only says which wallet or
// movement to re-check. Every money decision is a GET with our own key,
// because their eventData shapes are undocumented and a payload is not proof.
//
// Mounted at POST /webhooks/piggyvest with express.raw BEFORE express.json so
// the HMAC runs over the exact bytes. They also require the URL to answer GET
// with 200 when the webhook is registered.
const express = require("express");
const router = express.Router();
const prisma = require("../utils/db");
const piggyvest = require("../services/piggyvest");
const savings = require("../utils/savings");

router.get("/", (_req, res) => res.status(200).json({ ok: true }));

router.post("/", async (req, res) => {
  const raw = Buffer.isBuffer(req.body)
    ? req.body
    : Buffer.from(typeof req.body === "string" ? req.body : JSON.stringify(req.body || {}), "utf8");

  const header = req.headers["x-pvb-signature"] || req.headers["x-pvb-signature".toLowerCase()];
  const bypass = process.env.PVB_VERIFY_WEBHOOK === "false" && process.env.NODE_ENV !== "production";
  if (!bypass && !piggyvest.verifyWebhookSignature(raw, header)) {
    return res.status(401).json({ error: "invalid signature" });
  }

  let evt;
  try { evt = JSON.parse(raw.toString("utf8")); } catch { return res.status(400).json({ error: "invalid json" }); }
  if (process.env.PVB_WEBHOOK_DEBUG === "true") {
    // Learn the shapes from real events. Keys and ids only, never amounts or
    // account numbers, so the log stays safe to read.
    try { console.log(`[piggyvest webhook] ${evt.eventType || evt.event || "?"} keys=${Object.keys(evt.eventData || evt.data || {}).join(",")} wallet=${evt.pvb_wallet || evt.wallet_id || "?"} id=${evt.eventId || "?"}`); } catch { /* noop */ }
  }

  // Ack fast; process after responding.
  res.status(200).json({ received: true });

  const eventId = evt.eventId || evt.event_id || evt.id || null;
  const dedupKey = eventId ? `pvb:${eventId}` : null;
  try {
    if (dedupKey) {
      const seen = await prisma.processedWebhook.findFirst({ where: { eventId: dedupKey } });
      if (seen) return;
    }
    await handleEvent(evt);
    // The marker is written only AFTER handling succeeds, so a transient
    // failure leaves no marker and a redelivery gets to retry. Handlers are
    // idempotent (guarded claims + unique keys), so a double run is harmless.
    if (dedupKey) {
      await prisma.processedWebhook.create({ data: { eventId: dedupKey, type: String(evt.eventType || evt.event || "").slice(0, 80) } })
        .catch((e) => { if (e.code !== "P2002") throw e; });
    }
  } catch (e) {
    console.error("[piggyvest webhook]", evt?.eventType, e.message);
  }
});

function walletIdOf(evt) {
  const d = evt.eventData || evt.data || {};
  return String(evt.pvb_wallet || evt.wallet_id || d.wallet_id || d.walletId || d.wallet || d.source || d.id || "").trim() || null;
}

async function handleEvent(evt) {
  const type = String(evt.eventType || evt.event || "").toLowerCase();
  const d = evt.eventData || evt.data || {};
  const { reconcileSavings } = require("../utils/savingsReconcile");

  if (type === "create-wallet.success" || type === "reserve_virtual_account.success" || type === "reserve-virtual-account.success") {
    const walletId = walletIdOf(evt);
    if (!walletId) return;
    const pot = await prisma.savingsPot.findUnique({ where: { pvWalletId: walletId } });
    if (pot) await savings.activatePot(pot);
    return;
  }

  if (type.startsWith("bank-transfer.outflow")) {
    // Our reference is echoed; the outcome still comes from verify.
    const reference = String(d.reference || evt.reference || "").trim();
    let movement = reference ? await prisma.savingsMovement.findUnique({ where: { reference } }) : null;
    if (!movement && d.transaction_reference) {
      movement = await prisma.savingsMovement.findFirst({ where: { pvReference: String(d.transaction_reference) } });
    }
    if (!movement || movement.type !== "withdrawal") return;
    if (!["processing", "unknown"].includes(movement.status)) return;
    const verify = await piggyvest.verifyTransaction(movement.reference);
    const next = await savings.applyWithdrawalOutcome(movement, verify);
    if (next) {
      const pot = await prisma.savingsPot.findUnique({ where: { id: movement.potId } });
      if (pot?.pvWalletId) {
        const w = await piggyvest.getWallet(pot.pvWalletId).catch(() => null);
        if (w) await prisma.savingsPot.updateMany({ where: { id: pot.id, status: "active" }, data: { balance: w.balance } });
      }
    }
    return;
  }

  if (type.startsWith("bank-transfer.inflow") || type.startsWith("interest-payout") || type.startsWith("wallet.credit")) {
    const walletId = walletIdOf(evt);
    if (walletId) await reconcileSavings({ walletId });
    return;
  }

  console.log(`[piggyvest webhook] unhandled event type: ${type || "?"}`);
}

module.exports = router;
