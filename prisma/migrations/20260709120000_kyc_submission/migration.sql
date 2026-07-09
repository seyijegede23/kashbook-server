-- Admin approval gate for account-opening (KYC/KYB). Additive only — this
-- migration deliberately does NOT touch the orphan Storefront/legacy columns
-- (storeConfig*, Order, OrderItem, OrderStatus, legacySync, showInStore) that
-- were intentionally left in place when those features were removed.

-- CreateEnum
CREATE TYPE "KycSubmissionStatus" AS ENUM ('PENDING', 'APPROVED', 'DECLINED', 'FAILED');

-- CreateTable
CREATE TABLE "KycSubmission" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "KycSubmissionStatus" NOT NULL DEFAULT 'PENDING',
    "businessType" TEXT,
    "businessKyb" BOOLEAN NOT NULL DEFAULT false,
    "payload" TEXT,
    "summary" JSONB,
    "declineReason" TEXT,
    "processError" TEXT,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KycSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "KycSubmission_status_createdAt_idx" ON "KycSubmission"("status", "createdAt");

-- CreateIndex
CREATE INDEX "KycSubmission_businessId_idx" ON "KycSubmission"("businessId");

-- CreateIndex
CREATE INDEX "KycSubmission_userId_idx" ON "KycSubmission"("userId");

-- AddForeignKey
ALTER TABLE "KycSubmission" ADD CONSTRAINT "KycSubmission_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KycSubmission" ADD CONSTRAINT "KycSubmission_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
