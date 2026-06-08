-- RecurringExpense: optional auto-debit fields. Defaults make every
-- existing row behave exactly as before (pure bookkeeping).
ALTER TABLE "RecurringExpense" ADD COLUMN "autoSend"            BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "RecurringExpense" ADD COLUMN "authorizedAt"        TIMESTAMP(3);
ALTER TABLE "RecurringExpense" ADD COLUMN "payeeAccountNumber"  TEXT;
ALTER TABLE "RecurringExpense" ADD COLUMN "payeeBankCode"       TEXT;
ALTER TABLE "RecurringExpense" ADD COLUMN "payeeBankName"       TEXT;
ALTER TABLE "RecurringExpense" ADD COLUMN "payeeAccountName"    TEXT;
ALTER TABLE "RecurringExpense" ADD COLUMN "lastAutoSendAt"      TIMESTAMP(3);
ALTER TABLE "RecurringExpense" ADD COLUMN "lastAutoSendStatus"  TEXT;
ALTER TABLE "RecurringExpense" ADD COLUMN "lastAutoSendRef"     TEXT;
ALTER TABLE "RecurringExpense" ADD COLUMN "consecutiveFailures" INTEGER NOT NULL DEFAULT 0;
CREATE INDEX "RecurringExpense_active_autoSend_idx" ON "RecurringExpense"("active", "autoSend");

-- User: global "pause all auto-debits" kill-switch. On by default so existing
-- users start with auto-debit available; off pauses every recurring item.
ALTER TABLE "User" ADD COLUMN "autoDebitEnabled" BOOLEAN NOT NULL DEFAULT true;
