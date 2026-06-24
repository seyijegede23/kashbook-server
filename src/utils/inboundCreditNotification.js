// Shared helpers for inbound NUBAN credits — extract the best sender label
// out of Anchor's variable webhook / polling payload, and format a notification
// the user can act on at a glance.
//
// Used by:
//   - server/src/routes/anchor.js (webhook handler)
//   - server/src/utils/anchorReconcile.js (polling fallback)

const { formatAmountForBusiness } = require("../config/amlLimits");

// Anchor's payload shape varies by event type and partner bank. We try every
// field name that's been observed and fall back to a "Bank ****1234" label so
// the user always knows roughly who paid them, even if Anchor didn't send a
// usable name.
function extractSender(attrs = {}) {
  // Anchor nests the sender on inbound credits as a counterParty / source-account
  // object (capital P), while some partner payloads use flat fields. Check the
  // nested object first, then every flat variant we've seen.
  const cp =
    attrs.counterParty || attrs.counterparty || attrs.sourceAccount ||
    attrs.payer || attrs.originator || attrs.debitAccount || attrs.sender || {};

  const name =
    cleanName(attrs.senderName) ||
    cleanName(attrs.sourceAccountName) ||
    cleanName(attrs.fromAccountName) ||
    cleanName(attrs.payerName) ||
    cleanName(attrs.originatorName) ||
    cleanName(attrs.counterpartyName) ||
    cleanName(cp.accountName) ||
    cleanName(cp.name) ||
    cleanName(attrs.nameEnquiry?.accountName) ||
    "";

  const bankRaw =
    cp.bank?.name || cp.bankName || cp.bank ||
    attrs.sourceBank || attrs.senderBank || attrs.sourceBankName || attrs.fromBank ||
    "";
  const bank = typeof bankRaw === "string" ? bankRaw : (bankRaw?.name || "");

  const accountNumber =
    cp.accountNumber ||
    attrs.sourceAccountNumber ||
    attrs.senderAccountNumber ||
    attrs.fromAccountNumber ||
    "";

  // If we STILL couldn't find a name, log the raw sender-ish payload so we can map
  // whatever shape this partner/event used (then add it above). Only logs on miss.
  if (!name) {
    try {
      console.warn("[inbound] sender name not found — raw:", JSON.stringify({
        keys: Object.keys(attrs).slice(0, 40),
        counterParty: attrs.counterParty, counterparty: attrs.counterparty,
        sourceAccount: attrs.sourceAccount, payer: attrs.payer, debitAccount: attrs.debitAccount,
      }).slice(0, 1500));
    } catch { /* noop */ }
  }

  // Build a display label. Prefer the real name; otherwise "GTB ****4321";
  // last-resort plain "Anonymous sender".
  let label = name;
  if (!label && bank && accountNumber) {
    label = `${bank} ****${String(accountNumber).slice(-4)}`;
  } else if (!label && bank) {
    label = bank;
  } else if (!label && accountNumber) {
    label = `****${String(accountNumber).slice(-4)}`;
  } else if (!label) {
    label = "Anonymous sender";
  }

  return { name, bank, accountNumber, label, hasName: !!name };
}

function cleanName(s) {
  if (!s || typeof s !== "string") return "";
  const trimmed = s.trim();
  // Reject obvious junk.
  if (!trimmed) return "";
  if (/^(unknown|none|n\/a|null)$/i.test(trimmed)) return "";
  return trimmed;
}

// Build the title + body for the push notification.
// Title leads with the most important info (who + how much).
function buildInboundNotification({ business, amount, sender, narration }) {
  const amountFmt = formatAmountForBusiness(business, amount);
  const title = sender.hasName
    ? `${sender.label} sent ${amountFmt} 🎉`
    : `${amountFmt} received 🎉`;
  const lines = [];
  if (!sender.hasName && sender.label && sender.label !== "Anonymous sender") {
    lines.push(`From ${sender.label}`);
  }
  lines.push(`To ${business.name}`);
  if (narration) lines.push(`"${narration}"`);
  return { title, body: lines.join(" · ") };
}

// Build the Transaction.description string we persist for the ledger.
function buildInboundDescription({ sender, narration, reference }) {
  const parts = [`Transfer received from ${sender.label}`];
  if (sender.hasName && sender.bank) parts.push(`(${sender.bank})`);
  if (sender.accountNumber && !sender.label.includes("****")) {
    parts.push(`· Acct: ${sender.accountNumber}`);
  }
  if (narration) parts.push(`· "${narration}"`);
  if (reference) parts.push(`· Ref: ${reference}`);
  return parts.join(" ");
}

module.exports = {
  extractSender,
  buildInboundNotification,
  buildInboundDescription,
};
