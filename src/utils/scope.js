// Whose data is this request about?
//
// Staff act on their EMPLOYER's data, so nearly every route has to resolve the
// caller to an owner id before touching the database. That logic was copied into
// ~14 files under three different names (`getTargetUserId`, `ownerId`, and
// inlined), and the copies drifted: transfers.js used a bare `req.user.id` for
// its business lookup, which is why a staff transfer 404s instead of sending.
//
// One implementation, so a future divergence has to be deliberate.
function ownerIdOf(req) {
  return req?.user?.accountType === "staff" ? req.user.employerId : req?.user?.id;
}

module.exports = { ownerIdOf };
