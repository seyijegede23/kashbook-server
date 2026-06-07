const router = require("express").Router();
const prisma = require("../utils/db");
const auth = require("../middleware/auth");
const cloudinary = require("../config/cloudinary");
const anchor = require("../utils/anchor");
const { encrypt } = require("../utils/crypto");

router.use(auth);

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
  if (!name) return res.status(400).json({ error: "Business name required" });

  try {
    if (req.user.plan !== "PREMIUM") {
      const count = await prisma.business.count({ where: { userId: req.user.id } });
      if (count >= 1) {
        return res.status(403).json({ error: "Free plan allows only 1 business. Upgrade to Pro to manage multiple businesses." });
      }
    }

    const biz = await prisma.business.create({
      data: {
        userId: req.user.id,
        name,
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
    res.status(500).json({ error: "Failed to create business" });
  }
});

// PATCH /businesses/:id
router.patch("/:id", async (req, res) => {
  if (req.user.accountType === "staff") {
    return res.status(403).json({ error: "Staff cannot update businesses" });
  }

  const { name, emoji, color, customCategories } = req.body;
  try {
    // Verify ownership
    const existing = await prisma.business.findFirst({
      where: { id: req.params.id, userId: req.user.id },
    });
    if (!existing) return res.status(404).json({ error: "Business not found" });

    const data = {};
    if (name !== undefined) data.name = name;
    if (emoji !== undefined) data.emoji = emoji;
    if (color !== undefined) data.color = color;

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
// and cache 60s. Falls back to local math if the call fails so the UI doesn't blank.
const balanceCache = new Map(); // businessId → { value, expires }
const BALANCE_TTL_MS = 60 * 1000;
router.get("/:id/balance", async (req, res) => {
  try {
    const biz = await prisma.business.findFirst({
      where: { id: req.params.id, userId: getTargetUserId(req) },
    });
    if (!biz) return res.status(404).json({ error: "Business not found" });
    if (!biz.anchorAccountId)
      return res.json({ balance: 0, hasAccount: false });

    const cached = balanceCache.get(biz.id);
    if (cached && cached.expires > Date.now()) {
      return res.json({ balance: cached.value, hasAccount: true, cached: true });
    }

    try {
      const { balance } = await anchor.getAccountBalance(biz.anchorAccountId);
      balanceCache.set(biz.id, {
        value: balance,
        expires: Date.now() + BALANCE_TTL_MS,
      });
      return res.json({ balance, hasAccount: true });
    } catch (anchorErr) {
      console.warn("[Anchor balance] falling back to local math:", anchorErr.message);
      const [inAgg, outAgg] = await Promise.all([
        prisma.transaction.aggregate({
          where: { businessId: biz.id, type: "income", paymentMethod: "bank" },
          _sum: { amount: true },
        }),
        prisma.transaction.aggregate({
          where: {
            businessId: biz.id,
            type: "expense",
            paymentMethod: "bank",
            category: "transfer",
          },
          _sum: { amount: true },
        }),
      ]);
      const balance = Math.max(
        0,
        Number(inAgg._sum.amount || 0) - Number(outAgg._sum.amount || 0),
      );
      return res.json({ balance, hasAccount: true, fallback: true });
    }
  } catch (err) {
    console.error("Balance lookup failed:", err);
    res.status(500).json({ error: err.message || "Failed to fetch balance" });
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

    const {
      bvn, dateOfBirth, gender,
      businessType,            // "sole_proprietorship" | "limited_company"
      industry,
      dateOfRegistration,      // YYYY-MM-DD (CAC registration / incorporation)
      businessAddress,         // { state, addressLine1, city, postalCode? }
      owners,                  // [{ firstName, lastName, bvn, dateOfBirth, gender, percentageOwned, email?, phoneNumber?, addressLine1?, addressCity?, addressState? }]
    } = req.body;

    if (!bvn || bvn.length !== 11) {
      return res.status(400).json({ error: "A valid 11-digit BVN is required." });
    }

    const isLtd = businessType === "limited_company";

    // LTD requires the owners array + incorporation date.
    if (isLtd) {
      if (!Array.isArray(owners) || owners.length === 0) {
        return res.status(400).json({ error: "Limited companies must list at least one owner." });
      }
      if (!dateOfRegistration) {
        return res.status(400).json({ error: "Date of incorporation is required for limited companies." });
      }
      const sum = owners.reduce((s, o) => s + Number(o.percentageOwned || 0), 0);
      if (Math.abs(sum - 100) > 0.01) {
        return res.status(400).json({ error: `Owner percentages must add up to 100% (got ${sum.toFixed(2)}%).` });
      }
      for (const o of owners) {
        if (!o.firstName || !o.lastName) {
          return res.status(400).json({ error: "Each owner needs a first and last name." });
        }
        if (!/^\d{11}$/.test(String(o.bvn || ""))) {
          return res.status(400).json({ error: "Each owner needs a valid 11-digit BVN." });
        }
        if (!o.dateOfBirth) {
          return res.status(400).json({ error: "Each owner needs a date of birth." });
        }
        if (Number(o.percentageOwned) < 5) {
          return res.status(400).json({ error: "Each owner must hold at least 5%." });
        }
      }
    }

    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    const dob = dateOfBirth ? new Date(dateOfBirth) : user.dateOfBirth;
    if (!dob || isNaN(new Date(dob).getTime())) {
      return res.status(400).json({ error: "A valid date of birth is required." });
    }
    const userGender = gender || user.gender;
    if (!userGender) {
      return res.status(400).json({ error: "Gender is required for KYC verification." });
    }

    const registrationType = anchor.mapBusinessTypeToRegistration(businessType);

    // Persist BVN encrypted; backfill DOB/gender on User if missing.
    // Persist new KYB fields on Business so the picker selections survive a retry.
    const bizPatch = { kycBvn: encrypt(bvn) };
    if (industry) bizPatch.industry = industry;
    if (registrationType) bizPatch.registrationType = registrationType;
    if (dateOfRegistration) {
      bizPatch.dateOfRegistration = new Date(dateOfRegistration);
      if (isLtd) bizPatch.dateOfIncorporation = new Date(dateOfRegistration);
    }
    if (businessAddress?.state) bizPatch.addressState = businessAddress.state;
    if (businessAddress?.addressLine1) bizPatch.addressLine1 = businessAddress.addressLine1;
    if (businessAddress?.city) bizPatch.addressCity = businessAddress.city;
    if (businessAddress?.postalCode) bizPatch.addressPostalCode = businessAddress.postalCode;
    if (isLtd) bizPatch.kycBusinessType = "limited_company";
    else bizPatch.kycBusinessType = "sole_proprietor";

    await prisma.business.update({ where: { id: biz.id }, data: bizPatch });

    const userPatch = {};
    if (!user.dateOfBirth) userPatch.dateOfBirth = new Date(dob);
    if (!user.gender) userPatch.gender = userGender;
    if (Object.keys(userPatch).length) {
      await prisma.user.update({ where: { id: req.user.id }, data: userPatch });
    }

    // Persist LTD officers (BVN encrypted) BEFORE the Anchor call so retries work.
    if (isLtd) {
      // Wipe any prior attempt's officer rows (re-submit case).
      await prisma.businessOfficer.deleteMany({ where: { businessId: biz.id } });
      await prisma.businessOfficer.createMany({
        data: [
          {
            businessId: biz.id,
            role: "DIRECTOR",
            firstName: user.firstName,
            lastName: user.lastName || user.firstName,
            bvn: encrypt(bvn),
            dateOfBirth: new Date(dob),
            gender: userGender,
            email: user.email,
            phoneNumber: user.phone,
            title: "CEO",
            percentageOwned: 0,
          },
          ...owners.map((o) => ({
            businessId: biz.id,
            role: "OWNER",
            firstName: o.firstName,
            lastName: o.lastName,
            middleName: o.middleName || null,
            bvn: encrypt(o.bvn),
            dateOfBirth: new Date(o.dateOfBirth),
            gender: o.gender || "Male",
            email: o.email || null,
            phoneNumber: o.phoneNumber || null,
            title: o.title || "President",
            percentageOwned: Number(o.percentageOwned),
            addressLine1: o.addressLine1 || null,
            addressCity: o.addressCity || null,
            addressState: o.addressState || null,
            addressPostalCode: o.addressPostalCode || null,
          })),
        ],
      });
    }

    // 1. Ensure-or-adopt the Anchor customer (Business preferred, Individual fallback)
    let customerId = user.anchorCustomerId;
    let customerType = "BusinessCustomer";
    let adoptedAlreadyApproved = false;
    if (!customerId) {
      try {
        const created = await anchor.createBusinessCustomer({
          businessName: biz.name,
          businessBvn: bvn,
          registrationType,
          industry,
          dateOfRegistration,
          businessAddress: businessAddress?.addressLine1
            ? {
                state: businessAddress.state,
                addressLine_1: businessAddress.addressLine1,
                city: businessAddress.city,
                postalCode: businessAddress.postalCode,
              }
            : undefined,
          user: {
            firstName: user.firstName,
            lastName: user.lastName || user.firstName,
            email: user.email || `${user.id}@kashbook.app`,
            phone: user.phone || "+2348000000000",
            dateOfBirth: new Date(dob),
            gender: userGender,
            bvn,
          },
          owners: isLtd ? owners.map((o) => ({
            firstName: o.firstName,
            lastName: o.lastName,
            middleName: o.middleName,
            bvn: o.bvn,
            dateOfBirth: o.dateOfBirth,
            percentageOwned: Number(o.percentageOwned),
            email: o.email,
            phoneNumber: o.phoneNumber,
            title: o.title,
            addressLine1: o.addressLine1,
            addressCity: o.addressCity,
            addressState: o.addressState,
            addressPostalCode: o.addressPostalCode,
          })) : undefined,
        });
        customerId = created.customerId;
      } catch (e) {
        const isDuplicate =
          /already exist/i.test(e.message || "") ||
          (e.httpStatus === 400 &&
            (e.anchorErrors?.[0]?.detail || "")
              .toLowerCase()
              .includes("already exist"));
        if (!isDuplicate) throw e;

        const phone = (user.phone || "").replace(/^\+/, "");
        const searchValues = [biz.name, phone, user.email, bvn].filter(Boolean);
        const customerTypes = ["BusinessCustomer", "IndividualCustomer"];

        // Try every combination — Anchor's search returns a hit on phone/BVN
        // even across customer types, so we expand the net.
        let existing = null;
        let existingType = null;
        outer: for (const ct of customerTypes) {
          for (const sv of searchValues) {
            const hit = await anchor.searchCustomer({
              searchValue: sv,
              customerType: ct,
            });
            if (hit?.customerId) {
              existing = hit;
              existingType = ct;
              console.log(
                `[Anchor] found existing ${ct} ${hit.customerId} via "${sv}"`,
              );
              break outer;
            }
          }
        }

        if (!existing?.customerId) {
          throw new Error(
            "Anchor reports this user already exists but we can't look them up. Contact support.",
          );
        }
        customerId = existing.customerId;
        customerType = existingType;
        // Adopted customers from earlier testing are usually already KYC-approved.
        // Skip the KYB trigger and let createDepositAccount handle it directly.
        adoptedAlreadyApproved = true;
        console.log(
          `[Anchor] adopted existing ${existingType} ${customerId} for ${biz.name}`,
        );
      }
      await prisma.user.update({
        where: { id: user.id },
        data: { anchorCustomerId: customerId },
      });
    }

    // 2. Trigger KYB only for newly-created BusinessCustomers that aren't verified
    if (
      !adoptedAlreadyApproved &&
      customerType === "BusinessCustomer" &&
      user.kycStatus !== "verified"
    ) {
      try {
        await anchor.triggerKYB(customerId);
      } catch (e) {
        if (e.httpStatus !== 409) {
          console.warn("[KYB trigger] failed:", e.message);
        }
      }
      return res.status(202).json({
        status: "pending_kyc",
        message:
          "We're verifying your business. You'll get a notification when your account is ready.",
      });
    }

    // Mark the user as verified locally since we're about to open an account
    // for an already-approved customer (adopted or webhook-confirmed).
    if (user.kycStatus !== "verified") {
      await prisma.user.update({
        where: { id: req.user.id },
        data: { kycStatus: "verified" },
      });
    }

    // 3. KYC/KYB verified — open deposit account synchronously.
    // NOTE: the response carries the DepositAccount's masked underlying details
    // (e.g. CORESTEP MFB shell), NOT the virtual NUBAN that customers send to.
    // The virtual NUBAN arrives via the `accountNumber.created` webhook later
    // — that handler writes virtualAccountNumber/Bank/Name. We only persist
    // the deposit account ID here so the webhook can match the business.
    const acc = await anchor.createDepositAccount({ customerId, customerType });
    await prisma.business.update({
      where: { id: biz.id },
      data: {
        anchorAccountId: acc.accountId,
        virtualAccountId: acc.accountId,
        virtualAccountRef: acc.accountId,
      },
    });

    // The synchronous response's accountNumber is the masked DepositAccount
    // number — not useful for receiving payments. Always wait for the
    // accountNumber.created webhook (usually <1s) to write the real NUBAN.
    return res.status(202).json({
      status: "pending_account",
      message: "Your account is being provisioned. You'll get a notification shortly.",
    });
  } catch (err) {
    if (err.code === "ANCHOR_NOT_CONFIGURED") {
      return res
        .status(503)
        .json({ error: "Virtual accounts not configured on this server." });
    }
    console.error("Virtual account error:", err);
    res
      .status(400)
      .json({ error: err.message || "Failed to create virtual account" });
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
    res.status(500).json({ error: err.message || "Failed to sync from Anchor" });
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
    res.status(500).json({ error: err.message || "Failed to fetch documents" });
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
    res.status(400).json({ error: err.message || "Failed to upload document" });
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
    res.status(500).json({ error: err.message || "Failed to upload CAC certificate" });
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
