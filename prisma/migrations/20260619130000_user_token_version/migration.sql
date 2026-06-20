-- Session-revocation counter. JWTs carry this value; authMiddleware rejects a
-- token whose tokenVersion no longer matches the user's (password change / logout-all).
ALTER TABLE "User" ADD COLUMN "tokenVersion" INTEGER NOT NULL DEFAULT 0;
