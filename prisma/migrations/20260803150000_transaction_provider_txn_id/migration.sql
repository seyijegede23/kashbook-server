-- Provider-side identifier for a money movement (Anchor payment/transaction/transfer id).
-- ADDITIVE ONLY (shared DB): nullable column + a non-unique index.
ALTER TABLE "Transaction" ADD COLUMN IF NOT EXISTS "providerTxnId" TEXT;
CREATE INDEX IF NOT EXISTS "Transaction_businessId_providerTxnId_idx"
  ON "Transaction" ("businessId", "providerTxnId");
