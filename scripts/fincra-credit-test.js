// Regression test: proves the inbound-credit fix against Fincra's DOCUMENTED
// collection.successful payload. Prisma is stubbed, nothing touches the DB.
const path = require("path");

// The stubs HONOUR the `where` clause on purpose.
//
// An earlier version returned a fixed row for every query, which made every
// resolution assertion vacuous: the test passed whether the code matched the
// right account, the wrong account, or ignored the lookup entirely — precisely
// the misrouting bug the fix exists to prevent. These stubs run the same simple
// AND-match Prisma would, over a table of rows, so a wrong `where` finds nothing.
function matches(row, where = {}) {
  return Object.entries(where).every(([k, v]) => {
    // The resolution query is `where: { OR: [{fincraAccountId}, {fincraRequestId}] }`,
    // so the stub has to understand OR/AND or it silently matches nothing.
    if (k === "OR") return v.some((clause) => matches(row, clause));
    if (k === "AND") return v.every((clause) => matches(row, clause));
    if (v && typeof v === "object" && "not" in v) return row[k] !== v.not;
    if (v && typeof v === "object" && "in" in v) return v.in.includes(row[k]);
    // Prisma does not match on undefined/null columns the way a bare === would.
    if (v === undefined) return true;
    return row[k] === v;
  });
}

function load({ foreignAccounts = [], businesses = [] }) {
  for (const k of Object.keys(require.cache)) delete require.cache[k];
  const created = [];
  const faRows = [].concat(foreignAccounts).filter(Boolean);
  const bizRows = [].concat(businesses).filter(Boolean);
  const stub = {
    foreignAccount: {
      findFirst: async ({ where } = {}) => faRows.find((r) => matches(r, where)) || null,
      update: async () => ({}),
    },
    business: {
      findFirst: async ({ where } = {}) => bizRows.find((r) => matches(r, where)) || null,
      findUnique: async ({ where } = {}) => bizRows.find((r) => matches(r, where)) || null,
    },
    transaction: {
      create: async ({ data }) => {
        // Enforce the real idempotency gate: @@unique([businessId, reference]).
        if (created.some((c) => c.businessId === data.businessId && c.reference === data.reference)) {
          throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        }
        created.push(data); return data;
      },
    },
    complianceFlag: { create: async () => ({}) },
  };
  const dbPath = require.resolve("../src/utils/db");
  require(dbPath);
  require.cache[dbPath].exports = stub;

  for (const m of ["../src/utils/pushNotification", "../src/utils/igPaymentMatch", "../src/utils/waPaymentMatch"]) {
    const p = require.resolve(m);
    require(p);
    require.cache[p].exports = {
      pushTo: async () => {}, tryMatchIgPayment: async () => {}, tryMatchWaPayment: async () => {},
    };
  }
  const bc = require.resolve("../src/utils/balanceCache");
  require(bc);
  require.cache[bc].exports = { adjustBalance: () => {}, bustBalance: () => {} };

  return { fn: require("../src/utils/fincraCredit").recordFincraInboundCredit, created };
}

// Verbatim from Fincra's collection.successful documentation.
const PAYLOAD = {
  business: "jw3e3d4fa8728738k82299h4",
  virtualAccount: "65f0a1b2c3d4e5f6a7b8c9b9", // ← a STRING id, not an object
  sessionId: "0000021234",
  senderBankName: "Zenith Bank",
  senderAccountName: "John Doe",
  senderAccountNumber: null, // null on the successful sample
  sourceCurrency: "EUR",
  destinationCurrency: "EUR",
  sourceAmount: 15,
  destinationAmount: 5,
  amountReceived: 4.98,
  fee: 0.02,
  customerName: "John Doe",
  description: "FT//12345678/NXG :TRFFRM John Doe TO John Doe",
  status: "successful",
  reference: "FNCR_42e9f72b0075",
};

const BIZ = { id: "biz-1", userId: "user-1", name: "Test Ltd", baseCurrency: "NGN" };
const FA = { id: "fa-1", businessId: "biz-1", currency: "EUR", fincraAccountId: "65f0a1b2c3d4e5f6a7b8c9b9", inflowMonth: null, inflowThisMonth: 0 };

(async () => {
  let pass = 0, fail = 0;
  const check = (name, cond, extra = "") => {
    if (cond) { pass++; console.log(`  ✔ ${name}`); }
    else { fail++; console.log(`  ✖ ${name} ${extra}`); }
  };

  // 1. THE P0: the documented payload must now resolve and book.
  {
    const { fn, created } = load({ foreignAccounts: [FA], businesses: [BIZ] });
    const r = await fn(PAYLOAD);
    check("documented payload is RECORDED (was silently dropped)", r.recorded === true, JSON.stringify(r));
    check("amount = amountReceived 4.98 (fee-net, not re-deducted)", created[0]?.amount === 4.98, `got ${created[0]?.amount}`);
    check("currency = EUR (was defaulting to NGN)", created[0]?.currency === "EUR", `got ${created[0]?.currency}`);
    check("fee 0.02 persisted", created[0]?.fee === 0.02, `got ${created[0]?.fee}`);
    check("reference carried through", created[0]?.reference === "FNCR_42e9f72b0075");
    check("sender name resolved from senderAccountName",
      String(created[0]?.description || "").includes("John Doe"), created[0]?.description);
  }

  // 2. Local pooled account: resolves via Business.providerAccountId.
  {
    const { fn, created } = load({ foreignAccounts: [], businesses: [{ ...BIZ, id: "biz-gh", providerAccountId: "va-ghs-1" }] });
    const r = await fn({ ...PAYLOAD, virtualAccount: "va-ghs-1", sourceCurrency: "GHS", destinationCurrency: "GHS", amountReceived: 250 });
    check("pooled local account resolves via providerAccountId", r.recorded === true, JSON.stringify(r));
    check("local credit books its own currency", created[0]?.currency === "GHS", `got ${created[0]?.currency}`);
  }

  // 3. Unresolvable credit must NOT be silent.
  {
    const { fn } = load({ foreignAccounts: [], businesses: [] });
    const errs = [];
    const orig = console.error; console.error = (...a) => errs.push(a.join(" "));
    const r = await fn({ ...PAYLOAD, virtualAccount: "unknown-va" });
    console.error = orig;
    check("unresolved credit is rejected", r.recorded === false && r.reason === "no_business");
    check("unresolved credit LOGS LOUDLY (was silent)", errs.some((e) => e.includes("UNRESOLVED")), JSON.stringify(errs));
  }

  // 4. Legacy shape with a real account number still works.
  {
    const { fn, created } = load({ foreignAccounts: [{ ...FA, fincraAccountId: null, accountNumber: "8373878380" }], businesses: [BIZ] });
    const r = await fn({ accountNumber: "8373878380", amountReceived: 10, destinationCurrency: "USD", reference: "R2" });
    check("legacy accountNumber path still resolves", r.recorded === true && created[0]?.currency === "USD");
  }

  // 5. Zero/absent amount is still refused.
  {
    const { fn } = load({ foreignAccounts: [FA], businesses: [BIZ] });
    const r = await fn({ ...PAYLOAD, amountReceived: 0, destinationAmount: 0, amount: 0 });
    check("zero amount refused", r.recorded === false && r.reason === "invalid", JSON.stringify(r));
  }

  // 6. WRONG-BUSINESS MISROUTING. Two businesses each own an FCY account. A
  //    credit for one must never land on the other. With stubs that ignored
  //    `where`, this case could not fail.
  {
    const FA_A = { id: "fa-a", businessId: "biz-a", currency: "USD", fincraAccountId: "va-AAA", inflowMonth: null, inflowThisMonth: 0 };
    const FA_B = { id: "fa-b", businessId: "biz-b", currency: "USD", fincraAccountId: "va-BBB", inflowMonth: null, inflowThisMonth: 0 };
    const BIZ_A = { id: "biz-a", userId: "u-a", name: "A Ltd", baseCurrency: "NGN" };
    const BIZ_B = { id: "biz-b", userId: "u-b", name: "B Ltd", baseCurrency: "NGN" };
    const { fn, created } = load({ foreignAccounts: [FA_A, FA_B], businesses: [BIZ_A, BIZ_B] });
    await fn({ ...PAYLOAD, virtualAccount: "va-BBB", destinationCurrency: "USD", amountReceived: 100, reference: "R-B" });
    check("credit lands on the RIGHT business", created[0]?.businessId === "biz-b", `got ${created[0]?.businessId}`);
  }

  // 7. destinationCurrency must win over sourceCurrency. Every earlier fixture
  //    had them equal, so this distinction was untested.
  {
    const { fn, created } = load({ foreignAccounts: [FA], businesses: [BIZ] });
    await fn({ ...PAYLOAD, sourceCurrency: "GBP", destinationCurrency: "EUR", amountReceived: 4.98, reference: "R-CCY" });
    check("books destinationCurrency, not sourceCurrency", created[0]?.currency === "EUR", `got ${created[0]?.currency}`);
  }

  // 8. IDEMPOTENCY. The webhook and the reconcile backstop share this function,
  //    so the same collection arriving twice must book once.
  {
    const { fn, created } = load({ foreignAccounts: [FA], businesses: [BIZ] });
    const a = await fn(PAYLOAD);
    const b = await fn(PAYLOAD); // replay, as reconcile would
    check("replayed credit books exactly once", created.length === 1, `booked ${created.length}`);
    check("replay reports duplicate, not success", a.recorded === true && b.recorded === false && b.reason === "duplicate",
      JSON.stringify(b));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
