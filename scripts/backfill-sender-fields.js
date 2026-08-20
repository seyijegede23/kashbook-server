// One-time backfill: populate Transaction.senderName/senderBank/senderAccount
// on existing bank credits, and try to de-anonymize poller-booked rows.
//
//   node scripts/backfill-sender-fields.js           # dry run (prints plan)
//   node scripts/backfill-sender-fields.js --apply   # writes
//
// Two passes:
//   1. Parse the server-written description grammar (buildInboundDescription
//      is a fixed template) into the new structured columns. No network.
//   2. For rows still "Anonymous sender" with an Anchor transaction id, ask
//      Anchor again — the payment relationship is often attached by now even
//      when it was missing at poll time — and rewrite description + columns.
require("dotenv").config();
const prisma = require("../src/utils/db");
const {
  resolveInboundSender,
  buildInboundDescription,
} = require("../src/utils/inboundCreditNotification");

const APPLY = process.argv.includes("--apply");

// The real grammar (buildInboundDescription):
//   "Transfer received from NAME (Bank) · Acct: 0123456789 · "note" · Ref: x"
//   "Transfer received from Name (KashBook) · "note" · Ref: x"
//   "Transfer received from GTB ****4321 · Ref: x"          (bank+acct label, no name)
//   "Transfer received from Anonymous sender · Ref: x"
// Bank parens are optional (only emitted when a name AND bank exist); the name
// group must not cross the " · " separators or quotes; masked labels
// ("****4321") and Anonymous are not names.
function parseDescription(desc) {
  const m = /^Transfer received from ([^·("]+?)(?: \(([^)]+)\))?(?: · Acct: (\d{6,}))?(?= · |$)/.exec(desc || "");
  if (!m) return null;
  const [, rawName, bank, acct] = m;
  const name = (rawName || "").trim();
  if (!name || /anonymous/i.test(name) || /\*{2,}/.test(name)) return null;
  return { name, bank: (bank || "").trim() || null, account: acct || null };
}

const BASE = () => process.env.ANCHOR_BASE_URL;
const KEY = () => process.env.ANCHOR_API_KEY;
async function fetchAnchorTxn(txnId) {
  const res = await fetch(`${BASE()}/transactions/${encodeURIComponent(txnId)}`, {
    headers: { "x-anchor-key": KEY(), Accept: "application/json" },
  });
  if (!res.ok) return null;
  const j = await res.json().catch(() => null);
  return j?.data || null;
}

(async () => {
  const credits = await prisma.transaction.findMany({
    where: {
      type: "income",
      source: { in: ["anchor", "fincra"] },
      senderName: null,
    },
    select: { id: true, description: true, reference: true, providerTxnId: true, amount: true },
  });
  console.log(`${credits.length} credits with no structured sender`);

  let parsed = 0, resolved = 0, stillAnon = 0;
  for (const c of credits) {
    // Pass 1 — parse the description grammar.
    const p = parseDescription(c.description);
    if (p) {
      parsed++;
      console.log(`parse  ₦${c.amount}  ${p.name} (${p.bank})${p.account ? " ····" + p.account.slice(-4) : ""}`);
      if (APPLY) {
        await prisma.transaction.update({
          where: { id: c.id },
          data: { senderName: p.name, senderBank: p.bank, senderAccount: p.account },
        });
      }
      continue;
    }

    // Pass 2 — re-ask Anchor for anonymous poller rows.
    const anchorTxnId =
      c.providerTxnId ||
      ((c.reference || "").startsWith("anc_txn_") ? c.reference.slice("anc_txn_".length) : null);
    if (!anchorTxnId || !BASE() || !KEY()) { stillAnon++; continue; }
    try {
      const t = await fetchAnchorTxn(anchorTxnId);
      const paymentId = t?.relationships?.payment?.data?.id || "";
      if (!t || !paymentId) { stillAnon++; continue; }
      const { sender, narration } = await resolveInboundSender(t.attributes || {}, paymentId);
      if (!sender?.hasName && !sender?.bank && !sender?.accountNumber) { stillAnon++; continue; }
      resolved++;
      const sessionRef =
        t.attributes?.reference || t.attributes?.sessionId || anchorTxnId;
      console.log(`anchor ₦${c.amount}  ${sender.label}`);
      if (APPLY) {
        await prisma.transaction.update({
          where: { id: c.id },
          data: {
            senderName: sender.name || null,
            senderBank: sender.bank || null,
            senderAccount: sender.accountNumber || null,
            description: buildInboundDescription({ sender, narration, reference: sessionRef }),
          },
        });
      }
      await new Promise((r) => setTimeout(r, 400)); // be polite to Anchor
    } catch (e) {
      console.warn(`  anchor lookup failed for ${anchorTxnId}: ${e.message}`);
      stillAnon++;
    }
  }
  console.log(`\n${APPLY ? "APPLIED" : "DRY RUN"}: parsed ${parsed}, anchor-resolved ${resolved}, still anonymous ${stillAnon}`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
