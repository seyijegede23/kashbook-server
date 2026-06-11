// Dojah BVN-basic adapter.
//
// Auth (confirmed against https://docs.dojah.io/docs/technical-reference/authentication):
//   AppId: <DOJAH_APP_ID>
//   Authorization: <DOJAH_SECRET_KEY>
//
// Base URL:
//   sandbox  https://sandbox.dojah.io
//   live     https://api.dojah.io
//
// Endpoint (BVN basic):
//   GET /api/v1/kyc/bvn/basic?bvn=<11-digit>&customer_reference=<our user id>
//
// Returns an object the kycCheck wrapper normalises against the user's typed
// name + DOB. Provider-specific shape stays here; rest of the system never
// sees Dojah-specific field names.

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

// Verify a BVN against Dojah.
//
//   bvn        — 11-digit string. Caller has already format-checked.
//   userId     — KashBook user ID. Sent as customer_reference so Dojah's
//                dashboard shows which of our users triggered the lookup.
//
// Resolves to:
//   { ok: true,  details: { firstName, lastName, dateOfBirth, gender, phoneNumber } }
//   { ok: false, error: "NOT_FOUND" | "PROVIDER_UNAVAILABLE" | "PROVIDER_ERROR",
//     httpStatus?, message? }
//
// Throws only when the env config is missing (PROVIDER_NOT_CONFIGURED) — the
// wrapper treats that as PROVIDER_UNAVAILABLE so KYB doesn't hard-fail in
// staging before the keys are set.
async function verifyBvn(bvn, { userId } = {}) {
  let headers;
  try { headers = getHeaders(); }
  catch (err) {
    return { ok: false, error: "PROVIDER_UNAVAILABLE", message: err.message };
  }

  const url = new URL(`${getBaseUrl()}/api/v1/kyc/bvn/basic`);
  url.searchParams.set("bvn", bvn);
  if (userId) url.searchParams.set("customer_reference", String(userId));

  let res;
  try {
    res = await fetch(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return {
      ok: false,
      error: "PROVIDER_UNAVAILABLE",
      message: err.message || String(err),
    };
  }

  let body;
  try { body = await res.json(); }
  catch { body = null; }

  const status = res.status;

  if (status >= 500 || status === 408 || status === 429) {
    return {
      ok: false,
      error: "PROVIDER_UNAVAILABLE",
      httpStatus: status,
      message: body?.error || `Dojah ${status}`,
    };
  }

  if (status === 400 || status === 404) {
    // Dojah uses 400 for "BVN not found" too — normalise to NOT_FOUND.
    return {
      ok: false,
      error: "NOT_FOUND",
      httpStatus: status,
      message: body?.error || "BVN not found",
    };
  }

  if (status !== 200 || !body) {
    return {
      ok: false,
      error: "PROVIDER_ERROR",
      httpStatus: status,
      message: body?.error || `Unexpected Dojah response (${status})`,
    };
  }

  // Dojah's documented success shape wraps data under `entity` (some endpoints
  // use `data`). Normalise defensively.
  const data = body.entity || body.data || body;

  // Field-name normalisation. Dojah BVN-basic returns first_name / last_name /
  // date_of_birth / gender / phone_number1 / phone_number; we expose camelCase.
  const details = {
    firstName:   data.first_name   || data.firstName   || "",
    lastName:    data.last_name    || data.lastName    || "",
    dateOfBirth: data.date_of_birth || data.dateOfBirth || "",
    gender:      data.gender       || "",
    phoneNumber: data.phone_number1 || data.phone_number || data.phoneNumber || "",
  };

  if (!details.firstName && !details.lastName) {
    return {
      ok: false,
      error: "PROVIDER_ERROR",
      httpStatus: status,
      message: "Dojah returned no identity fields",
    };
  }

  return { ok: true, details };
}

module.exports = { verifyBvn };
