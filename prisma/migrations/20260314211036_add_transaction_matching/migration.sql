-- AlterTable
ALTER TABLE "Sales" ADD COLUMN     "matchedTransactionId" TEXT;

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "matchedSaleId" TEXT;
