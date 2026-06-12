-- Saved transfer recipients for the Send Money "Recents" chips.
-- One row per (business, account, bank); upserted on successful transfers.

CREATE TABLE "Beneficiary" (
  "id"            TEXT          NOT NULL,
  "businessId"    TEXT          NOT NULL,
  "accountNumber" TEXT          NOT NULL,
  "bankCode"      TEXT          NOT NULL,
  "bankName"      TEXT,
  "accountName"   TEXT,
  "timesUsed"     INTEGER       NOT NULL DEFAULT 1,
  "lastUsedAt"    TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt"     TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "Beneficiary_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Beneficiary_businessId_fkey" FOREIGN KEY ("businessId")
    REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "Beneficiary_businessId_accountNumber_bankCode_key"
  ON "Beneficiary"("businessId", "accountNumber", "bankCode");
CREATE INDEX "Beneficiary_businessId_lastUsedAt_idx"
  ON "Beneficiary"("businessId", "lastUsedAt");
