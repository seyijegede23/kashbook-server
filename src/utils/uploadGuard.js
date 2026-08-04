// Validation for client-supplied base64 uploads.
//
// Every upload route used to pass the raw request string straight to
// cloudinary.uploader.upload() with no MIME check, no size cap and
// resource_type "auto". Two concrete problems that closes:
//
//   1. ARBITRARY HOSTING — an attacker could store any content (HTML, SVG with
//      script, executables) under our Cloudinary account at a public URL.
//   2. REQUEST FORWARDING — cloudinary.uploader.upload() also accepts a REMOTE
//      URL as its first argument, not just a data URI. Passing
//      "http://169.254.169.254/..." makes Cloudinary's fetcher perform that
//      request. It originates from their network rather than ours, but it is an
//      unintended forwarding primitive and there is no reason to allow it.
//
// So: only well-formed `data:` URIs, only allowlisted MIME types, hard cap on
// the DECODED size (base64 inflates ~33%, so the byte length is what matters).

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/jpg", "image/webp"];
const DOC_TYPES = [...IMAGE_TYPES, "application/pdf"];

// Cloudinary resource_type must be pinned explicitly — "auto" lets the file
// decide what it becomes.
const RESOURCE_TYPE = { "application/pdf": "raw", default: "image" };

class UploadError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
    this.httpStatus = 400;
  }
}

/**
 * Validate a base64 data URI.
 * @returns {{ mime: string, bytes: number, resourceType: string }}
 * @throws  {UploadError} with a user-safe message
 */
function validateDataUri(input, { allow = IMAGE_TYPES, maxBytes = 5 * 1024 * 1024 } = {}) {
  if (typeof input !== "string" || !input) {
    throw new UploadError("No file provided.", "UPLOAD_EMPTY");
  }
  // Reject anything that isn't a data URI — in particular remote URLs, which
  // Cloudinary would otherwise fetch on our behalf.
  const m = /^data:([a-z0-9.+/-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(input.trim());
  if (!m) {
    throw new UploadError(
      "File must be uploaded as base64 data (data:<type>;base64,...).",
      "UPLOAD_NOT_DATA_URI",
    );
  }
  const mime = m[1].toLowerCase();
  if (!allow.includes(mime)) {
    throw new UploadError(
      `Unsupported file type. Allowed: ${allow.map((t) => t.split("/")[1]).join(", ")}.`,
      "UPLOAD_TYPE_NOT_ALLOWED",
    );
  }
  // Decoded size, not the base64 length.
  const b64 = m[2].replace(/\s/g, "");
  const padding = (b64.match(/=+$/) || [""])[0].length;
  const bytes = Math.floor((b64.length * 3) / 4) - padding;
  if (bytes <= 0) throw new UploadError("File appears to be empty.", "UPLOAD_EMPTY");
  if (bytes > maxBytes) {
    throw new UploadError(
      `File is too large (${(bytes / 1024 / 1024).toFixed(1)}MB). Maximum ${Math.round(maxBytes / 1024 / 1024)}MB.`,
      "UPLOAD_TOO_LARGE",
    );
  }
  return { mime, bytes, resourceType: RESOURCE_TYPE[mime] || RESOURCE_TYPE.default };
}

module.exports = { validateDataUri, UploadError, IMAGE_TYPES, DOC_TYPES };
