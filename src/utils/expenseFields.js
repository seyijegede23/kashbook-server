// What an expense may carry since the Zoho-style Add Expense (2026-10-12): its
// lines (Zoho's "Itemize": one expense, several accounts), the supplier's
// receipt or invoice number, and the customer the cost was for. Shared by POST
// and PATCH /expenses, and (the reference and the customer) by
// POST /transactions/:id/create-expense, so both check them the same way.
//
// Every check throws a coded 400 carrying the field it is about; a line's
// error also says which line (0-based), so the app can point at it:
// { error, code, field: "items", line }.
const prisma = require("./db");
const chart = require("./chart");
const { accountError, assertAccountUsable } = require("./ledgerData");
// At most two decimals, tolerant of a client's float noise (utils/money.js).
const { twoDecimals } = require("./money");

const MAX_ITEMS = 50;
const MAX_REFERENCE = 100;
const MAX_ITEM_DESCRIPTION = 200;

function fieldError(code, field, message, extra = {}) {
  return Object.assign(new Error(message), { status: 400, code, field, extra });
}

// The supplier's receipt or invoice number (Zoho's Reference#), trimmed, 100
// characters at most. undefined when it was not sent; null when it was sent
// empty (on an edit, that clears it).
function cleanReference(v) {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== "string" && typeof v !== "number") {
    throw fieldError("BAD_REFERENCE", "reference", "Enter the reference as text.");
  }
  const s = String(v).trim();
  if (s.length > MAX_REFERENCE) {
    throw fieldError("REFERENCE_TOO_LONG", "reference", `A reference can be at most ${MAX_REFERENCE} characters.`);
  }
  return s || null;
}

// The customer a cost was for: one of this owner's customers, of this business
// or of none yet, the rule a credit sale's customer follows (routes/sales.js).
// It shows on the customer's page and changes no total. undefined when it was
// not sent; null when it was sent empty (on an edit, that clears it).
async function expenseCustomerId(ownerId, businessId, customerId) {
  if (customerId === undefined) return undefined;
  if (customerId === null || customerId === "") return null;
  const found =
    typeof customerId === "string"
      ? await prisma.customer.findFirst({
          where: { id: customerId, userId: ownerId, ...(businessId ? { OR: [{ businessId }, { businessId: null }] } : {}) },
          select: { id: true },
        })
      : null;
  if (!found) throw fieldError("CUSTOMER_NOT_FOUND", "customerId", "That customer isn't one of this business's customers.");
  return found.id;
}

// One line as sent, checked for shape only (the accounts are checked after
// every line has passed this, so a typo is reported before any lookup).
function readLine(raw, i) {
  const bad = (code, message) => fieldError(code, "items", message, { line: i });
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw bad("BAD_ITEMS", "Each line needs an account and an amount.");
  }
  if (raw.accountId === undefined || raw.accountId === null || raw.accountId === "") {
    throw bad("ITEM_ACCOUNT_REQUIRED", "Choose an account for every line.");
  }
  const amount =
    typeof raw.amount === "number" ? raw.amount
      : typeof raw.amount === "string" && raw.amount.trim() ? Number(raw.amount)
        : NaN;
  // A kobo at least, once rounded to the kobo it is stored as: a speck such
  // as 1e-15 passes the two-decimals test and would be saved as 0, which the
  // database refuses (ExpenseItem_amount_check).
  const kobo = Math.round(amount * 100);
  if (!Number.isFinite(amount) || kobo < 1 || !twoDecimals(amount)) {
    throw bad("BAD_ITEM_AMOUNT", "Enter an amount above zero on every line, in naira and kobo.");
  }
  let description = null;
  if (raw.description !== undefined && raw.description !== null) {
    if (typeof raw.description !== "string") throw bad("BAD_ITEMS", "A line's description is text.");
    description = raw.description.trim();
    if (description.length > MAX_ITEM_DESCRIPTION) {
      throw bad("ITEM_DESCRIPTION_TOO_LONG", `A line's description can be at most ${MAX_ITEM_DESCRIPTION} characters.`);
    }
  }
  return {
    accountId: String(raw.accountId),
    amount: kobo / 100,
    description: description || null,
    position: i,
    category: "other",
  };
}

// The account an expense, or one of its lines, names: null when none was
// given. Any account must be one an expense may use now (assertAccountUsable,
// "expense"), except one in `kept`: on an edit, the accounts the expense names
// already (its own and its lines'). One of those is taken as it is, even one
// the owner has since made inactive, so the expense still saves and keeps
// counting where it did, as an invoice's lines do (routes/invoices.js
// checkLineAccounts). It need only still be in this business's chart, where
// its category comes from. Who may use it is still checked: an equity account
// stays the owner's.
async function resolveAccount(businessId, accountId, { kept = new Set(), isStaff = false } = {}) {
  if (accountId === undefined || accountId === null || accountId === "") return null;
  if (!kept.has(String(accountId))) return assertAccountUsable(businessId, accountId, "expense", { isStaff });
  const acc = await prisma.ledgerAccount.findFirst({ where: { id: String(accountId), businessId } });
  if (!acc) throw accountError("That account isn't in this business's chart.", "ACCOUNT_NOT_FOUND");
  if (isStaff && chart.classOf(acc.type) === "equity") {
    throw accountError("Only the owner can use this account.", "OWNER_ONLY", 403);
  }
  return acc;
}

// The lines of an itemized expense, all checked before anything is saved: 1 to
// 50 of them, each on an account an expense may use (assertAccountUsable,
// "expense": spending, or something the business now owns or owes, which the
// books then leave out of spending), each amount above zero in naira and kobo,
// each description 200 characters at most. Lines need a business: the
// accounts are its chart.
//
// An edit passes `kept`, the accounts the expense names already (a Set of
// ids), and a line on one of those is taken as it is (resolveAccount). The app
// sends every line when any one changes, the untouched ones included, so
// without this a line on an account made inactive since would block every
// edit of the others. Only an account new to the expense is checked as above.
// A create passes none.
//
// Returns undefined when no lines were sent, null when an empty list (or null)
// was sent (a whole expense), else { lines, total, category }: each line with
// its account's category slug ("other" when it has none) and its 0-based
// position in the order sent; total = their sum in kobo, back in naira;
// category = the first line's (what older app versions show).
async function resolveItems(businessId, raw, { isStaff = false, kept = new Set() } = {}) {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (!Array.isArray(raw)) throw fieldError("BAD_ITEMS", "items", "Send the lines as a list.");
  if (!raw.length) return null;
  if (raw.length > MAX_ITEMS) {
    throw fieldError("TOO_MANY_ITEMS", "items", `An expense can have at most ${MAX_ITEMS} lines.`, { max: MAX_ITEMS });
  }
  if (!businessId) {
    throw fieldError("BUSINESS_REQUIRED", "items", "Choose a business before splitting an expense into lines.");
  }
  const lines = raw.map(readLine);
  const checked = new Map();
  for (const line of lines) {
    if (!checked.has(line.accountId)) {
      try {
        checked.set(line.accountId, await resolveAccount(businessId, line.accountId, { kept, isStaff }));
      } catch (e) {
        if (e && e.status) Object.assign(e, { field: "items", extra: { line: line.position } });
        throw e;
      }
    }
    line.category = checked.get(line.accountId).categorySlug || "other";
  }
  const total = lines.reduce((s, l) => s + Math.round(l.amount * 100), 0) / 100;
  return { lines, total, category: lines[0].category };
}

// The columns an ExpenseItem row is created with, from a resolved line.
function itemData(line) {
  return {
    accountId: line.accountId,
    category: line.category,
    description: line.description,
    amount: line.amount,
    position: line.position,
  };
}

module.exports = {
  MAX_ITEMS,
  MAX_REFERENCE,
  MAX_ITEM_DESCRIPTION,
  twoDecimals,
  cleanReference,
  expenseCustomerId,
  resolveAccount,
  resolveItems,
  itemData,
};
