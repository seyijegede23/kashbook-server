-- Concurrency hardening: idempotency + dedup constraints.

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "reference" TEXT;

-- CreateTable
CREATE TABLE "ProcessedWebhook" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "type" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcessedWebhook_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProcessedWebhook_eventId_key" ON "ProcessedWebhook"("eventId");

-- CreateIndex
CREATE UNIQUE INDEX "Transaction_businessId_reference_key" ON "Transaction"("businessId", "reference");

-- CreateIndex
CREATE UNIQUE INDEX "User_anchorCustomerId_key" ON "User"("anchorCustomerId");
