-- Per-business VAT summary settings. Off by default; vatRate null falls back
-- to the country's rate; amounts treated as VAT-inclusive by default.
ALTER TABLE "Business" ADD COLUMN "vatEnabled"   BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Business" ADD COLUMN "vatRate"      DOUBLE PRECISION;
ALTER TABLE "Business" ADD COLUMN "vatInclusive" BOOLEAN NOT NULL DEFAULT true;
