-- Per-account business-name uniqueness — a database backstop to the
-- application-level check (race-safe across devices/requests).
--
-- Functional UNIQUE index on the NORMALIZED name: lower + trim + collapsed
-- internal whitespace, matching normalizeBusinessName() in
-- server/src/utils/businessName.js. Prisma can't model expression indexes in
-- schema.prisma, so this lives as raw SQL. IF NOT EXISTS keeps it idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS "Business_userId_normalizedName_key"
  ON "Business" ("userId", (lower(regexp_replace(btrim(name), '\s+', ' ', 'g'))));
