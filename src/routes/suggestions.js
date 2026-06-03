const router = require("express").Router();
const prisma = require("../utils/db");
const authMiddleware = require("../middleware/auth");

// POST /suggestions (protected)
router.post("/", authMiddleware, async (req, res) => {
  const { category, type, text, content } = req.body;
  // Accept both old (category/text) and new (type/content) field names
  const suggestionContent = content || text;
  const suggestionType = type || category || "feature";

  if (!suggestionContent?.trim()) {
    return res.status(400).json({ error: "Suggestion text is required" });
  }
  try {
    const suggestion = await prisma.suggestion.create({
      data: {
        userId: req.user.id,
        type: suggestionType,
        content: suggestionContent.trim(),
      },
    });
    res.status(201).json({ suggestion });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to save suggestion" });
  }
});

module.exports = router;
