// Shared bill-payment executor (airtime / data / electricity / cable TV).
// Mirrors executeTransfer.js: the caller verifies PIN + runs AML checks; this
// does the Anchor-side work + fail-safe bookkeeping.
//
// Funds come from the business's own NUBAN (Anchor DepositAccount). The bill
// auto-logs as an expense Transaction (category "bill") so it flows into the
// ledger, reports and VAT summary like any other expense.
//
// Returns { reference, billId, transactionId, transaction, fee, token }.

const prisma = require("./db");
const anchor = require("./anchor");
const { pushTo } = require("./pushNotification");
const { audit } = require("./audit");
const { recordComplianceFlags } = require("./amlChecks");
const { formatAmountForBusiness } = require("../config/amlLimits");
const { computeBillFee } = require("../config/fees");

// Human label per category, for the transaction description + push.
const CATEGORY_LABEL = {
  airtime: "Airtime",
  data: "Data",
  electricity: "Electricity",
  cabletv: "Cable TV",
};

async function executeBillPayment({
  business,
  userId,
  category,        // "airtime" | "data" | "electricity" | "cabletv"
  customerId,      // phone / meter / smartcard number
  amount,
  provider,        // biller slug — required for airtime (e.g. "mtn")
  phoneNumber,     // contact for electricity/cable (defaults to customerId)
  productSlug,     // data plan / cable bouquet / electricity product (not airtime)
  billerName,      // for the description, e.g. "MTN", "Ikeja Electric"
  reference,
  amlCheck = {},
  req = null,
  notify = true,
} = {}) {
  if (!business || !business.anchorAccountId) {
    const err = new Error("Business has no banking account configured.");
    err.code = "NO_BANKING";
    throw err;
  }

  const ref =
    reference || `kashbook_bill_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  // 1. Idempotency — skip if this reference already produced a Transaction.
  const existing = await prisma.transaction.findFirst({
    where: { businessId: business.id, source: "anchor", description: { contains: ref } },
    select: { id: true },
  });
  if (existing) {
    return { reference: ref, billId: null, transactionId: existing.id, transaction: null, fee: 0 };
  }

  const { total: fee, breakdown: feeBreakdown } = computeBillFee(Number(amount), category);

  // 2. Balance check — must cover the bill AND any convenience fee.
  const { balance } = await anchor.getAccountBalance(business.anchorAccountId);
  if (balance < Number(amount) + fee) {
    const err = new Error(
      fee > 0
        ? `Insufficient balance. This payment needs ${formatAmountForBusiness(business, Number(amount) + fee)} (includes ${formatAmountForBusiness(business, fee)} fee). Available: ${formatAmountForBusiness(business, balance)}`
        : `Insufficient balance. Available: ${formatAmountForBusiness(business, balance)}`,
    );
    err.code = "INSUFFICIENT_BALANCE";
    err.availableBalance = balance;
    throw err;
  }

  // 3. Anchor bill purchase.
  const result = await anchor.payBill({
    accountId: business.anchorAccountId,
    category,
    provider,
    customerId,
    phoneNumber,
    amount: Number(amount),
    productSlug,
    reference: ref,
  });
  const token = result.token || null; // electricity prepaid token (if returned)

  // 4. Collect convenience fee (free book transfer), if any. A failed
  // collection must NOT fail the bill — the bill already went through.
  if (fee > 0) {
    try {
      await anchor.createBookTransfer({
        fromAccountId: business.anchorAccountId,
        toAccountId: process.env.ANCHOR_FEE_ACCOUNT_ID,
        amount: fee,
        reason: "Bill payment fee",
        reference: `${ref}_fee`,
      });
    } catch (feeErr) {
      console.error(`[executeBillPayment] fee collection failed for ${ref}:`, feeErr.message);
      await audit({
        req, action: "BILL_FEE_COLLECTION_FAILED", resourceType: "business",
        resourceId: business.id, severity: "warn",
        metadata: { reference: ref, fee, error: feeErr.message },
      }).catch(() => {});
    }
  }

  // 5. Bookkeeping — the money has ALREADY moved. A DB failure here must not
  // surface as a failed payment (the user would retry and double-pay). Log
  // alert + return success; reconcile from Anchor's ledger.
  const label = CATEGORY_LABEL[category] || "Bill";
  const description =
    `${label}${billerName ? ` (${billerName})` : ""} → ${customerId} · Ref: ${ref}`;
  let txn;
  try {
    txn = await prisma.transaction.create({
      data: {
        businessId: business.id,
        userId,
        type: "expense",
        amount: Number(amount),
        description,
        category: "bill",
        paymentMethod: "bank",
        date: new Date(),
        source: "anchor",
        currency: business.baseCurrency || "NGN",
        flagSeverity: amlCheck.maxSeverity || null,
        complianceStatus: amlCheck.maxSeverity ? "flagged" : "clean",
        fee,
        feeBreakdown: feeBreakdown || undefined,
      },
    });
  } catch (bookErr) {
    console.error(
      `[executeBillPayment] BOOKKEEPING FAILED after bill paid (ref ${ref}, ₦${amount}):`,
      bookErr.message,
    );
    await audit({
      req, action: "BILL_BOOKKEEPING_FAILED", resourceType: "business",
      resourceId: business.id, severity: "alert",
      metadata: { reference: ref, amount: Number(amount), fee, category, error: bookErr.message },
    }).catch(() => {});
    if (notify) {
      await pushTo(userId, `${label} purchased ✅`,
        `${formatAmountForBusiness(business, amount)} → ${customerId}`).catch(() => {});
    }
    return { reference: ref, billId: result.billId, transactionId: null, transaction: null, fee, token };
  }

  await recordComplianceFlags({
    userId, businessId: business.id, business, transactionId: txn.id,
    amount: Number(amount), flags: amlCheck.flags || [],
  });

  await audit({
    req, action: "BILL_PAID", resourceType: "transaction", resourceId: txn.id,
    severity: amlCheck.maxSeverity === "high" ? "alert" : amlCheck.maxSeverity === "medium" ? "warn" : "info",
    metadata: { amount: Number(amount), fee, reference: ref, category, customerId,
      flags: (amlCheck.flags || []).map((f) => f.ruleCode) },
  });

  if (notify) {
    const feeSuffix = fee > 0 ? ` · fee ${formatAmountForBusiness(business, fee)}` : "";
    await pushTo(userId, `${label} purchased ✅`,
      `${formatAmountForBusiness(business, amount)} → ${customerId}${feeSuffix}`).catch(() => {});
  }

  return { reference: ref, billId: result.billId, transactionId: txn.id, transaction: txn, fee, token };
}

module.exports = { executeBillPayment };
