-- Chart of accounts, release 3 (2026-10-13): what a business sells, what it
-- cost, and what is left. Every item is goods or a service. A goods item keeps
-- its quantity and the value of that stock at cost (moving average by entry
-- order: utils/stock.js); a service carries no stock and no cost. Sales get
-- lines (SaleItem), invoice lines may name an item and carry the cost of the
-- goods that left, a bill may restock goods (BillItem), and every change to a
-- goods item's stock is one StockMovement, unique per source line, so a
-- retried request never moves stock twice. The books stay derived from the
-- records (utils/books.js, utils/ledger.js): these are records like the others.
--
-- Money is naira, kobo-exact; quantities have at most three decimals (kg,
-- litre). utils/stock.js does both in whole kobo and thousandths internally.
--
-- The storefront tables still in some databases (Order, OrderItem with its key
-- to InventoryItem, InventoryItem."showInStore") are not in schema.prisma and
-- are left exactly as they are.
--
-- Idempotent throughout.

-- ── Items ───────────────────────────────────────────────────────────────────
-- itemType: goods or service. stockValue: what the stock on hand cost, in
-- naira. avgCost: the last known average cost of one unit, kept when the
-- quantity reaches 0 so a return or a count can use it (null: never known).
-- incomeAccountId: the income account the item's sales count as (null: Sales
-- for goods, Service Income for a service). lowStockNotifiedAt: when the
-- low-stock alert went out (cleared when the quantity rises above the level
-- again), so it goes out once per crossing. archivedAt: an item with history
-- is archived, not deleted. The old "cost" column stays, unused (the release 3
-- backfill reads it once).
ALTER TABLE "InventoryItem" ADD COLUMN IF NOT EXISTS "itemType" TEXT NOT NULL DEFAULT 'goods';
ALTER TABLE "InventoryItem" ADD COLUMN IF NOT EXISTS "stockValue" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "InventoryItem" ADD COLUMN IF NOT EXISTS "avgCost" DOUBLE PRECISION;
ALTER TABLE "InventoryItem" ADD COLUMN IF NOT EXISTS "incomeAccountId" TEXT;
ALTER TABLE "InventoryItem" ADD COLUMN IF NOT EXISTS "lowStockNotifiedAt" TIMESTAMP(3);
ALTER TABLE "InventoryItem" ADD COLUMN IF NOT EXISTS "archivedAt" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "InventoryItem_incomeAccountId_idx" ON "InventoryItem"("incomeAccountId");

-- The quantity becomes a number with decimals (2.5 kg). The phone used to
-- count stock down by itself and could take it below zero; such a count is
-- nothing anyone has, so it starts again at zero.
DO $$ BEGIN
  IF (SELECT data_type FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'InventoryItem' AND column_name = 'quantity') <> 'double precision' THEN
    ALTER TABLE "InventoryItem" ALTER COLUMN "quantity" TYPE DOUBLE PRECISION USING "quantity"::DOUBLE PRECISION;
  END IF;
END $$;
ALTER TABLE "InventoryItem" ALTER COLUMN "quantity" SET DEFAULT 0;
UPDATE "InventoryItem" SET "quantity" = 0 WHERE "quantity" < 0;

-- What the business sells (goods, services or both; null: not asked yet,
-- shown as both).
ALTER TABLE "Business" ADD COLUMN IF NOT EXISTS "sells" TEXT;

-- ── Sale lines ──────────────────────────────────────────────────────────────
-- A sale's lines, fixed once saved. name is a snapshot of the item's name.
-- itemType: goods, service, or other (a typed line that names no item).
-- accountId: the income account the line counts as. unitCost: what one unit
-- cost, null unless the line is goods with a known cost; costAmount: what the
-- goods that left cost (0 for a service, a typed line, or goods of unknown
-- cost).
CREATE TABLE IF NOT EXISTS "SaleItem" (
  "id"         TEXT NOT NULL,
  "saleId"     TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "itemId"     TEXT,
  "name"       TEXT NOT NULL,
  "itemType"   TEXT NOT NULL DEFAULT 'other',
  "quantity"   DOUBLE PRECISION NOT NULL,
  "rate"       DOUBLE PRECISION NOT NULL DEFAULT 0,
  "amount"     DOUBLE PRECISION NOT NULL DEFAULT 0,
  "accountId"  TEXT,
  "unitCost"   DOUBLE PRECISION,
  "costAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "position"   INTEGER NOT NULL DEFAULT 0,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SaleItem_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SaleItem_itemType_check" CHECK ("itemType" IN ('goods', 'service', 'other')),
  -- Real numbers only (NaN and infinity compare above every number in
  -- Postgres, so "> 0" alone lets them through).
  CONSTRAINT "SaleItem_numbers_check" CHECK (
    "quantity" > 0 AND "quantity" < 'Infinity'
    AND "rate" >= 0 AND "rate" < 'Infinity'
    AND "amount" >= 0 AND "amount" < 'Infinity'
    AND "costAmount" >= 0 AND "costAmount" < 'Infinity'
    AND ("unitCost" IS NULL OR ("unitCost" >= 0 AND "unitCost" < 'Infinity')))
);
CREATE INDEX IF NOT EXISTS "SaleItem_saleId_idx" ON "SaleItem"("saleId");
CREATE INDEX IF NOT EXISTS "SaleItem_itemId_idx" ON "SaleItem"("itemId");
CREATE INDEX IF NOT EXISTS "SaleItem_businessId_idx" ON "SaleItem"("businessId");
CREATE INDEX IF NOT EXISTS "SaleItem_accountId_idx" ON "SaleItem"("accountId");

-- ── Invoice lines ───────────────────────────────────────────────────────────
-- The item a line is for (null: a typed line), its type (null on lines from
-- before release 3: other), what one unit cost and what the goods that left
-- cost, and on a credit note whether the goods come back into stock (restock;
-- costAmount is then the cost that came back, positive).
ALTER TABLE "InvoiceItem" ADD COLUMN IF NOT EXISTS "itemId" TEXT;
ALTER TABLE "InvoiceItem" ADD COLUMN IF NOT EXISTS "itemType" TEXT;
ALTER TABLE "InvoiceItem" ADD COLUMN IF NOT EXISTS "unitCost" DOUBLE PRECISION;
ALTER TABLE "InvoiceItem" ADD COLUMN IF NOT EXISTS "costAmount" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "InvoiceItem" ADD COLUMN IF NOT EXISTS "restock" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS "InvoiceItem_itemId_idx" ON "InvoiceItem"("itemId");

-- ── Bill lines (restocks) ───────────────────────────────────────────────────
-- A bill that restocks goods: each line names a goods item, how many came in
-- and what one cost. amount is the line's value, quantity times unitCost to
-- the kobo (utils/stock.js lineCost), and the bill's amount is their sum.
CREATE TABLE IF NOT EXISTS "BillItem" (
  "id"        TEXT NOT NULL,
  "billId"    TEXT NOT NULL,
  "itemId"    TEXT NOT NULL,
  "quantity"  DOUBLE PRECISION NOT NULL,
  "unitCost"  DOUBLE PRECISION NOT NULL DEFAULT 0,
  "amount"    DOUBLE PRECISION NOT NULL DEFAULT 0,
  "position"  INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BillItem_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "BillItem_numbers_check" CHECK (
    "quantity" > 0 AND "quantity" < 'Infinity'
    AND "unitCost" >= 0 AND "unitCost" < 'Infinity'
    AND "amount" >= 0 AND "amount" < 'Infinity')
);
CREATE INDEX IF NOT EXISTS "BillItem_billId_idx" ON "BillItem"("billId");
CREATE INDEX IF NOT EXISTS "BillItem_itemId_idx" ON "BillItem"("itemId");

-- ── Stock movements ─────────────────────────────────────────────────────────
-- Every change to a goods item's stock, dated by the record behind it.
-- quantity and value are signed (in is more than zero, out less); the kinds
-- that only change the value (opening_value, revalue) move no quantity.
-- qtyAfter and valueAfter are what the item held right after, for showing the
-- history (a later removal does not rewrite them). sourceKey names the record
-- line the movement belongs to ("sale:<saleItemId>", "inv:<invoiceItemId>",
-- "bill:<billItemId>", "adj:<uuid>", "open:<itemId>:<n>"), once per business:
-- a retried request finds its movement instead of writing a second one. The
-- item's quantity and stockValue are always the sums of its movements.
CREATE TABLE IF NOT EXISTS "StockMovement" (
  "id"          TEXT NOT NULL,
  "businessId"  TEXT NOT NULL,
  "itemId"      TEXT NOT NULL,
  "kind"        TEXT NOT NULL,
  "reason"      TEXT,
  "date"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "quantity"    DOUBLE PRECISION NOT NULL DEFAULT 0,
  "value"       DOUBLE PRECISION NOT NULL DEFAULT 0,
  "qtyAfter"    DOUBLE PRECISION NOT NULL DEFAULT 0,
  "valueAfter"  DOUBLE PRECISION NOT NULL DEFAULT 0,
  "sourceKey"   TEXT NOT NULL,
  "note"        TEXT,
  "createdById" TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StockMovement_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "StockMovement_kind_check" CHECK ("kind" IN (
    'opening', 'opening_value', 'purchase', 'sale', 'invoice', 'credit_note', 'adjustment', 'revalue')),
  -- Only an adjustment has a reason, and it always has one.
  CONSTRAINT "StockMovement_reason_check" CHECK (
    ("kind" = 'adjustment') = ("reason" IS NOT NULL)
    AND ("reason" IS NULL OR "reason" IN ('damaged', 'expired', 'lost', 'used', 'counted', 'other'))),
  CONSTRAINT "StockMovement_numbers_check" CHECK (
    "quantity" > '-Infinity' AND "quantity" < 'Infinity'
    AND "value" > '-Infinity' AND "value" < 'Infinity'
    AND "qtyAfter" >= 0 AND "qtyAfter" < 'Infinity'
    AND "valueAfter" >= 0 AND "valueAfter" < 'Infinity'),
  -- Each kind moves stock its own way: a value-only kind moves no quantity;
  -- goods coming in (opening, a purchase, a credit note's return) add
  -- quantity and value, goods going out (a sale, an invoice) take them away;
  -- an adjustment goes either way, its value with its quantity or nothing.
  CONSTRAINT "StockMovement_sign_check" CHECK (
    ("kind" IN ('opening_value', 'revalue') AND "quantity" = 0)
    OR ("kind" IN ('opening', 'purchase', 'credit_note') AND "quantity" > 0 AND "value" >= 0)
    OR ("kind" IN ('sale', 'invoice') AND "quantity" < 0 AND "value" <= 0)
    OR ("kind" = 'adjustment' AND "quantity" <> 0 AND "value" * "quantity" >= 0))
);
CREATE UNIQUE INDEX IF NOT EXISTS "StockMovement_businessId_sourceKey_key" ON "StockMovement"("businessId", "sourceKey");
CREATE INDEX IF NOT EXISTS "StockMovement_businessId_date_idx" ON "StockMovement"("businessId", "date");
CREATE INDEX IF NOT EXISTS "StockMovement_itemId_createdAt_idx" ON "StockMovement"("itemId", "createdAt");

DO $$ BEGIN
  -- Items.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'InventoryItem_itemType_check') THEN
    ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_itemType_check"
      CHECK ("itemType" IN ('goods', 'service'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'InventoryItem_quantity_check') THEN
    ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_quantity_check"
      CHECK ("quantity" >= 0 AND "quantity" < 'Infinity');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'InventoryItem_stockValue_check') THEN
    ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_stockValue_check"
      CHECK ("stockValue" >= 0 AND "stockValue" < 'Infinity');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'InventoryItem_avgCost_check') THEN
    ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_avgCost_check"
      CHECK ("avgCost" IS NULL OR ("avgCost" >= 0 AND "avgCost" < 'Infinity'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'InventoryItem_incomeAccountId_fkey') THEN
    ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_incomeAccountId_fkey"
      FOREIGN KEY ("incomeAccountId") REFERENCES "LedgerAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  -- What the business sells.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Business_sells_check') THEN
    ALTER TABLE "Business" ADD CONSTRAINT "Business_sells_check"
      CHECK ("sells" IS NULL OR "sells" IN ('goods', 'services', 'both'));
  END IF;

  -- Sale lines go with their sale (the route puts their goods back first).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SaleItem_saleId_fkey') THEN
    ALTER TABLE "SaleItem" ADD CONSTRAINT "SaleItem_saleId_fkey"
      FOREIGN KEY ("saleId") REFERENCES "Sales"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SaleItem_businessId_fkey') THEN
    ALTER TABLE "SaleItem" ADD CONSTRAINT "SaleItem_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SaleItem_itemId_fkey') THEN
    ALTER TABLE "SaleItem" ADD CONSTRAINT "SaleItem_itemId_fkey"
      FOREIGN KEY ("itemId") REFERENCES "InventoryItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SaleItem_accountId_fkey') THEN
    ALTER TABLE "SaleItem" ADD CONSTRAINT "SaleItem_accountId_fkey"
      FOREIGN KEY ("accountId") REFERENCES "LedgerAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  -- Invoice lines.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'InvoiceItem_itemType_check') THEN
    ALTER TABLE "InvoiceItem" ADD CONSTRAINT "InvoiceItem_itemType_check"
      CHECK ("itemType" IS NULL OR "itemType" IN ('goods', 'service', 'other'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'InvoiceItem_cost_check') THEN
    ALTER TABLE "InvoiceItem" ADD CONSTRAINT "InvoiceItem_cost_check"
      CHECK ("costAmount" >= 0 AND "costAmount" < 'Infinity'
        AND ("unitCost" IS NULL OR ("unitCost" >= 0 AND "unitCost" < 'Infinity')));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'InvoiceItem_itemId_fkey') THEN
    ALTER TABLE "InvoiceItem" ADD CONSTRAINT "InvoiceItem_itemId_fkey"
      FOREIGN KEY ("itemId") REFERENCES "InventoryItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  -- Bill lines go with their bill (the route takes their goods out first).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BillItem_billId_fkey') THEN
    ALTER TABLE "BillItem" ADD CONSTRAINT "BillItem_billId_fkey"
      FOREIGN KEY ("billId") REFERENCES "BusinessDebt"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BillItem_itemId_fkey') THEN
    -- An item a restock names is never deleted (the app archives it instead).
    -- The check waits for the end of the transaction (DEFERRABLE INITIALLY
    -- DEFERRED), as for a journal line's account: deleting an owner removes
    -- their items, and their bills' lines through the bills, in one
    -- statement, and an immediate check (RESTRICT) would run as the items go,
    -- while the lines are still there, and refuse the whole deletion.
    -- Deleting an item a line still names is refused all the same, at COMMIT.
    ALTER TABLE "BillItem" ADD CONSTRAINT "BillItem_itemId_fkey"
      FOREIGN KEY ("itemId") REFERENCES "InventoryItem"("id") ON DELETE NO ACTION ON UPDATE CASCADE
      DEFERRABLE INITIALLY DEFERRED;
  END IF;

  -- Movements go with their business, and with their item (an item with
  -- movements is archived, never deleted, by the routes).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'StockMovement_businessId_fkey') THEN
    ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'StockMovement_itemId_fkey') THEN
    ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_itemId_fkey"
      FOREIGN KEY ("itemId") REFERENCES "InventoryItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
