// Invoice numbers, in one place.
//
// Four paths mint a number off Business.invoiceCounter: a new invoice or
// quote, a quote converted to an invoice, the recurring-invoice runner and an
// Instagram order. They used to format it four times; now they all call
// allocateInvoiceNumber, so the owner's prefix applies everywhere.
//
// The counter is shared by invoices and quotes, as before. Quotes keep the
// fixed "QTE-" prefix; the owner's prefix is for invoices.

const DEFAULT_PREFIX = "INV-";
const QUOTE_PREFIX = "QTE-";
const MAX_PREFIX = 10;
const MAX_NEXT = 99999999;
// Letters, digits and the separators people actually print on invoices.
const PREFIX_RE = /^[A-Za-z0-9\-_/.#]*$/;

function formatInvoiceNumber(prefix, n) {
  return `${prefix}${String(n).padStart(3, "0")}`;
}

function invoicePrefixOf(business) {
  const p = business?.invoicePrefix;
  return p === null || p === undefined ? DEFAULT_PREFIX : p;
}

// null when invalid. Empty is allowed and means "numbers only".
function normalizePrefix(raw) {
  if (raw === null || raw === undefined) return DEFAULT_PREFIX;
  const p = String(raw).trim();
  if (p.length > MAX_PREFIX || !PREFIX_RE.test(p)) return null;
  return p;
}

// null when invalid.
function normalizeNextNumber(raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_NEXT) return null;
  return n;
}

// Increment the counter and return the first number not already used by this
// business. The skip loop matters after an owner lowers "next number" below
// numbers that already exist; the numbering route refuses that exact case, so
// this is the safety net, bounded so a bad state can never spin forever.
async function allocateInvoiceNumber(db, businessId, type = "invoice") {
  for (let attempt = 0; attempt < 200; attempt++) {
    const biz = await db.business.update({
      where: { id: businessId },
      data: { invoiceCounter: { increment: 1 } },
      select: { invoiceCounter: true, invoicePrefix: true },
    });
    const prefix = type === "quote" ? QUOTE_PREFIX : invoicePrefixOf(biz);
    const number = formatInvoiceNumber(prefix, biz.invoiceCounter);
    const clash = await db.invoice.findFirst({
      where: { businessId, invoiceNumber: number },
      select: { id: true },
    });
    if (!clash) return number;
  }
  throw new Error("Could not find a free invoice number");
}

module.exports = {
  DEFAULT_PREFIX,
  QUOTE_PREFIX,
  MAX_PREFIX,
  MAX_NEXT,
  formatInvoiceNumber,
  invoicePrefixOf,
  normalizePrefix,
  normalizeNextNumber,
  allocateInvoiceNumber,
};
