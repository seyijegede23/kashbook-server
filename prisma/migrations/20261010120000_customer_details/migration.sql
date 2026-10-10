-- Customer details (2026-10-10, owner: "lets do customer like that", the
-- Zoho Add Contact form): who the customer is, how to reach them, their tax
-- number, default payment terms, addresses and contact persons. Invoices keep
-- a copy of the addresses and the tax number as they were when issued, so an
-- edit to the customer never rewrites an issued (or VAT-locked) document.
-- Additive only (the IRCL app shares this database): new nullable columns,
-- nothing changed, retyped or dropped. "name" stays the display name and
-- "phone" stays the mobile number (WhatsApp, reminders, duplicate check).

-- "business" | "individual"; NULL on customers saved before this form.
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "customerType" TEXT;
-- Mr., Mrs., Dr., Chief...
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "salutation" TEXT;
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "firstName" TEXT;
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "lastName" TEXT;
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "companyName" TEXT;
-- Lower-cased, validated like account emails.
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "email" TEXT;
-- The form's "Phone" (office or other); "phone" is the form's "Mobile".
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "workPhone" TEXT;
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "website" TEXT;
-- The customer's TIN, printed on their invoices.
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "taxId" TEXT;
-- Default terms for new invoices: an invoice payment-terms code, never "custom".
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "paymentTerms" TEXT;
-- { attention, street1, street2, city, state, postalCode, country, phone }
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "billingAddress" JSONB;
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "shippingAddress" JSONB;
-- [{ id, salutation, firstName, lastName, email, phone, designation }], at most 10.
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "contactPersons" JSONB;
-- Private remarks; never printed.
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "notes" TEXT;

-- The customer's addresses and TIN as they were when the invoice was saved.
ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "billingAddress" JSONB;
ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "shippingAddress" JSONB;
ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "customerTaxId" TEXT;
