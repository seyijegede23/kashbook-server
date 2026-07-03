/**
 * Wire Meta's WhatsApp TEST number to a business — bypasses Embedded Signup so
 * the integration can be tested end-to-end before Tech Provider approval.
 *
 * Usage:
 *   1. Add to server/.env (untracked — never paste tokens in chat):
 *        WA_TEST_TOKEN=<access token from the dashboard "Try it out" step>
 *        WA_TEST_PHONE_NUMBER_ID=<Phone Number ID>
 *        WA_TEST_WABA_ID=<WhatsApp Business Account ID>
 *        WA_TEST_BUSINESS_NAME=<exact KashBook business name, e.g. Mr J enterprise>
 *   2. cd server && node scripts/connect-wa-test.js
 *
 * Notes: dashboard test tokens expire in ~24h — regenerate + re-run when testing
 * later. Test numbers are pre-registered by Meta, so /register is skipped.
 */
require("dotenv").config();
const prisma = require("../src/utils/db");
const { encrypt } = require("../src/utils/crypto");
const wa = require("../src/utils/whatsappCloud");

(async () => {
  const token = process.env.WA_TEST_TOKEN;
  const phoneNumberId = process.env.WA_TEST_PHONE_NUMBER_ID;
  const wabaId = process.env.WA_TEST_WABA_ID;
  const bizName = process.env.WA_TEST_BUSINESS_NAME;
  for (const [k, v] of Object.entries({ WA_TEST_TOKEN: token, WA_TEST_PHONE_NUMBER_ID: phoneNumberId, WA_TEST_WABA_ID: wabaId, WA_TEST_BUSINESS_NAME: bizName })) {
    if (!v) { console.error(`Missing ${k} in server/.env`); process.exit(1); }
  }

  const business = await prisma.business.findFirst({ where: { name: bizName } });
  if (!business) { console.error(`No business named "${bizName}" found`); process.exit(1); }
  console.log(`Business: ${business.name} (${business.id})`);

  // Subscribe our app to the test WABA so inbound messages reach our webhook.
  let subscribed = false;
  try { subscribed = await wa.subscribeWaba(token, wabaId); }
  catch (e) { console.warn("subscribed_apps failed:", e.message); }
  console.log("WABA webhook subscription:", subscribed ? "OK" : "FAILED (check token)");

  let displayPhone = null;
  try { displayPhone = (await wa.getPhoneInfo(token, phoneNumberId)).displayPhoneNumber; }
  catch (e) { console.warn("phone info lookup failed:", e.message); }

  try {
    await prisma.business.update({
      where: { id: business.id },
      data: {
        waAccessToken: encrypt(token),
        wabaId,
        waPhoneNumberId: phoneNumberId,
        waPhoneNumber: displayPhone,
        waConnectionStatus: "connected",
        waWebhookSubscribed: subscribed,
      },
    });
  } catch (e) {
    if (e.code === "P2002") { console.error("That phone-number-id is already linked to another business."); process.exit(1); }
    throw e;
  }
  console.log(`✅ Test number ${displayPhone || phoneNumberId} connected to "${business.name}".`);
  console.log("Next: message the test number from a verified recipient phone — it should appear in WhatsApp Chats.");
  process.exit(0);
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
