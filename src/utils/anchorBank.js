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

  // 1. Settlement deposit account for the individual. Reuse an existing one if a
  //    prior attempt already opened it (anchorAccountId set but NUBAN write failed
  //    mid-way).
  //
  //    Product name is org-dependent on LIVE: the deposit product must be enabled
  //    for the Anchor organization or the create fails with "The product <NAME> is
  //    not enabled in this organization". Sandbox had SAVINGS on by default; a live
  //    org commonly has CURRENT instead. ANCHOR_INDIVIDUAL_PRODUCT lets ops match
  //    whatever Anchor enabled without a code change (default keeps sandbox behavior).
  let accountId = biz.anchorAccountId;
  if (!accountId) {
    const acc = await anchor.createDepositAccount({
      customerId,
      customerType: "IndividualCustomer",
      productName: process.env.ANCHOR_INDIVIDUAL_PRODUCT || "SAVINGS",
    });
    accountId = acc.accountId;
    // Persist the account link IMMEDIATELY — before the NUBAN attempt. If the
    // NUBAN step fails, (a) a re-approve reuses this account instead of relying
    // only on Anchor's 24h idempotency window, and (b) the accountNumber.created
    // webhook can match the business (it looks up by anchorAccountId) and write
    // the account's own number as a fallback.
    await prisma.business.update({
      where: { id: biz.id },
      data: { anchorAccountId: accountId, virtualAccountId: accountId, virtualAccountRef: accountId },
    });
  }

  // 2. Business-named virtual NUBAN settling into it. `reference` keyed on the
  //    business id makes the create idempotent (Anchor returns the same NUBAN on
  //    a retry within the idempotency window).
  try {
    const nuban = await anchor.createVirtualNuban({
      settlementAccountId: accountId,
      name: biz.name,
      bvn: rawBvn,
      reference: `kb-${biz.id}`,
    });

    await prisma.business.update({
      where: { id: biz.id },
      data: {
        virtualAccountNumber: nuban.accountNumber,
        virtualAccountName: nuban.accountName || biz.name,
        virtualAccountBank: nuban.bankName || "Providus Bank",
      },
    });

    return { accountId, ...nuban, businessNamed: true };
  } catch (e) {
    // Org/product limitation seen on LIVE: "The settlement account product does
    // not support creating virtual nuban via the specified provider" — Providus
    // virtual NUBANs can't settle into a SAVINGS account on this organization.
    // FALL BACK to the deposit account's OWN NUBAN: a real, payable account
    // number, just named after the PERSON (legal name) instead of the business.
    // When Anchor enables business-named NUBANs on SAVINGS, minting the pretty
    // one and overwriting these fields upgrades the account in place.
    const unsupported = /does not support creating virtual nuban/i.test(String(e && e.message));
    if (!unsupported) throw e;
    console.warn(
      `[anchorBank] business-named NUBAN unavailable for ${biz.name} (${e.message}) — using the settlement account's own number`,
    );
    let own = null;
    try {
      own = await anchor.getAccount(accountId);
    } catch (fetchErr) {
      console.warn(`[anchorBank] getAccount fallback failed: ${fetchErr.message}`);
    }
    // Only accept a REAL unmasked NUBAN (some Anchor payloads mask the number);
    // otherwise leave it to the accountNumber.created webhook, which carries the
    // full number and already writes it for a business matched by anchorAccountId.
    const full = own && /^\d{10}$/.test(String(own.accountNumber || ""));
    if (full) {
      await prisma.business.update({
        where: { id: biz.id },
        data: {
          virtualAccountNumber: own.accountNumber,
          virtualAccountName: own.accountName || biz.name,
          virtualAccountBank: own.bankName || "Anchor",
        },
      });
      return {
        accountId,
        accountNumber: own.accountNumber,
        accountName: own.accountName || biz.name,
        bankName: own.bankName || "Anchor",
        businessNamed: false,
      };
    }
    return { accountId, pendingNuban: true };
  }
}

module.exports = { openIndividualBankAccount };
