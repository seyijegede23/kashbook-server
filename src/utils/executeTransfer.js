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
const { computeTransferFee, computeFincraTransferFee, MONEY_EPS } = require("../config/fees");
const { getProvider } = require("../providers");
const { getCountryConfig } = require("../config/countries");
const { computeLedgerBalance } = require("./ledgerBalance");
const balanceCache = require("./balanceCache");

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

  // Pooled providers (Fincra) use a merchant-wallet payout API; Anchor's
  // per-account chain is below. getProvider keeps an Anchor-provisioned business on
  // Anchor even after its country flips, so only pooled-native businesses get here.
  const provider = getProvider(business);
  if (provider.pooledWallet) {
    // KashBook→KashBook: the recipient is one of OUR own pooled accounts. Both
    // businesses share the merchant wallet, so this is a pure ledger move (debit
    // sender, credit recipient) — instant, free, no external payout (a real payout
    // to our own VA is rejected by the provider as an invalid beneficiary).
    const dest = await prisma.business.findFirst({
      where: { virtualAccountNumber: accountNumber, providerAccountId: { not: null } },
      select: { id: true, userId: true, name: true, virtualAccountName: true, country: true, baseCurrency: true },
    });
    if (dest && dest.id !== business.id) {
      return executeFincraBookTransfer({ business, userId, amount, dest, narration, reference, amlCheck, req, notify, source: provider.key, recordedBy, recordedByName });
    }
    const args = { provider, business, userId, amount, accountNumber, bankCode, accountName, bankName, narration, reference, amlCheck, req, notify, recordedBy, recordedByName };
    return executeFincraPayout(args);
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

  // 3. Live balance check — must cover the transfer, our fee, AND the stamp duty.
  const { balance } = await anchor.getAccountBalance(business.anchorAccountId);
  if (balance + MONEY_EPS < Number(amount) + totalCost) {
    const err = new Error(
      totalCost > 0
        ? `Insufficient balance. This transfer needs ${formatAmountForBusiness(business, Number(amount) + totalCost)} (includes ${formatAmountForBusiness(business, fee)} fee${statutoryStamp ? ` + ${formatAmountForBusiness(business, statutoryStamp)} government stamp duty` : ""}). Available: ${formatAmountForBusiness(business, balance)}`
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

// ─────────────────────────────────────────────────────────────────────────────
// Fincra one-call payout path. Simpler than Anchor (no counterparty creation):
// balance → resolve name → POST /disbursements/payouts → bookkeeping. No KashBook
// fee for now (Fincra deducts its own; repricing is B9). ⚠️ NEEDS a funded
// sandbox wallet for a real end-to-end send test before go-live.
// ─────────────────────────────────────────────────────────────────────────────
async function executeFincraPayout({
  provider, business, userId, amount, accountNumber, bankCode,
  accountName, bankName, narration, reference, amlCheck = {}, req = null, notify = true,
  recordedBy = null, recordedByName = null,
}) {
  // Encode the businessId in the customerReference (kb_tf_<bizId>_<suffix>) so the
  // payout reconcile can attribute an orphaned SUCCESSFUL payout (one that Fincra
  // processed but whose booking we lost to a timeout) back to this business. The
  // caller's reference, if any, is preserved as the suffix for its idempotency.
  const suffix = reference || `${Date.now()}${Math.random().toString(36).slice(2, 7)}`;
  const ref = `kb_tf_${String(business.id).replace(/-/g, "")}_${suffix}`;
  const cfg = getCountryConfig(business.country);
  const currency = cfg?.currency?.code || business.baseCurrency || "NGN";

  // Idempotency — reference already recorded → skip the payout.
  const existing = await prisma.transaction.findFirst({
    where: { businessId: business.id, source: "fincra", reference: ref },
    select: { id: true },
  });
  if (existing) {
    return { reference: ref, route: "idempotent_skip", transactionId: existing.id, transaction: null };
  }

  // Fincra pay-out fee (1% Fincra cost + 0.5% KashBook margin = 1.5%). The sender
  // pays amount + fee; the recipient gets `amount`. On the pooled model the margin
  // just stays in the wallet as KashBook revenue (no separate fee account).
  const { total: fee, breakdown: feeBreakdown } = computeFincraTransferFee(amount, { internal: false });

  // Live balance check. Fincra POOLS every virtual account into ONE merchant
  // wallet per currency, so provider.getAccountBalance would return the shared
  // total across ALL businesses — letting one business spend another's money.
  // A pooled business's spendable cash is its OWN ledger (matches the /balance
  // routes). Non-pooled providers keep the real per-account balance. Must cover
  // amount + fee.
  const balance = provider.pooledWallet
    ? await computeLedgerBalance(business.id, currency)
    : Number((await provider.getAccountBalance(business.providerAccountId, currency))?.balance ?? 0);
  if (balance + MONEY_EPS < Number(amount) + fee) {
    const err = new Error(`Insufficient balance. Available: ${formatAmountForBusiness(business, balance)}`);
    err.code = "INSUFFICIENT_BALANCE";
    err.availableBalance = balance;
    throw err;
  }

  // Resolve the recipient name if the caller didn't supply it.
  let resolvedName = accountName;
  if (!resolvedName) {
    const ne = await provider.verifyRecipient({ accountNumber, bankCode, currency });
    if (!ne.accountName) {
      const err = new Error("Could not resolve recipient account");
      err.code = "RECIPIENT_UNVERIFIED";
      throw err;
    }
    resolvedName = ne.accountName;
  }
  const first = resolvedName.split(" ")[0] || resolvedName;
  const last = resolvedName.split(" ").slice(1).join(" ") || first;

  await provider.payout({
    business: process.env.FINCRA_BUSINESS_ID,
    sourceCurrency: currency,
    destinationCurrency: currency,
    amount: String(amount),
    description: narration || `Transfer from ${business.name}`,
    paymentDestination: "bank_account",
    customerReference: ref,
    beneficiary: {
      firstName: first,
      lastName: last,
      accountHolderName: resolvedName,
      type: "individual",
      accountNumber,
      bankCode,
      country: business.country || "NG",
    },
  });

  // Bookkeeping — money has moved at Fincra; a DB failure must NOT surface as a
  // transfer failure (double-send risk). Fail-soft, same as the Anchor path.
  const recipientLabel = `${resolvedName} · ${bankName || currency} · ${accountNumber}`;
  const description = narration
    ? `${narration} — to ${recipientLabel} · Ref: ${ref}`
    : `Transfer to ${recipientLabel} · Ref: ${ref}`;
  let txn;
  try {
    txn = await prisma.transaction.create({
      data: {
        businessId: business.id, userId, type: "expense", amount: Number(amount),
        description, category: "transfer", paymentMethod: "bank", date: new Date(),
        source: "fincra", reference: ref, currency,
        recordedBy, recordedByName,
        fee, feeBreakdown,
        flagSeverity: amlCheck.maxSeverity || null,
        complianceStatus: amlCheck.maxSeverity ? "flagged" : "clean",
      },
    });
  } catch (bookErr) {
    console.error(`[executeFincraPayout] BOOKKEEPING FAILED after money moved (ref ${ref}):`, bookErr.message);
    await audit({
      req, action: "TRANSFER_BOOKKEEPING_FAILED", resourceType: "business", resourceId: business.id,
      severity: "alert", metadata: { reference: ref, amount: Number(amount), provider: "fincra", error: bookErr.message },
    }).catch(() => {});
    return { reference: ref, route: "nip", transactionId: null, transaction: null, bookkeepingFailed: true };
  }

  await recordComplianceFlags({
    userId, businessId: business.id, business, transactionId: txn.id,
    amount: Number(amount), flags: amlCheck.flags || [],
  });
  await audit({
    req, action: "TRANSFER_SENT", resourceType: "transaction", resourceId: txn.id,
    severity: amlCheck.maxSeverity === "high" ? "alert" : amlCheck.maxSeverity === "medium" ? "warn" : "info",
    metadata: { amount: Number(amount), reference: ref, route: "nip", provider: "fincra", accountNumber, bankName, currency, flags: (amlCheck.flags || []).map((f) => f.ruleCode), automated: !req },
  });
  if (notify) {
    await pushTo(
      userId,
      `${req ? "" : "Auto-debit: "}Transfer Sent ✅`,
      `${formatAmountForBusiness(business, amount)} → ${resolvedName} (Ref: ${ref.slice(-8)})`,
    ).catch(() => {});
  }
  return { reference: ref, route: "nip", transactionId: txn.id, transaction: txn, fee };
}
async function executeFincraBookTransfer({ business, userId, amount, dest, narration, reference, amlCheck = {}, req = null, notify = true, source = "fincra", recordedBy = null, recordedByName = null }) {
  const ref = reference || `kb_bk_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const currency = getCountryConfig(business.country)?.currency?.code || business.baseCurrency || "NGN";

  // Both legs are booked in ONE currency (below). If the recipient's base currency
  // differs, crediting them in the sender's currency would make the money invisible
  // to their balance (which filters by their own currency) — and a real cross-currency
  // move needs FX we don't do here. Reject rather than mis-credit. (Latent while all
  // accounts are NGN; guards the moment a second currency exists.)
  const destCurrency = getCountryConfig(dest.country)?.currency?.code || dest.baseCurrency || currency;
  if (destCurrency !== currency) {
    const err = new Error("Cross-currency transfers between KashBook accounts aren't supported yet.");
    err.code = "CROSS_CURRENCY_UNSUPPORTED";
    throw err;
  }

  // Idempotency — the send was already booked → skip.
  const existing = await prisma.transaction.findFirst({
    where: { businessId: business.id, source, reference: ref },
    select: { id: true },
  });
  if (existing) return { reference: ref, route: "book", transactionId: existing.id, transaction: null };

  // Sender spends from ITS OWN ledger (pooled model), not the shared wallet.
  const balance = await computeLedgerBalance(business.id, currency);
  if (balance + MONEY_EPS < Number(amount)) {
    const err = new Error(`Insufficient balance. Available: ${formatAmountForBusiness(business, balance)}`);
    err.code = "INSUFFICIENT_BALANCE";
    err.availableBalance = balance;
    throw err;
  }

  const recvName = dest.virtualAccountName || dest.name;
  const senderName = business.virtualAccountName || business.name;
  const outDesc = narration
    ? `${narration} — to ${recvName} · KashBook · Ref: ${ref}`
    : `Transfer to ${recvName} · KashBook · Ref: ${ref}`;
  const inDesc = narration
    ? `${narration} — from ${senderName} · KashBook · Ref: ${ref}`
    : `Transfer received from ${senderName} · KashBook · Ref: ${ref}`;

  // Atomic debit+credit. No external side effect, so a failure is safe to surface
  // as a transfer failure. Idempotent via @@unique([businessId, reference]).
  let outTxn;
  try {
    const [expense] = await prisma.$transaction([
      prisma.transaction.create({
        data: {
          businessId: business.id, userId, type: "expense", amount: Number(amount), currency,
          description: outDesc, category: "transfer", paymentMethod: "bank", date: new Date(),
          source, reference: ref,
          // Debit side only. The recipient's credit row below must NOT carry
          // our staff member — they didn't record anything in that business,
          // and stamping them there would attribute the money to a stranger.
          recordedBy, recordedByName,
          flagSeverity: amlCheck.maxSeverity || null,
          complianceStatus: amlCheck.maxSeverity ? "flagged" : "clean",
        },
      }),
      prisma.transaction.create({
        data: {
          businessId: dest.id, userId: dest.userId, type: "income", amount: Number(amount), currency,
          description: inDesc, category: "transfer", paymentMethod: "bank", date: new Date(),
          source, reference: `${ref}:in`,
        },
      }),
    ]);
    outTxn = expense;
  } catch (e) {
    if (e.code === "P2002") {
      const ex = await prisma.transaction.findFirst({ where: { businessId: business.id, source, reference: ref }, select: { id: true } });
      return { reference: ref, route: "book", transactionId: ex?.id || null, transaction: null };
    }
    throw e;
  }

  try {
    balanceCache.adjustBalance(business.id, -Number(amount));
    balanceCache.adjustBalance(dest.id, Number(amount));
  } catch { /* noop */ }

  await recordComplianceFlags({ userId, businessId: business.id, business, transactionId: outTxn.id, amount: Number(amount), flags: amlCheck.flags || [] });
  await audit({
    req, action: "TRANSFER_SENT", resourceType: "transaction", resourceId: outTxn.id,
    severity: amlCheck.maxSeverity === "high" ? "alert" : amlCheck.maxSeverity === "medium" ? "warn" : "info",
    metadata: { amount: Number(amount), reference: ref, route: "book", provider: source, internal: true, toBusinessId: dest.id, currency, flags: (amlCheck.flags || []).map((f) => f.ruleCode), automated: !req },
  });
  if (notify) {
    pushTo(userId, `${req ? "" : "Auto-debit: "}Transfer Sent ✅`, `${formatAmountForBusiness(business, amount)} → ${recvName} (Ref: ${ref.slice(-8)})`).catch(() => {});
    pushTo(dest.userId, "Payment received 💰", `${formatAmountForBusiness(business, amount)} from ${senderName}`).catch(() => {});
  }
  return { reference: ref, route: "book", transactionId: outTxn.id, transaction: outTxn, fee: 0 };
}

module.exports = { executeTransfer };
