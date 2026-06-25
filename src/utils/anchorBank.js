/**
 * Open an individual-KYC settlement account + a business-named virtual NUBAN.
 *
 * The "individual KYC + business-named account" flow (cheap ₦50 individual KYC
 * instead of ₦1,000 business KYB): the owner is an Anchor IndividualCustomer
 * with a SAVINGS deposit account (the settlement account — labelled with the
 * person's name, never shown to payers). On top of it we mint a Providus
 * VirtualNuban whose displayed name IS THE BUSINESS NAME — that's the account
 * customers pay into and see. Inbound credits settle into the deposit account.
 *
 * Called from:
 *   - routes/businesses.js  (sync path — user already KYC-verified, e.g. adding
 *     a 2nd business; the raw BVN is in the request)
 *   - routes/anchor.js      (webhook customer.identification.approved — first
 *     business; BVN comes from the encrypted Business.kycBvn)
 */

const prisma = require("./db");
const anchor = require("./anchor");
const { decrypt } = require("./crypto");

async function openIndividualBankAccount({ biz, customerId, bvn }) {
  // Already provisioned — idempotent no-op (webhook redelivery / retry).
  if (biz.virtualAccountNumber) {
    return {
      accountId: biz.anchorAccountId,
      accountNumber: biz.virtualAccountNumber,
      accountName: biz.virtualAccountName,
      bankName: biz.virtualAccountBank,
      skipped: true,
    };
  }

  const rawBvn = bvn || (biz.kycBvn ? decrypt(biz.kycBvn) : null);
  if (!rawBvn) {
    throw new Error(`openIndividualBankAccount: no BVN available for business ${biz.id}`);
  }

  // 1. Settlement deposit account (SAVINGS — individual only). Reuse an existing
  //    one if a prior attempt already opened it (anchorAccountId set but NUBAN
  //    write failed mid-way).
  let accountId = biz.anchorAccountId;
  if (!accountId) {
    const acc = await anchor.createDepositAccount({
      customerId,
      customerType: "IndividualCustomer",
      productName: "SAVINGS",
    });
    accountId = acc.accountId;
  }

  // 2. Business-named virtual NUBAN settling into it. `reference` keyed on the
  //    business id makes the create idempotent (Anchor returns the same NUBAN on
  //    a retry within the idempotency window).
  const nuban = await anchor.createVirtualNuban({
    settlementAccountId: accountId,
    name: biz.name,
    bvn: rawBvn,
    reference: `kb-${biz.id}`,
  });

  await prisma.business.update({
    where: { id: biz.id },
    data: {
      anchorAccountId: accountId,
      virtualAccountId: accountId,
      virtualAccountRef: accountId,
      virtualAccountNumber: nuban.accountNumber,
      virtualAccountName: nuban.accountName || biz.name,
      virtualAccountBank: nuban.bankName || "Providus Bank",
    },
  });

  return { accountId, ...nuban };
}

module.exports = { openIndividualBankAccount };
