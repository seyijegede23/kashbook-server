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

// ── Content verification ────────────────────────────────────────────────────
// The declared MIME in a data URI is attacker-controlled, so it proves nothing.
// Verify the actual bytes: "image/png" carrying an HTML/SVG payload would
// otherwise be stored and later served/opened as whatever it really is.
const MAGIC = {
  "image/png":  (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  "image/jpeg": (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "image/webp": (b) => b.length > 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP",
  "application/pdf": (b) => b.subarray(0, 5).toString("latin1") === "%PDF-",
};
MAGIC["image/jpg"] = MAGIC["image/jpeg"];

// PDFs are documents AND a scripting host. A KYB certificate never needs any of
// this, and these files are forwarded to Anchor's reviewers, so anything active
// is rejected rather than "sanitised" — rewriting a PDF to strip actions is
// error-prone and can silently corrupt a legitimate document. The user simply
// re-exports a clean PDF (any "Print to PDF" produces one).
const PDF_ACTIVE_CONTENT = [
  { token: "/JavaScript", label: "JavaScript" },
  { token: "/JS", label: "JavaScript" },
  { token: "/OpenAction", label: "an auto-run action" },
  { token: "/AA", label: "an automatic action" },
  { token: "/Launch", label: "a launch action" },
  { token: "/EmbeddedFile", label: "an embedded file" },
  { token: "/RichMedia", label: "embedded media" },
  { token: "/XFA", label: "an XFA form" },
  { token: "/SubmitForm", label: "a form submission action" },
];

function inspectPdf(buf) {
  // Scan as latin1 so byte offsets line up with the tokens we're looking for.
  const text = buf.toString("latin1");
  if (/\/Encrypt[\s\d<]/.test(text)) {
    throw new UploadError(
      "Password-protected PDFs can't be accepted. Please upload an unprotected copy.",
      "UPLOAD_PDF_ENCRYPTED",
    );
  }
  for (const { token, label } of PDF_ACTIVE_CONTENT) {
    // Token must appear as a PDF name (followed by a delimiter), so "/JS" does
    // not match inside e.g. "/JSomething".
    const re = new RegExp(`\\${token}(?![A-Za-z0-9])`);
    if (re.test(text)) {
      throw new UploadError(
        `This PDF contains ${label} and can't be accepted. Please re-save it as a plain PDF (for example, print to PDF) and upload again.`,
        "UPLOAD_PDF_ACTIVE_CONTENT",
      );
    }
  }
  if (!/%%EOF/.test(text.slice(-2048))) {
    throw new UploadError("This PDF looks incomplete or corrupted.", "UPLOAD_PDF_MALFORMED");
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
  // Decoded size, not the base64 length. Check BEFORE decoding so an oversized
  // payload is rejected without allocating it.
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

  // The declared MIME is attacker-controlled — verify the real bytes.
  const buf = Buffer.from(b64, "base64");
  const check = MAGIC[mime];
  if (!check || !check(buf)) {
    throw new UploadError(
      "The file contents don't match its type. Please upload a valid file.",
      "UPLOAD_CONTENT_MISMATCH",
    );
  }
  if (mime === "application/pdf") inspectPdf(buf);

  return { mime, bytes, resourceType: RESOURCE_TYPE[mime] || RESOURCE_TYPE.default };
}

module.exports = { validateDataUri, UploadError, IMAGE_TYPES, DOC_TYPES };
