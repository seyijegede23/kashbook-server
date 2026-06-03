// Find the most recent stuck user with anchorCustomerId
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');

async function main() {
  const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL,
  });
  const prisma = new PrismaClient({ adapter });

  const users = await prisma.user.findMany({
    where: {
      anchorCustomerId: { not: null },
      NOT: {
        kycStatus: { in: ['verified', 'rejected'] },
      },
    },
    orderBy: { updatedAt: 'desc' },
    take: 5,
    select: {
      id: true,
      email: true,
      phone: true,
      firstName: true,
      lastName: true,
      anchorCustomerId: true,
      kycStatus: true,
      paystackCustomerCode: true,
      updatedAt: true,
      createdAt: true,
      businesses: {
        select: {
          id: true,
          name: true,
          virtualAccountId: true,
          virtualAccountNumber: true,
          virtualAccountBank: true,
          virtualAccountName: true,
          anchorAccountId: true,
          kycBvn: true,
          kycCacNumber: true,
          kycBusinessType: true,
          updatedAt: true,
        },
      },
    },
  });

  console.log(JSON.stringify(users, null, 2));
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
