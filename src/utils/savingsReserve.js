// The savings reserve: how much of a business's bank balance is set aside in
// ledger pots and therefore NOT spendable.
//
// A `ledger` pot moves no money. It is a promise the server keeps: the naira
// stays in the merchant's Anchor account and every path that spends from that
// account subtracts the reserve first. That is enforceable only because the
// account has no card and no other exit: every debit goes through
// executeTransfer, and executeTransfer's balance gate calls netSpendable.
//
// PiggyVest pots hold their money in a PiggyVest wallet, so they never appear
// here. Closed pots hold nothing. Pots in `error` or `provisioning` are
// PiggyVest pots by construction (ledger pots are born active) and their
// balance is zero, but the query keeps them out explicitly anyway.
//
// This module must never import executeTransfer: it is imported BY it.
const prisma = require("./db");
const { MONEY_EPS } = require("../config/fees");

async function getReservedBalance(businessId, client = prisma) {
  const agg = await client.savingsPot.aggregate({
    where: { businessId, backing: "ledger", status: "active" },
    _sum: { balance: true },
  });
  return Math.max(0, Number(agg._sum.balance || 0));
}

// Spendable = gross − reserved, floored at zero. Gross is what the bank says
// is available; a reserve larger than gross means money left the account by a
// path the server did not gate (or the bank is temporarily behind), which the
// reconcile loop alarms on. The floor keeps the spend gate refusing, not
// throwing, in that state.
function netSpendable(gross, reserved) {
  const g = Number(gross) || 0;
  const r = Math.max(0, Number(reserved) || 0);
  const net = g - r;
  return net < MONEY_EPS ? 0 : Math.round(net * 100) / 100;
}

// The full picture for one business, from the same provider read the balance
// routes already do. `source` says where gross came from so a caller can tell
// a live figure from a ledger fallback.
//   { gross, reserved, spendable, source: "anchor" | "ledger" | "none" }
async function getSpendableBalance(biz) {
  const bankingId = biz?.providerAccountId || biz?.anchorAccountId;
  if (!bankingId) return { gross: 0, reserved: 0, spendable: 0, source: "none" };
  const reserved = await getReservedBalance(biz.id);
  const { getProvider } = require("../providers");
  const provider = getProvider(biz);
  let gross;
  let source;
  if (provider.pooledWallet) {
    const { computeLedgerBalance } = require("./ledgerBalance");
    gross = await computeLedgerBalance(biz.id, biz.baseCurrency || "NGN");
    source = "ledger";
  } else {
    const anchor = require("./anchor");
    const r = await anchor.getAccountBalance(biz.anchorAccountId);
    gross = Number(r?.balance ?? 0);
    source = "anchor";
  }
  return { gross, reserved, spendable: netSpendable(gross, reserved), source };
}

module.exports = { getReservedBalance, netSpendable, getSpendableBalance };
