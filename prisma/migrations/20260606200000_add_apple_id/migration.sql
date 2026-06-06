-- Apple Sign-In support: stores Apple's stable user identifier (`sub`).
ALTER TABLE "User"
  ADD COLUMN "appleId" TEXT;

CREATE UNIQUE INDEX "User_appleId_key" ON "User"("appleId");
