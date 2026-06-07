// Single source of truth for invoice status calculation.
// Used by the invoices route handlers and the NUBAN auto-reconcile loop.

function recalcInvoiceStatus({ amountPaid, total, dueDate, status }) {
  if (status === "VOID") return "VOID";
  if (amountPaid >= total && total > 0) return "PAID";
  if (amountPaid > 0) {
    if (dueDate && new Date(dueDate) < new Date()) return "OVERDUE";
    return "PARTIAL";
  }
  if (dueDate && new Date(dueDate) < new Date() && status !== "DRAFT") {
    return "OVERDUE";
  }
  return status;
}

module.exports = { recalcInvoiceStatus };
