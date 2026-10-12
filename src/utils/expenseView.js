// An expense as a client receives it (Zoho-style expenses, 2026-10-12). Every
// route that returns an expense (routes/expenses.js, the sync bundle) sends it
// through publicExpense, so the keys that find a receipt on Cloudinary never
// leave the server: a receipt is opened through a short-lived signed link
// (GET /expenses/:id/attachments/:attachmentId/url), never by its storage key.
//
// Expense.attachments holds [{ id, name, mime, size, uploadedAt, publicId,
// resourceType }]; clients get [{ id, name, mime, size, uploadedAt }].
// Expense.items holds an itemized expense's lines (ExpenseItem rows).

// Load an expense with its lines in the order they were entered:
// prisma.expense.findMany({ ..., include: EXPENSE_INCLUDE }).
const EXPENSE_INCLUDE = Object.freeze({ items: { orderBy: { position: "asc" } } });

// A receipt without its storage keys.
function publicAttachment(a) {
  if (!a || typeof a !== "object") return null;
  return { id: a.id, name: a.name, mime: a.mime, size: a.size, uploadedAt: a.uploadedAt };
}

// The receipts as a client sees them: always a list, empty when there are none.
function publicAttachments(list) {
  return Array.isArray(list) ? list.map(publicAttachment).filter(Boolean) : [];
}

// The expense row with its receipts made public and its lines (when loaded)
// in their order. Every other field is sent as it is.
function publicExpense(row) {
  if (!row || typeof row !== "object") return row;
  const out = { ...row, attachments: publicAttachments(row.attachments) };
  if (Array.isArray(row.items)) out.items = [...row.items].sort((a, b) => (a.position || 0) - (b.position || 0));
  return out;
}

module.exports = { EXPENSE_INCLUDE, publicAttachment, publicAttachments, publicExpense };
