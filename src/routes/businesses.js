const router = require("express").Router();
const prisma = require("../utils/db");
const auth = require("../middleware/auth");
const requireUnfrozen = require("../middleware/requireUnfrozen");
const cloudinary = require("../config/cloudinary");
const anchor = require("../utils/anchor");
const { encrypt, hmacValue } = require("../utils/crypto");
const { audit } = require("../utils/audit");
const { getRiskCategory } = require("../config/amlLimits");
const {
  runBvnCheck,
  runCacCheck,
} = require("../utils/kycCheck");
const {
  isValidNigerianState,
  checkAdultDob,
  checkRegistrationDate,
  isPlausibleCacNumber,
  normaliseCacNumber,
} = require("../utils/kycMatch");
const { isValidAnchorIndustry } = require("../data/anchorIndustries");
const { upgradeStoreConfig, sanitizeStoreDoc, TEMPLATES, PREMIUM_BLOCK_TYPES } = require("../utils/storeConfig");
const { sanitizeStoreHtmlString, sanitizeStoreCssString } = require("../utils/sanitizeStoreHtml");

router.use(auth);
router.use(requireUnfrozen);

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

  const { name, emoji, color, customCategories, vatEnabled, vatRate, vatInclusive } = req.body;
  try {
    // Verify ownership
    const existing = await prisma.business.findFirst({
      where: { id: req.params.id, userId: req.user.id },
    });
    if (!existing) return res.status(404).json({ error: "Business not found" });

    // Once a bank account (NUBAN) has been issued, the business name is locked:
    // it was verified against the business's CAC/KYB records at Anchor, so a
    // change here would desync the account from its registered owner. Other
    // fields (emoji, colour, VAT, categories) stay editable.
    if (name !== undefined && name !== existing.name && existing.virtualAccountNumber) {
      return res.status(403).json({
        error:
          "Your business name is locked because a bank account has already been issued for it. Contact support if it must change.",
        code: "BUSINESS_NAME_LOCKED",
      });
    }

    const data = {};
    if (name !== undefined) data.name = name;
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

// ── PATCH /businesses/:id/store — online storefront settings + customization ──
const STORE_SLUG_RE = /^[a-z0-9-]{3,40}$/;
function hexOk(c) { return typeof c === "string" && /^#[0-9a-fA-F]{3,8}$/.test(c); }
function sanitizeStoreConfig(c) {
  if (!c || typeof c !== "object") return {};
  const s = {};
  if (hexOk(c.accentColor)) s.accentColor = c.accentColor;
  if (["grid", "list"].includes(c.layout)) s.layout = c.layout;
  if (["light", "dark"].includes(c.theme)) s.theme = c.theme;
  if (["recent", "bestselling", "price_asc"].includes(c.productSort)) s.productSort = c.productSort;
  const section = (obj, textFields = []) => {
    if (!obj || typeof obj !== "object") return undefined;
    const o = { visible: !!obj.visible };
    for (const f of textFields) if (obj[f] != null) o[f] = String(obj[f]).slice(0, 600);
    return o;
  };
  if (c.banner) s.banner = section(c.banner, ["imageUrl", "title", "description"]);
  if (c.announcement) s.announcement = section(c.announcement, ["text"]);
  if (c.about) s.about = section(c.about, ["text"]);
  if (c.contact) s.contact = section(c.contact, ["phone", "address"]);
  if (c.socials) s.socials = section(c.socials, ["instagram", "whatsapp", "x", "tiktok"]);
  if (c.whatsappChat) s.whatsappChat = section(c.whatsappChat, ["number"]);
  if (c.returnPolicy) s.returnPolicy = section(c.returnPolicy, ["text"]);
  return s;
}

router.patch("/:id/store", async (req, res) => {
  if (req.user.accountType === "staff")
    return res.status(403).json({ error: "Only the owner can manage the store" });
  try {
    const biz = await prisma.business.findFirst({ where: { id: req.params.id, userId: req.user.id } });
    if (!biz) return res.status(404).json({ error: "Business not found" });

    const { storeEnabled, storeSlug, storeDescription, storeBannerUrl, storeContactPhone, storeTemplate, storeConfig } = req.body;
    const data = {};

    if (storeSlug !== undefined) {
      const slug = String(storeSlug || "").toLowerCase().trim();
      if (!STORE_SLUG_RE.test(slug))
        return res.status(400).json({ error: "Store link must be 3–40 characters: lowercase letters, numbers and hyphens only." });
      const taken = await prisma.business.findFirst({ where: { storeSlug: slug, NOT: { id: biz.id } }, select: { id: true } });
      if (taken) return res.status(409).json({ error: "That store link is already taken — try another." });
      data.storeSlug = slug;
    }
    if (storeEnabled !== undefined) {
      if (storeEnabled && !(data.storeSlug || biz.storeSlug))
        return res.status(400).json({ error: "Set a store link before going live." });
      data.storeEnabled = !!storeEnabled;
    }
    if (storeDescription !== undefined) data.storeDescription = storeDescription ? String(storeDescription).slice(0, 300) : null;
    if (storeBannerUrl !== undefined) data.storeBannerUrl = storeBannerUrl || null;
    if (storeContactPhone !== undefined) data.storeContactPhone = storeContactPhone ? String(storeContactPhone).slice(0, 40) : null;
    if (storeTemplate !== undefined) data.storeTemplate = ["classic", "modern", "minimal"].includes(storeTemplate) ? storeTemplate : "classic";
    if (storeConfig !== undefined) data.storeConfig = sanitizeStoreConfig(storeConfig);

    // Mint a preview token once so the app can preview before going live.
    if (!biz.storePreviewToken) data.storePreviewToken = require("crypto").randomBytes(12).toString("base64url");

    const updated = await prisma.business.update({ where: { id: biz.id }, data });
    await audit({ req, action: "STORE_UPDATED", resourceType: "business", resourceId: biz.id, metadata: { storeEnabled: updated.storeEnabled, hasSlug: !!updated.storeSlug } });
    res.json(updated);
  } catch (err) {
    console.error("[store update]", err.message);
    res.status(500).json({ error: "Failed to update store" });
  }
});

// ── Visual editor (storeConfig v2 block document) ─────────────────────────────
const STORE_CLOUDINARY = {
  cloudName: process.env.CLOUDINARY_CLOUD_NAME || "dkbvxdbao",
  uploadPreset: process.env.CLOUDINARY_STORE_PRESET || "Kashbook",
  folder: "kashbook/store",
};
function editorProduct(p) {
  return { id: p.id, name: p.name, price: Number(p.price) || 0, image: p.image || null, quantity: Number(p.quantity) || 0, category: p.category || null, showInStore: !!p.showInStore, description: p.description || "" };
}

// Sanitise a GrapesJS design (engine="grapesjs") before storing. The public store
// renders html/css, so those are XSS-scrubbed; projectData only re-hydrates the
// owner's editor (never rendered publicly) so it's stored as-is, size-capped.
function sanitizeDesign(d) {
  const t = (d && typeof d === "object" && d.theme) || {};
  let projectData = null;
  if (d && d.projectData && typeof d.projectData === "object") {
    try { if (JSON.stringify(d.projectData).length <= 1500000) projectData = d.projectData; } catch { /* ignore */ }
  }
  return {
    engine: "grapesjs",
    theme: {
      template: TEMPLATES.includes(t.template) ? t.template : "aurora",
      accentColor: hexOk(t.accentColor) ? t.accentColor : "#2563EB",
      mode: t.mode === "dark" ? "dark" : "light",
    },
    html: sanitizeStoreHtmlString(d && d.html),
    css: sanitizeStoreCssString(d && d.css),
    projectData,
  };
}

// GET /businesses/:id/store/editor-bootstrap — everything the editor needs in one call.
router.get("/:id/store/editor-bootstrap", async (req, res) => {
  if (req.user.accountType === "staff")
    return res.status(403).json({ error: "Only the owner can edit the store" });
  try {
    const biz = await prisma.business.findFirst({
      where: { id: req.params.id, userId: req.user.id },
      include: { inventoryItems: { orderBy: { createdAt: "desc" } } },
    });
    if (!biz) return res.status(404).json({ error: "Business not found" });

    // Start editing from the draft if present, else the published (upgraded) doc.
    const config = upgradeStoreConfig(biz.storeConfigDraft || biz.storeConfig, biz);
    const isPro = req.user.effectivePlan === "PREMIUM";
    res.json({
      business: {
        id: biz.id, name: biz.name, emoji: biz.emoji, color: biz.color, logoUrl: biz.logoUrl,
        currency: biz.baseCurrency || "NGN", storeEnabled: !!biz.storeEnabled, storeSlug: biz.storeSlug,
        storePreviewToken: biz.storePreviewToken, contactPhone: biz.storeContactPhone, hasBank: !!biz.virtualAccountNumber,
      },
      config,
      products: biz.inventoryItems.map(editorProduct),
      limits: { isPro, premiumBlockTypes: PREMIUM_BLOCK_TYPES, maxBlocks: 80 },
      cloudinary: STORE_CLOUDINARY,
      templates: TEMPLATES,
    });
  } catch (err) {
    console.error("[editor-bootstrap]", err.message);
    res.status(500).json({ error: "Failed to load editor" });
  }
});

// PUT /businesses/:id/store/config — save the block document (draft) and/or publish.
//   body { doc }            → sanitize + save as draft
//   body { publish: true }  → publish (doc if provided, else current draft) → live store
router.put("/:id/store/config", async (req, res) => {
  if (req.user.accountType === "staff")
    return res.status(403).json({ error: "Only the owner can edit the store" });
  try {
    const biz = await prisma.business.findFirst({ where: { id: req.params.id, userId: req.user.id } });
    if (!biz) return res.status(404).json({ error: "Business not found" });

    const body = req.body || {};
    const wantPublish = !!body.publish;
    const isPro = req.user.effectivePlan === "PREMIUM";
    const data = {};

    if (body.design && body.design.engine === "grapesjs") {
      // GrapesJS design (html/css/projectData) — the new editor.
      const design = sanitizeDesign(body.design);
      data.storeConfigDraft = design;
      if (wantPublish) data.storeConfig = design;
    } else if (body.doc !== undefined) {
      // Legacy block-document path (kept for backward compatibility).
      const published = upgradeStoreConfig(biz.storeConfig, biz);
      const existingTypes = (published.blocks || []).map((b) => b.type);
      const nextDoc = sanitizeStoreDoc(body.doc, { isPro, existingTypes });
      data.storeConfigDraft = nextDoc;
      if (wantPublish) data.storeConfig = nextDoc;
    } else if (wantPublish && biz.storeConfigDraft) {
      // Publish whatever is already in the draft (any format).
      data.storeConfig = biz.storeConfigDraft;
    }

    if (!biz.storePreviewToken) data.storePreviewToken = require("crypto").randomBytes(12).toString("base64url");
    if (Object.keys(data).length === 0) return res.status(400).json({ error: "Nothing to save" });

    const updated = await prisma.business.update({
      where: { id: biz.id }, data,
      select: { storeConfig: true, storeConfigDraft: true, storePreviewToken: true },
    });
    if (wantPublish) {
      await audit({ req, action: "STORE_PUBLISHED", resourceType: "business", resourceId: biz.id });
    }
    res.json({ ok: true, published: wantPublish, config: updated.storeConfigDraft, previewToken: updated.storePreviewToken });
  } catch (err) {
    console.error("[store config save]", err.message);
    res.status(500).json({ error: "Failed to save store" });
  }
});

// GET /businesses/:id/balance
// Anchor exposes a per-deposit-account balance — we hit `/accounts/balance/:id`
// and cache 60s. Falls back to local math if the call fails so the UI doesn't blank.
const balanceCache = new Map(); // businessId → { value, expires }
const BALANCE_TTL_MS = 60 * 1000;
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
    const { getProvider } = require("../providers");
    if (!getProvider(biz).supportsBanking) {
      return res.status(400).json({
        error: "Banking isn't available in your country yet. You can still use KashBook for invoicing and bookkeeping. We'll let you know when banking arrives.",
        code: "BANKING_NOT_AVAILABLE",
      });
    }

    const {
      bvn, dateOfBirth, gender,
      businessType,            // "sole_proprietorship" | "limited_company"
      industry,
      dateOfRegistration,      // YYYY-MM-DD (CAC registration / incorporation)
      businessAddress,         // { state, addressLine1, city, postalCode? }
      owners,                  // [{ firstName, lastName, bvn, dateOfBirth, gender, percentageOwned, email?, phoneNumber?, addressLine1?, addressCity?, addressState? }]
      cacNumber,               // optional for sole prop; required for LTD
    } = req.body;

    if (!bvn || bvn.length !== 11) {
      return res.status(400).json({ error: "A valid 11-digit BVN is required.", code: "BVN_FORMAT_INVALID" });
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

    // ─────────────────────────────────────────────────────────────────────
    // Phase A · Format & sanity (every field we collect, free, sync)
    // ─────────────────────────────────────────────────────────────────────
    const dobCheck = checkAdultDob(dob);
    if (!dobCheck.ok) {
      return res.status(400).json({
        error: dobCheck.code === "DOB_TOO_YOUNG"
          ? "You must be 18 or older to open a KashBook bank account."
          : "The date of birth doesn't look valid. Please correct it.",
        code: `BVN_${dobCheck.code}`,
      });
    }
    if (dateOfRegistration) {
      const regCheck = checkRegistrationDate(dateOfRegistration);
      if (!regCheck.ok) {
        return res.status(400).json({
          error: regCheck.code === "REGDATE_FUTURE"
            ? "The registration date can't be in the future."
            : "The registration date doesn't look valid.",
          code: regCheck.code,
        });
      }
    }
    // Industry must be a known Anchor enum value. Anchor deserializes an
    // unknown string to null and 400s with "industry must not be null",
    // which costs a KYB attempt — catch it here instead.
    if (industry && !isValidAnchorIndustry(industry)) {
      return res.status(400).json({
        error: "Pick an industry from the list — the one selected isn't recognised.",
        code: "INDUSTRY_INVALID",
      });
    }
    // Anchor requires the director's phone as exactly 11 local digits
    // (0XXXXXXXXXX). A typo'd profile phone (registration only checks ≥6
    // digits, and OTP may have gone to email) otherwise fails at Anchor with
    // "phoneNumber size must be between 11 and 11".
    if (user.phone && !anchor.isValidAnchorPhone(user.phone)) {
      return res.status(400).json({
        error: "Your profile phone number doesn't look like a valid Nigerian mobile number. Update it in Profile, then try again.",
        code: "PHONE_INVALID",
      });
    }
    for (const o of Array.isArray(owners) ? owners : []) {
      if (o.phoneNumber && !anchor.isValidAnchorPhone(o.phoneNumber)) {
        return res.status(400).json({
          error: `${o.firstName || "A shareholder"}'s phone number doesn't look like a valid Nigerian mobile number.`,
          code: "OWNER_PHONE_INVALID",
        });
      }
    }
    if (businessAddress) {
      if (businessAddress.state && !isValidNigerianState(businessAddress.state)) {
        return res.status(400).json({
          error: `"${businessAddress.state}" isn't a valid Nigerian state.`,
          code: "ADDRESS_INVALID_STATE",
        });
      }
      if (businessAddress.addressLine1 && businessAddress.addressLine1.trim().length < 5) {
        return res.status(400).json({
          error: "Address line 1 looks too short. Please enter a full street address.",
          code: "ADDRESS_LINE1_TOO_SHORT",
        });
      }
      if (businessAddress.city && businessAddress.city.trim().length < 2) {
        return res.status(400).json({
          error: "City is required.",
          code: "ADDRESS_CITY_REQUIRED",
        });
      }
      if (businessAddress.postalCode && !/^\d{6}$/.test(businessAddress.postalCode.trim())) {
        return res.status(400).json({
          error: "Postal code must be 6 digits (or leave it blank).",
          code: "ADDRESS_POSTAL_INVALID",
        });
      }
    }
    // CAC number is required for LTD, optional for sole prop.
    if (isLtd && !cacNumber) {
      return res.status(400).json({
        error: "A CAC RC number is required for limited companies.",
        code: "CAC_REQUIRED",
      });
    }
    if (cacNumber && !isPlausibleCacNumber(cacNumber)) {
      return res.status(400).json({
        error: "Enter a valid RC or BN number (4-8 digits, optional RC/BN prefix).",
        code: "CAC_FORMAT_INVALID",
      });
    }

    // ─────────────────────────────────────────────────────────────────────
    // Phase B · Dedup. Reject if another business already verified this BVN
    // or CAC. Same-user resubmissions are allowed (the business id check).
    // ─────────────────────────────────────────────────────────────────────
    const bvnHash = hmacValue(bvn);
    const cacHash = cacNumber ? hmacValue(normaliseCacNumber(cacNumber)) : null;

    if (bvnHash) {
      const conflict = await prisma.business.findFirst({
        where: { kycBvnHash: bvnHash, id: { not: biz.id } },
        select: { id: true },
      });
      if (conflict) {
        return res.status(400).json({
          error: "This BVN is already linked to another KashBook account. If this is you, please log in to the original account.",
          code: "BVN_ALREADY_VERIFIED",
        });
      }
    }
    if (cacHash) {
      const conflict = await prisma.business.findFirst({
        where: { kycCacHash: cacHash, id: { not: biz.id } },
        select: { id: true },
      });
      if (conflict) {
        return res.status(400).json({
          error: "This RC/BN number is already registered to another KashBook business.",
          code: "CAC_ALREADY_VERIFIED",
        });
      }
    }

    // ─────────────────────────────────────────────────────────────────────
    // Phase C · Third-party identity match (Dojah). Soft on provider outage —
    // we log a warn and let Anchor do the substantive verification.
    // ─────────────────────────────────────────────────────────────────────
    const directorFirstName = user.firstName;
    const directorLastName  = user.lastName || user.firstName;

    const bvnRes = await runBvnCheck({
      bvn,
      userId: req.user.id,
      expectedFirstName: directorFirstName,
      expectedLastName:  directorLastName,
      expectedDateOfBirth: dob,
      req,
    });
    if (!bvnRes.ok && bvnRes.code !== "PROVIDER_UNAVAILABLE" && bvnRes.code !== "PROVIDER_ERROR") {
      return res.status(bvnRes.code === "BVN_RATE_LIMITED" ? 429 : 400).json({
        error: bvnRes.message,
        code: bvnRes.code,
      });
    }

    if (cacNumber) {
      const expectedDirectorNames = isLtd
        ? [`${directorFirstName} ${directorLastName}`]
        : []; // sole-prop CAC lookup confirms the business name, no director match
      const cacRes = await runCacCheck({
        cacNumber,
        userId: req.user.id,
        expectedBusinessName: biz.name,
        expectedDirectorNames,
        req,
      });
      if (!cacRes.ok && cacRes.code !== "PROVIDER_UNAVAILABLE" && cacRes.code !== "PROVIDER_ERROR") {
        return res.status(cacRes.code === "CAC_RATE_LIMITED" ? 429 : 400).json({
          error: cacRes.message,
          code: cacRes.code,
        });
      }
    }

    const registrationType = anchor.mapBusinessTypeToRegistration(businessType);

    // Persist BVN encrypted; backfill DOB/gender on User if missing.
    // Persist new KYB fields on Business so the picker selections survive a retry.
    const bizPatch = {
      kycBvn: encrypt(bvn),
      kycBvnHash: bvnHash,
    };
    if (cacNumber) {
      bizPatch.kycCacNumber = encrypt(normaliseCacNumber(cacNumber));
      bizPatch.kycCacHash   = cacHash;
    }
    if (industry) {
      bizPatch.industry = industry;
      bizPatch.riskCategory = getRiskCategory(industry);
    }
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
            bvnHash: hmacValue(bvn),
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
            bvnHash: hmacValue(o.bvn),
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

    // 1. Ensure-or-adopt the Anchor customer (Business preferred, Individual
    // fallback) — serialized per business so two concurrent virtual-account
    // requests can't create duplicate Anchor customers (also backstopped by
    // User.anchorCustomerId @unique).
    let customerId = user.anchorCustomerId;
    let customerType = "BusinessCustomer";
    let adoptedAlreadyApproved = false;
    await prisma.withBusinessLock(req.params.id, async () => {
      // Re-read inside the lock: a racing request may have just set it.
      const fresh = await prisma.user.findUnique({
        where: { id: user.id },
        select: { anchorCustomerId: true },
      });
      customerId = fresh?.anchorCustomerId || null;
      if (customerId) return; // already created/adopted by a concurrent request
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
    });

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
      await audit({
        req,
        action: "KYB_SUBMIT",
        resourceType: "business",
        resourceId: biz.id,
        severity: "info",
        metadata: {
          businessType,
          registrationType,
          industry,
          ownersCount: Array.isArray(owners) ? owners.length : 0,
          riskCategory: bizPatch.riskCategory || "standard",
        },
      });
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
      .json({ error: "Failed to create virtual account" });
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
