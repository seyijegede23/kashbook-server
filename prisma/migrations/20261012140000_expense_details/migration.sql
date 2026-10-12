-- Zoho-style expenses (2026-10-12, chart of accounts release 1): what the owner
-- chose from Zoho Books' Add Expense. An expense may now carry the supplier's
-- receipt or invoice number, the customer it was for, its receipts, and lines
-- (Zoho's "Itemize": one expense, several accounts).
--
-- An itemized expense keeps Expense.amount = the sum of its lines, accountId
-- NULL and category = the first line's, so older app versions (which read only
-- category and amount) still show it whole; the books rule (utils/books.js)
-- counts it line by line. Additive and idempotent throughout.

-- The supplier's receipt or invoice number (100 characters at most).
ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "reference" TEXT;
-- A cost tied to a customer: it shows on their page and changes no total.
ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "customerId" TEXT;
-- Up to 5 receipts, stored privately on Cloudinary:
-- [{ id, name, mime, size, uploadedAt, publicId, resourceType }].
ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "attachments" JSONB;
CREATE INDEX IF NOT EXISTS "Expense_customerId_idx" ON "Expense"("customerId");

-- The lines of an itemized expense, in the order the merchant entered them.
-- category is the line account's categorySlug when it has one, else "other"
-- (the same denormalisation Expense.category has).
CREATE TABLE IF NOT EXISTS "ExpenseItem" (
  "id"          TEXT NOT NULL,
  "expenseId"   TEXT NOT NULL,
  "accountId"   TEXT,
  "category"    TEXT NOT NULL DEFAULT 'other',
  "description" TEXT,
  "amount"      DOUBLE PRECISION NOT NULL,
  "position"    INTEGER NOT NULL DEFAULT 0,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ExpenseItem_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "ExpenseItem_expenseId_idx" ON "ExpenseItem"("expenseId");
CREATE INDEX IF NOT EXISTS "ExpenseItem_accountId_idx" ON "ExpenseItem"("accountId");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Expense_customerId_fkey') THEN
    ALTER TABLE "Expense" ADD CONSTRAINT "Expense_customerId_fkey"
      FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ExpenseItem_expenseId_fkey') THEN
    -- The lines go with their expense.
    ALTER TABLE "ExpenseItem" ADD CONSTRAINT "ExpenseItem_expenseId_fkey"
      FOREIGN KEY ("expenseId") REFERENCES "Expense"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ExpenseItem_accountId_fkey') THEN
    -- An account in use is never deleted (routes/ledger.js refuses, or merges
    -- the lines into another); were one ever removed, the line falls back to
    -- its category's account.
    ALTER TABLE "ExpenseItem" ADD CONSTRAINT "ExpenseItem_accountId_fkey"
      FOREIGN KEY ("accountId") REFERENCES "LedgerAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  -- A line is money spent: never zero or less.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ExpenseItem_amount_check') THEN
    ALTER TABLE "ExpenseItem" ADD CONSTRAINT "ExpenseItem_amount_check" CHECK ("amount" > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Expense_attachments_check') THEN
    ALTER TABLE "Expense" ADD CONSTRAINT "Expense_attachments_check"
      CHECK ("attachments" IS NULL OR jsonb_typeof("attachments") = 'array');
  END IF;
END $$;
