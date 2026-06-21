// Public storefront cart + checkout (CSP-safe: external, no inline handlers).
// Reads embedded store data, manages a localStorage cart, and posts orders.
(function () {
  "use strict";
  var data = {};
  try { data = JSON.parse(document.getElementById("store-data").textContent || "{}"); } catch (e) {}
  var SYMBOLS = { NGN: "₦", USD: "$", GBP: "£", EUR: "€", KES: "KSh ", GHS: "GH₵", ZAR: "R", UGX: "USh ", TZS: "TSh ", XOF: "CFA ", XAF: "FCFA ", RWF: "FRw ", EGP: "E£", MAD: "MAD " };
  var sym = SYMBOLS[data.currency] || (data.currency + " ");
  var KEY = "kb_cart_" + (data.slug || "store");
  function money(n) { return sym + Number(n || 0).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

  var cart = {};
  try { cart = JSON.parse(localStorage.getItem(KEY) || "{}"); } catch (e) { cart = {}; }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(cart)); } catch (e) {} }
  function count() { return Object.keys(cart).reduce(function (s, id) { return s + cart[id].qty; }, 0); }
  function total() { return Object.keys(cart).reduce(function (s, id) { return s + cart[id].qty * cart[id].price; }, 0); }

  var bar = document.getElementById("cartbar");
  var drawer = document.getElementById("drawer");
  var panel = document.getElementById("panel");

  function refreshBar() {
    var n = count();
    document.getElementById("cartcount").textContent = n + (n === 1 ? " item" : " items");
    document.getElementById("carttotal").textContent = money(total());
    bar.style.display = n > 0 ? "flex" : "none";
  }

  // Add-to-cart (event delegation on product cards)
  document.addEventListener("click", function (e) {
    var btn = e.target.closest && e.target.closest(".add");
    if (!btn) return;
    var card = btn.closest(".card");
    if (!card) return;
    var id = card.getAttribute("data-id");
    var stock = Number(card.getAttribute("data-stock"));
    var cur = cart[id] ? cart[id].qty : 0;
    if (cur >= stock) return;
    cart[id] = { id: id, name: card.getAttribute("data-name"), price: Number(card.getAttribute("data-price")), qty: cur + 1, stock: stock };
    save(); refreshBar();
    btn.textContent = "Added ✓"; setTimeout(function () { btn.textContent = "Add to cart"; }, 900);
  });

  bar.addEventListener("click", openCart);
  drawer.addEventListener("click", function (e) { if (e.target === drawer) closeDrawer(); });
  function closeDrawer() { drawer.style.display = "none"; }
  function openDrawer() { drawer.style.display = "flex"; }

  function openCart() {
    var ids = Object.keys(cart);
    if (!ids.length) return;
    var rows = ids.map(function (id) {
      var it = cart[id];
      return '<div class="row"><span>' + escapeHtml(it.name) + '</span><span class="qty">' +
        '<button data-dec="' + id + '">−</button>' + it.qty + '<button data-inc="' + id + '">+</button>' +
        '<b style="margin-left:10px">' + money(it.qty * it.price) + "</b></span></div>";
    }).join("");
    panel.innerHTML =
      "<h3>Your cart</h3>" + rows +
      '<div class="row" style="font-weight:800;border-bottom:0"><span>Total</span><span>' + money(total()) + "</span></div>" +
      '<button class="btn" id="toCheckout" style="width:100%;margin-top:14px">Checkout</button>' +
      '<button class="btn" id="closeC" style="width:100%;margin-top:8px;background:transparent;color:var(--sub);border:1px solid var(--line)">Keep shopping</button>';
    openDrawer();
    panel.querySelector("#closeC").onclick = closeDrawer;
    panel.querySelector("#toCheckout").onclick = openCheckout;
    panel.querySelectorAll("[data-inc]").forEach(function (b) { b.onclick = function () { var id = b.getAttribute("data-inc"); if (cart[id].qty < cart[id].stock) { cart[id].qty++; save(); refreshBar(); openCart(); } }; });
    panel.querySelectorAll("[data-dec]").forEach(function (b) { b.onclick = function () { var id = b.getAttribute("data-dec"); cart[id].qty--; if (cart[id].qty <= 0) delete cart[id]; save(); refreshBar(); if (count()) openCart(); else closeDrawer(); }; });
  }

  function openCheckout() {
    panel.innerHTML =
      "<h3>Your details</h3>" +
      '<input class="inp" id="cName" placeholder="Full name" autocomplete="name"/>' +
      '<input class="inp" id="cPhone" placeholder="Phone number" inputmode="tel" autocomplete="tel"/>' +
      '<input class="inp" id="cEmail" placeholder="Email (optional)" inputmode="email"/>' +
      '<input class="inp" id="cAddr" placeholder="Delivery address (optional)"/>' +
      '<textarea class="inp" id="cNote" placeholder="Order note (optional)" rows="2"></textarea>' +
      '<div class="row" style="font-weight:800;border-bottom:0;margin-top:8px"><span>Total</span><span>' + money(total()) + "</span></div>" +
      '<div id="cErr" style="color:#ef4444;font-size:13px;margin-top:8px"></div>' +
      '<button class="btn" id="placeBtn" style="width:100%;margin-top:12px">Place order</button>' +
      '<button class="btn" id="backC" style="width:100%;margin-top:8px;background:transparent;color:var(--sub);border:1px solid var(--line)">Back</button>';
    panel.querySelector("#backC").onclick = openCart;
    panel.querySelector("#placeBtn").onclick = placeOrder;
  }

  function placeOrder() {
    var name = val("cName"), phone = val("cPhone");
    var err = panel.querySelector("#cErr");
    if (!name || !phone) { err.textContent = "Name and phone are required."; return; }
    var btn = panel.querySelector("#placeBtn");
    btn.disabled = true; btn.textContent = "Placing…";
    var body = {
      customerName: name, customerPhone: phone,
      customerEmail: val("cEmail"), deliveryAddress: val("cAddr"), note: val("cNote"),
      items: Object.keys(cart).map(function (id) { return { id: id, quantity: cart[id].qty }; }),
    };
    fetch("/store/" + encodeURIComponent(data.slug) + "/orders", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (!res.ok) { err.textContent = (res.j && res.j.error) || "Could not place order."; btn.disabled = false; btn.textContent = "Place order"; return; }
        cart = {}; save(); refreshBar();
        showPaid(res.j);
      })
      .catch(function () { err.textContent = "Network error. Please try again."; btn.disabled = false; btn.textContent = "Place order"; });
  }

  function showPaid(o) {
    var bank = o.bank;
    var pay = bank
      ? '<p class="muted">Transfer <b>' + money(o.total) + "</b> to:</p>" +
        '<div class="row"><span>Bank</span><b>' + escapeHtml(bank.bankName || "-") + "</b></div>" +
        '<div class="row"><span>Account number</span><b>' + escapeHtml(bank.accountNumber) + "</b></div>" +
        '<div class="row"><span>Account name</span><b>' + escapeHtml(bank.accountName || "") + "</b></div>" +
        '<div class="row"><span>Reference</span><b>' + escapeHtml(o.paymentReference) + "</b></div>"
      : '<p class="muted">The seller will contact you with payment details.</p>';
    panel.innerHTML =
      "<h3>Order placed 🎉</h3>" +
      '<p class="muted">Order <b>' + escapeHtml(o.orderNumber) + "</b></p>" + pay +
      '<a class="btn" id="trackBtn" style="display:block;text-align:center;width:100%;margin-top:14px" href="' + escapeHtml(o.statusUrl) + '">View order status</a>' +
      '<button class="btn" id="doneC" style="width:100%;margin-top:8px;background:transparent;color:var(--sub);border:1px solid var(--line)">Done</button>';
    panel.querySelector("#doneC").onclick = closeDrawer;
  }

  function val(id) { var el = panel.querySelector("#" + id); return el ? el.value.trim() : ""; }
  function escapeHtml(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

  refreshBar();
})();
