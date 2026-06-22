// Sanitises merchant-authored HTML/CSS produced by the GrapesJS editor before it
// is ever served on a public store page. This is the trust boundary for stored
// XSS: <script>, event handlers, <iframe>/<object>/<form>, javascript:/data: in
// links, @import and CSS expression()/behavior are all stripped.
const sanitizeHtmlLib = require("sanitize-html");

const ALLOWED_TAGS = [
  "div", "span", "p", "a", "ul", "ol", "li", "blockquote", "b", "i", "strong", "em",
  "u", "s", "small", "sub", "sup", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6",
  "img", "figure", "figcaption", "picture", "source", "video",
  "section", "header", "footer", "nav", "main", "article", "aside",
  "table", "thead", "tbody", "tfoot", "tr", "td", "th", "caption", "col", "colgroup",
  "button", "label", "details", "summary", "svg", "path", "g", "circle", "rect", "line", "polyline", "polygon",
];

// data-* attributes our dynamic placeholders use (e.g. the product grid marker).
const KB_DATA_ATTRS = ["data-kb", "data-source", "data-sort", "data-columns", "data-heading", "data-limit", "data-category"];

function scrubDangerTokens(s) {
  return String(s)
    .replace(/expression\s*\(/gi, "")
    .replace(/javascript\s*:/gi, "")
    .replace(/vbscript\s*:/gi, "")
    .replace(/behavior\s*:/gi, "")
    .replace(/-moz-binding/gi, "");
}

function sanitizeStoreHtmlString(html) {
  if (typeof html !== "string" || !html) return "";
  const cleaned = sanitizeHtmlLib(html.slice(0, 400000), {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: {
      "*": ["style", "class", "id", "title", "aria-label", "role", ...KB_DATA_ATTRS],
      a: ["href", "name", "target", "rel"],
      img: ["src", "alt", "width", "height", "loading"],
      video: ["src", "poster", "controls", "autoplay", "muted", "loop", "playsinline", "width", "height"],
      source: ["src", "type", "srcset", "media"],
      svg: ["viewbox", "viewBox", "width", "height", "fill", "xmlns", "preserveaspectratio"],
      path: ["d", "fill", "stroke", "stroke-width"],
      circle: ["cx", "cy", "r", "fill", "stroke"],
      rect: ["x", "y", "width", "height", "rx", "fill", "stroke"],
      line: ["x1", "y1", "x2", "y2", "stroke"],
      polyline: ["points", "fill", "stroke"],
      polygon: ["points", "fill", "stroke"],
    },
    allowedSchemes: ["http", "https", "mailto", "tel"],
    allowedSchemesByTag: { img: ["http", "https", "data"], source: ["http", "https", "data"], video: ["http", "https"] },
    allowProtocolRelative: false,
    // Keep inline styles (GrapesJS positions/colours via style); dangerous CSS
    // tokens are scrubbed afterwards.
    allowedStyles: undefined,
    transformTags: {
      a: (tagName, attribs) => {
        if (attribs.target === "_blank") attribs.rel = "noopener noreferrer";
        return { tagName: "a", attribs };
      },
    },
  });
  return scrubDangerTokens(cleaned);
}

function sanitizeStoreCssString(css) {
  if (typeof css !== "string" || !css) return "";
  let c = css.slice(0, 300000)
    .replace(/<\/?\s*style[^>]*>/gi, "") // no </style> breakout
    .replace(/[<>]/g, "")
    .replace(/@import[^;]*;?/gi, "")     // no external CSS
    .replace(/@charset[^;]*;?/gi, "");
  return scrubDangerTokens(c);
}

module.exports = { sanitizeStoreHtmlString, sanitizeStoreCssString };
