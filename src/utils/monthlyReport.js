// Monthly P&L report email — a PREMIUM feature. Sent on the 1st of each month
// for the PREVIOUS Africa/Lagos calendar month (WAT, UTC+1, no DST), to every
// PREMIUM owner who had at least one transaction that month. One email per
// owner, a section per active business: money in / out, net profit, transaction
// count, month-over-month income change, estimated VAT (when the business
// enabled it) and the top expense categories.
//
// Runs from server.js (cron key 4009); manually triggerable via
// POST /admin-api/run-monthly-report. Rendering uses the shared hardened email
// layout (utils/emailLayout.js); delivery uses the transactional mailbox
// (utils/transactionEmail.getTransport). NEVER throws — reporting must not
// affect anything else.

const prisma = require("./db");
const { renderEmail, txnRow, escHtml } = require("./emailLayout");
const { getTransport } = require("./transactionEmail");

const WAT_OFFSET_MS = 60 * 60 * 1000; // UTC+1, fixed

const CURRENCY_SYMBOLS = {
  NGN: "₦", USD: "$", KES: "KSh ", GHS: "GH₵", ZAR: "R", EGP: "E£", GBP: "£", EUR: "€",
};
function money(amount, currency = "NGN") {
  const sym = CURRENCY_SYMBOLS[currency] || `${currency} `;
  return sym + Number(amount || 0).toLocaleString("en-NG", { maximumFractionDigits: 0 });
}

// [start, end) of the month `offset` months before the current Lagos month,
// plus a human label ("June 2026"). offset=1 → last month.
function lagosMonthRange(offset = 1, now = new Date()) {
  const lagos = new Date(now.getTime() + WAT_OFFSET_MS);
  const y = lagos.getUTCFullYear();
  const m = lagos.getUTCMonth();
  const start = new Date(Date.UTC(y, m - offset, 1) - WAT_OFFSET_MS);
  const end = new Date(Date.UTC(y, m - offset + 1, 1) - WAT_OFFSET_MS);
  const label = new Date(Date.UTC(y, m - offset, 1)).toLocaleDateString("en-GB", {
    month: "long", year: "numeric", timeZone: "UTC",
  });
  return { start, end, label };
}

// Aggregate the month for every business, plus the month before for the
// comparison line. Returns per-user payloads (only users with activity).
async function computeMonthlyData(offset = 1, now = new Date()) {
  const range = lagosMonthRange(offset, now);
  const prev = lagosMonthRange(offset + 1, now);

  const businesses = await prisma.business.findMany({
    select: {
      id: true, name: true, userId: true, baseCurrency: true,
      vatEnabled: true, vatRate: true, vatInclusive: true,
    },
  });
  if (businesses.length === 0) return { range, users: [] };
  const bizIds = businesses.map((b) => b.id);

  const [grouped, prevGrouped, expenseCats] = await Promise.all([
    prisma.transaction.groupBy({
      by: ["businessId", "type"],
      where: { businessId: { in: bizIds }, date: { gte: range.start, lt: range.end } },
      _sum: { amount: true },
      _count: { _all: true },
    }),
    prisma.transaction.groupBy({
      by: ["businessId", "type"],
      where: { businessId: { in: bizIds }, date: { gte: prev.start, lt: prev.end } },
      _sum: { amount: true },
    }),
    prisma.transaction.groupBy({
      by: ["businessId", "category"],
      where: { businessId: { in: bizIds }, type: "expense", date: { gte: range.start, lt: range.end } },
      _sum: { amount: true },
    }),
  ]);

  const stats = new Map(); // businessId -> { income, expense, count, prevIncome, cats: [] }
  const get = (id) => {
    if (!stats.has(id)) stats.set(id, { income: 0, expense: 0, count: 0, prevIncome: 0, cats: [] });
    return stats.get(id);
  };
  for (const g of grouped) {
    const s = get(g.businessId);
    if (g.type === "income") s.income += g._sum.amount || 0;
    else if (g.type === "expense") s.expense += g._sum.amount || 0;
    s.count += g._count._all;
  }
  for (const g of prevGrouped) {
    if (g.type === "income") get(g.businessId).prevIncome += g._sum.amount || 0;
  }
  for (const g of expenseCats) {
    if (g._sum.amount > 0) get(g.businessId).cats.push({ category: g.category || "other", amount: g._sum.amount });
  }
  for (const s of stats.values()) s.cats.sort((a, b) => b.amount - a.amount);

  // Group active businesses per owner.
  const byUser = new Map();
  for (const b of businesses) {
    const s = stats.get(b.id);
    if (!s || s.count === 0) continue; // silent months don't get a section
    if (!byUser.has(b.userId)) byUser.set(b.userId, []);
    byUser.get(b.userId).push({ business: b, stats: s });
  }
  if (byUser.size === 0) return { range, users: [] };

  // PREMIUM gate: the monthly P&L is a paid feature — only PREMIUM owners are
  // selected (same string filter the admin stats use). Free owners simply get
  // no email; there's no request context here, so this is the whole gate.
  const owners = await prisma.user.findMany({
    where: { id: { in: [...byUser.keys()] }, plan: "PREMIUM" },
    select: { id: true, email: true, firstName: true },
  });

  const users = [];
  for (const u of owners) {
    if (!u.email) continue;
    users.push({ user: u, sections: byUser.get(u.id) });
  }
  return { range, users };
}

// Estimated VAT on the month's income, honouring the business's inclusive flag.
function estimatedVat(b, income) {
  if (!b.vatEnabled || !income) return null;
  const r = (Number(b.vatRate) > 0 ? Number(b.vatRate) : 7.5) / 100;
  const vat = b.vatInclusive === false ? income * r : income * (r / (1 + r));
  return vat > 0 ? vat : null;
}

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

// One business section: name, big net figure, then the detail rows.
function businessSection({ business, stats }, isFirst) {
  const cur = business.baseCurrency || "NGN";
  const net = stats.income - stats.expense;
  const positive = net >= 0;
  const accent = positive ? "#059669" : "#DC2626";
  const netStr = `${positive ? "+" : "−"}${money(Math.abs(net), cur)}`;

  let momRow = "";
  if (stats.prevIncome > 0) {
    const delta = ((stats.income - stats.prevIncome) / stats.prevIncome) * 100;
    const arrow = delta >= 0 ? "▲" : "▼";
    momRow = txnRow("Income vs last month", `${arrow} ${Math.abs(delta).toFixed(0)}%`);
  }

  const vat = estimatedVat(business, stats.income);
  const topCats = stats.cats.slice(0, 3)
    .map((c) => `${c.category} ${money(c.amount, cur)}`)
    .join(" · ");

  return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:${isFirst ? "0" : "30px"} 0 0 0;">
<tr><td>
<p class="kb-sub" style="margin:0 0 4px 0;font-family:${FONT};font-size:13px;font-weight:600;color:#71717A;text-transform:uppercase;letter-spacing:0.6px;">${escHtml(business.name)}</p>
<p class="kb-amount" style="margin:0 0 4px 0;font-family:${FONT};font-size:30px;font-weight:800;letter-spacing:-0.5px;line-height:1.1;"><span style="color:${accent};">${escHtml(netStr)}</span></p>
<p class="kb-faint" style="margin:0 0 14px 0;font-family:${FONT};font-size:13px;color:#A1A1AA;">net profit</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
${txnRow("Money in", `+${money(stats.income, cur)}`)}
${txnRow("Money out", `−${money(stats.expense, cur)}`)}
${txnRow("Transactions", String(stats.count))}
${momRow}
${vat != null ? txnRow("VAT (estimated)", money(vat, cur)) : ""}
</table>
${topCats ? `<p class="kb-sub" style="margin:12px 0 0 0;font-family:${FONT};font-size:13px;line-height:1.6;color:#71717A;"><strong class="kb-strong" style="color:#18181B;font-weight:600;">Top expenses:</strong> ${escHtml(topCats)}</p>` : ""}
</td></tr>
</table>`;
}

function buildUserEmail({ user, sections }, range) {
  const first = (user.firstName || "").trim();
  const content = `
<h1 class="kb-ink" style="margin:0 0 6px 0;font-family:${FONT};font-size:21px;font-weight:700;letter-spacing:-0.2px;color:#18181B;line-height:1.3;">Your ${escHtml(range.label)} report</h1>
<p class="kb-sub" style="margin:0 0 26px 0;font-family:${FONT};font-size:15px;line-height:1.65;color:#71717A;">${first ? `Hi ${escHtml(first)}, here` : "Here"}&rsquo;s how your business${sections.length > 1 ? "es" : ""} performed last month.</p>
${sections.map((s, i) => businessSection(s, i === 0)).join("")}
<p class="kb-faint" style="margin:26px 0 0 0;font-family:${FONT};font-size:13px;line-height:1.6;color:#A1A1AA;">Figures cover ${escHtml(range.label)} (Africa/Lagos time), from the transactions recorded in KashBook. VAT figures are estimates &mdash; confirm with your tax adviser.</p>`;

  // Whole-account net for the subject/preheader (mixed currencies just fall
  // back to the first business's symbol — the sections carry the detail).
  const cur = sections[0].business.baseCurrency || "NGN";
  const totalNet = sections.reduce((n, s) => n + (s.stats.income - s.stats.expense), 0);
  const netStr = `${totalNet >= 0 ? "+" : "−"}${money(Math.abs(totalNet), cur)}`;
  return {
    subject: `Your ${range.label} report — ${netStr} net`,
    html: renderEmail({
      preheader: `${range.label}: ${netStr} net across ${sections.length} business${sections.length > 1 ? "es" : ""}.`,
      content,
      accentDark: totalNet >= 0 ? "#4ADE80" : "#F87171",
    }),
  };
}

// Send last month's P&L to every owner with activity. Resolves always.
async function sendMonthlyReports({ monthOffset = 1 } = {}) {
  try {
    const transport = getTransport();
    if (!transport) {
      console.warn("[monthlyReport] no SMTP configured — skipping");
      return { users: 0, skipped: "no-smtp" };
    }
    const { range, users } = await computeMonthlyData(monthOffset);
    if (users.length === 0) return { users: 0, month: range.label };

    const from = process.env.TXN_EMAIL_FROM || process.env.TXN_SMTP_USER || process.env.EMAIL_FROM;
    let sent = 0;
    const CHUNK = 10;
    for (let i = 0; i < users.length; i += CHUNK) {
      await Promise.allSettled(
        users.slice(i, i + CHUNK).map(async (payload) => {
          const { subject, html } = buildUserEmail(payload, range);
          await transport.sendMail({ from, to: payload.user.email, subject, html });
          sent += 1;
        }),
      );
    }
    console.log(`[monthlyReport] ${range.label}: sent ${sent}/${users.length} report(s)`);
    return { users: sent, month: range.label };
  } catch (err) {
    console.error("[monthlyReport] failed:", err.message);
    return { users: 0, error: err.message };
  }
}

module.exports = { sendMonthlyReports, computeMonthlyData, lagosMonthRange, _buildUserEmail: buildUserEmail };
