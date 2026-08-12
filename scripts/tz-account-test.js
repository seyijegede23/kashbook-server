// Create a Tanzanian merchant in KashBook and provision its TZS local account
// through the REAL app path (services/virtualAccountProvisioning), not a
// hand-rolled provider call.
//
//   node -r dotenv/config scripts/tz-account-test.js            create + provision
//   node -r dotenv/config scripts/tz-account-test.js --cleanup  remove the test rows
//
// ⚠ READ THIS FIRST
//   * It writes to whatever DATABASE_URL points at, which is the LIVE database.
//     Rows are named "[TEST]" and --cleanup removes them.
//   * FINCRA_BASE_URL here is SANDBOX, so the issued account number is a sandbox
//     one living in the production DB. That is fine for a test but must not be
//     mistaken for a real account, hence the loud naming and the cleanup path.
//   * Business.country derives from the OWNER's country (a rule added so a
//     second business cannot silently default to NG), so a TZS business needs a
//     TZ user. That is why this creates a user rather than reusing one.

require("dotenv").config();

const prisma = require("../src/utils/db");
const { getCountryConfig } = require("../src/config/countries");
const { executeVirtualAccountProvisioning } = require("../src/services/virtualAccountProvisioning");

const TAG = "[TEST-TZ]";
const EMAIL = "test.tz@kashbook.invalid"; // .invalid is reserved: never routable
const PHONE = "+255780000001";

async function cleanup() {
  const users = await prisma.user.findMany({ where: { email: EMAIL }, select: { id: true } });
  if (!users.length) return console.log("nothing to clean up");
  for (const u of users) {
    const biz = await prisma.business.findMany({ where: { userId: u.id }, select: { id: true, name: true, virtualAccountNumber: true } });
    for (const b of biz) console.log(`  removing business ${b.name} (${b.virtualAccountNumber || "no account"})`);
    await prisma.business.deleteMany({ where: { userId: u.id } });
    await prisma.user.delete({ where: { id: u.id } });
    console.log(`  removed user ${u.id}`);
  }
  console.log("✔ cleanup complete");
}

async function main() {
  const base = process.env.FINCRA_BASE_URL || "";
  console.log(`fincra env : ${base} ${/sandbox/i.test(base) ? "(SANDBOX)" : "⚠ LIVE"}`);
  console.log(`database   : ${String(process.env.DATABASE_URL || "").split("@")[1] || "?"}\n`);

  const existing = await prisma.user.findFirst({ where: { email: EMAIL } });
  if (existing) {
    console.log("A test TZ user already exists. Run with --cleanup first to start fresh.");
    const biz = await prisma.business.findFirst({ where: { userId: existing.id } });
    if (biz) console.log(`  business: ${biz.name} | ${biz.country}/${biz.baseCurrency} | account ${biz.virtualAccountNumber || "(none)"}`);
    return;
  }

  const cfg = getCountryConfig("TZ");
  console.log(`country cfg: ${cfg.name} → ${cfg.currency.code} (${cfg.currency.symbol}), provider ${cfg.paymentProvider}\n`);

  // 1. The merchant. Country drives currency; both are locked at creation.
  const user = await prisma.user.create({
    data: {
      firstName: "Neema", lastName: "Juma",
      email: EMAIL, phone: PHONE,
      password: "x".repeat(60),           // unusable hash: this account cannot be logged into
      country: "TZ",
      currency: cfg.currency.code,
      language: cfg.language || "en",
    },
  });
  console.log(`✔ user      ${user.firstName} ${user.lastName} · ${user.country}/${user.currency}`);

  // 2. The business, inheriting country + currency from the owner.
  const biz = await prisma.business.create({
    data: {
      userId: user.id,
      name: `${TAG} Neema Trading`,
      country: user.country,
      baseCurrency: cfg.currency.code,
      emoji: "🇹🇿",
      color: "#6C3FC5",
    },
  });
  console.log(`✔ business  ${biz.name} · ${biz.country}/${biz.baseCurrency}`);

  // 3. Provision through the SAME service the API route calls.
  console.log(`\nprovisioning via ${cfg.paymentProvider}…`);
  const res = await executeVirtualAccountProvisioning({
    biz,
    user,
    body: {},                    // TZS needs no BVN: buildLocalKyc sends name only
    req: { user: { id: user.id, accountType: "owner" } },
  });

  console.log(`\nHTTP ${res.httpStatus}`);
  console.log(JSON.stringify(res.body, null, 2));

  const after = await prisma.business.findUnique({ where: { id: biz.id } });
  console.log("\n─── stored on the business ─────────────────────");
  console.log(`  accountNumber   : ${after.virtualAccountNumber || "(none)"}`);
  console.log(`  bank            : ${after.virtualAccountBank || "(none)"}`);
  console.log(`  accountName     : ${after.virtualAccountName || "(none)"}`);
  console.log(`  providerAccountId: ${after.providerAccountId || "(none)"}`);
  console.log(`  localAccountStatus: ${after.localAccountStatus || "(none)"}`);
  console.log(`  currency        : ${after.baseCurrency}`);

  console.log(after.virtualAccountNumber
    ? `\n✔ TZS ACCOUNT LIVE IN THE APP — ${after.virtualAccountNumber} at ${after.virtualAccountBank}`
    : `\n⚠ no account number stored — see the response above`);
  console.log(`\nremove with: node -r dotenv/config scripts/tz-account-test.js --cleanup`);
}

(process.argv.includes("--cleanup") ? cleanup() : main())
  .catch((e) => { console.error("\n✖", e.message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect?.());
