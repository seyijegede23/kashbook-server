/**
 * Shared validation helpers using express-validator.
 * Import these into route files to guard POST/PATCH endpoints.
 */
const { body, param, validationResult } = require("express-validator");

// Sends a 400 with the first validation error if any failed
function checkResult(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: errors.array()[0].msg });
  }
  next();
}

// ── Reusable field validators ─────────────────────────────────────────────────

// amount: required, finite positive number. With `when`, only for the requests
// it returns true for (express-validator skips the rest of the chain).
const amountField = (field = "amount", when) =>
  (when ? body(field).if(when) : body(field))
    .exists({ checkNull: true })
    .withMessage(`${field} is required`)
    .isFloat({ min: 0.01 })
    .withMessage(`${field} must be a positive number`);

// optional notes / free-text field — max 500 chars
const notesField = (field = "notes") =>
  body(field)
    .optional({ nullable: true })
    .isString()
    .withMessage(`${field} must be a string`)
    .trim()
    .isLength({ max: 500 })
    .withMessage(`${field} must be 500 characters or less`);

// short name field — required, max 120 chars
const nameField = (field = "name") =>
  body(field)
    .notEmpty()
    .withMessage(`${field} is required`)
    .isString()
    .withMessage(`${field} must be a string`)
    .trim()
    .isLength({ max: 120 })
    .withMessage(`${field} must be 120 characters or less`);

// optional date field — must be a valid ISO date if provided
const dateField = (field = "date") =>
  body(field)
    .optional({ nullable: true })
    .isISO8601()
    .withMessage(`${field} must be a valid date`);

// UUID param (e.g. :id)
const uuidParam = (field = "id") =>
  param(field)
    .isUUID()
    .withMessage("Invalid ID format");

// ── Pre-built validator chains for each entity ────────────────────────────────

const validateSale = [
  amountField("amount"),
  dateField("date"),
  notesField("notes"),
  checkResult,
];

// An itemized expense's amount is the sum of its lines (routes/expenses.js
// works it out and ignores any amount sent), so a request that sends lines
// need not send one.
const sendsNoLines = (_value, { req }) => !(Array.isArray(req.body && req.body.items) && req.body.items.length > 0);

const validateExpense = [
  amountField("amount", sendsNoLines),
  dateField("date"),
  notesField("notes"),
  checkResult,
];

const validateCustomer = [
  nameField("name"),
  body("phone")
    .optional({ nullable: true })
    .isString()
    .trim()
    .isLength({ max: 30 })
    .withMessage("phone must be 30 characters or less"),
  checkResult,
];

// Products and services (release 3). A refusal carries a code and the field,
// as the inventory routes' own refusals do, so the app can point at it. The
// routes check the finer rules (three decimals for a quantity, kobo for a
// price, a service's units) with the same codes.
const INVENTORY_CODES = {
  name: "BAD_NAME",
  itemType: "BAD_ITEM_TYPE",
  unit: "BAD_UNIT",
  quantity: "BAD_QUANTITY",
  price: "BAD_PRICE",
  unitPrice: "BAD_PRICE",
  costPrice: "BAD_COST",
  lowStockAlert: "BAD_LOW_STOCK",
  lowStockThreshold: "BAD_LOW_STOCK",
  incomeAccountId: "ACCOUNT_NOT_FOUND",
  description: "BAD_DESCRIPTION",
  category: "BAD_ITEM",
  sku: "BAD_ITEM",
  barcode: "BAD_ITEM",
};

function checkInventoryResult(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const first = errors.array()[0];
    const field = first.path;
    return res.status(400).json({ error: first.msg, code: INVENTORY_CODES[field] || "BAD_ITEM", field });
  }
  next();
}

const optionalNumber = (field, check, message) =>
  body(field).optional({ nullable: true }).custom((v) => v === "" || check(v)).withMessage(message);
const isNumberLike = (v) => (typeof v === "number" || (typeof v === "string" && v.trim() !== "")) && Number.isFinite(Number(v));
const inRange = (min, max) => (v) => isNumberLike(v) && Number(v) >= min && Number(v) <= max;
const shortText = (field, max) =>
  body(field)
    .optional({ nullable: true })
    .isString()
    .withMessage(`${field} must be text`)
    .isLength({ max })
    .withMessage(`${field} must be ${max} characters or less`);

const inventoryFields = [
  body("itemType")
    .optional({ nullable: true })
    .isIn(["goods", "service"])
    .withMessage("An item is goods or a service"),
  shortText("unit", 30),
  optionalNumber("quantity", inRange(0, 1e9), "quantity must be a number, 0 or more"),
  optionalNumber("price", inRange(0, 1e13), "price must be a number, 0 or more"),
  optionalNumber("unitPrice", inRange(0, 1e13), "price must be a number, 0 or more"),
  optionalNumber("costPrice", inRange(0, 1e13), "cost price must be a number, 0 or more"),
  optionalNumber("lowStockAlert", (v) => inRange(0, 1e9)(v) && Number.isInteger(Number(v)), "low-stock level must be a whole number, 0 or more"),
  optionalNumber("lowStockThreshold", (v) => inRange(0, 1e9)(v) && Number.isInteger(Number(v)), "low-stock level must be a whole number, 0 or more"),
  body("incomeAccountId")
    .optional({ nullable: true })
    .isString()
    .withMessage("incomeAccountId must be an account id"),
  shortText("category", 100),
  shortText("sku", 100),
  shortText("barcode", 100),
  notesField("description"),
];

// POST /inventory: a name is required.
const validateInventoryItem = [nameField("name"), ...inventoryFields, checkInventoryResult];

// PATCH /inventory/:id: every field is optional, a name sent is not empty.
const validateInventoryPatch = [
  body("name")
    .optional()
    .isString()
    .withMessage("name must be a string")
    .trim()
    .notEmpty()
    .withMessage("name is required")
    .isLength({ max: 120 })
    .withMessage("name must be 120 characters or less"),
  ...inventoryFields,
  checkInventoryResult,
];

const validateIdParam = [uuidParam("id"), checkResult];

module.exports = {
  checkResult,
  validateSale,
  validateExpense,
  validateCustomer,
  validateInventoryItem,
  validateInventoryPatch,
  validateIdParam,
};
