// Korapay webhook — fail-closed HMAC-SHA256 verify (header x-korapay-signature,
// signed over the `data` object), dedup via ProcessedWebhook, then handle inbound
// credits + payout settlement.
//
// Mounted at POST /webhooks/korapay with express.raw BEFORE express.json.
//
// Events: charge.success (inbound credit) · transfer.success/failed (payout).
// ⚠️ The inbound charge.success DATA field paths (which account, amount) are the
// expected shapes; confirm against a REAL event via the probe (set
// KORAPAY_WEBHOOK_DEBUG=true) once Korapay accounts/collections are live. The
// signature scheme (SHA256 over data) is verified.
const express = require("express");
const router = express.Router();
const prisma = require("../utils/db");
const KorapayProvider = require("../providers/korapay");
const { recordFincraInboundCredit } = require("../utils/fincraCredit");
const { recordFincraPayoutOutcome } = require("../utils/fincraPayout");

const kora = new KorapayProvider();

router.post("/", async (req, res) => {
  const raw = Buffer.isBuffer(req.body)
    ? req.body.toString("utf8")
    : typeof req.body === "string"
      ? req.body
      : JSON.stringify(req.body || {});

  // One-shot format probe (set KORAPAY_WEBHOOK_DEBUG=true). Confirms the signature
  // scheme + prints the data keys from a real event. Never logs the secret.
  if (process.env.KORAPAY_WEBHOOK_DEBUG === "true") {
    try { logKorapayProbe(req.headers, raw); } catch (e) { console.warn("[Korapay webhook probe]", e.message); }
  }

  const bypass = process.env.KORAPAY_VERIFY_WEBHOOK === "false" && process.env.NODE_ENV !== "production";
  if (!bypass && !kora.verifyWebhook(raw, req.headers)) {
    return res.status(401).json({ error: "invalid signature" });
  }

  const evt = kora.parseWebhookEvent(raw);
  res.status(200).json({ received: true }); // ack fast, process after

  try {
    // Dedup marker written only AFTER processing succeeds, so a transient failure
    // leaves no marker and Korapay's redelivery can retry (the Transaction @@unique
    // + idempotent reversal keep re-processing safe).
    const dedupId = evt.dedupId || evt.event || "";
    const dedupKey = dedupId ? `korapay:${evt.event}:${dedupId}` : null;
    if (dedupKey) {
      const seen = await prisma.processedWebhook.findFirst({ where: { eventId: dedupKey } });
      if (seen) return;
    }
    await handleEvent(evt);
    if (dedupKey) {
      await prisma.processedWebhook
        .create({ data: { eventId: dedupKey, type: evt.event } })
        .catch((e) => { if (e.code !== "P2002") throw e; });
    }
  } catch (e) {
    console.error("[Korapay webhook]", evt?.event, e.message);
  }
});

async function handleEvent(evt) {
  const d = evt.data || {};
  switch (evt.kind) {
    case "inbound_credit":
      await recordFincraInboundCredit(d, "korapay");
      break;
    case "payout_success":
      await recordFincraPayoutOutcome(d, "success", "korapay");
      break;
    case "payout_failed":
      await recordFincraPayoutOutcome(d, "failed", "korapay");
      break;
    default:
      break;
  }
}

// Diagnostic: confirm Korapay's webhook signing from a real event. Korapay signs
// HMAC-SHA256 over the `data` object only, header x-korapay-signature. Logs whether
// our computation matches + the data keys (to confirm field paths).
function logKorapayProbe(headers, raw) {
  const crypto = require("crypto");
  const secret = process.env.KORAPAY_SECRET_KEY || "";
  let body;
  try { body = JSON.parse(raw); } catch { body = null; }
  const data = body?.data;
  const sig = headers["x-korapay-signature"] || headers["X-Korapay-Signature"];
  let match = "n/a";
  if (data != null && sig) {
    const expected = crypto.createHmac("sha256", secret).update(JSON.stringify(data)).digest("hex");
    match = expected === sig ? "MATCH (sha256 over data)" : "NO MATCH — confirm signed string";
  }
  console.log("[Korapay webhook probe] event=%s | sig present=%s | %s | data keys=%j",
    body?.event, !!sig, match, data ? Object.keys(data) : []);
}

module.exports = router;
