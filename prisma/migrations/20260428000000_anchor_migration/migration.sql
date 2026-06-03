-- Anchor migration: Customer→DepositAccount model
-- Adds anchor identifiers + KYC tracking. Renames the bank account-type field
-- to "bankAccountType" to avoid collision with User.accountType (OWNER/STAFF).
-- Clears any VFD virtual-account data so users re-onboard against Anchor.

ALTER TABLE "User"
  ADD COLUMN "anchorCustomerId" TEXT,
  ADD COLUMN "kycStatus" TEXT NOT NULL DEFAULT 'unverified';

ALTER TABLE "Business"
  ADD COLUMN "anchorAccountId" TEXT,
  ADD COLUMN "bankAccountType" TEXT NOT NULL DEFAULT 'SAVINGS';

UPDATE "Business" SET
  "virtualAccountRef"    = NULL,
  "virtualAccountId"     = NULL,
  "virtualAccountNumber" = NULL,
  "virtualAccountBank"   = NULL,
  "virtualAccountName"   = NULL
WHERE "virtualAccountNumber" IS NOT NULL;
