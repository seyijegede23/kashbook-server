-- Quick replies: per-business saved canned messages for one-tap IG DM replies.
CREATE TABLE IF NOT EXISTS "QuickReply" (
  "id"         TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "text"       TEXT NOT NULL,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "QuickReply_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "QuickReply_businessId_idx" ON "QuickReply" ("businessId");

DO $$ BEGIN
  ALTER TABLE "QuickReply"
    ADD CONSTRAINT "QuickReply_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
