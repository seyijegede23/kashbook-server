-- Recurring invoices (PREMIUM): a rule auto-creates a SENT invoice + share link
-- on a schedule. Additive + idempotent, mirrors the other feature migrations.
CREATE TABLE IF NOT EXISTS "RecurringInvoice" (
  "id"            TEXT NOT NULL,
  "userId"        TEXT NOT NULL,
  "businessId"    TEXT NOT NULL,
  "customerId"    TEXT,
  "description"   TEXT NOT NULL,
  "amount"        DOUBLE PRECISION NOT NULL,
  "frequency"     TEXT NOT NULL DEFAULT 'monthly',
  "dueInDays"     INTEGER,
  "nextDue"       TIMESTAMP(3) NOT NULL,
  "active"        BOOLEAN NOT NULL DEFAULT true,
  "lastRunAt"     TIMESTAMP(3),
  "lastInvoiceId" TEXT,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RecurringInvoice_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "RecurringInvoice_userId_active_idx" ON "RecurringInvoice" ("userId", "active");
CREATE INDEX IF NOT EXISTS "RecurringInvoice_nextDue_active_idx" ON "RecurringInvoice" ("nextDue", "active");

DO $$ BEGIN
  ALTER TABLE "RecurringInvoice"
    ADD CONSTRAINT "RecurringInvoice_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "RecurringInvoice"
    ADD CONSTRAINT "RecurringInvoice_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "RecurringInvoice"
    ADD CONSTRAINT "RecurringInvoice_customerId_fkey"
    FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
