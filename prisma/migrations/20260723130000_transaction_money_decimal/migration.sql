-- Phase C1: Transaction.amount + fee → exact money (Postgres numeric(18,2)).
--
-- double precision → numeric with round() so any IEEE-754 artifact frozen in a
-- stored double (e.g. 0.30000000000000004) collapses to exact kobo (2 dp). Every
-- amount is already 2 dp naira/kobo, so values are preserved. From here the DB
-- stores and SUMs money exactly; the app converts to Number only at the arithmetic
-- and API boundaries.
ALTER TABLE "Transaction"
  ALTER COLUMN "amount" TYPE numeric(18,2) USING round("amount"::numeric, 2),
  ALTER COLUMN "fee"    TYPE numeric(18,2) USING round("fee"::numeric, 2);
