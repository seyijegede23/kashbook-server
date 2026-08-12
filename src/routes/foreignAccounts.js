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
const crypto = require("crypto");
const cloudinary = require("../config/cloudinary");
const { getForeignAccountProvider } = require("../providers");
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
    return { id: up.public_id, type: meta.resourceType };
  };

  const out = { meansOfIdIds: [] };
  if (docs.utilityBill) {
    const r = await put(docs.utilityBill, "ub");
    out.utilityBillId = r.id;
    out.utilityBillType = r.type;
  }
  if (docs.bankStatement) {
    const r = await put(docs.bankStatement, "bs");
    out.bankStatementId = r.id;
    out.bankStatementType = r.type;
  }
  // Passport is one page; other IDs need front and back, hence an array.
  for (const [i, uri] of [].concat(docs.meansOfId || []).filter(Boolean).entries()) {
    if (i >= 2) break; // Fincra takes at most front + back
    const r = await put(uri, "id");
    out.meansOfIdIds.push(r.id);
  }
  return out;
}

// Staff act on their employer's data — same convention as the other routes.
const getTargetUserId = (req) =>
  req.user.accountType === "staff" ? req.user.employerId : req.user.id;

const SUPPORTED = ["USD", "EUR", "GBP"];

// Gated OFF by default until the full KYC payload is implemented.
//
// Fincra's POST /profile/virtual-accounts/requests requires ~25 fields plus two
// uploaded documents (utilityBill, meansOfId), not the three we currently send —
// every request would be rejected on validation. See docs/FINCRA_FCY_FINDINGS.md.
// With this off the endpoints stay reachable but advertise no currencies, so the
// UI shows "not available yet" instead of a button that always fails.
const FCY_ENABLED = process.env.FCY_ENABLED === "true";

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
router.get("/:businessId/foreign-accounts", authMiddleware, async (req, res) => {
  try {
    const biz = await ownedBusiness(req, req.params.businessId);
    if (!biz) return res.status(404).json({ error: "Business not found" });

    const rows = await prisma.foreignAccount.findMany({
      where: { businessId: biz.id },
      orderBy: { createdAt: "asc" },
    });
    // Fincra refuses FCY accounts for a list of countries (Uganda is on it and
    // is in our own country list), so advertise nothing there rather than
    // letting a merchant complete a full KYC form only to be declined.
    const restricted = isFcyRestricted(biz.country);
    res.json({
      supported: FCY_ENABLED && getForeignAccountProvider() && !restricted ? SUPPORTED : [],
      restricted,
      accounts: rows.map(publicView),
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
    const provider = FCY_ENABLED ? getForeignAccountProvider() : null;
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

    // One per (business, currency). Return the existing row rather than erroring
    // so a double-tap is harmless and the client just keeps polling.
    const existing = await prisma.foreignAccount.findUnique({
      where: { businessId_currency: { businessId: biz.id, currency } },
    });
    if (existing && existing.status !== "declined") {
      return res.status(200).json({ account: publicView(existing), existing: true });
    }

    const owner = await prisma.user.findUnique({ where: { id: biz.userId } });
    if (!owner) return res.status(404).json({ error: "Business owner not found" });

    // Create the row BEFORE calling Fincra. The issued webhook matches on
    // fincraRequestId/accountNumber, and it can arrive before our HTTP response
    // does — with no row to match, that credit would have nowhere to land.
    const row = existing
      ? await prisma.foreignAccount.update({
          where: { id: existing.id },
          data: { status: "pending", declineReason: null },
        })
      : await prisma.foreignAccount.create({
          data: {
            businessId: biz.id,
            currency,
            accountType: biz.businessKyb ? "corporate" : "individual",
            status: "pending",
          },
        });

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
        // Not a provider failure — nothing was sent, so the row stays pending
        // and the user can correct and resubmit.
        return res.status(err.httpStatus || 400).json({ error: err.message, code: err.code, field: err.field });
      }
      throw err;
    }

    let result;
    try {
      result = await provider.provisionForeignAccount({
        ...fincraBody,
        merchantReference: `fa_${row.id}`,
      });
    } catch (err) {
      // Leave no half-open request: mark it declined with the reason so the user
      // can retry, and surface a safe message.
      await prisma.foreignAccount.update({
        where: { id: row.id },
        data: { status: "declined", declineReason: String(err.message || "").slice(0, 500) },
      });
      console.error(`[foreign-accounts] ${currency} provisioning failed:`, err.message);
      return res.status(502).json({
        code: "PROVIDER_ERROR",
        error: "We couldn't set up that account right now. Please try again shortly.",
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

module.exports = router;
