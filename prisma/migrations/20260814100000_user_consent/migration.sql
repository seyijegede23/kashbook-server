-- ADDITIVE ONLY (shared database). marketingOptIn defaults false so existing
-- rows read as "no consent given", which is the correct and safe default: we
-- must never infer marketing consent from an account that predates the checkbox.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "marketingOptIn"  BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "termsAcceptedAt" TIMESTAMP(3);
