// Public merchant storefront ("get a website"). Mounted at root (no auth) like
// publicInvoice. Serves the shop page, a preview, the order-status page, and the
// public place-order endpoint. /store/store.js is served by express.static.
const router = require("express").Router();
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");
const prisma = require("../utils/db");
const { renderStorefront, renderOrderStatus, notFound, money } = require("../utils/storefrontHtml");

const SLUG_RE = /^[a-z0-9-]{3,40}$/;

// Stops abuse of the public order endpoint without throttling page views.
const orderLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many orders — please slow down and try again shortly." },
});

const STORE_INCLUDE = { inventoryItems: { where: { showInStore: true } } };

// ── GET /store/:slug — the public shop ────────────────────────────────────────
router.get("/store/:slug", async (req, res) => {
  try {
    const slug = String(req.params.slug || "").toLowerCase();
    if (!SLUG_RE.test(slug)) return res.status(404).type("html").send(notFound());
    const business = await prisma.business.findUnique({ where: { storeSlug: slug }, include: STORE_INCLUDE });
    if (!business || !business.storeEnabled) return res.status(404).type("html").send(notFound());
    res.type("html").send(renderStorefront({ business, items: business.inventoryItems }));
  } catch (e) {
    console.error("[storefront]", e.message);
    res.status(500).type("html").send(notFound("Something went wrong"));
  }
});

// ── GET /store/preview/:token — render current (even unpublished) config ───────
router.get("/store/preview/:token", async (req, res) => {
  try {
    const business = await prisma.business.findUnique({ where: { storePreviewToken: req.params.token }, include: STORE_INCLUDE });
    if (!business) return res.status(404).type("html").send(notFound());
    res.type("html").send(renderStorefront({ business, items: business.inventoryItems, preview: true }));
  } catch (e) {
    console.error("[storefront preview]", e.message);
    res.status(500).type("html").send(notFound());
  }
});

// ── GET /store/order/:token — customer order-status page ───────────────────────
router.get("/store/order/:token", async (req, res) => {
  try {
    const order = await prisma.order.findUnique({
      where: { publicToken: req.params.token },
      include: { items: true, business: true },
    });
    if (!order) return res.status(404).type("html").send(notFound("Order not found"));
    res.type("html").send(renderOrderStatus({ business: order.business, order }));
  } catch (e) {
    console.error("[order status]", e.message);
    res.status(500).type("html").send(notFound("Order not found"));
  }
});

// ── POST /store/:slug/orders — place an order (public) ─────────────────────────
router.post("/store/:slug/orders", orderLimiter, async (req, res) => {
  try {
    const slug = String(req.params.slug || "").toLowerCase();
    if (!SLUG_RE.test(slug)) return res.status(404).json({ error: "Store not found" });
    const business = await prisma.business.findUnique({ where: { storeSlug: slug }, include: STORE_INCLUDE });
    if (!business || !business.storeEnabled) return res.status(404).json({ error: "Store not available" });

    const { customerName, customerPhone, customerEmail, deliveryAddress, note, items } = req.body || {};
    if (!customerName || !customerPhone) return res.status(400).json({ error: "Name and phone are required" });
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: "Your cart is empty" });

    // Build line items from CURRENT product data — never trust client prices.
    const byId = new Map(business.inventoryItems.map((p) => [p.id, p]));
    const lines = [];
    for (const it of items) {
      const p = byId.get(it && it.id);
      const qty = Math.floor(Number(it && it.quantity) || 0);
      if (!p || qty <= 0) continue;
      if (qty > p.quantity) return res.status(400).json({ error: `Only ${p.quantity} of "${p.name}" left` });
      lines.push({ inventoryItemId: p.id, name: p.name, price: p.price, quantity: qty, amount: p.price * qty });
    }
    if (!lines.length) return res.status(400).json({ error: "No valid items in your cart" });
    const subtotal = lines.reduce((s, l) => s + l.amount, 0);

    // Atomic order-number allocation + create.
    const order = await prisma.withBusinessLock(business.id, async () => {
      const updated = await prisma.business.update({
        where: { id: business.id }, data: { orderCounter: { increment: 1 } }, select: { orderCounter: true },
      });
      const orderNumber = "ORD-" + String(updated.orderCounter).padStart(3, "0");
      const paymentReference = "KB" + crypto.randomBytes(4).toString("hex").toUpperCase();
      const publicToken = crypto.randomBytes(16).toString("base64url");
      return prisma.order.create({
        data: {
          businessId: business.id, userId: business.userId, orderNumber,
          customerName: String(customerName).slice(0, 120),
          customerPhone: String(customerPhone).slice(0, 40),
          customerEmail: customerEmail ? String(customerEmail).slice(0, 160) : null,
          deliveryAddress: deliveryAddress ? String(deliveryAddress).slice(0, 300) : null,
          note: note ? String(note).slice(0, 500) : null,
          currency: business.baseCurrency || "NGN",
          subtotal, total: subtotal, paymentReference, publicToken,
          items: { create: lines },
        },
        include: { items: true },
      });
    });

    // Notify the merchant (fire-and-forget).
    try {
      const { pushTo } = require("../utils/pushNotification");
      await pushTo(business.userId, `New order ${order.orderNumber}`, `${order.customerName} · ${money(order.total, order.currency)}`);
    } catch (e) { console.error("[order notify]", e.message); }

    const base = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;
    res.status(201).json({
      ok: true,
      orderNumber: order.orderNumber,
      total: order.total,
      currency: order.currency,
      paymentReference: order.paymentReference,
      statusUrl: `${base}/store/order/${order.publicToken}`,
      bank: business.virtualAccountNumber
        ? { bankName: business.virtualAccountBank, accountNumber: business.virtualAccountNumber, accountName: business.virtualAccountName || business.name }
        : null,
    });
  } catch (e) {
    console.error("[place order]", e);
    res.status(500).json({ error: "Could not place order" });
  }
});

module.exports = router;
