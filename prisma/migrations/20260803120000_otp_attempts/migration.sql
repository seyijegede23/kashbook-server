-- OTP brute-force protection: per-code failed-attempt counter.
-- ADDITIVE ONLY (shared DB — see project-ledger-hardening): a new column with a
-- default is backward-compatible with the sibling app running older code.
ALTER TABLE "OtpCode" ADD COLUMN IF NOT EXISTS "attempts" INTEGER NOT NULL DEFAULT 0;
