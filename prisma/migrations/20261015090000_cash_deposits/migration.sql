-- Deposit cash (2026-10-14): the owner takes cash from the till to a bank.
-- A deposit moves the business's own money from Cash at Hand to a bank, so it
-- is never a sale and never spending; the books rule (utils/books.js) does not
-- read it. The ledger (utils/ledger.js) posts it on its date:
--
--   into another bank ("account", status done): that bank / Cash at Hand;
--   into the KashBook account ("kashbook", status waiting, then arrived):
--     Undeposited Funds / Cash at Hand, and the bank credit it is linked to
--     posts KashBook Account / Undeposited Funds when it arrives;
--   cancelled: nothing.
--
-- A KashBook deposit is linked to the transfer that brings the cash in
-- (transactionId, set only when it has arrived) by the server itself
-- (utils/cashDeposits.js) or by the owner. A transfer the owner unlinked is
-- kept in rejectedTransactionIds and never linked by itself again.
--
-- Idempotent throughout.

CREATE TABLE IF NOT EXISTS "CashDeposit" (
  "id"                     TEXT NOT NULL,
  "businessId"             TEXT NOT NULL,
  "amount"                 DOUBLE PRECISION NOT NULL,
  "date"                   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "into"                   TEXT NOT NULL,
  "intoAccountId"          TEXT,
  "status"                 TEXT NOT NULL,
  "transactionId"          TEXT,
  "rejectedTransactionIds" JSONB NOT NULL DEFAULT '[]',
  "note"                   TEXT,
  "clientRef"              TEXT,
  "autoLinked"             BOOLEAN NOT NULL DEFAULT false,
  "createdById"            TEXT,
  "createdAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"              TIMESTAMP(3) NOT NULL,
  "arrivedAt"              TIMESTAMP(3),
  "cancelledAt"            TIMESTAMP(3),
  CONSTRAINT "CashDeposit_pkey" PRIMARY KEY ("id"),
  -- Money: more than zero and a real number (NaN and infinity compare above
  -- every number in Postgres, so "> 0" alone lets them through), in naira and
  -- kobo (the route stores the kobo over a hundred; the tolerance only allows
  -- for how a double holds such a value).
  CONSTRAINT "CashDeposit_amount_check" CHECK (
    "amount" > 0 AND "amount" < 'Infinity'
    AND abs("amount" * 100 - round("amount" * 100)) <= 1e-6 * greatest(1, abs("amount" * 100))),
  CONSTRAINT "CashDeposit_into_check" CHECK ("into" IN ('kashbook', 'account')),
  -- Another bank names its account; the KashBook account is the system's own.
  CONSTRAINT "CashDeposit_into_account_check" CHECK (("into" = 'account') = ("intoAccountId" IS NOT NULL)),
  -- A KashBook deposit waits for its transfer, then has arrived; one into
  -- another bank is done at once. Either may be cancelled.
  CONSTRAINT "CashDeposit_status_check" CHECK (
    ("into" = 'kashbook' AND "status" IN ('waiting', 'arrived', 'cancelled'))
    OR ("into" = 'account' AND "status" IN ('done', 'cancelled'))),
  -- The transfer is named exactly while the deposit has arrived.
  CONSTRAINT "CashDeposit_arrived_check" CHECK (("status" = 'arrived') = ("transactionId" IS NOT NULL)),
  CONSTRAINT "CashDeposit_rejected_check" CHECK (jsonb_typeof("rejectedTransactionIds") = 'array')
);

-- One deposit per transfer, and one per request the app retries (clientRef).
CREATE UNIQUE INDEX IF NOT EXISTS "CashDeposit_transactionId_key" ON "CashDeposit"("transactionId");
CREATE UNIQUE INDEX IF NOT EXISTS "CashDeposit_businessId_clientRef_key" ON "CashDeposit"("businessId", "clientRef");
CREATE INDEX IF NOT EXISTS "CashDeposit_businessId_status_idx" ON "CashDeposit"("businessId", "status");
CREATE INDEX IF NOT EXISTS "CashDeposit_businessId_date_idx" ON "CashDeposit"("businessId", "date");
CREATE INDEX IF NOT EXISTS "CashDeposit_intoAccountId_idx" ON "CashDeposit"("intoAccountId");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CashDeposit_businessId_fkey') THEN
    ALTER TABLE "CashDeposit" ADD CONSTRAINT "CashDeposit_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  -- An account a deposit went into, and a transfer a deposit is linked to,
  -- are refused deletion. The check waits for the end of the transaction
  -- (DEFERRABLE INITIALLY DEFERRED), as for a journal line's account:
  -- deleting a business removes its accounts, its bank rows and its deposits
  -- in one statement, and an immediate check (RESTRICT, or plain NO ACTION)
  -- would run while the deposits are still there and refuse the whole
  -- deletion. Deferred, it sees them gone. A delete of an account or a
  -- transfer a deposit still names is refused all the same: by its own
  -- statement outside a transaction, at COMMIT inside one.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CashDeposit_intoAccountId_fkey') THEN
    ALTER TABLE "CashDeposit" ADD CONSTRAINT "CashDeposit_intoAccountId_fkey"
      FOREIGN KEY ("intoAccountId") REFERENCES "LedgerAccount"("id") ON DELETE NO ACTION ON UPDATE CASCADE
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CashDeposit_transactionId_fkey') THEN
    ALTER TABLE "CashDeposit" ADD CONSTRAINT "CashDeposit_transactionId_fkey"
      FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE NO ACTION ON UPDATE CASCADE
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
