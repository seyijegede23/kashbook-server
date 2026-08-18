-- ADDITIVE ONLY: two nullable columns, nothing existing altered or dropped.
-- (IRCL retirement is decided but not yet confirmed executed, so the additive
-- rule still holds — and these have no reason to be anything else.)
--
-- The expense mirror of sale matching. Income already had the pair
-- (Transaction.matchedSaleId <-> Sales.matchedTransactionId); expenses had no
-- link at all, so an Expense recorded for money that left by bank transfer
-- double-counted against the bank debit in every expense aggregate. These two
-- columns are what let "tap a transfer you sent -> record it as an expense"
-- exist without corrupting the expense totals.
--
-- Bare scalars, no FKs, no uniques — mirrors the Sales pattern exactly; the
-- one-expense-per-transfer guarantee is enforced in code under the business
-- lock, like every other match invariant.

ALTER TABLE "Transaction" ADD COLUMN IF NOT EXISTS "matchedExpenseId" TEXT;

ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "matchedTransactionId" TEXT;
