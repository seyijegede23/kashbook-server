// JSON API for the Next.js storefront app (public, no auth). Mounted at
// /api/storefront. The Next.js public store fetches these server-to-server for
// SSR; checkout still POSTs to /store/:slug/orders (routes/storefront.js), which
// owns order creation + reconciliation. This file only READS for rendering.
const router = require("express").Router();
const prisma = require("../utils/db");
const { upgradeStoreConfig } = require("../utils/storeConfig");

const SLUG_RE = /^[a-z0-9-]{3,40}$/;

const STORE_INCLUDE = { inventoryItems: { where: { showInStore: true } } };

function mapProduct(p) {
  return {
    id: p.id,
    name: p.name,
    description: p.description || "",
    price: Number(p.price) || 0,
    quantity: Number(p.quantity) || 0,
    inStock: Number(p.quantity) > 0,
    category: p.category || null,
    unit: p.unit || "piece",
    image: p.image || null,
    createdAt: p.createdAt,
  };
}

function mapBusiness(b) {
  return {
    id: b.id,
    name: b.name,
    emoji: b.emoji || "🛍️",
    slug: b.storeSlug,
    description: b.storeDescription || "",
    logoUrl: b.logoUrl || null,
    bannerUrl: b.storeBannerUrl || null,
    currency: b.baseCurrency || "NGN",
    color: b.color || "#2563EB",
    contactPhone: b.storeContactPhone || null,
    address: [b.addressLine1, b.addressCity, b.addressState].filter(Boolean).join(", ") || null,
    enabled: !!b.storeEnabled,
    bank: b.virtualAccountNumber
      ? { bankName: b.virtualAccountBank || null, accountNumber: b.virtualAccountNumber, accountName: b.virtualAccountName || b.name }
      : null,
  };
}

// ── GET /api/storefront/:slug — public store payload for SSR ───────────────────
router.get("/:slug", async (req, res) => {
  try {
    const slug = String(req.params.slug || "").toLowerCase();
    if (!SLUG_RE.test(slug)) return res.status(404).json({ error: "not_found" });
    const business = await prisma.business.findUnique({ where: { storeSlug: slug }, include: STORE_INCLUDE });
    if (!business || !business.storeEnabled) return res.status(404).json({ error: "not_found" });

    const config = upgradeStoreConfig(business.storeConfig, business);
    res.json({
      business: mapBusiness(business),
      config,
      products: business.inventoryItems.map(mapProduct),
    });
  } catch (e) {
    console.error("[storefrontApi]", e.message);
    res.status(500).json({ error: "server_error" });
  }
});

// ── GET /api/storefront/:slug/product/:productKey — product detail (P3) ────────
router.get("/:slug/product/:productKey", async (req, res) => {
  try {
    const slug = String(req.params.slug || "").toLowerCase();
    if (!SLUG_RE.test(slug)) return res.status(404).json({ error: "not_found" });
    const business = await prisma.business.findUnique({ where: { storeSlug: slug }, include: STORE_INCLUDE });
    if (!business || !business.storeEnabled) return res.status(404).json({ error: "not_found" });

    const key = String(req.params.productKey || "");
    const product = business.inventoryItems.find((p) => p.id === key);
    if (!product) return res.status(404).json({ error: "not_found" });

    const related = business.inventoryItems
      .filter((p) => p.id !== product.id && (!product.category || p.category === product.category))
      .slice(0, 4)
      .map(mapProduct);

    res.json({
      business: mapBusiness(business),
      product: mapProduct(product),
      related,
    });
  } catch (e) {
    console.error("[storefrontApi product]", e.message);
    res.status(500).json({ error: "server_error" });
  }
});

// ── GET /api/storefront/order/:token — order status JSON ───────────────────────
router.get("/order/:token", async (req, res) => {
  try {
    const order = await prisma.order.findUnique({
      where: { publicToken: req.params.token },
      include: { items: true, business: true },
    });
    if (!order) return res.status(404).json({ error: "not_found" });
    res.json({
      business: mapBusiness(order.business),
      order: {
        orderNumber: order.orderNumber,
        status: order.status,
        currency: order.currency,
        subtotal: order.subtotal,
        total: order.total,
        paymentReference: order.paymentReference,
        createdAt: order.createdAt,
        items: (order.items || []).map((i) => ({ name: i.name, price: i.price, quantity: i.quantity, amount: i.amount })),
      },
    });
  } catch (e) {
    console.error("[storefrontApi order]", e.message);
    res.status(500).json({ error: "server_error" });
  }
});

module.exports = router;
