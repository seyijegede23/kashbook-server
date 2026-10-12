// Where an expense's receipts are kept (Zoho-style expenses, 2026-10-12):
// on Cloudinary under a random public_id, with delivery type "authenticated":
// the original AND every derived version (a resized image, say) need a
// signature, and none can be made on the fly without one. Type "private",
// which the KYB certificate uses (routes/businesses.js, upload-cac), signs
// only the original: Cloudinary serves derived versions of a private asset
// publicly unless Strict Transformations is on, and a receipt's public_id is
// inside the link that opens it. A link to open one is minted on demand for
// ten minutes. Expense.attachments keeps each file's publicId and
// resourceType; they never leave the server (utils/expenseView.js).
//
// What is NOT done here: removing a photo's EXIF or GPS data. Cloudinary
// keeps an uploaded original as it came (it strips metadata only from the
// versions it transforms), and the server has no image library; the app
// re-encodes a photo before sending it, which drops that data.
//
// `storage` is the seam. The two calls that reach Cloudinary go through it, so
// the e2e test (scripts/expense-details-e2e-test.js) replaces them with
// in-memory ones and checks the options they get; in production they are
// Cloudinary's own calls, unchanged. Minting a link is a local signature (no
// request), so it is not part of the seam.
const crypto = require("crypto");
const cloudinary = require("../config/cloudinary");

const MAX_RECEIPTS = 5;
const RECEIPT_MAX_BYTES = 8 * 1024 * 1024;
const RECEIPT_LINK_SECONDS = 10 * 60;
// Cloudinary's delivery type for every receipt: the upload, the link and the
// removal must all name it.
const RECEIPT_TYPE = "authenticated";

const storage = {
  upload: (file, options) => cloudinary.uploader.upload(file, options),
  destroy: (publicId, options) => cloudinary.uploader.destroy(publicId, options),
};

// Keep one file the upload guard has already checked (validateDataUri's
// { resourceType }). Returns where it went: { publicId, resourceType }.
async function saveReceipt(fileBase64, meta) {
  const up = await storage.upload(fileBase64, {
    folder: "kashbook/receipts",
    public_id: `receipt_${crypto.randomUUID()}`,
    overwrite: false,
    resource_type: meta.resourceType,
    type: RECEIPT_TYPE,
  });
  if (!up || !up.public_id) throw new Error("the upload returned no public_id");
  return { publicId: up.public_id, resourceType: meta.resourceType };
}

// Remove stored receipts, best effort: a file that fails to go is logged and
// stays on Cloudinary, and never fails the request that removed it (the
// expense, or the receipt on it, is already gone from the books). Resolves
// once every attempt has settled; callers need not wait for it.
function destroyReceipts(list, why) {
  const jobs = (Array.isArray(list) ? list : [])
    .filter((a) => a && a.publicId)
    .map((a) =>
      Promise.resolve()
        .then(() =>
          storage.destroy(a.publicId, { type: RECEIPT_TYPE, resource_type: a.resourceType || "image", invalidate: true }),
        )
        .catch((e) => console.warn(`[receipts] ${a.publicId} not removed (${why}): ${(e && e.message) || e}`)),
    );
  return Promise.all(jobs);
}

// A link that opens one receipt for ten minutes: Cloudinary's signed download
// URL (its download API, which serves the stored original), minted as
// routes/fcyDocs.js mints its own. → { url, expiresAt (ISO) }.
function receiptLink(receipt, seconds = RECEIPT_LINK_SECONDS) {
  const expiresAt = Math.floor(Date.now() / 1000) + seconds;
  const url = cloudinary.utils.private_download_url(receipt.publicId, null, {
    resource_type: receipt.resourceType || "image",
    type: RECEIPT_TYPE,
    expires_at: expiresAt,
  });
  return { url, expiresAt: new Date(expiresAt * 1000).toISOString() };
}

module.exports = {
  MAX_RECEIPTS,
  RECEIPT_MAX_BYTES,
  RECEIPT_LINK_SECONDS,
  RECEIPT_TYPE,
  storage,
  saveReceipt,
  destroyReceipts,
  receiptLink,
};
