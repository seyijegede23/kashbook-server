// Assemble and validate the Fincra FCY (USD/EUR/GBP) virtual-account payload.
//
// WHY THIS FILE EXISTS
//   The first cut of the FCY route sent { firstName, lastName, email } and would
//   have been rejected on validation every time. Fincra's individual FCY request
//   needs ~25 fields plus TWO fetched documents. Most of them we already hold
//   from Anchor onboarding, so this module's job is: prefill everything we know,
//   demand only the genuine remainder, and fail with a precise message BEFORE we
//   consume a provider request slot.
//
// DOCUMENT URLS
//   Fincra FETCHES `utilityBill` and `meansOfId`, so they must be reachable by
//   their servers, and they validate what they get back. Our KYC uploads are
//   deliberately private on Cloudinary, and Cloudinary's own download links
//   serve a PDF as application/octet-stream with no extension, which Fincra
//   declined on 2026-09-12 ("Unable to retrieve one or more documents from
//   url"). So the links point at OUR server (routes/fcyDocs.js), signed and
//   expiring, ending in .pdf/.jpg with the real Content-Type. See
//   utils/fcyDocLink.js and signedDocUrl() below.
//
// Reference: docs/FINCRA_INTEGRATION_REFERENCE.md §4.

// The configured instance, not the bare SDK: requiring "cloudinary" directly
// yields an unconfigured client unless some other module happened to be loaded
// first, and signing then throws "Must supply api_key" at request time.
const { signDocLink } = require("./fcyDocLink");

// EUR only — Fincra granted EUR virtual accounts and not USD or GBP.
// Kept as a list, and the taxCountry === "US" rule below is left intact, so
// re-adding a currency is a one-line change if Fincra widens the grant.
const SUPPORTED = ["EUR"];

// Fincra's documented enums. Anything outside these is rejected by them, so we
// reject first with a message the user can act on.
// Both lists are Fincra's, verbatim from the "Collect Customer Details" table
// on docs.fincra.com/docs/request-fcy-virtual-account (checked 2026-09-11).
// Their validator is strict and case-sensitive, so a value outside these is a
// decline AFTER the merchant has filled the whole form.
//
// "savings" used to be in SOURCE_OF_INCOME. It is not a value Fincra accepts,
// so it was removed on 2026-09-11 before any merchant hit it; the app's picker
// no longer offers it.
const EMPLOYMENT_STATUS = [
  "employed", "self_employed", "unemployed", "student", "retired", "homemaker", "freelancer", "other",
];
const SOURCE_OF_INCOME = [
  "salary", "business_income", "investment", "gift", "inheritance", "real_estate",
  "loan", "pension", "grant", "trust", "crypto", "other",
];
// Fincra's EUR document enum, verified against docs.fincra.com/docs/request-fcy-virtual-account
// on 2026-09-09. Corrected on that date after the restore: this list previously
// read ["passport", "nationalId", "driversLicense", "votersCard"], which had two
// faults that would each have produced a decline AFTER the merchant completed the
// whole form and uploaded documents:
//   • "driversLicense" — Fincra spells it "driverLicense", no "s".
//   • "votersCard"     — not an accepted value at all. Nigerian merchants would
//                        reasonably pick it, since a voter's card is a normal ID
//                        here, and every one of those requests would have failed.
// "idCard" (identity card / residence permit) was missing and is accepted, so it
// is added rather than silently narrowing what merchants can use.
//
// EUR accepts all four. USD would be passport-only, which is why the check below
// is written against the currency rather than hardcoded.
const DOCUMENT_TYPES = ["passport", "nationalId", "driverLicense", "idCard"];

// Passport is one page and Fincra wants a SINGLE url string. Every other type is
// two-sided and wants an ARRAY of exactly [front, back]. Sending the wrong shape
// is a validation decline, so the shape is derived here, not at the call site.
const SINGLE_PAGE_DOCS = ["passport"];

// Fincra requires more than one month of validity remaining on the ID.
const MIN_ID_VALIDITY_DAYS = 31;

class FcyKycError extends Error {
  constructor(message, code, field) {
    super(message);
    this.code = code;
    this.field = field;
    this.httpStatus = 400;
  }
}

const req = (v) => v !== undefined && v !== null && String(v).trim() !== "";

/**
 * Mint a signed, expiring URL for a PRIVATE Cloudinary asset.
 *
 * TTL is deliberately long: Fincra does not fetch once and finish. A reviewer
 * can re-open the document during a manual review that the docs put at "1 to 24
 * hours" and, for corporate, longer. A short TTL yields a decline for a document
 * we did upload correctly, which is worse than the exposure of a URL that is
 * already unguessable (random public_id) and time-boxed.
 */
function signedDocUrl(publicId, { resourceType = "image", mime, ttlDays = 14 } = {}) {
  if (!publicId) return null;
  // Not a Cloudinary URL any more: a link to our own fcy-docs route, which
  // fetches the private asset server-side and serves it as a normal file.
  return signDocLink({ publicId, resourceType, mime, ttlDays });
}

// ISO-2 country for tax/nationality. Fincra wants the code, not the name.
const iso2 = (c) => String(c || "").trim().toUpperCase().slice(0, 2);

// A stored DateTime → the YYYY-MM-DD it means in Lagos. Same rule as
// toLagosDateString in utils/anchor.js (kept local so this module does not
// load the Anchor client). A bare "YYYY-MM-DD" string passes through.
function lagosCalendarDate(d) {
  if (!d) return null;
  if (typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return null;
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos" }).format(dt);
}

// "12 Awolowo Road" → { number: "12", street: "Awolowo Road" }.
// Accepts the local habits "No. 12", "No 12", "#12" and a letter suffix ("12B").
// A street with no leading number comes back with number: null, untouched.
function splitHouseNumber(street) {
  const s = String(street || "").trim();
  const m = s.match(/^(?:no\.?|#)?\s*(\d+[a-z]?)\s*[,\-]?\s+(.+)$/i);
  return m ? { number: m[1].toUpperCase(), street: m[2].trim() } : { number: null, street: s };
}

function assertDocument(doc = {}) {
  if (!DOCUMENT_TYPES.includes(doc.type)) {
    throw new FcyKycError(
      `Choose a valid ID type (${DOCUMENT_TYPES.join(", ")}).`, "FCY_DOC_TYPE", "document.type",
    );
  }
  if (!req(doc.number)) {
    throw new FcyKycError("Enter the number on your ID document.", "FCY_DOC_NUMBER", "document.number");
  }
  if (!req(doc.issuedDate)) {
    throw new FcyKycError("Enter the date your ID was issued.", "FCY_DOC_ISSUED", "document.issuedDate");
  }
  // expirationDate is optional ONLY for nationalId.
  if (doc.type !== "nationalId" && !req(doc.expirationDate)) {
    throw new FcyKycError("Enter your ID's expiry date.", "FCY_DOC_EXPIRY", "document.expirationDate");
  }
  if (req(doc.expirationDate)) {
    const exp = new Date(doc.expirationDate);
    if (Number.isNaN(exp.getTime())) {
      throw new FcyKycError("That expiry date isn't valid.", "FCY_DOC_EXPIRY", "document.expirationDate");
    }
    const daysLeft = (exp - Date.now()) / 86400000;
    if (daysLeft < MIN_ID_VALIDITY_DAYS) {
      throw new FcyKycError(
        "Your ID must have more than a month left before it expires. Please renew it or use another ID.",
        "FCY_DOC_EXPIRING", "document.expirationDate",
      );
    }
  }
}

/**
 * Build the full Fincra request body.
 *
 * @param {object} a
 * @param {object} a.user      User row (name, email, phone, dateOfBirth)
 * @param {object} a.business  Business row (address, country, businessKyb, name)
 * @param {string} a.currency  USD | EUR | GBP
 * @param {object} a.extra     the fields only the user can supply (see below)
 * @param {object} a.documents { utilityBillId, meansOfIdIds: [], bankStatementId }
 *                             Cloudinary PRIVATE public_ids, signed here.
 * @returns {object} the exact body for POST /profile/virtual-accounts/requests
 * @throws  {FcyKycError} with a user-safe, field-tagged message
 */
function buildFcyRequest({ user = {}, business = {}, currency, extra = {}, documents = {} }) {
  if (!SUPPORTED.includes(currency)) {
    throw new FcyKycError(`Choose one of ${SUPPORTED.join(", ")}.`, "FCY_CURRENCY", "currency");
  }

  // ── things we already hold, so never ask for them again ──────────────────
  const firstName = user.firstName;
  const lastName = user.lastName;
  const email = user.email;
  const phone = user.phone;
  // The CALENDAR date in Lagos, never a slice of the ISO string. The app's date
  // picker yields local midnight, which is stored as the previous day at 23:00Z
  // (2 May 2004 → "2004-05-01T23:00:00.000Z"). Slicing that sent "2004-05-01",
  // and Fincra declined the first live request on 2026-09-12: "Date of Birth on
  // the document does not match with the provided one." Anchor's KYC passed on
  // the same stored value because utils/anchor.js converts it the same way
  // (toLagosDateString); the two providers must see the same date.
  const birthDate = lagosCalendarDate(user.dateOfBirth);
  const countryOfResidence = iso2(business.country || user.country || "NG");

  for (const [label, v, field] of [
    ["your first name", firstName, "firstName"],
    ["your last name", lastName, "lastName"],
    ["an email address", email, "email"],
    ["a phone number", phone, "phone"],
    ["your date of birth", birthDate, "birthDate"],
  ]) {
    if (!req(v)) {
      throw new FcyKycError(`Add ${label} in your profile first.`, "FCY_PROFILE_INCOMPLETE", field);
    }
  }

  // Address: what the merchant typed on the FCY form wins, then what the
  // business row holds. The form has an address section because the NUBAN
  // onboarding never collected a postcode (VirtualAccountScreen sends street,
  // city and state only), so addressPostalCode was null for every app-onboarded
  // business and this check rejected every single request, 2026-09-10, with a
  // message the app then failed to display. Fincra requires all four.
  const addr = extra.address && typeof extra.address === "object" ? extra.address : {};
  const pick = (v, fallback) => (req(v) ? String(v).trim() : fallback);
  const street = pick(addr.street, business.addressLine1);
  const city = pick(addr.city, business.addressCity);
  const state = pick(addr.state, business.addressState);
  const zip = pick(addr.postalCode, business.addressPostalCode);
  if (!req(street) || !req(city) || !req(state) || !req(zip)) {
    throw new FcyKycError(
      "Enter your full business address, including a postal code.",
      "FCY_ADDRESS_INCOMPLETE", "address",
    );
  }

  // Fincra wants the house number SEPARATE from the street, and compliance
  // checks the utility bill against it, so it must be real. Order: the form's
  // house-number field, else a leading number on the street line ("12 Awolowo
  // Road" → 12 + "Awolowo Road"), else a purely numeric addressLine2. Nothing
  // is invented: this used to fall back to a literal "1", which passes
  // validation and then fails the document review, days later, with no way to
  // see why. A merchant with no number anywhere is asked for one instead.
  const parsed = splitHouseNumber(street);
  const line2 = String(business.addressLine2 || "").trim();
  const houseNumber = pick(addr.number, parsed.number || (/^\d+[a-z]?$/i.test(line2) ? line2 : null));
  if (!req(houseNumber)) {
    throw new FcyKycError(
      "Enter your house number, or start the street with it (for example 12 Awolowo Road).",
      "FCY_HOUSE_NUMBER", "address",
    );
  }
  // Once the number has its own field, it must not also lead the street line,
  // or the address reads "12, 12 Awolowo Road" on Fincra's side.
  const streetName = parsed.number ? parsed.street : street;

  // ── things only the user can tell us ─────────────────────────────────────
  if (!EMPLOYMENT_STATUS.includes(extra.employmentStatus)) {
    throw new FcyKycError("Select your employment status.", "FCY_EMPLOYMENT", "employmentStatus");
  }
  if (!SOURCE_OF_INCOME.includes(extra.sourceOfIncome)) {
    throw new FcyKycError("Select where your income comes from.", "FCY_INCOME_SOURCE", "sourceOfIncome");
  }
  if (!req(extra.occupation)) {
    throw new FcyKycError("Enter your occupation.", "FCY_OCCUPATION", "occupation");
  }
  const lower = Number(extra.incomeLower);
  const upper = Number(extra.incomeUpper);
  if (!(lower >= 0) || !(upper > lower)) {
    throw new FcyKycError("Enter a valid income range.", "FCY_INCOME_BAND", "incomeBand");
  }
  const monthlyCount = Number(extra.monthlyTransactionCount);
  const monthlyVolume = Number(extra.monthlyTransactionVolume);
  if (!(monthlyCount > 0)) {
    throw new FcyKycError("Enter how many payments you expect each month.", "FCY_TXN_COUNT", "monthlyTransactionCount");
  }
  if (!(monthlyVolume > 0)) {
    throw new FcyKycError("Enter how much you expect to receive each month.", "FCY_TXN_VOLUME", "monthlyTransactionVolume");
  }
  assertDocument(extra.document);

  // ── documents: private assets, signed so Fincra can fetch them ───────────
  const meansOfIdIds = [].concat(documents.meansOfIdIds || []).filter(Boolean);
  if (!documents.utilityBillId) {
    throw new FcyKycError("Upload a utility bill from the last 3 months.", "FCY_UTILITY_BILL", "utilityBill");
  }
  if (!meansOfIdIds.length) {
    throw new FcyKycError("Upload your ID document.", "FCY_MEANS_OF_ID", "meansOfId");
  }
  // Passport is a single page; other IDs need front AND back.
  const singlePage = SINGLE_PAGE_DOCS.includes(extra.document.type);
  if (!singlePage && meansOfIdIds.length < 2) {
    throw new FcyKycError(
      "Upload both the front and back of your ID.", "FCY_MEANS_OF_ID_BACK", "meansOfId",
    );
  }

  // Each ID page carries its own type and mime: a PDF scan of a licence is a
  // `raw` asset and needs a .pdf link, a photographed one is an image. The old
  // form assumed "image" for every page, which 404s for a PDF.
  const signedIds = meansOfIdIds.map((id, i) => signedDocUrl(id, {
    resourceType: (documents.meansOfIdTypes || [])[i] || "image",
    mime: (documents.meansOfIdMimes || [])[i],
  }));

  const body = {
    currency,
    // ALWAYS "individual". Fincra's FCY virtual accounts are documented as
    // individual-only ("not suitable for business use"), and the approval we hold
    // is to issue them to end users. This previously read
    //   business.businessKyb ? "corporate" : "individual"
    // which sent "corporate" for every limited-company merchant — precisely the
    // merchants most likely to want a euro account — and each of those requests
    // would have been declined. The account belongs to the PERSON (the KYC block
    // below is entirely personal identity), not to the registered company.
    accountType: "individual",
    utilityBill: signedDocUrl(documents.utilityBillId, { resourceType: documents.utilityBillType, mime: documents.utilityBillMime }),
    // ALWAYS an array: one url for a passport, [front, back] for everything
    // else. Fincra's own request example sends a one-element array for a
    // passport, so that is the shape known to pass their validator; a bare
    // string is documented as accepted but has never been seen to be.
    meansOfId: signedIds.slice(0, singlePage ? 1 : 2),
    KYCInformation: {
      firstName,
      lastName,
      email,
      phone,
      birthDate,
      nationality: iso2(user.country || business.country || "NG"),
      occupation: String(extra.occupation).trim(),
      taxCountry: countryOfResidence,
      sourceOfIncome: extra.sourceOfIncome,
      accountDesignation: business.businessKyb ? "Business use" : "Personal use",
      employmentStatus: extra.employmentStatus,
      // INSIDE KYCInformation, not at the top level. Fincra's field table puts
      // these two at the top level; their JSON example nests them here; and on
      // 2026-09-10 the LIVE validator declined the top-level form with
      // "monthlyTransactionCount is not allowed". The example is the truth.
      monthlyTransactionCount: String(monthlyCount),
      monthlyTransactionVolume: String(monthlyVolume),
      address: {
        countryOfResidence,
        state,
        city,
        street: streetName,
        number: String(houseNumber),
        zip: String(zip),
      },
      incomeBand: { lower: String(lower), upper: String(upper) },
      document: {
        type: extra.document.type,
        number: String(extra.document.number).trim(),
        issuedCountryCode: iso2(extra.document.issuedCountryCode || countryOfResidence),
        issuedBy: extra.document.issuedBy || "government",
        issuedDate: extra.document.issuedDate,
        ...(req(extra.document.expirationDate) ? { expirationDate: extra.document.expirationDate } : {}),
      },
    },
  };

  // taxNumber is required ONLY when taxCountry is US.
  if (body.KYCInformation.taxCountry === "US") {
    if (!req(extra.taxNumber)) {
      throw new FcyKycError("A US tax number (TIN) is required.", "FCY_TAX_NUMBER", "taxNumber");
    }
    body.KYCInformation.taxNumber = String(extra.taxNumber).trim();
  }
  if (documents.bankStatementId) {
    body.bankStatement = signedDocUrl(documents.bankStatementId, { resourceType: documents.bankStatementType, mime: documents.bankStatementMime });
  }
  return body;
}

// What the client must still collect, so the form and the validator cannot drift.
const REQUIRED_FROM_USER = {
  occupation: "text",
  employmentStatus: EMPLOYMENT_STATUS,
  sourceOfIncome: SOURCE_OF_INCOME,
  incomeLower: "number",
  incomeUpper: "number",
  monthlyTransactionCount: "number",
  monthlyTransactionVolume: "number",
  document: { type: DOCUMENT_TYPES, number: "text", issuedDate: "date", expirationDate: "date" },
  utilityBill: "file",
  meansOfId: "file[]",
};

module.exports = {
  buildFcyRequest,
  signedDocUrl,
  FcyKycError,
  SUPPORTED,
  EMPLOYMENT_STATUS,
  SOURCE_OF_INCOME,
  DOCUMENT_TYPES,
  REQUIRED_FROM_USER,
};
