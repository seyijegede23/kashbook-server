// SMS provider router. Picks the right adapter based on the user's country
// (or an explicit override). Falls back to Africa's Talking for unknown
// countries (the platform-wide default SMS provider).
const { getCountryConfig } = require("../../config/countries");
const termii = require("./termii");
const africasTalking = require("./africas_talking");
const awsSns = require("./aws_sns");
const sendchamp = require("./sendchamp");

const ADAPTERS = {
  termii,
  africas_talking: africasTalking,
  aws_sns: awsSns,
  sendchamp,
};

function pickAdapter(country) {
  const cfg = getCountryConfig(country);
  const key = cfg.smsProvider || "africas_talking";
  return ADAPTERS[key] || africasTalking;
}

async function sendSms(phone, message, { country, ...opts } = {}) {
  const adapter = pickAdapter(country);
  // opts (e.g. otpCode) lets adapters pick richer channels — Sendchamp uses it
  // to deliver OTPs over WhatsApp before falling back to SMS.
  return adapter.sendSms(phone, message, opts);
}

module.exports = { sendSms, pickAdapter };
