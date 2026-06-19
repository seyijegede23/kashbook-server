require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const bcrypt = require("@node-rs/bcrypt");
const prisma = require("../src/utils/db");

async function main() {
  const email    = "admin@kashbook.com";
  const password = "KashBook@Admin2026";

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
  console.log("   Email:   ", email);
  console.log("   Password:", password);
  console.log("   Role:    ", user.role);
}

main()
  .catch(console.error)
  .finally(() => process.exit());
