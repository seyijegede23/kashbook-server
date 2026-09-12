// Signed, expiring links for the KYC documents Fincra fetches.
//
// WHY THIS EXISTS
//   Fincra retrieves `utilityBill` and `meansOfId` from the URLs in the account
//   request, synchronously, and validates what comes back. The first live
//   request (2026-09-12) was declined with "Unable to retrieve one or more
//   documents from url" even though every link answered HTTP 200 to a plain
//   fetch. The difference was WHAT came back: PDFs are stored on Cloudinary as
//   `raw`, and Cloudinary serves raw assets as application/octet-stream with
//   Content-Disposition: attachment and no file extension. Fincra's own example
//   documents are S3 links ending in .pdf. A fetcher that checks the type of the
//   document it retrieved rejects ours.
//
//   So documents are now served by US, through routes/fcyDocs.js, at a link that
//   looks exactly like the example: .../fcy-docs/<token>.pdf, with the real
//   content type, inline, HEAD supported, no Cloudinary anywhere in it. The
//   token is an HMAC over the Cloudinary public_id, resource type, mime and an
//   expiry, so a link is unguessable, expires, and cannot be re-pointed at
//   another asset.
//
//   TTL is deliberately long. Fincra does not fetch once and finish: a reviewer
//   can re-open the document during a manual review that the docs put at 1 to
//   24 hours, sometimes longer. A short TTL yields a decline for a document we
//   did upload correctly, which is worse than the exposure of a URL that is
//   already unguessable and time-boxed.
const crypto = require("crypto");

const EXT = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

// The extension a link ends in, from the document's mime. Unknown mimes fall
// back by resource type so a link is never extension-less.
function extFor(mime, resourceType = "image") {
  return EXT[mime] || (resourceType === "raw" ? "pdf" : "jpg");
}

function secret() {
  const s = process.env.FCY_DOC_SECRET || process.env.JWT_SECRET;
  if (!s || String(s).length < 32) {
    throw new Error("FCY_DOC_SECRET or JWT_SECRET (32+ characters) is required to sign document links");
  }
  return String(s);
}

// Where Fincra will fetch from. PUBLIC_BASE_URL is the app's convention for
// public links (invoices, Instagram callbacks); RENDER_EXTERNAL_URL is set by
// Render on every web service, so production works without new configuration.
function publicBase() {
  const b = process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || "https://server-kashbook.onrender.com";
  return String(b).replace(/\/+$/, "");
}

const hmac = (body) => crypto.createHmac("sha256", secret()).update(body).digest("base64url");

/**
 * Mint the URL Fincra will fetch.
 * @param {object} a
 * @param {string} a.publicId      Cloudinary public_id (private asset)
 * @param {string} a.resourceType  "image" | "raw"
 * @param {string} a.mime          the validated upload mime (drives extension + Content-Type)
 * @param {number} a.ttlDays       default 14
 * @returns {string|null}
 */
function signDocLink({ publicId, resourceType = "image", mime, ttlDays = 14, now = Date.now() } = {}) {
  if (!publicId) return null;
  const ext = extFor(mime, resourceType);
  const m = mime || (ext === "pdf" ? "application/pdf" : "image/jpeg");
  const payload = JSON.stringify({ p: publicId, r: resourceType, m, e: Math.floor(now / 1000) + ttlDays * 86400 });
  const body = Buffer.from(payload, "utf8").toString("base64url");
  return `${publicBase()}/fcy-docs/${body}.${hmac(body)}.${ext}`;
}

/**
 * Verify a token (the path segment WITHOUT its extension). Returns the asset
 * to serve, or null for anything tampered, malformed, unsigned or expired.
 * Never throws: a bad link is a 404, not a 500.
 */
function verifyDocLink(token, { now = Date.now() } = {}) {
  if (typeof token !== "string" || token.length > 2048) return null;
  const i = token.lastIndexOf(".");
  if (i <= 0 || i === token.length - 1) return null;
  const body = token.slice(0, i);
  const sig = token.slice(i + 1);
  let expected;
  try { expected = hmac(body); } catch { return null; }
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch { return null; }
  if (!payload || typeof payload.p !== "string" || !payload.p) return null;
  if (!(Number(payload.e) > 0) || Number(payload.e) * 1000 < now) return null;
  return {
    publicId: payload.p,
    resourceType: payload.r === "raw" ? "raw" : "image",
    mime: typeof payload.m === "string" && payload.m ? payload.m : "application/octet-stream",
    expiresAt: Number(payload.e),
  };
}

module.exports = { signDocLink, verifyDocLink, extFor, publicBase };
