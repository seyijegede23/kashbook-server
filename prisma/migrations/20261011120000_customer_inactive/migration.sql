-- Mark a customer inactive (2026-10-11, the customer page's More menu, as in
-- Zoho): an inactive customer leaves the Customers list's Active tab and stays
-- under All, with everything they owe and paid unchanged. NULL = active.
-- Additive only (the IRCL app shares this database): one nullable column.
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "inactiveAt" TIMESTAMP(3);
