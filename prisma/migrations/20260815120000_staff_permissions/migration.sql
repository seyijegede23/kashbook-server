-- ADDITIVE ONLY. The kashbook database is SHARED with another deployed app
-- running older code. Nothing existing is altered or dropped: this is one
-- brand-new table that app has never heard of, plus one index on a column that
-- has been queried unindexed since it was introduced.
--
-- Row existence is the grant, so creating this table grants nothing to anyone.

CREATE TABLE IF NOT EXISTS "StaffPermission" (
  "id"                TEXT NOT NULL,
  "userId"            TEXT NOT NULL,
  "employerId"        TEXT NOT NULL,
  "canViewBalance"    BOOLEAN NOT NULL DEFAULT false,
  "canTransfer"       BOOLEAN NOT NULL DEFAULT false,
  "canViewReports"    BOOLEAN NOT NULL DEFAULT false,
  "canManagePayables" BOOLEAN NOT NULL DEFAULT false,
  "dailyTransferCap"  DOUBLE PRECISION,
  "grantedById"       TEXT NOT NULL,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StaffPermission_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "StaffPermission_userId_key"     ON "StaffPermission"("userId");
CREATE INDEX        IF NOT EXISTS "StaffPermission_employerId_idx" ON "StaffPermission"("employerId");

-- The FK targets the NEW table only; "User" itself is never altered.
DO $$ BEGIN
  ALTER TABLE "StaffPermission"
    ADD CONSTRAINT "StaffPermission_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- employerId has been queried without an index since staff were introduced
-- (the staff list, and now every permission read).
CREATE INDEX IF NOT EXISTS "User_employerId_idx" ON "User"("employerId");
