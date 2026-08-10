-- Wire details for FCY (USD/EUR/GBP) receive accounts.
--
-- The previous columns assumed a flat swift/routing/iban shape. Fincra actually
-- returns `bankSwiftCode` (individual, nested under otherInfo) or a flat
-- `swiftCode` (corporate), no "routing" key at all (the ACH routing number is
-- the top-level bankCode), plus a per-rail `alternateAccountDetails` array where
-- each entry carries its OWN memo and SWIFT code. Flattening those into single
-- columns lets one rail's memo be shown beside another rail's SWIFT, which gets
-- the wire rejected or misrouted.
--
-- ADDITIVE ONLY. This database is shared with idealroyalcrown.com running older
-- code, so every column is nullable and nothing existing is altered or dropped.

ALTER TABLE "ForeignAccount" ADD COLUMN IF NOT EXISTS "sortCode" TEXT;
ALTER TABLE "ForeignAccount" ADD COLUMN IF NOT EXISTS "bankAddress" TEXT;
ALTER TABLE "ForeignAccount" ADD COLUMN IF NOT EXISTS "addressableIn" TEXT;
ALTER TABLE "ForeignAccount" ADD COLUMN IF NOT EXISTS "memo" TEXT;
ALTER TABLE "ForeignAccount" ADD COLUMN IF NOT EXISTS "alternateAccountDetails" JSONB;
ALTER TABLE "ForeignAccount" ADD COLUMN IF NOT EXISTS "consentExpiresAt" TIMESTAMP(3);
