-- Stable conversation → customer link (avoids fragile display-name matching).
ALTER TABLE "IgConversation" ADD COLUMN IF NOT EXISTS "customerId" TEXT;

CREATE INDEX IF NOT EXISTS "IgConversation_customerId_idx" ON "IgConversation" ("customerId");

DO $$ BEGIN
  ALTER TABLE "IgConversation"
    ADD CONSTRAINT "IgConversation_customerId_fkey"
    FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
