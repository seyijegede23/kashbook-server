-- AlterTable
ALTER TABLE "Business" ADD COLUMN     "kycBusinessType" TEXT DEFAULT 'sole_proprietor',
ADD COLUMN     "kycBvn" TEXT,
ADD COLUMN     "kycCacNumber" TEXT;
