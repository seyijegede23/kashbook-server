// Euro → naira conversion. The only way euros leave a merchant's balance.
//
// WHERE THE MONEY ACTUALLY IS
//   Fincra pools every merchant's EUR virtual account into ONE KashBook EUR
//   wallet. Our ledger says who is owed what. A conversion therefore has three
//   legs, and the ledger must describe each one truthfully:
//
//     1. convert   Fincra moves €X from our EUR wallet to our NGN wallet.
//                  → we book a EUR expense on the merchant (their balance drops).
//     2. pay out   Fincra sends ₦Y from our NGN wallet to the merchant's OWN
//                  Anchor NUBAN.
//                  → nothing booked here. The naira is not theirs until it lands.
//     3. land      Anchor's inbound-credit webhook books the ₦Y as bank income,
//                  source "anchor", exactly as any other transfer in.
//
//   So the naira appears in the app only when it is physically at Anchor, where
//   the merchant can spend it. Booking it earlier, with source "fincra", would
//   make computeLedgerBalance claim money Anchor does not hold, and the next
//   send-money would fail at the provider with a balance the app said was there.
//
// THE FAILURE THAT MATTERS
//   Leg 1 succeeded, leg 2 failed. The merchant's euros are gone from their
//   balance and the naira is sitting in our wallet with nothing to say whose it
//   is. That is why every attempt is an FcyConversion row with an explicit
//   status, and why retryStuckConversions() runs from the reconcile loop:
//   "converted" or "payout_failed" is a debt we owe until the payout goes
//   through. Both references are unique, so a retry can never pay twice.
//
// QUOTES EXPIRE IN 30 SECONDS
//   Nobody reliably enters a PIN inside that. confirm re-quotes when the quote
//   has expired, proceeds if the merchant would get at least what they saw
//   (within QUOTE_TOLERANCE), and otherwise hands the NEW figures back with
//   QUOTE_CHANGED so they confirm what will actually happen.
//
// NOT SUBJECT TO AML VELOCITY LIMITS
//   This is the merchant's own money moving to their own name-verified account,
//   not a transfer to a third party. The EUR expense row it writes is excluded
//   from the naira windows by the currency filter in amlChecks (see
//   moneySources.js). Frozen accounts are still refused.
const { randomUUID } = require("crypto");
const prisma = require("./db");
const fincra = require("../services/fincra");
const { computeLedgerBalance } = require("./ledgerBalance");
const balanceCache = require("./balanceCache");
const { audit } = require("./audit");
const { pushTo } = require("./pushNotification");
const { fireAlert } = require("./alerts");

const SOURCE = "fincra";
const DEST_CURRENCY = "NGN";
const MIN_SOURCE_AMOUNT = 1;          // €1. Fincra will refuse below its own floor anyway.
const QUOTE_TTL_MS = 30 * 1000;       // Fincra's documented validity.
const QUOTE_TOLERANCE = 0.01;         // re-quote may deliver up to 1% less without re-confirm
const MONEY_EPS = 0.005;
const STUCK_AFTER_MS = 10 * 60 * 1000;

// KashBook's cut on the naira side, in basis points. Default 0: the merchant
// gets Fincra's full amountToReceive. Capped so a typo in the env cannot take
// half of someone's money.
const marginBps = () => Math.max(0, Math.min(500, Math.floor(Number(process.env.FCY_CONVERSION_MARGIN_BPS || 0)) || 0));

class ConversionError extends Error {
  constructor(message, code, status = 400, extra = {}) {
    super(message);
    this.code = code;
    this.status = status;
    Object.assign(this, extra);
  }
}

const round2 = (n) => Math.round(Number(n) * 100) / 100;
const floor2 = (n) => Math.floor(Number(n) * 100 + 1e-9) / 100;

// Naira the merchant receives after the margin. Floored, never rounded up:
// rounding up would pay out a kobo we did not receive.
function applyMargin(gross, bps = marginBps()) {
  const g = Number(gross) || 0;
  return floor2(g * (1 - bps / 10000));
}

// Fincra wants a bank CODE for the payout; we hold the bank NAME Anchor gave us
// ("Providus Bank", "9 Payment Service Bank", …). Match generously on the
// normalised name and fail closed on ambiguity: paying the right account number
// at the wrong bank is a different person's money.
function normaliseBankName(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\b(bank|plc|limited|ltd|nigeria|the|of|mfb|microfinance)\b/g, " ")
    .replace(/[^a-z0-9]/g, "");
}

// Anchor and Fincra do not spell banks the same way. Anchor issues NUBANs at
// "9 Payment Service Bank"; Fincra's list may say "9PSB". Each entry is a set
// of normalised spellings that mean the same institution. Extend when a new
// mismatch is seen in the logs (resolvePayoutTarget logs the name it failed on).
const BANK_SYNONYMS = [
  ["9paymentservice", "9psb", "9payment", "ninepsb", "ninepaymentservice"],
  ["providus", "providusbank"],
];

function spellings(name) {
  const n = normaliseBankName(name);
  const out = new Set(n ? [n] : []);
  for (const group of BANK_SYNONYMS) if (group.includes(n)) group.forEach((g) => out.add(g));
  return out;
}

function matchBankCode(banks, bankName) {
  const want = spellings(bankName);
  if (!want.size) return null;
  const list = (Array.isArray(banks) ? banks : []).filter((b) => b && b.code && b.name);
  const exact = list.filter((b) => [...spellings(b.name)].some((s) => want.has(s)));
  if (exact.length === 1) return exact[0].code;
  if (exact.length > 1) return null;
  const partial = list.filter((b) => {
    const have = normaliseBankName(b.name);
    return [...want].some((w) => w.length >= 4 && (have.includes(w) || w.includes(have)));
  });
  return partial.length === 1 ? partial[0].code : null;
}

// "SEYI EMMANUEL JEGEDE" vs "Jegede Seyi": banes enquiry and Anchor order names
// differently, so require shared tokens rather than equality. Any single token
// of 3+ letters in common is enough; nothing in common is a different person.
function namesOverlap(a, b) {
  const tok = (s) => new Set(String(s || "").toLowerCase().split(/[^a-z]+/).filter((t) => t.length >= 3));
  const A = tok(a), B = tok(b);
  if (!A.size || !B.size) return true; // nothing to compare; do not block on missing data
  for (const t of A) if (B.has(t)) return true;
  return false;
}

// Same freeze gate as sending money (amlChecks.runPreTransferChecks). An
// account under review must not move money in any direction, and a conversion
// is money moving. Checked at quote AND at confirm, since a freeze can land in
// between.
async function assertNotFrozen(biz) {
  if (biz?.accountStatus && biz.accountStatus !== "active") {
    throw new ConversionError("This business is under review. Contact support to resolve.", "FROZEN", 423);
  }
  const owner = await prisma.user.findUnique({ where: { id: biz.userId }, select: { accountStatus: true } });
  if (owner?.accountStatus && owner.accountStatus !== "active") {
    throw new ConversionError("Your account is under review. Contact support to resolve.", "FROZEN", 423);
  }
}

// Where the naira goes: the merchant's own NUBAN, resolved and name-checked at
// Fincra. Done BEFORE quoting so a merchant whose payout target cannot be
// verified never sees a rate they cannot use.
async function resolvePayoutTarget(biz) {
  if (!biz.virtualAccountNumber) {
    throw new ConversionError("Set up your naira account first, then you can convert.", "NO_LOCAL_ACCOUNT", 409);
  }
  let bankCode = process.env.FCY_PAYOUT_BANK_CODE || null;
  if (!bankCode) {
    const banks = await fincra.getBanks(DEST_CURRENCY);
    bankCode = matchBankCode(banks?.data || banks, biz.virtualAccountBank);
  }
  if (!bankCode) {
    console.error(`[fcy-conversion] no Fincra bank code for "${biz.virtualAccountBank}" (business ${biz.id})`);
    throw new ConversionError("We couldn't verify your naira account's bank. Please contact support.", "PAYOUT_BANK_UNKNOWN", 503);
  }
  const ne = await fincra.resolveAccount({ accountNumber: biz.virtualAccountNumber, bankCode, currency: DEST_CURRENCY });
  const resolvedName = ne?.data?.accountName;
  if (!resolvedName) {
    throw new ConversionError("Your naira account couldn't be verified right now. Try again shortly.", "PAYOUT_ACCOUNT_UNRESOLVED", 503);
  }
  const expected = biz.virtualAccountName || biz.name;
  if (!namesOverlap(resolvedName, expected)) {
    console.error(`[fcy-conversion] payout name mismatch for business ${biz.id}: bank says "${resolvedName}", we hold "${expected}"`);
    throw new ConversionError("The name on your naira account doesn't match. Please contact support.", "PAYOUT_NAME_MISMATCH", 409);
  }
  return {
    accountNumber: biz.virtualAccountNumber,
    bankCode,
    bankName: biz.virtualAccountBank || null,
    accountName: resolvedName,
  };
}

async function fetchQuote(sourceCurrency, amount) {
  const res = await fincra.generateQuote({
    sourceCurrency,
    destinationCurrency: DEST_CURRENCY,
    amount: String(amount),
    action: "send",
    transactionType: "conversion",
    paymentDestination: "fliqpay_wallet",
    // Fee comes off the naira side, so the euro debit equals exactly what the
    // merchant asked to convert. Simpler to reason about than a fee on top.
    feeBearer: "customer",
  });
  const q = res?.data;
  if (!q || !q.reference) throw new ConversionError("Couldn't get a rate right now. Try again shortly.", "QUOTE_FAILED", 502);
  if (String(q.sourceCurrency).toUpperCase() !== sourceCurrency || String(q.destinationCurrency).toUpperCase() !== DEST_CURRENCY) {
    throw new ConversionError("Unexpected quote from our partner. Nothing was converted.", "QUOTE_MISMATCH", 502);
  }
  const sourceAmount = round2(q.sourceAmount ?? amount);
  const amountToCharge = round2(q.amountToCharge ?? sourceAmount);
  const gross = round2(q.amountToReceive ?? q.destinationAmount);
  if (!(gross > 0) || !(Number(q.rate) > 0)) throw new ConversionError("Couldn't get a rate right now. Try again shortly.", "QUOTE_FAILED", 502);
  const expiresAt = q.expireAt ? new Date(q.expireAt) : new Date(Date.now() + QUOTE_TTL_MS);
  return {
    quoteReference: String(q.reference),
    quoteExpiresAt: Number.isNaN(expiresAt.getTime()) ? new Date(Date.now() + QUOTE_TTL_MS) : expiresAt,
    sourceAmount,
    fee: Math.max(0, round2(amountToCharge - sourceAmount)),
    rate: Number(q.rate),
    grossDestinationAmount: gross,
    destinationAmount: applyMargin(gross),
    marginBps: marginBps(),
  };
}

function publicView(c) {
  return {
    id: c.id,
    status: c.status,
    sourceCurrency: c.sourceCurrency,
    sourceAmount: c.sourceAmount,
    fee: c.fee,
    destinationCurrency: c.destinationCurrency,
    destinationAmount: c.destinationAmount,
    rate: c.rate,
    expiresAt: c.quoteExpiresAt,
    payoutTo: {
      bankName: c.payoutBankName,
      accountName: c.payoutAccountName,
      accountNumber: c.payoutAccountNumber ? `••••${String(c.payoutAccountNumber).slice(-4)}` : null,
    },
    createdAt: c.createdAt,
    paidAt: c.paidAt,
  };
}

// Step 1. Validate, verify the payout target, get a rate, persist it.
async function quoteConversion({ biz, userId, currency, amount }) {
  const cur = String(currency || "").toUpperCase();
  const amt = round2(amount);
  if (!(amt >= MIN_SOURCE_AMOUNT)) {
    throw new ConversionError(`Minimum is ${cur} ${MIN_SOURCE_AMOUNT.toFixed(2)}.`, "BELOW_MINIMUM");
  }
  await assertNotFrozen(biz);
  const balance = await computeLedgerBalance(biz.id, cur);
  if (amt > balance + MONEY_EPS) {
    throw new ConversionError(`Not enough ${cur}. Available: ${cur} ${balance.toFixed(2)}.`, "INSUFFICIENT_FCY_BALANCE", 400, { available: balance });
  }
  const target = await resolvePayoutTarget(biz);
  const q = await fetchQuote(cur, amt);

  const id = randomUUID();
  const row = await prisma.fcyConversion.create({
    data: {
      id,
      businessId: biz.id,
      userId,
      sourceCurrency: cur,
      destinationCurrency: DEST_CURRENCY,
      ...q,
      status: "quoted",
      customerReference: `kb_cv_${id.replace(/-/g, "")}`,
      payoutCustomerReference: `kb_cvp_${id.replace(/-/g, "")}`,
      payoutAccountNumber: target.accountNumber,
      payoutBankCode: target.bankCode,
      payoutBankName: target.bankName,
      payoutAccountName: target.accountName,
    },
  });
  return publicView(row);
}

// Our EUR wallet must actually hold what the ledger says the merchant has.
// If it does not, something upstream is wrong (a missed chargeback, a booking
// error) and converting would spend someone else's euros. Refuse and alert.
// A transient API failure is NOT a shortfall; only a returned number is.
async function assertWalletCovers(currency, amount) {
  let wallets;
  try { wallets = await fincra.getWallets(); } catch (e) {
    console.warn(`[fcy-conversion] wallet check unavailable: ${e.message}`);
    return;
  }
  const list = wallets?.data || wallets || [];
  const w = (Array.isArray(list) ? list : []).find((x) => String(x?.currency || "").toUpperCase() === currency);
  if (!w) return;
  const avail = Number(w.availableBalance ?? w.balance);
  if (Number.isFinite(avail) && avail + MONEY_EPS < amount) {
    fireAlert("fcy-wallet-short", "Fincra EUR wallet short",
      `Ledger wants ${currency} ${amount.toFixed(2)} but the wallet holds ${avail.toFixed(2)}. Conversions refused until reconciled.`,
    ).catch(() => {});
    throw new ConversionError("Conversions are paused for a moment. Please try again later.", "WALLET_SHORT", 503);
  }
}

// Book the euro leg. Reference is unique per business, so a retry after a
// crash between Fincra and the DB collapses into the row that already exists.
async function bookSourceLeg(row) {
  const desc = `Converted ${row.sourceCurrency} ${row.sourceAmount.toFixed(2)} to naira · Ref: ${row.customerReference}`;
  try {
    await prisma.transaction.create({
      data: {
        businessId: row.businessId,
        userId: row.userId,
        type: "expense",
        amount: row.sourceAmount,
        fee: row.fee || 0,
        currency: row.sourceCurrency,
        description: desc,
        category: "transfer",
        paymentMethod: "bank",
        date: new Date(),
        source: SOURCE,
        reference: row.customerReference,
      },
    });
  } catch (e) {
    if (e.code === "P2002") return; // already booked
    // Money has moved at Fincra. Never surface this as a failed conversion.
    console.error(`[fcy-conversion] BOOKKEEPING FAILED after conversion (ref ${row.customerReference}): ${e.message}`);
    fireAlert("fcy-bookkeeping", "Euro conversion booked at Fincra but not in the ledger",
      `Conversion ${row.id} (${row.sourceCurrency} ${row.sourceAmount}) succeeded at Fincra; the EUR expense row failed to write: ${e.message}`,
    ).catch(() => {});
  }
}

async function sendPayout(row) {
  const nameParts = String(row.payoutAccountName || "").trim().split(/\s+/);
  const firstName = nameParts[0] || "KashBook";
  const lastName = nameParts.slice(1).join(" ") || firstName;
  const res = await fincra.createPayout({
    business: process.env.FINCRA_BUSINESS_ID,
    sourceCurrency: DEST_CURRENCY,
    destinationCurrency: DEST_CURRENCY,
    amount: String(row.destinationAmount),
    description: `KashBook: ${row.sourceCurrency} ${row.sourceAmount.toFixed(2)} converted to naira`,
    paymentDestination: "bank_account",
    customerReference: row.payoutCustomerReference,
    beneficiary: {
      firstName,
      lastName,
      accountHolderName: row.payoutAccountName,
      type: "individual",
      accountNumber: row.payoutAccountNumber,
      bankCode: row.payoutBankCode,
      country: "NG",
    },
  });
  const d = res?.data || {};
  const status = String(d.status || "").toLowerCase();
  return {
    reference: d.reference ? String(d.reference) : null,
    settled: ["successful", "success", "completed", "paid"].includes(status),
  };
}

// Step 2. The merchant has entered their PIN (verified by the route). Runs
// under the business lock so two taps cannot both pass the balance check.
async function executeConversion({ biz, userId, conversionId, req = null }) {
  return prisma.withBusinessLock(biz.id, async () => {
    const row = await prisma.fcyConversion.findFirst({ where: { id: conversionId, businessId: biz.id } });
    if (!row) throw new ConversionError("That quote wasn't found.", "NOT_FOUND", 404);
    if (row.status !== "quoted") throw new ConversionError("This conversion was already submitted.", "ALREADY_SUBMITTED", 409);

    await assertNotFrozen(biz);
    const balance = await computeLedgerBalance(biz.id, row.sourceCurrency);
    if (row.sourceAmount > balance + MONEY_EPS) {
      throw new ConversionError(`Not enough ${row.sourceCurrency}. Available: ${row.sourceCurrency} ${balance.toFixed(2)}.`, "INSUFFICIENT_FCY_BALANCE");
    }
    await assertWalletCovers(row.sourceCurrency, row.sourceAmount);

    // Re-quote if expired. Proceed silently only if the merchant gets at least
    // what they were shown (within tolerance); otherwise they must see it.
    let live = row;
    if (Date.now() > new Date(row.quoteExpiresAt).getTime() - 2000) {
      const fresh = await fetchQuote(row.sourceCurrency, row.sourceAmount);
      const worse = fresh.destinationAmount < row.destinationAmount * (1 - QUOTE_TOLERANCE);
      live = await prisma.fcyConversion.update({ where: { id: row.id }, data: { ...fresh, status: "quoted" } });
      if (worse) {
        throw new ConversionError("The rate changed. Check the new amount and confirm again.", "QUOTE_CHANGED", 409, { quote: publicView(live) });
      }
    }

    // ATOMIC CLAIM. Exactly one caller moves the row out of "quoted".
    const claimed = await prisma.fcyConversion.updateMany({
      where: { id: row.id, status: "quoted" },
      data: { status: "converting" },
    });
    if (claimed.count !== 1) throw new ConversionError("This conversion was already submitted.", "ALREADY_SUBMITTED", 409);

    // Leg 1: convert.
    let conv;
    try {
      conv = await fincra.initiateConversion({ quoteReference: live.quoteReference, customerReference: live.customerReference });
    } catch (e) {
      await prisma.fcyConversion.update({ where: { id: row.id }, data: { status: "failed", error: String(e.message || e).slice(0, 500) } });
      await audit({ req, action: "FCY_CONVERSION_FAILED", resourceType: "business", resourceId: biz.id, severity: "warn",
        metadata: { conversionId: row.id, amount: live.sourceAmount, currency: live.sourceCurrency, error: e.message } });
      throw new ConversionError("Our partner couldn't complete the conversion. Nothing was taken from your balance.", "CONVERSION_FAILED", 502);
    }
    const converted = await prisma.fcyConversion.update({
      where: { id: row.id },
      data: { status: "converted", convertedAt: new Date(), conversionReference: conv?.data?.reference ? String(conv.data.reference) : null },
    });
    await bookSourceLeg(converted);
    try { balanceCache.bustBalance(biz.id); } catch { /* noop */ }

    // Leg 2: pay the naira to the merchant's NUBAN.
    const outcome = await completePayout(converted, { req });
    await audit({ req, action: "FCY_CONVERTED", resourceType: "business", resourceId: biz.id, severity: "info",
      metadata: { conversionId: row.id, source: `${live.sourceCurrency} ${live.sourceAmount}`, destination: `${DEST_CURRENCY} ${live.destinationAmount}`, rate: live.rate, payout: outcome.status } });

    const title = `${live.sourceCurrency} ${live.sourceAmount.toFixed(2)} converted`;
    const body = outcome.status === "payout_failed"
      ? `₦${live.destinationAmount.toLocaleString()} will reach your naira account shortly.`
      : `₦${live.destinationAmount.toLocaleString()} is on its way to your naira account.`;
    pushTo(biz.userId, title, body).catch(() => {});

    return { conversion: publicView(outcome.row), payout: outcome.status };
  });
}

// Payout with the row already "converted". Shared by the live path and the
// reconcile retry. Never throws: a payout failure is a state, not an error,
// because the euros are already gone and the caller must still report success.
async function completePayout(row, { req = null } = {}) {
  await prisma.fcyConversion.update({ where: { id: row.id }, data: { status: "paying_out" } });
  try {
    const p = await sendPayout(row);
    const updated = await prisma.fcyConversion.update({
      where: { id: row.id },
      data: p.settled
        ? { status: "paid", paidAt: new Date(), payoutReference: p.reference, error: null }
        : { status: "paying_out", payoutReference: p.reference, error: null },
    });
    return { status: updated.status, row: updated };
  } catch (e) {
    console.error(`[fcy-conversion] PAYOUT FAILED after conversion (ref ${row.payoutCustomerReference}): ${e.message}`);
    const updated = await prisma.fcyConversion.update({
      where: { id: row.id },
      data: { status: "payout_failed", error: String(e.message || e).slice(0, 500) },
    });
    fireAlert("fcy-payout-failed", "Euro conversion: naira payout failed",
      `Conversion ${row.id}: ${row.sourceCurrency} ${row.sourceAmount} converted, ₦${row.destinationAmount} payout to ${row.payoutAccountNumber} failed: ${e.message}. Reconcile will retry.`,
    ).catch(() => {});
    await audit({ req, action: "FCY_PAYOUT_FAILED", resourceType: "business", resourceId: row.businessId, severity: "alert",
      metadata: { conversionId: row.id, amount: row.destinationAmount, error: e.message } });
    return { status: "payout_failed", row: updated };
  }
}

// Has Fincra already got a payout for this reference? Checked before any retry
// so a payout whose RESPONSE we lost (timeout) is never sent twice.
async function findExistingPayout(customerReference, { maxPages = 3 } = {}) {
  let cursor;
  for (let page = 0; page < maxPages; page++) {
    let res;
    try { res = await fincra.listPayouts({ perPage: 100, cursor }); } catch { return null; }
    const items = res?.data?.results || (Array.isArray(res?.data) ? res.data : []);
    const hit = items.find((p) => String(p.customerReference || "") === customerReference);
    if (hit) return hit;
    cursor = res?.data?.nextCursor;
    if (!cursor || !items.length) break;
  }
  return null;
}

// Reconcile-loop entry. Drives rows out of the states where we owe naira.
//   converted / payout_failed → retry the payout (after checking Fincra for it)
//   paying_out               → confirm settlement from Fincra's record
//   converting (stale)       → we do not know if leg 1 happened; flag, never retry
async function retryStuckConversions({ logger = console } = {}) {
  const out = { retried: 0, completed: 0, flagged: 0 };
  if (!fincra.isConfigured()) return out;
  const stale = new Date(Date.now() - STUCK_AFTER_MS);

  const owed = await prisma.fcyConversion.findMany({
    where: { status: { in: ["converted", "payout_failed", "paying_out"] }, updatedAt: { lte: stale } },
    orderBy: { updatedAt: "asc" },
    take: 25,
  });
  for (const row of owed) {
    const existing = await findExistingPayout(row.payoutCustomerReference);
    if (existing) {
      const st = String(existing.status || "").toLowerCase();
      if (["successful", "success", "completed", "paid"].includes(st)) {
        await prisma.fcyConversion.update({ where: { id: row.id }, data: { status: "paid", paidAt: new Date(), payoutReference: String(existing.reference || row.payoutReference || ""), error: null } });
        out.completed++;
      } else if (["failed", "reversed", "declined", "cancelled", "returned"].includes(st)) {
        // Fincra failed it; safe to send again under the same reference only if
        // they dedup on it. They do, and the retry path below goes through
        // completePayout which records the outcome either way.
        const r = await completePayout(row);
        out.retried++;
        if (r.status === "paid") out.completed++;
      }
      // still processing at Fincra: leave it
      continue;
    }
    if (row.status === "paying_out") continue; // sent, not yet visible in the list; wait
    const r = await completePayout(row);
    out.retried++;
    if (r.status === "paid") out.completed++;
  }

  const unknown = await prisma.fcyConversion.updateMany({
    where: { status: "converting", updatedAt: { lte: stale } },
    data: { status: "needs_review", error: "Stuck in 'converting': conversion outcome unknown. Check Fincra before retrying." },
  });
  if (unknown.count) {
    out.flagged += unknown.count;
    fireAlert("fcy-needs-review", "Euro conversion needs review",
      `${unknown.count} conversion(s) stuck between quote and payout. Their outcome at Fincra is unknown; do NOT retry blindly.`,
    ).catch(() => {});
    logger.error?.(`[fcy-conversion] ${unknown.count} conversion(s) flagged needs_review`);
  }
  return out;
}

// Payout webhook for one of OUR conversion payouts (customerReference kb_cvp_…).
async function recordConversionPayoutOutcome(d, outcome) {
  const ref = String(d?.customerReference || "");
  if (!ref.startsWith("kb_cvp_")) return { handled: false };
  const row = await prisma.fcyConversion.findFirst({ where: { payoutCustomerReference: ref } });
  if (!row) return { handled: false };
  if (outcome === "success") {
    if (row.status !== "paid") {
      await prisma.fcyConversion.update({ where: { id: row.id }, data: { status: "paid", paidAt: new Date(), payoutReference: d.reference ? String(d.reference) : row.payoutReference, error: null } });
    }
  } else if (row.status !== "paid") {
    await prisma.fcyConversion.update({ where: { id: row.id }, data: { status: "payout_failed", error: String(d?.reason || d?.message || "payout failed").slice(0, 500) } });
    fireAlert("fcy-payout-failed", "Euro conversion: naira payout failed (webhook)",
      `Conversion ${row.id}: ₦${row.destinationAmount} to ${row.payoutAccountNumber} failed. Reconcile will retry.`,
    ).catch(() => {});
  }
  return { handled: true, id: row.id };
}

const isConversionPayoutRef = (ref) => String(ref || "").startsWith("kb_cvp_");

module.exports = {
  quoteConversion,
  executeConversion,
  retryStuckConversions,
  recordConversionPayoutOutcome,
  isConversionPayoutRef,
  publicView,
  ConversionError,
  // exported for tests
  applyMargin,
  matchBankCode,
  normaliseBankName,
  namesOverlap,
  QUOTE_TOLERANCE,
  MIN_SOURCE_AMOUNT,
};
