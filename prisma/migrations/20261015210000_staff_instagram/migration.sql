-- Staff and Instagram (owner, 2026-10-15): "owner can give some staff the
-- permission to see ig and reply customers". A fifth staff capability, off
-- until the owner turns it on for a staff member: canUseInstagram lets that
-- person read the business's Instagram messages and reply to customers.
-- Before this, every staff member could; from now on only those granted.
ALTER TABLE "StaffPermission" ADD COLUMN IF NOT EXISTS "canUseInstagram" BOOLEAN NOT NULL DEFAULT false;
