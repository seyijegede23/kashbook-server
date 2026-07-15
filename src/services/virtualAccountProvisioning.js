// Virtual-account (Anchor KYC/KYB) provisioning — extracted from
// routes/businesses.js so it can run in two places:
//   1. SUBMIT  (routes/businesses.js POST /:id/virtual-account) — validate only,
//      then park the request as a PENDING KycSubmission. Nothing hits Anchor.
//   2. APPROVE (routes/admin.js) — an admin approves the parked submission and
//      we replay the stored payload here to create the Anchor customer + KYC.
//
// The Dojah pre-check (runBvnCheck / runCacCheck) was intentionally removed from
// this flow: the admin gate + Anchor's own authoritative KYC make the redundant
// paid pre-check unnecessary. Re-add by calling runBvnCheck/runCacCheck before
// the persist step in executeVirtualAccountProvisioning if ever wanted.
//
// IMPORTANT: unlike the old inline route, these functions operate on the target
// business/user explicitly — they never read req.user / req.params / req.body,
// because at approval time `req` belongs to the ADMIN, not the merchant.

const prisma = require("../utils/db");
const anchor = require("../utils/anchor");
const { openIndividualBankAccount } = require("../utils/anchorBank");
const { encrypt, hmacValue } = require("../utils/crypto");
const { audit } = require("../utils/audit");
const { getRiskCategory } = require("../config/amlLimits");
const { getProvider } = require("../providers");
const { getCountryConfig } = require("../config/countries");
const {
  isValidNigerianState,
  checkAdultDob,
  checkRegistrationDate,
  isPlausibleCacNumber,
  normaliseCacNumber,
} = require("../utils/kycMatch");
const { isValidAnchorIndustry } = require("../data/anchorIndustries");

const err = (httpStatus, error, code) => ({ ok: false, httpStatus, error, code });

// Light validation for non-NGN Fincra countries (GHS/KES/TZS). Fincra's create
// call needs only the individual's name (+ email for GHS); the national ID is
// collected for our records but not required at issuance. Keep the adult check
// when a DOB is on file.
function validateUnifiedNonNgnInput({ user, currency }) {
  if (!user.firstName) {
    return err(400, "Add your name in Profile before opening an account.", "NAME_REQUIRED");
  }
  if (currency === "GHS" && !user.email) {
    return err(400, "Add an email address in Profile to open a Ghana account.", "EMAIL_REQUIRED");
  }
  if (user.dateOfBirth) {
    const c = checkAdultDob(user.dateOfBirth);
    if (!c.ok && c.code === "DOB_TOO_YOUNG") {
      return err(400, "You must be 18 or older to open a KashBook account.", "KYC_DOB_TOO_YOUNG");
    }
  }
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase A (format/sanity) + Phase B (dedup). Free, synchronous, no writes and no
// third-party calls. Returns { ok: true } or { ok: false, httpStatus, error, code }.
// Run this at SUBMIT (immediate user feedback) AND again at APPROVE (a racing
// business may have claimed the BVN/CAC in between).
// ─────────────────────────────────────────────────────────────────────────────
async function validateVirtualAccountInput({ body, user, biz }) {
  // Fincra countries other than NG issue an INDIVIDUAL account with light
  // create-KYC (name only, + email for GHS). No BVN / national-ID at create, and
  // none of the NG BusinessCustomer/KYB machinery. NG keeps its full, proven
  // validation below (its create-KYC still needs a BVN on Fincra too).
  const cfg = getCountryConfig(biz.country);
  const currency = cfg?.currency?.code || "NGN";
  if (currency !== "NGN") {
    return validateUnifiedNonNgnInput({ user, currency });
  }

  const {
    bvn,
    dateOfBirth,
    gender,
    businessType,
    industry,
    dateOfRegistration,
    businessAddress,
    owners,
    cacNumber,
  } = body;

  if (!bvn || bvn.length !== 11) {
    return err(400, "A valid 11-digit BVN is required.", "BVN_FORMAT_INVALID");
  }

  const isLtd = businessType === "limited_company";

  // Defence-in-depth: businessKyb=true (paid Anchor BusinessCustomer KYB) only
  // makes sense for a registered entity, never for an "individual" selection.
  if (body.businessKyb === true && businessType === "individual") {
    return err(400, "Individual accounts use identity (BVN) verification, not business KYB.", "KYB_TYPE_MISMATCH");
  }

  if (isLtd) {
    if (!Array.isArray(owners) || owners.length === 0) {
      return err(400, "Limited companies must list at least one owner.");
    }
    if (!dateOfRegistration) {
      return err(400, "Date of incorporation is required for limited companies.");
    }
    const sum = owners.reduce((s, o) => s + Number(o.percentageOwned || 0), 0);
    if (Math.abs(sum - 100) > 0.01) {
      return err(400, `Owner percentages must add up to 100% (got ${sum.toFixed(2)}%).`);
    }
    for (const o of owners) {
      if (!o.firstName || !o.lastName) {
        return err(400, "Each owner needs a first and last name.");
      }
      if (!/^\d{11}$/.test(String(o.bvn || ""))) {
        return err(400, "Each owner needs a valid 11-digit BVN.");
      }
      if (!o.dateOfBirth) {
        return err(400, "Each owner needs a date of birth.");
      }
      if (Number(o.percentageOwned) < 5) {
        return err(400, "Each owner must hold at least 5%.");
      }
    }
  }

  const dob = dateOfBirth ? new Date(dateOfBirth) : user.dateOfBirth;
  if (!dob || isNaN(new Date(dob).getTime())) {
    return err(400, "A valid date of birth is required.");
  }
  const userGender = gender || user.gender;
  if (!userGender) {
    return err(400, "Gender is required for KYC verification.");
  }

  const dobCheck = checkAdultDob(dob);
  if (!dobCheck.ok) {
    return err(
      400,
      dobCheck.code === "DOB_TOO_YOUNG"
        ? "You must be 18 or older to open a KashBook bank account."
        : "The date of birth doesn't look valid. Please correct it.",
      `BVN_${dobCheck.code}`,
    );
  }
  if (dateOfRegistration) {
    const regCheck = checkRegistrationDate(dateOfRegistration);
    if (!regCheck.ok) {
      return err(
        400,
        regCheck.code === "REGDATE_FUTURE"
          ? "The registration date can't be in the future."
          : "The registration date doesn't look valid.",
        regCheck.code,
      );
    }
  }
  if (industry && !isValidAnchorIndustry(industry)) {
    return err(400, "Pick an industry from the list — the one selected isn't recognised.", "INDUSTRY_INVALID");
  }
  if (user.phone && !anchor.isValidAnchorPhone(user.phone)) {
    return err(400, "Your profile phone number doesn't look like a valid Nigerian mobile number. Update it in Profile, then try again.", "PHONE_INVALID");
  }
  for (const o of Array.isArray(owners) ? owners : []) {
    if (o.phoneNumber && !anchor.isValidAnchorPhone(o.phoneNumber)) {
      return err(400, `${o.firstName || "A shareholder"}'s phone number doesn't look like a valid Nigerian mobile number.`, "OWNER_PHONE_INVALID");
    }
  }
  if (businessAddress) {
    if (businessAddress.state && !isValidNigerianState(businessAddress.state)) {
      return err(400, `"${businessAddress.state}" isn't a valid Nigerian state.`, "ADDRESS_INVALID_STATE");
    }
    if (businessAddress.addressLine1 && businessAddress.addressLine1.trim().length < 5) {
      return err(400, "Address line 1 looks too short. Please enter a full street address.", "ADDRESS_LINE1_TOO_SHORT");
    }
    if (businessAddress.city && businessAddress.city.trim().length < 2) {
      return err(400, "City is required.", "ADDRESS_CITY_REQUIRED");
    }
    if (businessAddress.postalCode && !/^\d{6}$/.test(businessAddress.postalCode.trim())) {
      return err(400, "Postal code must be 6 digits (or leave it blank).", "ADDRESS_POSTAL_INVALID");
    }
  }
  if (isLtd && !cacNumber) {
    return err(400, "A CAC RC number is required for limited companies.", "CAC_REQUIRED");
  }
  if (cacNumber && !isPlausibleCacNumber(cacNumber)) {
    return err(400, "Enter a valid RC or BN number (4-8 digits, optional RC/BN prefix).", "CAC_FORMAT_INVALID");
  }

  // Phase B · Dedup — reject if another business already registered this BVN/CAC.
  const bvnHash = hmacValue(bvn);
  const cacHash = cacNumber ? hmacValue(normaliseCacNumber(cacNumber)) : null;
  if (bvnHash) {
    const conflict = await prisma.business.findFirst({
      where: { kycBvnHash: bvnHash, id: { not: biz.id } },
      select: { id: true },
    });
    if (conflict) {
      return err(400, "This BVN is already linked to another KashBook account. If this is you, please log in to the original account.", "BVN_ALREADY_VERIFIED");
    }
  }
  if (cacHash) {
    const conflict = await prisma.business.findFirst({
      where: { kycCacHash: cacHash, id: { not: biz.id } },
      select: { id: true },
    });
    if (conflict) {
      return err(400, "This RC/BN number is already registered to another KashBook business.", "CAC_ALREADY_VERIFIED");
    }
  }

  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Persist KYC fields + create the Anchor customer + trigger KYC/KYB + open the
// account. Assumes the input was already validated. Returns { httpStatus, body }
// for the caller to relay; THROWS on Anchor / DB errors so the caller can mark
// the submission FAILED. `req` is used only for the audit actor (the admin).
// ─────────────────────────────────────────────────────────────────────────────
async function executeVirtualAccountProvisioning({ biz, user, body, req }) {
  // Unified (one-call) providers — Fincra — issue the local account in a single
  // call and return the account number synchronously. Anchor's granular chain
  // is below. NG stays on Anchor until the country config flips (B8), so this
  // branch is dormant until then.
  const provider = getProvider(biz);
  if (provider.unifiedProvisioning) {
    return provisionViaUnifiedProvider({ provider, biz, user, body, req });
  }

  const {
    bvn,
    dateOfBirth,
    gender,
    businessType,
    industry,
    dateOfRegistration,
    businessAddress,
    owners,
    cacNumber,
  } = body;

  const isLtd = businessType === "limited_company";
  const dob = dateOfBirth ? new Date(dateOfBirth) : user.dateOfBirth;
  const userGender = gender || user.gender;
  const bvnHash = hmacValue(bvn);
  const cacHash = cacNumber ? hmacValue(normaliseCacNumber(cacNumber)) : null;
  const registrationType = anchor.mapBusinessTypeToRegistration(businessType);

  // Persist BVN encrypted + KYB fields on the Business so a retry keeps them.
  const bizPatch = {
    kycBvn: encrypt(bvn),
    kycBvnHash: bvnHash,
  };
  if (cacNumber) {
    bizPatch.kycCacNumber = encrypt(normaliseCacNumber(cacNumber));
    bizPatch.kycCacHash = cacHash;
  }
  if (industry) {
    bizPatch.industry = industry;
    bizPatch.riskCategory = getRiskCategory(industry);
  }
  if (registrationType) bizPatch.registrationType = registrationType;
  if (dateOfRegistration) {
    bizPatch.dateOfRegistration = new Date(dateOfRegistration);
    if (isLtd) bizPatch.dateOfIncorporation = new Date(dateOfRegistration);
  }
  if (businessAddress?.state) bizPatch.addressState = businessAddress.state;
  if (businessAddress?.addressLine1) bizPatch.addressLine1 = businessAddress.addressLine1;
  if (businessAddress?.city) bizPatch.addressCity = businessAddress.city;
  if (businessAddress?.postalCode) bizPatch.addressPostalCode = businessAddress.postalCode;
  if (isLtd) bizPatch.kycBusinessType = "limited_company";
  else bizPatch.kycBusinessType = "sole_proprietor";

  await prisma.business.update({ where: { id: biz.id }, data: bizPatch });

  const userPatch = {};
  if (!user.dateOfBirth) userPatch.dateOfBirth = new Date(dob);
  if (!user.gender) userPatch.gender = userGender;
  if (Object.keys(userPatch).length) {
    await prisma.user.update({ where: { id: user.id }, data: userPatch });
  }

  // Persist LTD officers (BVN encrypted) BEFORE the Anchor call so retries work.
  if (isLtd) {
    await prisma.businessOfficer.deleteMany({ where: { businessId: biz.id } });
    await prisma.businessOfficer.createMany({
      data: [
        {
          businessId: biz.id,
          role: "DIRECTOR",
          firstName: user.firstName,
          lastName: user.lastName || user.firstName,
          bvn: encrypt(bvn),
          bvnHash: hmacValue(bvn),
          dateOfBirth: new Date(dob),
          gender: userGender,
          email: user.email,
          phoneNumber: user.phone,
          title: "CEO",
          percentageOwned: 0,
        },
        ...owners.map((o) => ({
          businessId: biz.id,
          role: "OWNER",
          firstName: o.firstName,
          lastName: o.lastName,
          middleName: o.middleName || null,
          bvn: encrypt(o.bvn),
          bvnHash: hmacValue(o.bvn),
          dateOfBirth: new Date(o.dateOfBirth),
          gender: o.gender || "Male",
          email: o.email || null,
          phoneNumber: o.phoneNumber || null,
          title: o.title || "President",
          percentageOwned: Number(o.percentageOwned),
          addressLine1: o.addressLine1 || null,
          addressCity: o.addressCity || null,
          addressState: o.addressState || null,
          addressPostalCode: o.addressPostalCode || null,
        })),
      ],
    });
  }

  // 1. Ensure-or-adopt the Anchor customer — serialized per business so two
  // concurrent requests can't create duplicate Anchor customers.
  let customerId = user.anchorCustomerId;
  let customerType = "BusinessCustomer";
  let adoptedAlreadyApproved = false;
  await prisma.withBusinessLock(biz.id, async () => {
    const fresh = await prisma.user.findUnique({
      where: { id: user.id },
      select: { anchorCustomerId: true },
    });
    customerId = fresh?.anchorCustomerId || null;
    if (customerId) return; // already created/adopted by a concurrent request
    try {
      if (body.businessKyb === true) {
        const created = await anchor.createBusinessCustomer({
          businessName: biz.name,
          businessBvn: bvn,
          dateOfRegistration,
          industry,
          registrationType,
          businessAddress: businessAddress?.addressLine1
            ? {
                state: businessAddress.state,
                addressLine_1: businessAddress.addressLine1,
                city: businessAddress.city,
                postalCode: businessAddress.postalCode,
              }
            : undefined,
          user: {
            firstName: user.firstName,
            lastName: user.lastName || user.firstName,
            email: user.email || `${user.id}@kashbook.app`,
            phone: user.phone || "+2348000000000",
            dateOfBirth: dob,
            bvn,
          },
          owners: isLtd ? owners : undefined,
        });
        customerId = created.customerId;
      } else {
        const created = await anchor.createIndividualCustomer({
          user: {
            firstName: user.firstName,
            lastName: user.lastName || user.firstName,
            email: user.email || `${user.id}@kashbook.app`,
            phone: user.phone || "+2348000000000",
          },
          address: businessAddress?.addressLine1
            ? {
                state: businessAddress.state,
                addressLine_1: businessAddress.addressLine1,
                city: businessAddress.city,
                postalCode: businessAddress.postalCode,
              }
            : undefined,
        });
        customerId = created.customerId;
      }
    } catch (e) {
      const isDuplicate =
        /already exist/i.test(e.message || "") ||
        (e.httpStatus === 400 &&
          (e.anchorErrors?.[0]?.detail || "").toLowerCase().includes("already exist"));
      if (!isDuplicate) throw e;

      const phone = (user.phone || "").replace(/^\+/, "");
      const searchValues = [biz.name, phone, user.email, bvn].filter(Boolean);
      const customerTypes = ["BusinessCustomer", "IndividualCustomer"];
      let existing = null;
      let existingType = null;
      outer: for (const ct of customerTypes) {
        for (const sv of searchValues) {
          const hit = await anchor.searchCustomer({ searchValue: sv, customerType: ct });
          if (hit?.customerId) {
            existing = hit;
            existingType = ct;
            console.log(`[Anchor] found existing ${ct} ${hit.customerId} via "${sv}"`);
            break outer;
          }
        }
      }
      if (!existing?.customerId) {
        throw new Error("Anchor reports this user already exists but we can't look them up. Contact support.");
      }
      customerId = existing.customerId;
      customerType = existingType;
      adoptedAlreadyApproved = true;
      console.log(`[Anchor] adopted existing ${existingType} ${customerId} for ${biz.name}`);
    }
    await prisma.user.update({
      where: { id: user.id },
      data: { anchorCustomerId: customerId },
    });
  });

  // The Anchor ID suffix is the source of truth for customer type.
  customerType = /-anc_ind_cst$/.test(customerId || "")
    ? "IndividualCustomer"
    : "BusinessCustomer";

  // 2. Trigger KYC/KYB for newly-created customers that aren't verified yet.
  if (!adoptedAlreadyApproved && user.kycStatus !== "verified") {
    try {
      if (customerType === "IndividualCustomer") {
        await anchor.triggerIndividualKyc(customerId, { bvn, dateOfBirth: dob, gender: userGender });
      } else {
        await anchor.triggerKYB(customerId);
      }
    } catch (e) {
      if (e.httpStatus !== 409) {
        console.warn("[KYC trigger] failed:", e.message);
      }
    }
    await audit({
      req,
      action: "KYB_SUBMIT",
      resourceType: "business",
      resourceId: biz.id,
      severity: "info",
      metadata: {
        businessType,
        registrationType,
        industry,
        ownersCount: Array.isArray(owners) ? owners.length : 0,
        riskCategory: bizPatch.riskCategory || "standard",
      },
    });
    return {
      httpStatus: 202,
      body: {
        status: "pending_kyc",
        message: "We're verifying your identity. You'll get a notification when your account is ready.",
      },
    };
  }

  // Mark the user verified locally since we're about to open an account for an
  // already-approved customer (adopted or webhook-confirmed).
  if (user.kycStatus !== "verified") {
    await prisma.user.update({ where: { id: user.id }, data: { kycStatus: "verified" } });
  }

  // 3. KYC verified — open the bank account synchronously.
  if (customerType === "IndividualCustomer") {
    const r = await openIndividualBankAccount({ biz, customerId, bvn });
    return {
      httpStatus: 200,
      body: {
        status: "ready",
        accountNumber: r.accountNumber,
        bankName: r.bankName,
        accountName: r.accountName,
      },
    };
  }

  // Idempotency: if a deposit account was already created (a prior partial run
  // that failed afterwards, or a re-approval), don't mint a second one — just
  // report the in-flight state and let the accountNumber.created webhook finish.
  if (biz.anchorAccountId) {
    return {
      httpStatus: 202,
      body: {
        status: "pending_account",
        message: "Your account is being provisioned. You'll get a notification shortly.",
      },
    };
  }

  const acc = await anchor.createDepositAccount({ customerId, customerType });
  await prisma.business.update({
    where: { id: biz.id },
    data: {
      anchorAccountId: acc.accountId,
      virtualAccountId: acc.accountId,
      virtualAccountRef: acc.accountId,
    },
  });
  return {
    httpStatus: 202,
    body: {
      status: "pending_account",
      message: "Your account is being provisioned. You'll get a notification shortly.",
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// One-call provisioning (Fincra): persist KYC, issue the LOCAL account, write the
// account number. Instant for NGN/GHS/KES/TZS. THROWS on provider/DB errors so the
// caller marks the submission FAILED (same contract as the Anchor path).
// ─────────────────────────────────────────────────────────────────────────────
async function provisionViaUnifiedProvider({ provider, biz, user, body, req }) {
  const { bvn, dateOfBirth, gender } = body;
  const cfg = getCountryConfig(biz.country);
  const currency = cfg?.currency?.code || biz.baseCurrency || "NGN";

  // Idempotency: a local account already exists → report it, don't re-issue.
  if (biz.providerAccountId && biz.virtualAccountNumber) {
    return {
      httpStatus: 200,
      body: {
        status: "ready",
        accountNumber: biz.virtualAccountNumber,
        bankName: biz.virtualAccountBank,
        accountName: biz.virtualAccountName,
      },
    };
  }

  // Persist the primary KYC id (generic encrypted) + BVN for NG back-compat.
  const bizPatch = { localAccountStatus: "pending" };
  if (bvn) {
    bizPatch.kycBvn = encrypt(bvn);
    bizPatch.kycBvnHash = hmacValue(bvn);
    bizPatch.kycId = encrypt(bvn);
    bizPatch.kycIdType = cfg?.kyc?.primaryIdType || "BVN";
  }
  await prisma.business.update({ where: { id: biz.id }, data: bizPatch });

  const userPatch = {};
  if (!user.dateOfBirth && dateOfBirth) userPatch.dateOfBirth = new Date(dateOfBirth);
  if (!user.gender && gender) userPatch.gender = gender;
  if (Object.keys(userPatch).length) {
    await prisma.user.update({ where: { id: user.id }, data: userPatch });
  }

  const merchantReference = `kb_${biz.id}`;
  let result;
  try {
    result = await provider.provisionLocalAccount({
      currency,
      accountType: "individual",
      kyc: {
        firstName: user.firstName,
        lastName: user.lastName || user.firstName,
        email: user.email || undefined,
        bvn: bvn || undefined,
      },
      merchantReference,
    });
  } catch (e) {
    // 409 DUPLICATE_REFERENCE: the account was already created at the provider
    // under our deterministic merchantReference on a prior attempt that failed to
    // persist. Recover it (re-fetch + back-fill) instead of orphaning it.
    const isDup = e.status === 409 || /duplicate/i.test(`${e.body?.message || e.message || ""}`);
    if (isDup && typeof provider.recoverLocalAccount === "function") {
      result = await provider.recoverLocalAccount({ currency, merchantReference });
    }
    if (!result) throw e;
  }

  if (result?.accountNumber) {
    await prisma.business.update({
      where: { id: biz.id },
      data: {
        providerAccountId: result.providerRef || null,
        paymentProviderRef: result.providerRef || null,
        virtualAccountNumber: result.accountNumber,
        virtualAccountBank: result.bankName || null,
        virtualAccountName: result.accountName || null,
        localAccountStatus: "issued",
      },
    });
    if (user.kycStatus !== "verified") {
      await prisma.user.update({ where: { id: user.id }, data: { kycStatus: "verified" } });
    }
    await audit({
      req,
      action: "ACCOUNT_ISSUED",
      resourceType: "business",
      resourceId: biz.id,
      severity: "info",
      metadata: { currency, provider: cfg?.paymentProvider, bank: result.bankName },
    });
    return {
      httpStatus: 200,
      body: {
        status: "ready",
        accountNumber: result.accountNumber,
        bankName: result.bankName,
        accountName: result.accountName,
      },
    };
  }

  // No account number yet (e.g. an FCY currency routed here) — leave pending.
  return {
    httpStatus: 202,
    body: {
      status: "pending_account",
      message: "Your account is being provisioned. You'll get a notification shortly.",
    },
  };
}

// Non-sensitive summary the admin list renders. NEVER includes a raw BVN.
function buildSubmissionSummary({ body, user, biz }) {
  const maskBvn = (b) => (b && b.length === 11 ? `•••• •••• ${b.slice(-3)}` : null);
  return {
    businessName: biz.name,
    ownerName: `${user.firstName} ${user.lastName || ""}`.trim(),
    ownerEmail: user.email || null,
    ownerPhone: user.phone || null,
    businessType: body.businessType || null,
    businessKyb: body.businessKyb === true,
    industry: body.industry || null,
    cacNumber: body.cacNumber || null,
    bvnMasked: maskBvn(body.bvn),
    state: body.businessAddress?.state || null,
    city: body.businessAddress?.city || null,
    owners: Array.isArray(body.owners)
      ? body.owners.map((o) => ({
          name: `${o.firstName || ""} ${o.lastName || ""}`.trim(),
          percentageOwned: Number(o.percentageOwned) || 0,
        }))
      : [],
  };
}

module.exports = {
  validateVirtualAccountInput,
  executeVirtualAccountProvisioning,
  buildSubmissionSummary,
};
