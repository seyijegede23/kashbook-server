// Did a ForeignAccount row ever reach Fincra?
//
// The request route creates the row immediately before calling Fincra and
// writes fincraRequestId (Fincra's `_id`, present on every accepted request)
// and consentUrl from the provider's response. So a "pending" row with neither
// is the leftover of an attempt that failed BEFORE the provider call, or of a
// crash between the create and the call. Two things follow, and both call sites
// use this module so they can never disagree:
//
//   - it must not be LISTED as an account in progress. On 2026-09-10 one such
//     row put an "In progress" badge on the owner's screen and hid the request
//     button behind it, so the fix on the server could not be reached.
//   - it must not BLOCK a retry. The old short-circuit returned 200 "existing"
//     for any non-declined row, so every resubmission was a silent no-op.
//
// A declined row is neither: it is shown (with its reason) and retryable.
function reachedFincra(fa) {
  if (!fa || fa.status === "declined") return false;
  if (fa.status === "approved" || fa.status === "issued") return true;
  return !!(fa.fincraRequestId || fa.consentUrl);
}

function neverSent(fa) {
  return !!fa && fa.status === "pending" && !fa.fincraRequestId && !fa.consentUrl;
}

module.exports = { reachedFincra, neverSent };
