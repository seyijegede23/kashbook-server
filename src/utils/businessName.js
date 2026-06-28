// Business-name validation helpers.
//
// - cleanBusinessName: trims + collapses internal whitespace (the value we store).
// - normalizeBusinessName: clean + lowercase (the key for per-account uniqueness).
// - isProtectedName: a reserved/blocklist guard so a merchant can't label their
//   business-named virtual NUBAN as a bank / regulator / well-known brand and
//   deceive payers. Exact (normalized) matches only — substring matching would
//   false-positive on common words (e.g. "Access Computers"). Extend freely.

function cleanBusinessName(name) {
  return String(name == null ? "" : name).trim().replace(/\s+/g, " ");
}

function normalizeBusinessName(name) {
  return cleanBusinessName(name).toLowerCase();
}

const PROTECTED_NAMES = new Set([
  // KashBook / operator
  "kashbook", "kash book", "reliant technology solutions", "reliant technology", "reliant technologies",
  // Regulators / payment infrastructure
  "cbn", "central bank of nigeria", "nibss", "ndic", "efcc", "firs",
  // Banks
  "access bank", "access bank plc", "gtbank", "gt bank", "gtco", "guaranty trust bank", "guaranty trust",
  "zenith bank", "first bank", "first bank of nigeria", "uba", "united bank for africa",
  "fidelity bank", "fcmb", "first city monument bank", "sterling bank", "stanbic ibtc",
  "stanbic ibtc bank", "union bank", "wema bank", "alat", "polaris bank", "keystone bank",
  "ecobank", "heritage bank", "providus bank", "titan trust bank", "globus bank",
  "premium trust bank", "jaiz bank", "suntrust bank", "unity bank", "citibank",
  // Fintechs / PSPs / MFBs
  "opay", "palmpay", "moniepoint", "moniepoint mfb", "kuda", "kuda bank", "paystack",
  "flutterwave", "interswitch", "carbon", "fairmoney", "paga", "anchor", "vfd",
  "vfd microfinance bank", "sparkle", "rubies", "mintyn", "vbank",
  // Major brands (common impersonation targets)
  "jumia", "konga", "mtn", "mtn nigeria", "glo", "globacom", "airtel", "9mobile", "dangote",
]);

function isProtectedName(name) {
  return PROTECTED_NAMES.has(normalizeBusinessName(name));
}

module.exports = { cleanBusinessName, normalizeBusinessName, isProtectedName, PROTECTED_NAMES };
