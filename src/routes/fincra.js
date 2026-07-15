// Fincra webhook — fail-closed HMAC-SHA512 verify (header `signature`), dedup via
// ProcessedWebhook, then handle account lifecycle + inbound credits.
//
// Mounted at POST /webhooks/fincra with express.raw BEFORE express.json so we can
// hash the EXACT bytes Fincra signed (they sign JSON.stringify(payload) and send
// that as the body, so raw-byte verification is robust to re-stringify drift).
//
// ⚠️ The account_issued / collection.successful DATA field paths below are the
// documented/expected shapes; confirm them against a REAL Fincra event once FCY
// + webhook delivery are enabled (FCY is currently disabled on the sandbox
// account). Signature + dedup + routing are verified.
const express = require("express");
const router = express.Router();
const prisma = require("../utils/db");
const FincraProvider = require("../providers/fincra");
const { pushTo } = require("../utils/pushNotification");
const { recordFincraInboundCredit } = require("../utils/fincraCredit");

const fincra = new FincraProvider();

router.post("/", async (req, res) => {
  const raw = Buffer.isBuffer(req.body)
    ? req.body.toString("utf8")
    : typeof req.body === "string"
      ? req.body
      : JSON.stringify(req.body || {});

  // One-shot format probe (set FINCRA_WEBHOOK_DEBUG=true). Logs which header +
  // HMAC variant matches the received signature so we can lock in Fincra's exact
  // signing from ONE real event instead of guessing. Never logs the secret; turn
  // off once the format is confirmed. Safe: does not affect verification/flow.
  if (process.env.FINCRA_WEBHOOK_DEBUG === "true") {
    try { logWebhookFormatProbe(req.headers, raw); } catch (e) { console.warn("[Fincra webhook probe]", e.message); }
  }

  const bypass = process.env.FINCRA_VERIFY_WEBHOOK === "false" && process.env.NODE_ENV !== "production";
  if (!bypass && !fincra.verifyWebhook(raw, req.headers)) {
    return res.status(401).json({ error: "invalid signature" });
  }

  const evt = fincra.parseWebhookEvent(raw);
  // Ack fast; process after responding.
  res.status(200).json({ received: true });

  try {
    // Dedup keyed on event:resourceId. We record the marker only AFTER processing
    // succeeds, so a transient failure (DB blip, timeout) leaves NO marker and
    // Fincra's redelivery can retry — otherwise a marker-before-processing write
    // would permanently drop an inbound credit. Re-processing is safe: the
    // Transaction @@unique([businessId,reference]) collapses double-credits and
    // the account-lifecycle updates are idempotent.
    const dedupId = evt.dedupId || evt.event || "";
    const dedupKey = dedupId ? `fincra:${evt.event}:${dedupId}` : null;
    if (dedupKey) {
      const seen = await prisma.processedWebhook.findFirst({ where: { eventId: dedupKey } });
      if (seen) return; // already fully processed
    }
    await handleEvent(evt);
    if (dedupKey) {
      await prisma.processedWebhook
        .create({ data: { eventId: dedupKey, type: evt.event } })
        .catch((e) => { if (e.code !== "P2002") throw e; });
    }
  } catch (e) {
    console.error("[Fincra webhook]", evt?.event, e.message);
  }
});

async function findForeignAccount(d) {
  const requestId = d._id || d.id || d.virtualAccount?._id || d.reference;
  const accountNumber = d.accountNumber || d.accountInformation?.accountNumber;
  return prisma.foreignAccount.findFirst({
    where: {
      OR: [
        requestId ? { fincraRequestId: String(requestId) } : undefined,
        requestId ? { fincraAccountId: String(requestId) } : undefined,
        accountNumber ? { accountNumber: String(accountNumber) } : undefined,
      ].filter(Boolean),
    },
  });
}

async function handleEvent(evt) {
  const d = evt.data || {};
  switch (evt.kind) {
    case "account_approved": {
      const fa = await findForeignAccount(d);
      if (fa) await prisma.foreignAccount.update({ where: { id: fa.id }, data: { status: "approved" } });
      break;
    }
    case "account_issued": {
      const info = d.accountInformation || {};
      const other = info.otherInfo || {};
      const fa = await findForeignAccount(d);
      if (fa) {
        await prisma.foreignAccount.update({
          where: { id: fa.id },
          data: {
            status: "issued",
            fincraAccountId: String(d._id || d.id || fa.fincraAccountId || ""),
            accountNumber: d.accountNumber || info.accountNumber || fa.accountNumber,
            accountName: info.accountName || fa.accountName,
            bankName: info.bankName || fa.bankName,
            swift: other.swift || other.swiftCode || null,
            routing: other.routing || other.routingNumber || null,
            iban: other.iban || null,
          },
        });
        const biz = await prisma.business.findUnique({ where: { id: fa.businessId }, select: { userId: true } });
        if (biz) pushTo(biz.userId, "Account ready 🎉", `Your ${fa.currency} account is now active.`).catch(() => {});
      }
      break;
    }
    case "inbound_credit":
      await recordFincraInboundCredit(d);
      break;
    default:
      break;
  }
}

// Diagnostic: work out Fincra's exact webhook signing from a real event. Tries
// each candidate header × algorithm × signed-string and reports which combo
// reproduces the received signature. Also prints the top-level payload keys +
// the collection data keys so we can confirm recordInboundCredit's field paths.
function logWebhookFormatProbe(headers, raw) {
  const crypto = require("crypto");
  const secret = process.env.FINCRA_WEBHOOK_SECRET || "";
  const sigHeaderNames = ["signature", "x-fincra-signature", "x-webhook-signature", "fincra-signature"];
  const present = sigHeaderNames.filter((h) => headers[h]);
  let compact = raw;
  try { compact = JSON.stringify(JSON.parse(raw)); } catch { /* keep raw */ }
  const signedVariants = { rawBody: raw, stringifyPayload: compact };
  const matches = [];
  for (const [vName, str] of Object.entries(signedVariants)) {
    for (const algo of ["sha512", "sha256"]) {
      const hex = crypto.createHmac(algo, secret).update(str).digest("hex");
      const b64 = crypto.createHmac(algo, secret).update(str).digest("base64");
      for (const h of present) {
        if (headers[h] === hex) matches.push(`${h} = HMAC-${algo}(${vName}) hex`);
        if (headers[h] === b64) matches.push(`${h} = HMAC-${algo}(${vName}) base64`);
      }
    }
  }
  let event, dataKeys = [];
  try { const b = JSON.parse(raw); event = b.event || b.type; dataKeys = Object.keys(b.data || {}); } catch { /* noop */ }
  console.log(
    "[Fincra webhook probe] event=%s | sig headers present=%j | MATCHES=%j | data keys=%j",
    event, present, matches.length ? matches : "NONE (check secret / header / signed-string)", dataKeys,
  );
}

module.exports = router;
