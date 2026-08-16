-- ADDITIVE ONLY. The kashbook database is SHARED with another deployed app
-- (idealroyalcrown.com) running older code. Nothing existing is altered or
-- dropped: this is one brand-new table that app has never heard of. Its Prisma
-- client selects explicit column lists, so a table it does not know about is
-- invisible to it.
--
-- The one place this touches an existing table is a FOREIGN KEY *from* the new
-- table *to* "Business". That adds no column and changes no existing row; the
-- only behavioural effect is that deleting a Business now also deletes its
-- pending requests, which is what we want and which cannot fire for the sibling
-- app because it never writes rows here.

CREATE TABLE IF NOT EXISTS "StaffTransferRequest" (
  "id"                    TEXT NOT NULL,
  "businessId"            TEXT NOT NULL,
  "requestedById"         TEXT NOT NULL,
  "ownerId"               TEXT NOT NULL,
  "accountNumber"         TEXT NOT NULL,
  "bankCode"              TEXT NOT NULL,
  "bankName"              TEXT,
  "accountName"           TEXT,
  "amount"                DOUBLE PRECISION NOT NULL,
  "narration"             TEXT,
  "currency"              TEXT NOT NULL DEFAULT 'NGN',
  "status"                TEXT NOT NULL DEFAULT 'pending',
  "reason"                TEXT,
  "idempotencyKey"        TEXT NOT NULL,
  "capAtRequest"          DOUBLE PRECISION,
  "spentAtRequest"        DOUBLE PRECISION,
  "decidedById"           TEXT,
  "decidedAt"             TIMESTAMP(3),
  "executedTransactionId" TEXT,
  "executedReference"     TEXT,
  "failureReason"         TEXT,
  "expiresAt"             TIMESTAMP(3) NOT NULL,
  "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"             TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StaffTransferRequest_pkey" PRIMARY KEY ("id")
);

-- The unique key is the second line of defence against a double-send: even if
-- the atomic status claim were ever weakened, the executor's reference lookup
-- and this constraint both still stand between an approval and a second payout.
CREATE UNIQUE INDEX IF NOT EXISTS "StaffTransferRequest_idempotencyKey_key"
  ON "StaffTransferRequest"("idempotencyKey");

CREATE INDEX IF NOT EXISTS "StaffTransferRequest_ownerId_status_idx"
  ON "StaffTransferRequest"("ownerId", "status");
CREATE INDEX IF NOT EXISTS "StaffTransferRequest_businessId_status_idx"
  ON "StaffTransferRequest"("businessId", "status");
CREATE INDEX IF NOT EXISTS "StaffTransferRequest_requestedById_status_idx"
  ON "StaffTransferRequest"("requestedById", "status");
-- Drives the expiry reaper, which scans by (status, expiresAt) every tick.
CREATE INDEX IF NOT EXISTS "StaffTransferRequest_status_expiresAt_idx"
  ON "StaffTransferRequest"("status", "expiresAt");

DO $$ BEGIN
  ALTER TABLE "StaffTransferRequest"
    ADD CONSTRAINT "StaffTransferRequest_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
