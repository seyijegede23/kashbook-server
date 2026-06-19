// In-process request metrics + event-loop lag. Per-instance and reset on
// restart (durable history is written by the snapshot cron → MetricSnapshot).
// Cheap by design: a hrtime diff + a few counter increments per request.

const startedAt = Date.now();
const buckets = new Map(); // routeKey -> { count, errors, totalMs, maxMs, hist[] }
let totalReq = 0;
let total5xx = 0;
let total4xx = 0;

// Latency histogram edges (ms) → approximate percentiles without storing samples.
const BOUNDS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, Infinity];

// Normalized route key — prefer the matched Express route, else collapse to the
// first two path segments so dynamic ids don't explode cardinality.
function routeKey(req) {
  const base = req.baseUrl || "";
  const rp = req.route && req.route.path;
  if (rp) return `${req.method} ${base}${rp === "/" ? "" : rp}`;
  const seg = (req.path || "/").split("/").filter(Boolean).slice(0, 2).join("/");
  return `${req.method} /${seg}`;
}

function record(key, ms, status) {
  let b = buckets.get(key);
  if (!b) {
    b = { count: 0, errors: 0, totalMs: 0, maxMs: 0, hist: new Array(BOUNDS.length).fill(0) };
    buckets.set(key, b);
  }
  b.count++;
  b.totalMs += ms;
  if (ms > b.maxMs) b.maxMs = ms;
  if (status >= 500) b.errors++;
  for (let i = 0; i < BOUNDS.length; i++) {
    if (ms <= BOUNDS[i]) { b.hist[i]++; break; }
  }
}

function percentile(hist, count, p) {
  if (!count) return 0;
  const target = count * p;
  let cum = 0;
  for (let i = 0; i < BOUNDS.length; i++) {
    cum += hist[i];
    if (cum >= target) return BOUNDS[i] === Infinity ? 5000 : BOUNDS[i];
  }
  return 5000;
}

function metricsMiddleware(req, res, next) {
  const start = process.hrtime.bigint();
  res.on("finish", () => {
    try {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      totalReq++;
      if (res.statusCode >= 500) total5xx++;
      else if (res.statusCode >= 400) total4xx++;
      record(routeKey(req), ms, res.statusCode);
    } catch {
      /* metrics must never break a request */
    }
  });
  next();
}

function getMetrics() {
  const routes = [];
  for (const [key, b] of buckets) {
    routes.push({
      route: key,
      count: b.count,
      errors: b.errors,
      avgMs: Math.round(b.totalMs / b.count),
      maxMs: Math.round(b.maxMs),
      p95Ms: percentile(b.hist, b.count, 0.95),
    });
  }
  routes.sort((a, b) => b.count - a.count);
  return {
    sinceMs: Date.now() - startedAt,
    totalRequests: totalReq,
    errors5xx: total5xx,
    errors4xx: total4xx,
    errorRate5xx: totalReq ? Number(((total5xx / totalReq) * 100).toFixed(2)) : 0,
    routes: routes.slice(0, 50),
  };
}

// Event-loop lag — drift of a fixed-interval timer (ms over its nominal period).
let _lagMs = 0;
(function sampleLag() {
  const INTERVAL = 1000;
  let last = process.hrtime.bigint();
  setInterval(() => {
    const now = process.hrtime.bigint();
    _lagMs = Math.max(0, Math.round(Number(now - last) / 1e6 - INTERVAL));
    last = now;
  }, INTERVAL).unref();
})();
const eventLoopLagMs = () => _lagMs;

module.exports = { metricsMiddleware, getMetrics, eventLoopLagMs };
