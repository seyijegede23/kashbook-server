/**
 * Unstick BusinessCustomers that were created BEFORE we added the OWNER role.
 *
 * Symptom: Anchor BusinessCustomer exists in `verification.status: "unverified"`
 * with only a DIRECTOR officer (percentOwned: 0) and no OWNER. KYB trigger
 * fails silently with "A minimum of 5.0% owner information is required"
 * and the user is stuck on "Verifying your business..." indefinitely.
 *
 * Fix per stuck user:
 *   1. POST /businesses/{customerId}/officers — add an OWNER officer
 *   2. POST /customers/{customerId}/verification/business — re-trigger KYB
 *   3. The customer.identification.approved webhook fires asynchronously,
 *      which creates the DepositAccount and writes the NUBAN.
 *
 * Usage (PowerShell):
 *   $env:DATABASE_URL = "<render postgres url>"
 *   $env:ANCHOR_BASE_URL = "https://api.sandbox.getanchor.co/api/v1"
 *   $env:ANCHOR_API_KEY = "<sandbox key>"
 *   node scripts/unstick-anchor-kyb.js
 */

const prisma = require("../src/utils/db");
const anchor = require("../src/utils/anchor");

const BASE = () => process.env.ANCHOR_BASE_URL;
const KEY = () => process.env.ANCHOR_API_KEY;

// Map Anchor phone to local 0XXXXXXXXXX (already exported via normalizePhoneForAnchor
// in anchor.js, but it's not exported — inline it here).
function normalizePhone(phone) {
  if (!phone) return "07000000000";
  const digits = String(phone).replace(/\D/g, "");
  if (digits.startsWith("234") && digits.length === 13) return "0" + digits.slice(3);
  if (digits.length === 10) return "0" + digits;
  return digits;
}

async function addOwnerOfficer(customerId, user, biz) {
  const phone = normalizePhone(user.phone);
  const dob =
    user.dateOfBirth instanceof Date
      ? user.dateOfBirth.toISOString().slice(0, 10)
      : new Date(user.dateOfBirth).toISOString().slice(0, 10);

  const body = {
    data: {
      type: "BusinessOfficer",
      attributes: {
        fullName: {
          firstName: user.firstName,
          lastName: user.lastName || user.firstName,
        },
        role: "OWNER",
        dateOfBirth: dob,
        email: user.email,
        phoneNumber: phone,
        title: "President",
        nationality: "NG",
        address: {
          country: "NG",
          state: biz.addressState || "Lagos",
          addressLine_1: biz.addressLine1 || "1 Marina Street",
          addressLine_2: biz.addressLine2 || "",
          city: biz.addressCity || "Lagos Island",
          postalCode: biz.addressPostalCode || "100001",
        },
        bvn: user.bvn || biz.kycBvnPlain, // caller passes decrypted bvn
        percentageOwned: 100,
      },
    },
  };

  const res = await fetch(`${BASE()}/businesses/${customerId}/officers`, {
    method: "POST",
    headers: {
      "x-anchor-key": KEY(),
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) {
    const err = new Error(
      data?.errors?.[0]?.detail || data?.message || `addOfficer failed (${res.status})`,
    );
    err.httpStatus = res.status;
    err.anchorErrors = data?.errors;
    throw err;
  }
  return data;
}

async function getCustomerVerificationStatus(customerId) {
  const res = await fetch(`${BASE()}/customers/${customerId}`, {
    headers: { "x-anchor-key": KEY(), Accept: "application/json" },
  });
  const data = await res.json();
  return data?.data?.attributes?.verification?.status || "unknown";
}

async function main() {
  const { decrypt } = require("../src/utils/crypto");

  const stuck = await prisma.user.findMany({
    where: {
      anchorCustomerId: { not: null },
      kycStatus: { notIn: ["verified", "rejected"] },
    },
    include: { businesses: { take: 1, orderBy: { createdAt: "asc" } } },
  });

  console.log(`Found ${stuck.length} stuck user(s).`);

  for (const user of stuck) {
    const biz = user.businesses[0];
    if (!biz) {
      console.warn(`[skip] ${user.email}: no business`);
      continue;
    }
    console.log(`\n── ${user.email} (${user.anchorCustomerId}) — ${biz.name} ──`);

    // Skip if a deposit account already exists (someone else fixed it)
    if (biz.anchorAccountId) {
      console.log(`  already has anchorAccountId=${biz.anchorAccountId} — skipping`);
      continue;
    }

    // Decrypt BVN from business (we encrypted it on submit)
    let bvn = null;
    try {
      bvn = biz.kycBvn ? decrypt(biz.kycBvn) : null;
    } catch (e) {
      console.warn(`  could not decrypt BVN: ${e.message}`);
    }

    // 1. Check verification status
    const status = await getCustomerVerificationStatus(user.anchorCustomerId);
    console.log(`  Anchor verification.status = ${status}`);

    if (status === "approved") {
      // Already approved on Anchor's side — open the deposit account now
      try {
        const acc = await anchor.createDepositAccount({
          customerId: user.anchorCustomerId,
          customerType: "BusinessCustomer",
          productName: biz.bankAccountType || "SAVINGS",
        });
        await prisma.user.update({
          where: { id: user.id },
          data: { kycStatus: "verified" },
        });
        await prisma.business.update({
          where: { id: biz.id },
          data: {
            anchorAccountId: acc.accountId,
            virtualAccountId: acc.accountId,
            virtualAccountRef: acc.accountId,
          },
        });
        console.log(`  ✓ DepositAccount opened: ${acc.accountId} — NUBAN will land via webhook`);
      } catch (e) {
        console.error(`  ✗ createDepositAccount failed: ${e.message}`);
      }
    } else if (status === "unverified") {
      // Bad BusinessCustomer created without the OWNER role fix — delete and
      // let the user retry. The new POST /customers payload now sends both
      // DIRECTOR + OWNER, so retry will succeed.
      try {
        const delRes = await fetch(`${BASE()}/customers/${user.anchorCustomerId}`, {
          method: "DELETE",
          headers: { "x-anchor-key": KEY(), Accept: "application/json" },
        });
        if (!delRes.ok) {
          const t = await delRes.text();
          console.error(`  ✗ delete failed: ${delRes.status} ${t.slice(0, 200)}`);
          continue;
        }
        console.log(`  ✓ deleted BusinessCustomer on Anchor`);
      } catch (e) {
        console.error(`  ✗ delete error: ${e.message}`);
        continue;
      }
      await prisma.user.update({
        where: { id: user.id },
        data: { anchorCustomerId: null, kycStatus: "unverified" },
      });
      await prisma.business.update({
        where: { id: biz.id },
        data: {
          anchorAccountId: null,
          virtualAccountId: null,
          virtualAccountRef: null,
          virtualAccountNumber: null,
          virtualAccountBank: null,
          virtualAccountName: null,
        },
      });
      console.log(`  ✓ cleared local state — user can retry "Get Account Number"`);
    } else {
      console.log(`  status=${status} — manual review required, leaving as-is`);
    }
  }

  console.log(`\nDone.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
