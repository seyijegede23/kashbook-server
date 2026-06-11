// Pre-Anchor KYC check wrapper.
//
// Owns:
//   • Phase B rate-limit lookups against KycCheckAttempt
//   • 2-tier cache (in-process LRU + KycCheckCache table)
//   • Circuit-breaker per provider so a provider outage doesn't hammer them
//   • Audit emission (KycCheckAttempt row + AuditLog row, every attempt)
//   • Provider selection via registries in bvnProviders/, cacProviders/.
//
// Exports:
//   runBvnCheck       — verify a BVN belongs to the typed name + DOB
//   runCacCheck       — verify a CAC RC/BN exists and the user's business
//                       name + at-least-one-director match
//   hashValue         — re-export of crypto.hmacValue for callers
//   purgeStaleCache   — daily cron entry point
//
// All three runXxxCheck functions resolve to one of:
//   { ok: true,  cached, result }
//   { ok: false, code, message, retryable? }
// and write a KycCheckAttempt row before returning. The route handler turns
// the code into a 400/429 response.

const prisma = require("./db");
const { hmacValue } = require("./crypto");
const { audit } = require("./audit");
const { getBvnProvider } = require("./bvnProviders");
const { getCacProvider } = require("./cacProviders");
const {
  fuzzyNameMatch,
  fuzzyBusinessNameMatch,
  isPlausibleBvn,
  isPlausibleCacNumber,
  normaliseCacNumber,
} = require("./kycMatch");

// ── Tunables (env-overridable) ────────────────────────────────────────────────

const CACHE_TTL_HOURS         = Number(process.env.KYC_CACHE_TTL_HOURS         || 24);
const USER_MAX_PER_DAY        = Number(process.env.KYC_USER_MAX_ATTEMPTS_PER_DAY || 3);
const VALUE_MAX_PER_DAY       = Number(process.env.KYC_VALUE_MAX_ATTEMPTS_PER_DAY || 5);
const CIRCUIT_FAIL_THRESHOLD  = 3;
const CIRCUIT_OPEN_MS         = 60_000;       // 1 minute lockout when tripped
const IN_PROCESS_CACHE_MS     = 15 * 60_000;  // 15 min LRU

// ── In-process LRU cache (avoids hitting the DB on hot keys) ─────────────────

const memCache = new Map(); // key → { result, expiresAt }

function memGet(key) {
  const entry = memCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    memCache.delete(key);
    return null;
  }
  // LRU touch
  memCache.delete(key);
  memCache.set(key, entry);
  return entry.result;
}

function memSet(key, result) {
  if (memCache.size > 500) {
    // Drop the oldest 50 entries when we get full.
    const dropCount = 50;
    let i = 0;
    for (const k of memCache.keys()) {
      memCache.delete(k);
      if (++i >= dropCount) break;
    }
  }
  memCache.set(key, { result, expiresAt: Date.now() + IN_PROCESS_CACHE_MS });
}

// ── Circuit breaker per provider ──────────────────────────────────────────────

const breakers = new Map(); // provider → { consecutiveFailures, openUntil }

function breakerKey(checkType, providerName) {
  return `${checkType}:${providerName}`;
}

function breakerIsOpen(checkType, providerName) {
  const key = breakerKey(checkType, providerName);
  const b = breakers.get(key);
  if (!b) return false;
  if (b.openUntil && Date.now() < b.openUntil) return true;
  return false;
}

function breakerRecord(checkType, providerName, success) {
  const key = breakerKey(checkType, providerName);
  const b = breakers.get(key) || { consecutiveFailures: 0, openUntil: 0 };
  if (success) {
    b.consecutiveFailures = 0;
    b.openUntil = 0;
  } else {
    b.consecutiveFailures += 1;
    if (b.consecutiveFailures >= CIRCUIT_FAIL_THRESHOLD) {
      b.openUntil = Date.now() + CIRCUIT_OPEN_MS;
    }
  }
  breakers.set(key, b);
}

// ── Audit row writer ──────────────────────────────────────────────────────────

async function recordAttempt({
  userId, checkType, valueHash, result, provider, cached, errorMessage, req,
}) {
  try {
    await prisma.kycCheckAttempt.create({
      data: {
        userId,
        checkType,
        valueHash,
        result,
        provider: provider || null,
        cached: !!cached,
        errorMessage: errorMessage || null,
      },
    });
  } catch (err) {
    console.error("[kycCheck] failed to write KycCheckAttempt:", err.message);
  }

  // Mirror to the global AuditLog so this shows up in the compliance feed.
  const severity =
    result === "ok"                  ? "info"
    : result === "provider_unavailable" ? "warn"
    : result === "format_invalid"    ? "info"
    : "warn";
  try {
    await audit({
      req,
      action: `KYC_CHECK_${result.toUpperCase()}`,
      resourceType: "kycCheck",
      resourceId: valueHash, // hash, never plaintext
      severity,
      metadata: { checkType, provider, cached, userId },
    });
  } catch (err) {
    console.error("[kycCheck] failed to write AuditLog:", err.message);
  }
}

// ── Rate-limit lookups ────────────────────────────────────────────────────────

async function isRateLimited({ userId, checkType, valueHash }) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [userCount, valueCount] = await Promise.all([
    prisma.kycCheckAttempt.count({
      where: {
        userId,
        checkType,
        createdAt: { gt: since },
        result: { notIn: ["ok"] }, // successful attempts don't count
      },
    }),
    prisma.kycCheckAttempt.count({
      where: {
        checkType,
        valueHash,
        createdAt: { gt: since },
        result: { notIn: ["ok"] },
      },
    }),
  ]);

  if (userCount >= USER_MAX_PER_DAY) {
    return { limited: true, reason: "user", count: userCount, cap: USER_MAX_PER_DAY };
  }
  if (valueCount >= VALUE_MAX_PER_DAY) {
    return { limited: true, reason: "value", count: valueCount, cap: VALUE_MAX_PER_DAY };
  }
  return { limited: false };
}

// ── Cache helpers ─────────────────────────────────────────────────────────────

async function cacheGet({ checkType, valueHash }) {
  // 1. Hot path
  const mem = memGet(`${checkType}:${valueHash}`);
  if (mem) return mem;

  // 2. DB path
  const cutoff = new Date(Date.now() - CACHE_TTL_HOURS * 60 * 60 * 1000);
  const row = await prisma.kycCheckCache.findUnique({
    where: { checkType_valueHash: { checkType, valueHash } },
  });
  if (!row || row.cachedAt < cutoff) return null;

  memSet(`${checkType}:${valueHash}`, row.result);
  return row.result;
}

async function cacheSet({ checkType, valueHash, provider, result }) {
  memSet(`${checkType}:${valueHash}`, result);
  try {
    await prisma.kycCheckCache.upsert({
      where: { checkType_valueHash: { checkType, valueHash } },
      create: { checkType, valueHash, provider, result },
      update: { provider, result, cachedAt: new Date() },
    });
  } catch (err) {
    console.error("[kycCheck] failed to write KycCheckCache:", err.message);
  }
}

// ── Public: BVN check ─────────────────────────────────────────────────────────

async function runBvnCheck({
  bvn,                  // raw 11-digit string from the request
  userId,
  expectedFirstName,    // user-typed; will be fuzzy-matched
  expectedLastName,
  expectedDateOfBirth,  // ISO string; will be exact-matched (YYYY-MM-DD)
  req,
}) {
  const checkType = "bvn";

  // Phase A — format
  if (!isPlausibleBvn(bvn)) {
    const valueHash = hmacValue(bvn || "invalid");
    await recordAttempt({
      userId, checkType, valueHash, result: "format_invalid", req,
      errorMessage: "BVN format invalid",
    });
    return { ok: false, code: "BVN_FORMAT_INVALID", message: "Enter a valid 11-digit BVN." };
  }

  const valueHash = hmacValue(bvn);

  // Phase B — rate-limit
  const rl = await isRateLimited({ userId, checkType, valueHash });
  if (rl.limited) {
    await recordAttempt({
      userId, checkType, valueHash, result: "rate_limited", req,
      errorMessage: `Rate-limited (${rl.reason}, ${rl.count}/${rl.cap})`,
    });
    return {
      ok: false,
      code: "BVN_RATE_LIMITED",
      message: "Too many attempts. Try again in 24 hours.",
      retryable: true,
    };
  }

  // Phase C — third-party lookup (cache-first)
  let cached = await cacheGet({ checkType, valueHash });
  let providerName = process.env.KYC_PROVIDER || "dojah";

  if (!cached) {
    if (breakerIsOpen(checkType, providerName)) {
      await recordAttempt({
        userId, checkType, valueHash, result: "provider_unavailable",
        provider: providerName, req,
        errorMessage: "Circuit breaker open",
      });
      return { ok: false, code: "PROVIDER_UNAVAILABLE" };
    }

    const provider = getBvnProvider(providerName);
    const r = await provider.verifyBvn(bvn, { userId });

    if (!r.ok && r.error === "PROVIDER_UNAVAILABLE") {
      breakerRecord(checkType, providerName, false);
      await recordAttempt({
        userId, checkType, valueHash, result: "provider_unavailable",
        provider: providerName, req,
        errorMessage: r.message,
      });
      return { ok: false, code: "PROVIDER_UNAVAILABLE" };
    }

    if (!r.ok && r.error === "NOT_FOUND") {
      await recordAttempt({
        userId, checkType, valueHash, result: "name_mismatch",
        provider: providerName, req,
        errorMessage: "BVN not found at provider",
      });
      return {
        ok: false,
        code: "BVN_NOT_FOUND",
        message: "This BVN was not found. Please double-check the number.",
      };
    }

    if (!r.ok) {
      breakerRecord(checkType, providerName, false);
      await recordAttempt({
        userId, checkType, valueHash, result: "provider_error",
        provider: providerName, req,
        errorMessage: r.message,
      });
      return { ok: false, code: "PROVIDER_ERROR" };
    }

    breakerRecord(checkType, providerName, true);
    cached = r.details;
    await cacheSet({ checkType, valueHash, provider: providerName, result: cached });
  }

  // Phase C match — name + DOB
  const firstOk = fuzzyNameMatch(cached.firstName, expectedFirstName);
  const lastOk  = fuzzyNameMatch(cached.lastName,  expectedLastName);
  if (!firstOk || !lastOk) {
    await recordAttempt({
      userId, checkType, valueHash, result: "name_mismatch",
      provider: providerName, cached: true, req,
    });
    return {
      ok: false,
      code: "BVN_NAME_MISMATCH",
      message: "The name on this BVN doesn't match what you entered. Double-check the first and last name.",
    };
  }

  // DOB exact-match (after normalising to YYYY-MM-DD)
  const got = ymd(cached.dateOfBirth);
  const want = ymd(expectedDateOfBirth);
  if (got && want && got !== want) {
    await recordAttempt({
      userId, checkType, valueHash, result: "dob_mismatch",
      provider: providerName, cached: true, req,
    });
    return {
      ok: false,
      code: "BVN_DOB_MISMATCH",
      message: "The date of birth on this BVN doesn't match. Please correct it.",
    };
  }

  await recordAttempt({
    userId, checkType, valueHash, result: "ok",
    provider: providerName, cached: true, req,
  });

  return {
    ok: true,
    cached: !!cached,
    result: cached,
    valueHash,
  };
}

// ── Public: CAC check ─────────────────────────────────────────────────────────

async function runCacCheck({
  cacNumber,                    // raw user input — may include RC/BN prefix
  userId,
  expectedBusinessName,
  expectedDirectorNames = [],   // array of strings to match against directors
  req,
}) {
  const checkType = "cac";

  if (!isPlausibleCacNumber(cacNumber)) {
    const valueHash = hmacValue(cacNumber || "invalid");
    await recordAttempt({
      userId, checkType, valueHash, result: "format_invalid", req,
      errorMessage: "CAC format invalid",
    });
    return {
      ok: false,
      code: "CAC_FORMAT_INVALID",
      message: "Enter a valid RC or BN number (4-8 digits, with optional RC/BN prefix).",
    };
  }

  const normalised = normaliseCacNumber(cacNumber);
  const valueHash = hmacValue(normalised);

  const rl = await isRateLimited({ userId, checkType, valueHash });
  if (rl.limited) {
    await recordAttempt({
      userId, checkType, valueHash, result: "rate_limited", req,
      errorMessage: `Rate-limited (${rl.reason}, ${rl.count}/${rl.cap})`,
    });
    return {
      ok: false,
      code: "CAC_RATE_LIMITED",
      message: "Too many attempts. Try again in 24 hours.",
      retryable: true,
    };
  }

  let cached = await cacheGet({ checkType, valueHash });
  const providerName = process.env.KYC_PROVIDER || "dojah";

  if (!cached) {
    if (breakerIsOpen(checkType, providerName)) {
      await recordAttempt({
        userId, checkType, valueHash, result: "provider_unavailable",
        provider: providerName, req,
        errorMessage: "Circuit breaker open",
      });
      return { ok: false, code: "PROVIDER_UNAVAILABLE" };
    }

    const provider = getCacProvider(providerName);
    const r = await provider.verifyCacNumber(normalised, { userId });

    if (!r.ok && r.error === "PROVIDER_UNAVAILABLE") {
      breakerRecord(checkType, providerName, false);
      await recordAttempt({
        userId, checkType, valueHash, result: "provider_unavailable",
        provider: providerName, req,
        errorMessage: r.message,
      });
      return { ok: false, code: "PROVIDER_UNAVAILABLE" };
    }

    if (!r.ok && r.error === "NOT_FOUND") {
      await recordAttempt({
        userId, checkType, valueHash, result: "name_mismatch",
        provider: providerName, req,
        errorMessage: "CAC record not found",
      });
      return {
        ok: false,
        code: "CAC_NOT_FOUND",
        message: "This RC/BN number was not found in CAC's records. Please double-check it.",
      };
    }

    if (!r.ok) {
      breakerRecord(checkType, providerName, false);
      await recordAttempt({
        userId, checkType, valueHash, result: "provider_error",
        provider: providerName, req,
        errorMessage: r.message,
      });
      return { ok: false, code: "PROVIDER_ERROR" };
    }

    breakerRecord(checkType, providerName, true);
    cached = r.details;
    await cacheSet({ checkType, valueHash, provider: providerName, result: cached });
  }

  // Phase C match — business name + at-least-one director
  if (!fuzzyBusinessNameMatch(cached.businessName, expectedBusinessName)) {
    await recordAttempt({
      userId, checkType, valueHash, result: "name_mismatch",
      provider: providerName, cached: true, req,
    });
    return {
      ok: false,
      code: "CAC_NAME_MISMATCH",
      message: `The business name registered at CAC for this number is "${cached.businessName}". Please update the business name to match.`,
    };
  }

  // Director match is only required when the caller passes any expected names
  // (typically: limited_company KYB). If the array is empty we skip.
  if (expectedDirectorNames.length > 0) {
    const directors = cached.directors || [];
    const matched = expectedDirectorNames.some((expected) =>
      directors.some((d) =>
        fuzzyNameMatch(
          `${d.firstName} ${d.lastName}`.trim() || d.fullName,
          expected,
          0.80,
        ),
      ),
    );
    if (!matched) {
      await recordAttempt({
        userId, checkType, valueHash, result: "director_mismatch",
        provider: providerName, cached: true, req,
      });
      return {
        ok: false,
        code: "CAC_DIRECTOR_MISMATCH",
        message: "None of the listed directors on CAC matched the names you entered.",
      };
    }
  }

  await recordAttempt({
    userId, checkType, valueHash, result: "ok",
    provider: providerName, cached: true, req,
  });

  return {
    ok: true,
    cached: !!cached,
    result: cached,
    valueHash,
  };
}

// ── Maintenance ───────────────────────────────────────────────────────────────

// Daily cron entry point. Drops cache rows past TTL so we don't keep
// PII-adjacent normalised identity data around longer than necessary.
async function purgeStaleCache() {
  const cutoff = new Date(Date.now() - CACHE_TTL_HOURS * 60 * 60 * 1000);
  const { count } = await prisma.kycCheckCache.deleteMany({
    where: { cachedAt: { lt: cutoff } },
  });
  if (count > 0) {
    console.log(`[kycCheck] purged ${count} stale cache row(s)`);
  }
  return count;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function ymd(s) {
  if (!s) return "";
  // Accept ISO strings, dd/mm/yyyy from Dojah, or plain Date.
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  // Try Dojah's "dd-mm-yyyy" / "dd/mm/yyyy".
  const m = String(s).match(/^(\d{2})[\/\-](\d{2})[\/\-](\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return "";
}

module.exports = {
  runBvnCheck,
  runCacCheck,
  purgeStaleCache,
  hashValue: hmacValue,
};
