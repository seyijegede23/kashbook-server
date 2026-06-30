-- Instagram Phase 3: per-business OAuth connection + thin DM cache.
-- Additive + nullable, so existing rows are untouched. IF NOT EXISTS keeps this
-- idempotent (applied directly to the live DB + recorded by `migrate deploy`).

-- ── Business: Instagram connection fields (Path A — Instagram Login) ─────────
ALTER TABLE "Business" ADD COLUMN IF NOT EXISTS "instagramAccessToken"       TEXT;
ALTER TABLE "Business" ADD COLUMN IF NOT EXISTS "instagramBusinessAccountId" TEXT;
ALTER TABLE "Business" ADD COLUMN IF NOT EXISTS "instagramUsername"          TEXT;
ALTER TABLE "Business" ADD COLUMN IF NOT EXISTS "igTokenExpiresAt"           TIMESTAMP(3);
ALTER TABLE "Business" ADD COLUMN IF NOT EXISTS "igConnectionStatus"         TEXT DEFAULT 'disconnected';
ALTER TABLE "Business" ADD COLUMN IF NOT EXISTS "igWebhookSubscribed"        BOOLEAN NOT NULL DEFAULT false;

-- One IG account ↔ one business (webhook routing key). Nullable-unique allows
-- many NULLs but rejects a duplicate claim — closes the connect-callback race.
CREATE UNIQUE INDEX IF NOT EXISTS "Business_instagramBusinessAccountId_key"
  ON "Business" ("instagramBusinessAccountId");

-- ── IgConversation: one row per (business, customer IGSID) ───────────────────
CREATE TABLE IF NOT EXISTS "IgConversation" (
  "id"                  TEXT NOT NULL,
  "businessId"          TEXT NOT NULL,
  "participantIgId"     TEXT NOT NULL,
  "igThreadId"          TEXT,
  "participantUsername" TEXT,
  "lastMessageAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastInboundAt"       TIMESTAMP(3),
  "unread"              BOOLEAN NOT NULL DEFAULT false,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IgConversation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "IgConversation_businessId_participantIgId_key"
  ON "IgConversation" ("businessId", "participantIgId");
CREATE INDEX IF NOT EXISTS "IgConversation_businessId_lastMessageAt_idx"
  ON "IgConversation" ("businessId", "lastMessageAt");

-- ── IgMessage: thin per-message cache ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "IgMessage" (
  "id"             TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "igMessageId"    TEXT NOT NULL,
  "direction"      TEXT NOT NULL,
  "text"           TEXT,
  "sentAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IgMessage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "IgMessage_igMessageId_key" ON "IgMessage" ("igMessageId");
CREATE INDEX IF NOT EXISTS "IgMessage_conversationId_sentAt_idx" ON "IgMessage" ("conversationId", "sentAt");

-- ── Foreign keys (guarded: ADD CONSTRAINT has no IF NOT EXISTS pre-PG16) ──────
DO $$ BEGIN
  ALTER TABLE "IgConversation"
    ADD CONSTRAINT "IgConversation_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "IgMessage"
    ADD CONSTRAINT "IgMessage_conversationId_fkey"
    FOREIGN KEY ("conversationId") REFERENCES "IgConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
