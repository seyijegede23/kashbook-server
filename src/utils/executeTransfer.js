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

  // 1. Live balance check
  const { balance } = await anchor.getAccountBalance(business.anchorAccountId);
  if (balance < Number(amount)) {
    const err = new Error(
      `Insufficient balance. Available: ${formatAmountForBusiness(business, balance)}`,
    );
    err.code = "INSUFFICIENT_BALANCE";
    err.availableBalance = balance;
    throw err;
  }

  const ref =
    reference || `kashbook_tf_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  // 2. Idempotency check — if this exact reference is already on a Transaction,
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

  // 3. Route detection — internal book transfer vs external NIP.
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
  }

  // 4. Bookkeeping row.
  const recipientLabel = resolvedBank
    ? `${resolvedName} · ${resolvedBank} · ${accountNumber}`
    : `${resolvedName} · ${accountNumber}`;
  const description = narration
    ? `${narration} — to ${recipientLabel} · Ref: ${ref}`
    : `Transfer to ${recipientLabel} · Ref: ${ref}`;

  const txn = await prisma.transaction.create({
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
      currency: business.baseCurrency || "NGN",
      flagSeverity: amlCheck.maxSeverity || null,
      complianceStatus: amlCheck.maxSeverity ? "flagged" : "clean",
    },
  });

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
    await pushTo(
      userId,
      `${automatedPrefix}Transfer Sent ✅`,
      `${formatAmountForBusiness(business, amount)} → ${resolvedName} (Ref: ${ref.slice(-8)})`,
    );
  }

  return { reference: ref, route, transactionId: txn.id, transaction: txn };
}

module.exports = { executeTransfer };
