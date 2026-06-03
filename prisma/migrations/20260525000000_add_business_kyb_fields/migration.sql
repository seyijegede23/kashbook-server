-- Business KYB fields collected from the user during the
-- Get Account Number flow and forwarded to Anchor's
-- /customers (BusinessCustomer) endpoint.
ALTER TABLE "Business"
  ADD COLUMN "description"           TEXT,
  ADD COLUMN "industry"              TEXT,
  ADD COLUMN "registrationType"      TEXT,
  ADD COLUMN "dateOfRegistration"    TIMESTAMP(3),
  ADD COLUMN "addressState"          TEXT,
  ADD COLUMN "addressLine1"          TEXT,
  ADD COLUMN "addressLine2"          TEXT,
  ADD COLUMN "addressCity"           TEXT,
  ADD COLUMN "addressPostalCode"     TEXT,
  ADD COLUMN "directorAddressSame"   BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN "directorAddressLine1"  TEXT,
  ADD COLUMN "directorAddressState"  TEXT,
  ADD COLUMN "directorAddressCity"   TEXT,
  ADD COLUMN "cacCertificateUrl"     TEXT;
