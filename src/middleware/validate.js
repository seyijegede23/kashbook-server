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

const validateInventoryItem = [
  nameField("name"),
  body("quantity")
    .optional()
    .isFloat({ min: 0 })
    .withMessage("quantity must be a non-negative number"),
  body("price")
    .optional()
    .isFloat({ min: 0 })
    .withMessage("price must be a non-negative number"),
  body("cost")
    .optional({ nullable: true })
    .isFloat({ min: 0 })
    .withMessage("cost must be a non-negative number"),
  notesField("description"),
  checkResult,
];

const validateIdParam = [uuidParam("id"), checkResult];

module.exports = {
  checkResult,
  validateSale,
  validateExpense,
  validateCustomer,
  validateInventoryItem,
  validateIdParam,
};
