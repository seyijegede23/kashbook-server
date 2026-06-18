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
const { computeTransferFee } = require("../config/fees");

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
} = {}) {
  if (!business || !business.anchorAccountId) {
    const err = new Error("Business has no banking account configured.");
    err.code = "NO_BANKING";
    throw err;
  }

  const ref =
    reference || `kashbook_tf_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  // 1. Idempotency check — if this exact reference is already on a Transaction,
  // skip the Anchor call entirely. Belt-and-braces for cron restarts.
  const existing = await prisma.transaction.findFirst({
    where: {
      businessId: business.id,
      source: "anchor",
      description: { contains: ref },
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

  const { total: fee, breakdown: feeBreakdown } = computeTransferFee(
    Number(amount),
    internalDest ? "book" : "nip",
  );

  // 3. Live balance check — must cover the transfer AND the fee.
  const { balance } = await anchor.getAccountBalance(business.anchorAccountId);
  if (balance < Number(amount) + fee) {
    const err = new Error(
      fee > 0
        ? `Insufficient balance. This transfer needs ${formatAmountForBusiness(business, Number(amount) + fee)} (includes ${formatAmountForBusiness(business, fee)} fee). Available: ${formatAmountForBusiness(business, balance)}`
        : `Insufficient balance. Available: ${formatAmountForBusiness(business, balance)}`,
    );
    err.code = "INSUFFICIENT_BALANCE";
    err.availableBalance = balance;
    throw err;
  }

  let resolvedName = accountName;
  let resolvedBank = bankName;
  let route;

  if (internalDest) {
    resolvedName = resolvedName || internalDest.virtualAccountName || internalDest.name;
    resolvedBank = "KashBook (internal)";
    route = "book";
    await anchor.createBookTransfer({
      fromAccountId: business.anchorAccountId,
      toAccountId: internalDest.anchorAccountId,
      amount: Number(amount),
      reason: narration || `Transfer from ${business.name}`,
      reference: ref,
    });
  } else {
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
    const cp = await anchor.createCounterparty({
      accountNumber,
      bankId: matchedBank.id,
      accountName: resolvedName,
    });
    route = "nip";
    await anchor.createTransfer({
      fromAccountId: business.anchorAccountId,
      counterpartyId: cp.counterpartyId,
      amount: Number(amount),
      reason: narration || `Transfer from ${business.name}`,
      reference: ref,
    });

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
        currency: business.baseCurrency || "NGN",
        flagSeverity: amlCheck.maxSeverity || null,
        complianceStatus: amlCheck.maxSeverity ? "flagged" : "clean",
        fee,
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
    return { reference: ref, route, transactionId: null, transaction: null, fee, bookkeepingFailed: true };
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

  return { reference: ref, route, transactionId: txn.id, transaction: txn, fee };
}

module.exports = { executeTransfer };
