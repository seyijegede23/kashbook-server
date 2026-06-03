-- AlterTable
ALTER TABLE "BusinessDebt" ADD COLUMN     "note" TEXT;

-- AlterTable
ALTER TABLE "Reminder" ADD COLUMN     "message" TEXT,
ADD COLUMN     "phone" TEXT,
ALTER COLUMN "targetId" DROP NOT NULL,
ALTER COLUMN "amount" SET DEFAULT 0,
ALTER COLUMN "recipientName" SET DEFAULT '';
