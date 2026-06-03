/**
 * One-shot reconciliation script: for a given user (by email), pull their
 * Anchor deposit accounts and backfill the matching Business row with the
 * NUBAN if it's currently null.
 *
 * Use when a webhook (e.g. accountNumber.created) was missed and the user
 * is stuck on "Verifying" even though Anchor opened the account.
 *
 * Usage:
 *   $env:DATABASE_URL = "..."
 *   $env:ANCHOR_BASE_URL = "https://api.sandbox.getanchor.co/api/v1"
 *   $env:ANCHOR_API_KEY = "..."
 *   cd c:\bookeepingapp\server
 *   node scripts/sync-stuck-anchor.js seyijegede23@gmail.com
 */

const prisma = require("../src/utils/db");
const anchor = require("../src/utils/anchor");

async function main() {
  const email = process.argv[2];
  if (!email) {
    console.error("Usage: node scripts/sync-stuck-anchor.js <user-email>");
    process.exit(1);
  }

  const user = await prisma.user.findFirst({ where: { email } });
  if (!user) {
    console.error(`No user with email ${email}`);
    process.exit(1);
  }
  if (!user.anchorCustomerId) {
    console.error(`User has no anchorCustomerId — they haven't started KYC yet.`);
    process.exit(1);
  }

  console.log(`Found user ${user.id} with anchorCustomerId ${user.anchorCustomerId}`);

  const accounts = await anchor.listCustomerAccounts(user.anchorCustomerId);
  console.log(`Anchor returned ${accounts.length} account(s):`);
  console.log(JSON.stringify(accounts, null, 2));

  if (!accounts.length) {
    console.error("No deposit accounts found on Anchor — KYC may not have completed.");
    process.exit(1);
  }

  const businesses = await prisma.business.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "asc" },
  });
  console.log(`User has ${businesses.length} business(es) locally.`);

  // Pair the FIRST business missing a NUBAN with the FIRST account from Anchor
  const stuckBiz = businesses.find((b) => !b.virtualAccountNumber);
  if (!stuckBiz) {
    console.log("All businesses already have a NUBAN — nothing to sync.");
    process.exit(0);
  }

  const acc = accounts[0];
  const attrs = acc.attributes || {};
  console.log(
    `Syncing business "${stuckBiz.name}" (${stuckBiz.id}) with account ${acc.id} (NUBAN ${attrs.accountNumber})`,
  );

  await prisma.business.update({
    where: { id: stuckBiz.id },
    data: {
      anchorAccountId: acc.id,
      virtualAccountId: acc.id,
      virtualAccountRef: acc.id,
      virtualAccountNumber: attrs.accountNumber || null,
      virtualAccountBank: attrs.bank?.name || "Anchor",
      virtualAccountName: attrs.accountName || stuckBiz.name,
    },
  });

  console.log("✅ Done. Reload the app — the Bank Account screen should show the NUBAN.");
}

main()
  .catch((err) => {
    console.error("Script failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
