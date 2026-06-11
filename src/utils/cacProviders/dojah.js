// Dojah CAC (Corporate Affairs Commission) adapter.
//
// Same auth + base URL pattern as bvnProviders/dojah.js.
//
// Endpoint:
//   GET /api/v1/kyc/cac/basic?rc_number=<bare digits>&customer_reference=<our user id>
//
// Dojah accepts the bare digits OR RC-prefixed format; we always send the
// bare digits (normaliseCacNumber strips RC/BN). Some Dojah accounts also
// expose /kyc/cac/advance which returns director DOBs and shareholder
// breakdowns; we'll add that adapter when the data is needed.

const { request } = require("undici");

const TIMEOUT_MS = 4_000;

function getBaseUrl() {
  return (
    process.env.DOJAH_BASE_URL ||
    (process.env.NODE_ENV === "production"
      ? "https://api.dojah.io"
      : "https://sandbox.dojah.io")
  );
}

function getHeaders() {
  const appId = process.env.DOJAH_APP_ID;
  const secret = process.env.DOJAH_SECRET_KEY;
  if (!appId || !secret) {
    const e = new Error("DOJAH_APP_ID + DOJAH_SECRET_KEY env vars are required");
    e.code = "PROVIDER_NOT_CONFIGURED";
    throw e;
  }
  return {
    AppId: appId,
    Authorization: secret,
    Accept: "application/json",
  };
}

// Verify a CAC registration number against Dojah.
//
//   rcNumber  — bare digits (no "RC"/"BN" prefix). Caller has already
//               format-checked + normalised.
//   userId    — for customer_reference tracking.
//
// Resolves to:
//   { ok: true, details: {
//       businessName, registrationNumber, status, address,
//       directors: [{ firstName, lastName }, …],
//     } }
//   { ok: false, error: "NOT_FOUND" | "PROVIDER_UNAVAILABLE" | "PROVIDER_ERROR",
//     httpStatus?, message? }
async function verifyCacNumber(rcNumber, { userId } = {}) {
  let headers;
  try { headers = getHeaders(); }
  catch (err) {
    return { ok: false, error: "PROVIDER_UNAVAILABLE", message: err.message };
  }

  const url = new URL(`${getBaseUrl()}/api/v1/kyc/cac/basic`);
  url.searchParams.set("rc_number", rcNumber);
  if (userId) url.searchParams.set("customer_reference", String(userId));

  let res;
  try {
    res = await request(url, {
      method: "GET",
      headers,
      bodyTimeout: TIMEOUT_MS,
      headersTimeout: TIMEOUT_MS,
    });
  } catch (err) {
    return {
      ok: false,
      error: "PROVIDER_UNAVAILABLE",
      message: err.message || String(err),
    };
  }

  let body;
  try { body = await res.body.json(); }
  catch { body = null; }

  if (res.statusCode >= 500 || res.statusCode === 408 || res.statusCode === 429) {
    return {
      ok: false,
      error: "PROVIDER_UNAVAILABLE",
      httpStatus: res.statusCode,
      message: body?.error || `Dojah ${res.statusCode}`,
    };
  }

  if (res.statusCode === 400 || res.statusCode === 404) {
    return {
      ok: false,
      error: "NOT_FOUND",
      httpStatus: res.statusCode,
      message: body?.error || "CAC record not found",
    };
  }

  if (res.statusCode !== 200 || !body) {
    return {
      ok: false,
      error: "PROVIDER_ERROR",
      httpStatus: res.statusCode,
      message: body?.error || `Unexpected Dojah response (${res.statusCode})`,
    };
  }

  const data = body.entity || body.data || body;

  // Field-name normalisation. Dojah CAC-basic returns: company_name,
  // registration_number, registration_status, address, directors.
  const directors = Array.isArray(data.directors)
    ? data.directors.map((d) => ({
        firstName: d.first_name || d.firstName || "",
        lastName:  d.last_name  || d.lastName  || "",
        fullName:  d.name       || `${d.first_name || ""} ${d.last_name || ""}`.trim(),
      }))
    : [];

  const details = {
    businessName:       data.company_name        || data.businessName        || data.name || "",
    registrationNumber: data.registration_number || data.registrationNumber  || rcNumber,
    status:             data.registration_status || data.status              || "",
    address:            data.address             || "",
    directors,
  };

  if (!details.businessName) {
    return {
      ok: false,
      error: "PROVIDER_ERROR",
      httpStatus: res.statusCode,
      message: "Dojah returned no business identity fields",
    };
  }

  return { ok: true, details };
}

module.exports = { verifyCacNumber };
