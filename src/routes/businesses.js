const router = require("express").Router();
const prisma = require("../utils/db");
const auth = require("../middleware/auth");
const requireUnfrozen = require("../middleware/requireUnfrozen");
const cloudinary = require("../config/cloudinary");
const anchor = require("../utils/anchor");
const { openIndividualBankAccount } = require("../utils/anchorBank");
const { cleanBusinessName, normalizeBusinessName, isProtectedName } = require("../utils/businessName");
const { encrypt, hmacValue } = require("../utils/crypto");
const { audit } = require("../utils/audit");
const { getRiskCategory } = require("../config/amlLimits");
const { getProvider } = require("../providers");
const { computeLedgerBalance } = require("../utils/ledgerBalance");
// Dojah pre-check (runBvnCheck/runCacCheck) removed from the KYC flow — the admin
// approval gate + Anchor's own authoritative KYC make it redundant. The
// utils/kycCheck module is left in place for an easy re-enable.
const {
  isValidNigerianState,
  checkAdultDob,
  checkRegistrationDate,
  isPlausibleCacNumber,
  normaliseCacNumber,
} = require("../utils/kycMatch");
const { isValidAnchorIndustry } = require("../data/anchorIndustries");
const { pushTo } = require("../utils/pushNotification");
const {
  validateVirtualAccountInput,
  buildSubmissionSummary,
} = require("../services/virtualAccountProvisioning");

router.use(auth);
router.use(requireUnfrozen);

// Best-effort heads-up to every admin that a new account-opening request is
// waiting for review. The admin web panel is the primary surface (it polls the
// pending list); this just pushes to any admin who also uses the mobile app.
// Never allowed to fail the submit.
async function notifyAdminsOfKycSubmission(summary) {
  const admins = await prisma.user.findMany({
    where: { role: "ADMIN" },
    select: { id: true },
  });
  const label = summary?.businessName || "A business";
  await Promise.allSettled(
    admins.map((a) =>
      pushTo(a.id, "New account request", `${label} is waiting for KYC review.`),
    ),
  );
}

// Helper to resolve the correct business owner ID
const getTargetUserId = (req) =>
  req.user.accountType === "staff" ? req.user.employerId : req.user.id;

// GET /businesses
router.get("/", async (req, res) => {
  try {
    const list = await prisma.business.findMany({
      where: { userId: getTargetUserId(req) },
      include: { customCategories: true },
      orderBy: { createdAt: "asc" },
    });
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch businesses" });
  }
});

// POST /businesses
router.post("/", async (req, res) => {
  if (req.user.accountType === "staff") {
    return res.status(403).json({ error: "Staff cannot create businesses" });
  }

  const {
    name,
    emoji = "🛍️",
    color = "#6C3FC5",
    customCategories = [],
  } = req.body;
  const cleanName = cleanBusinessName(name);
  if (!cleanName) return res.status(400).json({ error: "Business name required" });
  if (isProtectedName(cleanName)) {
    return res.status(400).json({
      error: "That name isn't allowed — it matches a bank, regulator, or well-known brand. Please use your own business name.",
      code: "BUSINESS_NAME_PROTECTED",
    });
  }

  try {
    if (req.user.plan !== "PREMIUM") {
      const count = await prisma.business.count({ where: { userId: req.user.id } });
      if (count >= 1) {
        return res.status(403).json({ error: "Free plan allows only 1 business. Upgrade to Pro to manage multiple businesses." });
      }
    }

    // One account can't hold two businesses with the same name
    // (case- and whitespace-insensitive) — avoids duplicate NUBANs/receipts.
    const mine = await prisma.business.findMany({
      where: { userId: req.user.id },
      select: { name: true },
    });
    const normalized = normalizeBusinessName(cleanName);
    if (mine.some((b) => normalizeBusinessName(b.name) === normalized)) {
      return res.status(409).json({
        error: "You already have a business with this name. Pick a different name.",
        code: "BUSINESS_NAME_DUPLICATE",
      });
    }

    const biz = await prisma.business.create({
      data: {
        userId: req.user.id,
        name: cleanName,
        emoji,
        color,
        customCategories: {
          create: customCategories.map((c) => ({
            label: c.label,
            value: c.value,
            icon: c.icon || "pricetag-outline",
          })),
        },
      },
      include: { customCategories: true },
    });
    res.status(201).json(biz);
  } catch (err) {
    // DB unique-index backstop (race across devices/requests) → friendly dup error.
    if (err?.code === "P2002") {
      return res.status(409).json({
        error: "You already have a business with this name. Pick a different name.",
        code: "BUSINESS_NAME_DUPLICATE",
      });
    }
    res.status(500).json({ error: "Failed to create business" });
  }
});

// PATCH /businesses/:id
router.patch("/:id", async (req, res) => {
  if (req.user.accountType === "staff") {
    return res.status(403).json({ error: "Staff cannot update businesses" });
  }

  const { name, emoji, color, customCategories, vatEnabled, vatRate, vatInclusive } = req.body;
  try {
    // Verify ownership
    const existing = await prisma.business.findFirst({
      where: { id: req.params.id, userId: req.user.id },
    });
    if (!existing) return res.status(404).json({ error: "Business not found" });

    // Normalize the requested name; a whitespace/case-only edit is not a change.
    const cleanName = name !== undefined ? cleanBusinessName(name) : undefined;
    if (cleanName !== undefined && !cleanName) {
      return res.status(400).json({ error: "Business name required" });
    }
    const nameChanged = cleanName !== undefined && cleanName !== existing.name;

    // The business name is NOT locked after a NUBAN is issued — with individual
    // KYC the name is just the virtual-account display label, so renames are
    // allowed normally (still subject to the impersonation + uniqueness checks
    // below). Note: the virtual NUBAN keeps its original display name at Anchor.
    // Block impersonation + per-account duplicate names on rename too.
    if (nameChanged) {
      if (isProtectedName(cleanName)) {
        return res.status(400).json({
          error: "That name isn't allowed — it matches a bank, regulator, or well-known brand. Please use your own business name.",
          code: "BUSINESS_NAME_PROTECTED",
        });
      }
      const others = await prisma.business.findMany({
        where: { userId: req.user.id, id: { not: req.params.id } },
        select: { name: true },
      });
      const normalized = normalizeBusinessName(cleanName);
      if (others.some((b) => normalizeBusinessName(b.name) === normalized)) {
        return res.status(409).json({
          error: "You already have a business with this name. Pick a different name.",
          code: "BUSINESS_NAME_DUPLICATE",
        });
      }
    }

    const data = {};
    if (cleanName !== undefined) data.name = cleanName;
    if (emoji !== undefined) data.emoji = emoji;
    if (color !== undefined) data.color = color;
    if (vatEnabled !== undefined) data.vatEnabled = !!vatEnabled;
    if (vatInclusive !== undefined) data.vatInclusive = !!vatInclusive;
    if (vatRate !== undefined) {
      // null clears the override (falls back to the country rate); otherwise
      // clamp to a sane 0–100%.
      data.vatRate = vatRate === null ? null : Math.min(100, Math.max(0, Number(vatRate) || 0));
    }

    // Replace customCategories if provided
    if (customCategories !== undefined) {
      await prisma.customCategory.deleteMany({
        where: { businessId: req.params.id },
      });
      data.customCategories = {
        create: customCategories.map((c) => ({
          label: c.label,
          value: c.value,
          icon: c.icon || "pricetag-outline",
        })),
      };
    }

    const biz = await prisma.business.update({
      where: { id: req.params.id },
      data,
      include: { customCategories: true },
    });
    res.json(biz);
  } catch (err) {
    if (err?.code === "P2002") {
      return res.status(409).json({
        error: "You already have a business with this name. Pick a different name.",
        code: "BUSINESS_NAME_DUPLICATE",
      });
    }
    res.status(500).json({ error: "Failed to update business" });
  }
});

// PATCH /businesses/:id/branding
router.patch("/:id/branding", async (req, res) => {
  if (req.user.accountType === "staff") {
    return res.status(403).json({ error: "Staff cannot update businesses" });
  }

  const {
    logoBase64,
    receiptFooter,
    color,
    invoiceTemplate,
    bankName,
    bankAccountNumber,
    bankAccountName,
    usePaymentOverride,
  } = req.body;
  try {
    const biz = await prisma.business.findFirst({
      where: { id: req.params.id, userId: req.user.id },
    });
    if (!biz) return res.status(404).json({ error: "Business not found" });

    let logoUrl;
    if (logoBase64 === null) {
      await cloudinary.uploader
        .destroy(`kashbook/businesses/biz_${biz.id}`)
        .catch(() => {});
      logoUrl = null;
    } else if (logoBase64) {
      const result = await cloudinary.uploader.upload(logoBase64, {
        folder: "kashbook/businesses",
        public_id: `biz_${biz.id}`,
        overwrite: true,
      });
      logoUrl = result.secure_url;
    }

    const data = {};
    if (logoUrl !== undefined) data.logoUrl = logoUrl;
    if (receiptFooter !== undefined) data.receiptFooter = receiptFooter;
    if (color !== undefined) data.color = color;
    if (invoiceTemplate !== undefined) data.invoiceTemplate = invoiceTemplate;
    if (bankName !== undefined) data.bankName = bankName;
    if (bankAccountNumber !== undefined) data.bankAccountNumber = bankAccountNumber;
    if (bankAccountName !== undefined) data.bankAccountName = bankAccountName;
    if (usePaymentOverride !== undefined) data.usePaymentOverride = !!usePaymentOverride;

    const updatedBiz = await prisma.business.update({
      where: { id: biz.id },
      data,
      include: { customCategories: true },
    });
    res.json(updatedBiz);
  } catch (err) {
    console.error("Branding update failed:", err);
    res.status(500).json({ error: "Failed to update business branding" });
  }
});

// GET /businesses/:id/balance
// Anchor exposes a per-deposit-account balance — we hit `/accounts/balance/:id`
// and cache 60s (shared cache so a transfer can optimistically adjust it).
// Falls back to local math if the call fails so the UI doesn't blank.
const balanceCache = require("../utils/balanceCache");
router.get("/:id/balance", async (req, res) => {
  // Staff record transactions but never see the money position.
  if (req.user.accountType === "staff") {
    return res.status(403).json({ error: "Balances are visible to the business owner only.", code: "STAFF_FORBIDDEN" });
  }
  try {
    const biz = await prisma.business.findFirst({
      where: { id: req.params.id, userId: getTargetUserId(req) },
    });
    if (!biz) return res.status(404).json({ error: "Business not found" });
    const bankingId = biz.providerAccountId || biz.anchorAccountId;
    if (!bankingId)
      return res.json({ balance: 0, hasAccount: false });

    const cachedVal = balanceCache.getBalance(biz.id);
    if (cachedVal !== undefined) {
      return res.json({ balance: cachedVal, hasAccount: true, cached: true });
    }

    const provider = getProvider(biz);
    // Pooled-wallet providers (Fincra): the provider has no per-business balance,
    // so our ledger IS the balance (not a fallback).
    if (provider.pooledWallet) {
      const balance = await computeLedgerBalance(biz.id, biz.baseCurrency || "NGN");
      balanceCache.setBalance(biz.id, balance);
      return res.json({ balance, hasAccount: true });
    }

    try {
      const { balance } = await anchor.getAccountBalance(biz.anchorAccountId);
      balanceCache.setBalance(biz.id, balance);
      return res.json({ balance, hasAccount: true });
    } catch (anchorErr) {
      console.warn("[Anchor balance] falling back to local math:", anchorErr.message);
      const balance = await computeLedgerBalance(biz.id, biz.baseCurrency || "NGN");
      return res.json({ balance, hasAccount: true, fallback: true });
    }
  } catch (err) {
    console.error("Balance lookup failed:", err);
    res.status(500).json({ error: "Failed to fetch balance" });
  }
});

// POST /businesses/:id/virtual-account
// body: { bvn, dateOfBirth, gender }
// Anchor BusinessCustomer flow (async):
//   1. Ensure-or-adopt a BusinessCustomer on Anchor for the user
//   2. Trigger KYB (Tier 1) — webhook drives DepositAccount + NUBAN creation
//   3. Return 202 pending_kyc; UI flips to "Verifying..." until webhook lands
router.post("/:id/virtual-account", async (req, res) => {
  if (req.user.accountType === "staff") {
    return res.status(403).json({ error: "Staff cannot create virtual accounts" });
  }

  try {
    const biz = await prisma.business.findFirst({
      where: { id: req.params.id, userId: req.user.id },
    });
    if (!biz) return res.status(404).json({ error: "Business not found" });

    if (biz.virtualAccountNumber) {
      return res.json({
        accountNumber: biz.virtualAccountNumber,
        bankName: biz.virtualAccountBank,
        accountName: biz.virtualAccountName,
        status: "ready",
      });
    }

    // Banking gate — bookkeeping-only countries can't open virtual accounts.
    if (!getProvider(biz).supportsBanking) {
      return res.status(400).json({
        error: "Banking isn't available in your country yet. You can still use KashBook for invoicing and bookkeeping. We'll let you know when banking arrives.",
        code: "BANKING_NOT_AVAILABLE",
      });
    }

    // Load the merchant so validation can read their DOB/gender/phone fallbacks.
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });

    // Idempotency: if this business already cleared review and reached Anchor
    // (an APPROVED request is being provisioned, or a deposit account is awaiting
    // its webhook), don't queue a duplicate — report the in-flight state. Without
    // this, an impatient resubmit during the pre-webhook window would create a
    // second request that, if approved, re-fires KYC / duplicates the account.
    const alreadyApproved = await prisma.kycSubmission.findFirst({
      where: { businessId: biz.id, status: "APPROVED" },
      select: { id: true },
    });
    if (alreadyApproved || biz.anchorAccountId) {
      return res.status(202).json({
        status: "pending_kyc",
        message: "We're verifying your details. You'll get a notification when your account is ready.",
      });
    }

    // Phase A + B validation — reject bad input immediately (before queuing) so
    // the user gets specific feedback rather than a silent "under review".
    const v = await validateVirtualAccountInput({ body: req.body, user, biz });
    if (!v.ok) {
      return res.status(v.httpStatus).json({ error: v.error, code: v.code });
    }

    // Admin approval gate: park the request for review. NOTHING reaches Anchor
    // here — an admin approves it later (routes/admin.js), which replays the
    // stored payload via executeVirtualAccountProvisioning. The full request body
    // is stored ENCRYPTED (it holds raw BVNs); a non-sensitive summary drives the
    // admin list.
    const payloadEnc = encrypt(JSON.stringify(req.body));
    const summary = buildSubmissionSummary({ body: req.body, user, biz });
    const businessType = req.body.businessType || null;
    const businessKyb = req.body.businessKyb === true;

    // One active submission per business — reuse any non-approved row so a
    // resubmit (after a decline / fix) updates in place instead of piling up.
    const existing = await prisma.kycSubmission.findFirst({
      where: { businessId: biz.id, status: { in: ["PENDING", "DECLINED", "FAILED"] } },
      orderBy: { createdAt: "desc" },
    });
    if (existing) {
      await prisma.kycSubmission.update({
        where: { id: existing.id },
        data: {
          status: "PENDING",
          businessType,
          businessKyb,
          payload: payloadEnc,
          summary,
          declineReason: null,
          processError: null,
          reviewedById: null,
          reviewedAt: null,
          processedAt: null,
        },
      });
    } else {
      await prisma.kycSubmission.create({
        data: {
          businessId: biz.id,
          userId: user.id,
          status: "PENDING",
          businessType,
          businessKyb,
          payload: payloadEnc,
          summary,
        },
      });
    }

    notifyAdminsOfKycSubmission(summary).catch((e) =>
      console.warn("[kyc submit] admin notify failed:", e.message),
    );

    await audit({
      req,
      action: "KYC_SUBMIT_FOR_REVIEW",
      resourceType: "business",
      resourceId: biz.id,
      severity: "info",
      metadata: { businessType, businessKyb },
    });

    return res.status(202).json({
      status: "pending_review",
      message:
        "Your account request has been sent for review. We'll notify you once it's approved — usually within a few hours.",
    });
  } catch (err) {
    console.error("Virtual account submit error:", err);
    res.status(400).json({ error: "Failed to submit account request" });
  }
});

// GET /businesses/:id/kyc-status
// Lightweight poll for the account-opening wizard: where does this request sit
// in the admin-review → Anchor pipeline? Drives the "under review" / "declined"
// screens on the mobile side.
router.get("/:id/kyc-status", async (req, res) => {
  try {
    const biz = await prisma.business.findFirst({
      where: { id: req.params.id, userId: getTargetUserId(req) },
      select: { id: true, virtualAccountNumber: true },
    });
    if (!biz) return res.status(404).json({ error: "Business not found" });

    if (biz.virtualAccountNumber) {
      return res.json({ reviewStatus: "approved", hasAccount: true });
    }

    const submission = await prisma.kycSubmission.findFirst({
      where: { businessId: biz.id },
      orderBy: { createdAt: "desc" },
      select: { status: true, declineReason: true, processError: true },
    });
    if (!submission) {
      return res.json({ reviewStatus: "none", hasAccount: false });
    }
    // PENDING → still queued. APPROVED → Anchor provisioning ran (KYC now in
    // Anchor's hands; the app's normal kycStatus poll takes over). DECLINED →
    // show the reason + let them resubmit. FAILED → a post-approval error; the
    // admin can retry, so from the user's side it's still "under review".
    const map = { PENDING: "pending", APPROVED: "approved", DECLINED: "declined", FAILED: "pending" };
    return res.json({
      reviewStatus: map[submission.status] || "pending",
      declineReason: submission.status === "DECLINED" ? submission.declineReason : null,
      hasAccount: false,
    });
  } catch (err) {
    console.error("[kyc-status] error:", err.message);
    res.status(500).json({ error: "Failed to fetch KYC status" });
  }
});

// POST /businesses/:id/sync-anchor-account
// Reconciliation hatch: pulls the user's deposit accounts from Anchor and
// backfills the Business row if we missed a webhook (e.g. transient failure).
router.post("/:id/sync-anchor-account", async (req, res) => {
  try {
    const biz = await prisma.business.findFirst({
      where: { id: req.params.id, userId: req.user.id },
    });
    if (!biz) return res.status(404).json({ error: "Business not found" });

    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user?.anchorCustomerId)
      return res.status(400).json({ error: "No Anchor customer for this user" });

    const accounts = await anchor.listCustomerAccounts(user.anchorCustomerId);
    if (!accounts.length)
      return res.status(404).json({ error: "No deposit accounts found on Anchor" });

    const acc = accounts[0];
    const accountId = acc.id;
    const attrs = acc.attributes || {};

    await prisma.business.update({
      where: { id: biz.id },
      data: {
        anchorAccountId: accountId,
        virtualAccountId: accountId,
        virtualAccountRef: accountId,
        virtualAccountNumber: attrs.accountNumber || null,
        virtualAccountBank: attrs.bank?.name || "Anchor",
        virtualAccountName: attrs.accountName || biz.name,
      },
    });

    res.json({
      status: "synced",
      accountNumber: attrs.accountNumber,
      bankName: attrs.bank?.name || "Anchor",
      accountName: attrs.accountName || biz.name,
    });
  } catch (err) {
    if (err.code === "ANCHOR_NOT_CONFIGURED")
      return res.status(503).json({ error: "Anchor not configured." });
    console.error("[sync-anchor-account] failed:", err);
    res.status(500).json({ error: "Failed to sync from Anchor" });
  }
});

// GET /businesses/:id/required-documents
// Returns the list of Anchor document slots for the user's BusinessCustomer
// (each with documentId, documentType, description, submitted, verified).
// Client uses this to show the "Documents needed" UI during pending KYB.
router.get("/:id/required-documents", async (req, res) => {
  try {
    const biz = await prisma.business.findFirst({
      where: { id: req.params.id, userId: getTargetUserId(req) },
    });
    if (!biz) return res.status(404).json({ error: "Business not found" });
    const user = await prisma.user.findUnique({ where: { id: getTargetUserId(req) } });
    if (!user?.anchorCustomerId) return res.json({ documents: [] });

    const docs = await anchor.listCustomerDocuments(user.anchorCustomerId);
    res.json({ documents: docs });
  } catch (err) {
    if (err.code === "ANCHOR_NOT_CONFIGURED")
      return res.status(503).json({ error: "Anchor not configured." });
    console.error("[required-documents] failed:", err.message);
    res.status(500).json({ error: "Failed to fetch documents" });
  }
});

// POST /businesses/:id/upload-kyb-document
// body: { documentId, fileBase64?, textData? }
// Forwards the document to Anchor's /documents/upload-document endpoint so the
// slot is marked submitted and KYB can proceed to review.
// Each slot is either FILE (send fileBase64) or TEXT (send textData) — the
// client uses the format field returned by GET /:id/required-documents to
// pick which one to send.
router.post("/:id/upload-kyb-document", async (req, res) => {
  if (req.user.accountType === "staff") {
    return res.status(403).json({ error: "Staff cannot upload KYB documents" });
  }
  const { documentId, fileBase64, textData } = req.body;
  if (!documentId) return res.status(400).json({ error: "documentId is required" });
  if (!fileBase64 && !textData)
    return res.status(400).json({ error: "fileBase64 or textData is required" });

  try {
    const biz = await prisma.business.findFirst({
      where: { id: req.params.id, userId: req.user.id },
    });
    if (!biz) return res.status(404).json({ error: "Business not found" });
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user?.anchorCustomerId)
      return res.status(400).json({ error: "No Anchor customer for this user" });

    await anchor.uploadDocument({
      customerId: user.anchorCustomerId,
      documentId,
      fileBase64,
      textData,
      filename: `kyb-${documentId}`,
    });
    res.json({ status: "submitted", documentId });
  } catch (err) {
    if (err.code === "ANCHOR_NOT_CONFIGURED")
      return res.status(503).json({ error: "Anchor not configured." });
    console.error("[upload-kyb-document] failed:", err.message);
    res.status(400).json({ error: "Failed to upload document" });
  }
});

// POST /businesses/:id/upload-cac
// body: { fileBase64: "data:image/jpeg;base64,..." }
// Uploads the CAC certificate (photo/PDF) to Cloudinary and persists the URL
// on the Business row. The URL is later forwarded to Anchor at KYB time
// (live mode) via documents/upload-document. Sandbox doesn't require this
// file, but having the URL stored lets the live-mode handoff be a single call.
router.post("/:id/upload-cac", async (req, res) => {
  if (req.user.accountType === "staff") {
    return res.status(403).json({ error: "Staff cannot upload KYB documents" });
  }
  const { fileBase64 } = req.body;
  if (!fileBase64)
    return res.status(400).json({ error: "fileBase64 is required" });

  try {
    const biz = await prisma.business.findFirst({
      where: { id: req.params.id, userId: req.user.id },
    });
    if (!biz) return res.status(404).json({ error: "Business not found" });

    const upload = await cloudinary.uploader.upload(fileBase64, {
      folder: "kashbook/kyb",
      public_id: `cac_${biz.id}`,
      overwrite: true,
      resource_type: "auto",
    });

    await prisma.business.update({
      where: { id: biz.id },
      data: { cacCertificateUrl: upload.secure_url },
    });

    res.json({ url: upload.secure_url });
  } catch (err) {
    console.error("CAC upload failed:", err);
    res.status(500).json({ error: "Failed to upload CAC certificate" });
  }
});

// DELETE /businesses/:id
router.delete("/:id", async (req, res) => {
  if (req.user.accountType === "staff") {
    return res.status(403).json({ error: "Staff cannot delete businesses" });
  }

  try {
    const count = await prisma.business.count({ where: { userId: req.user.id } });
    if (count <= 1) {
      return res.status(400).json({ error: "Cannot delete your only business" });
    }

    const deleted = await prisma.business.deleteMany({
      where: { id: req.params.id, userId: req.user.id },
    });
    if (deleted.count === 0)
      return res.status(404).json({ error: "Business not found" });

    res.json({ message: "Business deleted" });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete business" });
  }
});

module.exports = router;
