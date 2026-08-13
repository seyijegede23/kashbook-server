-- ADDITIVE ONLY. The kashbook database is shared with another deployed app
-- running older code, so every column here is nullable and nothing existing is
-- altered or dropped: old code simply never writes them.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "middleName"     TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "referredByCode" TEXT;
