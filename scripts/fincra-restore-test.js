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

test("passport sends a SINGLE url string, not an array", () => {
  const inp = OK();
  inp.extra.document.type = "passport";
  inp.documents.meansOfIdIds = ["kb/passport_page"];
  const body = buildFcyRequest(inp);
  assert.strictEqual(typeof body.meansOfId, "string",
    "passport must send one url string; an array is a validation decline");
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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
