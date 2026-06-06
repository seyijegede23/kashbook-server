-- Transaction PIN for outbound transfers
ALTER TABLE "User"
  ADD COLUMN "transactionPin"            TEXT,
  ADD COLUMN "transactionPinFailedCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "transactionPinLockedUntil" TIMESTAMP(3);
