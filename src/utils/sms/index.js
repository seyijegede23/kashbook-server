// SMS provider router. Picks the right adapter based on the user's country
// (or an explicit override). Falls back to Africa's Talking for unknown
// countries (the platform-wide default SMS provider).
const { getCountryConfig } = require("../../config/countries");
const termii = require("./termii");
const africasTalking = require("./africas_talking");
const awsSns = require("./aws_sns");

const ADAPTERS = {
  termii,
  africas_talking: africasTalking,
  aws_sns: awsSns,
};

function pickAdapter(country) {
  const cfg = getCountryConfig(country);
  const key = cfg.smsProvider || "africas_talking";
  return ADAPTERS[key] || africasTalking;
}

async function sendSms(phone, message, { country } = {}) {
  const adapter = pickAdapter(country);
  return adapter.sendSms(phone, message);
}

module.exports = { sendSms, pickAdapter };
