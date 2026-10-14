-- Items like Zoho (2026-10-14): the item form's sales and purchase
-- information, more information (brand, weight, codes), a preferred supplier,
-- whether goods may come back into stock on a credit note (returnable), goods
-- whose stock is not counted (trackInventory off), and items with variants:
-- one product in attributes (Size: S, M, L; Colour: red, blue), an ItemGroup
-- holding what its variants share, each variant an ordinary InventoryItem.
-- Sale and invoice lines keep whether their goods were counted (tracked), so
-- a line of goods that were not counted never moves stock. The books
-- (utils/books.js, utils/ledger.js) do not change: such a line carries no
-- cost, as a service's does not.
--
-- Money is naira, kobo-exact, as in release 3. Idempotent throughout: the
-- backfills run only when their column is added, so running this again never
-- undoes what an owner has changed since.

-- ── Items: stock counted or not, and returnable ────────────────────────────
-- trackInventory: whether the goods' stock is counted (always off for a
-- service). Goods whose stock is not counted hold no stock and no value, and
-- no cost of one unit. returnable: goods whose stock is counted may come back
-- into stock on a credit note. New goods are not returnable unless the owner
-- says so (Zoho's default); goods from before this release stay returnable,
-- so nothing changes for them.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'InventoryItem' AND column_name = 'trackInventory') THEN
    ALTER TABLE "InventoryItem" ADD COLUMN "trackInventory" BOOLEAN NOT NULL DEFAULT true;
    UPDATE "InventoryItem" SET "trackInventory" = false WHERE "itemType" = 'service';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'InventoryItem' AND column_name = 'returnable') THEN
    ALTER TABLE "InventoryItem" ADD COLUMN "returnable" BOOLEAN NOT NULL DEFAULT false;
    UPDATE "InventoryItem" SET "returnable" = true WHERE "itemType" = 'goods';
  END IF;
END $$;

-- ── Items: purchase information ─────────────────────────────────────────────
-- purchasePrice: what the business usually pays for one unit (fills a
-- restock's cost and "Record a purchase"); purchaseDescription and
-- preferredSupplier fill them too. purchaseAccountId: where buying goods that
-- are not counted, or a service's direct costs, go (null: Cost of Goods Sold
-- for goods, Cost of Services for a service); goods that are counted go to
-- Cost of Goods Sold when sold, whatever this says.
ALTER TABLE "InventoryItem" ADD COLUMN IF NOT EXISTS "purchasePrice" DOUBLE PRECISION;
ALTER TABLE "InventoryItem" ADD COLUMN IF NOT EXISTS "purchaseDescription" TEXT;
ALTER TABLE "InventoryItem" ADD COLUMN IF NOT EXISTS "purchaseAccountId" TEXT;
ALTER TABLE "InventoryItem" ADD COLUMN IF NOT EXISTS "preferredSupplier" TEXT;
CREATE INDEX IF NOT EXISTS "InventoryItem_purchaseAccountId_idx" ON "InventoryItem"("purchaseAccountId");

-- ── Items: more information ─────────────────────────────────────────────────
-- All optional and shown to everyone. A weight in kg, g, lb or oz; the three
-- dimensions in cm, m or in; the product codes as typed (UPC 12 digits, EAN 8
-- or 13, ISBN 10 or 13, MPN the maker's own).
ALTER TABLE "InventoryItem" ADD COLUMN IF NOT EXISTS "brand" TEXT;
ALTER TABLE "InventoryItem" ADD COLUMN IF NOT EXISTS "manufacturer" TEXT;
ALTER TABLE "InventoryItem" ADD COLUMN IF NOT EXISTS "weight" DOUBLE PRECISION;
ALTER TABLE "InventoryItem" ADD COLUMN IF NOT EXISTS "weightUnit" TEXT;
ALTER TABLE "InventoryItem" ADD COLUMN IF NOT EXISTS "length" DOUBLE PRECISION;
ALTER TABLE "InventoryItem" ADD COLUMN IF NOT EXISTS "width" DOUBLE PRECISION;
ALTER TABLE "InventoryItem" ADD COLUMN IF NOT EXISTS "height" DOUBLE PRECISION;
ALTER TABLE "InventoryItem" ADD COLUMN IF NOT EXISTS "dimensionUnit" TEXT;
ALTER TABLE "InventoryItem" ADD COLUMN IF NOT EXISTS "upc" TEXT;
ALTER TABLE "InventoryItem" ADD COLUMN IF NOT EXISTS "ean" TEXT;
ALTER TABLE "InventoryItem" ADD COLUMN IF NOT EXISTS "isbn" TEXT;
ALTER TABLE "InventoryItem" ADD COLUMN IF NOT EXISTS "mpn" TEXT;

-- ── Items with variants ─────────────────────────────────────────────────────
-- What the variants of one product share: their type, unit, whether their
-- stock is counted, whether they are returnable, the descriptions, the
-- accounts, the preferred supplier, brand and manufacturer (copied to every
-- variant and changed only through the group), and the attributes with their
-- options ([{ "name": "Size", "options": ["S", "M", "L"] }], 1 to 3, in the
-- order the variants' values follow). clientRef makes a retried create safe.
-- archivedAt: the group and its variants are archived together.
CREATE TABLE IF NOT EXISTS "ItemGroup" (
  "id"                  TEXT NOT NULL,
  "businessId"          TEXT NOT NULL,
  "userId"              TEXT NOT NULL,
  "name"                TEXT NOT NULL,
  "itemType"            TEXT NOT NULL DEFAULT 'goods',
  "unit"                TEXT NOT NULL,
  "trackInventory"      BOOLEAN NOT NULL DEFAULT true,
  "returnable"          BOOLEAN NOT NULL DEFAULT false,
  "description"         TEXT,
  "purchaseDescription" TEXT,
  "preferredSupplier"   TEXT,
  "brand"               TEXT,
  "manufacturer"        TEXT,
  "incomeAccountId"     TEXT,
  "purchaseAccountId"   TEXT,
  "attributes"          JSONB NOT NULL,
  "image"               TEXT,
  "clientRef"           TEXT,
  "archivedAt"          TIMESTAMP(3),
  "createdById"         TEXT,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ItemGroup_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ItemGroup_itemType_check" CHECK ("itemType" IN ('goods', 'service')),
  CONSTRAINT "ItemGroup_trackInventory_check" CHECK ("itemType" = 'goods' OR "trackInventory" = false),
  CONSTRAINT "ItemGroup_returnable_check" CHECK ("returnable" = false OR ("itemType" = 'goods' AND "trackInventory")),
  CONSTRAINT "ItemGroup_attributes_check" CHECK (jsonb_typeof("attributes") = 'array')
);
CREATE INDEX IF NOT EXISTS "ItemGroup_businessId_updatedAt_idx" ON "ItemGroup"("businessId", "updatedAt");
CREATE INDEX IF NOT EXISTS "ItemGroup_userId_idx" ON "ItemGroup"("userId");
CREATE INDEX IF NOT EXISTS "ItemGroup_incomeAccountId_idx" ON "ItemGroup"("incomeAccountId");
CREATE INDEX IF NOT EXISTS "ItemGroup_purchaseAccountId_idx" ON "ItemGroup"("purchaseAccountId");
CREATE UNIQUE INDEX IF NOT EXISTS "ItemGroup_businessId_clientRef_key" ON "ItemGroup"("businessId", "clientRef");

-- A variant: its group, its option for each attribute in the group's order
-- (variantValues, a list of text), and the same lower-cased and joined with
-- U+001F (variantKey), so a combination is made once per group.
ALTER TABLE "InventoryItem" ADD COLUMN IF NOT EXISTS "groupId" TEXT;
ALTER TABLE "InventoryItem" ADD COLUMN IF NOT EXISTS "variantValues" JSONB;
ALTER TABLE "InventoryItem" ADD COLUMN IF NOT EXISTS "variantKey" TEXT;
CREATE INDEX IF NOT EXISTS "InventoryItem_groupId_idx" ON "InventoryItem"("groupId");
CREATE UNIQUE INDEX IF NOT EXISTS "InventoryItem_groupId_variantKey_key" ON "InventoryItem"("groupId", "variantKey");

-- ── Lines: whether their goods were counted ─────────────────────────────────
-- false only on a line of goods whose stock is not counted (a service's line
-- and a typed line keep true, which means nothing for them). A line moves
-- stock only when it is goods and tracked. An item's tracking never changes
-- once a line names it, so the line's copy always equals the item's.
ALTER TABLE "SaleItem" ADD COLUMN IF NOT EXISTS "tracked" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "InvoiceItem" ADD COLUMN IF NOT EXISTS "tracked" BOOLEAN NOT NULL DEFAULT true;

DO $$ BEGIN
  -- A service's stock is never counted; goods whose stock is not counted hold
  -- no stock, no value and no cost of one unit (a service may keep the cost
  -- it had as goods, as release 3 does); only counted goods are returnable.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'InventoryItem_trackInventory_check') THEN
    ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_trackInventory_check"
      CHECK ("itemType" = 'goods' OR "trackInventory" = false);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'InventoryItem_untracked_stock_check') THEN
    ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_untracked_stock_check"
      CHECK ("trackInventory" OR ("quantity" = 0 AND "stockValue" = 0));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'InventoryItem_untracked_cost_check') THEN
    ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_untracked_cost_check"
      CHECK ("trackInventory" OR "itemType" <> 'goods' OR "avgCost" IS NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'InventoryItem_returnable_check') THEN
    ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_returnable_check"
      CHECK ("returnable" = false OR ("itemType" = 'goods' AND "trackInventory"));
  END IF;

  -- Real numbers only (NaN and infinity compare above every number in
  -- Postgres, so "> 0" alone lets them through), and the listed units.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'InventoryItem_details_check') THEN
    ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_details_check" CHECK (
      ("purchasePrice" IS NULL OR ("purchasePrice" >= 0 AND "purchasePrice" < 'Infinity'))
      AND ("weight" IS NULL OR ("weight" > 0 AND "weight" < 'Infinity'))
      AND ("length" IS NULL OR ("length" > 0 AND "length" < 'Infinity'))
      AND ("width" IS NULL OR ("width" > 0 AND "width" < 'Infinity'))
      AND ("height" IS NULL OR ("height" > 0 AND "height" < 'Infinity'))
      AND ("weightUnit" IS NULL OR "weightUnit" IN ('kg', 'g', 'lb', 'oz'))
      AND ("dimensionUnit" IS NULL OR "dimensionUnit" IN ('cm', 'm', 'in')));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'InventoryItem_variantValues_check') THEN
    ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_variantValues_check"
      CHECK ("variantValues" IS NULL OR jsonb_typeof("variantValues") = 'array');
  END IF;

  -- The purchase account goes when the account does (the item then uses the
  -- default); the same for a group's accounts.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'InventoryItem_purchaseAccountId_fkey') THEN
    ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_purchaseAccountId_fkey"
      FOREIGN KEY ("purchaseAccountId") REFERENCES "LedgerAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  -- A variant whose group is deleted is an ordinary item (the routes delete
  -- a group's variants with it).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'InventoryItem_groupId_fkey') THEN
    ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_groupId_fkey"
      FOREIGN KEY ("groupId") REFERENCES "ItemGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  -- Groups go with their business and their owner, as items do.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ItemGroup_businessId_fkey') THEN
    ALTER TABLE "ItemGroup" ADD CONSTRAINT "ItemGroup_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ItemGroup_userId_fkey') THEN
    ALTER TABLE "ItemGroup" ADD CONSTRAINT "ItemGroup_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ItemGroup_incomeAccountId_fkey') THEN
    ALTER TABLE "ItemGroup" ADD CONSTRAINT "ItemGroup_incomeAccountId_fkey"
      FOREIGN KEY ("incomeAccountId") REFERENCES "LedgerAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ItemGroup_purchaseAccountId_fkey') THEN
    ALTER TABLE "ItemGroup" ADD CONSTRAINT "ItemGroup_purchaseAccountId_fkey"
      FOREIGN KEY ("purchaseAccountId") REFERENCES "LedgerAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
