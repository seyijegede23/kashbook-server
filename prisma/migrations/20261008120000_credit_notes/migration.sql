-- Credit notes (owner request 2026-10-08, after Zoho Invoice).
--
-- A credit note is an Invoice row with type 'credit_note', the way a quote is
-- one with type 'quote', so the editor, PDF and sharing carry over. Its
-- amountPaid is the credit already used; total - amountPaid is what is left.
-- It is DRAFT, then SENT (shown as Open), PARTIAL while partly used, PAID when
-- used up (shown as Closed), or VOID: the existing enum, no new values, so the
-- older app sharing this DB never meets a status it cannot read.
--
-- Additive only: three nullable or defaulted Business columns and one table.

ALTER TABLE "Business" ADD COLUMN IF NOT EXISTS "creditNoteCounter" INTEGER NOT NULL DEFAULT 0;
-- NULL = "CN-"; "" = plain numbers.
ALTER TABLE "Business" ADD COLUMN IF NOT EXISTS "creditNotePrefix" TEXT;
-- NULL/'auto' = the server numbers them; 'manual' = the app asks.
ALTER TABLE "Business" ADD COLUMN IF NOT EXISTS "creditNoteNumberMode" TEXT;

-- Credit applied from a credit note to an invoice of the same customer. The
-- invoice also gets an InvoicePayment (method 'credit_note') so its balance
-- falls like any payment; this row is the link back to the credit note.
CREATE TABLE IF NOT EXISTS "CreditApplication" (
  "id"           TEXT NOT NULL,
  "businessId"   TEXT NOT NULL,
  "creditNoteId" TEXT NOT NULL,
  "invoiceId"    TEXT NOT NULL,
  "amount"       DOUBLE PRECISION NOT NULL,
  "date"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CreditApplication_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "CreditApplication_creditNoteId_idx" ON "CreditApplication" ("creditNoteId");
CREATE INDEX IF NOT EXISTS "CreditApplication_invoiceId_idx" ON "CreditApplication" ("invoiceId");
CREATE INDEX IF NOT EXISTS "CreditApplication_businessId_idx" ON "CreditApplication" ("businessId");

-- Business deletion takes the rows with it. The two document links are NO
-- ACTION: checked at the end of the statement, so deleting a whole business
-- (which cascades both documents and these rows) succeeds, while deleting one
-- document that still has credit attached is refused by the database as well
-- as by the route.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CreditApplication_businessId_fkey') THEN
    ALTER TABLE "CreditApplication"
      ADD CONSTRAINT "CreditApplication_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CreditApplication_creditNoteId_fkey') THEN
    ALTER TABLE "CreditApplication"
      ADD CONSTRAINT "CreditApplication_creditNoteId_fkey"
      FOREIGN KEY ("creditNoteId") REFERENCES "Invoice"("id")
      ON DELETE NO ACTION ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CreditApplication_invoiceId_fkey') THEN
    ALTER TABLE "CreditApplication"
      ADD CONSTRAINT "CreditApplication_invoiceId_fkey"
      FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id")
      ON DELETE NO ACTION ON UPDATE CASCADE;
  END IF;
END $$;
