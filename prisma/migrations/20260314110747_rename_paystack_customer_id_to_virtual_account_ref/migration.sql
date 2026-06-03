/*
  Warnings:

  - You are about to drop the column `paystackCustomerId` on the `Business` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Business" DROP COLUMN "paystackCustomerId",
ADD COLUMN     "virtualAccountRef" TEXT;
