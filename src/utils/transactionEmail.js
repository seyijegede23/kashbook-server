// Detailed debit/credit transaction emails (money sent / money received).
//
// Uses a DEDICATED transactional mailbox so these don't share the OTP sender:
//   TXN_SMTP_HOST / TXN_SMTP_PORT / TXN_SMTP_USER / TXN_SMTP_PASS / TXN_EMAIL_FROM
// Falls back to the shared SMTP_* config if the TXN_* vars aren't set. If nothing
// is configured, this is a silent no-op. NEVER throws — a mail failure must not
// affect money movement (same discipline as audit()/pushNotification).
const nodemailer = require("nodemailer");
const { renderTxnEmail, txnRow } = require("./emailLayout");

const CURRENCY_SYMBOLS = {
  NGN: "₦", USD: "$", KES: "KSh ", GHS: "GH₵", ZAR: "R", EGP: "E£", GBP: "£", EUR: "€",
};
function money(amount, currency = "NGN") {
  const sym = CURRENCY_SYMBOLS[currency] || `${currency} `;
  return sym + Number(amount || 0).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
  return txnRow(label, value);
}

function buildHtml({ direction, amount, currency, counterparty, reference, narration, fee, balanceAfter, dateLabel, businessName }) {
  const credit = direction === "credit";
  // Light + dark-mode amount colours (the layout swaps to accentDark in dark mode).
  const accent = credit ? "#059669" : "#DC2626";
  const accentDark = credit ? "#4ADE80" : "#F87171";
  const sign = credit ? "+" : "−";
  // Textual heading carries credit/debit so it's never colour-only.
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

  return renderTxnEmail({
    heading,
    amountSigned: `${sign}${money(amount, currency)}`,
    accent,
    accentDark,
    rowsHtml: rows,
  });
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
