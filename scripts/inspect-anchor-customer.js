/**
 * Diagnostic: fetch everything Anchor knows about a customer (by email),
 * then re-trigger KYC with the locally-stored BVN/DOB/gender so we can see
 * what the verification response says.
 *
 * Usage:
 *   $env:DATABASE_URL = "..."
 *   $env:ANCHOR_BASE_URL = "..."
 *   $env:ANCHOR_API_KEY = "..."
 *   $env:ENCRYPTION_KEY = "..."
 *   node scripts/inspect-anchor-customer.js seyijegede23@gmail.com
 */

const prisma = require("../src/utils/db");
const anchor = require("../src/utils/anchor");
const { decrypt } = require("../src/utils/crypto");

async function main() {
  const email = process.argv[2];
  if (!email) {
    console.error("Usage: node scripts/inspect-anchor-customer.js <email>");
    process.exit(1);
  }

  const user = await prisma.user.findFirst({ where: { email } });
  if (!user || !user.anchorCustomerId) {
    console.error("User has no anchorCustomerId");
    process.exit(1);
  }

  console.log("\n=== Local DB state ===");
  console.log("userId:", user.id);
  console.log("anchorCustomerId:", user.anchorCustomerId);
  console.log("kycStatus:", user.kycStatus);
  console.log("dateOfBirth:", user.dateOfBirth);
  console.log("gender:", user.gender);
  console.log("phone:", user.phone);
  console.log("firstName/lastName:", user.firstName, user.lastName);

  const biz = await prisma.business.findFirst({
    where: { userId: user.id },
    orderBy: { createdAt: "asc" },
  });
  console.log("\n=== Business state ===");
  console.log("businessId:", biz?.id);
  console.log("anchorAccountId:", biz?.anchorAccountId);
  console.log("virtualAccountNumber:", biz?.virtualAccountNumber);
  console.log("kycBvn (decrypted):", biz?.kycBvn ? decrypt(biz.kycBvn) : null);

  console.log("\n=== Anchor: fetch customer ===");
  try {
    const cust = await anchor
      .anchorFetch
      ? await anchor.anchorFetch(`/customers/${user.anchorCustomerId}`)
      : null;
    console.log(JSON.stringify(cust, null, 2));
  } catch (e) {
    // anchorFetch isn't exported — try a different way
    console.log("Direct fetch not exported, using built-in helpers instead");
  }

  console.log("\n=== Anchor: list accounts for this customer ===");
  try {
    const accounts = await anchor.listCustomerAccounts(user.anchorCustomerId);
    console.log(`Found ${accounts.length} account(s)`);
    console.log(JSON.stringify(accounts, null, 2));
  } catch (e) {
    console.error("listCustomerAccounts failed:", e.message);
  }

  console.log("\n=== Re-triggering KYC ===");
  if (!biz?.kycBvn) {
    console.error("No stored BVN for this business — cannot retry");
    process.exit(1);
  }
  const bvn = decrypt(biz.kycBvn);
  try {
    const res = await anchor.triggerKYC(user.anchorCustomerId, {
      bvn,
      dateOfBirth: user.dateOfBirth,
      gender: user.gender,
    });
    console.log("KYC trigger response:");
    console.log(JSON.stringify(res, null, 2));
  } catch (e) {
    console.error("KYC trigger failed:");
    console.error("  message:", e.message);
    console.error("  httpStatus:", e.httpStatus);
    console.error("  anchorErrors:", JSON.stringify(e.anchorErrors, null, 2));
  }
}

main()
  .catch((err) => {
    console.error("Script failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
