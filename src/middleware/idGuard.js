// Ids and query values arrive as plain strings (security fix, 2026-10-12).
//
// Express's default query parser (qs, "extended") turns `businessId[not]=x`
// into { not: "x" }, and a JSON body can carry the same object. Prisma reads
// either as a FILTER, not an id: a route that scopes a query by an id alone
// then widens it to other merchants' rows. GET /sync scoped bank rows and
// invoices by businessId alone, so `?businessId[in][]=<theirs>&businessId[in][]=<mine>`
// passed the ownership check (it matched the caller's own business) and
// returned another business's bank rows.
//
// So, before any route runs:
//   - every query value must be a string (no route reads arrays or objects
//     from the query);
//   - a top-level body field named like an id (`id`, `...Id`) must not be an
//     object or an array; a `...Ids` field may be an array of strings.
// Anything else is refused with 400 BAD_ID, naming the field.
const ID_KEY = /(^id$|Id$)/;
const IDS_KEY = /Ids$/;

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && !Buffer.isBuffer(v);

function badQuery(query) {
  if (!isPlainObject(query)) return null;
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && typeof v !== "string") return k;
  }
  return null;
}

function badBody(body) {
  if (!isPlainObject(body)) return null;
  for (const [k, v] of Object.entries(body)) {
    if (v === null || v === undefined || typeof v !== "object") continue;
    if (IDS_KEY.test(k)) {
      if (Array.isArray(v) && v.every((x) => typeof x === "string")) continue;
      return k;
    }
    if (ID_KEY.test(k)) return k;
  }
  return null;
}

function idGuard(req, res, next) {
  const field = badQuery(req.query) || badBody(req.body);
  if (field) {
    return res.status(400).json({ error: "That request isn't valid.", code: "BAD_ID", field });
  }
  next();
}

module.exports = { idGuard, badQuery, badBody };
