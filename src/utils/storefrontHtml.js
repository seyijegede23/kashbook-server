// Server-rendered HTML for the public merchant storefront ("get a website").
// Theme-driven (THEMES map, same idea as invoiceHtml.js's templates) + driven by
// the merchant's storeConfig (sections + visibility). CSP-safe: inline <style>
// (allowed) + product data in a <script type="application/json"> block + an
// external /store/store.js for cart/checkout (no inline JS).

const CURRENCY_SYMBOLS = {
  NGN: "₦", USD: "$", GBP: "£", EUR: "€", KES: "KSh ", GHS: "GH₵", ZAR: "R",
  UGX: "USh ", TZS: "TSh ", XOF: "CFA ", XAF: "FCFA ", RWF: "FRw ", EGP: "E£", MAD: "MAD ",
};
function money(n, currency = "NGN") {
  const sym = CURRENCY_SYMBOLS[currency] || `${currency} `;
  return sym + Number(n || 0).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// Theme presets — each tweaks typography + card styling on a shared layout.
const THEMES = {
  classic: { font: "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif", radius: "14px", shadow: "0 1px 3px rgba(0,0,0,.08)", heading: "700" },
  modern:  { font: "'Segoe UI',Roboto,Helvetica,Arial,sans-serif", radius: "20px", shadow: "0 8px 24px rgba(0,0,0,.10)", heading: "800" },
  minimal: { font: "Georgia,'Times New Roman',serif", radius: "6px", shadow: "none", heading: "600" },
};

const DEFAULTS = {
  layout: "grid", theme: "light", productSort: "recent",
  banner: { visible: true }, announcement: { visible: false }, about: { visible: false },
  contact: { visible: true }, socials: { visible: false }, whatsappChat: { visible: false },
  returnPolicy: { visible: false },
};
function cfg(business) {
  const c = (business.storeConfig && typeof business.storeConfig === "object") ? business.storeConfig : {};
  return {
    ...DEFAULTS, ...c,
    accentColor: c.accentColor || business.color || "#2563EB",
    banner: { ...DEFAULTS.banner, ...(c.banner || {}) },
    announcement: { ...DEFAULTS.announcement, ...(c.announcement || {}) },
    about: { ...DEFAULTS.about, ...(c.about || {}) },
    contact: { ...DEFAULTS.contact, ...(c.contact || {}) },
    socials: { ...DEFAULTS.socials, ...(c.socials || {}) },
    whatsappChat: { ...DEFAULTS.whatsappChat, ...(c.whatsappChat || {}) },
    returnPolicy: { ...DEFAULTS.returnPolicy, ...(c.returnPolicy || {}) },
  };
}

function sortItems(items, how) {
  const a = [...items];
  if (how === "price_asc") a.sort((x, y) => x.price - y.price);
  else if (how === "bestselling") a.sort((x, y) => (y.soldCount || 0) - (x.soldCount || 0));
  else a.sort((x, y) => new Date(y.createdAt) - new Date(x.createdAt)); // recent
  return a;
}

function pageCss(theme, t, accent, dark) {
  const bg = dark ? "#0c111b" : "#f6f7f9";
  const card = dark ? "#161d2b" : "#ffffff";
  const ink = dark ? "#eef2f7" : "#111827";
  const sub = dark ? "#9aa4b2" : "#6b7280";
  const line = dark ? "#243044" : "#eaecef";
  return `
  :root{--accent:${accent};--bg:${bg};--card:${card};--ink:${ink};--sub:${sub};--line:${line};--radius:${t.radius};--shadow:${t.shadow}}
  *{box-sizing:border-box} html,body{margin:0;padding:0}
  body{font-family:${t.font};background:var(--bg);color:var(--ink);-webkit-font-smoothing:antialiased}
  a{color:inherit;text-decoration:none}
  .wrap{max-width:1080px;margin:0 auto;padding:0 16px}
  .banner{width:100%;height:200px;object-fit:cover;display:block}
  .ann{background:var(--accent);color:#fff;text-align:center;padding:10px 16px;font-size:14px;font-weight:600}
  header.shop{display:flex;align-items:center;gap:14px;padding:20px 0}
  header.shop img.logo{width:60px;height:60px;border-radius:50%;object-fit:cover;border:1px solid var(--line)}
  header.shop .name{font-size:24px;font-weight:${t.heading}}
  header.shop .desc{color:var(--sub);font-size:14px;margin-top:2px}
  h2.sec{font-size:18px;font-weight:${t.heading};margin:26px 0 12px}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:14px}
  .list .grid{grid-template-columns:1fr}
  .list .card{display:flex;gap:12px;align-items:center}
  .list .card .ph{width:84px;height:84px;flex:none}
  .card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow);overflow:hidden;display:flex;flex-direction:column}
  .card .ph{width:100%;aspect-ratio:1/1;background:#e9edf2 center/cover no-repeat;display:flex;align-items:center;justify-content:center;color:#9aa4b2;font-size:28px}
  .card .body{padding:10px 12px;display:flex;flex-direction:column;gap:6px;flex:1}
  .card .pname{font-size:14px;font-weight:600;line-height:1.3}
  .card .price{font-weight:${t.heading};color:var(--accent)}
  .card .oos{font-size:12px;color:#ef4444;font-weight:600}
  .btn{background:var(--accent);color:#fff;border:0;border-radius:10px;padding:9px 12px;font-weight:700;font-size:14px;cursor:pointer}
  .btn[disabled]{opacity:.5}
  .muted{color:var(--sub);font-size:14px;line-height:1.6}
  .sectionbox{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:16px;margin-top:14px}
  footer{color:var(--sub);font-size:13px;text-align:center;padding:30px 0}
  /* cart bar + drawer */
  #cartbar{position:fixed;left:0;right:0;bottom:0;background:var(--accent);color:#fff;display:none;align-items:center;justify-content:space-between;padding:14px 18px;font-weight:700;cursor:pointer;z-index:30}
  .drawer{position:fixed;inset:0;background:rgba(0,0,0,.45);display:none;z-index:40;align-items:flex-end;justify-content:center}
  .drawer .panel{background:var(--card);width:100%;max-width:560px;border-radius:18px 18px 0 0;max-height:90vh;overflow:auto;padding:18px}
  .drawer h3{margin:0 0 12px;font-size:18px}
  .row{display:flex;justify-content:space-between;gap:10px;padding:8px 0;border-bottom:1px solid var(--line)}
  .inp{width:100%;border:1px solid var(--line);border-radius:10px;padding:11px;font-size:15px;margin-top:8px;background:transparent;color:var(--ink)}
  .qty{display:flex;align-items:center;gap:8px}
  .qty button{width:28px;height:28px;border-radius:8px;border:1px solid var(--line);background:transparent;color:var(--ink);font-size:16px;cursor:pointer}
  .wa-float{position:fixed;right:16px;bottom:80px;background:#25D366;color:#fff;width:52px;height:52px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:26px;box-shadow:0 6px 18px rgba(0,0,0,.25);z-index:25}
  .pill{display:inline-block;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:700}
  .socs a{display:inline-block;margin-right:14px;color:var(--accent);font-weight:600}
  `;
}

function productCard(p, currency) {
  const out = Number(p.quantity) <= 0;
  const img = p.image
    ? `<div class="ph" style="background-image:url('${esc(p.image)}')"></div>`
    : `<div class="ph">🛍️</div>`;
  return `<div class="card" data-id="${esc(p.id)}" data-name="${esc(p.name)}" data-price="${Number(p.price)}" data-stock="${Number(p.quantity)}">
    ${img}
    <div class="body">
      <div class="pname">${esc(p.name)}</div>
      <div class="price">${esc(money(p.price, currency))}</div>
      ${out ? `<div class="oos">Out of stock</div>` : `<button class="btn add" type="button">Add to cart</button>`}
    </div>
  </div>`;
}

function renderStorefront({ business, items, preview = false }) {
  const c = cfg(business);
  const t = THEMES[business.storeTemplate] || THEMES.classic;
  const dark = c.theme === "dark";
  const currency = business.baseCurrency || "NGN";
  const sorted = sortItems(items, c.productSort);

  // Group into collections by category (uncategorised last).
  const groups = {};
  for (const p of sorted) (groups[p.category || "All products"] ||= []).push(p);
  const collectionsHtml = Object.entries(groups).map(([cat, list]) =>
    `<h2 class="sec">${esc(cat)}</h2><div class="grid">${list.map((p) => productCard(p, currency)).join("")}</div>`
  ).join("") || `<p class="muted">No products yet — check back soon.</p>`;

  const waNumber = (c.whatsappChat.visible && c.whatsappChat.number) || business.storeContactPhone || "";
  const storeData = {
    slug: business.storeSlug,
    name: business.name,
    currency,
    whatsapp: waNumber ? String(waNumber).replace(/\D/g, "") : "",
    preview,
  };

  return `<!DOCTYPE html><html lang="en" class="${esc(business.storeTemplate || "classic")} ${c.layout === "list" ? "list" : ""}"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
${preview ? '<meta name="robots" content="noindex"/>' : ""}
<title>${esc(business.name)} — Online Store</title>
${business.logoUrl ? `<link rel="icon" href="${esc(business.logoUrl)}"/>` : ""}
<style>${pageCss(business.storeTemplate, t, c.accentColor, dark)}</style>
</head><body>
${c.announcement.visible && c.announcement.text ? `<div class="ann">${esc(c.announcement.text)}</div>` : ""}
${c.banner.visible && business.storeBannerUrl ? `<img class="banner" src="${esc(business.storeBannerUrl)}" alt=""/>` : ""}
<div class="wrap">
  <header class="shop">
    ${business.logoUrl ? `<img class="logo" src="${esc(business.logoUrl)}" alt=""/>` : `<div class="logo" style="display:flex;align-items:center;justify-content:center;font-size:28px;background:var(--card)">${esc(business.emoji || "🛍️")}</div>`}
    <div><div class="name">${esc(business.name)}</div>${business.storeDescription ? `<div class="desc">${esc(business.storeDescription)}</div>` : ""}</div>
  </header>

  ${collectionsHtml}

  ${c.about.visible && c.about.text ? `<div class="sectionbox"><h2 class="sec" style="margin-top:0">About us</h2><p class="muted">${esc(c.about.text)}</p></div>` : ""}
  ${c.contact.visible ? `<div class="sectionbox"><h2 class="sec" style="margin-top:0">Contact</h2><p class="muted">${[business.storeContactPhone, [business.addressLine1, business.addressCity, business.addressState].filter(Boolean).join(", ")].filter(Boolean).map(esc).join("<br/>") || "Reach us to place an order."}</p></div>` : ""}
  ${c.socials.visible ? `<div class="sectionbox socs"><h2 class="sec" style="margin-top:0">Follow us</h2>${["instagram","whatsapp","x","tiktok"].filter(k=>c.socials[k]).map(k=>`<a href="${esc(c.socials[k])}" target="_blank" rel="noopener">${k}</a>`).join("") || '<span class="muted">—</span>'}</div>` : ""}
  ${c.returnPolicy.visible && c.returnPolicy.text ? `<div class="sectionbox"><h2 class="sec" style="margin-top:0">Return policy</h2><p class="muted">${esc(c.returnPolicy.text)}</p></div>` : ""}

  <footer>Powered by KashBook${preview ? " · PREVIEW" : ""}</footer>
</div>

${waNumber ? `<a class="wa-float" href="https://wa.me/${esc(storeData.whatsapp)}" target="_blank" rel="noopener" aria-label="Chat on WhatsApp">💬</a>` : ""}
<div id="cartbar"><span id="cartcount">0 items</span><span id="carttotal"></span></div>
<div class="drawer" id="drawer"><div class="panel" id="panel"></div></div>

<script type="application/json" id="store-data">${JSON.stringify(storeData)}</script>
<script src="/store/store.js"></script>
</body></html>`;
}

function statusPill(status) {
  const map = { PENDING: ["#fef3c7", "#92400e", "Awaiting payment"], PAID: ["#dcfce7", "#166534", "Paid"], FULFILLED: ["#dbeafe", "#1e40af", "Fulfilled"], CANCELLED: ["#fee2e2", "#991b1b", "Cancelled"] };
  const [bg, fg, label] = map[status] || map.PENDING;
  return `<span class="pill" style="background:${bg};color:${fg}">${label}</span>`;
}

function renderOrderStatus({ business, order }) {
  const t = THEMES[business.storeTemplate] || THEMES.classic;
  const c = cfg(business);
  const currency = order.currency || business.baseCurrency || "NGN";
  const itemsHtml = (order.items || []).map((i) =>
    `<div class="row"><span>${esc(i.name)} × ${i.quantity}</span><span>${esc(money(i.amount, currency))}</span></div>`).join("");
  const unpaid = order.status === "PENDING";
  const hasBank = !!business.virtualAccountNumber;
  const pay = unpaid && hasBank ? `
    <div class="sectionbox">
      <h2 class="sec" style="margin-top:0">Pay ${esc(money(order.total, currency))}</h2>
      <p class="muted">Transfer the exact amount to:</p>
      <div class="row"><span>Bank</span><b>${esc(business.virtualAccountBank || "—")}</b></div>
      <div class="row"><span>Account number</span><b>${esc(business.virtualAccountNumber)}</b></div>
      <div class="row"><span>Account name</span><b>${esc(business.virtualAccountName || business.name)}</b></div>
      <div class="row"><span>Use as reference</span><b>${esc(order.paymentReference)}</b></div>
      <p class="muted" style="margin-top:10px">This page updates automatically once your payment is confirmed.</p>
    </div>` : unpaid ? `<div class="sectionbox"><p class="muted">The seller will contact you with payment details.</p></div>` : "";

  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta name="robots" content="noindex"/>
<title>Order ${esc(order.orderNumber)} — ${esc(business.name)}</title>
<style>${pageCss(business.storeTemplate, t, c.accentColor, c.theme === "dark")} body{padding:0 0 40px}</style>
</head><body>
<div class="wrap" style="max-width:560px">
  <header class="shop"><div><div class="name">${esc(business.name)}</div><div class="desc">Order ${esc(order.orderNumber)} · ${statusPill(order.status)}</div></div></header>
  <div class="sectionbox" style="margin-top:0">
    ${itemsHtml}
    <div class="row" style="border-bottom:0;font-weight:800"><span>Total</span><span>${esc(money(order.total, currency))}</span></div>
  </div>
  ${pay}
  <footer>Powered by KashBook</footer>
</div>
</body></html>`;
}

function notFound(msg = "Store not found") {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${esc(msg)}</title><style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f6f7f9;color:#111827;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}.b{text-align:center}.b p{color:#6b7280}</style>
</head><body><div class="b"><h1>${esc(msg)}</h1><p>This online store isn't available.</p></div></body></html>`;
}

module.exports = { renderStorefront, renderOrderStatus, notFound, money, _cfg: cfg };
