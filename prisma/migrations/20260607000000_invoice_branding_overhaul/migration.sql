-- Branding consolidation: drop invoiceFooter (receiptFooter is the unified
-- footer now). Add usePaymentOverride toggle so users can opt out of
-- NUBAN auto-fill and use a non-KashBook bank account on their invoices.
ALTER TABLE "Business" DROP COLUMN IF EXISTS "invoiceFooter";
ALTER TABLE "Business" ADD COLUMN "usePaymentOverride" BOOLEAN NOT NULL DEFAULT false;

-- Public hosted invoice page: GET /i/:token
CREATE TABLE "InvoiceShareLink" (
  "id"        TEXT NOT NULL,
  "invoiceId" TEXT NOT NULL,
  "token"     TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "InvoiceShareLink_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "InvoiceShareLink_invoiceId_key" ON "InvoiceShareLink"("invoiceId");
CREATE UNIQUE INDEX "InvoiceShareLink_token_key"     ON "InvoiceShareLink"("token");
CREATE        INDEX "InvoiceShareLink_token_idx"     ON "InvoiceShareLink"("token");
ALTER TABLE "InvoiceShareLink"
  ADD CONSTRAINT "InvoiceShareLink_invoiceId_fkey"
  FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
