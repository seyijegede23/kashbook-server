const router = require("express").Router();
const auth = require("../middleware/auth");
const prisma = require("../utils/db");
const anchor = require("../utils/anchor");
const { verifyTransactionPin } = require("../utils/transactionPin");

router.use(auth);

// GET /transfers/banks
router.get("/banks", async (_req, res) => {
  try {
    const banks = await anchor.getBanks();
    res.json(banks);
  } catch (err) {
    if (err.code === "ANCHOR_NOT_CONFIGURED")
      return res.status(503).json({ error: "Transfers not configured on this server." });
    res.status(500).json({ error: err.message || "Failed to fetch banks" });
  }
});

// POST /transfers/verify-account
// body: { accountNumber, bankCode } — bankCode is the CBN bank code
// Two-step lookup:
//   1. Check our DB for an internal KashBook business with that NUBAN. Anchor's
//      /payments/verify-account doesn't know about its own virtual NUBANs, so
//      external-only enquiry returns "Account not found" for KashBook→KashBook.
//   2. Fall back to Anchor's name enquiry for external banks.
router.post("/verify-account", async (req, res) => {
  const { accountNumber, bankCode } = req.body;
  if (!accountNumber || !bankCode)
    return res.status(400).json({ error: "accountNumber and bankCode are required" });

  try {
    const internal = await prisma.business.findFirst({
      where: {
        virtualAccountNumber: accountNumber,
        anchorAccountId: { not: null },
      },
      select: { name: true, virtualAccountName: true },
    });
    if (internal) {
      return res.json({
        accountName: internal.virtualAccountName || internal.name,
        internal: true,
      });
    }

    const ne = await anchor.verifyCounterparty({ accountNumber, bankCode });
    if (!ne.accountName)
      return res.status(400).json({ error: "Account not found" });
    res.json({ accountName: ne.accountName, internal: false });
  } catch (err) {
    if (err.code === "ANCHOR_NOT_CONFIGURED")
      return res.status(503).json({ error: "Transfers not configured on this server." });
    res
      .status(400)
      .json({ error: err.message || "Could not verify account. Check the number and bank." });
  }
});

// GET /transfers/balance?businessId=
// Live held-funds balance from Anchor for the business's deposit account.
router.get("/balance", async (req, res) => {
  try {
    const { businessId } = req.query;
    if (!businessId) return res.status(400).json({ error: "businessId required" });

    const userId =
      req.user.accountType === "staff" ? req.user.employerId : req.user.id;
    const biz = await prisma.business.findFirst({
      where: { id: businessId, userId },
    });
    if (!biz) return res.status(404).json({ error: "Business not found" });
    if (!biz.anchorAccountId) return res.json({ balance: 0 });

    const { balance } = await anchor.getAccountBalance(biz.anchorAccountId);
    res.json({ balance });
  } catch (err) {
    if (err.code === "ANCHOR_NOT_CONFIGURED") return res.json({ balance: 0 });
    res.status(500).json({ error: err.message || "Failed to fetch balance" });
  }
});

// POST /transfers/send
// body: { businessId, accountNumber, bankCode, amount, narration, accountName, bankName }
router.post("/send", async (req, res) => {
  if (req.user.accountType === "staff")
    return res.status(403).json({ error: "Staff cannot initiate transfers" });

  const { businessId, accountNumber, bankCode, amount, narration, accountName, bankName, pin } = req.body;
  if (!businessId || !accountNumber || !bankCode || !amount)
    return res.status(400).json({ error: "Missing required fields" });
  if (isNaN(amount) || Number(amount) <= 0)
    return res.status(400).json({ error: "Invalid amount" });

  // Require a valid transaction PIN before processing.
  const pinCheck = await verifyTransactionPin(req.user.id, pin);
  if (!pinCheck.ok) {
    return res
      .status(pinCheck.status || 401)
      .json({ error: pinCheck.error, code: pinCheck.code });
  }

  try {
    const biz = await prisma.business.findFirst({
      where: { id: businessId, userId: req.user.id },
    });
    if (!biz) return res.status(404).json({ error: "Business not found" });
    if (!biz.anchorAccountId)
      return res.status(400).json({
        error: "This business has no bank account. Set one up first.",
      });

    // Authoritative live balance from Anchor (user's own deposit account)
    const { balance } = await anchor.getAccountBalance(biz.anchorAccountId);
    if (balance < Number(amount)) {
      return res.status(400).json({
        error: `Insufficient balance. Available: ₦${balance.toLocaleString("en-NG", { minimumFractionDigits: 2 })}`,
      });
    }

    const reference = `kashbook_tf_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

    // Auto-detect internal vs external. If the destination NUBAN belongs to
    // another KashBook business that has a DepositAccount on the same Anchor
    // org, use BookTransfer (free + instant). Otherwise fall back to NIP.
    const internalDest = await prisma.business.findFirst({
      where: {
        virtualAccountNumber: accountNumber,
        anchorAccountId: { not: null },
        NOT: { id: businessId }, // can't book-transfer to yourself
      },
      select: { id: true, name: true, anchorAccountId: true, virtualAccountName: true },
    });

    let resolvedName = accountName;
    let resolvedBank = bankName;
    let route;

    if (internalDest) {
      resolvedName = resolvedName || internalDest.virtualAccountName || internalDest.name;
      resolvedBank = "KashBook (internal)";
      route = "book";
      await anchor.createBookTransfer({
        fromAccountId: biz.anchorAccountId,
        toAccountId: internalDest.anchorAccountId,
        amount: Number(amount),
        reason: narration || `Transfer from ${biz.name}`,
        reference,
      });
    } else {
      // External NIP path
      if (!resolvedName) {
        const ne = await anchor.verifyCounterparty({ accountNumber, bankCode });
        if (!ne.accountName)
          return res.status(400).json({ error: "Could not resolve recipient account" });
        resolvedName = ne.accountName;
      }
      const banks = await anchor.getBanks();
      const matchedBank = banks.find((b) => b.code === bankCode);
      if (!matchedBank?.id)
        return res.status(400).json({ error: "Unknown bank — refresh the bank list" });

      const cp = await anchor.createCounterparty({
        accountNumber,
        bankId: matchedBank.id,
        accountName: resolvedName,
      });
      route = "nip";
      await anchor.createTransfer({
        fromAccountId: biz.anchorAccountId,
        counterpartyId: cp.counterpartyId,
        amount: Number(amount),
        reason: narration || `Transfer from ${biz.name}`,
        reference,
      });
    }

    const recipientLabel = resolvedBank
      ? `${resolvedName} · ${resolvedBank} · ${accountNumber}`
      : `${resolvedName} · ${accountNumber}`;
    const description = narration
      ? `${narration} — to ${recipientLabel}`
      : `Transfer to ${recipientLabel}`;

    await prisma.transaction.create({
      data: {
        businessId,
        userId: req.user.id,
        type: "expense",
        amount: Number(amount),
        description,
        category: "transfer",
        paymentMethod: "bank",
        date: new Date(),
        source: "anchor",
      },
    });

    res.json({ status: "success", reference, route });
  } catch (err) {
    if (err.code === "ANCHOR_NOT_CONFIGURED")
      return res.status(503).json({ error: "Transfers not configured on this server." });
    console.error("Transfer error:", err);
    res.status(400).json({ error: err.message || "Transfer failed" });
  }
});

module.exports = router;
