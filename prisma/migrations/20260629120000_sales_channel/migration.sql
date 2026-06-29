-- Sales channel tracking: which channel a sale came from (instagram, whatsapp,
-- walk-in, online, other). Additive + nullable, so existing rows are untouched.
-- IF NOT EXISTS keeps this idempotent (applied directly + recorded by migrate deploy).
ALTER TABLE "Sales" ADD COLUMN IF NOT EXISTS "channel" TEXT;
ALTER TABLE "Transaction" ADD COLUMN IF NOT EXISTS "channel" TEXT;

CREATE INDEX IF NOT EXISTS "Sales_businessId_channel_idx" ON "Sales" ("businessId", "channel");
CREATE INDEX IF NOT EXISTS "Transaction_businessId_channel_idx" ON "Transaction" ("businessId", "channel");
