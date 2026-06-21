const router = require("express").Router();
const auth = require("../middleware/auth");
const prisma = require("../utils/db");
const { validateInventoryItem, validateIdParam } = require("../middleware/validate");

router.use(auth);

// Helper to resolve the correct business owner ID
const getTargetUserId = (req) =>
  req.user.accountType === "staff" ? req.user.employerId : req.user.id;

// GET /inventory?businessId=
router.get("/", async (req, res) => {
  try {
    const { businessId, since } = req.query;
    const where = { userId: getTargetUserId(req) };
    if (businessId) where.businessId = businessId;
    if (since) where.updatedAt = { gt: new Date(since) };
    const items = await prisma.inventoryItem.findMany({
      where,
      orderBy: since ? { updatedAt: "asc" } : { name: "asc" },
    });
    res.json(items);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch inventory" });
  }
});

// POST /inventory
router.post("/", validateInventoryItem, async (req, res) => {
  const {
    name,
    quantity = 0,
    unit,
    price,
    unitPrice, // legacy alias
    cost,
    lowStockAlert,
    lowStockThreshold, // legacy alias
    businessId,
    image,
    imageUrl, // legacy alias
    description,
    category,
    sku,
    barcode,
    showInStore,
  } = req.body;
  if (!name) return res.status(400).json({ error: "name required" });

  try {
    if (businessId) {
      const owned = await prisma.business.findFirst({
        where: { id: businessId, userId: getTargetUserId(req) },
      });
      if (!owned) return res.status(403).json({ error: "Forbidden" });
    }

    if (req.user.effectivePlan !== "PREMIUM") {
      const userId = getTargetUserId(req);
      const count = await prisma.inventoryItem.count({ where: { userId } });
      if (count >= 20) {
        return res.status(403).json({ error: "Free plan allows up to 20 inventory items. Upgrade to Pro for unlimited items." });
      }
    }

    const item = await prisma.inventoryItem.create({
      data: {
        userId: getTargetUserId(req),
        businessId: businessId || null,
        name: name.trim(),
        description: description || null,
        unit: unit || "piece",
        quantity: Number(quantity),
        price: Number(price ?? unitPrice ?? 0),
        cost: cost !== undefined ? Number(cost) : null,
        lowStockAlert: Number(lowStockAlert ?? lowStockThreshold ?? 5),
        image: image || imageUrl || null,
        category: category || null,
        sku: sku || null,
        barcode: barcode || null,
        showInStore: !!showInStore,
        createdBy: req.user.id,
        createdByName: req.user.name,
      },
    });
    res.status(201).json(item);
  } catch (err) {
    console.error("POST /inventory error:", err.message);
    res.status(500).json({ error: "Failed to create item" });
  }
});

// PATCH /inventory/:id
router.patch("/:id", async (req, res) => {
  const {
    name,
    quantity,
    unit,
    price,
    unitPrice,
    cost,
    lowStockAlert,
    lowStockThreshold,
    image,
    imageUrl,
    description,
    category,
    sku,
    barcode,
    showInStore,
  } = req.body;
  try {
    const item = await prisma.inventoryItem.findUnique({
      where: { id: req.params.id },
    });
    if (!item) return res.status(404).json({ error: "Item not found" });
    if (item.userId !== getTargetUserId(req))
      return res.status(403).json({ error: "Forbidden" });

    const data = {};
    if (name !== undefined) data.name = name.trim();
    if (quantity !== undefined) data.quantity = Number(quantity);
    if (unit !== undefined) data.unit = unit;
    if (price !== undefined) data.price = Number(price);
    else if (unitPrice !== undefined) data.price = Number(unitPrice);
    if (cost !== undefined) data.cost = Number(cost);
    if (lowStockAlert !== undefined) data.lowStockAlert = Number(lowStockAlert);
    else if (lowStockThreshold !== undefined)
      data.lowStockAlert = Number(lowStockThreshold);
    if (image !== undefined) data.image = image;
    else if (imageUrl !== undefined) data.image = imageUrl;
    if (description !== undefined) data.description = description;
    if (category !== undefined) data.category = category;
    if (sku !== undefined) data.sku = sku;
    if (barcode !== undefined) data.barcode = barcode;
    if (showInStore !== undefined) data.showInStore = !!showInStore;

    const updated = await prisma.inventoryItem.update({
      where: { id: req.params.id },
      data,
    });
    res.json(updated);
  } catch (err) {
    console.error("PATCH /inventory error:", err.message);
    res.status(500).json({ error: "Failed to update item" });
  }
});

// DELETE /inventory/:id
router.delete("/:id", validateIdParam, async (req, res) => {
  if (req.user.accountType === "staff") {
    return res
      .status(403)
      .json({ error: "Staff cannot delete inventory items" });
  }

  try {
    const item = await prisma.inventoryItem.findUnique({
      where: { id: req.params.id },
    });
    if (!item) return res.status(404).json({ error: "Item not found" });
    if (item.userId !== req.user.id)
      return res.status(403).json({ error: "Forbidden" });

    await prisma.inventoryItem.delete({ where: { id: req.params.id } });
    res.json({ message: "Deleted" });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete item" });
  }
});

module.exports = router;
