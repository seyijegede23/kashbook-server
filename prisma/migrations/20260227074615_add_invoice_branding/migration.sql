-- AlterTable
ALTER TABLE "Business" ADD COLUMN     "invoiceFooter" TEXT,
ADD COLUMN     "invoiceTemplate" TEXT NOT NULL DEFAULT 'classic';
