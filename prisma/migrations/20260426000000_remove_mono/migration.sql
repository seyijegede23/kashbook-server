-- Drop Mono integration columns and related index.
-- Source column on Transaction is retained — it is used for non-Mono provenance.

-- DropIndex
DROP INDEX IF EXISTS "Transaction_monoTxId_key";

-- AlterTable
ALTER TABLE "Transaction" DROP COLUMN IF EXISTS "monoTxId";

-- AlterTable
ALTER TABLE "Business"
  DROP COLUMN IF EXISTS "monoAccountId",
  DROP COLUMN IF EXISTS "monoAccountNumber",
  DROP COLUMN IF EXISTS "monoAccountBank",
  DROP COLUMN IF EXISTS "monoAccountName",
  DROP COLUMN IF EXISTS "monoLastSynced";
