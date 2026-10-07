-- Invoice details, laid out the way the owner asked on 2026-10-07: payment
-- terms, the customer's order number, a salesperson and a subject line, plus
-- a business-chosen invoice number prefix.
--
-- Additive only. This DB is shared with another deployed app running older
-- code: six nullable columns it never selects by name. Nothing existing is
-- altered, renamed, retyped or dropped.

-- due_on_receipt | net_15 | net_30 | net_45 | net_60 | due_end_of_month
-- | due_end_of_next_month | custom. The client computes dueDate from it.
ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "paymentTerms" TEXT;

-- The customer's purchase-order (or reference) number, printed on the invoice.
ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "orderNumber" TEXT;

-- One line telling the customer what the invoice is for.
ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "subject" TEXT;

-- The owner or one of their staff. The name is copied at save time so the
-- document keeps it if the staff member is later renamed or removed.
ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "salespersonId" TEXT;
ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "salespersonName" TEXT;

-- NULL means the default "INV-". An empty string means plain numbers.
ALTER TABLE "Business" ADD COLUMN IF NOT EXISTS "invoicePrefix" TEXT;
