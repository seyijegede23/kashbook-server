-- ──────────────────────────────────────────────────────────────────────────
-- Pre-Anchor KYC validation. Adds:
--   • Searchable HMAC fingerprints on Business + BusinessOfficer for BVN/CAC
--     dedup. Encrypted plaintext stays in kycBvn / kycCacNumber / bvn.
--   • Generic KycCheckAttempt audit-and-rate-limit ledger.
--   • Generic KycCheckCache for 24h-TTL Dojah responses.
--
-- Existing rows backfill with NULL hashes; the route handler computes them
-- lazily on the next KYC submission. No data migration required.
-- ──────────────────────────────────────────────────────────────────────────

-- Business: searchable identifier hashes for dedup.
ALTER TABLE "Business" ADD COLUMN "kycBvnHash"         VARCHAR(64);
ALTER TABLE "Business" ADD COLUMN "kycCacHash"         VARCHAR(64);

CREATE INDEX "Business_kycBvnHash_idx" ON "Business"("kycBvnHash");
CREATE INDEX "Business_kycCacHash_idx" ON "Business"("kycCacHash");

-- BusinessOfficer: searchable BVN hash for shareholder-level dedup.
ALTER TABLE "BusinessOfficer" ADD COLUMN "bvnHash" VARCHAR(64);
CREATE INDEX "BusinessOfficer_bvnHash_idx" ON "BusinessOfficer"("bvnHash");

-- Generic audit + rate-limit ledger. Append-only.
CREATE TABLE "KycCheckAttempt" (
  "id"            TEXT          NOT NULL,
  "userId"        TEXT          NOT NULL,
  "checkType"     TEXT          NOT NULL,
  "valueHash"     VARCHAR(64)   NOT NULL,
  "result"        TEXT          NOT NULL,
  "provider"      TEXT,
  "cached"        BOOLEAN       NOT NULL DEFAULT false,
  "errorMessage"  TEXT,
  "createdAt"     TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "KycCheckAttempt_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "KycCheckAttempt_userId_createdAt_idx"
  ON "KycCheckAttempt"("userId", "createdAt");
CREATE INDEX "KycCheckAttempt_checkType_valueHash_createdAt_idx"
  ON "KycCheckAttempt"("checkType", "valueHash", "createdAt");

-- Generic response cache. Composite PK (checkType, valueHash) keeps the
-- table compact and the lookup point-query fast.
CREATE TABLE "KycCheckCache" (
  "checkType"    TEXT          NOT NULL,
  "valueHash"    VARCHAR(64)   NOT NULL,
  "provider"     TEXT          NOT NULL,
  "result"       JSONB         NOT NULL,
  "cachedAt"     TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "KycCheckCache_pkey" PRIMARY KEY ("checkType", "valueHash")
);

CREATE INDEX "KycCheckCache_cachedAt_idx" ON "KycCheckCache"("cachedAt");
