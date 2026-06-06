/**
 * One-shot reconcile inbound Anchor credits with our local Transaction table.
 * Useful when you want to manually trigger a sweep — the server also runs
 * this every 2 min on its own.
 *
 * Usage:
 *   $env:DATABASE_URL = "<render postgres>"
 *   $env:ANCHOR_BASE_URL = "https://api.sandbox.getanchor.co/api/v1"
 *   $env:ANCHOR_API_KEY = "<key>"
 *   node scripts/reconcile-anchor-transactions.js
 */

const prisma = require("../src/utils/db");
const { reconcileAll } = require("../src/utils/anchorReconcile");

async function main() {
  const total = await reconcileAll({
    onCreate: ({ biz, amount, reference }) => {
      console.log(
        `  + ${biz.name} ← ₦${amount.toLocaleString("en-NG")} ref=${reference}`,
      );
    },
    logger: (msg) => console.warn(msg),
  });
  console.log(`\nInserted ${total} income transaction(s).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
