// Ledger integrity self-check — the safety net that catches a mistake even if one
// slips past every guard. Two invariants, computed read-only from the observability
// cron (via takeHealthSnapshot) and surfaced by the alert engine:
//
//   1. COVERAGE: each POOLED provider's wallet must always be >= the sum of every
//      business's spendable balance on that provider, per currency. The wallet holds
//      Σ ledgers PLUS accumulated KashBook margin (₦20/transfer) PLUS float, so a
//      SHORTFALL (spendable > wallet) means the pool can't honour all balances — the
//      dangerous, undercollateralized direction. Surplus is tracked, not alerted.
//   2. NEGATIVE: no business's RAW (unfloored) ledger may be below zero. The display +
//      spend gate floor at 0, which CONTAINS a corrupted business but also HIDES it —
//      the raw sum surfaces it.
//
// Reuses computeRawLedger per business (the SAME authoritative math the balance and
// the spend gate use, so the check can never drift from reality, and each query is
// indexed by businessId — no full-table scan). Groups coverage by the business's
// actual POOLED provider (Anchor is per-account money, not a pool, so it's excluded
// from coverage). Never throws — an integrity check must not take down the health cron.
const prisma = require("./db");
const { computeRawLedger } = require("./ledgerBalance");
const { MONEY_EPS } = require("../config/fees");
const { getProvider } = require("../providers");

const MAX_NEGATIVES = 50; // cap what we alert/persist; carry the full count separately

async function collectLedgerIntegrity() {
  try {
    // Only businesses that actually hold a bank account can have a ledger balance.
    // Bounded by business count (small), not transaction volume.
    const businesses = await prisma.business.findMany({
      where: { OR: [{ providerAccountId: { not: null } }, { anchorAccountId: { not: null } }] },
      select: { id: true, providerAccountId: true, anchorAccountId: true, baseCurrency: true, country: true },
    });

    const pools = {};        // providerKey -> { provider, byCurrency: { cur: Σ floored } }
    const negatives = [];
    let negativeCount = 0;

    for (const biz of businesses) {
      const currency = biz.baseCurrency || "NGN";
      const raw = await computeRawLedger(biz.id, currency); // indexed by businessId
      if (raw < -MONEY_EPS) {
        negativeCount++;
        if (negatives.length < MAX_NEGATIVES) negatives.push({ businessId: biz.id, currency, raw: Number(raw.toFixed(2)) });
      }
      const provider = getProvider(biz);
      if (!provider.pooledWallet) continue; // Anchor = per-account deposit, not pooled
      const p = (pools[provider.key] = pools[provider.key] || { provider, byCurrency: {} });
      p.byCurrency[currency] = (p.byCurrency[currency] || 0) + Math.max(0, raw);
    }

    // Compare each pooled (provider, currency) spendable total to THAT provider's
    // wallet. The provider is derived from a real business that holds an account in
    // that currency, so the wallet response includes it (no 0-vs-absent ambiguity).
    const perProvider = [];
    for (const [providerKey, { provider, byCurrency }] of Object.entries(pools)) {
      for (const [currency, total] of Object.entries(byCurrency)) {
        const spendable = Number(total.toFixed(2));
        let poolAvailable = null;
        try { poolAvailable = Number(await provider.getAccountBalance(null, currency)); }
        catch { poolAvailable = null; } // provider unreachable → skip (no false alarm)
        const surplus = poolAvailable == null ? null : Number((poolAvailable - spendable).toFixed(2));
        const shortfall = poolAvailable == null ? 0 : Math.max(0, Number((spendable - poolAvailable).toFixed(2)));
        perProvider.push({ provider: providerKey, currency, spendable, poolAvailable, surplus, shortfall });
      }
    }

    return { perProvider, negatives, negativeCount };
  } catch (e) {
    console.error("[ledger-integrity]", e.message);
    return { perProvider: [], negatives: [], negativeCount: 0, error: e.message };
  }
}

module.exports = { collectLedgerIntegrity };
