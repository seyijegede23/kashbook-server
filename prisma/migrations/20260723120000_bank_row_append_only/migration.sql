-- Phase C2: append-only guarantee for booked bank-ledger rows.
--
-- A Transaction written by a payment provider (source in anchor/fincra/korapay) is
-- REAL money that feeds the spendable balance. Once booked its money-identity fields
-- are immutable — no code (or stray raw SQL) may change the amount, fee, type,
-- category, payment method, source, currency, business, or reference. This is
-- defense-in-depth behind the Phase A route guards.
--
-- Still allowed: INSERT (including compensating reversing entries — corrections are
-- new rows, never edits), DELETE (cascades + app-guarded paths), and UPDATEs that
-- touch only non-money fields (complianceStatus, flagSeverity, matchedSaleId,
-- matchedCustomerId, updatedAt).

CREATE OR REPLACE FUNCTION kb_bank_row_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD.source IN ('anchor', 'fincra', 'korapay') THEN
    IF NEW.amount        IS DISTINCT FROM OLD.amount
       OR NEW.fee        IS DISTINCT FROM OLD.fee
       OR NEW.type       IS DISTINCT FROM OLD.type
       OR NEW.category   IS DISTINCT FROM OLD.category
       OR NEW."paymentMethod" IS DISTINCT FROM OLD."paymentMethod"
       OR NEW.source     IS DISTINCT FROM OLD.source
       OR NEW.currency   IS DISTINCT FROM OLD.currency
       OR NEW."businessId" IS DISTINCT FROM OLD."businessId"
       OR NEW.reference  IS DISTINCT FROM OLD.reference THEN
      RAISE EXCEPTION 'bank-ledger rows are append-only: money fields are immutable (source=%)', OLD.source
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_kb_bank_row_immutable ON "Transaction";
CREATE TRIGGER trg_kb_bank_row_immutable
  BEFORE UPDATE ON "Transaction"
  FOR EACH ROW EXECUTE FUNCTION kb_bank_row_immutable();
