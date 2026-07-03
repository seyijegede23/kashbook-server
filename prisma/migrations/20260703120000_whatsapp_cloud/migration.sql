-- WhatsApp Business (Cloud API) integration: per-business connection + DM cache.
-- Additive + idempotent (IF NOT EXISTS), mirroring the instagram_phase3 migration.

-- ── Business: WhatsApp connection fields ─────────────────────────────────────
ALTER TABLE "Business" ADD COLUMN IF NOT EXISTS "waAccessToken"       TEXT;
ALTER TABLE "Business" ADD COLUMN IF NOT EXISTS "wabaId"              TEXT;
ALTER TABLE "Business" ADD COLUMN IF NOT EXISTS "waPhoneNumberId"     TEXT;
ALTER TABLE "Business" ADD COLUMN IF NOT EXISTS "waPhoneNumber"       TEXT;
ALTER TABLE "Business" ADD COLUMN IF NOT EXISTS "waConnectionStatus"  TEXT DEFAULT 'disconnected';
ALTER TABLE "Business" ADD COLUMN IF NOT EXISTS "waWebhookSubscribed" BOOLEAN NOT NULL DEFAULT false;

-- One phone-number-id ↔ one business (webhook routing key; closes the claim race).
CREATE UNIQUE INDEX IF NOT EXISTS "Business_waPhoneNumberId_key"
  ON "Business" ("waPhoneNumberId");

-- ── WaConversation ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "WaConversation" (
  "id"                     TEXT NOT NULL,
  "businessId"             TEXT NOT NULL,
  "participantPhone"       TEXT NOT NULL,
  "participantName"        TEXT,
  "customerId"             TEXT,
  "lastMessageAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastInboundAt"          TIMESTAMP(3),
  "expectedAmount"         DOUBLE PRECISION,
  "expectedSince"          TIMESTAMP(3),
  "lastPaymentConfirmedAt" TIMESTAMP(3),
  "unread"                 BOOLEAN NOT NULL DEFAULT false,
  "createdAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WaConversation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "WaConversation_businessId_participantPhone_key"
  ON "WaConversation" ("businessId", "participantPhone");
CREATE INDEX IF NOT EXISTS "WaConversation_businessId_lastMessageAt_idx"
  ON "WaConversation" ("businessId", "lastMessageAt");
CREATE INDEX IF NOT EXISTS "WaConversation_businessId_expectedAmount_idx"
  ON "WaConversation" ("businessId", "expectedAmount");
CREATE INDEX IF NOT EXISTS "WaConversation_customerId_idx"
  ON "WaConversation" ("customerId");

-- ── WaMessage ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "WaMessage" (
  "id"             TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "waMessageId"    TEXT NOT NULL,
  "direction"      TEXT NOT NULL,
  "text"           TEXT,
  "attachmentUrl"  TEXT,
  "sentAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WaMessage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "WaMessage_waMessageId_key" ON "WaMessage" ("waMessageId");
CREATE INDEX IF NOT EXISTS "WaMessage_conversationId_sentAt_idx" ON "WaMessage" ("conversationId", "sentAt");

-- ── Foreign keys (guarded) ───────────────────────────────────────────────────
DO $$ BEGIN
  ALTER TABLE "WaConversation"
    ADD CONSTRAINT "WaConversation_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "WaConversation"
    ADD CONSTRAINT "WaConversation_customerId_fkey"
    FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "WaMessage"
    ADD CONSTRAINT "WaMessage_conversationId_fkey"
    FOREIGN KEY ("conversationId") REFERENCES "WaConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
