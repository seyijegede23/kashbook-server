-- Online storefront ("get a website") + customer orders.

-- Business: storefront settings + customization
ALTER TABLE "Business"
  ADD COLUMN "storeEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "storeSlug" TEXT,
  ADD COLUMN "storeDescription" TEXT,
  ADD COLUMN "storeBannerUrl" TEXT,
  ADD COLUMN "storeContactPhone" TEXT,
  ADD COLUMN "storeTemplate" TEXT NOT NULL DEFAULT 'classic',
  ADD COLUMN "storeConfig" JSONB,
  ADD COLUMN "storePreviewToken" TEXT,
  ADD COLUMN "orderCounter" INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX "Business_storeSlug_key" ON "Business"("storeSlug");
CREATE UNIQUE INDEX "Business_storePreviewToken_key" ON "Business"("storePreviewToken");

-- InventoryItem: storefront visibility
ALTER TABLE "InventoryItem" ADD COLUMN "showInStore" BOOLEAN NOT NULL DEFAULT false;

-- Order status enum
CREATE TYPE "OrderStatus" AS ENUM ('PENDING', 'PAID', 'FULFILLED', 'CANCELLED');

-- Order
CREATE TABLE "Order" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "orderNumber" TEXT NOT NULL,
  "status" "OrderStatus" NOT NULL DEFAULT 'PENDING',
  "customerName" TEXT NOT NULL,
  "customerPhone" TEXT NOT NULL,
  "customerEmail" TEXT,
  "deliveryAddress" TEXT,
  "note" TEXT,
  "currency" TEXT NOT NULL DEFAULT 'NGN',
  "subtotal" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "total" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "paymentReference" TEXT NOT NULL,
  "publicToken" TEXT NOT NULL,
  "paidAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Order_paymentReference_key" ON "Order"("paymentReference");
CREATE UNIQUE INDEX "Order_publicToken_key" ON "Order"("publicToken");
CREATE INDEX "Order_businessId_status_idx" ON "Order"("businessId", "status");
CREATE INDEX "Order_businessId_createdAt_idx" ON "Order"("businessId", "createdAt");

-- OrderItem
CREATE TABLE "OrderItem" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "inventoryItemId" TEXT,
  "name" TEXT NOT NULL,
  "price" DOUBLE PRECISION NOT NULL,
  "quantity" INTEGER NOT NULL,
  "amount" DOUBLE PRECISION NOT NULL,
  CONSTRAINT "OrderItem_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OrderItem_orderId_idx" ON "OrderItem"("orderId");

-- Foreign keys
ALTER TABLE "Order" ADD CONSTRAINT "Order_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_inventoryItemId_fkey"
  FOREIGN KEY ("inventoryItemId") REFERENCES "InventoryItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
