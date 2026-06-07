-- Multi-country foundation: country is the single setting that locks currency,
-- KYC scheme, AML thresholds, region picker, bank list, etc. Existing users
-- backfill to Nigeria so nothing changes for them.

-- User
ALTER TABLE "User" ADD COLUMN "country" TEXT NOT NULL DEFAULT 'NG';

-- Business
ALTER TABLE "Business" ADD COLUMN "country"      TEXT NOT NULL DEFAULT 'NG';
ALTER TABLE "Business" ADD COLUMN "baseCurrency" TEXT NOT NULL DEFAULT 'NGN';
ALTER TABLE "Business" ADD COLUMN "kycId"        TEXT;
ALTER TABLE "Business" ADD COLUMN "kycIdType"    TEXT NOT NULL DEFAULT 'BVN';

-- BusinessOfficer
ALTER TABLE "BusinessOfficer" ADD COLUMN "idType" TEXT NOT NULL DEFAULT 'BVN';

-- Transaction
ALTER TABLE "Transaction" ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'NGN';

-- Backfill explicit NGN on every historical row (defensive — defaults already
-- handle this but we want the values written explicitly so dashboards never
-- see "default-implicit" rows).
UPDATE "Transaction" SET "currency" = 'NGN' WHERE "currency" IS NULL OR "currency" = '';
