const router = require("express").Router();
const prisma = require("../utils/db");
const authMiddleware = require("../middleware/auth");

// Resolve the business owner (staff act on their employer's data) — same helper
// convention as businesses.js / businessDebts.js.
const getTargetUserId = (req) =>
  req.user.accountType === "staff" ? req.user.employerId : req.user.id;

// ── Helper: normalise phone ──────────────────────────────────────────────────
function normalizePhone(phone = "") {
  const p = phone.replace(/\s+/g, "").trim();
  if (p.startsWith("+")) return p;
  if (p.startsWith("0")) return "+234" + p.slice(1);
  return p;
}

// POST /reminders/schedule
router.post("/schedule", authMiddleware, async (req, res) => {
  const { businessId, customerId, phone, amountOwed, timeframe } = req.body;

  if (
    !businessId ||
    !customerId ||
    !phone ||
    amountOwed === undefined ||
    !timeframe
  ) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const scheduledFor = new Date();
  switch (timeframe) {
    case "today":
      scheduledFor.setMinutes(scheduledFor.getMinutes() + 1);
      break;
    case "tomorrow":
      scheduledFor.setDate(scheduledFor.getDate() + 1);
      scheduledFor.setHours(10, 0, 0, 0);
      break;
    case "3days":
      scheduledFor.setDate(scheduledFor.getDate() + 3);
      scheduledFor.setHours(10, 0, 0, 0);
      break;
    case "1week":
      scheduledFor.setDate(scheduledFor.getDate() + 7);
      scheduledFor.setHours(10, 0, 0, 0);
      break;
    default:
      return res.status(400).json({ error: "Invalid timeframe" });
  }

  try {
    // SECURITY: scope BOTH lookups to the caller. Previously the customer was
    // matched on {id, businessId} with no owner check and the business was
    // fetched by id alone, so any authenticated user could target another
    // merchant's records — and the response leaked their customer + business
    // names back to the attacker.
    const userId = getTargetUserId(req);
    const business = await prisma.business.findFirst({
      where: { id: businessId, userId },
    });
    if (!business) {
      return res.status(404).json({ error: "Business not found" });
    }

    const customer = await prisma.customer.findFirst({
      where: { id: customerId, businessId: business.id },
    });
    if (!customer) {
      return res.status(404).json({ error: "Customer not found" });
    }
    const businessName = business.name || "KashBook Merchants";

    // SECURITY: the recipient is the CUSTOMER's stored number. Taking it from
    // the request body turned this endpoint into an SMS cannon that could text
    // any number in Nigeria from KashBook's sender ID, at KashBook's cost.
    if (!customer.phone) {
      return res.status(400).json({ error: "This customer has no phone number on file." });
    }

    const formattedAmount = Number(amountOwed).toLocaleString();
    const message = `Hi ${customer.name}, this is a quick reminder regarding your outstanding balance of NGN ${formattedAmount} with ${businessName}. Please let us know when you can settle this. Thank you!`;

    const reminder = await prisma.reminder.create({
      data: {
        userId: req.user.id,
        businessId,
        targetId: customerId,
        type: "debt",
        amount: Number(amountOwed),
        recipientName: customer.name,
        phone: normalizePhone(customer.phone),
        message,
        // Intended channel. The cron overwrites this with the channel that
        // actually delivered, so the merchant is never told "WhatsApp" for a
        // message that fell back to SMS.
        channel: process.env.SENDCHAMP_WA_REMINDER_TEMPLATE ? "whatsapp" : "sms",
        status: "pending",
        scheduledFor,
      },
    });

    res.status(201).json({ message: "Reminder scheduled successfully", reminder });
  } catch (err) {
    console.error("Error scheduling reminder:", err);
    res.status(500).json({ error: "Failed to schedule reminder" });
  }
});

module.exports = router;
