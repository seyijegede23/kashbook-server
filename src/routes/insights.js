// Insights ("ask your books") — PREMIUM. A deterministic Q&A algorithm over
// the business's own data (utils/insightsEngine.js). No AI, no external calls.
const router = require("express").Router();
const prisma = require("../utils/db");
const auth = require("../middleware/auth");
const { answerQuestion, generateInsightCards, SUGGESTIONS } = require("../utils/insightsEngine");

router.use(auth);

// Staff act on their employer's books (same convention as invoices/transfers).
function ownerId(req) {
  return req.user.accountType === "staff" ? req.user.employerId : req.user.id;
}

function premiumGate(req, res) {
  if (req.user.effectivePlan !== "PREMIUM") {
    res.status(403).json({
      error: "Business Insights is a Premium feature. Upgrade to ask questions about your books.",
      code: "PREMIUM_REQUIRED",
    });
    return false;
  }
  return true;
}

async function resolveBusiness(req, res) {
  const businessId = String(req.body?.businessId || req.query?.businessId || "");
  if (!businessId) {
    res.status(400).json({ error: "businessId is required" });
    return null;
  }
  const biz = await prisma.business.findFirst({
    where: { id: businessId, userId: ownerId(req) },
    select: { id: true, name: true, baseCurrency: true, country: true, anchorAccountId: true, providerAccountId: true },
  });
  if (!biz) {
    res.status(404).json({ error: "Business not found" });
    return null;
  }
  return biz;
}

// POST /insights/ask { businessId, question, context? }
// context = the previous answer's intent id (string) so "what about last week?"
// style follow-ups work. Returns { intent, answer, data? }.
router.post("/ask", async (req, res) => {
  try {
    if (!premiumGate(req, res)) return;
    const biz = await resolveBusiness(req, res);
    if (!biz) return;

    const question = String(req.body.question || "").trim().slice(0, 300);
    if (!question) return res.status(400).json({ error: "Ask a question first." });
    const context = typeof req.body.context === "string" ? req.body.context.slice(0, 40) : null;

    const result = await answerQuestion(question, biz, context);
    res.json(result);
  } catch (err) {
    console.error("[insights ask]", err.message);
    res.status(500).json({ error: "Failed to answer that — try again." });
  }
});

// GET /insights/cards?businessId= — auto-generated observation cards
router.get("/cards", async (req, res) => {
  try {
    if (!premiumGate(req, res)) return;
    const biz = await resolveBusiness(req, res);
    if (!biz) return;
    const cards = await generateInsightCards(biz);
    res.json({ cards });
  } catch (err) {
    console.error("[insights cards]", err.message);
    res.status(500).json({ error: "Failed to load insights" });
  }
});

// GET /insights/suggestions — static example questions (free to view; asking is gated)
router.get("/suggestions", (req, res) => {
  res.json({ suggestions: SUGGESTIONS });
});

module.exports = router;
