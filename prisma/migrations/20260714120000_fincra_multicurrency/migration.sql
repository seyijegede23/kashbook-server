-- Fincra swap + multi-currency (additive only, plus pruning the two dead Paystack orphan columns).
-- NOTE: hand-curated. Does NOT include the unrelated Storefront/legacy orphan drops
-- that `prisma migrate diff` surfaces — those stay as harmless orphans.

-- User: drop dead Paystack column, add provider-neutral Fincra customer ref
ALTER TABLE "User" DROP COLUMN IF EXISTS "paystackCustomerCode";
ALTER TABLE "User" ADD COLUMN "fincraCustomerRef" TEXT;

-- Business: drop dead Paystack column, add provider-neutral banking fields
ALTER TABLE "Business" DROP COLUMN IF EXISTS "paystackDvaId";
ALTER TABLE "Business" ADD COLUMN "providerAccountId" TEXT;
ALTER TABLE "Business" ADD COLUMN "paymentProviderRef" TEXT;
ALTER TABLE "Business" ADD COLUMN "localAccountStatus" TEXT DEFAULT 'none';

-- Currency on the two money tables that lacked it (default NGN for existing rows)
ALTER TABLE "Sales" ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'NGN';
ALTER TABLE "Expense" ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'NGN';

-- Foreign-currency (USD/EUR/GBP) receive account (Fincra FCY)
CREATE TABLE "ForeignAccount" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "accountType" TEXT NOT NULL DEFAULT 'individual',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "fincraRequestId" TEXT,
    "fincraAccountId" TEXT,
    "accountNumber" TEXT,
    "accountName" TEXT,
    "bankName" TEXT,
    "swift" TEXT,
    "routing" TEXT,
    "iban" TEXT,
    "consentUrl" TEXT,
    "declineReason" TEXT,
    "inflowThisMonth" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "inflowMonth" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ForeignAccount_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ForeignAccount_businessId_currency_key" ON "ForeignAccount"("businessId", "currency");
CREATE INDEX "ForeignAccount_fincraRequestId_idx" ON "ForeignAccount"("fincraRequestId");
CREATE INDEX "ForeignAccount_accountNumber_idx" ON "ForeignAccount"("accountNumber");

ALTER TABLE "ForeignAccount" ADD CONSTRAINT "ForeignAccount_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
