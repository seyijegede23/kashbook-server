-- Savings: pots ring-fenced in the merchant's own Anchor account today,
-- PiggyVest Business wallets when the partner keys arrive.
--
-- Additive only. This DB is shared with another deployed app running older
-- code: three new tables it never reads, and ONE nullable column on
-- "Transaction" that it never selects by name. Nothing existing is altered,
-- renamed, retyped or dropped.
--
-- Transaction.purpose marks the bank rows that savings created (a deposit to a
-- PiggyVest wallet, the withdrawal landing back, interest). Reporting
-- aggregates exclude those rows because moving your own money into your own
-- savings is neither an expense nor a sale; the ledger balance keeps them
-- because the money really did leave or land on the account.
ALTER TABLE "Transaction" ADD COLUMN IF NOT EXISTS "purpose" TEXT;

-- One PiggyVest customer per business. Created on the first PiggyVest pot,
-- never before, so a merchant who only ring-fences never touches the partner.
CREATE TABLE IF NOT EXISTS "SavingsProfile" (
  "id"                 TEXT NOT NULL,
  "businessId"         TEXT NOT NULL,
  "pvCustomerId"       TEXT,
  "pvDefaultWalletId"  TEXT,
  -- pending | ready | error
  "status"             TEXT NOT NULL DEFAULT 'pending',
  "error"              TEXT,
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"          TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SavingsProfile_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "SavingsProfile_businessId_key"
  ON "SavingsProfile" ("businessId");

-- A pot. `backing` says where the money is:
--   ledger     in the Anchor account; `balance` is the truth and the spend
--              gate subtracts the sum of active ledger pots from the bank
--              balance.
--   piggyvest  in a PiggyVest wallet; `balance` is a copy synced from the
--              partner and is never incremented locally.
CREATE TABLE IF NOT EXISTS "SavingsPot" (
  "id"                    TEXT NOT NULL,
  "businessId"            TEXT NOT NULL,
  "userId"                TEXT NOT NULL,
  "name"                  TEXT NOT NULL,
  "targetAmount"          DOUBLE PRECISION,
  -- ledger | piggyvest
  "backing"               TEXT NOT NULL,
  -- provisioning | active | error | closed
  "status"                TEXT NOT NULL DEFAULT 'active',
  "balance"               DOUBLE PRECISION NOT NULL DEFAULT 0,
  "pvWalletId"            TEXT,
  "pvAccountNumber"       TEXT,
  "pvBankName"            TEXT,
  "pvBankCode"            TEXT,
  "pvAccountName"         TEXT,
  "interestRate"          DOUBLE PRECISION,
  "interestAccruedMtd"    DOUBLE PRECISION NOT NULL DEFAULT 0,
  "interestEarned"        DOUBLE PRECISION NOT NULL DEFAULT 0,
  -- Bank withdrawals this calendar month (PiggyVest forfeits the month's
  -- interest on the fifth). `withdrawalMonth` is the YYYY-MM the count is for.
  "withdrawalCountMonth"  INTEGER NOT NULL DEFAULT 0,
  "withdrawalMonth"       TEXT,
  "lockUntil"             TIMESTAMP(3),
  -- strict | flexible | NULL
  "lockMode"              TEXT,
  "error"                 TEXT,
  "closedAt"              TIMESTAMP(3),
  "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"             TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SavingsPot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "SavingsPot_pvWalletId_key"
  ON "SavingsPot" ("pvWalletId");
CREATE INDEX IF NOT EXISTS "SavingsPot_businessId_status_idx"
  ON "SavingsPot" ("businessId", "status");
CREATE INDEX IF NOT EXISTS "SavingsPot_pvAccountNumber_idx"
  ON "SavingsPot" ("pvAccountNumber");

-- Every movement of money into or out of a pot. `reference` is our own
-- idempotency key and is unique, so a retried deposit can never send twice;
-- `pvTxnId` is the partner's id for inflows, interest and external deposits,
-- unique so the reconcile loop books each partner transaction once.
CREATE TABLE IF NOT EXISTS "SavingsMovement" (
  "id"                   TEXT NOT NULL,
  "potId"                TEXT NOT NULL,
  "businessId"           TEXT NOT NULL,
  "userId"               TEXT,
  -- deposit | withdrawal | interest | external_deposit
  "type"                 TEXT NOT NULL,
  -- ledger | piggyvest
  "backing"              TEXT NOT NULL,
  "amount"               DOUBLE PRECISION NOT NULL,
  "fee"                  DOUBLE PRECISION NOT NULL DEFAULT 0,
  "landedAmount"         DOUBLE PRECISION,
  -- ledger:      completed
  -- pv deposit:  initiated | sent | completed | failed | unknown | needs_review
  -- pv withdraw: requested | processing | completed | failed | unknown | needs_review
  -- interest / external_deposit: completed
  "status"               TEXT NOT NULL,
  "reference"            TEXT NOT NULL,
  "transactionId"        TEXT,
  "landedTransactionId"  TEXT,
  "providerTransferId"   TEXT,
  "pvReference"          TEXT,
  "pvTxnId"              TEXT,
  "payoutAccountNumber"  TEXT,
  "payoutBankCode"       TEXT,
  "narration"            TEXT,
  "error"                TEXT,
  -- Reconcile bookkeeping for withdrawals: how many consecutive verify calls
  -- said "no such transaction" (two, ten minutes apart, means the request
  -- never reached PiggyVest) and when the last one ran.
  "verifyMisses"         INTEGER NOT NULL DEFAULT 0,
  "lastVerifiedAt"       TIMESTAMP(3),
  -- Early-withdrawal fee on a flexible lock: `fee` is what was charged, this
  -- is when it was swept to KashBook's fee account (a claim, set before the
  -- book transfer so it can never be collected twice).
  "feeCollectedAt"       TIMESTAMP(3),
  "completedAt"          TIMESTAMP(3),
  "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"            TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SavingsMovement_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "SavingsMovement_reference_key"
  ON "SavingsMovement" ("reference");
CREATE UNIQUE INDEX IF NOT EXISTS "SavingsMovement_transactionId_key"
  ON "SavingsMovement" ("transactionId");
CREATE UNIQUE INDEX IF NOT EXISTS "SavingsMovement_landedTransactionId_key"
  ON "SavingsMovement" ("landedTransactionId");
CREATE UNIQUE INDEX IF NOT EXISTS "SavingsMovement_pvTxnId_key"
  ON "SavingsMovement" ("pvTxnId");
CREATE INDEX IF NOT EXISTS "SavingsMovement_potId_createdAt_idx"
  ON "SavingsMovement" ("potId", "createdAt");
CREATE INDEX IF NOT EXISTS "SavingsMovement_businessId_createdAt_idx"
  ON "SavingsMovement" ("businessId", "createdAt");
CREATE INDEX IF NOT EXISTS "SavingsMovement_status_idx"
  ON "SavingsMovement" ("status");
CREATE INDEX IF NOT EXISTS "SavingsMovement_providerTransferId_idx"
  ON "SavingsMovement" ("providerTransferId");

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'SavingsProfile_businessId_fkey'
  ) THEN
    ALTER TABLE "SavingsProfile"
      ADD CONSTRAINT "SavingsProfile_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

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
