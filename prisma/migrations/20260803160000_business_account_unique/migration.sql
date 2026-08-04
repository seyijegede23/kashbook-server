-- One bank account belongs to exactly ONE business.
--
-- Without these, POST /businesses/:id/sync-anchor-account could copy a single
-- KYC-verified Anchor account onto unlimited businesses. Because AML tier
-- resolution treats "has a virtualAccountNumber" as the verification test, each
-- clone then claimed its OWN full daily/weekly/monthly limits against the SAME
-- real account — an N-times multiplication of the regulator-facing cap with no
-- extra KYC. It also broke the per-business advisory lock's serialization
-- guarantee (two businesses, two locks, one Anchor account).
--
-- Verified before applying: zero duplicate values exist in live data, so these
-- constraints create cleanly. UNIQUE in Postgres permits many NULLs, so
-- unbanked businesses are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS "Business_virtualAccountNumber_key"
  ON "Business" ("virtualAccountNumber");
CREATE UNIQUE INDEX IF NOT EXISTS "Business_anchorAccountId_key"
  ON "Business" ("anchorAccountId");
CREATE UNIQUE INDEX IF NOT EXISTS "Business_providerAccountId_key"
  ON "Business" ("providerAccountId");
