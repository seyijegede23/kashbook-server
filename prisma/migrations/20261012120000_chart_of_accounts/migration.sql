-- Chart of accounts, release 1 (2026-10-11): Zoho Books' accounts, adapted for a
-- Nigerian shop (server/src/utils/chart.js holds the types and the default
-- chart). The books stay derived from the records: no journal is posted here.
-- This adds the accounts, the opening balances, and an optional account on the
-- records a merchant can explain (when a record names none, chart.js resolves
-- one from its category, method or purpose).
--
-- The database is no longer shared with the IRCL app (owner, 2026-10-11), so
-- real foreign keys and CHECK constraints are used. Idempotent throughout.

CREATE TABLE IF NOT EXISTS "LedgerAccount" (
  "id"           TEXT NOT NULL,
  "businessId"   TEXT NOT NULL,
  "type"         TEXT NOT NULL,
  "name"         TEXT NOT NULL,
  "nameKey"      TEXT NOT NULL,
  "code"         TEXT,
  "codeKey"      TEXT,
  "description"  TEXT,
  "systemKey"    TEXT,
  "categorySlug" TEXT,
  "seed"         TEXT,
  "parentId"     TEXT,
  "inactiveAt"   TIMESTAMP(3),
  "createdById"  TEXT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,
  CONSTRAINT "LedgerAccount_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "LedgerAccount_type_check" CHECK ("type" IN (
    'cash', 'bank', 'payment_clearing', 'accounts_receivable', 'stock', 'other_current_asset',
    'fixed_asset', 'other_asset', 'accounts_payable', 'credit_card', 'other_current_liability',
    'long_term_liability', 'other_liability', 'equity', 'income', 'other_income', 'expense',
    'cost_of_goods_sold', 'other_expense')),
  CONSTRAINT "LedgerAccount_parent_check" CHECK ("parentId" IS NULL OR "parentId" <> "id"),
  -- A system account is never deactivated: the books post to it.
  CONSTRAINT "LedgerAccount_system_active_check" CHECK ("systemKey" IS NULL OR "inactiveAt" IS NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS "LedgerAccount_businessId_systemKey_key" ON "LedgerAccount"("businessId", "systemKey");
CREATE UNIQUE INDEX IF NOT EXISTS "LedgerAccount_businessId_categorySlug_key" ON "LedgerAccount"("businessId", "categorySlug");
CREATE UNIQUE INDEX IF NOT EXISTS "LedgerAccount_businessId_codeKey_key" ON "LedgerAccount"("businessId", "codeKey");
CREATE UNIQUE INDEX IF NOT EXISTS "LedgerAccount_businessId_nameKey_key" ON "LedgerAccount"("businessId", "nameKey");
CREATE INDEX IF NOT EXISTS "LedgerAccount_parentId_idx" ON "LedgerAccount"("parentId");

CREATE TABLE IF NOT EXISTS "OpeningBalance" (
  "id"          TEXT NOT NULL,
  "businessId"  TEXT NOT NULL,
  "accountId"   TEXT NOT NULL,
  "debit"       DOUBLE PRECISION NOT NULL DEFAULT 0,
  "credit"      DOUBLE PRECISION NOT NULL DEFAULT 0,
  "updatedById" TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OpeningBalance_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OpeningBalance_amount_check" CHECK ("debit" >= 0 AND "credit" >= 0 AND NOT ("debit" > 0 AND "credit" > 0))
);
CREATE UNIQUE INDEX IF NOT EXISTS "OpeningBalance_businessId_accountId_key" ON "OpeningBalance"("businessId", "accountId");
CREATE INDEX IF NOT EXISTS "OpeningBalance_accountId_idx" ON "OpeningBalance"("accountId");

-- The day the books start (opening balances are as at the start of it) and the
-- month the financial year starts (1 = January).
ALTER TABLE "Business" ADD COLUMN IF NOT EXISTS "openingBalanceDate" TEXT;
ALTER TABLE "Business" ADD COLUMN IF NOT EXISTS "fiscalYearStartMonth" INTEGER NOT NULL DEFAULT 1;

-- An account on the records a merchant explains, and where the money went.
ALTER TABLE "Sales" ADD COLUMN IF NOT EXISTS "accountId" TEXT;
ALTER TABLE "Sales" ADD COLUMN IF NOT EXISTS "depositAccountId" TEXT;
ALTER TABLE "Sales" ADD COLUMN IF NOT EXISTS "clientRef" TEXT;
ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "accountId" TEXT;
ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "paidThroughAccountId" TEXT;
ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "clientRef" TEXT;
ALTER TABLE "InvoiceItem" ADD COLUMN IF NOT EXISTS "accountId" TEXT;
ALTER TABLE "InvoicePayment" ADD COLUMN IF NOT EXISTS "depositAccountId" TEXT;
ALTER TABLE "Transaction" ADD COLUMN IF NOT EXISTS "accountId" TEXT;
ALTER TABLE "RecurringExpense" ADD COLUMN IF NOT EXISTS "accountId" TEXT;
ALTER TABLE "RecurringExpense" ADD COLUMN IF NOT EXISTS "paidThroughAccountId" TEXT;
-- A repayment's method (cash, transfer, pos, ...) from now on; older rows keep
-- none and are booked as Undeposited Funds. createdAt stays NULL on them, so a
-- later lock date never mistakes the migration day for when they were made.
ALTER TABLE "DebtPayment" ADD COLUMN IF NOT EXISTS "method" TEXT;
ALTER TABLE "DebtPayment" ADD COLUMN IF NOT EXISTS "depositAccountId" TEXT;
ALTER TABLE "DebtPayment" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3);
ALTER TABLE "DebtPayment" ALTER COLUMN "createdAt" SET DEFAULT CURRENT_TIMESTAMP;

-- A retried create (a timed-out request sent again) finds the first one.
CREATE UNIQUE INDEX IF NOT EXISTS "Sales_businessId_clientRef_key" ON "Sales"("businessId", "clientRef");
CREATE UNIQUE INDEX IF NOT EXISTS "Expense_businessId_clientRef_key" ON "Expense"("businessId", "clientRef");

CREATE INDEX IF NOT EXISTS "Sales_accountId_idx" ON "Sales"("accountId");
CREATE INDEX IF NOT EXISTS "Sales_depositAccountId_idx" ON "Sales"("depositAccountId");
CREATE INDEX IF NOT EXISTS "Expense_accountId_idx" ON "Expense"("accountId");
CREATE INDEX IF NOT EXISTS "Expense_paidThroughAccountId_idx" ON "Expense"("paidThroughAccountId");
CREATE INDEX IF NOT EXISTS "InvoiceItem_accountId_idx" ON "InvoiceItem"("accountId");
CREATE INDEX IF NOT EXISTS "InvoicePayment_depositAccountId_idx" ON "InvoicePayment"("depositAccountId");
CREATE INDEX IF NOT EXISTS "Transaction_accountId_idx" ON "Transaction"("accountId");
CREATE INDEX IF NOT EXISTS "RecurringExpense_accountId_idx" ON "RecurringExpense"("accountId");
CREATE INDEX IF NOT EXISTS "RecurringExpense_paidThroughAccountId_idx" ON "RecurringExpense"("paidThroughAccountId");
CREATE INDEX IF NOT EXISTS "DebtPayment_depositAccountId_idx" ON "DebtPayment"("depositAccountId");

-- Foreign keys. An account in use cannot be deleted (the route refuses); were
-- one ever removed, its records fall back to the account chart.js resolves.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'LedgerAccount_businessId_fkey') THEN
    ALTER TABLE "LedgerAccount" ADD CONSTRAINT "LedgerAccount_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'LedgerAccount_parentId_fkey') THEN
    ALTER TABLE "LedgerAccount" ADD CONSTRAINT "LedgerAccount_parentId_fkey"
      FOREIGN KEY ("parentId") REFERENCES "LedgerAccount"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'OpeningBalance_businessId_fkey') THEN
    ALTER TABLE "OpeningBalance" ADD CONSTRAINT "OpeningBalance_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'OpeningBalance_accountId_fkey') THEN
    -- Never silently: an account with an opening balance is refused deletion.
    ALTER TABLE "OpeningBalance" ADD CONSTRAINT "OpeningBalance_accountId_fkey"
      FOREIGN KEY ("accountId") REFERENCES "LedgerAccount"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Sales_accountId_fkey') THEN
    ALTER TABLE "Sales" ADD CONSTRAINT "Sales_accountId_fkey"
      FOREIGN KEY ("accountId") REFERENCES "LedgerAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Sales_depositAccountId_fkey') THEN
    ALTER TABLE "Sales" ADD CONSTRAINT "Sales_depositAccountId_fkey"
      FOREIGN KEY ("depositAccountId") REFERENCES "LedgerAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Expense_accountId_fkey') THEN
    ALTER TABLE "Expense" ADD CONSTRAINT "Expense_accountId_fkey"
      FOREIGN KEY ("accountId") REFERENCES "LedgerAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Expense_paidThroughAccountId_fkey') THEN
    ALTER TABLE "Expense" ADD CONSTRAINT "Expense_paidThroughAccountId_fkey"
      FOREIGN KEY ("paidThroughAccountId") REFERENCES "LedgerAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'InvoiceItem_accountId_fkey') THEN
    ALTER TABLE "InvoiceItem" ADD CONSTRAINT "InvoiceItem_accountId_fkey"
      FOREIGN KEY ("accountId") REFERENCES "LedgerAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'InvoicePayment_depositAccountId_fkey') THEN
    ALTER TABLE "InvoicePayment" ADD CONSTRAINT "InvoicePayment_depositAccountId_fkey"
      FOREIGN KEY ("depositAccountId") REFERENCES "LedgerAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Transaction_accountId_fkey') THEN
    ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_accountId_fkey"
      FOREIGN KEY ("accountId") REFERENCES "LedgerAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RecurringExpense_accountId_fkey') THEN
    ALTER TABLE "RecurringExpense" ADD CONSTRAINT "RecurringExpense_accountId_fkey"
      FOREIGN KEY ("accountId") REFERENCES "LedgerAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RecurringExpense_paidThroughAccountId_fkey') THEN
    ALTER TABLE "RecurringExpense" ADD CONSTRAINT "RecurringExpense_paidThroughAccountId_fkey"
      FOREIGN KEY ("paidThroughAccountId") REFERENCES "LedgerAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'DebtPayment_depositAccountId_fkey') THEN
    ALTER TABLE "DebtPayment" ADD CONSTRAINT "DebtPayment_depositAccountId_fkey"
      FOREIGN KEY ("depositAccountId") REFERENCES "LedgerAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
