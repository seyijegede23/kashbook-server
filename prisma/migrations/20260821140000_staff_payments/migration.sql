-- ADDITIVE ONLY. The kashbook database is SHARED with another deployed app
-- (idealroyalcrown.com) running older code. Nothing existing is altered or
-- dropped: these are two brand-new tables that app has never heard of. Its
-- Prisma client selects explicit column lists, so tables it does not know about
-- are invisible to it.
--
-- In particular "User" is NOT touched. The payout bank details live on
-- SalarySchedule, which is also why "staffUserId" below is a bare TEXT with no
-- foreign key: staff are HARD deleted (auth.js DELETE /staff/:id), so an FK
-- would either cascade payment history into oblivion or block the delete.
--
-- The only contact with an existing table is a FOREIGN KEY *from* the new
-- tables *to* "Business". That adds no column and changes no existing row.

CREATE TABLE IF NOT EXISTS "SalarySchedule" (
  "id"                       TEXT NOT NULL,
  "businessId"               TEXT NOT NULL,
  "ownerId"                  TEXT NOT NULL,
  "staffUserId"              TEXT NOT NULL,
  "staffNameSnapshot"        TEXT NOT NULL,
  "payoutKind"               TEXT NOT NULL DEFAULT 'external_bank',
  "accountNumber"            TEXT NOT NULL,
  "bankCode"                 TEXT NOT NULL,
  "bankName"                 TEXT,
  "accountName"              TEXT NOT NULL,
  "nameVerified"             BOOLEAN NOT NULL DEFAULT false,
  "amount"                   DOUBLE PRECISION NOT NULL,
  "currency"                 TEXT NOT NULL DEFAULT 'NGN',
  "frequency"                TEXT NOT NULL DEFAULT 'monthly',
  "anchorDay"                INTEGER NOT NULL,
  "businessDayRule"          TEXT NOT NULL DEFAULT 'before',
  "nextRunDate"              TIMESTAMP(3) NOT NULL,
  "authorizedAt"             TIMESTAMP(3) NOT NULL,
  "authorizedAmount"         DOUBLE PRECISION NOT NULL,
  "authorizedPayee"          TEXT NOT NULL,
  "status"                   TEXT NOT NULL DEFAULT 'active',
  "pausedReason"             TEXT,
  "consecutiveUnpaidPeriods" INTEGER NOT NULL DEFAULT 0,
  "lastRunAt"                TIMESTAMP(3),
  "lastRunStatus"            TEXT,
  "createdAt"                TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"                TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SalarySchedule_pkey" PRIMARY KEY ("id")
);

-- One salary per person, enforced by the database rather than by application
-- logic. Scoped to the OWNER, not the business: a staff member has exactly one
-- employer, so a two-business owner must not be able to schedule them twice.
CREATE UNIQUE INDEX IF NOT EXISTS "SalarySchedule_ownerId_staffUserId_key"
  ON "SalarySchedule"("ownerId", "staffUserId");
CREATE INDEX IF NOT EXISTS "SalarySchedule_status_nextRunDate_idx"
  ON "SalarySchedule"("status", "nextRunDate");
CREATE INDEX IF NOT EXISTS "SalarySchedule_ownerId_status_idx"
  ON "SalarySchedule"("ownerId", "status");
CREATE INDEX IF NOT EXISTS "SalarySchedule_businessId_status_idx"
  ON "SalarySchedule"("businessId", "status");

CREATE TABLE IF NOT EXISTS "SalaryPayment" (
  "id"                    TEXT NOT NULL,
  "scheduleId"            TEXT NOT NULL,
  "businessId"            TEXT NOT NULL,
  "ownerId"               TEXT NOT NULL,
  "staffUserId"           TEXT NOT NULL,
  "staffNameSnapshot"     TEXT NOT NULL,
  "amount"                DOUBLE PRECISION NOT NULL,
  "currency"              TEXT NOT NULL DEFAULT 'NGN',
  "payoutKind"            TEXT NOT NULL DEFAULT 'external_bank',
  "accountNumber"         TEXT NOT NULL,
  "bankCode"              TEXT NOT NULL,
  "bankName"              TEXT,
  "accountName"           TEXT,
  "nameVerified"          BOOLEAN NOT NULL DEFAULT false,
  "periodKey"             TEXT NOT NULL,
  "scheduledFor"          TIMESTAMP(3) NOT NULL,
  "status"                TEXT NOT NULL DEFAULT 'pending',
  "reason"                TEXT,
  "failureReason"         TEXT,
  "owed"                  BOOLEAN NOT NULL DEFAULT true,
  "reference"             TEXT NOT NULL,
  "claimToken"            TEXT,
  "expiresAt"             TIMESTAMP(3) NOT NULL,
  "decidedById"           TEXT,
  "decidedAt"             TIMESTAMP(3),
  "paidAt"                TIMESTAMP(3),
  "executedTransactionId" TEXT,
  "executedReference"     TEXT,
  "feeCharged"            DOUBLE PRECISION,
  "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"             TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SalaryPayment_pkey" PRIMARY KEY ("id")
);

-- THE anti-double-pay constraint: one payment per person per period, forever,
-- enforced by Postgres. A schedule paused for three months and resumed can only
-- ever produce named periods — never one payment per daily cron tick.
CREATE UNIQUE INDEX IF NOT EXISTS "SalaryPayment_scheduleId_periodKey_key"
  ON "SalaryPayment"("scheduleId", "periodKey");
-- Second line of defence: the payout reference is unique per business, and is
-- the same string handed to executeTransfer, landing under
-- Transaction @@unique([businessId, reference]).
CREATE UNIQUE INDEX IF NOT EXISTS "SalaryPayment_businessId_reference_key"
  ON "SalaryPayment"("businessId", "reference");
CREATE INDEX IF NOT EXISTS "SalaryPayment_ownerId_status_idx"
  ON "SalaryPayment"("ownerId", "status");
CREATE INDEX IF NOT EXISTS "SalaryPayment_status_expiresAt_idx"
  ON "SalaryPayment"("status", "expiresAt");
CREATE INDEX IF NOT EXISTS "SalaryPayment_businessId_status_idx"
  ON "SalaryPayment"("businessId", "status");

DO $$ BEGIN
  ALTER TABLE "SalarySchedule" ADD CONSTRAINT "SalarySchedule_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "SalaryPayment" ADD CONSTRAINT "SalaryPayment_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
