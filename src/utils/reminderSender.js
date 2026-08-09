// Delivery for scheduled customer reminders.
//
// Mirrors how OTPs go out (utils/sms/sendchamp.js): try WhatsApp first, fall
// back to SMS. WhatsApp is preferred for the same reasons it is for OTP — it
// sidesteps the Nigerian DND filter and sender-ID registration that silently
// drop SMS from unregistered senders, and it is cheaper per message.
//
// WHY A TEMPLATE, NOT FREE TEXT
//   A debt reminder is a business-INITIATED message to someone who has not
//   messaged us, so WhatsApp requires a pre-approved template. Only the
//   variables change per send; the wording is fixed by whatever was approved on
//   the Sendchamp dashboard. The free-text `reminder.message` is still used
//   verbatim for the SMS fallback, so the two channels stay close but are not
//   required to be identical.
//
// REQUIRED ENV (WhatsApp is skipped, not failed, when absent)
//   SENDCHAMP_WA_SENDER              approved WhatsApp sender number
//   SENDCHAMP_WA_REMINDER_TEMPLATE   template_code from the dashboard
//
// The template must take exactly three body variables, in this order:
//   {{1}} customer name   {{2}} amount with currency   {{3}} business name
// e.g. "Hi {{1}}, this is a reminder about your outstanding balance of {{2}}
//       with {{3}}. Please let us know when you can settle this. Thank you!"

const { sendSms } = require("./sms");
const { sendWhatsAppTemplate } = require("./sms/sendchamp");
const { getCountryConfig } = require("../config/countries");

const REMINDER_TEMPLATE = () => process.env.SENDCHAMP_WA_REMINDER_TEMPLATE;

// Format the amount the way the message reads best. The reminder row stores a
// plain Float, and the template variable is a display string. Currency comes
// from the business's country config — Business has no currency column.
function formatAmount(amount, country = "NG") {
  const cfg = getCountryConfig(country || "NG");
  const { code = "NGN", locale = "en-NG" } = cfg.currency || {};
  const n = Number(amount) || 0;
  return `${code} ${n.toLocaleString(locale, { maximumFractionDigits: 2 })}`;
}

/**
 * Deliver one reminder.
 *
 * @param {object} reminder  Reminder row (needs phone, message, recipientName, amount)
 * @param {object} opts
 * @param {string} opts.businessName  used as template variable {{3}}
 * @param {string} opts.country       drives currency formatting, defaults NG
 * @returns {Promise<{ channel: "whatsapp"|"sms", reference?: string }>}
 * @throws if BOTH channels fail — the caller marks the reminder failed.
 */
async function sendReminder(reminder, { businessName = "", country = "NG" } = {}) {
  if (!reminder.phone) throw new Error("reminder has no phone number");

  // 1. WhatsApp template.
  const templateCode = REMINDER_TEMPLATE();
  if (templateCode) {
    const wa = await sendWhatsAppTemplate(reminder.phone, templateCode, [
      reminder.recipientName || "there",
      formatAmount(reminder.amount, country),
      businessName || "your supplier",
    ]);
    if (wa.ok) return { channel: "whatsapp", reference: wa.reference };
    // Not configured is a normal state (template not approved yet), so it is a
    // quiet fall-through rather than a warning per reminder.
    if (wa.error !== "NOT_CONFIGURED") {
      console.warn(`[reminder] WhatsApp failed (${wa.error}), falling back to SMS`);
    }
  }

  // 2. SMS fallback — unchanged behaviour, still the safety net.
  await sendSms(reminder.phone, reminder.message || "KashBook reminder.");
  return { channel: "sms" };
}

module.exports = { sendReminder, formatAmount };
