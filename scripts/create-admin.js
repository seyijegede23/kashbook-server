require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const bcrypt = require("@node-rs/bcrypt");
const prisma = require("../src/utils/db");

async function main() {
  // Credentials come from the environment — never hardcode them in a committed
  // script. Set INITIAL_ADMIN_EMAIL / INITIAL_ADMIN_PASSWORD (e.g. as Render
  // secrets, or inline for a one-off run) before invoking this script.
  const email    = process.env.INITIAL_ADMIN_EMAIL;
  const password = process.env.INITIAL_ADMIN_PASSWORD;
  if (!email || !password) {
    throw new Error(
      "Set INITIAL_ADMIN_EMAIL and INITIAL_ADMIN_PASSWORD env vars before running create-admin.js",
    );
  }
  if (password.length < 12) {
    throw new Error("INITIAL_ADMIN_PASSWORD must be at least 12 characters");
  }

  const hashed = await bcrypt.hash(password, 12);

  const user = await prisma.user.upsert({
    where: { email },
    update: { password: hashed, role: "ADMIN" },
    create: {
      firstName:    "KashBook",
      lastName:     "Admin",
      email,
      businessName: "KashBook HQ",
      password:     hashed,
      role:         "ADMIN",
    },
  });

  console.log("✅ Admin user ready:");
  console.log("   Email:", email);
  console.log("   Role: ", user.role);
  console.log("   (password set from INITIAL_ADMIN_PASSWORD — not printed)");
}

main()
  .catch(console.error)
  .finally(() => process.exit());
