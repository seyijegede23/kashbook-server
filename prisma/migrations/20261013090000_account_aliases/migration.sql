-- Chart of accounts, release 1.1 (2026-10-13): a merged or deleted category
-- account stays gone. A phone on an older app version only knows categories,
-- so it keeps sending the category of an account the owner merged away or
-- deleted, and the chart's set-up (utils/ledgerData.js ensureChart) made an
-- account for that category again. Two lists stop that:
--
-- LedgerAccount.aliasSlugs: the categories merged into this account. Each one
-- stands for it as its own category does (utils/chart.js indexChart), so an
-- older app's expense in a merged category counts where the merge put it.
--
-- Business.retiredCategorySlugs: the categories of the accounts the owner
-- deleted, or turned into an account of another kind. Nothing makes an
-- account for one of them again, until the owner makes a new account that
-- takes it back on purpose.
--
-- Additive and idempotent: two columns, empty for every existing row.
ALTER TABLE "LedgerAccount" ADD COLUMN IF NOT EXISTS "aliasSlugs" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "Business" ADD COLUMN IF NOT EXISTS "retiredCategorySlugs" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
