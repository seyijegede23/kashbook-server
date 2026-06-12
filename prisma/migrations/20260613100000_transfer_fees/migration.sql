-- Outbound-transfer fees (pass-through of Anchor's costs + ₦1 margin).
-- `fee` is what the user was charged on top of `amount`; `feeBreakdown`
-- records the { nip, stampDuty, platform } split. Existing rows backfill
-- with 0 / NULL — fees only exist from this point forward.

ALTER TABLE "Transaction" ADD COLUMN "fee" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "Transaction" ADD COLUMN "feeBreakdown" JSONB;
