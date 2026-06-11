// Google Geocoding adapter — Phase D address resolution.
//
// Auth: a single API key in the GOOGLE_GEOCODING_API_KEY env var. Lock the
// key down to server-only IPs in the Google Cloud console.
//
// Endpoint:
//   GET https://maps.googleapis.com/maps/api/geocode/json
//       ?address=<urlencoded full address>
//       &region=ng
//       &components=country:ng
//       &key=<key>
//
// region+components together bias Google's matcher toward Nigeria — the
// difference between "matched a Lagos street" vs "matched a Lagos in
// Portugal." If the address still doesn't resolve we return NOT_FOUND
// and the wrapper logs a `warn` without blocking submission.

const { request } = require("undici");

const TIMEOUT_MS = 4_000;

async function geocodeAddress({ line1, city, state, postalCode }) {
  const key = process.env.GOOGLE_GEOCODING_API_KEY;
  if (!key) {
    return { ok: false, error: "PROVIDER_UNAVAILABLE", message: "GOOGLE_GEOCODING_API_KEY missing" };
  }

  const addressParts = [line1, city, state, postalCode, "Nigeria"]
    .map((p) => (p || "").trim())
    .filter(Boolean);
  if (addressParts.length < 2) {
    return { ok: false, error: "NOT_FOUND", message: "Not enough address parts to geocode" };
  }
  const address = addressParts.join(", ");

  const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  url.searchParams.set("address", address);
  url.searchParams.set("region", "ng");
  url.searchParams.set("components", "country:NG");
  url.searchParams.set("key", key);

  let res;
  try {
    res = await request(url, {
      method: "GET",
      bodyTimeout: TIMEOUT_MS,
      headersTimeout: TIMEOUT_MS,
    });
  } catch (err) {
    return { ok: false, error: "PROVIDER_UNAVAILABLE", message: err.message };
  }

  let body;
  try { body = await res.body.json(); }
  catch { body = null; }

  if (res.statusCode >= 500) {
    return { ok: false, error: "PROVIDER_UNAVAILABLE", httpStatus: res.statusCode };
  }

  if (!body || body.status === "REQUEST_DENIED" || body.status === "INVALID_REQUEST") {
    return {
      ok: false,
      error: "PROVIDER_ERROR",
      httpStatus: res.statusCode,
      message: body?.error_message || body?.status || "Unknown geocoding error",
    };
  }

  // ZERO_RESULTS = address doesn't exist in Google's index. Common for very
  // rural areas, new estates, or pure junk. Not a failure of the provider.
  if (body.status === "ZERO_RESULTS" || !Array.isArray(body.results) || body.results.length === 0) {
    return { ok: false, error: "NOT_FOUND" };
  }

  const top = body.results[0];
  const { lat, lng } = top.geometry?.location || {};
  if (typeof lat !== "number" || typeof lng !== "number") {
    return { ok: false, error: "PROVIDER_ERROR", message: "Result missing lat/lng" };
  }

  // Safety: confirm Google actually placed the address in Nigeria. region+
  // components bias the search but don't HARD-restrict — a confident match
  // outside NG still gets returned. Reject those.
  const countryComponent = (top.address_components || []).find((c) =>
    Array.isArray(c.types) && c.types.includes("country"),
  );
  if (countryComponent && countryComponent.short_name !== "NG") {
    return { ok: false, error: "NOT_FOUND", message: "Result not in Nigeria" };
  }

  return {
    ok: true,
    details: {
      lat,
      lng,
      formattedAddress: top.formatted_address || address,
      components: top.address_components || [],
    },
  };
}

module.exports = { geocodeAddress };
