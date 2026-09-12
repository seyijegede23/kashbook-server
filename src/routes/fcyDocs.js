// GET|HEAD /fcy-docs/<token>.<ext>
//
// Serves a KYC document to Fincra. See utils/fcyDocLink.js for why this exists
// at all: the document has to come back looking like a normal file (right
// Content-Type, inline, extension in the path) or Fincra declines the account
// request with "Unable to retrieve one or more documents from url".
//
// No authentication: Fincra's fetcher carries none. The protection is the
// token, an HMAC over the exact asset and an expiry, so a link is unguessable,
// time-boxed, and pinned to one document. Anything else is a 404 that looks
// the same whether the token was tampered with, expired, or never existed.
//
// The Cloudinary asset stays private. We fetch it server-side with a
// five-minute download URL minted per request and stream the bytes on; no
// Cloudinary URL is ever handed to a third party.
const express = require("express");
const cloudinary = require("../config/cloudinary");
const { verifyDocLink, extFor } = require("../utils/fcyDocLink");

async function fetchFromCloudinary({ publicId, resourceType }, method) {
  const url = cloudinary.utils.private_download_url(publicId, null, {
    resource_type: resourceType,
    type: "private",
    expires_at: Math.floor(Date.now() / 1000) + 5 * 60,
  });
  const r = await fetch(url, { method, redirect: "follow" });
  if (!r.ok) return null;
  const length = Number(r.headers.get("content-length")) || null;
  if (method === "HEAD") return { length, body: null };
  const body = Buffer.from(await r.arrayBuffer());
  return { length: body.length, body };
}

// `fetchAsset` is injectable so the route can be tested without Cloudinary.
function createFcyDocsRouter({ fetchAsset = fetchFromCloudinary } = {}) {
  const router = express.Router();

  const handle = async (req, res) => {
    const file = String(req.params.file || "");
    const dot = file.lastIndexOf(".");
    const token = dot > 0 ? file.slice(0, dot) : "";
    const ext = dot > 0 ? file.slice(dot + 1).toLowerCase() : "";
    const link = verifyDocLink(token);
    // The extension is part of what was signed (it derives from the mime), so
    // a link cannot be re-labelled from .pdf to .jpg or vice versa.
    if (!link || extFor(link.mime, link.resourceType) !== ext) {
      console.warn(`[fcy-docs] refused ${req.method} …${file.slice(-16)} (${link ? "extension mismatch" : "bad or expired token"})`);
      return res.status(404).json({ error: "Not found" });
    }
    const method = req.method === "HEAD" ? "HEAD" : "GET";
    let asset = null;
    try {
      asset = await fetchAsset(link, method);
    } catch (e) {
      console.error(`[fcy-docs] fetch failed for ${link.publicId}: ${e.message}`);
    }
    if (!asset) {
      console.warn(`[fcy-docs] asset missing for ${link.publicId}`);
      return res.status(404).json({ error: "Not found" });
    }
    res.set({
      "Content-Type": link.mime,
      "Content-Disposition": `inline; filename="document.${ext}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    });
    if (asset.length) res.set("Content-Length", String(asset.length));
    console.log(`[fcy-docs] served ${method} ${link.publicId} ${link.mime} ${asset.length ?? "?"}B`);
    if (method === "HEAD") return res.status(200).end();
    return res.status(200).send(asset.body);
  };

  router.get("/:file", handle);
  router.head("/:file", handle);
  return router;
}

module.exports = createFcyDocsRouter;
module.exports.createFcyDocsRouter = createFcyDocsRouter;
