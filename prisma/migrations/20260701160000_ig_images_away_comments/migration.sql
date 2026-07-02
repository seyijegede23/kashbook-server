-- Inline images: store the inbound attachment URL on a message.
ALTER TABLE "IgMessage" ADD COLUMN IF NOT EXISTS "attachmentUrl" TEXT;

-- Away-hours auto-replies: window bounds (kind="away"). "comment" kind reuses keyword.
ALTER TABLE "IgAutoReply" ADD COLUMN IF NOT EXISTS "fromHour" INTEGER;
ALTER TABLE "IgAutoReply" ADD COLUMN IF NOT EXISTS "toHour"   INTEGER;
