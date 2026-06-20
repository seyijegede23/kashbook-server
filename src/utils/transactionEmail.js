// Detailed debit/credit transaction emails (money sent / money received).
//
// Uses a DEDICATED transactional mailbox so these don't share the OTP sender:
//   TXN_SMTP_HOST / TXN_SMTP_PORT / TXN_SMTP_USER / TXN_SMTP_PASS / TXN_EMAIL_FROM
// Falls back to the shared SMTP_* config if the TXN_* vars aren't set. If nothing
// is configured, this is a silent no-op. NEVER throws — a mail failure must not
// affect money movement (same discipline as audit()/pushNotification).
const nodemailer = require("nodemailer");

const CURRENCY_SYMBOLS = {
  NGN: "₦", USD: "$", KES: "KSh ", GHS: "GH₵", ZAR: "R", EGP: "E£", GBP: "£", EUR: "€",
};
function money(amount, currency = "NGN") {
  const sym = CURRENCY_SYMBOLS[currency] || `${currency} `;
  return sym + Number(amount || 0).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

let cachedTransport;
function getTransport() {
  if (cachedTransport !== undefined) return cachedTransport;
  const host = process.env.TXN_SMTP_HOST || process.env.SMTP_HOST;
  const user = process.env.TXN_SMTP_USER || process.env.SMTP_USER;
  const pass = process.env.TXN_SMTP_PASS || process.env.SMTP_PASS;
  if (!host || !user || !pass) {
    cachedTransport = null;
    return null;
  }
  cachedTransport = nodemailer.createTransport({
    host,
    port: Number(process.env.TXN_SMTP_PORT || process.env.SMTP_PORT) || 587,
    secure: false,
    requireTLS: true,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    auth: { user, pass },
  });
  return cachedTransport;
}

function row(label, value) {
  return `<tr>
    <td style="padding:8px 0;color:#71717a;font-size:14px;">${esc(label)}</td>
    <td style="padding:8px 0;color:#18181b;font-size:14px;font-weight:600;text-align:right;">${esc(value)}</td>
  </tr>`;
}

function buildHtml({ direction, amount, currency, counterparty, reference, narration, fee, balanceAfter, dateLabel, businessName }) {
  const credit = direction === "credit";
  const accent = credit ? "#059669" : "#DC2626";
  const sign = credit ? "+" : "−";
  const heading = credit ? "Money received" : "Money sent";
  const partyLabel = credit ? "From" : "To";

  const rows = [
    row(partyLabel, counterparty || "—"),
    businessName ? row("Account", businessName) : "",
    narration ? row("Description", narration) : "",
    !credit && fee != null ? row("Fee", money(fee, currency)) : "",
    balanceAfter != null ? row("Balance", money(balanceAfter, currency)) : "",
    reference ? row("Reference", reference) : "",
    dateLabel ? row("Date", dateLabel) : "",
  ].join("");

  return `<!DOCTYPE html>
  <html><head><meta charset="utf-8"></head>
  <body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f4f4f5;margin:0;padding:20px 0;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;"><tr><td align="center" style="padding:20px;">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#fff;border-radius:12px;overflow:hidden;">
        <tr><td style="background:#6C3FC5;padding:28px 40px;text-align:center;">
          <h1 style="color:#fff;margin:0;font-size:24px;font-weight:700;">KashBook</h1>
        </td></tr>
        <tr><td style="padding:32px 40px 8px;text-align:center;">
          <p style="margin:0;color:#71717a;font-size:15px;">${esc(heading)}</p>
          <p style="margin:8px 0 0;color:${accent};font-size:34px;font-weight:800;">${sign}${esc(money(amount, currency))}</p>
        </td></tr>
        <tr><td style="padding:8px 40px 32px;">
          <table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e4e4e7;margin-top:12px;">${rows}</table>
        </td></tr>
        <tr><td style="background:#fafafa;padding:20px 40px;text-align:center;border-top:1px solid #e4e4e7;">
          <p style="margin:0;color:#a1a1aa;font-size:12px;">This is an automated transaction alert from KashBook. If you didn't authorise this, contact support immediately.</p>
        </td></tr>
      </table>
    </td></tr></table>
  </body></html>`;
}

// Send a debit ("sent") or credit ("received") alert. Resolves always; never rejects.
async function sendTransactionEmail(opts = {}) {
  try {
    if (!opts.to || !opts.amount) return;
    const transport = getTransport();
    if (!transport) return;
    const from = process.env.TXN_EMAIL_FROM || process.env.TXN_SMTP_USER || process.env.EMAIL_FROM;
    const credit = opts.direction === "credit";
    const subject = `${credit ? "Money received" : "Money sent"}: ${money(opts.amount, opts.currency)}`;
    await transport.sendMail({ from, to: opts.to, subject, html: buildHtml(opts) });
  } catch (err) {
    console.error("[transactionEmail] send failed:", err.message);
  }
}

module.exports = { sendTransactionEmail, _buildHtml: buildHtml };
