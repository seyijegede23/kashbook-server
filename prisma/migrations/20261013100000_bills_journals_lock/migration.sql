-- Chart of accounts, release 2 (2026-10-13): bills, their payments, manual
-- journals and a lock date. The books stay derived from the records
-- (utils/books.js, utils/ledger.js): these are records like the others.
--
-- A payable (BusinessDebt, the table name is kept) becomes a Zoho-style bill:
-- the account it is for, its bill date and number, and dated payments
-- (BillPayment), each paid from an account or linked to the KashBook debit
-- that paid it (Transaction.matchedBillId, with the debit's matchedAmount).
-- A loan or other liability bill also says where the borrowed money went
-- (receivedViaAccountId). An estimated bill is a payable from before bills:
-- what was already paid on it is one estimated payment kept outside the
-- books, which lowers what is owed and counts nowhere, as nobody knows when
-- it was really paid. scripts/backfill-r2.js converts the existing rows after
-- this migration runs.
--
-- Manual journals (Adjustments in the app): numbered per business from
-- Business.journalCounter (MJ-00001), draft or published, every line on one
-- side only (a debit or a credit). Only published journals post. Their debits
-- equal their credits to the kobo: the route checks that, as a CHECK cannot
-- see the other lines.
--
-- Business.booksLockDate: a Lagos day ("YYYY-MM-DD", like openingBalanceDate)
-- on or before which nothing dated may be added, changed or removed
-- (utils/booksLock.js). Bank rows from the provider still arrive.
--
-- Idempotent throughout.

-- The bill.
ALTER TABLE "BusinessDebt" ADD COLUMN IF NOT EXISTS "accountId" TEXT;
ALTER TABLE "BusinessDebt" ADD COLUMN IF NOT EXISTS "billDate" TIMESTAMP(3);
ALTER TABLE "BusinessDebt" ADD COLUMN IF NOT EXISTS "billNumber" TEXT;
ALTER TABLE "BusinessDebt" ADD COLUMN IF NOT EXISTS "estimated" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "BusinessDebt" ADD COLUMN IF NOT EXISTS "receivedViaAccountId" TEXT;
ALTER TABLE "BusinessDebt" ADD COLUMN IF NOT EXISTS "createdById" TEXT;
-- A payable from before bills is dated when it was entered. updatedAt is left
-- alone: the backfill dates the estimated payment by it.
UPDATE "BusinessDebt" SET "billDate" = "createdAt" WHERE "billDate" IS NULL;
ALTER TABLE "BusinessDebt" ALTER COLUMN "billDate" SET DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "BusinessDebt" ALTER COLUMN "billDate" SET NOT NULL;
CREATE INDEX IF NOT EXISTS "BusinessDebt_accountId_idx" ON "BusinessDebt"("accountId");
CREATE INDEX IF NOT EXISTS "BusinessDebt_receivedViaAccountId_idx" ON "BusinessDebt"("receivedViaAccountId");

-- Payments towards a bill. method "bank" is money that left the KashBook
-- account: the payment then names the debit (transactionId), and only then.
-- A payment kept outside the books names no debit, because that debit would
-- stop counting and nothing would count in its place.
CREATE TABLE IF NOT EXISTS "BillPayment" (
  "id"                   TEXT NOT NULL,
  "billId"               TEXT NOT NULL,
  "amount"               DOUBLE PRECISION NOT NULL,
  "date"                 TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "method"               TEXT NOT NULL DEFAULT 'cash',
  "paidThroughAccountId" TEXT,
  "transactionId"        TEXT,
  "estimated"            BOOLEAN NOT NULL DEFAULT false,
  "outsideBooks"         BOOLEAN NOT NULL DEFAULT false,
  "note"                 TEXT,
  "createdById"          TEXT,
  "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BillPayment_pkey" PRIMARY KEY ("id"),
  -- Money paid: more than zero, and a real number (NaN and infinity compare
  -- above every number in Postgres, so "> 0" alone lets them through).
  CONSTRAINT "BillPayment_amount_check" CHECK ("amount" > 0 AND "amount" < 'Infinity'),
  CONSTRAINT "BillPayment_method_check" CHECK ("method" IN ('cash', 'transfer', 'pos', 'cheque', 'other', 'bank')),
  CONSTRAINT "BillPayment_bank_link_check" CHECK (("method" = 'bank') = ("transactionId" IS NOT NULL)),
  CONSTRAINT "BillPayment_outside_books_check" CHECK (NOT "outsideBooks" OR "transactionId" IS NULL)
);
CREATE INDEX IF NOT EXISTS "BillPayment_billId_idx" ON "BillPayment"("billId");
CREATE INDEX IF NOT EXISTS "BillPayment_transactionId_idx" ON "BillPayment"("transactionId");
CREATE INDEX IF NOT EXISTS "BillPayment_paidThroughAccountId_idx" ON "BillPayment"("paidThroughAccountId");

-- The bill a KashBook debit paid (bare, like matchedExpenseId). The debit's
-- matchedAmount is the payment's amount, at most the debit; the rest of the
-- debit counts as it did before.
ALTER TABLE "Transaction" ADD COLUMN IF NOT EXISTS "matchedBillId" TEXT;
CREATE INDEX IF NOT EXISTS "Transaction_matchedBillId_idx" ON "Transaction"("matchedBillId");

-- Manual journals.
CREATE TABLE IF NOT EXISTS "ManualJournal" (
  "id"          TEXT NOT NULL,
  "businessId"  TEXT NOT NULL,
  "number"      TEXT NOT NULL,
  "date"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "note"        TEXT,
  "status"      TEXT NOT NULL DEFAULT 'draft',
  "createdById" TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ManualJournal_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ManualJournal_status_check" CHECK ("status" IN ('draft', 'published'))
);
CREATE UNIQUE INDEX IF NOT EXISTS "ManualJournal_businessId_number_key" ON "ManualJournal"("businessId", "number");
CREATE INDEX IF NOT EXISTS "ManualJournal_businessId_date_idx" ON "ManualJournal"("businessId", "date");

-- A journal line is a debit or a credit: one side more than zero, the other
-- zero, both real numbers.
CREATE TABLE IF NOT EXISTS "ManualJournalLine" (
  "id"          TEXT NOT NULL,
  "journalId"   TEXT NOT NULL,
  "accountId"   TEXT NOT NULL,
  "debit"       DOUBLE PRECISION NOT NULL DEFAULT 0,
  "credit"      DOUBLE PRECISION NOT NULL DEFAULT 0,
  "description" TEXT,
  "position"    INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "ManualJournalLine_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ManualJournalLine_side_check" CHECK (
    "debit" >= 0 AND "credit" >= 0 AND "debit" < 'Infinity' AND "credit" < 'Infinity'
    AND ("debit" > 0) <> ("credit" > 0))
);
CREATE INDEX IF NOT EXISTS "ManualJournalLine_journalId_idx" ON "ManualJournalLine"("journalId");
CREATE INDEX IF NOT EXISTS "ManualJournalLine_accountId_idx" ON "ManualJournalLine"("accountId");

-- The journal number counter, and the lock date.
ALTER TABLE "Business" ADD COLUMN IF NOT EXISTS "journalCounter" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Business" ADD COLUMN IF NOT EXISTS "booksLockDate" TEXT;

DO $$ BEGIN
  -- The lock is compared as text, day by day, so it is always a plain day.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Business_booksLockDate_check') THEN
    ALTER TABLE "Business" ADD CONSTRAINT "Business_booksLockDate_check"
      CHECK ("booksLockDate" IS NULL OR "booksLockDate" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$');
  END IF;
  -- Foreign keys. An account in use is never deleted (routes/ledger.js
  -- refuses, or merges its records into another); were one ever removed, a
  -- bill or payment falls back to the account chart.js resolves.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BusinessDebt_accountId_fkey') THEN
    ALTER TABLE "BusinessDebt" ADD CONSTRAINT "BusinessDebt_accountId_fkey"
      FOREIGN KEY ("accountId") REFERENCES "LedgerAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BusinessDebt_receivedViaAccountId_fkey') THEN
    ALTER TABLE "BusinessDebt" ADD CONSTRAINT "BusinessDebt_receivedViaAccountId_fkey"
      FOREIGN KEY ("receivedViaAccountId") REFERENCES "LedgerAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BillPayment_billId_fkey') THEN
    -- The payments go with their bill (the route frees any debit they named).
    ALTER TABLE "BillPayment" ADD CONSTRAINT "BillPayment_billId_fkey"
      FOREIGN KEY ("billId") REFERENCES "BusinessDebt"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BillPayment_paidThroughAccountId_fkey') THEN
    ALTER TABLE "BillPayment" ADD CONSTRAINT "BillPayment_paidThroughAccountId_fkey"
      FOREIGN KEY ("paidThroughAccountId") REFERENCES "LedgerAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ManualJournal_businessId_fkey') THEN
    ALTER TABLE "ManualJournal" ADD CONSTRAINT "ManualJournal_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ManualJournalLine_journalId_fkey') THEN
    ALTER TABLE "ManualJournalLine" ADD CONSTRAINT "ManualJournalLine_journalId_fkey"
      FOREIGN KEY ("journalId") REFERENCES "ManualJournal"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ManualJournalLine_accountId_fkey') THEN
    -- Never silently: an account a journal line names is refused deletion.
    -- The check waits for the end of the transaction (DEFERRABLE INITIALLY
    -- DEFERRED). Deleting a business removes its accounts, and its journals'
    -- lines through the journals, in one statement; an immediate check
    -- (RESTRICT, or plain NO ACTION) runs as the accounts go, while the lines
    -- are still there, and refuses the whole deletion. Deferred, it sees the
    -- lines gone. A delete of an account a line still names is refused all
    -- the same: by its own statement outside a transaction, at COMMIT inside
    -- one.
    ALTER TABLE "ManualJournalLine" ADD CONSTRAINT "ManualJournalLine_accountId_fkey"
      FOREIGN KEY ("accountId") REFERENCES "LedgerAccount"("id") ON DELETE NO ACTION ON UPDATE CASCADE
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
