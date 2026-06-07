// KEEP IN SYNC WITH src/utils/invoiceHtml.js (client mirror, ESM export form)
//
// Single source of truth for rendering invoices to HTML. Used by:
//   - Client: handleShare in InvoiceDetailScreen (printToFile → PDF)
//   - Client: live WebView preview in CreateInvoiceScreen
//   - Server: GET /i/:token (public hosted invoice page)
//
// Four templates: classic | modern | minimal | bold.
// Payment block auto-derives from NUBAN unless usePaymentOverride.

const QRCode = require("qrcode");

// ──────────────────────────────────────────────────────────────────────────
// Public derivations
// ──────────────────────────────────────────────────────────────────────────

function deriveInvoicePaymentBlock(business) {
  if (!business) return null;
  if (business.usePaymentOverride && business.bankAccountNumber) {
    return {
      bank: business.bankName || "",
      number: business.bankAccountNumber,
      name: business.bankAccountName || business.name || "",
      source: "manual",
    };
  }
  if (business.virtualAccountNumber) {
    return {
      bank: business.virtualAccountBank || "PROVIDUS BANK",
      number: business.virtualAccountNumber,
      name: business.virtualAccountName || business.name || "",
      source: "nuban",
    };
  }
  return null;
}

async function buildQrDataUrl(text) {
  if (!text) return "";
  try {
    return await QRCode.toDataURL(text, {
      errorCorrectionLevel: "M",
      margin: 1,
      width: 160,
      color: { dark: "#111111", light: "#FFFFFF" },
    });
  } catch {
    return "";
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Format helpers
// ──────────────────────────────────────────────────────────────────────────

const CURRENCY_SYMBOLS = {
  NGN: "₦", USD: "$", EUR: "€", GBP: "£", GHS: "₵", KES: "KSh",
  ZAR: "R", CAD: "C$", AUD: "A$", INR: "₹", JPY: "¥", CNY: "¥",
  EGP: "ج.م", UGX: "USh", TZS: "TSh", RWF: "RF", XOF: "CFA", XAF: "FCFA", MAD: "DH",
};

// Per-currency locale fallback. Used when the caller doesn't pass a
// locale explicitly — keeps formatting "correct enough" for any currency
// even if we forget to thread the business locale through.
const CURRENCY_LOCALES = {
  NGN: "en-NG", GHS: "en-GH", KES: "en-KE", ZAR: "en-ZA",
  EGP: "ar-EG", UGX: "en-UG", TZS: "en-TZ", RWF: "rw-RW",
  XOF: "fr-CI", XAF: "fr-CM", MAD: "ar-MA",
  USD: "en-US", EUR: "de-DE", GBP: "en-GB", CAD: "en-CA",
  AUD: "en-AU", INR: "en-IN", JPY: "ja-JP", CNY: "zh-CN",
};

function fmt(n, currency = "NGN", locale) {
  const sym = CURRENCY_SYMBOLS[currency] || "";
  const loc = locale || CURRENCY_LOCALES[currency] || "en-US";
  const num = Number(n || 0);
  return `${sym}${num.toLocaleString(loc, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function esc(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const STATUS_COLORS = {
  draft:   "#6B7280",
  sent:    "#3B82F6",
  partial: "#F59E0B",
  paid:    "#10B981",
  overdue: "#EF4444",
  void:    "#9CA3AF",
};

const STATUS_LABELS = {
  draft:   "Draft",
  sent:    "Sent",
  partial: "Partial",
  paid:    "Paid",
  overdue: "Overdue",
  void:    "Void",
};

// ──────────────────────────────────────────────────────────────────────────
// Main entry
// ──────────────────────────────────────────────────────────────────────────

function buildInvoiceHtml({
  invoice,
  business,
  customer,
  payment,
  shareUrl,
  qrDataUrl,
}) {
  const tmpl = (invoice.template || business?.invoiceTemplate || "classic").toLowerCase();
  const ctx = buildCtx({ invoice, business, customer, payment, shareUrl, qrDataUrl });

  if (tmpl === "modern") return modernTemplate(ctx);
  if (tmpl === "minimal") return minimalTemplate(ctx);
  if (tmpl === "bold") return boldTemplate(ctx);
  return classicTemplate(ctx);
}

function buildCtx({ invoice, business, customer, payment, shareUrl, qrDataUrl }) {
  const today = new Date().toISOString().slice(0, 10);
  const liveStatus =
    invoice.status !== "paid" && invoice.status !== "void" && invoice.dueDate && invoice.dueDate < today
      ? "overdue"
      : (invoice.status || "draft").toLowerCase();

  const balance = Math.max(0, Number(invoice.total || 0) - Number(invoice.amountPaid || 0));
  const currency = invoice.currency || "NGN";

  return {
    invoice,
    business: business || {},
    customer: customer || null,
    payment: payment || null,
    shareUrl: shareUrl || "",
    qrDataUrl: qrDataUrl || "",
    liveStatus,
    statusColor: STATUS_COLORS[liveStatus] || "#6B7280",
    statusLabel: STATUS_LABELS[liveStatus] || "Draft",
    balance,
    currency,
    accent: business?.color || "#2563EB",
    logoUrl: business?.logoUrl || null,
    bizName: business?.name || "My Business",
    footer: business?.receiptFooter || "",
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Shared HTML fragments
// ──────────────────────────────────────────────────────────────────────────

function itemRows(items, currency, opts = {}) {
  const { rowBg = "transparent", altBg = "transparent" } = opts;
  return (items || []).map((it, i) => `
    <tr style="background:${i % 2 === 0 ? rowBg : altBg};">
      <td style="padding:11px 10px;vertical-align:top;">
        <div style="font-weight:600;">${esc(it.name)}</div>
        ${it.description ? `<div style="font-size:12px;color:#6B7280;margin-top:2px;">${esc(it.description)}</div>` : ""}
      </td>
      <td style="padding:11px 10px;text-align:center;">${Number(it.quantity || 0)}</td>
      <td style="padding:11px 10px;text-align:right;">${fmt(it.rate, currency)}</td>
      <td style="padding:11px 10px;text-align:right;font-weight:700;">${fmt(it.amount, currency)}</td>
    </tr>`).join("");
}

function totals(invoice, currency, balance, liveStatus) {
  const t = invoice;
  return `
    <div class="totals-row"><span>Subtotal</span><span>${fmt(t.subtotal, currency)}</span></div>
    ${t.taxAmount > 0 ? `<div class="totals-row"><span>Tax (${Number(t.taxRate || 0)}%)</span><span>+${fmt(t.taxAmount, currency)}</span></div>` : ""}
    ${t.discountAmount > 0 ? `<div class="totals-row"><span>Discount</span><span>-${fmt(t.discountAmount, currency)}</span></div>` : ""}
    <hr class="totals-divider" />
    <div class="totals-grand"><span>Total</span><span>${fmt(t.total, currency)}</span></div>
    ${t.amountPaid > 0 ? `<div class="totals-row" style="color:#10B981;font-weight:600;"><span>Amount Paid</span><span>${fmt(t.amountPaid, currency)}</span></div>` : ""}
    <div class="balance-row ${liveStatus === "paid" ? "balance-paid" : ""}"><span>Balance Due</span><span>${fmt(balance, currency)}</span></div>`;
}

function metaBlocks(invoice, customer, liveStatus) {
  return `
    ${customer?.name ? `<div class="meta-block"><label>Bill To</label><p>${esc(customer.name)}</p>${customer.phone ? `<p style="color:#6B7280;font-size:13px;">${esc(customer.phone)}</p>` : ""}</div>` : ""}
    <div class="meta-block"><label>Issue Date</label><p>${esc(invoice.issueDate)}</p></div>
    ${invoice.dueDate ? `<div class="meta-block"><label>Due Date</label><p style="color:${liveStatus === "overdue" ? "#EF4444" : "inherit"};">${esc(invoice.dueDate)}</p></div>` : ""}`;
}

function paymentBlock(payment, qrDataUrl, shareUrl, opts = {}) {
  if (!payment) return "";
  const { variant = "card", accent = "#2563EB" } = opts;
  const qrImg = qrDataUrl
    ? `<img src="${qrDataUrl}" alt="QR" style="width:96px;height:96px;display:block;border-radius:6px;border:1px solid #E5E7EB;background:#fff;" />`
    : "";
  const linkLine = shareUrl
    ? `<div class="pay-link" style="margin-top:8px;font-size:11px;color:#6B7280;word-break:break-all;">${esc(shareUrl)}</div>`
    : "";
  const sourceTag = payment.source === "nuban"
    ? `<span class="pay-badge" style="display:inline-block;font-size:9px;font-weight:800;letter-spacing:0.5px;color:${accent};background:${accent}1A;padding:3px 7px;border-radius:6px;margin-left:8px;text-transform:uppercase;">Auto-reconciling</span>`
    : "";

  const inner = `
    <div style="flex:1;">
      <div class="pay-title">Pay Into${sourceTag}</div>
      ${payment.bank ? `<div class="pay-row"><span class="pay-label">Bank</span><span class="pay-value">${esc(payment.bank)}</span></div>` : ""}
      <div class="pay-row"><span class="pay-label">Account No</span><span class="pay-value" style="font-weight:800;font-size:16px;letter-spacing:0.5px;">${esc(payment.number)}</span></div>
      ${payment.name ? `<div class="pay-row"><span class="pay-label">Account Name</span><span class="pay-value">${esc(payment.name)}</span></div>` : ""}
      ${linkLine}
    </div>
    ${qrImg ? `<div style="margin-left:14px;text-align:center;">
      ${qrImg}
      <div style="font-size:9px;color:#9CA3AF;margin-top:4px;text-transform:uppercase;letter-spacing:0.5px;">Scan to view</div>
    </div>` : ""}`;

  if (variant === "card") {
    return `<div class="pay-card" style="display:flex;align-items:flex-start;margin-top:24px;padding:16px;background:#F8F9FA;border-radius:12px;border:1px solid #E5E7EB;">${inner}</div>`;
  }
  if (variant === "hero") {
    return `<div class="pay-hero" style="display:flex;align-items:flex-start;margin-top:24px;padding:20px;background:linear-gradient(135deg, ${accent}, ${accent}CC);border-radius:14px;color:#fff;">${inner}</div>`;
  }
  if (variant === "plain") {
    return `<div class="pay-plain" style="display:flex;align-items:flex-start;margin-top:24px;padding:14px 0;border-top:1px solid #E5E7EB;">${inner}</div>`;
  }
  return `<div class="pay-card">${inner}</div>`;
}

function notesFooter(invoice, footer, bizName) {
  return `
    ${invoice.notes || invoice.terms ? `<div class="notes-section">${invoice.notes ? `<div class="notes-title">Notes</div><div class="notes-text">${esc(invoice.notes)}</div>` : ""}${invoice.terms ? `<div class="notes-title" style="margin-top:12px;">Terms</div><div class="notes-text">${esc(invoice.terms)}</div>` : ""}</div>` : ""}
    <div class="footer">${esc(footer || `Generated by KashBook · ${bizName}`)}</div>`;
}

const SHARED_PAY_STYLES = `
  .pay-card .pay-title,.pay-plain .pay-title,.pay-hero .pay-title{font-size:10px;font-weight:800;color:#6B7280;text-transform:uppercase;letter-spacing:0.8px;margin-bottom:10px;display:flex;align-items:center;}
  .pay-hero .pay-title{color:rgba(255,255,255,0.85);}
  .pay-hero .pay-row{color:#fff;}.pay-hero .pay-label{color:rgba(255,255,255,0.7);}
  .pay-row{font-size:13px;color:#374151;margin-bottom:6px;display:flex;justify-content:space-between;align-items:baseline;gap:12px;}
  .pay-label{color:#9CA3AF;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.4px;}
  .pay-value{color:inherit;font-weight:600;text-align:right;}
`;

// ──────────────────────────────────────────────────────────────────────────
// Template: CLASSIC
// ──────────────────────────────────────────────────────────────────────────

function classicTemplate(ctx) {
  const { invoice, accent, logoUrl, bizName, statusColor, statusLabel, balance,
    currency, customer, payment, qrDataUrl, shareUrl, footer, liveStatus } = ctx;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<style>
  *{margin:0;padding:0;box-sizing:border-box;}
  body{font-family:-apple-system,Helvetica,Arial,sans-serif;background:#fff;color:#111;}
  .page{max-width:720px;margin:0 auto;padding:44px 36px 56px;}
  .header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px;}
  .biz-name{font-size:22px;font-weight:800;color:#111;margin-top:8px;}
  .invoice-number{font-size:26px;font-weight:800;color:${accent};}
  .status-badge{display:inline-block;padding:4px 14px;border-radius:20px;font-size:12px;font-weight:700;background:#F3F4F6;color:${statusColor};margin-top:6px;border:1.5px solid ${statusColor};}
  .accent-bar{height:4px;background:${accent};border-radius:2px;margin-bottom:28px;}
  .meta-row{display:flex;gap:40px;margin-bottom:28px;flex-wrap:wrap;}
  .meta-block{min-width:140px;}
  .meta-block label{font-size:11px;font-weight:700;color:#9CA3AF;text-transform:uppercase;letter-spacing:0.5px;display:block;margin-bottom:4px;}
  .meta-block p{font-size:14px;color:#111;font-weight:500;}
  table{width:100%;border-collapse:collapse;margin-bottom:24px;}
  thead tr{background:#F9FAFB;border-bottom:2px solid #E5E7EB;}
  thead th{padding:11px 10px;font-size:11px;font-weight:700;color:#6B7280;text-transform:uppercase;letter-spacing:0.5px;}
  thead th:first-child{text-align:left;}thead th:not(:first-child){text-align:right;}thead th:nth-child(2){text-align:center;}
  tbody tr{border-bottom:1px solid #F3F4F6;}
  .totals{margin-left:auto;width:280px;}
  .totals-row{display:flex;justify-content:space-between;padding:6px 0;font-size:14px;color:#374151;}
  .totals-divider{border:none;border-top:1px solid #E5E7EB;margin:6px 0;}
  .totals-grand{display:flex;justify-content:space-between;padding:10px 0;font-size:17px;font-weight:800;color:#111;}
  .balance-row{display:flex;justify-content:space-between;padding:11px 14px;border-radius:10px;background:#FEF2F2;font-size:15px;font-weight:700;color:#EF4444;margin-top:6px;}
  .balance-paid{background:#D1FAE5;color:#10B981;}
  .notes-section{margin-top:32px;padding-top:20px;border-top:2px solid #E5E7EB;}
  .notes-title{font-size:12px;font-weight:700;color:#9CA3AF;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;}
  .notes-text{font-size:13px;color:#374151;line-height:1.5;}
  .footer{margin-top:40px;text-align:center;font-size:11px;color:#9CA3AF;}
  ${SHARED_PAY_STYLES}
</style></head><body>
<div class="page">
  <div class="header">
    <div>
      ${logoUrl ? `<img src="${esc(logoUrl)}" alt="logo" style="height:60px;max-width:160px;object-fit:contain;"/>` : ""}
      <div class="biz-name">${esc(bizName)}</div>
    </div>
    <div style="text-align:right;">
      <div class="invoice-number">${esc(invoice.invoiceNumber)}</div>
      <div class="status-badge">${statusLabel.toUpperCase()}</div>
    </div>
  </div>
  <div class="accent-bar"></div>
  <div class="meta-row">${metaBlocks(invoice, customer, liveStatus)}</div>
  <table>
    <thead><tr><th>Item</th><th>Qty</th><th>Rate</th><th>Amount</th></tr></thead>
    <tbody>${itemRows(invoice.items, currency)}</tbody>
  </table>
  <div class="totals">${totals(invoice, currency, balance, liveStatus)}</div>
  ${paymentBlock(payment, qrDataUrl, shareUrl, { variant: "card", accent })}
  ${notesFooter(invoice, footer, bizName)}
</div>
</body></html>`;
}

// ──────────────────────────────────────────────────────────────────────────
// Template: MODERN
// ──────────────────────────────────────────────────────────────────────────

function modernTemplate(ctx) {
  const { invoice, accent, logoUrl, bizName, statusColor, statusLabel, balance,
    currency, customer, payment, qrDataUrl, shareUrl, footer, liveStatus } = ctx;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<style>
  *{margin:0;padding:0;box-sizing:border-box;}
  body{font-family:-apple-system,Helvetica,Arial,sans-serif;background:#fff;color:#111;}
  .page{max-width:720px;margin:0 auto;}
  .dark-header{background:#1E1E2E;padding:36px 36px 28px;display:flex;justify-content:space-between;align-items:flex-start;}
  .biz-block{flex:1;}
  .biz-name-dark{font-size:20px;font-weight:800;color:#fff;margin-top:10px;}
  .inv-block{text-align:right;}
  .inv-number{font-size:32px;font-weight:900;color:#fff;line-height:1;}
  .inv-label{font-size:11px;font-weight:700;color:rgba(255,255,255,0.5);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;}
  .status-pill{display:inline-block;padding:5px 16px;border-radius:20px;font-size:11px;font-weight:800;color:#fff;background:${statusColor};margin-top:10px;}
  .body-pad{padding:32px 36px 48px;}
  .meta-row{display:flex;gap:40px;margin-bottom:28px;flex-wrap:wrap;}
  .meta-block{min-width:140px;}
  .meta-block label{font-size:10px;font-weight:800;color:#9CA3AF;text-transform:uppercase;letter-spacing:0.8px;display:block;margin-bottom:5px;}
  .meta-block p{font-size:14px;color:#111;font-weight:500;}
  table{width:100%;border-collapse:collapse;margin-bottom:24px;}
  thead tr{background:${accent};}
  thead th{padding:12px 10px;font-size:10px;font-weight:800;color:#fff;text-transform:uppercase;letter-spacing:0.5px;}
  thead th:first-child{text-align:left;}thead th:not(:first-child){text-align:right;}thead th:nth-child(2){text-align:center;}
  tbody tr{border-bottom:1px solid #F3F4F6;}
  .totals{margin-left:auto;width:280px;}
  .totals-row{display:flex;justify-content:space-between;padding:7px 0;font-size:14px;color:#374151;}
  .totals-divider{border:none;border-top:2px solid #E5E7EB;margin:8px 0;}
  .totals-grand{display:flex;justify-content:space-between;padding:10px 0;font-size:18px;font-weight:900;color:#111;}
  .balance-row{display:flex;justify-content:space-between;padding:12px 16px;border-radius:10px;background:#FEF2F2;font-size:15px;font-weight:800;color:#EF4444;margin-top:8px;}
  .balance-paid{background:#D1FAE5;color:#10B981;}
  .notes-section{margin-top:28px;padding-top:20px;border-top:2px solid #E5E7EB;}
  .notes-title{font-size:11px;font-weight:800;color:#9CA3AF;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;}
  .notes-text{font-size:13px;color:#374151;line-height:1.6;}
  .footer{margin-top:36px;text-align:center;font-size:11px;color:#9CA3AF;}
  ${SHARED_PAY_STYLES}
</style></head><body>
<div class="page">
  <div class="dark-header">
    <div class="biz-block">
      ${logoUrl ? `<img src="${esc(logoUrl)}" alt="logo" style="height:52px;max-width:150px;object-fit:contain;"/>` : ""}
      <div class="biz-name-dark">${esc(bizName)}</div>
    </div>
    <div class="inv-block">
      <div class="inv-label">Invoice</div>
      <div class="inv-number">${esc(invoice.invoiceNumber)}</div>
      <div class="status-pill">${statusLabel.toUpperCase()}</div>
    </div>
  </div>
  <div class="body-pad">
    <div class="meta-row">${metaBlocks(invoice, customer, liveStatus)}</div>
    <table>
      <thead><tr><th>Item</th><th>Qty</th><th>Rate</th><th>Amount</th></tr></thead>
      <tbody>${itemRows(invoice.items, currency, { rowBg: "#FAFAFA", altBg: "#fff" })}</tbody>
    </table>
    <div class="totals">${totals(invoice, currency, balance, liveStatus)}</div>
    ${paymentBlock(payment, qrDataUrl, shareUrl, { variant: "card", accent })}
    ${notesFooter(invoice, footer, bizName)}
  </div>
</div>
</body></html>`;
}

// ──────────────────────────────────────────────────────────────────────────
// Template: MINIMAL
// ──────────────────────────────────────────────────────────────────────────

function minimalTemplate(ctx) {
  const { invoice, accent, logoUrl, bizName, statusColor, statusLabel, balance,
    currency, customer, payment, qrDataUrl, shareUrl, footer, liveStatus } = ctx;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<style>
  *{margin:0;padding:0;box-sizing:border-box;}
  body{font-family:Georgia,"Times New Roman",serif;background:#fff;color:#111;}
  .page{max-width:680px;margin:0 auto;padding:48px 40px 56px;}
  .header{display:flex;justify-content:space-between;align-items:flex-end;padding-bottom:20px;border-bottom:2px solid #111;margin-bottom:36px;}
  .biz-block{flex:1;}
  .biz-name-min{font-size:20px;font-weight:700;color:#111;margin-top:8px;font-family:-apple-system,Helvetica,Arial,sans-serif;}
  .inv-number-min{font-size:40px;font-weight:300;color:#111;letter-spacing:-1px;line-height:1;}
  .status-min{font-size:12px;font-weight:700;color:${statusColor};text-transform:uppercase;letter-spacing:1px;font-family:-apple-system,Helvetica,Arial,sans-serif;margin-top:4px;}
  .meta-row{display:flex;gap:48px;margin-bottom:32px;flex-wrap:wrap;}
  .meta-block{min-width:140px;}
  .meta-block label{font-size:10px;font-weight:700;color:#9CA3AF;text-transform:uppercase;letter-spacing:0.8px;display:block;margin-bottom:4px;font-family:-apple-system,Helvetica,Arial,sans-serif;}
  .meta-block p{font-size:14px;color:#111;}
  table{width:100%;border-collapse:collapse;margin-bottom:28px;}
  thead tr{border-bottom:2px solid #111;}
  thead th{padding:9px 6px;font-size:10px;font-weight:700;color:#6B7280;text-transform:uppercase;letter-spacing:0.5px;font-family:-apple-system,Helvetica,Arial,sans-serif;}
  thead th:first-child{text-align:left;}thead th:not(:first-child){text-align:right;}thead th:nth-child(2){text-align:center;}
  tbody tr{border-bottom:1px solid #E5E7EB;}
  .totals{margin-left:auto;width:260px;}
  .totals-row{display:flex;justify-content:space-between;padding:6px 0;font-size:13px;color:#374151;font-family:-apple-system,Helvetica,Arial,sans-serif;}
  .totals-divider{border:none;border-top:1px solid #111;margin:8px 0;}
  .totals-grand{display:flex;justify-content:space-between;padding:10px 0;font-size:17px;font-weight:700;color:#111;font-family:-apple-system,Helvetica,Arial,sans-serif;}
  .balance-row{display:flex;justify-content:space-between;padding:10px 0;font-size:15px;font-weight:700;color:#EF4444;border-top:2px solid #EF4444;margin-top:6px;font-family:-apple-system,Helvetica,Arial,sans-serif;}
  .balance-paid{color:#10B981;border-color:#10B981;}
  .notes-section{margin-top:32px;padding-top:20px;border-top:1px solid #E5E7EB;}
  .notes-title{font-size:10px;font-weight:700;color:#9CA3AF;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;font-family:-apple-system,Helvetica,Arial,sans-serif;}
  .notes-text{font-size:13px;color:#374151;line-height:1.6;}
  .footer{margin-top:48px;font-size:11px;color:#9CA3AF;font-family:-apple-system,Helvetica,Arial,sans-serif;text-align:center;}
  ${SHARED_PAY_STYLES}
</style></head><body>
<div class="page">
  <div class="header">
    <div class="biz-block">
      ${logoUrl ? `<img src="${esc(logoUrl)}" alt="logo" style="height:48px;max-width:140px;object-fit:contain;"/>` : ""}
      <div class="biz-name-min">${esc(bizName)}</div>
    </div>
    <div style="text-align:right;">
      <div class="inv-number-min">${esc(invoice.invoiceNumber)}</div>
      <div class="status-min">${statusLabel}</div>
    </div>
  </div>
  <div class="meta-row">${metaBlocks(invoice, customer, liveStatus)}</div>
  <table>
    <thead><tr><th>Item</th><th>Qty</th><th>Rate</th><th>Amount</th></tr></thead>
    <tbody>${itemRows(invoice.items, currency)}</tbody>
  </table>
  <div class="totals">${totals(invoice, currency, balance, liveStatus)}</div>
  ${paymentBlock(payment, qrDataUrl, shareUrl, { variant: "plain", accent })}
  ${notesFooter(invoice, footer, bizName)}
</div>
</body></html>`;
}

// ──────────────────────────────────────────────────────────────────────────
// Template: BOLD (new)
// ──────────────────────────────────────────────────────────────────────────

function boldTemplate(ctx) {
  const { invoice, accent, logoUrl, bizName, statusLabel, balance,
    currency, customer, payment, qrDataUrl, shareUrl, footer, liveStatus } = ctx;

  const itemCards = (invoice.items || []).map((it) => `
    <div class="item-card">
      <div class="item-card-head">
        <div class="item-name">${esc(it.name)}</div>
        <div class="item-amount">${fmt(it.amount, currency)}</div>
      </div>
      <div class="item-card-meta">
        ${it.description ? `<div class="item-desc">${esc(it.description)}</div>` : ""}
        <div class="item-qty">${Number(it.quantity || 0)} × ${fmt(it.rate, currency)}</div>
      </div>
    </div>`).join("");

  return `<!DOCTYPE html><html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<style>
  *{margin:0;padding:0;box-sizing:border-box;}
  body{font-family:-apple-system,Helvetica,Arial,sans-serif;background:#fff;color:#111;}
  .page{max-width:720px;margin:0 auto;}
  .hero{background:${accent};padding:48px 36px 36px;color:#fff;text-align:center;}
  .hero-logo{height:56px;max-width:160px;object-fit:contain;margin-bottom:14px;filter:brightness(0) invert(1);}
  .hero-biz{font-size:14px;font-weight:600;color:rgba(255,255,255,0.85);text-transform:uppercase;letter-spacing:1px;}
  .hero-label{font-size:11px;font-weight:700;color:rgba(255,255,255,0.6);text-transform:uppercase;letter-spacing:2px;margin-top:22px;}
  .hero-number{font-size:48px;font-weight:900;color:#fff;line-height:1.1;letter-spacing:-1px;}
  .hero-status{display:inline-block;margin-top:14px;padding:6px 18px;border-radius:30px;font-size:11px;font-weight:800;background:rgba(255,255,255,0.18);color:#fff;text-transform:uppercase;letter-spacing:1.2px;}
  .hero-amount{margin-top:24px;padding-top:22px;border-top:1px solid rgba(255,255,255,0.2);}
  .hero-amount-label{font-size:11px;font-weight:700;color:rgba(255,255,255,0.65);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;}
  .hero-amount-value{font-size:32px;font-weight:900;color:#fff;}
  .body-pad{padding:36px 36px 48px;}
  .meta-row{display:flex;gap:32px;margin-bottom:28px;flex-wrap:wrap;}
  .meta-block{min-width:140px;}
  .meta-block label{font-size:10px;font-weight:800;color:#9CA3AF;text-transform:uppercase;letter-spacing:0.8px;display:block;margin-bottom:5px;}
  .meta-block p{font-size:14px;color:#111;font-weight:600;}
  .items-title{font-size:11px;font-weight:800;color:#9CA3AF;text-transform:uppercase;letter-spacing:0.8px;margin-bottom:12px;}
  .item-card{padding:14px 16px;background:#F8F9FA;border-radius:12px;margin-bottom:8px;border:1px solid #EFF2F5;}
  .item-card-head{display:flex;justify-content:space-between;align-items:baseline;gap:12px;}
  .item-name{font-size:15px;font-weight:700;color:#111;}
  .item-amount{font-size:16px;font-weight:800;color:${accent};}
  .item-card-meta{margin-top:4px;display:flex;justify-content:space-between;align-items:baseline;gap:12px;}
  .item-desc{font-size:12px;color:#6B7280;flex:1;}
  .item-qty{font-size:12px;color:#9CA3AF;font-weight:600;}
  .totals{margin-top:24px;margin-left:auto;width:300px;background:#fff;border:1px solid #E5E7EB;border-radius:14px;padding:18px;}
  .totals-row{display:flex;justify-content:space-between;padding:7px 0;font-size:14px;color:#374151;}
  .totals-divider{border:none;border-top:1px solid #E5E7EB;margin:8px 0;}
  .totals-grand{display:flex;justify-content:space-between;padding:10px 0;font-size:18px;font-weight:900;color:#111;}
  .balance-row{display:flex;justify-content:space-between;padding:12px 14px;border-radius:10px;background:#FEF2F2;font-size:15px;font-weight:800;color:#EF4444;margin-top:6px;}
  .balance-paid{background:#D1FAE5;color:#10B981;}
  .notes-section{margin-top:28px;padding-top:20px;border-top:1px solid #E5E7EB;}
  .notes-title{font-size:11px;font-weight:800;color:#9CA3AF;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;}
  .notes-text{font-size:13px;color:#374151;line-height:1.6;}
  .footer{margin-top:36px;text-align:center;font-size:11px;color:#9CA3AF;}
  ${SHARED_PAY_STYLES}
  .pay-hero .pay-title{display:flex;align-items:center;}
</style></head><body>
<div class="page">
  <div class="hero">
    ${logoUrl ? `<img src="${esc(logoUrl)}" class="hero-logo" alt="logo"/>` : ""}
    <div class="hero-biz">${esc(bizName)}</div>
    <div class="hero-label">Invoice</div>
    <div class="hero-number">${esc(invoice.invoiceNumber)}</div>
    <div class="hero-status">${statusLabel.toUpperCase()}</div>
    <div class="hero-amount">
      <div class="hero-amount-label">Amount Due</div>
      <div class="hero-amount-value">${fmt(balance, currency)}</div>
    </div>
  </div>
  <div class="body-pad">
    <div class="meta-row">${metaBlocks(invoice, customer, liveStatus)}</div>
    <div class="items-title">Items</div>
    ${itemCards}
    <div class="totals">${totals(invoice, currency, balance, liveStatus)}</div>
    ${paymentBlock(payment, qrDataUrl, shareUrl, { variant: "hero", accent })}
    ${notesFooter(invoice, footer, bizName)}
  </div>
</div>
</body></html>`;
}

// ──────────────────────────────────────────────────────────────────────────
// Helper to render a friendly 404 page
// ──────────────────────────────────────────────────────────────────────────

function buildInvoiceNotFoundHtml() {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Invoice not found · KashBook</title>
<style>
  body{font-family:-apple-system,Helvetica,Arial,sans-serif;background:#F4F6F9;color:#111;margin:0;padding:60px 24px;text-align:center;}
  .box{max-width:420px;margin:0 auto;background:#fff;border-radius:18px;padding:36px;border:1px solid #E8ECF0;}
  .emoji{font-size:48px;margin-bottom:14px;}
  h1{font-size:22px;font-weight:800;margin-bottom:10px;}
  p{font-size:14px;color:#6B7280;line-height:1.6;}
</style></head><body>
<div class="box">
  <div class="emoji">📄</div>
  <h1>Invoice not found</h1>
  <p>This invoice link may have been revoked or never existed. Ask the business that sent it to share a new link.</p>
</div>
</body></html>`;
}

module.exports = {
  buildInvoiceHtml,
  deriveInvoicePaymentBlock,
  buildQrDataUrl,
  buildInvoiceNotFoundHtml,
};
