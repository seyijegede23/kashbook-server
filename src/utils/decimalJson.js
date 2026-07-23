// Phase C1: money columns moved from Float to Prisma Decimal for exact arithmetic.
// A Decimal serializes to JSON as a STRING, which would silently break the client's
// number math + formatting. This deep-converts every Decimal in a response body back
// to a plain Number so the JSON API contract stays exactly as it was (numbers).
// Applied globally as an express middleware that wraps res.json.
const { Prisma } = require("@prisma/client");

function decimalsToNumbers(v) {
  if (v == null) return v;
  if (Prisma.Decimal.isDecimal(v)) return v.toNumber();
  if (typeof v !== "object") return v;
  if (v instanceof Date || Buffer.isBuffer(v)) return v;
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) v[i] = decimalsToNumbers(v[i]);
    return v;
  }
  for (const k of Object.keys(v)) v[k] = decimalsToNumbers(v[k]);
  return v;
}

function decimalJsonMiddleware(req, res, next) {
  const orig = res.json.bind(res);
  res.json = (body) => orig(decimalsToNumbers(body));
  next();
}

module.exports = { decimalsToNumbers, decimalJsonMiddleware };
