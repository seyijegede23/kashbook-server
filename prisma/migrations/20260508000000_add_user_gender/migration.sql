-- Add User.gender for Anchor KYC. Captured in the KYC modal alongside BVN + DOB.
ALTER TABLE "User" ADD COLUMN "gender" TEXT;
