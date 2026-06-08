// Pure function shared by the recurring-expense route (creating items)
// and the cron runner (advancing `nextDue` after each execution).

function computeNextDue(frequency, from = new Date()) {
  const d = new Date(from);
  switch (frequency) {
    case "daily":   d.setDate(d.getDate() + 1); break;
    case "weekly":  d.setDate(d.getDate() + 7); break;
    case "monthly": d.setMonth(d.getMonth() + 1); break;
    case "yearly":  d.setFullYear(d.getFullYear() + 1); break;
    default: {
      if (frequency && frequency.startsWith("custom_")) {
        const days = parseInt(frequency.split("_")[1], 10);
        if (days > 0) { d.setDate(d.getDate() + days); break; }
      }
      d.setMonth(d.getMonth() + 1);
    }
  }
  return d;
}

module.exports = { computeNextDue };
