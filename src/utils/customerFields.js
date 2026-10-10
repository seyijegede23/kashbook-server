// The customer details from the Add Contact form (2026-10-10): what each field
// may hold. Shared by POST and PATCH /customers, and by the copy of a
// customer's addresses and TIN that every invoice keeps (customerSnapshot).
//
// `name` is the display name and `phone` the mobile number, as before the form:
// every other part of the app (lists, reminders, WhatsApp, Insights, invoices)
// keeps reading those two.
const crypto = require("crypto");
const { Prisma } = require("@prisma/client");
const { normalizeEmail } = require("./email");
const { CUSTOMER_TERMS } = require("./paymentTerms");

const CUSTOMER_TYPES = ["business", "individual"];
const ADDRESS_LIMITS = {
  attention: 100, street1: 200, street2: 200, city: 100, state: 100, postalCode: 20, country: 100, phone: 30,
};
const PERSON_LIMITS = { salutation: 20, firstName: 60, lastName: 60, email: 254, phone: 30, designation: 100 };
const MAX_CONTACT_PERSONS = 10;
const JSON_FIELDS = ["billingAddress", "shippingAddress", "contactPersons"];

function fieldError(code, field, message, extra = {}) {
  return Object.assign(new Error(message), { status: 400, code, field, extra });
}

// Trimmed and cut to length; "" becomes null.
function text(v, max) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}

// A phone number: an optional leading +, then 6 to 15 digits. Spaces, dots,
// dashes and brackets are dropped, so "0803 123 4567" and "08031234567" are
// one number (the duplicate check is on this string).
function phone(v, field) {
  const s = text(v, 40);
  if (!s) return null;
  const compact = s.replace(/[\s().-]/g, "");
  if (!/^\+?\d{6,15}$/.test(compact)) throw fieldError("BAD_PHONE", field, "Enter a valid phone number.");
  return compact;
}

function email(v, field) {
  const s = text(v, 254);
  if (!s) return null;
  const e = normalizeEmail(s);
  if (!e) throw fieldError("BAD_EMAIL", field, "Enter a valid email address.");
  return e;
}

function website(v) {
  const s = text(v, 200);
  if (!s) return null;
  if (!/^(https?:\/\/)?([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}(:\d{1,5})?([/?#]\S*)?$/i.test(s)) {
    throw fieldError("BAD_WEBSITE", "website", "Enter a valid website, like example.com.");
  }
  return s;
}

// { attention, street1, ... } with only the known keys, each cut to length;
// null when nothing is filled in.
function address(v, field) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v !== "object" || Array.isArray(v)) throw fieldError("BAD_ADDRESS", field, "Invalid address.");
  const out = {};
  for (const [key, max] of Object.entries(ADDRESS_LIMITS)) {
    const val = key === "phone" ? phone(v[key], field) : text(v[key], max);
    if (val) out[key] = val;
  }
  // A country alone is the form's default, not an address: it would print as
  // a lone "Nigeria" under Bill To.
  return Object.keys(out).some((k) => k !== "country") ? out : null;
}

function contactPersons(v) {
  if (v === null || v === undefined || v === "") return null;
  if (!Array.isArray(v)) throw fieldError("BAD_CONTACT_PERSON", "contactPersons", "Invalid contact persons.");
  const out = [];
  for (const p of v) {
    if (!p || typeof p !== "object") throw fieldError("BAD_CONTACT_PERSON", "contactPersons", "Invalid contact person.");
    const person = {};
    for (const [key, max] of Object.entries(PERSON_LIMITS)) {
      const val =
        key === "email" ? email(p.email, "contactPersons")
          : key === "phone" ? phone(p.phone, "contactPersons")
            : text(p[key], max);
      if (val) person[key] = val;
    }
    if (!person.firstName && !person.lastName) {
      throw fieldError("BAD_CONTACT_PERSON", "contactPersons", "Enter the contact person's first or last name.");
    }
    person.id = text(p.id, 40) || crypto.randomUUID();
    out.push(person);
  }
  if (out.length > MAX_CONTACT_PERSONS) {
    throw fieldError("TOO_MANY_CONTACTS", "contactPersons", `Up to ${MAX_CONTACT_PERSONS} contact persons.`, {
      max: MAX_CONTACT_PERSONS,
    });
  }
  return out.length ? out : null;
}

// The detail fields present in `body`, validated, ready for prisma.customer
// create/update. Keys absent from the body are absent from the result, so a
// PATCH changes only what it sends. A Json field set to nothing becomes
// Prisma.DbNull (a plain null is refused for Json columns).
// Throws { status: 400, code, field } for a value that cannot be stored.
function readCustomerFields(body) {
  const b = body || {};
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
  if (has("customerType")) out.customerType = CUSTOMER_TYPES.includes(b.customerType) ? b.customerType : null;
  if (has("salutation")) out.salutation = text(b.salutation, 20);
  if (has("firstName")) out.firstName = text(b.firstName, 60);
  if (has("lastName")) out.lastName = text(b.lastName, 60);
  if (has("companyName")) out.companyName = text(b.companyName, 120);
  if (has("email")) out.email = email(b.email, "email");
  if (has("workPhone")) out.workPhone = phone(b.workPhone, "workPhone");
  if (has("website")) out.website = website(b.website);
  if (has("taxId")) out.taxId = text(b.taxId, 40);
  if (has("paymentTerms")) out.paymentTerms = CUSTOMER_TERMS.includes(b.paymentTerms) ? b.paymentTerms : null;
  if (has("billingAddress")) out.billingAddress = address(b.billingAddress, "billingAddress");
  if (has("shippingAddress")) out.shippingAddress = address(b.shippingAddress, "shippingAddress");
  if (has("contactPersons")) out.contactPersons = contactPersons(b.contactPersons);
  if (has("notes")) out.notes = text(b.notes, 1000);
  for (const k of JSON_FIELDS) if (k in out && out[k] === null) out[k] = Prisma.DbNull;
  return out;
}

// What an invoice keeps of its customer when it is saved: the addresses and
// the TIN as they are now. Cleared (DbNull) when the customer has none, so an
// edited invoice never keeps a previous customer's address.
function customerSnapshot(customer) {
  return {
    billingAddress: (customer && customer.billingAddress) || Prisma.DbNull,
    shippingAddress: (customer && customer.shippingAddress) || Prisma.DbNull,
    customerTaxId: (customer && customer.taxId) || null,
  };
}

async function snapshotFor(db, customerId) {
  if (!customerId) return customerSnapshot(null);
  const c = await db.customer.findUnique({
    where: { id: customerId },
    select: { billingAddress: true, shippingAddress: true, taxId: true },
  });
  return customerSnapshot(c);
}

module.exports = {
  CUSTOMER_TYPES,
  MAX_CONTACT_PERSONS,
  readCustomerFields,
  customerSnapshot,
  snapshotFor,
  normalizePhone: (v) => phone(v, "phone"),
};
