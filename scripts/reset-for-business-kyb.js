/**
 * Wipes the local KYC state for one user so the next Get Account Number tap
 * creates a fresh Anchor BusinessCustomer (not Individual). Use after the
 * Individual → Business migration.
 *
 * Refuses while any of the user's savings pots holds money: a pot is a
 * reserve on the Anchor account this script detaches, so its money would be
 * left with no account behind it, and an Unbreakable pot cannot be emptied by
 * anyone before the day it opens. Empty and close every pot first.
 *
 *   $env:DATABASE_URL = "..."
 *   node scripts/reset-for-business-kyb.js seyijegede23@gmail.com
 */

const prisma = require("../src/utils/db");
const { savingsBlockingDeletion, dayWords } = require("../src/utils/savings");

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

  const businesses = await prisma.business.findMany({ where: { userId: user.id }, select: { id: true } });
  const bizIds = businesses.map((b) => b.id);

  // Checked and reset under the business locks a deposit takes, so no pot can
  // fill up between the check and the reset.
  const block = await prisma.withBusinessLock(bizIds, async () => {
    const found = await savingsBlockingDeletion(bizIds);
    if (found) return found;

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
    return null;
  });

  if (block) {
    console.error(
      `Refusing: the savings pot "${block.potName}" still holds money` +
        (block.unbreakable ? `, and it is Unbreakable until it opens on ${dayWords(block.opensOn)}` : "") +
        ". Resetting KYC would detach the bank account that money sits in. Empty and close every pot first. Nothing was changed.",
    );
    process.exitCode = 1;
    return;
  }

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
