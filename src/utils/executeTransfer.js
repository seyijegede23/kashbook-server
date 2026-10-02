// Shared outbound-transfer executor. Called by:
//   - the HTTP route /transfers/send (interactive)
//   - the recurring-expense cron (unattended)
//
// Caller is responsible for:
//   1. Verifying PIN (interactive) or pre-authorisation (recurring).
//   2. Calling runPreTransferChecks() for AML / frozen / limit gating.
//   3. Ensuring business + provider.supportsBanking are already confirmed.
//
// This function only does the Anchor-side work + bookkeeping:
//   - Live balance check.
//   - Internal book-transfer vs NIP route detection.
//   - Anchor call.
//   - Transaction row, ComplianceFlag rows, audit log, push notification.
//
// Throws on Anchor / balance errors; returns { reference, route, transactionId }
// on success.

const prisma = require("./db");
const anchor = require("./anchor");
const { pushTo } = require("./pushNotification");
const { audit } = require("./audit");
const { recordComplianceFlags } = require("./amlChecks");
const { formatAmountForBusiness } = require("../config/amlLimits");
const { computeTransferFee, MONEY_EPS } = require("../config/fees");
const { getProvider } = require("../providers");
const { getCountryConfig } = require("../config/countries");
const { computeLedgerBalance } = require("./ledgerBalance");
const balanceCache = require("./balanceCache");
const { getReservedBalance, netSpendable } = require("./savingsReserve");

async function executeTransfer({
  business,
  userId,
  amount,
  accountNumber,
  bankCode,
  accountName,   // optional — name enquiry fills if missing
  bankName,      // optional — Anchor's bank list resolves if missing
  narration,
  reference,     // optional — caller passes a deterministic string for idempotency
  amlCheck = {}, // result of runPreTransferChecks; default empty = no flags
  req = null,    // for audit IP/user-agent; null in cron
  notify = true, // toggle the push notification
  // WHO pressed send, when that isn't the account owner. `userId` above stays
  // the owner so the ledger and compliance rows are owner-scoped; these two
  // record the actual human. They are load-bearing, not decorative: the
  // per-staff daily cap in transfers.js sums Transaction.recordedBy to work out
  // what a staff member has already moved. Drop the stamp and the cap silently
  // resets to zero-spent on every send.
  recordedBy = null,
  recordedByName = null,
} = {}) {
  const bankingId = business?.providerAccountId || business?.anchorAccountId;
  if (!business || !bankingId) {
    const err = new Error("Business has no banking account configured.");
    err.code = "NO_BANKING";
    throw err;
  }


  const ref =
    reference || `kashbook_tf_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  // 1. Idempotency check — if this exact reference is already on a Transaction,
  // skip the Anchor call entirely. Belt-and-braces for cron restarts.
  //
  // SECURITY: match the indexed `reference` column EXACTLY. The old
  // `description: { contains: ref }` was a substring match on client-supplied
  // input, so a shorter idempotency key ("ABC" after a real send with "ABCDEF")
  // collided with the earlier transfer and returned `success` + a debit email
  // for money that never moved.
  const existing = await prisma.transaction.findFirst({
    where: {
      businessId: business.id,
      source: "anchor",
      reference: ref,
    },
    select: { id: true },
  });
  if (existing) {
    return {
      reference: ref,
      route: "idempotent_skip",
      transactionId: existing.id,
      transaction: null,
    };
  }

  // 2. Route detection — internal book transfer vs external NIP. Done before
  // the balance check because the fee depends on the route (internal = free).
  const internalDest = await prisma.business.findFirst({
    where: {
      virtualAccountNumber: accountNumber,
      anchorAccountId: { not: null },
      NOT: { id: business.id },
    },
    select: {
      id: true, name: true, anchorAccountId: true, virtualAccountName: true,
    },
  });

  const { total: fee, statutoryStamp = 0, breakdown: feeBreakdown } = computeTransferFee(
    Number(amount),
    internalDest ? "book" : "nip",
  );
  // Everything that leaves the account beyond the amount: our fee (swept to the
  // revenue account) + the government stamp duty Anchor debits on >₦10k (theirs,
  // not ours — but it's real money off this account, so gate and book it).
  const totalCost = fee + statutoryStamp;

  // 3. Live balance check — must cover the transfer, our fee, AND the stamp duty,
  // out of what is SPENDABLE: the bank's available figure minus whatever the
  // merchant has set aside in ledger savings pots. Those pots move no money, so
  // this subtraction is the only thing that makes them real. Every caller holds
  // withBusinessLock(business.id) here, and ledger-pot deposits take the same
  // lock, so the reserve cannot change between this read and the Anchor call.
  const [{ balance: grossBalance }, reserved] = await Promise.all([
    anchor.getAccountBalance(business.anchorAccountId),
    getReservedBalance(business.id),
  ]);
  const balance = netSpendable(grossBalance, reserved);
  if (balance + MONEY_EPS < Number(amount) + totalCost) {
    const savedNote = reserved > 0 ? ` (${formatAmountForBusiness(business, reserved)} is set aside in savings)` : "";
    const err = new Error(
      totalCost > 0
        ? `Insufficient balance. This transfer needs ${formatAmountForBusiness(business, Number(amount) + totalCost)} (includes ${formatAmountForBusiness(business, fee)} fee${statutoryStamp ? ` + ${formatAmountForBusiness(business, statutoryStamp)} government stamp duty` : ""}). Available: ${formatAmountForBusiness(business, balance)}${savedNote}`
        : `Insufficient balance. Available: ${formatAmountForBusiness(business, balance)}${savedNote}`,
    );
    err.code = "INSUFFICIENT_BALANCE";
    err.availableBalance = balance;
    err.grossBalance = grossBalance;
    err.reserved = reserved;
    err.moneyMoved = false;
    throw err;
  }

  let resolvedName = accountName;
  let resolvedBank = bankName;
  let route;
  // Anchor's own id for the movement, stored as providerTxnId so the row can
  // always be traced back to the provider event without parsing the description.
  let providerTransferId = null;

  if (internalDest) {
    resolvedName = resolvedName || internalDest.virtualAccountName || internalDest.name;
    resolvedBank = "KashBook (internal)";
    route = "book";
    const book = await anchor.createBookTransfer({
      fromAccountId: business.anchorAccountId,
      toAccountId: internalDest.anchorAccountId,
      amount: Number(amount),
      reason: narration || `Transfer from ${business.name}`,
      reference: ref,
    });
    providerTransferId = book?.transferId || book?.id || null;
  } else {
    // Everything up to the transfer itself moves no money. Errors thrown here
    // are stamped moneyMoved:false so a caller that books a movement row before
    // calling (the savings service) can fail that row outright instead of
    // parking it as "unknown" for the reconcile loop to resolve.
    let cp;
    try {
      if (!resolvedName) {
        const ne = await anchor.verifyCounterparty({ accountNumber, bankCode });
        if (!ne.accountName) {
          const err = new Error("Could not resolve recipient account");
          err.code = "RECIPIENT_UNVERIFIED";
          throw err;
        }
        resolvedName = ne.accountName;
      }
      const banks = await anchor.getBanks();
      const matchedBank = banks.find((b) => b.code === bankCode);
      if (!matchedBank?.id) {
        const err = new Error("Unknown bank — refresh the bank list");
        err.code = "UNKNOWN_BANK";
        throw err;
      }
      cp = await anchor.createCounterparty({
        accountNumber,
        bankId: matchedBank.id,
        accountName: resolvedName,
      });
    } catch (preErr) {
      if (preErr && typeof preErr === "object") preErr.moneyMoved = false;
      throw preErr;
    }
    route = "nip";
    let nip;
    try {
      nip = await anchor.createTransfer({
        fromAccountId: business.anchorAccountId,
        counterpartyId: cp.counterpartyId,
        amount: Number(amount),
        reason: narration || `Transfer from ${business.name}`,
        reference: ref,
      });
    } catch (txErr) {
      // A definite rejection (validation, auth, not found) means Anchor did
      // not act. A timeout, a 5xx, a 409 on the idempotency key or a
      // code-less network error may have: leave moneyMoved undefined.
      const s = Number(txErr?.httpStatus || txErr?.status || 0);
      if ([400, 401, 403, 404, 422].includes(s) && txErr && typeof txErr === "object") txErr.moneyMoved = false;
      throw txErr;
    }
    providerTransferId = nip?.transferId || nip?.id || null;

    // Collect the fee into KashBook's revenue account (free book transfer).
    // The user's transfer already succeeded — a failed collection must NOT
    // fail it. Log + audit warn instead; reconciled manually.
    if (fee > 0) {
      try {
        await anchor.createBookTransfer({
          fromAccountId: business.anchorAccountId,
          toAccountId: process.env.ANCHOR_FEE_ACCOUNT_ID,
          amount: fee,
          reason: "Transfer fee",
          reference: `${ref}_fee`,
        });
      } catch (feeErr) {
        console.error(`[executeTransfer] fee collection failed for ${ref}:`, feeErr.message);
        await audit({
          req,
          action: "TRANSFER_FEE_COLLECTION_FAILED",
          resourceType: "business",
          resourceId: business.id,
          severity: "warn",
          metadata: { reference: ref, fee, error: feeErr.message },
        });
      }
    }
  }

  // 4. Bookkeeping row.
  const recipientLabel = resolvedBank
    ? `${resolvedName} · ${resolvedBank} · ${accountNumber}`
    : `${resolvedName} · ${accountNumber}`;
  const description = narration
    ? `${narration} — to ${recipientLabel} · Ref: ${ref}`
    : `Transfer to ${recipientLabel} · Ref: ${ref}`;

  // From here on the money has ALREADY MOVED at Anchor. A bookkeeping
  // failure (DB outage, schema drift, …) must not bubble up as a transfer
  // failure — the client would tell the user it failed and invite a retry,
  // double-sending. Log at alert severity and return success instead; the
  // missing row is reconciled manually from Anchor's ledger.
  let txn;
  try {
    txn = await prisma.transaction.create({
      data: {
        businessId: business.id,
        userId,
        type: "expense",
        amount: Number(amount),
        description,
        category: "transfer",
        paymentMethod: "bank",
        date: new Date(),
        source: "anchor",
        reference: ref, // idempotency key (unique per [businessId, reference])
        providerTxnId: providerTransferId || undefined,
        currency: business.baseCurrency || "NGN",
        recordedBy, recordedByName,
        flagSeverity: amlCheck.maxSeverity || null,
        complianceStatus: amlCheck.maxSeverity ? "flagged" : "clean",
        // Booked fee = our fee + the bank-debited stamp duty, so the ledger
        // matches the account's true movement (only OUR fee gets swept below).
        fee: totalCost,
        feeBreakdown: feeBreakdown || undefined,
      },
    });
  } catch (bookErr) {
    console.error(
      `[executeTransfer] BOOKKEEPING FAILED after money moved (ref ${ref}, ₦${amount}):`,
      bookErr.message,
    );
    await audit({
      req,
      action: "TRANSFER_BOOKKEEPING_FAILED",
      resourceType: "business",
      resourceId: business.id,
      severity: "alert",
      metadata: { reference: ref, amount: Number(amount), fee, route, accountNumber, error: bookErr.message },
    }).catch(() => {});
    if (notify) {
      await pushTo(
        userId,
        "Transfer Sent ✅",
        `${formatAmountForBusiness(business, amount)} → ${resolvedName} (Ref: ${ref.slice(-8)})`,
      ).catch(() => {});
    }
    return { reference: ref, route, transactionId: null, transaction: null, fee, totalCost, providerTransferId, bookkeepingFailed: true };
  }

  // 5. ComplianceFlag rows (CTR auto-flag + any rule hits).
  await recordComplianceFlags({
    userId,
    businessId: business.id,
    business,
    transactionId: txn.id,
    amount: Number(amount),
    flags: amlCheck.flags || [],
  });

  // 6. Audit log.
  await audit({
    req,
    action: "TRANSFER_SENT",
    resourceType: "transaction",
    resourceId: txn.id,
    severity: amlCheck.maxSeverity === "high" ? "alert"
            : amlCheck.maxSeverity === "medium" ? "warn"
            : "info",
    metadata: {
      amount: Number(amount),
      fee,
      reference: ref,
      route,
      accountNumber,
      bankName: resolvedBank,
      flags: (amlCheck.flags || []).map((f) => f.ruleCode),
      automated: !req, // cron call has req: null
    },
  });

  // 7. Push notification (skippable for batches).
  if (notify) {
    const automatedPrefix = req ? "" : "Auto-debit: ";
    const feeSuffix = fee > 0 ? ` · fee ${formatAmountForBusiness(business, fee)}` : "";
    await pushTo(
      userId,
      `${automatedPrefix}Transfer Sent ✅`,
      `${formatAmountForBusiness(business, amount)} → ${resolvedName}${feeSuffix} (Ref: ${ref.slice(-8)})`,
    );
  }

  // `fee` is OUR charge; `totalCost` is everything that left the account beyond
  // the amount (fee + the bank's stamp duty), which is what a cached balance
  // must be reduced by.
  return { reference: ref, route, transactionId: txn.id, transaction: txn, fee, totalCost, providerTransferId };
}

module.exports = { executeTransfer };
