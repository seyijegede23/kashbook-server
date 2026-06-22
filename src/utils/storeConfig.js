// Canonical storefront block-document model (storeConfig v2).
//
// The merchant's store is a versioned, ordered, typed BLOCK document stored in
// Business.storeConfig (Prisma Json). This module is the SERVER source of truth
// for that shape: it (a) upgrades legacy flat configs to v2 on read, and (b)
// sanitizes any v2 document on the write path (the editor saves through here).
//
// The Next.js storefront app has its own copy of the *rendering* (theme tokens +
// React block components); this file only owns the data contract + validation.
//
// Block shape: { id, type, visible, props, style, layout? }
//   - props:  typed, per-type content (primitives / enums / urls / lists) — NEVER raw HTML.
//   - style:  small whitelisted presentation tokens (enums) mapped to CSS by the renderer.
//   - layout: optional free-form geometry per breakpoint for the Wix-style canvas:
//             { desktop:{x,y,w,h,z,rotate}, tablet?:{…}, mobile?:{…} }. Absent = flow layout.

const crypto = require("crypto");

const SCHEMA_VERSION = 2;

// Premium theme presets understood by the Next.js renderer (lib/themes.js).
const TEMPLATES = ["aurora", "noir", "bloom", "classic", "minimal"];
// Legacy storeTemplate values → premium equivalents.
const LEGACY_TEMPLATE_MAP = { classic: "classic", modern: "aurora", minimal: "minimal" };

const THEME_MODES = ["light", "dark"];
const DENSITIES = ["compact", "comfortable", "spacious"];
const PRODUCT_SORTS = ["recent", "bestselling", "price_asc", "price_desc"];

// Full block catalog. `dynamic` blocks are hydrated with live inventory/reviews
// at render time (only the query is stored, never product snapshots).
const BLOCK_DEFS = {
  // --- static content blocks ---
  announcement: { props: { text: "text" } },
  hero: { props: { title: "text", subtitle: "longtext", imageUrl: "image", ctaLabel: "text", ctaTarget: "url", overlay: "number", align: "enum:left,center,right" } },
  "rich-text": { props: { heading: "text", body: "longtext", align: "enum:left,center,right" } },
  image: { props: { url: "image", alt: "text", caption: "text", link: "url" } },
  button: { props: { label: "text", href: "url", variant: "enum:solid,outline,ghost" } },
  shape: { props: { kind: "enum:rectangle,ellipse,line", color: "color" } },
  "video-embed": { props: { url: "url", title: "text" } },
  gallery: { props: { heading: "text", items: "list:image" } },
  testimonials: { props: { heading: "text", items: "list:testimonial" } },
  faq: { props: { heading: "text", items: "list:qa" } },
  "cta-banner": { props: { title: "text", body: "longtext", ctaLabel: "text", ctaTarget: "url" } },
  contact: { props: { heading: "text", phone: "text", address: "longtext", email: "text", useBusinessDefaults: "bool" } },
  socials: { props: { heading: "text", instagram: "url", whatsapp: "url", x: "url", tiktok: "url", facebook: "url" } },
  "return-policy": { props: { heading: "text", body: "longtext" } },
  divider: { props: { size: "enum:sm,md,lg" } },
  spacer: { props: { size: "enum:sm,md,lg,xl" } },
  // --- dynamic / data-bound blocks ---
  "product-grid": { props: { heading: "text", source: "enum:all,category", category: "text", sort: "enum:recent,bestselling,price_asc,price_desc", columns: "enum:auto,2,3,4", layout: "enum:grid,list", showSearch: "bool", showCategoryTabs: "bool", limit: "number" } },
  "featured-products": { props: { heading: "text", productIds: "list:id", limit: "number" } },
  "category-showcase": { props: { heading: "text", category: "text", limit: "number" } },
  reviews: { props: { heading: "text", minRating: "number", limit: "number" } },
};
const BLOCK_TYPES = Object.keys(BLOCK_DEFS);

// Style tokens allowed on any block (presentation, mapped to CSS classes/vars by renderer).
const STYLE_DEFS = {
  paddingTop: "enum:none,sm,md,lg,xl",
  paddingBottom: "enum:none,sm,md,lg,xl",
  bg: "enum:none,card,accent,muted",
  textColor: "color",
  bgColor: "color",
  align: "enum:left,center,right",
  maxWidth: "enum:narrow,normal,wide,full",
  rounded: "enum:none,sm,md,lg,full",
};

// Blocks gated behind Premium (free stores still render them if already present,
// but the editor won't let Free users add them and the save path strips new ones).
const PREMIUM_BLOCK_TYPES = ["gallery", "testimonials", "faq", "cta-banner", "video-embed", "featured-products", "category-showcase"];

// ── small helpers ─────────────────────────────────────────────────────────────
function blockId() { return "blk_" + crypto.randomBytes(6).toString("hex"); }
function hexOk(s) { return typeof s === "string" && /^#[0-9a-fA-F]{3,8}$/.test(s); }
function clampStr(s, n) { return String(s == null ? "" : s).slice(0, n); }
function asObj(v) { return v && typeof v === "object" && !Array.isArray(v) ? v : {}; }

function safeUrl(u) {
  if (!u) return "";
  const s = String(u).trim().slice(0, 2000);
  if (!s) return "";
  if (/^javascript:/i.test(s) || /^vbscript:/i.test(s)) return "";
  if (/^data:image\//i.test(s)) return s;           // inline images ok
  if (/^data:/i.test(s)) return "";                  // any other data: rejected
  if (/^(https?:|mailto:|tel:)/i.test(s)) return s;  // safe absolute
  if (/^[#/]/.test(s)) return s;                      // same-site relative / anchors
  return "";
}

// ── prop / style coercion ─────────────────────────────────────────────────────
function coerceValue(kind, value) {
  if (kind === "text") return clampStr(value, 300);
  if (kind === "longtext") return clampStr(value, 5000);
  if (kind === "url" || kind === "image") return safeUrl(value);
  if (kind === "color") return hexOk(value) ? value : undefined;
  if (kind === "bool") return !!value;
  if (kind === "id") return clampStr(value, 64) || undefined;
  if (kind === "number") {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(-100000, Math.min(100000, n)) : undefined;
  }
  if (kind.startsWith("enum:")) {
    const opts = kind.slice(5).split(",");
    return opts.includes(value) ? value : opts[0];
  }
  if (kind.startsWith("list:")) {
    if (!Array.isArray(value)) return [];
    const sub = kind.slice(5);
    return value.slice(0, 30).map((entry) => coerceListEntry(sub, entry)).filter(Boolean);
  }
  return undefined;
}

function coerceListEntry(sub, entry) {
  if (sub === "image") {
    const o = asObj(entry);
    const url = safeUrl(o.url || entry);
    if (!url) return null;
    return { url, alt: clampStr(o.alt, 200), caption: clampStr(o.caption, 200) };
  }
  if (sub === "testimonial") {
    const o = asObj(entry);
    const quote = clampStr(o.quote, 1000);
    if (!quote) return null;
    return { quote, author: clampStr(o.author, 120) };
  }
  if (sub === "qa") {
    const o = asObj(entry);
    const q = clampStr(o.q, 300);
    if (!q) return null;
    return { q, a: clampStr(o.a, 2000) };
  }
  if (sub === "id") {
    const id = clampStr(entry, 64);
    return id || null;
  }
  return null;
}

function sanitizeProps(type, rawProps) {
  const def = BLOCK_DEFS[type];
  const out = {};
  const raw = asObj(rawProps);
  for (const [key, kind] of Object.entries(def.props)) {
    if (raw[key] === undefined) continue;
    const v = coerceValue(kind, raw[key]);
    if (v !== undefined) out[key] = v;
  }
  return out;
}

function sanitizeStyle(rawStyle) {
  const out = {};
  const raw = asObj(rawStyle);
  for (const [key, kind] of Object.entries(STYLE_DEFS)) {
    if (raw[key] === undefined) continue;
    const v = coerceValue(kind, raw[key]);
    if (v !== undefined) out[key] = v;
  }
  return out;
}

function sanitizeGeom(g) {
  const o = asObj(g);
  const num = (v, min, max, dflt) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return dflt;
    return Math.max(min, Math.min(max, n));
  };
  const out = {};
  if (o.x !== undefined) out.x = num(o.x, -5000, 10000, 0);
  if (o.y !== undefined) out.y = num(o.y, -5000, 100000, 0);
  if (o.w !== undefined) out.w = num(o.w, 0, 10000, 0);
  if (o.h !== undefined) out.h = num(o.h, 0, 100000, 0);
  if (o.z !== undefined) out.z = num(o.z, 0, 9999, 0);
  if (o.rotate !== undefined) out.rotate = num(o.rotate, -360, 360, 0);
  return Object.keys(out).length ? out : undefined;
}

function sanitizeLayout(rawLayout) {
  const raw = asObj(rawLayout);
  const out = {};
  for (const bp of ["desktop", "tablet", "mobile"]) {
    if (raw[bp] === undefined) continue;
    const g = sanitizeGeom(raw[bp]);
    if (g) out[bp] = g;
  }
  return Object.keys(out).length ? out : undefined;
}

// ── public: sanitize a v2 document on the write path ──────────────────────────
function sanitizeStoreDoc(rawDoc, { isPro = true, existingTypes = [] } = {}) {
  const raw = asObj(rawDoc);
  const theme = asObj(raw.theme);
  const template = TEMPLATES.includes(theme.template) ? theme.template : "aurora";
  const out = {
    version: SCHEMA_VERSION,
    theme: {
      template,
      mode: THEME_MODES.includes(theme.mode) ? theme.mode : "light",
      accentColor: hexOk(theme.accentColor) ? theme.accentColor : "#2563EB",
      density: DENSITIES.includes(theme.density) ? theme.density : "comfortable",
    },
    blocks: [],
  };
  const existing = new Set(existingTypes);
  const blocks = Array.isArray(raw.blocks) ? raw.blocks.slice(0, 80) : [];
  for (const b of blocks) {
    const block = asObj(b);
    const type = block.type;
    if (!BLOCK_TYPES.includes(type)) continue;
    // Free users may keep premium blocks that already exist, but can't ADD new ones.
    if (!isPro && PREMIUM_BLOCK_TYPES.includes(type) && !existing.has(type)) continue;
    const node = {
      id: typeof block.id === "string" && /^[\w-]{1,64}$/.test(block.id) ? block.id : blockId(),
      type,
      visible: block.visible !== false,
      props: sanitizeProps(type, block.props),
      style: sanitizeStyle(block.style),
    };
    const layout = sanitizeLayout(block.layout);
    if (layout) node.layout = layout;
    out.blocks.push(node);
  }
  return out;
}

// ── public: upgrade a legacy flat config (or pass through v2) ──────────────────
function mkBlock(type, props, opts = {}) {
  const node = { id: opts.id || blockId(), type, visible: opts.visible !== false, props: props || {}, style: opts.style || {} };
  return node;
}

function upgradeStoreConfig(rawConfig, business = {}) {
  // Already v2 → return as-is (callers may still want sanitize separately).
  if (rawConfig && typeof rawConfig === "object" && Number(rawConfig.version) >= 2 && Array.isArray(rawConfig.blocks)) {
    return rawConfig;
  }
  const c = asObj(rawConfig);
  const sec = (k) => asObj(c[k]);
  const blocks = [];

  const ann = sec("announcement");
  if (ann.text) blocks.push(mkBlock("announcement", { text: clampStr(ann.text, 300) }, { visible: ann.visible !== false }));

  // Hero from the legacy banner + business identity.
  const banner = sec("banner");
  blocks.push(mkBlock("hero", {
    title: clampStr(business.name || "", 300),
    subtitle: clampStr(business.storeDescription || banner.description || "", 5000),
    imageUrl: safeUrl(business.storeBannerUrl || banner.imageUrl || ""),
    ctaLabel: "Shop now",
    ctaTarget: "#products",
    overlay: 0.35,
    align: "center",
  }, { visible: banner.visible !== false }));

  // The product catalog.
  blocks.push(mkBlock("product-grid", {
    heading: "Products",
    source: "all",
    sort: PRODUCT_SORTS.includes(c.productSort) ? c.productSort : "recent",
    columns: "auto",
    layout: c.layout === "list" ? "list" : "grid",
    showSearch: true,
    showCategoryTabs: true,
  }, { visible: true }));

  const about = sec("about");
  if (about.text) blocks.push(mkBlock("rich-text", { heading: "About us", body: clampStr(about.text, 5000), align: "left" }, { visible: about.visible !== false }));

  const contact = sec("contact");
  blocks.push(mkBlock("contact", {
    heading: "Contact",
    phone: clampStr(contact.phone || business.storeContactPhone || "", 300),
    address: clampStr(contact.address || "", 5000),
    useBusinessDefaults: !contact.phone && !contact.address,
  }, { visible: contact.visible !== false }));

  const socials = sec("socials");
  if (socials.instagram || socials.whatsapp || socials.x || socials.tiktok) {
    blocks.push(mkBlock("socials", {
      heading: "Follow us",
      instagram: safeUrl(socials.instagram), whatsapp: safeUrl(socials.whatsapp),
      x: safeUrl(socials.x), tiktok: safeUrl(socials.tiktok),
    }, { visible: socials.visible !== false }));
  }

  const ret = sec("returnPolicy");
  if (ret.text) blocks.push(mkBlock("return-policy", { heading: "Return policy", body: clampStr(ret.text, 5000) }, { visible: ret.visible !== false }));

  const legacyTpl = LEGACY_TEMPLATE_MAP[business.storeTemplate] || "aurora";
  return {
    version: SCHEMA_VERSION,
    theme: {
      template: legacyTpl,
      mode: c.theme === "dark" ? "dark" : "light",
      accentColor: hexOk(c.accentColor) ? c.accentColor : (business.color || "#2563EB"),
      density: "comfortable",
    },
    blocks,
    // Carry the legacy floating-WhatsApp setting as chrome config (renderer reads it).
    chrome: { whatsappChat: asObj(c.whatsappChat) },
  };
}

module.exports = {
  SCHEMA_VERSION,
  TEMPLATES,
  BLOCK_TYPES,
  BLOCK_DEFS,
  STYLE_DEFS,
  PREMIUM_BLOCK_TYPES,
  upgradeStoreConfig,
  sanitizeStoreDoc,
  blockId,
  hexOk,
  safeUrl,
};
