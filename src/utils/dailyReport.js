// Daily 8pm business report push.
//
// For every user that owns at least one business:
//   • If they recorded transactions today → a summary of money in / out.
//   • If they recorded nothing            → a gentle nudge to log the day.
//
// "Today" is the Africa/Lagos calendar day (WAT, UTC+1, no DST) — the app's
// home market. Runs from server.js via cron at 20:00 Lagos time; also
// triggerable on demand through POST /admin-api/run-daily-report.

const prisma = require("./db");
const { pushTo } = require("./pushNotification");
const { formatAmountForBusiness } = require("../config/amlLimits");

const WAT_OFFSET_MS = 60 * 60 * 1000; // UTC+1, fixed

function startOfTodayLagos(now = new Date()) {
  const lagos = new Date(now.getTime() + WAT_OFFSET_MS);
  return new Date(
    Date.UTC(lagos.getUTCFullYear(), lagos.getUTCMonth(), lagos.getUTCDate()) - WAT_OFFSET_MS,
  );
}

async function sendDailyReports() {
  const since = startOfTodayLagos();

  const businesses = await prisma.business.findMany({
    select: { id: true, name: true, userId: true, country: true, baseCurrency: true },
  });
  if (businesses.length === 0) return { users: 0 };

  // Today's sales and expenses by the books rule (utils/books.js): recorded
  // sales and expenses, invoice and debt payments, refunds and bank rows, each
  // naira once. It used to read bank rows only, so a day of recorded sales
  // still got the "no entries" nudge.
  const { booksFor } = require("./booksData");
  const today = new Date(since.getTime() + WAT_OFFSET_MS).toISOString().slice(0, 10);
  const statsByBusiness = new Map();
  for (const b of businesses) {
    const books = await booksFor(b.id, { from: today, to: today });
    if (!books) continue;
    let count = 0;
    for (const line of Object.values(books.sales.lines)) count += line.count;
    for (const line of Object.values(books.expenses.lines)) count += line.count;
    if (count === 0) continue;
    statsByBusiness.set(b.id, { income: books.sales.total, expense: books.expenses.total, count });
  }

  // Group businesses per owner so each user gets exactly one push.
  const byUser = new Map();
  for (const b of businesses) {
    if (!byUser.has(b.userId)) byUser.set(b.userId, []);
    byUser.get(b.userId).push(b);
  }

  const jobs = [];
  for (const [userId, bizList] of byUser) {
    let income = 0, expense = 0, count = 0, activeBiz = 0;
    for (const b of bizList) {
      const s = statsByBusiness.get(b.id);
      if (!s) continue;
      income += s.income;
      expense += s.expense;
      count += s.count;
      activeBiz += 1;
    }

    const fmtBiz = bizList[0]; // currency/locale source for the aggregate
    if (count === 0) {
      jobs.push({
        userId,
        title: "No entries today 📝",
        body: "You haven't recorded any transactions today. Take a minute to log your sales and expenses before you forget.",
      });
    } else {
      const inStr = formatAmountForBusiness(fmtBiz, income);
      const outStr = formatAmountForBusiness(fmtBiz, expense);
      const scope =
        activeBiz > 1 ? ` across ${activeBiz} businesses` : ` at ${bizList[0].name}`;
      jobs.push({
        userId,
        title: "Today's business summary 📊",
        body: `${inStr} sales · ${outStr} expenses · ${count} entr${count === 1 ? "y" : "ies"}${scope}.`,
      });
    }
  }

  // pushTo writes the in-app row and sends the device push (token +
  // notifications-enabled permitting). Chunked to be polite to Expo.
  const CHUNK = 20;
  for (let i = 0; i < jobs.length; i += CHUNK) {
    await Promise.allSettled(
      jobs.slice(i, i + CHUNK).map((j) => pushTo(j.userId, j.title, j.body)),
    );
  }

  console.log(`[dailyReport] sent ${jobs.length} report(s)`);
  return { users: jobs.length };
}

module.exports = { sendDailyReports };
