-- Euro → naira conversions.
--
-- Additive only: one new table, no change to anything existing. This DB is
-- shared with another deployed app running older code; it never reads this
-- table, so nothing here can affect it.
--
-- One row per conversion attempt, from quote to naira landing. It exists
-- because the ledger alone cannot describe the failure that matters most: the
-- euros have left the merchant's balance (conversion succeeded at Fincra) but
-- the naira payout to their NUBAN failed. Without a durable record of that
-- state the money would sit in KashBook's Fincra naira wallet with nothing to
-- say who it belongs to. The reconcile loop drives rows out of that state.
--
-- Both references are unique so a retry can never send a second payout or a
-- second conversion for the same row: Fincra dedups on customerReference and
-- so do we.
CREATE TABLE IF NOT EXISTS "FcyConversion" (
  "id"                       TEXT NOT NULL,
  "businessId"               TEXT NOT NULL,
  "userId"                   TEXT,
  "sourceCurrency"           TEXT NOT NULL,
  "destinationCurrency"      TEXT NOT NULL DEFAULT 'NGN',
  -- What the merchant asked to convert, in the source currency. This is the
  -- amount debited from their FCY ledger balance.
  "sourceAmount"             DOUBLE PRECISION NOT NULL,
  -- Anything Fincra charged on the source side beyond sourceAmount.
  "fee"                      DOUBLE PRECISION NOT NULL DEFAULT 0,
  "rate"                     DOUBLE PRECISION NOT NULL,
  -- What Fincra delivers to our naira wallet, and what the merchant gets after
  -- the (default zero) KashBook margin. Kept separately so the margin is
  -- auditable per row rather than inferred.
  "grossDestinationAmount"   DOUBLE PRECISION NOT NULL,
  "destinationAmount"        DOUBLE PRECISION NOT NULL,
  "marginBps"                INTEGER NOT NULL DEFAULT 0,
  -- quoted | converting | converted | paying_out | paid | payout_failed |
  -- failed | needs_review
  "status"                   TEXT NOT NULL DEFAULT 'quoted',
  "quoteReference"           TEXT NOT NULL,
  "quoteExpiresAt"           TIMESTAMP(3) NOT NULL,
  "customerReference"        TEXT NOT NULL,
  "conversionReference"      TEXT,
  "payoutCustomerReference"  TEXT NOT NULL,
  "payoutReference"          TEXT,
  -- Snapshot of where the naira goes, taken at quote time and name-verified,
  -- so what the merchant confirmed is exactly what is paid.
  "payoutAccountNumber"      TEXT NOT NULL,
  "payoutBankCode"           TEXT NOT NULL,
  "payoutBankName"           TEXT,
  "payoutAccountName"        TEXT,
  "error"                    TEXT,
  "convertedAt"              TIMESTAMP(3),
  "paidAt"                   TIMESTAMP(3),
  "createdAt"                TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"                TIMESTAMP(3) NOT NULL,
  CONSTRAINT "FcyConversion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "FcyConversion_customerReference_key"
  ON "FcyConversion" ("customerReference");
CREATE UNIQUE INDEX IF NOT EXISTS "FcyConversion_payoutCustomerReference_key"
  ON "FcyConversion" ("payoutCustomerReference");
CREATE INDEX IF NOT EXISTS "FcyConversion_businessId_createdAt_idx"
  ON "FcyConversion" ("businessId", "createdAt");
CREATE INDEX IF NOT EXISTS "FcyConversion_status_idx"
  ON "FcyConversion" ("status");

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'FcyConversion_businessId_fkey'
  ) THEN
    ALTER TABLE "FcyConversion"
      ADD CONSTRAINT "FcyConversion_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
