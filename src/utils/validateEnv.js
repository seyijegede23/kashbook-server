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

  // Korapay is the active provider (banking + payouts + webhooks). Its secret key
  // is BOTH the API bearer AND the webhook HMAC secret, so a missing/sandbox key
  // breaks provisioning, payouts, and inbound-credit verification.
  const korapayKey = process.env.KORAPAY_SECRET_KEY || "";
  if (!korapayKey) {
    problems.push("KORAPAY_SECRET_KEY is not set (Korapay provisioning/payouts/webhooks all fail)");
  } else if (isProd && korapayKey.startsWith("sk_test_")) {
    problems.push("KORAPAY_SECRET_KEY is a sandbox key (sk_test_*) in production — no real money moves");
  }
  if (isProd && process.env.KORAPAY_VERIFY_WEBHOOK === "false") {
    problems.push("KORAPAY_VERIFY_WEBHOOK=false disables signature checks — forbidden in production");
  }
  // The NGN virtual-account sponsor bank. "000" is Korapay's SANDBOX test bank; a
  // prod deploy that forgets to set a live sponsor code would silently issue every
  // merchant a test-bank NUBAN that can't receive real money.
  if (isProd && (!process.env.KORAPAY_VBA_BANK_CODE || process.env.KORAPAY_VBA_BANK_CODE === "000")) {
    problems.push("KORAPAY_VBA_BANK_CODE is unset or the sandbox test bank (000) in production — accounts would be issued on the test bank");
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
