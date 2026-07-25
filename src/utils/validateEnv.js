// Fail-fast environment validation, run once at boot (server.js).
//
// In PRODUCTION (NODE_ENV==='production') a missing/insecure value throws so the
// process never starts in an unsafe state — better a failed deploy than a live
// fintech server that silently accepts unsigned webhooks or routes KYC to the
// wrong environment. In dev/staging these are warnings so local work isn't blocked.
//
// Note: JWT_SECRET (utils/jwt.js) and ENCRYPTION_KEY (utils/crypto.js) already
// self-validate on load, so they are not re-checked here.

function validateEnv() {
  const isProd = process.env.NODE_ENV === "production";
  const problems = [];

  // Webhook signing secrets — without these, money/subscription webhooks would
  // either fail-open (fraudulent inbound credits) or be rejected wholesale.
  if (!process.env.ANCHOR_WEBHOOK_SECRET) {
    problems.push("ANCHOR_WEBHOOK_SECRET is not set (Anchor webhook signatures cannot be verified)");
  }
  if (!process.env.REVENUECAT_WEBHOOK_AUTH) {
    problems.push("REVENUECAT_WEBHOOK_AUTH is not set (RevenueCat subscription webhooks will be rejected)");
  }

  // The webhook-verification kill switch must never be on in production.
  if (isProd && process.env.ANCHOR_VERIFY_WEBHOOK === "false") {
    problems.push("ANCHOR_VERIFY_WEBHOOK=false disables signature checks — forbidden in production");
  }

  // Anchor is the active provider (Nigeria banking + payouts + webhooks). Require
  // the API key + base URL, and in production flag a SANDBOX base URL — going live
  // against the sandbox would issue fake NUBANs and move no real money.
  // (Korapay is dormant — NG reverted to Anchor; its keys, if present, are harmless
  // and not required.)
  if (!process.env.ANCHOR_API_KEY) {
    problems.push("ANCHOR_API_KEY is not set (Anchor provisioning/payouts will fail)");
  }
  const anchorUrl = process.env.ANCHOR_BASE_URL || "";
  if (!anchorUrl) {
    problems.push("ANCHOR_BASE_URL is not set");
  } else if (isProd && anchorUrl.includes("sandbox")) {
    problems.push("ANCHOR_BASE_URL points at the SANDBOX in production — flip it to the live endpoint (https://api.getanchor.co/api/v1)");
  }

  // Dojah: a sandbox key (test_sk_*) pointed at the live endpoint (or vice-versa)
  // silently breaks KYC/KYB — flag the mismatch.
  const dojahKey = process.env.DOJAH_SECRET_KEY || "";
  const dojahUrl = process.env.DOJAH_BASE_URL || "";
  const dojahLiveUrl = dojahUrl.includes("api.dojah.io") && !dojahUrl.includes("sandbox");
  if (dojahKey.startsWith("test_sk_") && dojahLiveUrl) {
    problems.push("Dojah sandbox key (test_sk_*) is set against the LIVE base URL — fix the key/URL pair");
  }

  if (problems.length) {
    const msg = "[validateEnv] configuration problems:\n  - " + problems.join("\n  - ");
    if (isProd) {
      throw new Error(msg);
    }
    console.warn(msg + "\n[validateEnv] (warnings only outside production)");
  } else {
    console.log("[validateEnv] environment OK");
  }
}

module.exports = { validateEnv };
