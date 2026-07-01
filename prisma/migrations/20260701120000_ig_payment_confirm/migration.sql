-- Instagram auto payment confirmation: track an expected payment amount per
-- conversation so an inbound NUBAN credit can be matched and auto-confirmed in
-- the DM. Additive + nullable + idempotent (IF NOT EXISTS).
ALTER TABLE "IgConversation" ADD COLUMN IF NOT EXISTS "expectedAmount"         DOUBLE PRECISION;
ALTER TABLE "IgConversation" ADD COLUMN IF NOT EXISTS "expectedSince"          TIMESTAMP(3);
ALTER TABLE "IgConversation" ADD COLUMN IF NOT EXISTS "lastPaymentConfirmedAt" TIMESTAMP(3);
