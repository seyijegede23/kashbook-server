-- Instagram auto-replies: per-business greeting + keyword rules.
CREATE TABLE IF NOT EXISTS "IgAutoReply" (
  "id"         TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "kind"       TEXT NOT NULL,
  "keyword"    TEXT,
  "text"       VARCHAR(900) NOT NULL,
  "enabled"    BOOLEAN NOT NULL DEFAULT true,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IgAutoReply_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "IgAutoReply_businessId_idx" ON "IgAutoReply" ("businessId");

DO $$ BEGIN
  ALTER TABLE "IgAutoReply"
    ADD CONSTRAINT "IgAutoReply_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
