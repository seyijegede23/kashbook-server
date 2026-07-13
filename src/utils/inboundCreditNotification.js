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
function extractSender(attrs = {}, { quiet = false } = {}) {
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
  // `quiet` suppresses this when the caller has a fallback (e.g. it will next fetch
  // the linked Payment, which is where the sender actually lives for NIP inbound).
  if (!name && !quiet) {
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

// ── Payment lookup ─────────────────────────────────────────────────────────
// For a NIP inbound credit, Anchor's *transaction* payload carries NO sender —
// the counterParty (name / bank / account) lives on the linked *Payment*
// resource (transaction.relationships.payment.data.id). Fetch it on demand.
const ANCHOR_BASE = () => process.env.ANCHOR_BASE_URL;
const ANCHOR_KEY = () => process.env.ANCHOR_API_KEY;

async function fetchPaymentAttributes(paymentId) {
  if (!paymentId || !ANCHOR_BASE() || !ANCHOR_KEY()) return null;
  try {
    const res = await fetch(
      `${ANCHOR_BASE()}/payments/${encodeURIComponent(paymentId)}`,
      { headers: { "x-anchor-key": ANCHOR_KEY(), Accept: "application/json" } },
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data?.data?.attributes || null;
  } catch {
    return null;
  }
}

// Book transfers (KashBook→KashBook, type BOOK_TRANSFER) carry the sender as the
// SOURCE DepositAccount on the transfer's `account` relationship. Return the
// source account id + reason so the caller can map it to a local business.
async function fetchTransferInfo(transferId) {
  if (!transferId || !ANCHOR_BASE() || !ANCHOR_KEY()) return null;
  try {
    const res = await fetch(
      `${ANCHOR_BASE()}/transfers/${encodeURIComponent(transferId)}`,
      { headers: { "x-anchor-key": ANCHOR_KEY(), Accept: "application/json" } },
    );
    if (!res.ok) return null;
    const data = await res.json();
    const d = data?.data || {};
    return {
      sourceAccountId: d.relationships?.account?.data?.id || "",
      reason: d.attributes?.reason || "",
      reference: d.attributes?.reference || "",
    };
  } catch {
    return null;
  }
}

// Resolve the best sender + narration for an inbound credit. Tries the primary
// payload first; if it has no usable name and we know the Payment id, fetch the
// Payment (where the counterParty actually is) and use that instead.
async function resolveInboundSender(attrs = {}, paymentId = "") {
  const canFallBack = !!paymentId;
  let sender = extractSender(attrs, { quiet: canFallBack });
  let narration = attrs.narration || attrs.reason || "";
  if (!sender.hasName && paymentId) {
    const payAttrs = await fetchPaymentAttributes(paymentId);
    if (payAttrs) {
      // The Payment is strictly richer than the transaction-list attrs.
      sender = extractSender(payAttrs);
      if (!narration) narration = payAttrs.narration || payAttrs.reason || "";
    }
  }
  return { sender, narration };
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
  resolveInboundSender,
  fetchPaymentAttributes,
  fetchTransferInfo,
  buildInboundNotification,
  buildInboundDescription,
};
