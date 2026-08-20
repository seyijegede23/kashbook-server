-- Additive only (shared kashbook DB — IRCL sibling app must keep working).
ALTER TABLE "Transaction" ADD COLUMN IF NOT EXISTS "matchedAmount" DOUBLE PRECISION;
ALTER TABLE "Transaction" ADD COLUMN IF NOT EXISTS "senderName" TEXT;
ALTER TABLE "Transaction" ADD COLUMN IF NOT EXISTS "senderBank" TEXT;
ALTER TABLE "Transaction" ADD COLUMN IF NOT EXISTS "senderAccount" TEXT;
