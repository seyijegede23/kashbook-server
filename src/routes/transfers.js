const router = require("express").Router();
const auth = require("../middleware/auth");
const requireUnfrozen = require("../middleware/requireUnfrozen");
const { requirePermission, ownerOnly } = require("../middleware/requirePermission");
const { ownerIdOf } = require("../utils/scope");
const prisma = require("../utils/db");
const anchor = require("../utils/anchor");
const { getProvider } = require("../providers");
const { getCountryConfig } = require("../config/countries");
const { computeLedgerBalance } = require("../utils/ledgerBalance");
const { verifyTransactionPin } = require("../utils/transactionPin");
const { runPreTransferChecks, MONEY_OUT_SOURCES } = require("../utils/amlChecks");
const { staffSpendLast24h, decideStaffCap, APPROVAL_TTL_MS } = require("../utils/staffTransferCap");
const { randomUUID } = require("crypto");
const { audit } = require("../utils/audit");
const { pushTo } = require("../utils/pushNotification");
const { dispatchOtp } = require("../utils/otp");
const { executeTransfer } = require("../utils/executeTransfer");
const { computeTransferFee, NIP_FEE, STAMP_DUTY, STAMP_DUTY_THRESHOLD, PLATFORM_MARGIN } = require("../config/fees");
const {
  STEP_UP_OTP_ABOVE,
  TRANSFER_OTP_TYPE,
  resolveBusinessLimits,
  getThresholds,
  formatAmountForBusiness,
} = require("../config/amlLimits");

router.use(auth);
router.use(requireUnfrozen);

// Money endpoints are capability-gated, using TWO distinct capabilities:
//
//   canViewBalance  the money position itself — the balance, the AML limits,
//                   and spend-to-date.
//   canTransfer     the machinery for SENDING: the bank list, name enquiry,
//                   saved beneficiaries, fee quotes. These are useless to
//                   someone who cannot send, and verify-account in particular
//                   is a name-enquiry oracle that should not be open to them.
//
// Both default to false for staff (no grant row), so this is identical in
// behaviour to the blanket block it replaces until an owner grants something.

// GET /transfers/banks
// Bank list for the sender's country/currency, via their payment provider
// (Fincra bank `code` is the payout bankCode; Anchor returns CBN codes). Sending
// is local, so the sender's country drives which banks + which code namespace.
router.get("/banks", requirePermission("canTransfer"), async (req, res) => {
  try {
    const country = req.user.country || "NG";
    const provider = getProvider(country);
    if (!provider.supportsBanking) return res.json([]);
    const currency = getCountryConfig(country).currency.code;
    const banks = await provider.getBanks(currency);
    res.json(banks);
  } catch (err) {
    if (err.code === "ANCHOR_NOT_CONFIGURED" || err.code === "NOT_IMPLEMENTED")
      return res.status(503).json({ error: "Transfers not configured on this server." });
    console.error("[transfers/banks]", err.message);
    res.status(500).json({ error: "Failed to fetch banks" });
  }
});

// POST /transfers/verify-account
// body: { accountNumber, bankCode } — bankCode is the CBN bank code
// Two-step lookup:
//   1. Check our DB for an internal KashBook business with that NUBAN. Anchor's
//      /payments/verify-account doesn't know about its own virtual NUBANs, so
//      external-only enquiry returns "Account not found" for KashBook→KashBook.
//   2. Fall back to Anchor's name enquiry for external banks.
router.post("/verify-account", requirePermission("canTransfer"), async (req, res) => {
  const { accountNumber, bankCode } = req.body;
  if (!accountNumber || !bankCode)
    return res.status(400).json({ error: "accountNumber and bankCode are required" });

  try {
    const internal = await prisma.business.findFirst({
      where: {
        virtualAccountNumber: accountNumber,
        OR: [{ providerAccountId: { not: null } }, { anchorAccountId: { not: null } }],
      },
      select: { name: true, virtualAccountName: true },
    });
    if (internal) {
      return res.json({
        accountName: internal.virtualAccountName || internal.name,
        internal: true,
      });
    }

    const country = req.user.country || "NG";
    const provider = getProvider(country);
    const currency = getCountryConfig(country).currency.code;
    const ne = await provider.verifyRecipient({ accountNumber, bankCode, currency });
    if (!ne.accountName)
      return res.status(400).json({ error: "Account not found" });
    res.json({ accountName: ne.accountName, internal: false });
  } catch (err) {
    if (err.code === "ANCHOR_NOT_CONFIGURED" || err.code === "NOT_IMPLEMENTED")
      return res.status(503).json({ error: "Transfers not configured on this server." });
    console.error("[transfers/verify-account]", err.message);
    res
      .status(400)
      .json({ error: "Could not verify account. Check the number and bank." });
  }
});

// GET /transfers/balance?businessId=
// Live held-funds balance from Anchor for the business's deposit account.
router.get("/balance", requirePermission("canViewBalance"), async (req, res) => {
  try {
    const { businessId } = req.query;
    if (!businessId) return res.status(400).json({ error: "businessId required" });

    const userId =
      req.user.accountType === "staff" ? req.user.employerId : req.user.id;
    const biz = await prisma.business.findFirst({
      where: { id: businessId, userId },
    });
    if (!biz) return res.status(404).json({ error: "Business not found" });
    const bankingId = biz.providerAccountId || biz.anchorAccountId;
    if (!bankingId) return res.json({ balance: 0 });

    const provider = getProvider(biz);
    // Pooled-wallet providers (Fincra) have no per-business balance — derive it
    // from our ledger. Anchor exposes a real per-account balance.
    if (provider.pooledWallet) {
      return res.json({ balance: await computeLedgerBalance(biz.id, biz.baseCurrency || "NGN") });
    }
    const { balance } = await anchor.getAccountBalance(bankingId);
    res.json({ balance });
  } catch (err) {
    if (err.code === "ANCHOR_NOT_CONFIGURED") return res.json({ balance: 0 });
    console.error("[transfers/balance]", err.message);
    res.status(500).json({ error: "Failed to fetch balance" });
  }
});

// GET /transfers/limits?businessId=
//
// Returns the resolved AML tier limits for the business plus how much has
// already been sent today / this week / this month, so the client can show
// the user where they stand. Includes:
//
//   singleMax            biggest individual transfer allowed today
//   daily / weekly /     per-window caps from the country config
//     monthly
//   dailySoFar /         outbound transfers already counted against each
//     weeklySoFar /        window (anchor expense transfers only)
//     monthlySoFar
//   dailyRemaining /     daily - dailySoFar (etc.), floored at 0 — what the
//     weeklyRemaining /    user can still send before tripping a hard block
//     monthlyRemaining
//   stepUpOtpAbove       transfers above this require an OTP step-up
//   tierKey, country,    metadata so the UI can show "Sole proprietor · NG"
//     currencyCode
//
// Treats no-NUBAN businesses as the "unverified" tier (all zeros). The
// client is also expected to gate access to this screen, but a hard-coded
// zero here means even a bad client can't show stale limits.
router.get("/limits", requirePermission("canViewBalance"), async (req, res) => {
  try {
    // AML kill switch: no limits are enforced, so show none — the client's
    // LimitsCard hides itself on a null payload.
    if (process.env.AML_ENABLED === "false") return res.json(null);

    const { businessId } = req.query;
    if (!businessId) return res.status(400).json({ error: "businessId required" });

    const userId =
      req.user.accountType === "staff" ? req.user.employerId : req.user.id;
    const biz = await prisma.business.findFirst({ where: { id: businessId, userId } });
    if (!biz) return res.status(404).json({ error: "Business not found" });

    const limits = resolveBusinessLimits(biz);
    const thresholds = getThresholds(biz);

    // Mirror the windowing used by runPreTransferChecks so the numbers a user
    // sees here match the gate they're about to hit on /send.
    const now = Date.now();
    const since24h = new Date(now - 24 * 60 * 60 * 1000);
    const since7d  = new Date(now - 7  * 24 * 60 * 60 * 1000);
    const since30d = new Date(now - 30 * 24 * 60 * 60 * 1000);
    const recent30 = await prisma.transaction.findMany({
      where: {
        businessId: biz.id,
        type: "expense",
        category: "transfer",
        source: { in: MONEY_OUT_SOURCES }, // must match runPreTransferChecks (amlChecks.js)
        date: { gte: since30d },
      },
      select: { amount: true, date: true },
      orderBy: { date: "asc" },
    });
    const sumSince = (since) =>
      recent30.filter((t) => t.date >= since).reduce((s, t) => s + Number(t.amount), 0);

    const dailySoFar   = sumSince(since24h);
    const weeklySoFar  = sumSince(since7d);
    const monthlySoFar = sumSince(since30d);
    const remaining = (cap, used) => Math.max(0, cap - used);

    res.json({
      tierKey: limits.tierKey,
      riskCategory: limits.riskCategory,
      countryCode: limits.countryCode,
      currencyCode: limits.currencyCode,
      currencySymbol: limits.currencySymbol,
      currencyLocale: limits.currencyLocale,

      singleMax: limits.singleMax,
      daily: limits.daily,
      weekly: limits.weekly,
      monthly: limits.monthly,

      dailySoFar,
      weeklySoFar,
      monthlySoFar,

      dailyRemaining:   remaining(limits.daily,   dailySoFar),
      weeklyRemaining:  remaining(limits.weekly,  weeklySoFar),
      monthlyRemaining: remaining(limits.monthly, monthlySoFar),

      stepUpOtpAbove: thresholds.stepUpOtpAbove,
      singleFlagAbove: thresholds.singleFlagAbove,

      hasBankingAccount: !!biz.virtualAccountNumber,

      // Fee schedule for the limits sheet. Per-transfer quotes come from
      // GET /transfers/fee-quote; this is just display copy material.
      feeSchedule: {
        nip: NIP_FEE,
        stampDuty: STAMP_DUTY,
        stampDutyThreshold: STAMP_DUTY_THRESHOLD,
        platform: PLATFORM_MARGIN,
      },
    });
  } catch (err) {
    console.error("[transfers/limits]", err);
    res.status(500).json({ error: "Failed to fetch transfer limits" });
  }
});

// GET /transfers/beneficiaries?businessId=<id>
// Top recent transfer recipients for the Send Money "Recents" chips.
router.get("/beneficiaries", requirePermission("canTransfer"), async (req, res) => {
  try {
    const { businessId } = req.query;
    if (!businessId) return res.status(400).json({ error: "businessId required" });
    const userId =
      req.user.accountType === "staff" ? req.user.employerId : req.user.id;
    const biz = await prisma.business.findFirst({ where: { id: businessId, userId } });
    if (!biz) return res.status(404).json({ error: "Business not found" });

    const beneficiaries = await prisma.beneficiary.findMany({
      where: { businessId },
      orderBy: { lastUsedAt: "desc" },
      take: 5,
      select: {
        id: true, accountNumber: true, bankCode: true,
        bankName: true, accountName: true, timesUsed: true,
      },
    });
    res.json(beneficiaries);
  } catch (err) {
    console.error("[transfers/beneficiaries]", err);
    res.status(500).json({ error: "Failed to fetch beneficiaries" });
  }
});

// GET /transfers/fee-quote?amount=<n>&accountNumber=<10-digit>
// Returns the fee the user will pay for this transfer, detected the same way
// executeTransfer routes it: a KashBook-internal destination is a free book
// transfer; anything else is NIP (₦51 / ₦101 above ₦10,000). Server is
// authoritative — the client never computes fees itself.
router.get("/fee-quote", requirePermission("canTransfer"), async (req, res) => {
  try {
    const amount = Number(req.query.amount);
    const accountNumber = String(req.query.accountNumber || "").trim();
    if (!amount || amount <= 0)
      return res.status(400).json({ error: "amount required" });

    // Resolve the provider from the ACTUAL business the send will use — the same
    // getProvider(biz) that /send uses — so the quote can't diverge from the charge.
    // req.user carries no country field (auth middleware never sets it), so we must
    // NOT resolve from req.user.country; fall back to the NG default only when no
    // business is supplied. Honours both the country config and the sticky rule.
    const userId = req.user.accountType === "staff" ? req.user.employerId : req.user.id;
    const biz = req.query.businessId
      ? await prisma.business.findFirst({ where: { id: String(req.query.businessId), userId } })
      : null;
    const provider = biz ? getProvider(biz) : getProvider(req.user.country || "NG");
    // Internal-destination detection for pooled providers keys on providerAccountId
    // (the provider stamps it); a KashBook→KashBook send is a free book move.
    const isInternalPooled = async () => {
      if (!/^\d{10}$/.test(accountNumber)) return false;
      const dest = await prisma.business.findFirst({
        where: { virtualAccountNumber: accountNumber, providerAccountId: { not: null } },
        select: { id: true },
      });
      return !!dest;
    };

    let route = "nip";
    if (/^\d{10}$/.test(accountNumber)) {
      const internalDest = await prisma.business.findFirst({
        where: {
          virtualAccountNumber: accountNumber,
          anchorAccountId: { not: null },
        },
        select: { id: true },
      });
      if (internalDest) route = "book";
    }

    const { total, statutoryStamp = 0, totalCost = total, breakdown } = computeTransferFee(amount, route);
    // `fee` = OUR charge; `stampDuty` = the bank-debited government levy on
    // >₦10k (disclosed, not ours); `total` = the true debit incl. both.
    res.json({ fee: total, stampDuty: statutoryStamp, breakdown, route, total: amount + totalCost });
  } catch (err) {
    console.error("[transfers/fee-quote]", err);
    res.status(500).json({ error: "Failed to quote fee" });
  }
});

// POST /transfers/send
// body: { businessId, accountNumber, bankCode, amount, narration, accountName, bankName }
router.post("/send", requirePermission("canTransfer", { auditDenials: true }), async (req, res) => {
  // Four different people can be meant by "the user" on a staff-initiated
  // transfer, and conflating any two of them is a money or security bug:
  //
  //   actorId  who pressed send. Their PIN authorises it, their phone receives
  //            the step-up OTP, and they are the audit actor.
  //   ownerId  whose business and whose money. The compliance subject: the
  //            freeze state, the AML tier and the ledger row all belong here.
  //
  // For an owner both are the same id and nothing below changes behaviour.
  const isStaff = req.user.accountType === "staff";
  const actorId = req.user.id;
  const ownerId = ownerIdOf(req);

  const { businessId, accountNumber, bankCode, amount, narration, accountName, bankName, pin, otp, idempotencyKey } = req.body;
  // Client-supplied idempotency key → a STABLE payout reference so a retry after a
  // timed-out-but-succeeded send hits the existing-reference short-circuit instead
  // of a second real disburse. Keep the "kbtf_" prefix (the money-out reconcile
  // attributes only refs starting with it). Absent → the executor mints a fresh
  // random ref (unchanged behaviour).
  const idemSanitized = idempotencyKey ? String(idempotencyKey).replace(/[^a-zA-Z0-9]/g, "").slice(0, 40) : "";
  // Empty after sanitizing (a degenerate/punctuation-only key) → fall back to a
  // fresh random ref, so it can't collide across all of a user's sends.
  const idempotentRef = idemSanitized ? `kbtf_${idemSanitized}` : undefined;
  if (!businessId || !accountNumber || !bankCode || !amount)
    return res.status(400).json({ error: "Missing required fields" });
  if (isNaN(amount) || Number(amount) <= 0)
    return res.status(400).json({ error: "Invalid amount" });
  // Money is 2-decimal. Anchor rounds to kobo when sending (Math.round(amount*100)),
  // so a sub-kobo amount would leave the bank at one value and be BOOKED at
  // another — a permanent ledger-vs-bank divergence. Reject rather than silently
  // round, so the client and the ledger always agree on what was sent.
  if (Math.round(Number(amount) * 100) !== Number(amount) * 100)
    return res.status(400).json({ error: "Amount cannot have more than 2 decimal places" });

  // Require a valid transaction PIN before processing.
  const pinCheck = await verifyTransactionPin(req.user.id, pin);
  if (!pinCheck.ok) {
    await audit({
      req,
      action: "PIN_FAILED",
      resourceType: "user",
      resourceId: req.user.id,
      severity: "warn",
      metadata: { code: pinCheck.code },
    });
    return res
      .status(pinCheck.status || 401)
      .json({ error: pinCheck.error, code: pinCheck.code });
  }

  try {
    const biz = await prisma.business.findFirst({
      // ownerId, not req.user.id: a staff member sends from their EMPLOYER's
      // business, so this lookup returned nothing and every staff send 404'd.
      // Never drop the userId filter to "fix" that — it is what stops any
      // authenticated user sending from any business in the system.
      where: { id: businessId, userId: ownerId },
    });
    if (!biz) return res.status(404).json({ error: "Business not found" });

    // Banking gate — bookkeeping-only countries can't move money.
    const { getProvider } = require("../providers");
    const provider = getProvider(biz);
    if (!provider.supportsBanking) {
      return res.status(400).json({
        error: "Banking isn't available in your country yet. You can still use KashBook for invoicing and bookkeeping.",
        code: "BANKING_NOT_AVAILABLE",
      });
    }

    if (!biz.providerAccountId && !biz.anchorAccountId)
      return res.status(400).json({
        error: "This business has no bank account. Set one up first.",
      });

    // ── AML pre-transfer pipeline ─────────────────────────────────────
    // Runs frozen + tier limit + single cap + step-up + rules engine in
    // order. Writes audit rows for each gate and returns early on block.
    // TWO rows, because one row was doing three incompatible jobs.
    //
    //   ownerFull  the COMPLIANCE SUBJECT: freeze state, AML tier, and the
    //              address the debit notice goes to. It is the owner's money.
    //   actorFull  who pressed send: their step-up OTP destination.
    //
    // Loading only the caller meant a staff send would have run the AML and
    // freeze checks against the STAFF's row — so a compliance-frozen OWNER would
    // not have stopped it, because requireUnfrozen only inspects the caller.
    // For an owner these are the same row and nothing changes.
    const [ownerFull, actorRow] = await Promise.all([
      prisma.user.findUnique({
        where: { id: ownerId },
        select: {
          id: true, accountStatus: true, complianceFreezeReason: true,
          email: true, phone: true, firstName: true, lastName: true,
        },
      }),
      isStaff
        ? prisma.user.findUnique({
            where: { id: actorId },
            select: {
              id: true, accountStatus: true, complianceFreezeReason: true,
              email: true, phone: true, firstName: true, lastName: true,
            },
          })
        : null,
    ]);
    if (!ownerFull) return res.status(404).json({ error: "Business owner not found" });
    const actorFull = actorRow || ownerFull;

    // Both subjects are checked for freeze: requireUnfrozen already refused a
    // frozen ACTOR on this POST, and the AML pipeline refuses a frozen OWNER
    // below. Neither alone is enough.

    // Serialize money-out per business: the AML cumulative-limit read and the
    // execution must be atomic, or two concurrent transfers could both pass the
    // limit/balance gate and overshoot. Different businesses still run in
    // parallel. Early-returns become outcome values handled after the lock.
    // The business lock makes the balance/AML read-then-spend atomic PER
    // BUSINESS. The staff cap is a per-STAFF quantity summed across every
    // business they act for, so a business lock does not protect it: an owner
    // with two banked businesses has a staff member who can fire one send at
    // each, both read spent=0, both pass the cap, and 2x the authorised amount
    // leaves. Reachable today for Fincra countries (GH/KE/TZ), whose
    // provisioning has no one-account-per-owner constraint.
    //
    // So a staff send takes a second lock keyed on the ACTOR. Both are acquired
    // in ONE transaction on ONE connection (see withBusinessLock) — nesting two
    // calls would hold two pooled clients per request while the Prisma work
    // inside draws from that same pool, which is how a busy instance deadlocks
    // itself. Owners are untouched and pay nothing.
    const lockKeys = isStaff ? [`staffcap:${actorId}`, biz.id] : [biz.id];

    const outcome = await prisma.withBusinessLock(lockKeys, async () => {
      const amlCheck = await runPreTransferChecks({
        req,
        user: ownerFull,   // compliance subject: freeze, tier, velocity windows
        actor: actorFull,  // who gets and answers the step-up OTP
        business: biz,
        amount: Number(amount),
        otp,
      });
      if (!amlCheck.ok) {
        // On the first attempt of a large transfer, the pipeline returns
        // OTP_REQUIRED before any code has been issued. Dispatch one now so
        // the user can collect it from email/SMS, then surface the request
        // to the client with the masked identifier.
        if (amlCheck.code === "OTP_REQUIRED") {
          // Use the target the pipeline itself chose. Picking one here
          // independently is how dispatch and verification drift apart the
          // moment the actor is not the account holder.
          const target = amlCheck.otpTarget;
          if (target) {
            try {
              await dispatchOtp(target, TRANSFER_OTP_TYPE, { country: biz.country });
            } catch (err) {
              console.error("[transfers] OTP dispatch failed:", err.message);
              return { status: 503, body: { error: "Could not send the verification code. Please try again.", code: "OTP_DISPATCH_FAILED" } };
            }
          }
        }
        // WHITELIST, deliberately — do not replace with `...amlCheck`.
        // amlCheck carries otpTarget, the UNMASKED destination for the step-up
        // code. Only the masked otpIdentifier is safe to return.
        return {
          status: amlCheck.status || 400,
          body: {
            error: amlCheck.error,
            code: amlCheck.code,
            ...(amlCheck.otpIdentifier ? { otpIdentifier: amlCheck.otpIdentifier } : {}),
          },
        };
      }

      // ── Per-staff daily cap ───────────────────────────────────────
      // The owner's own AML limits above are the business's ceiling. This is a
      // SECOND, tighter ceiling on how much any one staff member may move, and
      // it is the whole reason granting canTransfer is not equivalent to handing
      // over the account.
      //
      // Default is 0 (auth.js coalesces a null grant to 0), so a freshly granted
      // staff member can send NOTHING until the owner names a number. That is
      // deliberate: it is what makes this route safe to ship before the approval
      // queue exists, because the fail-closed path is "refuse", not "send".
      //
      // Window is a rolling 24h, matching the AML pipeline rather than a
      // calendar day — a calendar day resets at midnight and would let a staff
      // member spend 2x the cap across a two-minute boundary.
      //
      // Attribution comes from Transaction.recordedBy, which the executor stamps
      // below. Not the audit log: audit() is fire-and-forget and swallows its
      // own failures, so a dropped audit row would silently raise the cap. The
      // spend record has to be the same row as the money.
      if (isStaff) {
        // Worst-case fee, on purpose. The real fee isn't known until the
        // executor has run (an internal KashBook->KashBook book transfer is
        // free), and re-running that route detection here would mean a second
        // lookup that can disagree with the executor's. Over-estimating only
        // ever refuses slightly early; under-estimating would let a staff
        // member cross the cap, so the rounding goes the safe way.
        const worstFee = computeTransferFee(Number(amount), "nip").totalCost;

        const spent = await staffSpendLast24h(prisma, actorId);
        const verdict = decideStaffCap({
          cap: req.user.dailyTransferCap,
          spent,
          amount,
          fee: worstFee,
        });

        // Over the cap is a HOLD, not a refusal. The transfer is parked for the
        // owner to approve or reject, and NO Transaction row is written — see
        // the StaffTransferRequest model comment for why parking it in the
        // ledger as complianceStatus "held" would corrupt the balance.
        if (!verdict.allowed) {
          // RESOLVE THE PAYEE FROM THE BANK, not from the request body.
          //
          // The approval queue is the control that makes an over-cap staff
          // transfer safe, and the only thing the owner has to decide on is the
          // beneficiary. Storing the staff member's own `accountName` would let
          // them type "ACME Suppliers Ltd" against their cousin's account
          // number and have the owner approve exactly that — the queue would
          // look like oversight while providing none. Worse, executeTransfer
          // SKIPS its name enquiry whenever accountName is already set, so the
          // spoofed name would also be what gets stamped on the counterparty.
          //
          // Falls back to the supplied name only if the enquiry itself fails,
          // and says so, so the owner is never shown an unverified name as
          // though it were confirmed.
          let verifiedName = null;
          let nameVerified = false;
          try {
            const internal = await prisma.business.findFirst({
              where: {
                virtualAccountNumber: accountNumber,
                OR: [{ providerAccountId: { not: null } }, { anchorAccountId: { not: null } }],
              },
              select: { name: true, virtualAccountName: true },
            });
            if (internal) {
              verifiedName = internal.virtualAccountName || internal.name;
              nameVerified = true;
            } else {
              const ne = await provider.verifyRecipient({
                accountNumber,
                bankCode,
                currency: getCountryConfig(biz.country || "NG").currency.code,
              });
              if (ne?.accountName) { verifiedName = ne.accountName; nameVerified = true; }
            }
          } catch (e) {
            console.warn("[transfers] hold name enquiry failed:", e.message);
          }

          // HONOUR THE CLIENT'S IDEMPOTENCY KEY HERE TOO.
          //
          // The execute branch turns it into a stable payout reference so a
          // retry after a lost response cannot double-send. This branch used to
          // discard it and mint a fresh UUID, which meant the identical retried
          // POST created a SECOND request. Both are approvable, both carry
          // different references, and neither the executor's reference
          // short-circuit nor the provider's idempotency header can collapse
          // them — so an owner working through the queue pays the same
          // beneficiary twice. And with the default cap of 0, EVERY staff
          // transfer takes this branch.
          //
          // Safe inside the lock: lookup-then-create cannot race another send
          // for the same actor.
          const holdKey = idemSanitized ? `kbsa_${idemSanitized}` : `kbsa_${randomUUID().replace(/-/g, "")}`;
          let held = idemSanitized
            ? await prisma.staffTransferRequest.findUnique({ where: { idempotencyKey: holdKey } })
            : null;
          // Only reuse when it is genuinely the same intent. A client that
          // reuses a key for a different transfer must get its own row rather
          // than silently inherit this one, and a request already decided is
          // not something to re-open.
          if (
            held &&
            !(held.status === "pending" &&
              held.requestedById === actorId &&
              held.businessId === biz.id &&
              Number(held.amount) === Number(amount) &&
              held.accountNumber === accountNumber &&
              held.bankCode === bankCode)
          ) {
            held = null;
          }

          if (held) {
            // Same intent, already queued. Return the SAME 202 rather than
            // adding a duplicate for the owner to approve, and skip the second
            // audit row and push.
            return {
              status: 202,
              body: {
                status: "pending_approval",
                code: "PENDING_APPROVAL",
                requestId: held.id,
                expiresAt: held.expiresAt,
                message: "This is already waiting for the business owner to approve.",
                cap: verdict.cap,
                spent: verdict.spent,
                remaining: verdict.remaining,
              },
            };
          }

          held = await prisma.staffTransferRequest.create({
            data: {
              businessId: biz.id,
              requestedById: actorId,
              ownerId,
              accountNumber, bankCode,
              bankName: bankName || null,
              accountName: verifiedName || accountName || null,
              nameVerified,
              amount: Number(amount),
              narration: narration || null,
              currency: biz.baseCurrency || "NGN",
              status: "pending",
              reason: verdict.cap === 0
                ? "No daily limit set for this staff member"
                : "Over the staff member's daily limit",
              // Carried through to execution, so approving twice hits the
              // executor's existing-reference short-circuit. The kbsa_ prefix
              // keeps this namespace distinct from the execute branch's kbtf_,
              // so one client key cannot collide across the two paths.
              idempotencyKey: holdKey,
              capAtRequest: verdict.cap,
              spentAtRequest: verdict.spent,
              expiresAt: new Date(Date.now() + APPROVAL_TTL_MS),
            },
          });

          await audit({
            req,
            action: "STAFF_TRANSFER_HELD",
            resourceType: "business",
            resourceId: biz.id,
            severity: "warn",
            metadata: {
              requestId: held.id, staffUserId: actorId, ownerUserId: ownerId,
              cap: verdict.cap, spent: verdict.spent, attempted: verdict.cost,
            },
          }).catch(() => {});

          const who = `${actorFull.firstName || ""} ${actorFull.lastName || ""}`.trim() || "A staff member";
          pushTo(ownerId, "Transfer needs your approval",
            `${who} wants to send ${formatAmountForBusiness(biz, Number(amount))} to ${accountName || accountNumber}`,
          ).catch(() => {});

          return {
            status: 202,
            body: {
              status: "pending_approval",
              code: "PENDING_APPROVAL",
              requestId: held.id,
              expiresAt: held.expiresAt,
              message: verdict.cap === 0
                ? "Sent to the business owner for approval. You don't have a daily transfer limit yet."
                : `This is over your ${formatAmountForBusiness(biz, verdict.cap)} daily limit, so it's been sent to the business owner for approval.`,
              cap: verdict.cap,
              spent: verdict.spent,
              remaining: verdict.remaining,
            },
          };
        }
      }

      // Hand off to the shared executor — same code path the cron uses.
      const exec = await executeTransfer({
        business: biz,
        // The OWNER owns the ledger row, not whoever pressed send. Two reasons:
        // Transaction.user is onDelete SetNull and staff are hard-deleted, so
        // stamping the staff id would NULL the attribution on every transfer
        // they ever made the day they leave; and ComplianceFlag.userId must stay
        // on the KYC subject the compliance queue expects. Who pressed send is
        // recorded in the audit log, where actorId is already the staff id.
        userId: ownerId,
        // ...and this is who actually pressed send. Always stamped, owner or
        // staff, so the field means exactly one thing. The daily-cap query
        // above reads it back, so this line is what makes the cap enforceable.
        recordedBy: actorId,
        recordedByName: `${actorFull.firstName || ""} ${actorFull.lastName || ""}`.trim() || null,
        amount: Number(amount),
        accountNumber,
        bankCode,
        accountName,
        bankName,
        narration,
        reference: idempotentRef,
        amlCheck,
        req,
        notify: false, // route doesn't push — client UI shows the success state itself
      });
      return { exec };
    });

    if (outcome.status) return res.status(outcome.status).json(outcome.body);
    const { reference, route, fee } = outcome.exec;

    // Optimistically reflect the debit (amount + fee) in the cached "cash at
    // bank" so the dashboard shows the new balance immediately on its next
    // refetch, instead of the up-to-60s-stale value. Reconciles with Anchor when
    // the cache entry expires. Never let a display-cache tweak affect the result.
    try {
      require("../utils/balanceCache").adjustBalance(biz.id, -(Number(amount) + Number(fee || 0)));
    } catch { /* noop */ }

    // Remember the recipient — powers the Send Money "Recents" chips.
    // Best-effort: a failed upsert must never fail a successful transfer.
    prisma.beneficiary
      .upsert({
        where: {
          businessId_accountNumber_bankCode: {
            businessId: biz.id,
            accountNumber,
            bankCode,
          },
        },
        create: {
          businessId: biz.id,
          accountNumber,
          bankCode,
          bankName: bankName || null,
          accountName: accountName || null,
        },
        update: {
          lastUsedAt: new Date(),
          timesUsed: { increment: 1 },
          ...(accountName ? { accountName } : {}),
          ...(bankName ? { bankName } : {}),
        },
      })
      .catch((e) => console.warn("[transfers] beneficiary upsert failed:", e.message));

    res.json({ status: "success", reference, route, fee });

    // A staff-initiated debit must never be silent to the owner. The executor is
    // called with notify:false here, so without this the owner would learn
    // nothing about money leaving their account until they opened the app.
    if (isStaff) {
      const who = `${actorFull.firstName || ""} ${actorFull.lastName || ""}`.trim() || "A staff member";
      const to = accountName || accountNumber;
      const amt = formatAmountForBusiness(biz, Number(amount));
      pushTo(ownerId, "Staff sent money", `${who} sent ${amt} to ${to}`).catch(() => {});
      pushTo(actorId, "Transfer sent", `${amt} to ${to}`).catch(() => {});
      audit({
        req,
        action: "STAFF_TRANSFER_SENT",
        resourceType: "business",
        resourceId: biz.id,
        severity: "warn",
        metadata: {
          staffUserId: actorId, ownerUserId: ownerId,
          amount: Number(amount), fee, reference, route,
          capAtTime: req.user.dailyTransferCap,
        },
      }).catch(() => {});
    }

    // Detailed debit alert — fire-and-forget, never affects the transfer result.
    // Goes to the OWNER: it is their money and their fraud tripwire.
    if (ownerFull.email) {
      const counterparty =
        [accountName, bankName].filter(Boolean).join(" · ") || String(accountNumber);
      require("../utils/transactionEmail").sendTransactionEmail({
        to: ownerFull.email,
        direction: "debit",
        amount: Number(amount),
        currency: biz.currency || "NGN",
        counterparty,
        // Says who pressed send, so an unexpected debit is immediately
        // attributable rather than looking like fraud.
        narration: isStaff
          ? `${narration || ""} · Sent by ${actorFull.firstName || "staff"}`.trim()
          : narration,
        fee,
        reference,
        businessName: biz.name,
        dateLabel: new Date().toLocaleString("en-NG", { dateStyle: "medium", timeStyle: "short" }),
      });
    }
  } catch (err) {
    if (err.code === "ANCHOR_NOT_CONFIGURED")
      return res.status(503).json({ error: "Transfers not configured on this server." });
    if (err.code === "INSUFFICIENT_BALANCE")
      return res.status(400).json({ error: err.message, code: err.code });
    if (err.code === "RECIPIENT_UNVERIFIED" || err.code === "UNKNOWN_BANK")
      return res.status(400).json({ error: err.message, code: err.code });
    console.error("Transfer error:", err);
    res.status(400).json({ error: "Transfer failed" });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// Approval queue for staff transfers over their daily cap.
// ═══════════════════════════════════════════════════════════════════════

// What the requester and the approver are each allowed to see. The staff member
// asked for this transfer, so nothing here is news to them; the owner needs the
// beneficiary to make a decision. Neither gets the raw row.
const publicRequest = (r) => ({
  id: r.id,
  businessId: r.businessId,
  requestedById: r.requestedById,
  requestedByName: r.requestedByName ?? undefined,
  accountNumber: r.accountNumber,
  bankCode: r.bankCode,
  bankName: r.bankName,
  accountName: r.accountName,
  // The owner's sheet MUST show this. An unverified name is one the staff
  // member typed, and approving it is the exact risk this queue exists to stop.
  nameVerified: r.nameVerified === true,
  amount: r.amount,
  narration: r.narration,
  currency: r.currency,
  status: r.status,
  reason: r.reason,
  failureReason: r.failureReason,
  expiresAt: r.expiresAt,
  decidedAt: r.decidedAt,
  createdAt: r.createdAt,
});

// A request that has sat past its expiry is treated as expired on read, even if
// the reaper has not swept it yet. Without this an owner could open a stale list
// and approve something the system already considers dead.
const isLapsed = (r) => r.status === "pending" && r.expiresAt <= new Date();

// GET /transfers/approvals
// Owner: everything waiting on them. Staff: their own requests, so they can see
// what happened to a transfer they were told was "sent for approval".
router.get("/approvals", async (req, res) => {
  try {
    const isStaff = req.user.accountType === "staff";
    const status = String(req.query.status || "pending");

    const rows = await prisma.staffTransferRequest.findMany({
      where: isStaff
        ? { requestedById: req.user.id, ...(status === "all" ? {} : { status }) }
        : { ownerId: req.user.id, ...(status === "all" ? {} : { status }) },
      orderBy: { createdAt: "desc" },
      take: 100,
    });

    // Attach the requester's name for the owner's list — an amount and an
    // account number is not enough to decide on.
    let names = {};
    if (!isStaff && rows.length) {
      const ids = [...new Set(rows.map((r) => r.requestedById))];
      const users = await prisma.user.findMany({
        where: { id: { in: ids } },
        select: { id: true, firstName: true, lastName: true },
      });
      names = Object.fromEntries(
        users.map((u) => [u.id, `${u.firstName || ""} ${u.lastName || ""}`.trim()]),
      );
    }

    res.json(
      rows.map((r) =>
        publicRequest({
          ...r,
          status: isLapsed(r) ? "expired" : r.status,
          requestedByName: names[r.requestedById],
        }),
      ),
    );
  } catch (err) {
    console.error("[transfers/approvals]", err);
    res.status(500).json({ error: "Failed to load approvals" });
  }
});

// POST /transfers/approvals/:id/approve
// Owner-only, PIN-confirmed. Runs the full AML pipeline again at execution time
// rather than trusting the checks from when the request was made: the balance,
// the tier limits and the freeze state can all have changed since.
router.post("/approvals/:id/approve", ownerOnly("Only the business owner can approve transfers."), async (req, res) => {
  try {
    const { pin } = req.body;

    const pinCheck = await verifyTransactionPin(req.user.id, pin);
    if (!pinCheck.ok) {
      await audit({
        req, action: "PIN_FAILED", resourceType: "user", resourceId: req.user.id,
        severity: "warn", metadata: { code: pinCheck.code, context: "approve_staff_transfer" },
      }).catch(() => {});
      return res.status(pinCheck.status || 401).json({ error: pinCheck.error, code: pinCheck.code });
    }

    const request = await prisma.staffTransferRequest.findFirst({
      where: { id: req.params.id, ownerId: req.user.id },
    });
    if (!request) return res.status(404).json({ error: "Request not found" });
    if (request.status !== "pending")
      return res.status(409).json({ error: `This request was already ${request.status}.`, code: "NOT_PENDING", status: request.status });
    if (isLapsed(request))
      return res.status(409).json({ error: "This request expired. Ask your staff member to send it again.", code: "EXPIRED" });

    const biz = await prisma.business.findFirst({
      where: { id: request.businessId, userId: req.user.id },
    });
    if (!biz) return res.status(404).json({ error: "Business not found" });

    const provider = getProvider(biz);
    if (!provider.supportsBanking)
      return res.status(400).json({ error: "Banking isn't available in your country yet.", code: "BANKING_NOT_AVAILABLE" });

    const [ownerFull, staffFull] = await Promise.all([
      prisma.user.findUnique({
        where: { id: request.ownerId },
        select: { id: true, accountStatus: true, complianceFreezeReason: true, email: true, phone: true, firstName: true, lastName: true },
      }),
      prisma.user.findUnique({
        where: { id: request.requestedById },
        select: { id: true, firstName: true, lastName: true, employerId: true },
      }),
    ]);
    if (!ownerFull) return res.status(404).json({ error: "Owner not found" });

    // The staff member may have been removed, or moved to another employer,
    // while the request sat in the queue. Approving then would send money on
    // behalf of someone who no longer works here.
    if (!staffFull || staffFull.employerId !== request.ownerId) {
      await prisma.staffTransferRequest.updateMany({
        where: { id: request.id, status: "pending" },
        data: { status: "rejected", reason: "The staff member no longer works for this business.", decidedById: req.user.id, decidedAt: new Date() },
      });
      return res.status(409).json({ error: "That staff member is no longer on your team, so this request was cancelled.", code: "STAFF_GONE" });
    }

    const outcome = await prisma.withBusinessLock(biz.id, async () => {
      // ATOMIC CLAIM. This single statement is what makes a double-tap safe:
      // exactly one caller can move the row out of "pending", and only that
      // caller proceeds to spend money. Everything before this point is a read
      // and can legitimately race; nothing after it can run twice.
      const claim = await prisma.staffTransferRequest.updateMany({
        // expiresAt is re-checked HERE, not only at the earlier read. Between
        // that read and this line the request survives a business lookup, a
        // provider resolve, two user lookups and a wait for the advisory lock —
        // so a request that was live when we looked can be past its expiry by
        // the time we spend. The TTL exists because an approval granted late is
        // an approval the owner no longer means; enforcing it anywhere but the
        // claim leaves exactly that window open.
        where: { id: request.id, status: "pending", expiresAt: { gt: new Date() } },
        data: { status: "approving", decidedById: req.user.id, decidedAt: new Date() },
      });
      if (claim.count !== 1) {
        return { status: 409, body: { error: "This request is already being processed.", code: "NOT_PENDING" } };
      }

      const amlCheck = await runPreTransferChecks({
        req,
        user: ownerFull,   // compliance subject
        actor: ownerFull,  // the OWNER is approving, so any step-up is theirs
        business: biz,
        amount: Number(request.amount),
        // The owner has just entered their transaction PIN against this specific
        // request, which is the same standing the recurring-expense cron relies
        // on. Requiring a second OTP on top would mean the owner authenticates
        // twice to approve one transfer they are already looking at.
        bypassOtp: true,
      });
      if (!amlCheck.ok) {
        // Put it back so the owner can retry once the blocker clears, rather
        // than silently consuming their approval.
        await prisma.staffTransferRequest.update({
          where: { id: request.id },
          data: { status: "pending", decidedById: null, decidedAt: null, failureReason: amlCheck.error },
        });
        return { status: amlCheck.status || 400, body: { error: amlCheck.error, code: amlCheck.code } };
      }

      const exec = await executeTransfer({
        business: biz,
        userId: request.ownerId,
        // Attribution stays with the staff member who asked. The owner
        // authorised it; they did not record it.
        recordedBy: request.requestedById,
        recordedByName: `${staffFull.firstName || ""} ${staffFull.lastName || ""}`.trim() || null,
        amount: Number(request.amount),
        accountNumber: request.accountNumber,
        bankCode: request.bankCode,
        // Only pass a name the BANK confirmed. executeTransfer skips its own
        // name enquiry whenever accountName is truthy, so handing it an
        // unverified, staff-supplied string would both skip verification and
        // stamp that string on the counterparty. Passing null makes the
        // executor resolve it properly, and RECIPIENT_UNVERIFIED aborts before
        // any money moves.
        accountName: request.nameVerified ? request.accountName : null,
        bankName: request.bankName,
        narration: request.narration,
        reference: request.idempotencyKey,
        amlCheck,
        req,
        notify: false,
      });

      await prisma.staffTransferRequest.update({
        where: { id: request.id },
        data: {
          status: "executed",
          executedTransactionId: exec.transactionId || null,
          executedReference: exec.reference || null,
        },
      });

      return { exec };
    });

    if (outcome.status) return res.status(outcome.status).json(outcome.body);
    const { reference, route, fee } = outcome.exec;

    try {
      require("../utils/balanceCache").adjustBalance(biz.id, -(Number(request.amount) + Number(fee || 0)));
    } catch { /* noop */ }

    res.json({ status: "success", reference, route, fee, requestId: request.id });

    const who = `${staffFull.firstName || ""} ${staffFull.lastName || ""}`.trim() || "your staff member";
    const amt = formatAmountForBusiness(biz, Number(request.amount));
    const to = request.accountName || request.accountNumber;
    pushTo(request.requestedById, "Transfer approved", `${amt} to ${to} has been sent.`).catch(() => {});
    audit({
      req, action: "STAFF_TRANSFER_APPROVED", resourceType: "business", resourceId: biz.id,
      severity: "warn",
      metadata: { requestId: request.id, staffUserId: request.requestedById, amount: Number(request.amount), fee, reference, route },
    }).catch(() => {});

    if (ownerFull.email) {
      require("../utils/transactionEmail").sendTransactionEmail({
        to: ownerFull.email,
        direction: "debit",
        amount: Number(request.amount),
        currency: biz.currency || "NGN",
        counterparty: [request.accountName, request.bankName].filter(Boolean).join(" · ") || String(request.accountNumber),
        narration: `${request.narration || ""} · Approved for ${who}`.trim(),
        fee,
        reference,
        businessName: biz.name,
        dateLabel: new Date().toLocaleString("en-NG", { dateStyle: "medium", timeStyle: "short" }),
      });
    }
  } catch (err) {
    // The claim already moved this row to "approving", so it must not be left
    // there — no route or reaper can act on that state. Where it goes depends
    // entirely on whether the provider could possibly have moved money.
    //
    // These codes are all raised BEFORE the payout call, so nothing left the
    // account and the owner can safely try again. Anything else — a timeout, a
    // socket reset, a 5xx, a bookkeeping failure after a successful debit — is
    // ambiguous, and ambiguity here must never resolve to "offer it again".
    const SAFE_TO_RETRY = new Set([
      "INSUFFICIENT_BALANCE", "RECIPIENT_UNVERIFIED", "UNKNOWN_BANK",
      "NO_BANKING", "ANCHOR_NOT_CONFIGURED", "BANKING_NOT_AVAILABLE", "NOT_IMPLEMENTED",
    ]);
    const safeToRetry = SAFE_TO_RETRY.has(err.code);
    const reason = (err.message || "Transfer failed").slice(0, 300);
    if (!safeToRetry) {
      console.error(
        `[transfers/approve] AMBIGUOUS FAILURE on request ${req.params.id} — parked as failed, DO NOT re-approve without checking the provider:`,
        err.code || err.message,
      );
      audit({
        req, action: "STAFF_TRANSFER_APPROVAL_AMBIGUOUS", resourceType: "business",
        resourceId: req.params.id, severity: "alert",
        metadata: { requestId: req.params.id, code: err.code || null, error: reason },
      }).catch(() => {});
    }

    await prisma.staffTransferRequest
      .updateMany({
        where: { id: req.params.id, status: "approving" },
        data: safeToRetry
          ? { status: "pending", decidedById: null, decidedAt: null, failureReason: reason }
          // NOT back to pending. We do not know whether the provider moved the
          // money — a socket that died after the payout request was accepted
          // looks identical here to one that never reached them. Returning it
          // to the queue invites the owner to approve again, and the executor's
          // reference short-circuit only saves us if the Transaction row was
          // written, which is exactly what did not happen on this path.
          // "failed" is terminal and visible; a duplicate payout is not
          // recoverable.
          : { status: "failed", failureReason: reason },
      })
      .catch(() => {});

    if (err.code === "INSUFFICIENT_BALANCE" || err.code === "RECIPIENT_UNVERIFIED" || err.code === "UNKNOWN_BANK")
      return res.status(400).json({ error: err.message, code: err.code });
    console.error("[transfers/approve]", err);
    res.status(400).json({ error: "Transfer failed" });
  }
});

// POST /transfers/approvals/:id/reject
router.post("/approvals/:id/reject", ownerOnly("Only the business owner can reject transfers."), async (req, res) => {
  try {
    const reason = String(req.body?.reason || "").trim().slice(0, 300);

    // Guarded on "pending" so a reject cannot race an in-flight approval and
    // mark an executed transfer as rejected.
    const claim = await prisma.staffTransferRequest.updateMany({
      where: { id: req.params.id, ownerId: req.user.id, status: "pending" },
      data: {
        status: "rejected",
        reason: reason || "Not approved by the business owner",
        decidedById: req.user.id,
        decidedAt: new Date(),
      },
    });
    if (claim.count !== 1) {
      const existing = await prisma.staffTransferRequest.findFirst({
        where: { id: req.params.id, ownerId: req.user.id },
        select: { status: true },
      });
      if (!existing) return res.status(404).json({ error: "Request not found" });
      return res.status(409).json({ error: `This request was already ${existing.status}.`, code: "NOT_PENDING", status: existing.status });
    }

    const request = await prisma.staffTransferRequest.findUnique({ where: { id: req.params.id } });
    res.json({ status: "rejected", request: publicRequest(request) });

    pushTo(request.requestedById, "Transfer not approved",
      reason || "The business owner didn't approve this transfer.",
    ).catch(() => {});
    audit({
      req, action: "STAFF_TRANSFER_REJECTED", resourceType: "business", resourceId: request.businessId,
      severity: "warn",
      metadata: { requestId: request.id, staffUserId: request.requestedById, amount: request.amount, reason },
    }).catch(() => {});
  } catch (err) {
    console.error("[transfers/reject]", err);
    res.status(500).json({ error: "Failed to reject the request" });
  }
});

// POST /transfers/approvals/:id/cancel
// The staff member withdrawing their own request — a typo'd amount shouldn't
// need the owner to formally reject it. Scoped to requestedById so one staff
// member cannot cancel another's.
router.post("/approvals/:id/cancel", async (req, res) => {
  try {
    const claim = await prisma.staffTransferRequest.updateMany({
      where: { id: req.params.id, requestedById: req.user.id, status: "pending" },
      data: { status: "cancelled", reason: "Withdrawn by the requester", decidedAt: new Date() },
    });
    if (claim.count !== 1)
      return res.status(409).json({ error: "This request can no longer be cancelled.", code: "NOT_PENDING" });

    const request = await prisma.staffTransferRequest.findUnique({ where: { id: req.params.id } });
    res.json({ status: "cancelled", request: publicRequest(request) });
  } catch (err) {
    console.error("[transfers/cancel]", err);
    res.status(500).json({ error: "Failed to cancel the request" });
  }
});

module.exports = router;
