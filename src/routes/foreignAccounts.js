// Foreign-currency (USD / EUR / GBP) receive accounts, issued by Fincra.
//
// The plumbing for these already existed — the ForeignAccount model, the
// provider method, the `virtualaccount.approved` / `virtualaccount.issued`
// webhooks and the FCY credit path with its monthly inflow cap. What was
// missing was the entry point: nothing ever called provisionForeignAccount.
// This is that entry point.
//
// HOW IT DIFFERS FROM THE NGN NUBAN
//   Anchor returns a naira account number instantly. Fincra FCY is asynchronous
//   and consent-gated: the request comes back "pending" with no account number,
//   the user opens a consent link to authorise, and the real details arrive
//   later on the webhook. So this route never returns account details — the
//   client polls GET until status becomes "issued".
//
// KYC GATE
//   We do NOT open a second admin approval queue. A business can only request an
//   FCY account once it already holds an APPROVED KycSubmission, which is the
//   same admin-vetted identity check that gates the naira account. That keeps
//   the rule "no unvetted business reaches a provider" without making the owner
//   review the same merchant twice. Fincra additionally runs its own review and
//   the consent step before issuing.

const router = require("express").Router();
const prisma = require("../utils/db");
const authMiddleware = require("../middleware/auth");
const { requirePermission } = require("../middleware/requirePermission");
const crypto = require("crypto");
const cloudinary = require("../config/cloudinary");
const { getForeignAccountProvider } = require("../providers");
const fincraService = require("../services/fincra");
const fcy = require("../utils/fcyConversion");
const { computeLedgerBalance } = require("../utils/ledgerBalance");
const { verifyTransactionPin } = require("../utils/transactionPin");
const { fireAlert } = require("../utils/alerts");
const { reachedFincra, neverSent } = require("../utils/foreignAccountState");

const fincraHost = () => {
  try { return new URL(process.env.FINCRA_BASE_URL || "https://sandboxapi.fincra.com").hostname; } catch { return "?"; }
};
const { audit } = require("../utils/audit");
const { buildFcyRequest, FcyKycError } = require("../utils/fcyKyc");
const { isFcyRestricted } = require("../config/fcyRestrictedCountries");
const { validateDataUri, DOC_TYPES } = require("../utils/uploadGuard");

// Store FCY KYC documents PRIVATELY, like the KYB certificates: a passport or a
// utility bill must never sit on a public CDN URL. buildFcyRequest turns these
// public_ids into short-lived signed URLs for Fincra to fetch.
async function uploadFcyDocs(docs = {}) {
  const put = async (dataUri, kind) => {
    const meta = validateDataUri(dataUri, { allow: DOC_TYPES, maxBytes: 8 * 1024 * 1024 });
    const up = await cloudinary.uploader.upload(dataUri, {
      folder: "kashbook/fcy",
      public_id: `${kind}_${crypto.randomUUID()}`,
      overwrite: false,
      resource_type: meta.resourceType,
      image_metadata: false, // strip EXIF/GPS from a photographed document
      type: "private",
      access_mode: "authenticated",
    });
    // The validated mime travels with the id: it decides the extension and the
    // Content-Type of the link Fincra fetches (utils/fcyDocLink.js). Cloudinary
    // cannot supply it for a `raw` PDF, which is exactly the case that failed.
    return { id: up.public_id, type: meta.resourceType, mime: meta.mime };
  };

  const out = { meansOfIdIds: [] };
  if (docs.utilityBill) {
    const r = await put(docs.utilityBill, "ub");
    out.utilityBillId = r.id;
    out.utilityBillType = r.type;
    out.utilityBillMime = r.mime;
  }
  if (docs.bankStatement) {
    const r = await put(docs.bankStatement, "bs");
    out.bankStatementId = r.id;
    out.bankStatementType = r.type;
    out.bankStatementMime = r.mime;
  }
  // Passport is one page; other IDs need front and back, hence an array.
  out.meansOfIdTypes = [];
  out.meansOfIdMimes = [];
  for (const [i, uri] of [].concat(docs.meansOfId || []).filter(Boolean).entries()) {
    if (i >= 2) break; // Fincra takes at most front + back
    const r = await put(uri, "id");
    out.meansOfIdIds.push(r.id);
    out.meansOfIdTypes.push(r.type);
    out.meansOfIdMimes.push(r.mime);
  }
  return out;
}

// Best-effort removal of documents stored for an attempt that never reached
// Fincra. A private passport scan with nothing pointing at it is the worst kind
// of leftover: invisible, personal, and ours to answer for.
async function destroyUploaded(uploaded = {}) {
  const jobs = [];
  const gone = (id, type) => cloudinary.uploader.destroy(id, { type: "private", resource_type: type || "image" });
  if (uploaded.utilityBillId) jobs.push(gone(uploaded.utilityBillId, uploaded.utilityBillType));
  if (uploaded.bankStatementId) jobs.push(gone(uploaded.bankStatementId, uploaded.bankStatementType));
  (uploaded.meansOfIdIds || []).forEach((id, i) => jobs.push(gone(id, (uploaded.meansOfIdTypes || [])[i])));
  await Promise.allSettled(jobs);
}

// Keep the address the merchant confirmed on the FCY form. Only the fields they
// supplied, only where they differ, so this can never blank anything. The
// postcode in particular was never collected anywhere else.
async function persistAddress(biz, address) {
  if (!address || typeof address !== "object") return;
  const map = { street: "addressLine1", city: "addressCity", state: "addressState", postalCode: "addressPostalCode" };
  const data = {};
  for (const [k, col] of Object.entries(map)) {
    const v = typeof address[k] === "string" ? address[k].trim().slice(0, 120) : "";
    if (v && v !== biz[col]) data[col] = v;
  }
  if (!Object.keys(data).length) return;
  await prisma.business.update({ where: { id: biz.id }, data })
    .catch((e) => console.warn("[foreign-accounts] address persist failed:", e.message));
}

// Staff act on their employer's data — same convention as the other routes.
const getTargetUserId = (req) =>
  req.user.accountType === "staff" ? req.user.employerId : req.user.id;

// EUR only. Fincra approved KashBook for EUR virtual accounts in August 2026;
// USD and GBP were not granted. Requesting an un-granted currency gets as far
// as a `pending` row that the provider then never issues, which shows the user
// a request that waits forever — so the currency is gated here rather than
// discovered at the provider.
//
// Re-add "USD" / "GBP" here and in utils/fcyKyc.js the day Fincra grants them.
// Everything downstream is already currency-parameterised.
const SUPPORTED = ["EUR"];

// Rollout switch, default OFF. Set FCY_ENABLED=true to go live.
//
// The original reason for this gate is GONE: it was off because we sent three
// fields where Fincra's POST /profile/virtual-accounts/requests wants ~25 plus
// two fetched documents, so every request would have failed validation.
// utils/fcyKyc.js now builds the full payload and this route uses it.
//
// It stays default-off because turning it on is a business decision with a
// prerequisite, not a code change: FINCRA_SECRET_KEY / FINCRA_BUSINESS_ID /
// FINCRA_WEBHOOK_SECRET must be set in the environment, and the webhook must be
// pointed at /webhooks/fincra, or merchants submit KYC into a void.
//
// With this off the endpoints stay reachable but advertise no currencies, so the
// UI shows "not available yet" instead of a button that always fails.
const FCY_ENABLED = process.env.FCY_ENABLED === "true";

// A euro account is only real if it came from Fincra's LIVE API. services/fincra
// falls back to the SANDBOX host when FINCRA_BASE_URL is unset, so a production
// deploy that turns FCY_ENABLED on and forgets the base URL would hand merchants
// sandbox account details, which they would give to real customers. Money sent
// to those never arrives and nothing in the app would say why.
//
// So production requires the live host explicitly. Off in production, the feature
// simply advertises no currencies, which is the same "not available yet" state
// the UI already knows how to show.
const LIVE_OK = () => process.env.NODE_ENV !== "production" || fincraService.isLive();
if (FCY_ENABLED && process.env.NODE_ENV === "production" && !fincraService.isLive()) {
  console.error(
    "[fcy] DISABLED: FCY_ENABLED=true in production but FINCRA_BASE_URL is not the live API " +
    `(${process.env.FINCRA_BASE_URL || "unset, defaulting to sandbox"}). ` +
    "Set FINCRA_BASE_URL=https://api.fincra.com with LIVE keys, or unset FCY_ENABLED.",
  );
}

// Never leak provider ids or the raw decline text to the client.
function publicView(fa) {
  return {
    id: fa.id,
    currency: fa.currency,
    status: fa.status,
    accountNumber: fa.accountNumber,
    accountName: fa.accountName,
    bankName: fa.bankName,
    swift: fa.swift,
    routing: fa.routing,
    iban: fa.iban,
    consentUrl: fa.status === "pending" ? fa.consentUrl : null,
    declineReason: fa.status === "declined" ? fa.declineReason : null,
    createdAt: fa.createdAt,
  };
}

// Scope every lookup to the caller's own business.
async function ownedBusiness(req, businessId) {
  return prisma.business.findFirst({
    where: { id: businessId, userId: getTargetUserId(req) },
  });
}

// GET /businesses/:businessId/foreign-accounts — list + poll status.
//
// Gated on canViewBalance, matching every other bank-identifier surface
// (businesses.js BANK_BUSINESS_FIELDS, sync.js, transfers.js) and matching the
// mobile gate on ForeignAccountsScreen. An IBAN and a SWIFT code are the same
// class of secret as a NUBAN: they let someone receive in the merchant name.
// Staff the owner DID trust with the account keep this for invoicing; opening an
// account stays owner-only regardless (see the POST below).
router.get("/:businessId/foreign-accounts", authMiddleware, requirePermission("canViewBalance"), async (req, res) => {
  try {
    const biz = await ownedBusiness(req, req.params.businessId);
    if (!biz) return res.status(404).json({ error: "Business not found" });

    const rows = await prisma.foreignAccount.findMany({
      where: { businessId: biz.id },
      orderBy: { createdAt: "asc" },
    });
    // A "pending" row that never reached Fincra is not an account in progress;
    // it is the leftover of an attempt that failed before the provider call.
    // Listing it showed an "In progress" badge and hid the request button
    // behind it. The POST path treats such a row as retryable; the list must
    // agree, or the merchant can never get back to the form.
    const visible = rows.filter((fa) => !neverSent(fa));
    // Fincra refuses FCY accounts for a list of countries (Uganda is on it and
    // is in our own country list), so advertise nothing there rather than
    // letting a merchant complete a full KYC form only to be declined.
    const restricted = isFcyRestricted(biz.country);

    // Balance per issued currency, from OUR ledger. Fincra pools every merchant's
    // euros into one KashBook wallet, so the ledger is the only place that knows
    // whose euros are whose. Currency-scoped, so this can never read naira rows.
    const balances = {};
    for (const fa of visible) {
      if (fa.status === "issued") balances[fa.currency] = await computeLedgerBalance(biz.id, fa.currency);
    }
    // Conversion history the merchant should see. Abandoned quotes and
    // conversions that failed before any money moved are noise to them.
    const conversions = await prisma.fcyConversion.findMany({
      where: { businessId: biz.id, status: { notIn: ["quoted", "failed"] } },
      orderBy: { createdAt: "desc" },
      take: 10,
    });

    res.json({
      supported: FCY_ENABLED && LIVE_OK() && getForeignAccountProvider() && !restricted ? SUPPORTED : [],
      restricted,
      accounts: visible.map(publicView),
      balances,
      // Where converted naira goes. Conversion needs a naira NUBAN to land in.
      canConvert: !!biz.virtualAccountNumber,
      payoutTo: biz.virtualAccountNumber
        ? { bankName: biz.virtualAccountBank || null, accountNumber: `••••${String(biz.virtualAccountNumber).slice(-4)}`, accountName: biz.virtualAccountName || null }
        : null,
      conversions: conversions.map(fcy.publicView),
    });
  } catch (err) {
    console.error("[foreign-accounts] list:", err.message);
    res.status(500).json({ error: "Couldn't load your foreign accounts." });
  }
});

// POST /businesses/:businessId/foreign-accounts  { currency }
router.post("/:businessId/foreign-accounts", authMiddleware, async (req, res) => {
  const currency = String(req.body?.currency || "").toUpperCase();
  try {
    // Staff may VIEW the business's foreign accounts (they need the details to
    // invoice customers), but they must not OPEN one. This request submits the
    // OWNER's personal identity to a bank: their date of birth, government ID,
    // utility bill and declared income band. That is the owner's to give, not an
    // employee's, and the same rule already applies to creating or editing the
    // business itself (businesses.js).
    if (req.user.accountType === "staff") {
      return res.status(403).json({
        code: "OWNER_ONLY",
        error: "Only the business owner can open a foreign currency account.",
      });
    }
    if (!SUPPORTED.includes(currency)) {
      return res.status(400).json({ error: `Choose one of ${SUPPORTED.join(", ")}.` });
    }
    const biz = await ownedBusiness(req, req.params.businessId);
    if (!biz) return res.status(404).json({ error: "Business not found" });

    // FCY is independent of whoever holds the local account: a Nigerian merchant
    // keeps their NGN NUBAN at Anchor and holds USD/EUR/GBP at Fincra.
    const provider = FCY_ENABLED && LIVE_OK() ? getForeignAccountProvider() : null;
    if (!provider) {
      return res.status(503).json({
        code: "NOT_SUPPORTED",
        error: "Foreign currency accounts aren't available right now.",
      });
    }
    if (isFcyRestricted(biz.country)) {
      return res.status(403).json({
        code: "COUNTRY_RESTRICTED",
        error: "Our banking partner can't open foreign currency accounts for businesses in your country.",
      });
    }

    // KYC gate, but ONLY where a local account exists to have been verified.
    //
    // Requiring an APPROVED KycSubmission unconditionally would permanently lock
    // out every merchant in a country with no local rail (South Africa, Egypt):
    // that submission is created by the local-account flow they can never run.
    // For them the FCY form IS the first KYC — it carries full identity plus a
    // government ID and a utility bill, and Fincra runs its own review on top.
    // Where a local rail does exist we keep reusing its admin-vetted approval,
    // so the owner never reviews the same merchant twice.
    const { supportsLocalAccount } = require("../config/countries");
    if (supportsLocalAccount(biz.country)) {
      const approvedKyc = await prisma.kycSubmission.findFirst({
        where: { businessId: biz.id, status: "APPROVED" },
        orderBy: { reviewedAt: "desc" },
      });
      if (!approvedKyc) {
        return res.status(403).json({
          code: "KYC_REQUIRED",
          error: "Verify your business and set up your local account first, then you can add a foreign currency account.",
        });
      }
    }

    // One per (business, currency). A row that actually reached Fincra (it has
    // a fincraRequestId, or has since been approved/issued) is returned as-is,
    // so a double-tap is harmless and the client just keeps polling.
    //
    // A "pending" row with NO fincraRequestId never reached Fincra: it is the
    // leftover of an attempt that failed validation. It must not block a retry.
    // On 2026-09-10 exactly that leftover made every resubmission return 200
    // "existing" without re-validating, and the app announced an account
    // request that had never been sent.
    const existing = await prisma.foreignAccount.findUnique({
      where: { businessId_currency: { businessId: biz.id, currency } },
    });
    if (reachedFincra(existing)) {
      return res.status(200).json({ account: publicView(existing), existing: true });
    }

    const owner = await prisma.user.findUnique({ where: { id: biz.userId } });
    if (!owner) return res.status(404).json({ error: "Business owner not found" });

    // Upload the KYC documents PRIVATELY (never public: these are passports and
    // utility bills). buildFcyRequest signs them into expiring URLs for Fincra
    // to fetch. Same validation as every other upload: MIME + magic bytes + size
    // cap + no remote URLs + PDF active-content rejection.
    let uploaded;
    try {
      uploaded = await uploadFcyDocs(req.body?.documents || {});
    } catch (err) {
      return res
        .status(err.httpStatus || 400)
        .json({ error: err.message, code: err.code || "UPLOAD_FAILED", field: err.field });
    }

    // Assemble the REAL payload. Fincra needs ~25 fields plus two fetched
    // documents; most come from data we already hold, the rest from `kyc` in the
    // request body. This throws a field-tagged FcyKycError before we consume a
    // provider request slot, so the user gets a precise fix rather than an
    // opaque provider rejection.
    let fincraBody;
    try {
      fincraBody = buildFcyRequest({
        user: owner,
        business: biz,
        currency,
        extra: req.body?.kyc || {},
        documents: uploaded,
      });
    } catch (err) {
      if (err instanceof FcyKycError) {
        // Nothing was sent. Drop the documents we just stored so a rejected
        // attempt leaves no private assets behind, and point at the field.
        destroyUploaded(uploaded).catch(() => {});
        // Log WHICH check failed and whether the app sent an address at all.
        // An old app build sends none, which looks identical to a merchant
        // who left the postcode blank unless this line says so.
        const addr = req.body?.kyc?.address;
        console.warn(
          `[foreign-accounts] ${currency} KYC rejected: ${err.code} field=${err.field} ` +
          `addressSupplied=${addr && typeof addr === "object" ? "yes" : "no"} business=${biz.id}`,
        );
        return res.status(err.httpStatus || 400).json({ error: err.message, code: err.code, field: err.field });
      }
      throw err;
    }

    // The address the merchant just confirmed IS the business address; keep it
    // so the next thing that needs it (invoices, the NUBAN) has it too.
    await persistAddress(biz, req.body?.kyc?.address);

    // Create the row only NOW, immediately before Fincra is called. It has to
    // exist before the call, because the issued webhook matches on
    // fincraRequestId/accountNumber and can arrive before our HTTP response,
    // and not a moment earlier, because a row created before validation is the
    // leftover described above.
    const row = existing
      ? await prisma.foreignAccount.update({
          where: { id: existing.id },
          data: { status: "pending", declineReason: null },
        })
      : await prisma.foreignAccount.create({
          data: {
            businessId: biz.id,
            currency,
            // Always individual: Fincra's FCY accounts are individual-only
            // (see utils/fcyKyc.js accountType).
            accountType: "individual",
            status: "pending",
          },
        });

    let result;
    try {
      result = await provider.provisionForeignAccount({
        ...fincraBody,
        merchantReference: `fa_${row.id}`,
      });
    } catch (err) {
      // Leave no half-open request: mark it declined so the user can retry.
      // The merchant sees a safe reason; the raw provider message goes to the
      // log. A 401/403 means OUR credentials were rejected, not their KYC, so
      // say that plainly and page the admin (fireAlert dedups for an hour).
      const authProblem = err.status === 401 || err.status === 403;
      const reason = authProblem
        ? "Our banking partner couldn't process the request. Support has been notified; please try again later."
        : String(err.message || "").slice(0, 500);
      await prisma.foreignAccount.update({
        where: { id: row.id },
        data: { status: "declined", declineReason: reason },
      });
      console.error(
        `[foreign-accounts] ${currency} provisioning failed: HTTP ${err.status ?? "n/a"} ${err.errorType || ""} ${err.message}`,
      );
      if (authProblem) {
        fireAlert("fincra-auth", "Fincra credentials rejected",
          `EUR account request for business ${biz.id} got HTTP ${err.status} (${err.message}) from ${fincraHost()}. ` +
          "Check FINCRA_SECRET_KEY / FINCRA_PUBLIC_KEY / FINCRA_BUSINESS_ID on Render are the LIVE values for api.fincra.com.",
        ).catch(() => {});
      }
      return res.status(502).json({
        code: authProblem ? "PROVIDER_AUTH" : "PROVIDER_ERROR",
        error: authProblem ? reason : "We couldn't set up that account right now. Please try again shortly.",
      });
    }

    const updated = await prisma.foreignAccount.update({
      where: { id: row.id },
      data: {
        fincraRequestId: result.providerRef || null,
        consentUrl: result.consentUrl || null,
        status: result.status === "issued" ? "issued" : "pending",
      },
    });

    await audit({
      req,
      action: "FOREIGN_ACCOUNT_REQUESTED",
      resourceType: "foreignAccount",
      resourceId: updated.id,
      metadata: { currency, businessId: biz.id },
    });

    res.status(201).json({ account: publicView(updated) });
  } catch (err) {
    console.error("[foreign-accounts] create:", err.message);
    res.status(500).json({ error: "Couldn't request that account. Please try again." });
  }
});

// ── Conversions: euro → naira ────────────────────────────────────────────────
// The only way euros leave a balance. Two steps, both owner-only, both behind
// the same feature gate as issuing: quote locks a rate (~30s), confirm needs the
// transaction PIN and runs the money path in utils/fcyConversion.js.

function sendConversionError(res, err) {
  if (err instanceof fcy.ConversionError) {
    const body = { error: err.message, code: err.code };
    if (err.quote) body.quote = err.quote;       // QUOTE_CHANGED carries the fresh figures
    if (err.available !== undefined) body.available = err.available;
    return res.status(err.status || 400).json(body);
  }
  console.error("[foreign-accounts] conversion:", err.message);
  return res.status(500).json({ error: "Couldn't complete that right now. Please try again." });
}

// Shared preamble for both conversion routes. Returns the business or sends
// the refusal and returns null.
async function conversionPreamble(req, res) {
  if (req.user.accountType === "staff") {
    res.status(403).json({ code: "OWNER_ONLY", error: "Only the business owner can convert foreign currency." });
    return null;
  }
  const biz = await ownedBusiness(req, req.params.businessId);
  if (!biz) { res.status(404).json({ error: "Business not found" }); return null; }
  if (!(FCY_ENABLED && LIVE_OK() && getForeignAccountProvider())) {
    res.status(503).json({ code: "FCY_UNAVAILABLE", error: "Foreign currency isn't available right now." });
    return null;
  }
  return biz;
}

router.post("/:businessId/foreign-accounts/conversions/quote", authMiddleware, async (req, res) => {
  try {
    const biz = await conversionPreamble(req, res);
    if (!biz) return;
    const currency = String(req.body?.currency || "").toUpperCase();
    if (!SUPPORTED.includes(currency)) {
      return res.status(400).json({ error: `Choose one of ${SUPPORTED.join(", ")}.` });
    }
    const amount = Number(req.body?.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: "Enter an amount to convert." });
    }
    // Must actually hold an issued account in that currency; a balance without
    // one would mean a credit landed somewhere we do not track.
    const fa = await prisma.foreignAccount.findUnique({
      where: { businessId_currency: { businessId: biz.id, currency } },
    });
    if (!fa || fa.status !== "issued") {
      return res.status(409).json({ code: "NO_FCY_ACCOUNT", error: `You don't have a ${currency} account yet.` });
    }
    const quote = await fcy.quoteConversion({ biz, userId: req.user.id, currency, amount });
    res.json({ quote });
  } catch (err) {
    sendConversionError(res, err);
  }
});

router.post("/:businessId/foreign-accounts/conversions/:conversionId/confirm", authMiddleware, async (req, res) => {
  try {
    const biz = await conversionPreamble(req, res);
    if (!biz) return;

    // Same PIN gate as sending money. Moving euros to naira is irreversible
    // once Fincra has converted, so it deserves the same proof of presence.
    const pinCheck = await verifyTransactionPin(req.user.id, req.body?.pin);
    if (!pinCheck.ok) {
      await audit({
        req, action: "PIN_FAILED", resourceType: "user", resourceId: req.user.id,
        severity: "warn", metadata: { context: "fcy_conversion", conversionId: req.params.conversionId },
      });
      const { ok, status, ...rest } = pinCheck;
      return res.status(status || 401).json({ code: "PIN_INVALID", ...rest });
    }

    const result = await fcy.executeConversion({
      biz, userId: req.user.id, conversionId: req.params.conversionId, req,
    });
    // 202 when the euros converted but the naira payout is being retried: the
    // merchant's money is safe and on its way, but not yet landed.
    res.status(result.payout === "payout_failed" ? 202 : 200).json(result);
  } catch (err) {
    sendConversionError(res, err);
  }
});

module.exports = router;
