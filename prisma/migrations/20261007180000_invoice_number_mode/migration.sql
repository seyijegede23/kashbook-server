-- How a business numbers its invoices: NULL or 'auto' = the server issues the
-- next number (prefix + counter); 'manual' = the app asks for a number on every
-- new invoice. Owner request 2026-10-07, matching Zoho Invoice's three options
-- (the third, "manually only for this invoice", needs no column).
--
-- Additive only: one nullable column the older app sharing this DB never reads.
ALTER TABLE "Business" ADD COLUMN IF NOT EXISTS "invoiceNumberMode" TEXT;
