// Pure-function AML rules engine. Each rule takes a context object and
// returns either null (clean) or a flag descriptor. The pipeline
// (utils/amlChecks.js) feeds rules with rolling-window history and
// consumes the union to decide hold-vs-flag.
//
// `ctx.business` is required; rules read country-specific thresholds and
// the locale-correct currency formatter from it.
const { getThresholds, formatAmountForBusiness } = require("../config/amlLimits");

// ── Individual rules ──────────────────────────────────────────────────────

// CTR-style: any single transfer at or above the threshold is flagged
// medium for review. Does NOT block — large legitimate transfers happen.
function ruleSingleLarge({ amount, business }) {
  const t = getThresholds(business);
  if (amount < t.singleFlagAbove) return null;
  return {
    ruleCode: "SINGLE_LARGE",
    severity: "medium",
    description: `Single transfer of ${formatAmountForBusiness(business, amount)} meets the auto-review threshold.`,
    metadata: { amount, threshold: t.singleFlagAbove },
  };
}

// 4+ transfers in 24h each in [structuringSubThreshold, singleFlagAbove).
// Classic structuring signature.
function ruleStructuring({ amount, history24h, business }) {
  const t = getThresholds(business);
  const w = t.velocity;
  const candidates = [...history24h, { amount, date: new Date() }].filter(
    (x) => Number(x.amount) >= t.structuringSubThreshold && Number(x.amount) < t.singleFlagAbove,
  );
  if (candidates.length < w.structuringCount) return null;
  return {
    ruleCode: "STRUCTURING",
    severity: "high",
    description: `${candidates.length} transfers between ${formatAmountForBusiness(business, t.structuringSubThreshold)} and the CTR threshold within 24h.`,
    metadata: { count: candidates.length, threshold: t.singleFlagAbove },
  };
}

// 5+ transfers within 10 minutes. Medium severity — humans can do this
// legitimately (paying multiple vendors at end of day), but it's worth a
// look.
function ruleRapidFire({ history24h, business }) {
  const t = getThresholds(business);
  const w = t.velocity;
  const cutoff = Date.now() - w.rapidFireWindowMs;
  const recent = history24h.filter((x) => new Date(x.date).getTime() >= cutoff);
  const count = recent.length + 1;
  if (count < w.rapidFireCount) return null;
  return {
    ruleCode: "RAPID_FIRE",
    severity: "medium",
    description: `${count} transfers within ${w.rapidFireWindowMs / 60000} minutes.`,
    metadata: { count, windowMs: w.rapidFireWindowMs },
  };
}

// Today's outbound volume > N × rolling 30-day daily avg. High severity
// because a 5× spike usually signals either a hijack or a fast-moving
// laundering attempt.
function ruleVelocitySpike({ amount, history30d, businessAgeDays, business }) {
  const t = getThresholds(business);
  const w = t.velocity;
  if (businessAgeDays < w.spikeMinHistoryDays) return null;
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const today = history30d
    .filter((x) => new Date(x.date) >= todayStart)
    .reduce((s, x) => s + Number(x.amount), 0);
  const earlier = history30d
    .filter((x) => new Date(x.date) < todayStart)
    .reduce((s, x) => s + Number(x.amount), 0);
  const days = Math.max(1, Math.min(30, businessAgeDays));
  const dailyAvg = earlier / days;
  const projected = today + amount;
  if (dailyAvg <= 0 || projected <= dailyAvg * w.spikeMultiplier) return null;
  return {
    ruleCode: "VELOCITY_SPIKE",
    severity: "high",
    description: `Today's outbound (${formatAmountForBusiness(business, projected)}) is ${(projected / dailyAvg).toFixed(1)}× the 30-day daily average.`,
    metadata: { dailyAvg, projected, multiplier: w.spikeMultiplier },
  };
}

// Off-hours transfer above a threshold. Low severity — informational.
// Timezone comes from the country config (Africa/Lagos for NG,
// Africa/Nairobi for KE, etc.) so rules fire on local hours.
function ruleOffHours({ amount, now, business }) {
  const t = getThresholds(business);
  const w = t.velocity;
  if (amount < t.offHoursMinAmount) return null;
  const localHour = hourInTimezone(now, t.timezone);
  if (localHour < w.offHoursStartHour || localHour >= w.offHoursEndHour) return null;
  return {
    ruleCode: "OFF_HOURS",
    severity: "low",
    description: `Transfer of ${formatAmountForBusiness(business, amount)} between ${w.offHoursStartHour}:00 and ${w.offHoursEndHour}:00 local time.`,
    metadata: { localHour, timezone: t.timezone },
  };
}

// Compute the hour of day for a timestamp in the given IANA timezone.
// Uses Intl.DateTimeFormat which is built into Node.
function hourInTimezone(epochMs, tz) {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      hour: "2-digit",
      hour12: false,
    }).formatToParts(new Date(epochMs));
    const h = parts.find((p) => p.type === "hour");
    return h ? Number(h.value) : new Date(epochMs).getUTCHours();
  } catch {
    return new Date(epochMs).getUTCHours();
  }
}

const RULES = [
  ruleSingleLarge,
  ruleStructuring,
  ruleRapidFire,
  ruleVelocitySpike,
  ruleOffHours,
];

const SEVERITY_RANK = { low: 1, medium: 2, high: 3 };

function runRules(ctx) {
  const flags = [];
  let maxSeverity = null;
  for (const rule of RULES) {
    try {
      const out = rule(ctx);
      if (!out) continue;
      flags.push(out);
      if (!maxSeverity || SEVERITY_RANK[out.severity] > SEVERITY_RANK[maxSeverity]) {
        maxSeverity = out.severity;
      }
    } catch (err) {
      console.error(`[amlRules] ${rule.name} threw:`, err.message || err);
    }
  }
  return { maxSeverity, flags };
}

module.exports = { runRules };
