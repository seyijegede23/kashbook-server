// Shared 60s cache for each business's Anchor "cash at bank" balance.
//
// It's shared (not local to the balance route) so the transfer route can
// OPTIMISTICALLY adjust it the instant a transfer succeeds — that way the
// dashboard's balance refetch shows the new figure immediately instead of the
// stale cached value, and it reconciles with Anchor when the entry next expires.
const TTL_MS = 60 * 1000;
const cache = new Map(); // businessId → { value, expires }

function getBalance(id) {
  const e = cache.get(id);
  if (e && e.expires > Date.now()) return e.value;
  if (e) cache.delete(id);
  return undefined; // miss → caller should fetch fresh from Anchor
}

function setBalance(id, value) {
  cache.set(id, { value: Number(value) || 0, expires: Date.now() + TTL_MS });
}

// Apply a signed delta (e.g. -(amount+fee) on a transfer) to the cached value so
// it reflects the movement right away. If there's no warm value to adjust, drop
// the entry so the next read fetches fresh from Anchor (avoids showing a guess).
function adjustBalance(id, delta) {
  const e = cache.get(id);
  if (e && e.expires > Date.now()) {
    e.value = Math.max(0, e.value + delta);
    e.expires = Date.now() + TTL_MS; // hold the optimistic value until Anchor catches up
  } else {
    cache.delete(id);
  }
}

function bustBalance(id) {
  cache.delete(id);
}

module.exports = { getBalance, setBalance, adjustBalance, bustBalance, TTL_MS };
