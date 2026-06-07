-- LTD support: incorporation date is required for Private_Incorporated.
ALTER TABLE "Business" ADD COLUMN "dateOfIncorporation" TIMESTAMP(3);

-- Multi-owner support: one DIRECTOR row + N OWNER rows per business.
CREATE TABLE "BusinessOfficer" (
  "id"                TEXT NOT NULL,
  "businessId"        TEXT NOT NULL,
  "role"              TEXT NOT NULL,
  "firstName"         TEXT NOT NULL,
  "lastName"          TEXT NOT NULL,
  "middleName"        TEXT,
  "bvn"               TEXT NOT NULL,
  "dateOfBirth"       TIMESTAMP(3) NOT NULL,
  "gender"            TEXT NOT NULL,
  "email"             TEXT,
  "phoneNumber"       TEXT,
  "nationality"       TEXT NOT NULL DEFAULT 'NG',
  "title"             TEXT NOT NULL DEFAULT 'President',
  "percentageOwned"   DOUBLE PRECISION NOT NULL DEFAULT 0,
  "addressLine1"      TEXT,
  "addressLine2"      TEXT,
  "addressCity"       TEXT,
  "addressState"      TEXT,
  "addressPostalCode" TEXT,
  "addressCountry"    TEXT NOT NULL DEFAULT 'NG',
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "BusinessOfficer_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "BusinessOfficer_businessId_idx" ON "BusinessOfficer"("businessId");
ALTER TABLE "BusinessOfficer"
  ADD CONSTRAINT "BusinessOfficer_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
