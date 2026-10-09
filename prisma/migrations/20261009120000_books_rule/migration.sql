-- Books rule (2026-10-09): invoice payments and refunds link to the bank rows
-- they are, credit sales link to their debt, invoices can be written off and
-- carry the tax authority's reference. Additive only (the IRCL app shares this
-- database): new nullable columns and indexes, nothing changed or dropped.

ALTER TABLE "InvoicePayment" ADD COLUMN IF NOT EXISTS "transactionId" TEXT;
CREATE INDEX IF NOT EXISTS "InvoicePayment_transactionId_idx" ON "InvoicePayment"("transactionId");

ALTER TABLE "Transaction" ADD COLUMN IF NOT EXISTS "matchedInvoiceId" TEXT;

ALTER TABLE "Debt" ADD COLUMN IF NOT EXISTS "saleId" TEXT;
CREATE INDEX IF NOT EXISTS "Debt_saleId_idx" ON "Debt"("saleId");

ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "writtenOffAt" TIMESTAMP(3);
ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "writtenOffAmount" DOUBLE PRECISION;
ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "irn" TEXT;
