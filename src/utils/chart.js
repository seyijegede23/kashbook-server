// The chart of accounts (2026-10-11): Zoho Books' model, adapted for a Nigerian
// shop. Pure and shared: mirrored verbatim to the app (src/utils/chart.js) like
// books.js, so pickers, the app's own totals and the server's ledger read the
// same types, the same default chart and the same rules for records that carry
// no account of their own.
//
// Accounts live in LedgerAccount (one row per business and account). A record
// names its account with `accountId` when the merchant picked one; otherwise
// its account follows from what it already says (an expense's category, a
// payment's method, a bank row's purpose). That resolution is here, in one
// place, so old app versions and the server's own writers never need to know
// about accounts.

// Zoho's account types, each in one of five classes.
const ACCOUNT_TYPES = {
  cash: "asset",
  bank: "asset",
  payment_clearing: "asset",
  accounts_receivable: "asset",
  stock: "asset",
  other_current_asset: "asset",
  fixed_asset: "asset",
  other_asset: "asset",
  accounts_payable: "liability",
  credit_card: "liability",
  other_current_liability: "liability",
  long_term_liability: "liability",
  other_liability: "liability",
  equity: "equity",
  income: "income",
  other_income: "income",
  expense: "expense",
  cost_of_goods_sold: "expense",
  other_expense: "expense",
};

// The order groups and types are shown in (balance sheet first, as Zoho does).
const CLASS_ORDER = ["asset", "liability", "equity", "income", "expense"];
const TYPE_ORDER = Object.keys(ACCOUNT_TYPES);

function classOf(type) {
  return ACCOUNT_TYPES[type] || null;
}

// Profit-and-loss classes; the rest are on the balance sheet.
function isProfitClass(cls) {
  return cls === "income" || cls === "expense";
}

// Assets and expenses grow with a debit; the rest with a credit.
function debitNormal(cls) {
  return cls === "asset" || cls === "expense";
}

// Types a merchant may not create: the system keeps one of each.
const SYSTEM_ONLY_TYPES = ["accounts_receivable", "accounts_payable", "stock", "payment_clearing"];

// The accounts the engine posts to by itself. Stable keys, never shown.
const SYS = {
  CASH: "cash",
  UNDEPOSITED: "undeposited",
  KASHBOOK: "kashbook",
  OTHER_BANK: "other_bank",
  POS: "pos",
  BANK_MATCH: "bank_match",
  AR: "ar",
  STOCK: "stock",
  DEFERRED_COGS: "deferred_cogs",
  LEGACY: "legacy",
  AP: "ap",
  VAT: "vat_payable",
  SUSPENSE: "suspense",
  LOANS: "loans",
  OWNER_EQUITY: "owner_equity",
  DRAWINGS: "drawings",
  OPENING: "opening_balance_adj",
  RETAINED: "retained_earnings",
  SALES: "sales",
  SERVICE_INCOME: "service_income",
  DISCOUNT: "discount",
  SALES_RETURNS: "sales_returns",
  BANK_RECEIPTS: "bank_receipts",
  OTHER_INCOME: "other_income",
  COGS: "cogs",
  COST_OF_SERVICES: "cost_of_services",
  STOCK_ADJ: "stock_adjustments",
  BAD_DEBT: "bad_debt",
  BANK_CHARGES: "bank_charges",
  SALARIES: "salaries",
  OTHER_EXPENSES: "other_expenses",
  BANK_PAYMENTS: "bank_payments",
};

// System accounts nothing may be posted to by hand (pickers, journals, opening
// balances): the engine keeps them in step with the records behind them.
const CONTROLLED = [
  SYS.KASHBOOK, SYS.BANK_MATCH, SYS.AR, SYS.AP, SYS.STOCK, SYS.DEFERRED_COGS,
  SYS.LEGACY, SYS.SUSPENSE, SYS.RETAINED, SYS.BANK_RECEIPTS, SYS.BANK_PAYMENTS,
];

// Accounts shown only while they hold something (housekeeping accounts).
const HIDDEN_AT_ZERO = [SYS.BANK_MATCH, SYS.LEGACY, SYS.SUSPENSE, SYS.DEFERRED_COGS, SYS.STOCK, SYS.STOCK_ADJ];

// The default chart. `seed` is the stable key the app translates the name by
// (until the merchant renames the account); `sys` marks a system account;
// `cat` is the expense category slug the account stands for.
const DEFAULT_CHART = [
  // What you own
  { seed: "cash_at_hand", sys: SYS.CASH, type: "cash", name: "Cash at Hand" },
  { seed: "undeposited_funds", sys: SYS.UNDEPOSITED, type: "cash", name: "Undeposited Funds" },
  { seed: "kashbook_account", sys: SYS.KASHBOOK, type: "bank", name: "KashBook Account" },
  { seed: "other_bank_account", sys: SYS.OTHER_BANK, type: "bank", name: "Other Bank Account" },
  { seed: "pos_account", sys: SYS.POS, type: "bank", name: "POS Account" },
  { seed: "bank_matching", sys: SYS.BANK_MATCH, type: "payment_clearing", name: "Bank Matching" },
  { seed: "accounts_receivable", sys: SYS.AR, type: "accounts_receivable", name: "Accounts Receivable" },
  { seed: "inventory_asset", sys: SYS.STOCK, type: "stock", name: "Inventory Asset" },
  { seed: "prepaid_expenses", type: "other_current_asset", name: "Prepaid Expenses" },
  { seed: "employee_advance", type: "other_current_asset", name: "Employee Advance" },
  { seed: "advance_tax", type: "other_current_asset", name: "Advance Tax" },
  { seed: "wht_receivable", type: "other_current_asset", name: "Withholding Tax Receivable" },
  { seed: "goods_awaiting_payment", sys: SYS.DEFERRED_COGS, type: "other_current_asset", name: "Goods Sold Awaiting Payment" },
  { seed: "older_records", sys: SYS.LEGACY, type: "other_current_asset", name: "Older Records" },
  { seed: "furniture_equipment", type: "fixed_asset", name: "Furniture and Equipment" },
  { seed: "motor_vehicles", type: "fixed_asset", name: "Motor Vehicles" },
  { seed: "generators_power", type: "fixed_asset", name: "Generators and Power Equipment" },
  { seed: "accumulated_depreciation", type: "fixed_asset", name: "Accumulated Depreciation" },
  // What you owe
  { seed: "accounts_payable", sys: SYS.AP, type: "accounts_payable", name: "Accounts Payable" },
  { seed: "vat_payable", sys: SYS.VAT, type: "other_current_liability", name: "VAT Payable" },
  { seed: "wht_payable", type: "other_current_liability", name: "Withholding Tax Payable" },
  { seed: "paye_pension_payable", type: "other_current_liability", name: "PAYE and Pension Payable" },
  { seed: "employee_reimbursements", type: "other_current_liability", name: "Employee Reimbursements" },
  { seed: "unexplained_receipts", sys: SYS.SUSPENSE, type: "other_current_liability", name: "Unexplained Receipts" },
  { seed: "loans", sys: SYS.LOANS, type: "long_term_liability", name: "Loans" },
  // Your stake
  { seed: "owners_equity", sys: SYS.OWNER_EQUITY, type: "equity", name: "Owner's Equity" },
  { seed: "drawings", sys: SYS.DRAWINGS, type: "equity", name: "Drawings" },
  { seed: "share_capital", type: "equity", name: "Share Capital" },
  { seed: "opening_balance_adjustments", sys: SYS.OPENING, type: "equity", name: "Opening Balance Adjustments" },
  { seed: "retained_earnings", sys: SYS.RETAINED, type: "equity", name: "Retained Earnings" },
  // Money in
  { seed: "sales", sys: SYS.SALES, type: "income", name: "Sales" },
  { seed: "service_income", sys: SYS.SERVICE_INCOME, type: "income", name: "Service Income" },
  { seed: "discount", sys: SYS.DISCOUNT, type: "income", name: "Discount" },
  { seed: "sales_returns", sys: SYS.SALES_RETURNS, type: "income", name: "Sales Returns" },
  { seed: "general_income", type: "income", name: "General Income" },
  { seed: "shipping_charge", type: "income", name: "Shipping Charge" },
  { seed: "late_fee_income", type: "income", name: "Late Fee Income" },
  { seed: "unexplained_bank_receipts", sys: SYS.BANK_RECEIPTS, type: "income", name: "Unexplained Bank Receipts" },
  { seed: "interest_income", type: "other_income", name: "Interest Income" },
  { seed: "other_income", sys: SYS.OTHER_INCOME, type: "other_income", name: "Other Income" },
  // Money out
  { seed: "cost_of_goods_sold", sys: SYS.COGS, cat: "supplies", type: "cost_of_goods_sold", name: "Cost of Goods Sold" },
  { seed: "cost_of_services", sys: SYS.COST_OF_SERVICES, type: "cost_of_goods_sold", name: "Cost of Services" },
  { seed: "stock_adjustments", sys: SYS.STOCK_ADJ, type: "cost_of_goods_sold", name: "Stock Adjustments" },
  { seed: "advertising_marketing", cat: "marketing", type: "expense", name: "Advertising and Marketing" },
  { seed: "automobile_expense", type: "expense", name: "Automobile Expense" },
  { seed: "bad_debt", sys: SYS.BAD_DEBT, type: "expense", name: "Bad Debt" },
  { seed: "bank_charges", sys: SYS.BANK_CHARGES, type: "expense", name: "Bank Fees and Charges" },
  { seed: "consultant_expense", type: "expense", name: "Consultant Expense" },
  { seed: "depreciation_expense", type: "expense", name: "Depreciation Expense" },
  { seed: "electricity_utilities", cat: "utility", type: "expense", name: "Electricity and Utilities" },
  { seed: "fuel_generator", cat: "fuel", type: "expense", name: "Fuel and Generator" },
  { seed: "it_internet", type: "expense", name: "IT and Internet" },
  { seed: "janitorial", type: "expense", name: "Janitorial" },
  { seed: "levies_permits_taxes", type: "expense", name: "Levies, Permits and Taxes" },
  { seed: "lodging", type: "expense", name: "Lodging" },
  { seed: "meals_entertainment", type: "expense", name: "Meals and Entertainment" },
  { seed: "postage", type: "expense", name: "Postage" },
  { seed: "printing_stationery", type: "expense", name: "Printing and Stationery" },
  { seed: "rent", cat: "rent", type: "expense", name: "Rent" },
  { seed: "repairs_maintenance", cat: "maintenance", type: "expense", name: "Repairs and Maintenance" },
  { seed: "salaries_wages", sys: SYS.SALARIES, cat: "salary", type: "expense", name: "Salaries and Employee Wages" },
  { seed: "telephone_data_airtime", type: "expense", name: "Telephone, Data and Airtime" },
  { seed: "transport_delivery", cat: "transport", type: "expense", name: "Transport and Delivery" },
  { seed: "travel", type: "expense", name: "Travel" },
  { seed: "other_expenses", sys: SYS.OTHER_EXPENSES, cat: "other", type: "expense", name: "Other Expenses" },
  { seed: "unexplained_bank_payments", sys: SYS.BANK_PAYMENTS, type: "expense", name: "Unexplained Bank Payments" },
];

// Expense category slugs the app has written over the years, mapped to the
// slug of the account that stands for them. Unknown slugs keep their own
// account (one per slug, created when the chart is set up).
const SLUG_ALIASES = {
  "": "other",
  misc: "other",
  miscellaneous: "other",
  utilities: "utility",
  electricity: "utility",
  generator: "fuel",
  diesel: "fuel",
  petrol: "fuel",
  inventory: "supplies",
  stock: "supplies",
  salaries: "salary",
  wages: "salary",
};

function lowerTrim(v) {
  return String(v == null ? "" : v).trim().toLowerCase();
}

// The account slug an expense category stands for.
function canonicalSlug(category) {
  const s = lowerTrim(category);
  return Object.prototype.hasOwnProperty.call(SLUG_ALIASES, s) ? SLUG_ALIASES[s] : s;
}

// A category label as an account name ("generator-fuel" → "Generator Fuel").
// Word by word: a regex \b is ASCII-only, and would capitalise inside "ọjà".
function nameFromSlug(slug) {
  return String(slug || "")
    .replace(/[-_]+/g, " ")
    .trim()
    .split(/\s+/)
    .map((w) => {
      const chars = Array.from(w);
      return chars.length ? chars[0].toUpperCase() + chars.slice(1).join("") : w;
    })
    .join(" ");
}

// The key names and codes are unique by.
function nameKey(name) {
  return lowerTrim(name).replace(/\s+/g, " ");
}

// ── Lookups over one business's chart ────────────────────────────────────────

// accounts: [{ id, type, systemKey, categorySlug, aliasSlugs, inactiveAt, ... }]
// An account stands for its own category and for the categories merged into
// it (aliasSlugs), so an older app's expense in a merged category lands where
// the merge put it. A category an account has as its own is never taken by
// another account's alias, wherever either is listed.
function indexChart(accounts) {
  const list = accounts || [];
  const byId = new Map();
  const bySystemKey = new Map();
  const byCategorySlug = new Map();
  for (const a of list) {
    byId.set(a.id, a);
    if (a.systemKey) bySystemKey.set(a.systemKey, a);
    if (a.categorySlug) byCategorySlug.set(a.categorySlug, a);
  }
  for (const a of list) {
    for (const slug of Array.isArray(a.aliasSlugs) ? a.aliasSlugs : []) {
      if (slug && !byCategorySlug.has(slug)) byCategorySlug.set(slug, a);
    }
  }
  return { byId, bySystemKey, byCategorySlug, accounts: list };
}

function sysAccount(chart, key) {
  return chart.bySystemKey.get(key) || null;
}

// An explicit account on a record, when it exists in this chart.
function explicit(chart, id) {
  return id ? chart.byId.get(id) || null : null;
}
const explicitAccount = explicit;

// The class of a record's explicit account, or null (no account, or unknown).
function accountClass(chart, id) {
  const a = explicit(chart, id);
  return a ? classOf(a.type) : null;
}

// ── Where a record's money went or came from ─────────────────────────────────

// Payment methods as the system accounts they land in. A bank link (the record
// was matched to a NUBAN row) beats all of them: that money sits in the
// KashBook account, reached through Bank Matching.
const METHOD_ACCOUNT = {
  cash: SYS.CASH,
  transfer: SYS.OTHER_BANK,
  pos: SYS.POS,
  card: SYS.POS,
  cheque: SYS.UNDEPOSITED,
  other: SYS.UNDEPOSITED,
  bank: SYS.BANK_MATCH,
};

// direction: "in" (a sale or payment received) or "out" (an expense paid).
// "credit" on a sale is money owed to the business; on an expense, owed by it.
function methodAccountKey(method, direction) {
  const m = lowerTrim(method);
  if (m === "credit") return direction === "out" ? SYS.AP : SYS.AR;
  if (m.startsWith("refund_")) return METHOD_ACCOUNT[m.slice(7)] || SYS.UNDEPOSITED;
  return METHOD_ACCOUNT[m] || SYS.UNDEPOSITED;
}

// The money account of a record: its bank link, else the account picked for
// it, else its method. The link beats a pick: the bank row the record was
// matched to already moved that money through the KashBook account and left it
// in Bank Matching for the record (utils/ledger.js), so the picked account
// would count the same money a second time and Bank Matching would keep it for
// good. Unmatched, the record goes back to its pick.
function moneyAccount(chart, { accountId, linked, method, direction }) {
  return (
    (linked ? sysAccount(chart, SYS.BANK_MATCH) : null) ||
    explicit(chart, accountId) ||
    sysAccount(chart, methodAccountKey(method, direction)) ||
    sysAccount(chart, SYS.UNDEPOSITED)
  );
}

// ── What a record is ─────────────────────────────────────────────────────────

// An expense's account: the one picked, else its category's, else Other Expenses.
function expenseAccount(chart, expense) {
  return (
    explicit(chart, expense && expense.accountId) ||
    chart.byCategorySlug.get(canonicalSlug(expense && expense.category)) ||
    sysAccount(chart, SYS.OTHER_EXPENSES)
  );
}

// A sale's (or invoice line's, or repayment's) income account.
function incomeAccount(chart, accountId) {
  return explicit(chart, accountId) || sysAccount(chart, SYS.SALES);
}

// The income account a line for an item counts as when the line names none
// of its own (release 3): the item's own account (incomeAccountId) while a
// sale may use it (pickerAllows "income": in this chart, active, income and
// not Discount or Sales Returns), else Service Income for a service, else
// Sales. A typed line names no item (null): Sales.
function incomeForItem(chart, item) {
  const own = explicit(chart, item && item.incomeAccountId);
  if (own && pickerAllows("income", own)) return own;
  const service = item && item.itemType === "service" ? sysAccount(chart, SYS.SERVICE_INCOME) : null;
  return service || sysAccount(chart, SYS.SALES);
}

// The account a bank row's purpose stands for.
const PURPOSE_ACCOUNT = {
  cash_deposit: SYS.CASH,
  own_transfer: SYS.OTHER_BANK,
  owner_money: SYS.OWNER_EQUITY,
  loan: SYS.LOANS,
  supplier_refund: SYS.COGS,
  savings_fee: SYS.BANK_CHARGES,
};

// Payroll and scheduled auto-debits leave the bank as plain transfers; their
// references say what they were (utils/salarySchedule.referenceFor,
// utils/recurringExpenseRunner.js).
function bankDebitDefaultKey(tx) {
  const ref = String((tx && tx.reference) || "");
  if (ref.startsWith("kbsal_")) return SYS.SALARIES;
  return SYS.BANK_PAYMENTS;
}

// recurringId when a bank debit is a scheduled auto-debit ("kashbook_rec_<id>_…").
function recurringIdOf(tx) {
  const m = /^kashbook_rec_([^_]+)_/.exec(String((tx && tx.reference) || ""));
  return m ? m[1] : null;
}

// A bank row's other side, when nothing carries it: its own account, else its
// purpose's, else payroll / auto-debit / unexplained. `recurring` maps a
// recurring rule id to that rule (for its account or category). A rule's own
// account stands for the debit only when it is spending: the books rule counts
// a debit that names no account as spending, so an auto-debit sent before its
// rule's account was written on the row (a loan repaid, the owner's drawings)
// stays on the rule's category, and the profit and loss still equals the books.
// The runner writes the rule's account on the row (utils/recurringExpenseRunner.js).
function bankRowAccount(chart, tx, basis, recurring) {
  const own = explicit(chart, tx && tx.accountId);
  if (own) return own;
  if (tx && tx.purpose && PURPOSE_ACCOUNT[tx.purpose]) return sysAccount(chart, PURPOSE_ACCOUNT[tx.purpose]);
  const isIn = lowerTrim(tx && tx.type) === "income";
  if (isIn) return sysAccount(chart, basis === "sold" ? SYS.SUSPENSE : SYS.BANK_RECEIPTS);
  const recId = recurringIdOf(tx);
  const rule = recId && recurring ? recurring.get(recId) : null;
  if (rule) {
    const ruleAccount = explicit(chart, rule.accountId);
    if (ruleAccount && classOf(ruleAccount.type) === "expense") return ruleAccount;
    return expenseAccount(chart, { category: rule.category });
  }
  return sysAccount(chart, bankDebitDefaultKey(tx));
}

// ── What a picker may offer ──────────────────────────────────────────────────

// context: "expense" (what was this money spent on), "income" (what was sold),
// "money" (paid from / received into), "credit" or "debit" (a bank row the
// merchant explains), "bill" (what a bill is for: spending, or a loan or
// another liability), "journal", "opening". No context offers an inactive
// account or a controlled one (the engine keeps those, journals included).
function pickerAllows(context, account) {
  if (!account || account.inactiveAt) return false;
  if (account.systemKey && CONTROLLED.includes(account.systemKey)) return false;
  const cls = classOf(account.type);
  const type = account.type;
  switch (context) {
    case "expense":
      return cls === "expense" || type === "fixed_asset" || type === "other_current_asset" || type === "other_asset" ||
        type === "other_current_liability" || type === "long_term_liability" || account.systemKey === SYS.DRAWINGS;
    case "income":
      return cls === "income" && account.systemKey !== SYS.DISCOUNT && account.systemKey !== SYS.SALES_RETURNS;
    case "bill":
      return cls === "expense" || type === "other_current_liability" || type === "long_term_liability" ||
        type === "other_liability";
    case "money":
      return type === "cash" || type === "bank" || type === "credit_card";
    case "credit":
      return cls === "income" || cls === "equity" || cls === "liability" || type === "cash" || type === "bank" ||
        type === "other_current_asset" || type === "fixed_asset" || cls === "expense";
    case "debit":
      return cls === "expense" || cls === "equity" || cls === "liability" || type === "cash" || type === "bank" ||
        type === "other_current_asset" || type === "fixed_asset" || type === "other_asset";
    case "journal":
      return true;
    case "opening":
      return !isProfitClass(cls) && account.systemKey !== SYS.OPENING;
    default:
      return false;
  }
}

// ── exports (everything above this line is identical in src/utils/chart.js) ──
module.exports = {
  ACCOUNT_TYPES,
  CLASS_ORDER,
  TYPE_ORDER,
  SYSTEM_ONLY_TYPES,
  SYS,
  CONTROLLED,
  HIDDEN_AT_ZERO,
  DEFAULT_CHART,
  SLUG_ALIASES,
  PURPOSE_ACCOUNT,
  classOf,
  isProfitClass,
  debitNormal,
  canonicalSlug,
  nameFromSlug,
  nameKey,
  indexChart,
  sysAccount,
  explicitAccount,
  accountClass,
  methodAccountKey,
  moneyAccount,
  expenseAccount,
  incomeAccount,
  incomeForItem,
  bankDebitDefaultKey,
  recurringIdOf,
  bankRowAccount,
  pickerAllows,
};
