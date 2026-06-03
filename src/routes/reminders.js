const router = require("express").Router();
const prisma = require("../utils/db");
const authMiddleware = require("../middleware/auth");

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
    const customer = await prisma.customer.findFirst({
      where: { id: customerId, businessId },
    });
    if (!customer) {
      return res.status(404).json({ error: "Customer not found" });
    }

    let businessName = "KashBook Merchants";
    const business = await prisma.business.findFirst({
      where: { id: businessId },
    });
    if (business?.name) {
      businessName = business.name;
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
        phone: normalizePhone(phone),
        message,
        channel: "sms",
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
