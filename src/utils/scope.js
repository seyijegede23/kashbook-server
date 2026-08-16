// Whose data is this request about?
//
// Staff act on their EMPLOYER's data, so nearly every route has to resolve the
// caller to an owner id before touching the database. That logic was copied into
// ~14 files under three different names (`getTargetUserId`, `ownerId`, and
// inlined), and the copies drifted: transfers.js used a bare `req.user.id` for
// its business lookup, which is why a staff transfer 404s instead of sending.
//
// One implementation, so a future divergence has to be deliberate.
// Never returns null for a real session. A staff row whose employerId is null is
// corrupt data (the employer was hard-deleted, or a row was written by hand), and
// the tempting `return req.user.employerId` hands a null straight into a Prisma
// `where` clause. `where: { userId: null }` does not mean "no rows" everywhere it
// is used — on a nullable column it MATCHES, and on a findMany with no other
// filter it widens the query instead of narrowing it. Falling back to the
// caller's own id scopes them to their own (empty) set, which 404s. Fail closed.
function ownerIdOf(req) {
  const u = req?.user;
  if (!u) return null; // no session at all — the auth middleware should have refused
  if (u.accountType === "staff") return u.employerId || u.id;
  return u.id;
}

module.exports = { ownerIdOf };
