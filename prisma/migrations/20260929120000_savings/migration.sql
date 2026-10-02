-- Savings: pots ring-fenced in the merchant's own Anchor account.
--
-- Additive only. This DB is shared with another deployed app running older
-- code: two new tables it never reads, and ONE nullable column on
-- "Transaction" that it never selects by name. Nothing existing is altered,
-- renamed, retyped or dropped.
--
-- Transaction.purpose marks the bank rows the savings feature creates. Today
-- that is only "savings_fee", the early-withdrawal charge swept to KashBook's
-- fee account. Reporting aggregates exclude rows carrying a purpose because
-- they are not trade; the ledger balance keeps them because the money really
-- left the account.
ALTER TABLE "Transaction" ADD COLUMN IF NOT EXISTS "purpose" TEXT;

-- A pot. Nothing moves: `balance` is a reserve that every spend path subtracts
-- from the bank balance before it lets money out.
CREATE TABLE IF NOT EXISTS "SavingsPot" (
  "id"            TEXT NOT NULL,
  "businessId"    TEXT NOT NULL,
  "userId"        TEXT NOT NULL,
  "name"          TEXT NOT NULL,
  "targetAmount"  DOUBLE PRECISION,
  -- active | closed
  "status"        TEXT NOT NULL DEFAULT 'active',
  "balance"       DOUBLE PRECISION NOT NULL DEFAULT 0,
  "lockUntil"     TIMESTAMP(3),
  -- strict | flexible | NULL
  "lockMode"      TEXT,
  "closedAt"      TIMESTAMP(3),
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SavingsPot_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "SavingsPot_businessId_status_idx"
  ON "SavingsPot" ("businessId", "status");

-- Every movement of money into or out of a pot. `reference` is the client's
-- idempotency key (kb_sv_… deposits, kb_svw_… withdrawals) and is unique, so a
-- retried request answers with the row it already made. `fee` is the
-- early-withdrawal charge and `feeCollectedAt` is when it was swept (a claim,
-- set before the book transfer so it can never be collected twice).
CREATE TABLE IF NOT EXISTS "SavingsMovement" (
  "id"              TEXT NOT NULL,
  "potId"           TEXT NOT NULL,
  "businessId"      TEXT NOT NULL,
  "userId"          TEXT,
  -- deposit | withdrawal
  "type"            TEXT NOT NULL,
  "amount"          DOUBLE PRECISION NOT NULL,
  "fee"             DOUBLE PRECISION NOT NULL DEFAULT 0,
  "status"          TEXT NOT NULL DEFAULT 'completed',
  "reference"       TEXT NOT NULL,
  "feeCollectedAt"  TIMESTAMP(3),
  "completedAt"     TIMESTAMP(3),
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SavingsMovement_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "SavingsMovement_reference_key"
  ON "SavingsMovement" ("reference");
CREATE INDEX IF NOT EXISTS "SavingsMovement_potId_createdAt_idx"
  ON "SavingsMovement" ("potId", "createdAt");
CREATE INDEX IF NOT EXISTS "SavingsMovement_businessId_createdAt_idx"
  ON "SavingsMovement" ("businessId", "createdAt");

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'SavingsPot_businessId_fkey'
  ) THEN
    ALTER TABLE "SavingsPot"
      ADD CONSTRAINT "SavingsPot_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'SavingsMovement_potId_fkey'
  ) THEN
    ALTER TABLE "SavingsMovement"
      ADD CONSTRAINT "SavingsMovement_potId_fkey"
      FOREIGN KEY ("potId") REFERENCES "SavingsPot"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'SavingsMovement_businessId_fkey'
  ) THEN
    ALTER TABLE "SavingsMovement"
      ADD CONSTRAINT "SavingsMovement_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
