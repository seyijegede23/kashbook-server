/**
 * Wipes the local KYC state for one user so the next Get Account Number tap
 * creates a fresh Anchor BusinessCustomer (not Individual). Use after the
 * Individual → Business migration.
 *
 *   $env:DATABASE_URL = "..."
 *   node scripts/reset-for-business-kyb.js seyijegede23@gmail.com
 */

const prisma = require("../src/utils/db");

async function main() {
  const email = process.argv[2];
  if (!email) {
    console.error("Usage: node scripts/reset-for-business-kyb.js <email>");
    process.exit(1);
  }

  const user = await prisma.user.findFirst({ where: { email } });
  if (!user) {
    console.error("No user with that email");
    process.exit(1);
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { anchorCustomerId: null, kycStatus: "unverified" },
  });

  await prisma.business.updateMany({
    where: { userId: user.id },
    data: {
      anchorAccountId: null,
      virtualAccountId: null,
      virtualAccountRef: null,
      virtualAccountNumber: null,
      virtualAccountBank: null,
      virtualAccountName: null,
      kycBvn: null,
    },
  });

  console.log(`✅ Reset KYC state for ${email}`);
  console.log(
    "Note: old Individual customer on Anchor's side still exists. Anchor's search will skip it (different customerType) when we look up duplicates next time.",
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
