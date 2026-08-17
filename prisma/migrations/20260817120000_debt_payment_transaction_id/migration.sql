-- ADDITIVE ONLY. One nullable column + one index on DebtPayment; nothing existing
-- is altered or dropped. (IRCL retirement is planned but not yet confirmed done,
-- so this migration still holds to the additive rule — and has no reason not to.)
--
-- transactionId records WHICH bank credit created a debt payment when the owner
-- matches an incoming transfer to a customer's debt. Null for manual payments.
-- It exists so unmatching a credit can reverse exactly the payments that credit
-- created — the old unmatch left the money applied with no way to find it.
--
-- No foreign key, deliberately: a Transaction row can be deleted along with its
-- business while the customer's payment history survives, and an FK would turn
-- that into a constraint failure.

ALTER TABLE "DebtPayment" ADD COLUMN IF NOT EXISTS "transactionId" TEXT;

CREATE INDEX IF NOT EXISTS "DebtPayment_transactionId_idx"
  ON "DebtPayment"("transactionId");
