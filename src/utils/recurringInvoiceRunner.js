// Recurring-invoice runner — processes due RecurringInvoice rules (daily cron,
// see server.js). For each due ACTIVE rule whose owner is PREMIUM:
//   • creates a real SENT invoice (auto-numbered, one line item) + share link,
//     inside withBusinessLock so the invoiceCounter can't race other creators;
//   • advances nextDue by the rule's frequency (catch-up safe: a rule overdue
//     by several periods produces ONE invoice and jumps to the next future due);
//   • pushes the owner a notification with the invoice number so they can share.
// Free owners' rules are SKIPPED (not deactivated) — they resume on upgrade.
// Per-rule try/catch: one bad rule never halts the batch. Never throws.

const crypto = require("crypto");
const prisma = require("./db");
const { computeNextDue } = require("./recurringSchedule");
const { pushTo } = require("./pushNotification");
const { formatAmountForBusiness } = require("../config/amlLimits");

function isoDay(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

async function processRecurringInvoices(now = new Date()) {
  let created = 0, skippedFree = 0, failed = 0;
  try {
    const due = await prisma.recurringInvoice.findMany({
      where: { active: true, nextDue: { lte: now } },
      include: {
        user: { select: { id: true, plan: true } },
        customer: { select: { id: true, name: true } },
        business: { select: { id: true, name: true, userId: true, country: true, baseCurrency: true } },
      },
      take: 500,
    });

    for (const rule of due) {
      try {
        // Advance the schedule FIRST in all outcomes below (skip or create) so a
        // broken/free rule can't be retried every night forever.
        let next = computeNextDue(rule.frequency, rule.nextDue);
        while (next <= now) next = computeNextDue(rule.frequency, next);

        if (!rule.business) {
          await prisma.recurringInvoice.update({ where: { id: rule.id }, data: { active: false } });
          continue;
        }
        // PREMIUM gate — paid feature; free owners' rules pause silently.
        if (rule.user?.plan !== "PREMIUM") {
          skippedFree++;
          await prisma.recurringInvoice.update({ where: { id: rule.id }, data: { nextDue: next } });
          continue;
        }

        const dueDate = rule.dueInDays != null && rule.dueInDays >= 0
          ? isoDay(new Date(now.getTime() + rule.dueInDays * 24 * 60 * 60 * 1000))
          : null;

        const invoice = await prisma.withBusinessLock(rule.businessId, async () => {
          const biz = await prisma.business.update({
            where: { id: rule.businessId },
            data: { invoiceCounter: { increment: 1 } },
          });
          const invoiceNumber = `INV-${String(biz.invoiceCounter).padStart(3, "0")}`;
          const inv = await prisma.invoice.create({
            data: {
              businessId: rule.businessId,
              customerId: rule.customerId || null,
              userId: rule.userId,
              invoiceNumber,
              type: "invoice",
              status: "SENT",
              issueDate: isoDay(now),
              dueDate,
              currency: rule.business.baseCurrency || "NGN",
              subtotal: rule.amount,
              total: rule.amount,
              items: { create: [{ name: rule.description, quantity: 1, rate: rule.amount, amount: rule.amount }] },
            },
          });
          const token = crypto.randomBytes(32).toString("base64url");
          await prisma.invoiceShareLink.create({ data: { invoiceId: inv.id, token } });
          return { ...inv, invoiceNumber };
        });

        await prisma.recurringInvoice.update({
          where: { id: rule.id },
          data: { nextDue: next, lastRunAt: now, lastInvoiceId: invoice.id },
        });

        const amt = formatAmountForBusiness(rule.business, rule.amount);
        const who = rule.customer?.name ? ` for ${rule.customer.name}` : "";
        await pushTo(
          rule.business.userId,
          "Recurring invoice created 🧾",
          `${invoice.invoiceNumber} · ${amt}${who} (${rule.frequency}). Open Invoices to share it.`,
        ).catch(() => {});
        created++;
      } catch (err) {
        failed++;
        console.error(`[recurringInvoices] rule ${rule.id} failed: ${err.message}`);
      }
    }

    if (created || skippedFree || failed) {
      console.log(`[recurringInvoices] created ${created}, skipped(free) ${skippedFree}, failed ${failed}`);
    }
  } catch (err) {
    console.error("[recurringInvoices] batch failed:", err.message);
  }
  return { created, skippedFree, failed };
}

module.exports = { processRecurringInvoices };
