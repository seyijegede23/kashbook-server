/*
  Warnings:

  - A unique constraint covering the columns `[monoTxId]` on the table `Transaction` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "Business" ADD COLUMN     "monoAccountBank" TEXT,
ADD COLUMN     "monoAccountId" TEXT,
ADD COLUMN     "monoAccountName" TEXT,
ADD COLUMN     "monoAccountNumber" TEXT,
ADD COLUMN     "monoLastSynced" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "monoTxId" TEXT,
ADD COLUMN     "source" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Transaction_monoTxId_key" ON "Transaction"("monoTxId");
