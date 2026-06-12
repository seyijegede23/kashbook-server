-- ──────────────────────────────────────────────────────────────────────────
-- Drop Google + Apple Sign-In columns from User. Both fields are now unused
-- after the social-sign-in removal — login is password + biometric only, and
-- legacy users with neither password nor social ID recover via the existing
-- phone-OTP password-set flow.
--
-- Indexes are dropped explicitly before the columns so the migration is
-- portable across Postgres versions that don't auto-drop unique indexes
-- with their owning columns.
-- ──────────────────────────────────────────────────────────────────────────

DROP INDEX IF EXISTS "User_googleId_key";
DROP INDEX IF EXISTS "User_appleId_key";

ALTER TABLE "User" DROP COLUMN IF EXISTS "googleId";
ALTER TABLE "User" DROP COLUMN IF EXISTS "appleId";
