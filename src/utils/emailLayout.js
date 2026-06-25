// KashBook transactional-email layout system.
//
// One shared, email-client-hardened wrapper (table-based, inline styles, MSO
// ghost tables, hidden preheader, dark-mode + Outlook.com [data-ogsc] handling)
// used by BOTH the OTP email (utils/otp.js) and the debit/credit alerts
// (utils/transactionEmail.js). Design = judge-panel winner ("Hairline"),
// compatibility-verified across Outlook/Gmail/Apple Mail/Yahoo/mobile.
//
// Header logo: hosted brand image via EMAIL_LOGO_URL, else
// ${PUBLIC_BASE_URL}/email-logo.png (served from server/public/), else a
// CSS-drawn fallback mark. Contacts: support@relianttechnology.com.ng.
//
// Generated from the verified HTML — edit via the design source, not by hand.
// Tokens are filled with split/join (a money value with '$' is safe); all
// user/merchant values are HTML-escaped; accents validated to 6-digit hex.

const LAYOUT = "<!DOCTYPE html>\n<html lang=\"en\" xmlns=\"http://www.w3.org/1999/xhtml\" xmlns:v=\"urn:schemas-microsoft-com:vml\" xmlns:o=\"urn:schemas-microsoft-com:office:office\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<meta http-equiv=\"X-UA-Compatible\" content=\"IE=edge\">\n<meta name=\"x-apple-disable-message-reformatting\">\n<meta name=\"color-scheme\" content=\"light dark\">\n<meta name=\"supported-color-schemes\" content=\"light dark\">\n<title>KashBook</title>\n<!--[if mso]>\n<noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch><o:AllowPNG/></o:OfficeDocumentSettings></xml></noscript>\n<![endif]-->\n<style type=\"text/css\">\n  /* Layout NEVER depends on this block - progressive enhancement only (Outlook resets + mobile + dark mode). */\n  body,table,td,a{ -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%; }\n  table,td{ mso-table-lspace:0pt; mso-table-rspace:0pt; }\n  img{ -ms-interpolation-mode:bicubic; border:0; outline:none; text-decoration:none; }\n  a[x-apple-data-detectors]{ color:inherit !important; text-decoration:none !important; font-size:inherit !important; font-family:inherit !important; font-weight:inherit !important; line-height:inherit !important; }\n  body{ margin:0 !important; padding:0 !important; width:100% !important; }\n  a{ text-decoration:none; }\n  .kb-link{ color:#2563EB; }\n  .kb-link:hover{ text-decoration:underline !important; }\n  @media only screen and (max-width:600px){\n    .kb-container{ width:100% !important; }\n    .kb-pad{ padding-left:24px !important; padding-right:24px !important; }\n    .kb-code{ font-size:34px !important; letter-spacing:8px !important; }\n    .kb-amount{ font-size:30px !important; }\n    .kb-rowlabel{ white-space:normal !important; }\n  }\n  @media (prefers-color-scheme:dark){\n    body,.kb-bg{ background:#0b0e14 !important; }\n    .kb-card{ background:#15181f !important; }\n    .kb-card-border{ border-color:#262b36 !important; }\n    .kb-ink{ color:#f4f6f9 !important; }\n    .kb-sub{ color:#aeb4c0 !important; }\n    .kb-faint{ color:#8b93a1 !important; }\n    .kb-hair{ border-color:#262b36 !important; }\n    .kb-rowlabel{ color:#aeb4c0 !important; }\n    .kb-rowvalue{ color:#f4f6f9 !important; }\n    .kb-wordmark{ color:#ffffff !important; }\n    .kb-wordmark-accent{ color:#5B8DEF !important; }\n    .kb-glyph{ background:#2563EB !important; color:#ffffff !important; }\n    .kb-strong{ color:#f4f6f9 !important; }\n    .kb-amount{ color:{{ACCENT_DARK}} !important; }\n    .kb-code{ color:#F8FAFF !important; }\n    .kb-eyebrow{ color:#DBE6FF !important; }\n  }\n  /* Outlook.com dark-mode ([data-ogsc]) overrides: pin the brand chip text + accents so smart-invert can't muddy them. */\n  [data-ogsc] body, [data-ogsc] .kb-bg{ background:#0b0e14 !important; }\n  [data-ogsc] .kb-card{ background:#15181f !important; }\n  [data-ogsc] .kb-card-border{ border-color:#262b36 !important; }\n  [data-ogsc] .kb-ink{ color:#f4f6f9 !important; }\n  [data-ogsc] .kb-sub{ color:#aeb4c0 !important; }\n  [data-ogsc] .kb-faint{ color:#8b93a1 !important; }\n  [data-ogsc] .kb-hair{ border-color:#262b36 !important; }\n  [data-ogsc] .kb-rowlabel{ color:#aeb4c0 !important; }\n  [data-ogsc] .kb-rowvalue{ color:#f4f6f9 !important; }\n  [data-ogsc] .kb-wordmark{ color:#ffffff !important; }\n  [data-ogsc] .kb-wordmark-accent{ color:#5B8DEF !important; }\n  [data-ogsc] .kb-glyph{ background:#2563EB !important; color:#ffffff !important; }\n  [data-ogsc] .kb-strong{ color:#f4f6f9 !important; }\n  [data-ogsc] .kb-amount{ color:{{ACCENT_DARK}} !important; }\n  [data-ogsc] .kb-code{ color:#F8FAFF !important; }\n  [data-ogsc] .kb-eyebrow{ color:#DBE6FF !important; }\n</style>\n</head>\n<body class=\"kb-bg\" style=\"margin:0;padding:0;width:100%;background:#F4F6F9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;mso-line-height-rule:exactly;\" bgcolor=\"#F4F6F9\">\n\n<div style=\"display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#F4F6F9;opacity:0;\">{{PREHEADER}}&#847;&#847;&#847;&#847;&#847;&#847;&#847;&#847;&#847;&#847;&#847;&#847;&#847;&#847;&#847;&#847;&#847;&#847;&#847;&#847;&#847;&#847;&#847;&#847;&#847;&#847;&#847;&#847;&#847;&#847;&#847;&#847;&#847;&#847;&#847;&#847;</div>\n\n<table role=\"presentation\" class=\"kb-bg\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" style=\"background:#F4F6F9;\" bgcolor=\"#F4F6F9\">\n<tr>\n<td align=\"center\" style=\"padding:32px 12px;\">\n\n<!--[if mso]><table role=\"presentation\" align=\"center\" width=\"600\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\"><tr><td><![endif]-->\n<table role=\"presentation\" class=\"kb-container\" width=\"600\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" style=\"width:600px;max-width:600px;margin:0 auto;\">\n\n<tr>\n<td class=\"kb-pad\" align=\"left\" style=\"padding:4px 8px 18px 8px;\">\n<table role=\"presentation\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" align=\"left\"><tr>\n{{LOGO}}\n<td width=\"10\" style=\"width:10px;\">&nbsp;</td>\n<td valign=\"middle\" class=\"kb-wordmark\" style=\"font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:19px;font-weight:700;letter-spacing:-0.3px;color:#18181B;\">Kash<span class=\"kb-wordmark-accent\" style=\"color:#2563EB;\">Book</span></td>\n</tr></table>\n</td>\n</tr>\n\n<tr>\n<td>\n<table role=\"presentation\" class=\"kb-card kb-card-border\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" style=\"background:#FFFFFF;border:1px solid #E8ECF0;border-radius:14px;\" bgcolor=\"#FFFFFF\">\n<tr>\n<td class=\"kb-pad\" style=\"padding:40px 44px;\">\n{{CONTENT}}\n</td>\n</tr>\n</table>\n</td>\n</tr>\n\n<tr>\n<td class=\"kb-pad\" style=\"padding:26px 20px 8px 20px;\">\n<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\">\n<tr><td class=\"kb-hair\" style=\"border-top:1px solid #E8ECF0;font-size:0;line-height:0;height:1px;\">&nbsp;</td></tr>\n<tr><td style=\"padding:18px 0 0 0;\">\n<p class=\"kb-ink\" style=\"margin:0 0 8px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;font-weight:600;color:#18181B;\">KashBook <span class=\"kb-sub\" style=\"color:#71717A;font-weight:400;\">by Reliant Technology Solutions</span></p>\n<p class=\"kb-sub\" style=\"margin:0 0 14px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.6;color:#71717A;\"><strong class=\"kb-strong\" style=\"color:#18181B;font-weight:600;\">Security:</strong> KashBook will never ask for your password, verification code, PIN or full card number by email, SMS or phone. Always check the sender ends in <span style=\"white-space:nowrap;\">&#64;relianttechnology.com.ng</span>. If a message asks for these, do not respond &mdash; report it to <a href=\"mailto:support@relianttechnology.com.ng\" class=\"kb-link\" style=\"color:#2563EB;\">support@relianttechnology.com.ng</a>.</p>\n<p class=\"kb-sub\" style=\"margin:0 0 14px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;line-height:1.6;color:#71717A;\">You received this email because it relates to security or activity on your KashBook account. These are service messages and can&#39;t be unsubscribed from. Need help? Contact <a href=\"mailto:support@relianttechnology.com.ng\" class=\"kb-link\" style=\"color:#2563EB;\">support@relianttechnology.com.ng</a>.</p>\n<p class=\"kb-faint\" style=\"margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:12px;line-height:1.6;color:#A1A1AA;\">&copy; {{YEAR}} Reliant Technology Solutions. All rights reserved. &middot; kashbook.app</p>\n</td></tr>\n</table>\n</td>\n</tr>\n\n</table>\n<!--[if mso]></td></tr></table><![endif]-->\n\n</td>\n</tr>\n</table>\n</body>\n</html>";

const OTP_CONTENT = "<h1 class=\"kb-ink\" style=\"margin:0 0 14px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:21px;font-weight:700;letter-spacing:-0.2px;color:#18181B;line-height:1.3;\">Confirm it&rsquo;s you</h1>\n<p class=\"kb-sub\" style=\"margin:0 0 26px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.65;color:#71717A;\">Use the verification code below to continue signing in to your KashBook account. Enter it on the screen where you requested it.</p>\n\n<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" style=\"margin:0 0 26px 0;\">\n<tr>\n<td align=\"center\" bgcolor=\"#2563EB\" style=\"background:#2563EB;border-radius:12px;padding:22px 16px 24px 16px;\">\n<div class=\"kb-eyebrow\" style=\"font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#DBE6FF;line-height:1;padding-bottom:12px;\">Verification code</div>\n<div class=\"kb-code\" style=\"font-family:'SFMono-Regular',ui-monospace,'SF Mono',Menlo,Consolas,'Liberation Mono','Courier New',monospace;font-size:40px;font-weight:700;letter-spacing:10px;color:#F8FAFF;line-height:1.1;mso-line-height-rule:exactly;overflow:hidden;white-space:nowrap;padding-left:10px;\">{{CODE}}</div>\n</td>\n</tr>\n</table>\n\n<p class=\"kb-sub\" style=\"margin:0 0 6px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.65;color:#71717A;\">This code expires in <strong class=\"kb-ink\" style=\"color:#18181B;font-weight:600;\">10 minutes</strong> and can be used once.</p>\n<p class=\"kb-sub\" style=\"margin:0 0 18px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.65;color:#71717A;\">Didn&rsquo;t try to sign in? You can safely ignore this email &mdash; your account stays secure as long as you don&rsquo;t share this code.</p>\n\n<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\">\n<tr><td class=\"kb-hair\" style=\"border-top:1px solid #E8ECF0;font-size:0;line-height:0;height:1px;\">&nbsp;</td></tr>\n<tr><td style=\"padding:16px 0 0 0;\">\n<p class=\"kb-faint\" style=\"margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;line-height:1.6;color:#A1A1AA;\">KashBook staff will never ask you for this code. If someone does &mdash; by phone, SMS or email &mdash; it&rsquo;s a scam. Report it to <a href=\"mailto:support@relianttechnology.com.ng\" class=\"kb-link\" style=\"color:#2563EB;\">support@relianttechnology.com.ng</a>.</p>\n</td></tr>\n</table>";

const TXN_CONTENT = "\n<p class=\"kb-sub\" style=\"margin:0 0 6px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;font-weight:600;color:#71717A;text-transform:uppercase;letter-spacing:0.6px;\">{{HEADING}}</p>\n<p class=\"kb-amount\" style=\"margin:0 0 26px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:34px;font-weight:800;letter-spacing:-0.5px;color:#18181B;line-height:1.1;\"><span style=\"color:{{ACCENT}};\">{{AMOUNT_SIGNED}}</span></p>\n\n<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\">\n{{ROWS}}\n</table>\n\n<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" style=\"margin:22px 0 0 0;\">\n<tr><td>\n<p class=\"kb-faint\" style=\"margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;line-height:1.6;color:#A1A1AA;\">This is an automated alert for activity on your KashBook account. <strong class=\"kb-strong\" style=\"color:#18181B;font-weight:600;\">Didn&rsquo;t make this transaction?</strong> Contact us right away at <a href=\"mailto:support@relianttechnology.com.ng\" class=\"kb-link\" style=\"color:#2563EB;\">support@relianttechnology.com.ng</a> so we can help secure your account.</p>\n</td></tr>\n</table>";

const ROW = "<tr>\n<td class=\"kb-rowlabel kb-hair\" valign=\"top\" style=\"padding:13px 16px 13px 0;border-bottom:1px solid #E8ECF0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#71717A;white-space:nowrap;\">{{LABEL}}</td>\n<td class=\"kb-rowvalue kb-hair\" valign=\"top\" align=\"right\" style=\"padding:13px 0 13px 16px;border-bottom:1px solid #E8ECF0;font-family:'SFMono-Regular',ui-monospace,'SF Mono',Menlo,Consolas,'Liberation Mono','Courier New',monospace;font-size:14px;line-height:1.5;font-weight:600;color:#18181B;text-align:right;word-break:break-word;\">{{VALUE}}</td>\n</tr>";

// HTML-entity-escape a value before it goes into markup.
function escHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Accept only a 6-digit hex colour; otherwise fall back to safe dark ink so a
// dropped/invalid accent never renders transparent or inherited.
function safeHex(v, fallback) {
  return /^#[0-9a-fA-F]{6}$/.test(String(v || "")) ? v : (fallback || "#18181B");
}

// Replace {{TOKENS}} via split/join (immune to '$' in replacement values).
function fill(tpl, map) {
  let out = tpl;
  for (const k of Object.keys(map)) out = out.split(k).join(map[k]);
  return out;
}

function trimSlash(s) {
  return s && s.charAt(s.length - 1) === "/" ? s.slice(0, -1) : s;
}

// Header logo cell: a hosted brand <img> when EMAIL_LOGO_URL or PUBLIC_BASE_URL
// is configured (served from server/public/email-logo.png), else the CSS-drawn
// fallback mark so the header is never empty. Read per-render so setting the env
// takes effect without re-generating the templates.
function logoCell() {
  const base = process.env.PUBLIC_BASE_URL ? trimSlash(process.env.PUBLIC_BASE_URL) + "/email-logo.png" : "";
  const url = process.env.EMAIL_LOGO_URL || base;
  if (url) {
    return '<td valign="middle" style="padding:0;line-height:0;"><img src="' + url + '" width="36" height="36" alt="KashBook" style="display:block;border:0;outline:none;text-decoration:none;border-radius:8px;"></td>';
  }
  return '<td align="center" valign="middle" width="34" height="34" bgcolor="#2563EB" style="width:34px;height:34px;background:#2563EB;border-radius:9px;color:#ffffff;font-family:Georgia,serif;font-size:18px;font-weight:700;line-height:34px;text-align:center;">&#8358;</td>';
}

// Wrap inner content in the shared chrome (logo header + card + footer).
function renderEmail(opts) {
  const o = opts || {};
  return fill(LAYOUT, {
    "{{LOGO}}": logoCell(),
    "{{PREHEADER}}": escHtml(o.preheader || ""),
    "{{CONTENT}}": o.content || "",
    "{{YEAR}}": String(o.year || new Date().getFullYear()),
    "{{ACCENT_DARK}}": safeHex(o.accentDark),
  });
}

// Verification-code (OTP) email.
function renderOtpEmail(code) {
  const content = fill(OTP_CONTENT, { "{{CODE}}": escHtml(code) });
  return renderEmail({
    preheader: "Your KashBook verification code is " + code + " - it expires in 10 minutes.",
    content: content,
  });
}

// One detail row for the transaction email.
function txnRow(label, value) {
  return fill(ROW, { "{{LABEL}}": escHtml(label), "{{VALUE}}": escHtml(value) });
}

// Debit/credit transaction alert. rowsHtml is concatenated txnRow() output;
// accent/accentDark are the light/dark amount colours (credit green / debit red).
function renderTxnEmail(opts) {
  const o = opts || {};
  const content = fill(TXN_CONTENT, {
    "{{HEADING}}": escHtml(o.heading),
    "{{AMOUNT_SIGNED}}": escHtml(o.amountSigned),
    "{{ACCENT}}": safeHex(o.accent),
    "{{ROWS}}": o.rowsHtml || "",
  });
  return renderEmail({
    preheader: o.preheader || (o.heading + ": " + o.amountSigned),
    content: content,
    accentDark: safeHex(o.accentDark),
  });
}

module.exports = { renderEmail, renderOtpEmail, renderTxnEmail, txnRow, escHtml, safeHex };
