// Email validation and normalisation, shared by every route that accepts one.
//
// ASCII-only, ON PURPOSE. RFC 6531 allows internationalised addresses, but in
// practice they bounce: the SMTP relay every KashBook mail goes through does not
// negotiate SMTPUTF8, and neither do most of the providers our merchants use.
// Accepting an address we cannot deliver to is worse than rejecting it, because
// receipts, invoices, OTPs and password resets all go by email. This is also
// what rejects emoji, which is how the gap was noticed: the old checks were
// `includes("@")` or /\S+@\S+\.\S+/, and an emoji is not whitespace, so
// 😀@😀.😀 registered as an email address and /send-otp tried to mail it.
//
// The mobile app carries a textually identical copy in src/utils/validators.js
// so the two sides cannot disagree about what a valid address is; a server test
// (scripts/email-validation-test.js) asserts they match. Change both or neither.
//
// Shape enforced:
//   local   letters/digits and . _ % + -   no leading, trailing or doubled dot
//   domain  one or more labels, each 1–63 chars, letters/digits/hyphen, no
//           leading/trailing hyphen, then a TLD of 2+ letters
//   length  ≤ 254 overall, local part ≤ 64 (RFC 5321 limits)
const EMAIL_RE = /^[a-z0-9_%+-]+(?:\.[a-z0-9_%+-]+)*@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

function isValidEmail(value) {
  const s = String(value ?? "").trim();
  if (!s || s.length > 254) return false;
  const at = s.lastIndexOf("@");
  if (at < 1 || at > 64) return false;
  return EMAIL_RE.test(s);
}

// Trimmed + lower-cased, or null when it is not a valid address. Callers that
// need to tell "absent" from "invalid" check the raw input first.
function normalizeEmail(value) {
  const s = String(value ?? "").trim().toLowerCase();
  return isValidEmail(s) ? s : null;
}

module.exports = { isValidEmail, normalizeEmail, EMAIL_RE };
