  const BASE = window.location.origin;
  let token = localStorage.getItem("kb_admin_token") || null;
  let allUsers = [];
  let notifyTargetUserId = null;
  let revenueChart = null;

  // ── Auth ──────────────────────────────────────────────────────────────
  document.getElementById("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email    = document.getElementById("email").value;
    const password = document.getElementById("password").value;
    const errEl    = document.getElementById("loginError");
    errEl.classList.add("hidden");

    try {
      const res  = await fetch(`${BASE}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: email, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Login failed");

      if (data.user?.role !== "ADMIN") throw new Error("Access denied. Admin accounts only.");
      token = data.token;
      localStorage.setItem("kb_admin_token", token);
      document.getElementById("adminName").textContent = data.user?.name || email;
      await showDashboard();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.remove("hidden");
    }
  });

  function logout() {
    localStorage.removeItem("kb_admin_token");
    token = null;
    document.getElementById("dashboard").classList.add("hidden");
    document.getElementById("loginScreen").classList.remove("hidden");
  }

  function showError(msg) {
    const el = document.getElementById("globalError");
    document.getElementById("globalErrorMsg").textContent = msg;
    el.classList.remove("hidden");
    setTimeout(() => el.classList.add("hidden"), 8000);
  }

  async function apiFetch(path, opts = {}) {
    const res = await fetch(`${BASE}${path}`, {
      ...opts,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...(opts.headers || {}),
      },
    });
    if (res.status === 403) throw new Error("Not authorised — admin role required");
    if (res.status === 401) { logout(); throw new Error("Session expired"); }
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  // ── Dashboard ─────────────────────────────────────────────────────────
  async function showDashboard() {
    document.getElementById("loginScreen").classList.add("hidden");
    document.getElementById("dashboard").classList.remove("hidden");
    await Promise.all([loadStats(), loadUsers(), loadRevenue(), loadActivity(), loadFlags(), loadAudit(), loadHealth(), loadAnalytics()]);
  }

  async function loadStats() {
    try {
      const s = await apiFetch("/admin-api/stats");
      document.getElementById("statTotalUsers").textContent = s.totalUsers.toLocaleString();
      document.getElementById("statPremium").textContent    = s.premiumUsers.toLocaleString();
      document.getElementById("statNewToday").textContent   = s.newToday.toLocaleString();
      document.getElementById("statInvoices").textContent   = s.totalInvoices.toLocaleString();
      document.getElementById("statRevenue").textContent    = formatMoney(s.totalRevenue);
    } catch (err) {
      showError("Failed to load stats: " + err.message);
    }
  }

  // ── Observability: health, errors, analytics ──────────────────────────────
  function fmtDur(s) {
    if (s < 60) return s + "s";
    if (s < 3600) return Math.floor(s / 60) + "m";
    if (s < 86400) return Math.floor(s / 3600) + "h";
    return Math.floor(s / 86400) + "d";
  }

  async function loadHealth() {
    try {
      const [h, m] = await Promise.all([apiFetch("/admin-api/health"), apiFetch("/admin-api/metrics")]);
      const card = (label, value, tone = "text-gray-900") =>
        `<div class="rounded-xl border border-gray-100 p-3"><p class="text-xs text-gray-500">${label}</p><p class="text-lg font-bold ${tone}">${value}</p></div>`;
      const poolBusy = h.pool.total - h.pool.idle;
      document.getElementById("healthCards").innerHTML = [
        card("Uptime", fmtDur(h.uptimeSec)),
        card("Memory", h.memory.rssMB + " MB"),
        card("Event-loop lag", h.eventLoopLagMs + " ms", h.eventLoopLagMs > 100 ? "text-red-600" : "text-gray-900"),
        card("DB", h.db.ok ? h.db.latencyMs + " ms" : "DOWN", h.db.ok ? "text-gray-900" : "text-red-600"),
        card("Pool", `${poolBusy}/${h.pool.max} busy${h.pool.waiting ? ` · ${h.pool.waiting} waiting` : ""}`, h.pool.waiting ? "text-red-600" : "text-gray-900"),
        card("Requests", (m.totalRequests || 0).toLocaleString()),
        card("5xx rate", (m.errorRate5xx || 0) + "%", m.errorRate5xx >= 5 ? "text-red-600" : "text-gray-900"),
        card("Failed ops (24h)", h.errors.failed24h, h.errors.failed24h > 0 ? "text-amber-600" : "text-gray-900"),
      ].join("");
      const crons = (h.crons || [])
        .map((c) => `<span class="inline-block mr-3 ${c.stale ? "text-red-600 font-semibold" : ""}">${esc(c.name)}: ${c.ageMin}m ago${c.stale ? " ⚠ stale" : ""}</span>`)
        .join("");
      document.getElementById("healthCrons").innerHTML = crons ? "Crons — " + crons : "Crons — none have reported yet";
    } catch (err) {
      showError("Failed to load health: " + err.message);
    }
  }

  let analyticsChart;
  async function loadAnalytics() {
    try {
      const [{ history }, s] = await Promise.all([apiFetch("/admin-api/analytics?days=30"), apiFetch("/admin-api/stats")]);
      const latest = history.length ? history[history.length - 1].data : {};
      const card = (l, v) => `<div class="rounded-xl border border-gray-100 p-3"><p class="text-xs text-gray-500">${l}</p><p class="text-lg font-bold text-gray-900">${v}</p></div>`;
      document.getElementById("analyticsCards").innerHTML = [
        card("Total users", (s.totalUsers || 0).toLocaleString()),
        card("Premium", (s.premiumUsers || 0).toLocaleString()),
        card("Active businesses", latest.activeBusinesses ?? "—"),
        card("Conversion", (latest.conversionPct ?? 0) + "%"),
      ].join("");
      const ctx = document.getElementById("analyticsChart").getContext("2d");
      const labels = history.map((h) => new Date(h.takenAt).toLocaleDateString(undefined, { month: "short", day: "numeric" }));
      if (analyticsChart) analyticsChart.destroy();
      analyticsChart = new Chart(ctx, {
        type: "line",
        data: { labels, datasets: [{ label: "Total users", data: history.map((h) => h.data.totalUsers || 0), borderColor: "#4f46e5", backgroundColor: "rgba(79,70,229,0.1)", tension: 0.3, fill: true }] },
        options: { responsive: true, plugins: { legend: { display: true } } },
      });
    } catch (err) {
      showError("Failed to load analytics: " + err.message);
    }
  }

  document.getElementById("refreshHealthBtn")?.addEventListener("click", loadHealth);

  async function loadUsers() {
    try {
      allUsers = await apiFetch("/admin-api/users");
      renderUsers(allUsers);
    } catch (err) {
      console.error(err);
    }
  }

  function renderUsers(users) {
    const tbody = document.getElementById("usersTableBody");
    const noEl  = document.getElementById("noUsers");
    tbody.innerHTML = "";

    if (!users.length) {
      noEl.classList.remove("hidden");
      return;
    }
    noEl.classList.add("hidden");

    users.forEach((u) => {
      const tr = document.createElement("tr");
      tr.className = "hover:bg-gray-50";
      const safeId = esc(u.id);
      const safePlan = esc(u.plan);
      const safeName = esc(u.name);
      tr.innerHTML = `
        <td class="py-3 pr-4 font-medium text-gray-800">${safeName}</td>
        <td class="py-3 pr-4 text-gray-500">${esc(u.email)}</td>
        <td class="py-3 pr-4">
          <span class="px-2.5 py-0.5 rounded-full text-xs font-semibold ${u.plan === 'PREMIUM' ? 'badge-premium' : 'badge-free'}">
            ${safePlan}
          </span>
          ${u.role === 'ADMIN' ? '<span class="ml-1 px-2.5 py-0.5 rounded-full text-xs font-semibold badge-admin">ADMIN</span>' : ''}
          ${u.accountStatus === 'frozen' ? '<span class="ml-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-red-100 text-red-700">FROZEN</span>' : ''}
        </td>
        <td class="py-3 pr-4 text-gray-600">${Number(u.businessCount)}</td>
        <td class="py-3 pr-4 text-gray-500">${new Date(u.createdAt).toLocaleDateString()}</td>
        <td class="py-3 flex items-center gap-2">
          ${u.role !== 'ADMIN' ? (u.plan !== 'PREMIUM'
            ? `<button data-action="upgrade" data-id="${safeId}"
                class="text-xs bg-amber-500 hover:bg-amber-600 text-white font-semibold px-3 py-1.5 rounded-lg transition">
                Upgrade
               </button>`
            : `<button data-action="downgrade" data-id="${safeId}"
                class="text-xs bg-gray-200 hover:bg-gray-300 text-gray-700 font-semibold px-3 py-1.5 rounded-lg transition">
                Downgrade
               </button>`) : ''}
          <button data-action="notify" data-id="${safeId}" data-name="${safeName}"
            class="text-xs bg-indigo-100 hover:bg-indigo-200 text-indigo-700 font-semibold px-3 py-1.5 rounded-lg transition">
            Notify
          </button>
          ${u.role !== 'ADMIN' ? (u.accountStatus === 'frozen'
            ? `<button data-action="unfreeze" data-id="${safeId}"
                class="text-xs bg-emerald-100 hover:bg-emerald-200 text-emerald-700 font-semibold px-3 py-1.5 rounded-lg transition">
                Unfreeze
               </button>`
            : `<button data-action="freeze" data-id="${safeId}"
                class="text-xs bg-red-100 hover:bg-red-200 text-red-700 font-semibold px-3 py-1.5 rounded-lg transition">
                Freeze
               </button>`) : ''}
        </td>
      `;
      tbody.appendChild(tr);
    });
  }

  function filterUsers() {
    const q = document.getElementById("userSearch").value.toLowerCase();
    renderUsers(allUsers.filter((u) =>
      u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q)
    ));
  }

  async function upgradeUser(userId, btn) {
    btn.disabled = true;
    btn.textContent = "…";
    try {
      await apiFetch(`/admin-api/users/${userId}/upgrade`, { method: "PATCH" });
      const u = allUsers.find((x) => x.id === userId);
      if (u) u.plan = "PREMIUM";
      renderUsers(allUsers);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = "Upgrade";
      showError("Upgrade failed: " + err.message);
    }
  }

  async function downgradeUser(userId, btn) {
    if (!confirm("Downgrade this user to FREE?")) return;
    btn.disabled = true;
    btn.textContent = "…";
    try {
      await apiFetch(`/admin-api/users/${userId}/downgrade`, { method: "PATCH" });
      const u = allUsers.find((x) => x.id === userId);
      if (u) u.plan = "FREE";
      renderUsers(allUsers);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = "Downgrade";
      showError("Downgrade failed: " + err.message);
    }
  }

  // Freeze blocks transfers and flags the account (AML §8). A reason is
  // mandatory — it lands in complianceFreezeReason + the audit trail.
  async function freezeUser(userId, btn) {
    const reason = prompt("Freeze reason (required — goes to the audit trail):");
    if (!reason || !reason.trim()) return;
    btn.disabled = true;
    btn.textContent = "…";
    try {
      await apiFetch(`/admin-api/users/${userId}/freeze`, {
        method: "POST",
        body: JSON.stringify({ reason: reason.trim() }),
      });
      const u = allUsers.find((x) => x.id === userId);
      if (u) u.accountStatus = "frozen";
      renderUsers(allUsers);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = "Freeze";
      showError("Freeze failed: " + err.message);
    }
  }

  async function unfreezeUser(userId, btn) {
    const note = prompt("Unfreeze note (optional — for the audit trail):") || "";
    if (!confirm("Restore this account to active? Transfers will be re-enabled immediately.")) return;
    btn.disabled = true;
    btn.textContent = "…";
    try {
      await apiFetch(`/admin-api/users/${userId}/unfreeze`, {
        method: "POST",
        body: JSON.stringify({ note: note.trim() }),
      });
      const u = allUsers.find((x) => x.id === userId);
      if (u) u.accountStatus = "active";
      renderUsers(allUsers);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = "Unfreeze";
      showError("Unfreeze failed: " + err.message);
    }
  }

  // ── Per-user notification ─────────────────────────────────────────────
  function openNotifyPanel(userId, name) {
    notifyTargetUserId = userId;
    document.getElementById("notifyUserName").textContent = name;
    document.getElementById("notifyUserPanel").classList.remove("hidden");
    document.getElementById("userNotifyTitle").focus();
  }

  function closeNotifyPanel() {
    notifyTargetUserId = null;
    document.getElementById("notifyUserPanel").classList.add("hidden");
    document.getElementById("userNotifyTitle").value = "";
    document.getElementById("userNotifyBody").value  = "";
  }

  async function sendUserNotification() {
    const title = document.getElementById("userNotifyTitle").value.trim();
    const body  = document.getElementById("userNotifyBody").value.trim();
    if (!title || !body) return alert("Title and message required");
    try {
      const r = await apiFetch("/admin-api/notify", {
        method: "POST",
        body: JSON.stringify({ userId: notifyTargetUserId, title, body }),
      });
      closeNotifyPanel();
      alert(`Notification saved! Delivered to ${r.saved} user(s).`);
    } catch (err) {
      alert(err.message);
    }
  }

  // ── Broadcast notification ────────────────────────────────────────────
  async function sendBroadcast() {
    const title   = document.getElementById("broadcastTitle").value.trim();
    const body    = document.getElementById("broadcastBody").value.trim();
    const succEl  = document.getElementById("notifySuccess");
    const errEl2  = document.getElementById("notifyError");
    succEl.classList.add("hidden");
    errEl2.classList.add("hidden");
    if (!title || !body) { errEl2.textContent = "Title and message required"; errEl2.classList.remove("hidden"); return; }
    try {
      const r = await apiFetch("/admin-api/notify", {
        method: "POST",
        body: JSON.stringify({ title, body }),
      });
      succEl.textContent = `Notification saved! ✓  Delivered to ${r.saved} user(s).`;
      succEl.classList.remove("hidden");
      document.getElementById("broadcastTitle").value = "";
      document.getElementById("broadcastBody").value  = "";
    } catch (err) {
      errEl2.textContent = err.message;
      errEl2.classList.remove("hidden");
    }
  }

  // ── Revenue chart ─────────────────────────────────────────────────────
  async function loadRevenue() {
    try {
      const data = await apiFetch("/admin-api/revenue");
      const labels = data.map((d) => {
        const dt = new Date(d.date);
        return dt.toLocaleDateString("en-US", { month: "short", day: "numeric" });
      });
      const totals = data.map((d) => d.total);

      const ctx = document.getElementById("revenueChart").getContext("2d");
      if (revenueChart) revenueChart.destroy();
      revenueChart = new Chart(ctx, {
        type: "bar",
        data: {
          labels,
          datasets: [{
            label: "Revenue",
            data: totals,
            backgroundColor: "rgba(99, 102, 241, 0.7)",
            borderRadius: 6,
          }],
        },
        options: {
          responsive: true,
          plugins: { legend: { display: false } },
          scales: {
            y: { beginAtZero: true, grid: { color: "#F3F4F6" } },
            x: { grid: { display: false } },
          },
        },
      });
    } catch (err) {
      console.error("Revenue chart error:", err);
    }
  }

  // ── Activity feed ─────────────────────────────────────────────────────
  async function loadActivity() {
    try {
      const items = await apiFetch("/admin-api/activity");
      const feed  = document.getElementById("activityFeed");
      feed.innerHTML = "";
      items.forEach((t) => {
        const isIncome = t.type === "income";
        const div = document.createElement("div");
        div.className = "flex items-center justify-between py-2 border-b border-gray-50 last:border-0";
        div.innerHTML = `
          <div class="flex items-center gap-3">
            <div class="w-8 h-8 rounded-full flex items-center justify-center text-sm
              ${isIncome ? 'bg-emerald-100 text-emerald-600' : 'bg-red-100 text-red-500'}">
              ${isIncome ? '↑' : '↓'}
            </div>
            <div>
              <p class="text-sm font-medium text-gray-800">${esc(t.description || '—')}</p>
              <p class="text-xs text-gray-400">${esc(t.businessName)} · ${esc(t.userName)}</p>
            </div>
          </div>
          <div class="text-right">
            <p class="text-sm font-semibold ${isIncome ? 'text-emerald-600' : 'text-red-500'}">
              ${isIncome ? '+' : '-'}${formatMoney(t.amount, t.currency)}
            </p>
            <p class="text-xs text-gray-400">${new Date(t.date).toLocaleDateString()}</p>
          </div>
        `;
        feed.appendChild(div);
      });
    } catch (err) {
      console.error("Activity error:", err);
    }
  }

  // ── Compliance Queue ──────────────────────────────────────────────────
  async function loadFlags() {
    try {
      const status   = document.getElementById("flagStatusFilter").value || "open";
      const severity = document.getElementById("flagSeverityFilter").value || "";
      const qs = new URLSearchParams({ status, ...(severity ? { severity } : {}) });
      const flags = await apiFetch(`/admin-api/compliance/flags?${qs}`);
      const list = document.getElementById("flagsList");
      const empty = document.getElementById("noFlags");
      list.innerHTML = "";
      if (!flags.length) {
        empty.classList.remove("hidden");
        return;
      }
      empty.classList.add("hidden");
      const sevColor = { high: "red", medium: "amber", low: "gray" };
      flags.forEach((f) => {
        const c = sevColor[f.severity] || "gray";
        const userName = f.user ? esc(`${f.user.firstName || ""} ${f.user.lastName || ""}`.trim() || f.user.email) : "—";
        const txAmount = f.transaction ? formatMoney(f.transaction.amount, f.transaction.currency) : "";
        const card = document.createElement("div");
        card.className = `border border-${c}-200 bg-${c}-50/40 rounded-xl p-4`;
        card.innerHTML = `
          <div class="flex items-start justify-between gap-4">
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 mb-1">
                <span class="text-xs font-bold uppercase tracking-wide text-${c}-700 bg-${c}-100 px-2 py-0.5 rounded">${esc(f.severity)}</span>
                <span class="text-xs font-bold text-gray-700">${esc(f.ruleCode)}</span>
                <span class="text-xs text-gray-400">· ${new Date(f.createdAt).toLocaleString()}</span>
              </div>
              <p class="text-sm font-medium text-gray-800 mb-1">${esc(f.description)}</p>
              <p class="text-xs text-gray-500">
                ${userName}
                ${f.business ? ` · ${countryFlag(f.business.country)} ${esc(f.business.name)} (${esc(f.business.riskCategory || "standard")} risk)` : ""}
                ${txAmount ? ` · ${txAmount}` : ""}
              </p>
            </div>
            <div class="flex flex-col gap-1 shrink-0">
              <button data-flag-id="${f.id}" data-status="cleared"   class="flag-action px-3 py-1 text-xs font-semibold rounded bg-emerald-100 text-emerald-700 hover:bg-emerald-200">Clear</button>
              <button data-flag-id="${f.id}" data-status="escalated" class="flag-action px-3 py-1 text-xs font-semibold rounded bg-amber-100 text-amber-700 hover:bg-amber-200">Escalate</button>
              <button data-flag-id="${f.id}" data-status="frozen"    data-user-id="${esc(f.userId)}" class="flag-action px-3 py-1 text-xs font-semibold rounded bg-red-100 text-red-700 hover:bg-red-200">Freeze User</button>
            </div>
          </div>
        `;
        list.appendChild(card);
      });
      list.querySelectorAll(".flag-action").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const id = btn.dataset.flagId;
          const newStatus = btn.dataset.status;
          const note = prompt(`Reviewer note for ${newStatus}:`, "");
          if (note === null) return;
          try {
            await apiFetch(`/admin-api/compliance/flags/${id}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ status: newStatus, reviewerNote: note }),
            });
            if (newStatus === "frozen" && btn.dataset.userId) {
              await apiFetch(`/admin-api/users/${btn.dataset.userId}/freeze`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ reason: note || "Frozen via compliance queue" }),
              });
            }
            await loadFlags();
          } catch (err) {
            alert("Failed: " + err.message);
          }
        });
      });
    } catch (err) {
      console.error("Flags error:", err);
    }
  }

  document.getElementById("refreshFlagsBtn")?.addEventListener("click", loadFlags);
  document.getElementById("flagStatusFilter")?.addEventListener("change", loadFlags);
  document.getElementById("flagSeverityFilter")?.addEventListener("change", loadFlags);

  // ── Audit Log ─────────────────────────────────────────────────────────
  async function loadAudit() {
    try {
      const actorId = document.getElementById("auditActorFilter").value.trim();
      const action  = document.getElementById("auditActionFilter").value.trim();
      const qs = new URLSearchParams({
        ...(actorId ? { actorId } : {}),
        ...(action  ? { action  } : {}),
        limit: "100",
      });
      const rows = await apiFetch(`/admin-api/audit-log?${qs}`);
      const list = document.getElementById("auditList");
      list.innerHTML = "";
      rows.forEach((r) => {
        const sev = r.severity === "alert" ? "text-red-600" : r.severity === "warn" ? "text-amber-600" : "text-gray-600";
        const row = document.createElement("div");
        row.className = `${sev} py-1 border-b border-gray-50 last:border-0`;
        row.innerHTML = `
          <span class="text-gray-400">${new Date(r.createdAt).toLocaleString()}</span>
          <span class="font-bold ml-2">${esc(r.action)}</span>
          <span class="text-gray-500 ml-2">${esc(r.actorType)}:${esc(r.actorId || "—").slice(0, 8)}</span>
          <span class="text-gray-500 ml-2">${esc(r.resourceType || "")}:${esc((r.resourceId || "").slice(0, 8))}</span>
          ${r.metadata ? `<span class="text-gray-400 ml-2">${esc(JSON.stringify(r.metadata)).slice(0, 80)}</span>` : ""}
        `;
        list.appendChild(row);
      });
    } catch (err) {
      console.error("Audit error:", err);
    }
  }

  document.getElementById("refreshAuditBtn")?.addEventListener("click", loadAudit);

  // ── Helpers ───────────────────────────────────────────────────────────
  // ISO 4217 → display symbol for the markets KashBook serves. Anything
  // unmapped falls back to "CODE " (e.g. "XOF 5.0K") rather than a wrong
  // symbol. Default NGN — the platform's home market.
  const CURRENCY_SYMBOLS = {
    NGN: "₦", USD: "$", KES: "KSh ", GHS: "GH₵", ZAR: "R",
    EGP: "E£", GBP: "£", EUR: "€",
  };
  function formatMoney(n, currency = "NGN") {
    const sym = CURRENCY_SYMBOLS[currency] ?? `${currency} `;
    if (n >= 1_000_000) return sym + (n / 1_000_000).toFixed(1) + "M";
    if (n >= 1_000)     return sym + (n / 1_000).toFixed(1) + "K";
    return sym + Number(n || 0).toFixed(2);
  }

  function esc(str) {
    return String(str || "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // Convert a 2-char ISO country code into the flag emoji.
  function countryFlag(cca2) {
    if (!cca2 || cca2.length !== 2) return "";
    return String.fromCodePoint(
      ...[...cca2.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65),
    );
  }

  // ── Wire DOM controls (CSP-safe: no inline handlers) ──────────────────────
  document.getElementById("logoutBtn")?.addEventListener("click", logout);
  document.getElementById("dismissErrorBtn")?.addEventListener("click", () =>
    document.getElementById("globalError").classList.add("hidden"));
  document.getElementById("broadcastBtn")?.addEventListener("click", sendBroadcast);
  document.getElementById("userSearch")?.addEventListener("input", filterUsers);
  document.getElementById("userNotifySendBtn")?.addEventListener("click", sendUserNotification);
  document.getElementById("userNotifyCancelBtn")?.addEventListener("click", closeNotifyPanel);

  // Delegated handler for the dynamically-rendered user-row action buttons
  // (replaces the former inline onclick handlers).
  document.getElementById("usersTableBody")?.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const id = btn.dataset.id;
    switch (btn.dataset.action) {
      case "upgrade":   return upgradeUser(id, btn);
      case "downgrade": return downgradeUser(id, btn);
      case "notify":    return openNotifyPanel(id, btn.dataset.name);
      case "freeze":    return freezeUser(id, btn);
      case "unfreeze":  return unfreezeUser(id, btn);
    }
  });

  // ── Auto-login if token exists ─────────────────────────────────────────
  if (token) {
    showDashboard().catch(() => {
      localStorage.removeItem("kb_admin_token");
      token = null;
    });
  }
