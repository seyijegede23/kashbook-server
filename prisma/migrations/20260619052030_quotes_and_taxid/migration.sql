-- Quotations (Invoice.type discriminator) + display-only Business.taxId for documents.

-- AlterTable
ALTER TABLE "Business" ADD COLUMN     "taxId" TEXT;

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "type" TEXT NOT NULL DEFAULT 'invoice';
