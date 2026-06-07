// Pure-function AML rules engine. Each rule takes a context object and
// returns either null (clean) or a flag descriptor. The pipeline
// (utils/amlChecks.js) feeds rules with rolling-window history and
// consumes the union to decide hold-vs-flag.
const {
  SINGLE_FLAG_ABOVE,
  VELOCITY_RULES,
} = require("../config/amlLimits");

// ── Individual rules ──────────────────────────────────────────────────────

// CTR-style: any single transfer at or above the threshold is flagged
// medium for review. Does NOT block — large legitimate transfers happen.
function ruleSingleLarge({ amount }) {
  if (amount < SINGLE_FLAG_ABOVE) return null;
  return {
    ruleCode: "SINGLE_LARGE",
    severity: "medium",
    description: `Single transfer of ₦${amount.toLocaleString("en-NG")} meets the auto-review threshold.`,
    metadata: { amount, threshold: SINGLE_FLAG_ABOVE },
  };
}

// 4+ transfers in 24h each in [structuringSubThreshold, SINGLE_FLAG_ABOVE).
// Classic structuring signature.
function ruleStructuring({ amount, history24h }) {
  const w = VELOCITY_RULES;
  // Include the current transfer in the check.
  const candidates = [...history24h, { amount, date: new Date() }].filter(
    (t) => t.amount >= w.structuringSubThreshold && t.amount < SINGLE_FLAG_ABOVE,
  );
  if (candidates.length < w.structuringCount) return null;
  return {
    ruleCode: "STRUCTURING",
    severity: "high",
    description: `${candidates.length} transfers between ₦${w.structuringSubThreshold.toLocaleString("en-NG")} and the CTR threshold within 24h.`,
    metadata: { count: candidates.length, threshold: SINGLE_FLAG_ABOVE },
  };
}

// 5+ transfers within 10 minutes. Medium severity — humans can do this
// legitimately (paying multiple vendors at end of day), but it's worth a
// look.
function ruleRapidFire({ history24h }) {
  const w = VELOCITY_RULES;
  const cutoff = Date.now() - w.rapidFireWindowMs;
  // Include this transfer (now) in the count.
  const recent = history24h.filter((t) => new Date(t.date).getTime() >= cutoff);
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
function ruleVelocitySpike({ amount, history30d, businessAgeDays }) {
  const w = VELOCITY_RULES;
  if (businessAgeDays < w.spikeMinHistoryDays) return null;
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const today = history30d
    .filter((t) => new Date(t.date) >= todayStart)
    .reduce((s, t) => s + t.amount, 0);
  const earlier = history30d
    .filter((t) => new Date(t.date) < todayStart)
    .reduce((s, t) => s + t.amount, 0);
  const days = Math.max(1, Math.min(30, businessAgeDays));
  const dailyAvg = earlier / days;
  const projected = today + amount;
  if (dailyAvg <= 0 || projected <= dailyAvg * w.spikeMultiplier) return null;
  return {
    ruleCode: "VELOCITY_SPIKE",
    severity: "high",
    description: `Today's outbound (₦${projected.toLocaleString("en-NG")}) is ${(projected / dailyAvg).toFixed(1)}× the 30-day daily average.`,
    metadata: { dailyAvg, projected, multiplier: w.spikeMultiplier },
  };
}

// Off-hours transfer above a threshold. Low severity — informational.
function ruleOffHours({ amount, now }) {
  const w = VELOCITY_RULES;
  if (amount < w.offHoursMinAmount) return null;
  // Africa/Lagos is UTC+1 with no DST.
  const hourInLagos = (new Date(now).getUTCHours() + 1) % 24;
  if (hourInLagos < w.offHoursStartHour || hourInLagos >= w.offHoursEndHour) return null;
  return {
    ruleCode: "OFF_HOURS",
    severity: "low",
    description: `Transfer of ₦${amount.toLocaleString("en-NG")} between ${w.offHoursStartHour}:00 and ${w.offHoursEndHour}:00 local time.`,
    metadata: { hourInLagos },
  };
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
