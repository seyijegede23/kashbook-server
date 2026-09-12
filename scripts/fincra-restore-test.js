// Fincra EUR restore — structural guards. No network, no DB.
//   node scripts/fincra-restore-test.js
//
// Fincra was deleted on 2026-08-27 and restored on 2026-09-09 as EUR-RECEIVE-ONLY.
// Two classes of bug are being guarded here.
//
// 1. THE SILENT-IMPORT BUG. The deletion left transfers.js importing
//    computeFincraTransferFee after it was removed from fees.js. Destructuring a
//    missing export yields `undefined` rather than throwing, so every module
//    still LOADED and it would only have blown up when called, on a money path.
//    A load test alone does not catch that, so section 2 asserts the actual
//    shape of what the restored modules import.
//
// 2. RECEIVE-ONLY IS STRUCTURAL, NOT A FLAG. Fincra may issue EUR accounts and
//    may not send money. Section 3 asserts there is no route from a business to
//    the Fincra provider and no caller able to initiate a Fincra payout.
const assert = require("assert");
const fs = require("fs");
const path = require("path");

// Modules that build a JWT verifier at require() time throw without this. We are
// testing module WIRING, not auth, so a dummy of the right length is enough and
// keeps the test runnable without a .env.
process.env.JWT_SECRET = process.env.JWT_SECRET || "x".repeat(48);
// fcyKyc signs private Cloudinary URLs; signing needs a key or it throws. Section
// 6 only inspects the SHAPE of the payload, so dummy credentials are correct here.
process.env.CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || "testcloud";
process.env.CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY || "123456789012345";
process.env.CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET || "test_secret_value";

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); failed++; }
}
function section(t) { console.log(`\n── ${t} ${"─".repeat(Math.max(0, 56 - t.length))}`); }

const SRC = path.join(__dirname, "..", "src");
const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");

// ══ 1. EVERYTHING STILL LOADS ══════════════════════════════════════════════
section("1. every module under src/ loads");

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : e.name.endsWith(".js") ? [p] : [];
  });
}

const modules = walk(SRC);
test(`all ${modules.length} modules require() without throwing`, () => {
  const broken = [];
  for (const m of modules) {
    try { require(m); } catch (e) { broken.push(`${path.relative(SRC, m)}: ${e.message}`); }
  }
  assert.strictEqual(broken.length, 0, "modules failed to load:\n        " + broken.join("\n        "));
});

// ══ 2. THE IMPORTS THE RESTORE DEPENDS ON ARE REAL ═════════════════════════
section("2. restored modules' imports actually resolve (the silent-import bug)");

// Each entry: the export a restored file destructures, and where it comes from.
// If any of these is undefined the app still boots and dies later, on a money
// path — which is exactly what happened in August.
const REQUIRED_EXPORTS = [
  ["../src/providers",            "getForeignAccountProvider", "routes/foreignAccounts.js"],
  ["../src/providers",            "getProvider",               "core"],
  ["../src/utils/fcyKyc",         "buildFcyRequest",           "routes/foreignAccounts.js"],
  ["../src/utils/fcyKyc",         "FcyKycError",               "routes/foreignAccounts.js"],
  ["../src/config/fcyRestrictedCountries", "isFcyRestricted",  "routes/foreignAccounts.js"],
  ["../src/utils/fincraCredit",   "recordFincraInboundCredit", "routes/fincra.js + fincraReconcile.js"],
  ["../src/utils/fincraReconcile", "startFincraReconcileLoop", "server.js"],
  ["../src/utils/fincraReconcile", "reconcileFincraCollections", "the inbound durability net"],
  ["../src/utils/uploadGuard",    "validateDataUri",           "routes/foreignAccounts.js"],
  ["../src/utils/uploadGuard",    "DOC_TYPES",                 "routes/foreignAccounts.js"],
  ["../src/config/countries",     "supportsLocalAccount",      "routes/foreignAccounts.js"],
];

for (const [mod, name, usedBy] of REQUIRED_EXPORTS) {
  test(`${mod.replace("../src/", "")} exports ${name}  (used by ${usedBy})`, () => {
    const v = require(mod)[name];
    assert.notStrictEqual(v, undefined, `${name} is undefined — a caller would fail only when it runs`);
  });
}

test("no restored file imports a fees export that no longer exists", () => {
  const fees = require("../src/config/fees");
  for (const rel of ["routes/foreignAccounts.js", "routes/fincra.js", "utils/fincraCredit.js",
    "utils/fincraReconcile.js", "providers/fincra.js"]) {
    const src = read(rel);
    const m = src.match(/require\(["']\.\.\/config\/fees["']\)/);
    if (!m) continue;
    // Pull the destructured names off the same line and check each one exists.
    const line = src.split("\n").find((l) => l.includes('config/fees'));
    const names = (line.match(/\{([^}]*)\}/) || [, ""])[1]
      .split(",").map((s) => s.trim().split(":")[0].trim()).filter(Boolean);
    for (const n of names) {
      assert.notStrictEqual(fees[n], undefined, `${rel} imports fees.${n} which does not exist`);
    }
  }
});

// ══ 3. RECEIVE-ONLY IS STRUCTURAL ══════════════════════════════════════════
section("3. Fincra can receive EUR and cannot send anything");

test("no country config routes its payments to Fincra", () => {
  const { getCountryConfig } = require("../src/config/countries");
  const countries = require("../src/config/countries").COUNTRIES
    || require("../src/config/countries");
  const named = [];
  for (const code of ["NG", "GH", "KE", "TZ", "UG", "ZA", "EG"]) {
    const cfg = getCountryConfig(code);
    if (cfg && cfg.paymentProvider === "fincra") named.push(code);
  }
  assert.deepStrictEqual(named, [], `these countries would route money through Fincra: ${named}`);
});

test("getProvider() never returns the Fincra provider", () => {
  const { getProvider } = require("../src/providers");
  const cases = [
    { country: "NG" }, { country: "GH" }, { country: "KE" }, { country: "TZ" },
    { country: "NG", anchorAccountId: "acc_1" },
    // The pooled sticky branch: a business with a providerAccountId and no Anchor
    // account used to resolve to Fincra. That branch was deliberately not restored.
    { country: "NG", providerAccountId: "va_1" },
    { country: "GH", providerAccountId: "va_2" },
    "NG", "GH", "XX",
  ];
  for (const c of cases) {
    const p = getProvider(c);
    assert.notStrictEqual(p && p.key, "fincra",
      `getProvider(${JSON.stringify(c)}) resolved to Fincra — the send path is reachable`);
  }
});

test("getForeignAccountProvider() DOES return Fincra (receive must work)", () => {
  const { getForeignAccountProvider } = require("../src/providers");
  const p = getForeignAccountProvider();
  assert.ok(p, "no FCY provider — merchants could never be issued a EUR account");
  assert.strictEqual(p.key, "fincra");
});

test("executeTransfer has no Fincra payout path", () => {
  const src = fs.readFileSync(path.join(SRC, "utils", "executeTransfer.js"), "utf8");
  for (const banned of ["executeFincraPayout", "executeFincraBookTransfer", "computeFincraTransferFee"]) {
    assert.ok(!src.includes(banned), `executeTransfer.js still references ${banned}`);
  }
});

test("no LIVE code references a Fincra payout function", () => {
  // Comments are stripped first. Several files legitimately DISCUSS the removed
  // payout path — that documentation is the point, and matching on it would make
  // this test fail for prose. Only executable references count.
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const BANNED = /\b(executeFincraPayout|executeFincraBookTransfer|recordFincraPayoutOutcome|backfillFincraPayout|reconcileFincraPayouts|computeFincraTransferFee)\b/;
  const offenders = [];
  for (const m of modules) {
    const code = stripComments(fs.readFileSync(m, "utf8"));
    const hit = code.match(BANNED);
    if (hit) offenders.push(`${path.relative(SRC, m)} (${hit[1]})`);
  }
  assert.deepStrictEqual(offenders, [], `payout code is still live in: ${offenders.join(", ")}`);
});

test("the payout module itself is gone, not merely unused", () => {
  assert.ok(!fs.existsSync(path.join(SRC, "utils", "fincraPayout.js")),
    "fincraPayout.js still exists — it imports computeFincraTransferFee, which does not");
});

// ══ 4. EUR ONLY ════════════════════════════════════════════════════════════
section("4. EUR is the only currency on offer");

test("fcyKyc accepts EUR", () => {
  const { buildFcyRequest, FcyKycError } = require("../src/utils/fcyKyc");
  // Deliberately incomplete input: we only care that the CURRENCY gate passes,
  // so the error must be about a missing field, never about the currency.
  try {
    buildFcyRequest({ currency: "EUR", user: {}, business: {}, extra: {}, documents: {} });
  } catch (e) {
    assert.ok(e instanceof FcyKycError, `unexpected error type: ${e.message}`);
    assert.notStrictEqual(e.code, "FCY_CURRENCY", "EUR was rejected as a currency");
  }
});

for (const cur of ["USD", "GBP", "CAD", "KES", "NGN", "eur", ""]) {
  test(`fcyKyc rejects ${cur || "(empty)"}`, () => {
    const { buildFcyRequest } = require("../src/utils/fcyKyc");
    assert.throws(
      () => buildFcyRequest({ currency: cur, user: {}, business: {}, extra: {}, documents: {} }),
      (e) => e.code === "FCY_CURRENCY",
      `${cur} was not rejected at the currency gate`,
    );
  });
}

// ══ 5. THE LEDGER ══════════════════════════════════════════════════════════
section("5. EUR counts as real money without touching the naira balance");

test("fincra is a recognised provider source again", () => {
  const { PROVIDER_SOURCES } = require("../src/config/moneySources");
  assert.ok(PROVIDER_SOURCES.includes("fincra"),
    "a EUR credit would be invisible to the ledger AND editable by the client");
  assert.ok(PROVIDER_SOURCES.includes("anchor"), "anchor must remain");
});

test("a EUR bank row is protected as an append-only ledger row", () => {
  const { isBankLedgerRow } = require("../src/config/moneySources");
  assert.strictEqual(isBankLedgerRow({ source: "fincra", currency: "EUR" }), true);
});

test("the ledger query is scoped by currency, not just by source", () => {
  // The guard that stops €1 being counted as ₦1. Asserted on the source text
  // because calling it needs a DB; if the currency filter is ever dropped this
  // test fails loudly rather than the balance quietly inflating.
  const src = fs.readFileSync(path.join(SRC, "utils", "ledgerBalance.js"), "utf8");
  const base = src.match(/const base = \{([^}]*)\}/);
  assert.ok(base, "could not find the ledger base query");
  assert.ok(/\bcurrency\b/.test(base[1]), "ledger query lost its currency filter — EUR would inflate NGN");
  assert.ok(/PROVIDER_SOURCES/.test(base[1]), "ledger query lost its source allowlist");
});

test("AML money-out windows cannot see EUR (income is not expense)", () => {
  // MONEY_OUT_SOURCES now includes fincra, and the AML window is NOT currency
  // scoped. That is safe only while no outbound EUR row can exist. Documented
  // in moneySources.js; asserted here so the assumption is checked, not trusted.
  const { MONEY_OUT_SOURCES } = require("../src/utils/amlChecks");
  assert.ok(MONEY_OUT_SOURCES.includes("fincra"));
  const src = fs.readFileSync(path.join(SRC, "utils", "amlChecks.js"), "utf8");
  assert.ok(/type:\s*"expense"/.test(src),
    "AML window no longer filters to expense rows — EUR credits would enter naira velocity limits");
});

// ══ 6. THE PAYLOAD MATCHES FINCRA'S CONTRACT ═══════════════════════════════
section("6. the request body Fincra actually accepts");

// A complete, valid input. Each test mutates one field, so a failure names the
// exact field that would have been declined.
const OK = () => ({
  currency: "EUR",
  user: {
    firstName: "Ada", lastName: "Obi", email: "ada@example.com",
    phone: "+2348000000000", dateOfBirth: "1990-04-02", country: "NG",
  },
  business: {
    country: "NG", name: "Ada Stores", businessKyb: false,
    addressLine1: "12 Awolowo Road", addressCity: "Lagos",
    addressState: "Lagos", addressPostalCode: "101233",
  },
  extra: {
    employmentStatus: "self_employed", sourceOfIncome: "business_income",
    occupation: "Trader", incomeLower: "1000", incomeUpper: "5000",
    monthlyTransactionCount: "20", monthlyTransactionVolume: "4000",
    document: {
      type: "nationalId", number: "A1234567",
      issuedDate: "2020-01-01", expirationDate: "2032-01-01",
    },
  },
  documents: { utilityBillId: "kb/util_1", meansOfIdIds: ["kb/id_front", "kb/id_back"] },
});

const { buildFcyRequest } = require("../src/utils/fcyKyc");

test("a complete input builds a body", () => {
  const body = buildFcyRequest(OK());
  assert.strictEqual(body.currency, "EUR");
  assert.ok(body.KYCInformation, "KYCInformation missing");
});

// The NUBAN onboarding never collected a postcode, so every app-onboarded
// business had addressPostalCode = null and every FCY request was rejected
// (2026-09-10). The form now supplies the address itself.
test("the postcode can come from the form when the business row has none", () => {
  const inp = OK();
  inp.business.addressPostalCode = null;
  inp.extra.address = { postalCode: "101233" };
  assert.doesNotThrow(() => buildFcyRequest(inp), "postcode from extra.address was not accepted");
});

test("what the merchant typed wins over the business row", () => {
  const inp = OK();
  inp.extra.address = { street: "5 New Road", city: "Abuja", state: "FCT", postalCode: "900001" };
  const a = buildFcyRequest(inp).KYCInformation.address;
  // "5 New Road" is split: the 5 becomes the house number Fincra requires
  // separately, and the street carries the rest.
  assert.deepStrictEqual(
    { number: a.number, street: a.street, city: a.city, state: a.state, zip: a.zip },
    { number: "5", street: "New Road", city: "Abuja", state: "FCT", zip: "900001" },
  );
  assert.ok(!JSON.stringify(a).includes("Awolowo"), "the business row's street leaked through despite a form value");
});

test("no postcode anywhere is FCY_ADDRESS_INCOMPLETE tagged 'address'", () => {
  const inp = OK();
  inp.business.addressPostalCode = null;
  inp.extra.address = { street: "12 Awolowo Road", city: "Lagos", state: "Lagos", postalCode: "" };
  assert.throws(() => buildFcyRequest(inp), (e) => e.code === "FCY_ADDRESS_INCOMPLETE" && e.field === "address");
});

test("the address error is tagged with a field the app now renders", () => {
  // The app's FIELD_TO_KEY must know every field tag the server can emit for
  // the address, or the error lands under a key nothing displays again.
  const screen = path.join(__dirname, "..", "..", "src", "screens", "ForeignAccountKycScreen.js");
  if (!fs.existsSync(screen)) return;
  const src = fs.readFileSync(screen, "utf8");
  assert.ok(/address:\s*"address"/.test(src), "FIELD_TO_KEY has no entry for the server's 'address' field");
  assert.ok(/errors\.address/.test(src), "nothing in the screen renders errors.address");
});

test("accountType is ALWAYS individual, even for a registered company", () => {
  // Fincra's FCY accounts are individual-only. This previously sent "corporate"
  // whenever business.businessKyb was true, declining exactly the merchants most
  // likely to want a euro account.
  const kyb = OK();
  kyb.business.businessKyb = true;
  assert.strictEqual(buildFcyRequest(kyb).accountType, "individual");
  assert.strictEqual(buildFcyRequest(OK()).accountType, "individual");
});

for (const type of ["nationalId", "driverLicense", "idCard"]) {
  test(`${type} is accepted and sends [front, back]`, () => {
    const inp = OK();
    inp.extra.document.type = type;
    const body = buildFcyRequest(inp);
    assert.ok(Array.isArray(body.meansOfId), `${type} must send an array of two urls`);
    assert.strictEqual(body.meansOfId.length, 2, `${type} must send exactly front and back`);
  });
}

test("passport sends a ONE-element array (the shape in Fincra's own example)", () => {
  const inp = OK();
  inp.extra.document.type = "passport";
  inp.documents.meansOfIdIds = ["kb/passport_page"];
  const body = buildFcyRequest(inp);
  assert.ok(Array.isArray(body.meansOfId) && body.meansOfId.length === 1,
    "passport must send [url]; Fincra's example does, and a bare string is unproven");
});

test("monthlyTransactionCount/Volume live INSIDE KYCInformation, not top level", () => {
  // The live validator declined the top-level form on 2026-09-10:
  // "monthlyTransactionCount is not allowed".
  const body = buildFcyRequest(OK());
  assert.strictEqual(body.monthlyTransactionCount, undefined, "still at top level");
  assert.strictEqual(body.monthlyTransactionVolume, undefined, "still at top level");
  assert.strictEqual(body.KYCInformation.monthlyTransactionCount, "20");
  assert.strictEqual(body.KYCInformation.monthlyTransactionVolume, "4000");
});

test("the top level carries exactly the keys Fincra's example does", () => {
  const keys = Object.keys(buildFcyRequest(OK())).sort();
  assert.deepStrictEqual(keys, ["KYCInformation", "accountType", "currency", "meansOfId", "utilityBill"],
    "an unexpected top-level key is a strict-schema decline");
});

test("savings is no longer an accepted source of income", () => {
  const inp = OK();
  inp.extra.sourceOfIncome = "savings";
  assert.throws(() => buildFcyRequest(inp), (e) => e.code === "FCY_INCOME_SOURCE");
});

for (const v of ["gift", "real_estate", "loan", "pension", "grant", "trust", "crypto", "other"]) {
  test(`sourceOfIncome ${v} (documented) is accepted`, () => {
    const inp = OK();
    inp.extra.sourceOfIncome = v;
    assert.doesNotThrow(() => buildFcyRequest(inp));
  });
}

test("house number: lifted off a street that starts with one", () => {
  const inp = OK(); // street "12 Awolowo Road", no explicit number
  const a = buildFcyRequest(inp).KYCInformation.address;
  assert.strictEqual(a.number, "12");
  assert.strictEqual(a.street, "Awolowo Road", "the number must not also lead the street");
});

test("house number: the form's own field wins", () => {
  const inp = OK();
  inp.extra.address = { number: "7B", street: "Adeola Odeku Street" };
  const a = buildFcyRequest(inp).KYCInformation.address;
  assert.strictEqual(a.number, "7B");
  assert.strictEqual(a.street, "Adeola Odeku Street");
});

test("house number: 'No. 5' and '#5' are understood", () => {
  for (const s of ["No. 5 Marina", "No 5 Marina", "#5 Marina"]) {
    const inp = OK();
    inp.extra.address = { street: s };
    const a = buildFcyRequest(inp).KYCInformation.address;
    assert.strictEqual(a.number, "5", `from "${s}"`);
    assert.strictEqual(a.street, "Marina", `from "${s}"`);
  }
});

test("house number: never invented", () => {
  // This used to send a literal "1", which passes validation and fails the
  // utility-bill review days later with no visible reason.
  const inp = OK();
  inp.extra.address = { street: "Awolowo Road" };
  inp.business.addressLine2 = "Suite 4";
  assert.throws(() => buildFcyRequest(inp), (e) => e.code === "FCY_HOUSE_NUMBER");
});

for (const bad of ["driversLicense", "votersCard", "drivers_license", "nin", ""]) {
  test(`${bad || "(empty)"} is rejected before it reaches Fincra`, () => {
    const inp = OK();
    inp.extra.document.type = bad;
    assert.throws(() => buildFcyRequest(inp), (e) => e.code === "FCY_DOC_TYPE",
      `${bad} was accepted — Fincra would decline it after a completed form`);
  });
}

test("a two-sided ID with only one page uploaded is caught here", () => {
  const inp = OK();
  inp.documents.meansOfIdIds = ["kb/id_front"];
  assert.throws(() => buildFcyRequest(inp), (e) => e.code === "FCY_MEANS_OF_ID_BACK");
});

test("the mobile picker offers exactly what the server accepts", () => {
  // The two lists are in different repos and drift silently: the screen sends
  // `value` verbatim, so a mismatch is a decline the merchant cannot act on.
  const screen = path.join(__dirname, "..", "..", "src", "screens", "ForeignAccountKycScreen.js");
  if (!fs.existsSync(screen)) return; // server checked out alone
  const src = fs.readFileSync(screen, "utf8");
  const block = src.slice(src.indexOf("const DOCUMENT_TYPES = ["));
  const offered = [...block.slice(0, block.indexOf("];")).matchAll(/value:\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(offered.length, "could not read the mobile document list");
  for (const v of offered) {
    const inp = OK();
    inp.extra.document.type = v;
    inp.documents.meansOfIdIds = ["kb/a", "kb/b"];
    assert.doesNotThrow(() => buildFcyRequest(inp),
      `the app offers "${v}" but the server rejects it`);
  }
});

// ══ 7. SANDBOX CANNOT MASQUERADE AS LIVE ═══════════════════════════════════
section("7. a production deploy cannot issue sandbox accounts");

const fincraService = require("../src/services/fincra");
const withBase = (url, fn) => {
  const prev = process.env.FINCRA_BASE_URL;
  if (url === undefined) delete process.env.FINCRA_BASE_URL;
  else process.env.FINCRA_BASE_URL = url;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.FINCRA_BASE_URL;
    else process.env.FINCRA_BASE_URL = prev;
  }
};

test("the live host reads as live", () => {
  assert.strictEqual(withBase("https://api.fincra.com", () => fincraService.isLive()), true);
});

for (const [label, url] of [
  ["the sandbox host", "https://sandboxapi.fincra.com"],
  ["an unset base url (defaults to sandbox)", undefined],
  ["a lookalike host", "https://api.fincra.com.evil.example"],
  ["a subdomain of the live host", "https://sandbox.api.fincra.com"],
  ["junk", "not-a-url"],
  ["empty", ""],
]) {
  test(`${label} does NOT read as live`, () => {
    assert.strictEqual(withBase(url, () => fincraService.isLive()), false,
      `${url} was treated as live — merchants could be issued sandbox accounts`);
  });
}

test("the live check is case-insensitive on the host", () => {
  assert.strictEqual(withBase("https://API.Fincra.COM", () => fincraService.isLive()), true);
});

// ══ 8. WHICH ROWS COUNT AS A REQUEST ═══════════════════════════════════════
section("8. a row that never reached Fincra is neither listed nor blocking");

const { reachedFincra, neverSent } = require("../src/utils/foreignAccountState");

const ROWS = {
  leftover:      { status: "pending",  fincraRequestId: null,  consentUrl: null },
  sentWithRef:   { status: "pending",  fincraRequestId: "abc", consentUrl: null },
  sentWithLink:  { status: "pending",  fincraRequestId: null,  consentUrl: "https://x" },
  approved:      { status: "approved", fincraRequestId: null,  consentUrl: null },
  issued:        { status: "issued",   fincraRequestId: null,  consentUrl: null },
  declined:      { status: "declined", fincraRequestId: "abc", consentUrl: null },
};

test("a pending row with no request id and no consent link never reached Fincra", () => {
  assert.strictEqual(neverSent(ROWS.leftover), true);
  assert.strictEqual(reachedFincra(ROWS.leftover), false, "it must not block a retry");
});

for (const k of ["sentWithRef", "sentWithLink", "approved", "issued"]) {
  test(`${k} DID reach Fincra: listed, and a retry short-circuits`, () => {
    assert.strictEqual(neverSent(ROWS[k]), false);
    assert.strictEqual(reachedFincra(ROWS[k]), true);
  });
}

test("a declined row is shown (with its reason) AND retryable", () => {
  assert.strictEqual(neverSent(ROWS.declined), false, "declined must stay visible");
  assert.strictEqual(reachedFincra(ROWS.declined), false, "declined must not block a retry");
});

test("no row at all is neither", () => {
  assert.strictEqual(neverSent(null), false);
  assert.strictEqual(reachedFincra(null), false);
  assert.strictEqual(reachedFincra(undefined), false);
});

test("both call sites use the shared helper (they can never disagree)", () => {
  const src = read("routes/foreignAccounts.js");
  assert.ok(/reachedFincra\(existing\)/.test(src), "POST short-circuit does not use reachedFincra()");
  assert.ok(/rows\.filter\(\(fa\) => !neverSent\(fa\)\)/.test(src), "GET list does not filter with neverSent()");
  assert.ok(!/existing\.status !== "declined" &&/.test(src), "an inline copy of the rule survives in the route");
});

// ══ 7. THE LINKS FINCRA FETCHES ════════════════════════════════════════════
section("7. document links: ours, signed, expiring, and shaped like a real file");

const { signDocLink, verifyDocLink, publicBase } = require("../src/utils/fcyDocLink");
const createFcyDocsRouter = require("../src/routes/fcyDocs");

test("a link points at OUR server, not Cloudinary, and ends in the right extension", () => {
  const pdf = signDocLink({ publicId: "kashbook/fcy/ub_1", resourceType: "raw", mime: "application/pdf" });
  const jpg = signDocLink({ publicId: "kashbook/fcy/id_1", resourceType: "image", mime: "image/jpeg" });
  assert.ok(pdf.startsWith(publicBase() + "/fcy-docs/"), pdf);
  assert.ok(pdf.endsWith(".pdf"), pdf);
  assert.ok(jpg.endsWith(".jpg"), jpg);
  assert.ok(!/cloudinary/i.test(pdf + jpg), "a Cloudinary host leaked into a link handed to a third party");
});

test("sign → verify round-trips the exact asset", () => {
  const url = signDocLink({ publicId: "kashbook/fcy/ub_2", resourceType: "raw", mime: "application/pdf" });
  const file = url.slice(url.lastIndexOf("/") + 1);
  const token = file.slice(0, file.lastIndexOf("."));
  const v = verifyDocLink(token);
  assert.deepStrictEqual({ p: v.publicId, r: v.resourceType, m: v.mime }, { p: "kashbook/fcy/ub_2", r: "raw", m: "application/pdf" });
});

test("a tampered signature is refused", () => {
  const url = signDocLink({ publicId: "kashbook/fcy/ub_3", resourceType: "raw", mime: "application/pdf" });
  const token = url.slice(url.lastIndexOf("/") + 1).replace(/\.pdf$/, "");
  const flipped = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
  assert.strictEqual(verifyDocLink(flipped), null);
});

test("a re-pointed payload (same signature, different asset) is refused", () => {
  const url = signDocLink({ publicId: "kashbook/fcy/ub_4", resourceType: "raw", mime: "application/pdf" });
  const token = url.slice(url.lastIndexOf("/") + 1).replace(/\.pdf$/, "");
  const [body, sig] = [token.slice(0, token.lastIndexOf(".")), token.slice(token.lastIndexOf(".") + 1)];
  const other = Buffer.from(JSON.stringify({ p: "kashbook/fcy/SOMEONE_ELSES_PASSPORT", r: "image", m: "image/jpeg", e: 9999999999 })).toString("base64url");
  assert.strictEqual(verifyDocLink(`${other}.${sig}`), null);
  assert.ok(verifyDocLink(`${body}.${sig}`), "the untouched token must still verify");
});

test("an expired link is refused; a live one is not", () => {
  const url = signDocLink({ publicId: "kashbook/fcy/ub_5", resourceType: "raw", mime: "application/pdf", ttlDays: 14 });
  const token = url.slice(url.lastIndexOf("/") + 1).replace(/\.pdf$/, "");
  assert.ok(verifyDocLink(token, { now: Date.now() + 13 * 86400 * 1000 }), "still valid on day 13");
  assert.strictEqual(verifyDocLink(token, { now: Date.now() + 15 * 86400 * 1000 }), null, "must be dead on day 15");
});

test("garbage never throws", () => {
  for (const junk of ["", ".", "a.", ".b", "x", null, undefined, 42, "a".repeat(5000), "notbase64.notasig"]) {
    assert.strictEqual(verifyDocLink(junk), null, `verifyDocLink(${JSON.stringify(junk)})`);
  }
});

test("the request body carries per-document links with the right extensions", () => {
  const inp = OK();
  inp.documents = {
    utilityBillId: "kb/ub", utilityBillType: "raw", utilityBillMime: "application/pdf",
    meansOfIdIds: ["kb/front", "kb/back"], meansOfIdTypes: ["raw", "image"], meansOfIdMimes: ["application/pdf", "image/png"],
  };
  const body = buildFcyRequest(inp);
  assert.ok(body.utilityBill.endsWith(".pdf"), body.utilityBill);
  assert.ok(body.meansOfId[0].endsWith(".pdf"), "a PDF ID page was labelled as an image: " + body.meansOfId[0]);
  assert.ok(body.meansOfId[1].endsWith(".png"), body.meansOfId[1]);
  for (const u of [body.utilityBill, ...body.meansOfId]) assert.ok(!/cloudinary/i.test(u), u);
});

// ══ 7b. DATE OF BIRTH IS A CALENDAR DATE ═══════════════════════════════════
section("7b. birthDate is the Lagos calendar date, not a slice of the ISO string");

test("the exact stored value Fincra declined (2 May at Lagos midnight) sends 2 May", () => {
  const inp = OK();
  inp.user.dateOfBirth = new Date("2004-05-01T23:00:00.000Z");
  assert.strictEqual(buildFcyRequest(inp).KYCInformation.birthDate, "2004-05-02",
    "still sending the previous day: Fincra will decline again with a DOB mismatch");
});

test("a UTC-midnight value (from a YYYY-MM-DD string) is unchanged", () => {
  const inp = OK();
  inp.user.dateOfBirth = new Date("2004-05-02T00:00:00.000Z");
  assert.strictEqual(buildFcyRequest(inp).KYCInformation.birthDate, "2004-05-02");
});

test("a bare YYYY-MM-DD string passes through", () => {
  const inp = OK();
  inp.user.dateOfBirth = "1990-04-02";
  assert.strictEqual(buildFcyRequest(inp).KYCInformation.birthDate, "1990-04-02");
});

test("year boundary: 31 Dec at Lagos midnight stays 31 Dec", () => {
  const inp = OK();
  inp.user.dateOfBirth = new Date("1999-12-30T23:00:00.000Z");
  assert.strictEqual(buildFcyRequest(inp).KYCInformation.birthDate, "1999-12-31");
});

test("no date of birth is still FCY_PROFILE_INCOMPLETE", () => {
  const inp = OK();
  inp.user.dateOfBirth = null;
  assert.throws(() => buildFcyRequest(inp), (e) => e.code === "FCY_PROFILE_INCOMPLETE" && e.field === "birthDate");
});

// ══ 7c. A RETRY IS A NEW REQUEST TO FINCRA ═════════════════════════════════
section("7c. every attempt carries its own merchantReference");

test("two attempts on the same row never share a reference (409 DUPLICATE_REFERENCE)", () => {
  const { attemptReference } = require("../src/routes/foreignAccounts");
  assert.strictEqual(typeof attemptReference, "function", "routes/foreignAccounts must expose attemptReference");
  const seen = new Set();
  for (let i = 0; i < 500; i++) {
    const ref = attemptReference("4f1b8f89-0000-0000-0000-000000000000");
    assert.ok(ref.startsWith("fa_4f1b8f89-"), ref);
    assert.ok(!seen.has(ref), `duplicate reference on attempt ${i}: ${ref}`);
    seen.add(ref);
  }
});

test("a reference still carries the row id for tracing in Fincra's dashboard", () => {
  const { attemptReference } = require("../src/routes/foreignAccounts");
  assert.ok(attemptReference("abc-123").includes("abc-123"));
});

// ══ 8. ACCOUNT LIFECYCLE WITHOUT THE WEBHOOK ═══════════════════════════════
section("8. polled account status maps to the same events the webhook uses");

const { decideAccountTransition, declineReasonOf } = require("../src/utils/fincraReconcile");
const D = (fa, d) => decideAccountTransition(fa, d);

test("pending + Fincra says declined → account_declined (the 2026-09-12 case)", () => {
  assert.strictEqual(D({ status: "pending" }, { status: "declined", reason: "x" }), "account_declined");
  assert.strictEqual(D({ status: "pending" }, { status: "DECLINED" }), "account_declined", "case-insensitive");
  assert.strictEqual(D({ status: "pending" }, { status: "rejected" }), "account_declined");
});

test("already declined + still declined → nothing (no second push)", () => {
  assert.strictEqual(D({ status: "declined" }, { status: "declined" }), null);
});

test("pending + approved (no details yet) → account_approved", () => {
  assert.strictEqual(D({ status: "pending" }, { status: "approved" }), "account_approved");
});

test("approved + isActive with account details → account_issued", () => {
  const d = { status: "approved", isActive: true, accountInformation: { otherInfo: { iban: "DE00" } } };
  assert.strictEqual(D({ status: "approved" }, d), "account_issued");
  assert.strictEqual(D({ status: "pending" }, d), "account_issued", "pending can go straight to issued");
});

test("approved with details but not yet active is still issued (details are what matter)", () => {
  assert.strictEqual(D({ status: "pending" }, { status: "approved", accountInformation: { accountNumber: "123" } }), "account_issued");
});

test("already issued + still active → nothing", () => {
  assert.strictEqual(D({ status: "issued" }, { status: "approved", isActive: true, accountInformation: { accountNumber: "1" } }), null);
});

test("pending + still pending → nothing; unknown status → nothing", () => {
  assert.strictEqual(D({ status: "pending" }, { status: "pending" }), null);
  assert.strictEqual(D({ status: "pending" }, { status: "processing" }), null);
  assert.strictEqual(D({ status: "pending" }, {}), null);
});

test("closed → account_closed once", () => {
  assert.strictEqual(D({ status: "issued" }, { status: "closed" }), "account_closed");
  assert.strictEqual(D({ status: "closed" }, { status: "closed" }), null);
});

test("the decline reason is found under any spelling Fincra has used", () => {
  assert.strictEqual(declineReasonOf({ reason: "Document type is different" }), "Document type is different");
  assert.strictEqual(declineReasonOf({ declineReason: " addr mismatch " }), "addr mismatch");
  assert.strictEqual(declineReasonOf({ rejectionReason: "r" }), "r");
  assert.strictEqual(declineReasonOf({ reason: "", comment: "c" }), "c");
  assert.strictEqual(declineReasonOf({}), "");
  assert.strictEqual(declineReasonOf({ reason: 42 }), "");
});

test("the webhook route exports handleEvent for the poller to reuse", () => {
  const mod = require("../src/routes/fincra");
  assert.strictEqual(typeof mod.handleEvent, "function", "routes/fincra must export handleEvent");
});

// The route itself, on a real listening socket with Cloudinary stubbed out.
const http = require("http");
const express = require("express");

async function atest(name, fn) {
  try { await fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); failed++; }
}

(async () => {
  const served = [];
  const app = express();
  app.use("/fcy-docs", createFcyDocsRouter({
    fetchAsset: async (link, method) => {
      served.push({ link, method });
      if (link.publicId === "kb/missing") return null;
      const body = Buffer.from("%PDF-1.1 stub");
      return { length: body.length, body: method === "HEAD" ? null : body };
    },
  }));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const at = (path, method = "GET") => fetch(`http://127.0.0.1:${port}${path}`, { method });
  const pathOf = (url) => url.slice(url.indexOf("/fcy-docs/"));

  await atest("GET a valid link: 200, real Content-Type, inline, the bytes", async () => {
    const url = signDocLink({ publicId: "kb/ub_ok", resourceType: "raw", mime: "application/pdf" });
    const r = await at(pathOf(url));
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers.get("content-type"), "application/pdf");
    assert.ok(/^inline; filename="document\.pdf"$/.test(r.headers.get("content-disposition")), r.headers.get("content-disposition"));
    assert.strictEqual(r.headers.get("content-length"), String(Buffer.byteLength("%PDF-1.1 stub")));
    assert.strictEqual(await r.text(), "%PDF-1.1 stub");
  });

  await atest("HEAD a valid link: 200 with headers and no body", async () => {
    const url = signDocLink({ publicId: "kb/ub_ok", resourceType: "raw", mime: "application/pdf" });
    const r = await at(pathOf(url), "HEAD");
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers.get("content-type"), "application/pdf");
    assert.strictEqual((await r.text()).length, 0);
  });

  await atest("an image link serves image/jpeg as .jpg", async () => {
    const url = signDocLink({ publicId: "kb/id_ok", resourceType: "image", mime: "image/jpeg" });
    const r = await at(pathOf(url));
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers.get("content-type"), "image/jpeg");
    assert.ok(url.endsWith(".jpg"));
  });

  await atest("a bad token is a 404, and Cloudinary is never asked", async () => {
    const before = served.length;
    const r = await at("/fcy-docs/not.a.real.token.pdf");
    assert.strictEqual(r.status, 404);
    assert.strictEqual(served.length, before, "the stub was called for a token that failed verification");
  });

  await atest("a valid token with a swapped extension is a 404", async () => {
    const url = signDocLink({ publicId: "kb/ub_ok", resourceType: "raw", mime: "application/pdf" });
    const r = await at(pathOf(url).replace(/\.pdf$/, ".jpg"));
    assert.strictEqual(r.status, 404);
  });

  await atest("a signed link to an asset that no longer exists is a 404, not a 500", async () => {
    const url = signDocLink({ publicId: "kb/missing", resourceType: "raw", mime: "application/pdf" });
    const r = await at(pathOf(url));
    assert.strictEqual(r.status, 404);
  });

  await new Promise((r) => server.close(r));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
