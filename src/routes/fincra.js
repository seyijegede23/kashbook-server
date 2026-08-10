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
const { recordFincraPayoutOutcome } = require("../utils/fincraPayout");

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

// Match a lifecycle event to our row.
//
// `data.id` on virtualaccount.* is the VIRTUAL-ACCOUNT id, which is not stated
// to equal the id returned by POST /profile/virtual-accounts/requests (what we
// store as fincraRequestId). If they differ and no account number is known yet,
// nothing matches and the account never leaves "pending". So we also try
// accountInformation.reference, and every handler writes fincraAccountId on the
// first sighting so later events match on it.
async function findForeignAccount(d) {
  const info = d.accountInformation || {};
  const ids = [d._id, d.id, d.virtualAccount?._id, d.virtualAccount, d.reference, info.reference]
    .filter((v) => v && typeof v !== "object")
    .map(String);
  const accountNumbers = [d.accountNumber, info.accountNumber, info.otherInfo?.accountNumber]
    .filter(Boolean)
    .map(String);
  if (!ids.length && !accountNumbers.length) return null;
  return prisma.foreignAccount.findFirst({
    where: {
      OR: [
        ...ids.flatMap((v) => [{ fincraRequestId: v }, { fincraAccountId: v }]),
        ...accountNumbers.map((v) => ({ accountNumber: v })),
      ],
    },
  });
}

// Map an issued/approved/changed payload onto our columns, handling BOTH the
// individual shape (details nested in accountInformation.otherInfo) and the
// flat corporate shape (swiftCode/bankAddress directly on accountInformation).
function mapAccountDetails(d, fa) {
  const info = d.accountInformation || {};
  const other = info.otherInfo || {};
  return {
    // For an individual GB account, info.accountNumber is the full IBAN while
    // otherInfo.accountNumber is the short local number. Prefer the local one
    // for display and keep the IBAN in its own column.
    accountNumber: other.accountNumber || d.accountNumber || info.accountNumber || fa.accountNumber,
    accountName: info.accountName || fa.accountName,
    bankName: info.bankName || fa.bankName,
    iban: other.iban || (String(info.accountNumber || "").length > 15 ? info.accountNumber : null) || fa.iban,
    sortCode: other.sortCode || fa.sortCode,
    swift: other.bankSwiftCode || info.swiftCode || fa.swift,
    // No "routing" key exists; the ACH routing number is the top-level bankCode.
    routing: info.bankCode || fa.routing,
    bankAddress: other.bankAddress || info.bankAddress || fa.bankAddress,
    addressableIn: other.addressableIn || fa.addressableIn,
    memo: other.memo || fa.memo,
    alternateAccountDetails: Array.isArray(info.alternateAccountDetails)
      ? info.alternateAccountDetails
      : fa.alternateAccountDetails,
  };
}

// An event we cannot tie to a row is a real operational problem, not a no-op:
// it means an account will never leave "pending", or money is landing somewhere
// we don't track. Never swallow it.
function logUnmatched(evt, d) {
  console.error(
    `[Fincra webhook] ${evt.event}: no ForeignAccount matched ` +
    `(id=${d._id || d.id || "?"} ref=${d.reference || d.accountInformation?.reference || "?"} ` +
    `acct=${d.accountNumber || d.accountInformation?.accountNumber || "?"})`,
  );
}

// Fincra is asking for supporting documents on an inbound payment. Their own
// guidance: "Although the webhook may contain an additionalInfo array, you
// should call the Get RFIs endpoint to retrieve the complete and current list."
// The deadline is short and missing it returns the customer's money, so this
// alerts the admin as well as notifying the merchant.
async function handleCollectionRfi(d) {
  // NOTE: the collection id here is an INTEGER (e.g. 16376096), not a Mongo id.
  const collectionId = d._id || d.id;
  const requests = Array.isArray(d.additionalInfo) ? d.additionalInfo : [];
  const summary = requests.map((r) => r?.request).filter(Boolean).join("; ").slice(0, 400);

  // Resolve the affected merchant the same way an inbound credit would.
  const vaId = typeof d.virtualAccount === "string" ? d.virtualAccount : d.virtualAccount?._id;
  let biz = null;
  if (vaId) {
    const fa = await prisma.foreignAccount.findFirst({
      where: { OR: [{ fincraAccountId: String(vaId) }, { fincraRequestId: String(vaId) }] },
    });
    biz = fa
      ? await prisma.business.findUnique({ where: { id: fa.businessId } })
      : await prisma.business.findFirst({ where: { providerAccountId: String(vaId) } });
  }

  console.error(
    `[Fincra RFI] collection=${collectionId} business=${biz?.id || "UNRESOLVED"} ` +
    `requests=${requests.length} — funds are returned to the sender if unanswered. ${summary}`,
  );

  try {
    await require("../utils/alerts").fireAlert(
      `fincra_rfi_${collectionId}`,
      "Fincra needs information on an inbound payment",
      `Collection ${collectionId}${biz ? ` for ${biz.name}` : ""} needs supporting documents. ` +
      `If this is not answered in time the money is returned to the sender with a fee. ${summary}`,
    );
  } catch { /* alerting must never mask the event */ }

  if (biz) {
    pushTo(
      biz.userId,
      "Action needed on a payment",
      "Your bank needs more information about a payment you received. Please respond as soon as possible.",
    ).catch(() => {});
  }
}

async function handleEvent(evt) {
  const d = evt.data || {};
  switch (evt.kind) {
    case "account_approved": {
      const fa = await findForeignAccount(d);
      if (!fa) return logUnmatched(evt, d);
      // Corporate .approved already carries the full (flat) account block, so
      // map details here too rather than waiting for .issued.
      await prisma.foreignAccount.update({
        where: { id: fa.id },
        data: {
          status: "approved",
          fincraAccountId: String(d._id || d.id || fa.fincraAccountId || ""),
          ...mapAccountDetails(d, fa),
        },
      });
      break;
    }
    case "account_issued": {
      const fa = await findForeignAccount(d);
      if (!fa) return logUnmatched(evt, d);
      await prisma.foreignAccount.update({
        where: { id: fa.id },
        data: {
          // Derived from evt.kind on purpose: the issued payload's own
          // data.status reads "approved", so trusting it would stall the row.
          status: "issued",
          fincraAccountId: String(d._id || d.id || fa.fincraAccountId || ""),
          declineReason: null,
          ...mapAccountDetails(d, fa),
        },
      });
      const biz = await prisma.business.findUnique({ where: { id: fa.businessId }, select: { userId: true } });
      if (biz) pushTo(biz.userId, "Account ready 🎉", `Your ${fa.currency} account is now active.`).catch(() => {});
      break;
    }
    // Fincra rejected the request. Without this the row sat at "pending"
    // forever and the user never learned why.
    case "account_declined": {
      const fa = await findForeignAccount(d);
      if (!fa) return logUnmatched(evt, d);
      const reason = d.reason || d.declineReason || "";
      await prisma.foreignAccount.update({
        where: { id: fa.id },
        data: { status: "declined", declineReason: String(reason).slice(0, 500) },
      });
      const biz = await prisma.business.findUnique({ where: { id: fa.businessId }, select: { userId: true } });
      if (biz) {
        pushTo(biz.userId, `${fa.currency} account not approved`,
          reason ? String(reason).slice(0, 160) : "Please review your details and try again.").catch(() => {});
      }
      break;
    }
    // Account details were replaced. Continuing to show the old ones sends the
    // payer's money to an account we no longer track.
    case "account_changed": {
      const fa = await findForeignAccount(d);
      if (!fa) return logUnmatched(evt, d);
      await prisma.foreignAccount.update({
        where: { id: fa.id },
        data: {
          fincraAccountId: String(d._id || d.id || fa.fincraAccountId || ""),
          ...mapAccountDetails(d, fa),
        },
      });
      const biz = await prisma.business.findUnique({ where: { id: fa.businessId }, select: { userId: true } });
      if (biz) {
        pushTo(biz.userId, `${fa.currency} account details updated`,
          "Your account details have changed. Please share the new ones with anyone paying you.").catch(() => {});
      }
      break;
    }
    // Permanently deactivated by Fincra: further inbound payments are rejected.
    case "account_closed": {
      const fa = await findForeignAccount(d);
      if (!fa) return logUnmatched(evt, d);
      await prisma.foreignAccount.update({
        where: { id: fa.id },
        data: { status: "closed", declineReason: String(d.reason || "").slice(0, 500) },
      });
      const biz = await prisma.business.findUnique({ where: { id: fa.businessId }, select: { userId: true } });
      if (biz) {
        pushTo(biz.userId, `${fa.currency} account closed`,
          "This account can no longer receive money. Please stop sharing its details.").catch(() => {});
      }
      break;
    }
    // Fincra wants more information about an inbound payment. If nobody
    // responds in time the funds are RETURNED TO THE SENDER with a fee, so this
    // must reach the merchant and be visible to the admin.
    case "collection_rfi": {
      await handleCollectionRfi(d);
      break;
    }
    case "inbound_credit":
      await recordFincraInboundCredit(d);
      break;
    case "payout_success":
      await recordFincraPayoutOutcome(d, "success");
      break;
    case "payout_failed":
      await recordFincraPayoutOutcome(d, "failed");
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
