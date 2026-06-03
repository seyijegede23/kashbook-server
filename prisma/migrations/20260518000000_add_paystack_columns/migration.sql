-- Paystack migration: add Paystack identifiers alongside existing Anchor columns
-- (kept nullable for future cleanup, no destructive ops on existing data).
ALTER TABLE "User" ADD COLUMN "paystackCustomerCode" TEXT;
ALTER TABLE "Business" ADD COLUMN "paystackDvaId" TEXT;
