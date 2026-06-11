// Pure helpers used by kycCheck.js for Phase A sanity checks and Phase C
// name-match logic. No external dependencies, no I/O — easy to unit-test
// in isolation.

// Nigerian states + FCT. Kept here as a server-side source of truth so we
// don't have to import from the client bundle. Matches src/data/nigerianStates.js.
const NG_STATES = new Set([
  "Abia", "Adamawa", "Akwa Ibom", "Anambra", "Bauchi", "Bayelsa",
  "Benue", "Borno", "Cross River", "Delta", "Ebonyi", "Edo",
  "Ekiti", "Enugu", "FCT", "Gombe", "Imo", "Jigawa",
  "Kaduna", "Kano", "Katsina", "Kebbi", "Kogi", "Kwara",
  "Lagos", "Nasarawa", "Niger", "Ogun", "Ondo", "Osun",
  "Oyo", "Plateau", "Rivers", "Sokoto", "Taraba", "Yobe",
  "Zamfara",
]);

// Common business-name noise that shouldn't influence a fuzzy compare. Stripped
// during normalisation so "Muna Collective Ltd" matches "Muna Collective".
const BIZ_SUFFIXES = [
  "ltd", "limited", "plc", "inc", "incorporated", "corp", "corporation",
  "llc", "co", "company", "enterprise", "enterprises", "ventures",
  "global", "services", "nigeria", "nig",
];

// ── String normalisation ──────────────────────────────────────────────────────

function normaliseName(s) {
  if (!s) return "";
  return String(s)
    .toLowerCase()
    .normalize("NFKD")             // strip accents (Adéolá → Adeola)
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")  // punctuation → space
    .replace(/\s+/g, " ")
    .trim();
}

function stripBusinessSuffixes(name) {
  if (!name) return "";
  // Repeatedly peel off trailing suffix tokens so "ABC Ventures Ltd" → "ABC".
  let tokens = normaliseName(name).split(" ");
  while (tokens.length > 1 && BIZ_SUFFIXES.includes(tokens[tokens.length - 1])) {
    tokens = tokens.slice(0, -1);
  }
  return tokens.join(" ");
}

// ── Levenshtein distance ──────────────────────────────────────────────────────

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;
  // Two-row DP. O(min(a,b)) memory.
  const m = a.length, n = b.length;
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

// Similarity ∈ [0, 1] where 1 = identical, 0 = nothing in common.
// (1 - levenshtein / max(len)) for non-empty inputs.
function similarity(a, b) {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  const maxLen = Math.max(a.length, b.length);
  return 1 - levenshtein(a, b) / maxLen;
}

// ── Public match helpers ──────────────────────────────────────────────────────

// Compare two person names. Strips accents, lowercases, normalises whitespace.
// Default threshold 0.85 matches the plan; CAC director matching uses 0.80.
function fuzzyNameMatch(a, b, threshold = 0.85) {
  const A = normaliseName(a);
  const B = normaliseName(b);
  if (!A || !B) return false;
  if (A === B) return true;
  return similarity(A, B) >= threshold;
}

// Same idea but with business-suffix stripping baked in.
function fuzzyBusinessNameMatch(a, b, threshold = 0.80) {
  const A = stripBusinessSuffixes(a);
  const B = stripBusinessSuffixes(b);
  if (!A || !B) return false;
  if (A === B) return true;
  return similarity(A, B) >= threshold;
}

// ── Address normalisation ────────────────────────────────────────────────────

function normaliseAddress({ line1, city, state, postalCode } = {}) {
  return [
    normaliseName(line1 || ""),
    normaliseName(city || ""),
    normaliseName(state || ""),
    (postalCode || "").trim(),
  ]
    .filter(Boolean)
    .join("|");
}

function isValidNigerianState(s) {
  if (!s || typeof s !== "string") return false;
  return NG_STATES.has(s.trim());
}

// ── Date sanity ──────────────────────────────────────────────────────────────

// Returns one of:
//   { ok: true, ageYears }
//   { ok: false, code: "DOB_INVALID" | "DOB_TOO_YOUNG" | "DOB_UNREALISTIC" }
function checkAdultDob(dobStr, { minAge = 18, maxAge = 110 } = {}) {
  if (!dobStr) return { ok: false, code: "DOB_INVALID" };
  const dob = new Date(dobStr);
  if (Number.isNaN(dob.getTime())) return { ok: false, code: "DOB_INVALID" };
  const now = new Date();
  if (dob > now) return { ok: false, code: "DOB_INVALID" };
  const ageMs = now - dob;
  const ageYears = ageMs / (365.2425 * 24 * 3600 * 1000);
  if (ageYears < minAge) return { ok: false, code: "DOB_TOO_YOUNG", ageYears };
  if (ageYears > maxAge) return { ok: false, code: "DOB_UNREALISTIC", ageYears };
  return { ok: true, ageYears };
}

// Incorporation/registration date: must be in the past, < 200 years old.
function checkRegistrationDate(dateStr) {
  if (!dateStr) return { ok: false, code: "REGDATE_INVALID" };
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return { ok: false, code: "REGDATE_INVALID" };
  const now = new Date();
  if (d > now) return { ok: false, code: "REGDATE_FUTURE" };
  const ageYears = (now - d) / (365.2425 * 24 * 3600 * 1000);
  if (ageYears > 200) return { ok: false, code: "REGDATE_UNREALISTIC" };
  return { ok: true, ageYears };
}

// ── ID format checks ─────────────────────────────────────────────────────────

// BVN — 11 digits, can't be a single repeated digit or a sequential run.
function isPlausibleBvn(s) {
  if (!s || typeof s !== "string") return false;
  if (!/^\d{11}$/.test(s)) return false;
  if (/^(\d)\1{10}$/.test(s)) return false;                          // 11111111111
  if (s === "01234567890" || s === "12345678901" || s === "98765432109") return false;
  return true;
}

// CAC RC/BN. RC = limited companies (4-8 digits). BN = registered business
// names (4-8 digits, may have a leading "BN"). Some older RC numbers run to
// 7 digits, modern ones 6-8. We accept 4-8 digits to be safe; reject obvious
// junk.
function isPlausibleCacNumber(s) {
  if (!s || typeof s !== "string") return false;
  const trimmed = s.trim().toUpperCase();
  // Accept: RC1234, BN12345, or bare 1234567.
  return /^(RC|BN)?\d{4,8}$/.test(trimmed);
}

// Normalise a CAC number for hashing/storage so "rc1234", "RC1234", "1234"
// all hash to the same value. Returns the bare digits, no prefix.
function normaliseCacNumber(s) {
  if (!s) return "";
  return String(s).trim().toUpperCase().replace(/^(RC|BN)/, "");
}

module.exports = {
  NG_STATES,
  normaliseName,
  stripBusinessSuffixes,
  similarity,
  fuzzyNameMatch,
  fuzzyBusinessNameMatch,
  normaliseAddress,
  isValidNigerianState,
  checkAdultDob,
  checkRegistrationDate,
  isPlausibleBvn,
  isPlausibleCacNumber,
  normaliseCacNumber,
};
