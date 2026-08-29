-- Barcode uniqueness, scoped per business.
--
-- Additive only. This DB is shared with another deployed app running older
-- code, so nothing here alters an existing column or drops anything: it adds
-- one index. The older app never writes InventoryItem.barcode (the column has
-- existed for a while and has always been NULL everywhere), so it cannot
-- collide with the constraint.
--
-- Scoped to (businessId, barcode) rather than barcode alone because two shops
-- legitimately stock the same product; a global unique would stop the second
-- one recording it.
--
-- Postgres treats NULLs as distinct in a unique index, so the products with no
-- barcode — today that is every row — are unaffected and can stay NULL forever.
--
-- Verified against production before writing: zero duplicate (businessId,
-- barcode) pairs, so the index builds without a backfill.
CREATE UNIQUE INDEX IF NOT EXISTS "InventoryItem_businessId_barcode_key"
  ON "InventoryItem" ("businessId", "barcode");
