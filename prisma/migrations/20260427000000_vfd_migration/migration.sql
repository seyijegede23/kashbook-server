-- Add User.dateOfBirth (required for VFD individual KYC) and Business.virtualAccountId
-- (VFD's internal account identifier, separate from the NUBAN). Clears any existing
-- Flutterwave virtual-account data so users re-onboard with VFD.

ALTER TABLE "User" ADD COLUMN "dateOfBirth" TIMESTAMP(3);

ALTER TABLE "Business" ADD COLUMN "virtualAccountId" TEXT;

UPDATE "Business" SET
  "virtualAccountRef"    = NULL,
  "virtualAccountNumber" = NULL,
  "virtualAccountBank"   = NULL,
  "virtualAccountName"   = NULL
WHERE "virtualAccountNumber" IS NOT NULL;
