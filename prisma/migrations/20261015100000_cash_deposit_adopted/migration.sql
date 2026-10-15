-- Deposit cash: a transfer the owner had already marked (2026-10-15).
-- Before a deposit could be recorded, the owner explained a transfer of their
-- own cash as "Cash I already recorded" (purpose cash_deposit, with no account
-- or with the Cash at Hand account). A KashBook deposit may now take such a
-- transfer when the owner picks it, so Cash at Hand falls once for that cash:
-- the transfer becomes the deposit's (purpose cash_deposit, no account) and
-- the deposit keeps what the transfer was, so an undo gives that marking
-- back:
--
--   adoptedPurpose    "cash_deposit" when the transfer was marked so, else
--                     null (a transfer nothing explained);
--   adoptedAccountId  the account it carried then (the Cash at Hand system
--                     account, which is never merged away or deleted), else
--                     null. No key: it names that account only while the
--                     deposit holds the transfer.
--
-- Both are kept only while the deposit has arrived (an undo clears them).
--
-- Idempotent throughout.

ALTER TABLE "CashDeposit" ADD COLUMN IF NOT EXISTS "adoptedPurpose" TEXT;
ALTER TABLE "CashDeposit" ADD COLUMN IF NOT EXISTS "adoptedAccountId" TEXT;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CashDeposit_adopted_check') THEN
    ALTER TABLE "CashDeposit" ADD CONSTRAINT "CashDeposit_adopted_check" CHECK (
      ("adoptedPurpose" IS NULL OR "adoptedPurpose" = 'cash_deposit')
      AND ("adoptedAccountId" IS NULL OR "adoptedPurpose" IS NOT NULL)
      AND ("status" = 'arrived' OR ("adoptedPurpose" IS NULL AND "adoptedAccountId" IS NULL)));
  END IF;
END $$;
