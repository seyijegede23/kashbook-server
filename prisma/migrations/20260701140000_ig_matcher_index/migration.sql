-- Index the auto-payment matcher's per-business "armed conversations" query
-- (runs on every inbound NUBAN credit).
CREATE INDEX IF NOT EXISTS "IgConversation_businessId_expectedAmount_idx"
  ON "IgConversation" ("businessId", "expectedAmount");

-- DB-enforced cap on quick-reply text (the route also validates <= 900).
ALTER TABLE "QuickReply" ALTER COLUMN "text" TYPE VARCHAR(900);
