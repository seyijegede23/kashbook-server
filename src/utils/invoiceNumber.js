// Document numbers, in one place.
//
// A business has two runs of numbers. Invoices and quotes share the invoice
// counter (quotes always print "QTE-"; the owner's prefix is for invoices).
// Credit notes have their own counter and prefix, "CN-" by default. Every path
// that numbers a document calls allocateInvoiceNumber: a new invoice, quote or
// credit note, a converted quote, the recurring runner and an Instagram order.

const DEFAULT_PREFIX = "INV-";
const QUOTE_PREFIX = "QTE-";
const CREDIT_NOTE_PREFIX = "CN-";
const MAX_PREFIX = 10;
const MAX_NEXT = 99999999;
// Letters, digits and the separators people actually print on invoices.
const PREFIX_RE = /^[A-Za-z0-9\-_/.#]*$/;

// Where each run of numbers keeps its counter, prefix and auto/manual mode.
const SERIES = {
  invoice: { counter: "invoiceCounter", prefix: "invoicePrefix", mode: "invoiceNumberMode", defaultPrefix: DEFAULT_PREFIX },
  credit_note: { counter: "creditNoteCounter", prefix: "creditNotePrefix", mode: "creditNoteNumberMode", defaultPrefix: CREDIT_NOTE_PREFIX },
};
function seriesOf(kind) {
  return kind === "credit_note" ? SERIES.credit_note : SERIES.invoice;
}

function formatInvoiceNumber(prefix, n) {
  return `${prefix}${String(n).padStart(3, "0")}`;
}

function prefixOf(business, kind = "invoice") {
  const s = seriesOf(kind);
  const p = business?.[s.prefix];
  return p === null || p === undefined ? s.defaultPrefix : p;
}

function invoicePrefixOf(business) {
  return prefixOf(business, "invoice");
}

// null when invalid. Empty is allowed and means "numbers only".
function normalizePrefix(raw, kind = "invoice") {
  if (raw === null || raw === undefined) return seriesOf(kind).defaultPrefix;
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

// A number the owner typed. Up to 30 characters: letters, digits, single
// spaces and the separators people print on invoices; it must start with a
// letter, a digit or #. undefined = nothing typed (number it automatically),
// null = typed but not acceptable. Mirrored in CreateInvoiceScreen.js.
const MANUAL_NUMBER_RE = /^[A-Za-z0-9#][A-Za-z0-9\-_/.# ]{0,29}$/;
function normalizeManualNumber(raw) {
  if (raw === null || raw === undefined) return undefined;
  const s = String(raw).trim().replace(/\s+/g, " ");
  if (!s) return undefined;
  return MANUAL_NUMBER_RE.test(s) ? s : null;
}

// Is this number already on another document of the business, of any kind?
// Case-blind, so "inv-010" and "INV-010" cannot both exist.
async function numberTaken(db, businessId, number, excludeId = null) {
  const hit = await db.invoice.findFirst({
    where: {
      businessId,
      invoiceNumber: { equals: number, mode: "insensitive" },
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: { id: true },
  });
  return !!hit;
}

// Increment the right counter and return the first number not already used by
// this business. The skip loop matters after an owner lowers "next number"
// below numbers that already exist; the numbering route refuses that exact
// case, so this is the safety net, bounded so a bad state can never spin.
async function allocateInvoiceNumber(db, businessId, type = "invoice") {
  const kind = type === "credit_note" ? "credit_note" : "invoice";
  const s = seriesOf(kind);
  for (let attempt = 0; attempt < 200; attempt++) {
    const biz = await db.business.update({
      where: { id: businessId },
      data: { [s.counter]: { increment: 1 } },
      select: { [s.counter]: true, [s.prefix]: true },
    });
    const prefix = type === "quote" ? QUOTE_PREFIX : prefixOf(biz, kind);
    const number = formatInvoiceNumber(prefix, biz[s.counter]);
    if (!(await numberTaken(db, businessId, number))) return number;
  }
  throw new Error("Could not find a free document number");
}

module.exports = {
  DEFAULT_PREFIX,
  QUOTE_PREFIX,
  CREDIT_NOTE_PREFIX,
  MAX_PREFIX,
  MAX_NEXT,
  SERIES,
  seriesOf,
  formatInvoiceNumber,
  prefixOf,
  invoicePrefixOf,
  normalizePrefix,
  normalizeNextNumber,
  normalizeManualNumber,
  numberTaken,
  allocateInvoiceNumber,
};
