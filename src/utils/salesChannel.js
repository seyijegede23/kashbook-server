// Sales-channel helpers — the channel a sale came in through. Shared by the
// sales + transactions routes so the allowed set + normalization stay in one
// place. Stored as a validated loose string (matching category/paymentMethod
// conventions), not a PG enum, so adding a channel later needs no migration.

const CHANNELS = ["instagram", "whatsapp", "walk-in", "online", "other"];
const CHANNEL_SET = new Set(CHANNELS);

// Normalize a client-supplied channel to a known value, else null.
// Accepts variants like "Walk In", "walk_in", "WhatsApp".
function normalizeChannel(raw) {
  if (raw == null || raw === "") return null;
  const c = String(raw).trim().toLowerCase().replace(/[\s_]+/g, "-");
  return CHANNEL_SET.has(c) ? c : null;
}

module.exports = { CHANNELS, normalizeChannel };
