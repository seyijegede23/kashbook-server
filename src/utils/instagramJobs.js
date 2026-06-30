/**
 * Instagram background jobs — long-lived token refresh.
 *
 * IG User tokens last 60 days and must be refreshed while still valid (token
 * must be >=24h old AND unexpired). We refresh any token within ~10 days of
 * expiry; already-expired ones can't be refreshed and are flagged for re-OAuth
 * (igConnectionStatus="expired") so the app can show a "Reconnect" CTA.
 *
 * Run from server.js under withCronLock (leader-election). See
 * docs/INSTAGRAM_API_SPEC.md §4 (token lifecycle).
 */
const prisma = require("./db");
const ig = require("./instagram");
const { encrypt, decrypt } = require("./crypto");
const { audit } = require("./audit");

const REFRESH_WINDOW_MS = 10 * 24 * 60 * 60 * 1000; // refresh when expiry < 10 days out

async function refreshExpiringTokens({ logger = console } = {}) {
  if (!ig.isConfigured()) return { refreshed: 0, expired: 0, failed: 0, candidates: 0 };

  const now = new Date();
  const soon = new Date(now.getTime() + REFRESH_WINDOW_MS);
  const businesses = await prisma.business.findMany({
    where: {
      igConnectionStatus: "connected",
      instagramAccessToken: { not: null },
      igTokenExpiresAt: { not: null, lte: soon },
    },
    select: { id: true, instagramAccessToken: true, igTokenExpiresAt: true },
  });

  let refreshed = 0, expired = 0, failed = 0;
  for (const b of businesses) {
    // Already expired → cannot refresh; needs a full re-OAuth.
    if (b.igTokenExpiresAt && new Date(b.igTokenExpiresAt) <= now) {
      await prisma.business.update({ where: { id: b.id }, data: { igConnectionStatus: "expired" } }).catch(() => {});
      expired++;
      continue;
    }
    try {
      const token = decrypt(b.instagramAccessToken);
      const result = await ig.refreshLongLivedToken(token);
      if (!result.accessToken) throw new Error("no token in refresh response");
      const expiresAt = new Date(Date.now() + (result.expiresIn || ig.SIXTY_DAYS_SEC) * 1000);
      await prisma.business.update({
        where: { id: b.id },
        data: { instagramAccessToken: encrypt(result.accessToken), igTokenExpiresAt: expiresAt },
      });
      refreshed++;
    } catch (err) {
      failed++;
      logger.error?.(`[ig-refresh] business ${b.id}: ${err.message}`);
      // An invalid/revoked token (OAuth error 190) won't recover — flag for reconnect.
      if (err.igError?.code === 190) {
        await prisma.business.update({ where: { id: b.id }, data: { igConnectionStatus: "error" } }).catch(() => {});
      }
    }
  }

  if (refreshed || expired || failed) {
    await audit({
      action: "INSTAGRAM_TOKEN_REFRESH", resourceType: "cron", severity: "info",
      metadata: { refreshed, expired, failed, candidates: businesses.length },
    }).catch(() => {});
  }
  return { refreshed, expired, failed, candidates: businesses.length };
}

module.exports = { refreshExpiringTokens };
