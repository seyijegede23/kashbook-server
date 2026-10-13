// The app's side of merged categories (chart of accounts release 1.1,
// 2026-10-13), run in Node through Babel like books-app-test.js on the real
// app files: src/utils/chart.js (the server's mirror), src/utils/accounts.js,
// and the mapAccount whitelist cut out of src/context/AppContext.js by its
// text (it is not exported). An account stands for the categories merged into
// it (aliasSlugs), so the phone must keep that list from the sync, find the
// account by one of them as the server's books do, and still see an unchanged
// chart from the next sync as unchanged (useAccounts keeps one steady list).
//   node scripts/accounts-app-test.js
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const APP = path.resolve(__dirname, "../..");
const babel = require(require.resolve("@babel/core", { paths: [APP] }));
const cjs = require.resolve("@babel/plugin-transform-modules-commonjs", { paths: [APP] });

const cache = new Map();
function load(file) {
  if (cache.has(file)) return cache.get(file).exports;
  const { code } = babel.transformSync(fs.readFileSync(file, "utf8"), { filename: file, plugins: [cjs], babelrc: false, configFile: false });
  const mod = { exports: {} };
  cache.set(file, mod);
  const localRequire = (p) => (p.startsWith(".") ? load(path.resolve(path.dirname(file), p.endsWith(".js") ? p : `${p}.js`)) : require(p));
  new Function("exports", "require", "module", code)(mod.exports, localRequire, mod);
  return mod.exports;
}
const chart = load(path.join(APP, "src/utils/chart.js"));
const accounts = load(path.join(APP, "src/utils/accounts.js"));
const serverChart = require("../src/utils/chart");

// mapAccount as AppContext.js defines it, from its first line to the "});"
// that closes it, run with the chart's helpers in scope (AppContext takes
// classOf and SYS from the chart).
const ctx = fs.readFileSync(path.join(APP, "src/context/AppContext.js"), "utf8");
const start = ctx.indexOf("const mapAccount = (a, businessId) => ({");
const end = ctx.indexOf("\n});", start);
assert.ok(start >= 0 && end > start, "mapAccount not found in src/context/AppContext.js");
const helpers = Object.keys(chart);
const mapAccount = new Function(...helpers, `${ctx.slice(start, end + 4)}\nreturn mapAccount;`)(...helpers.map((k) => chart[k]));

let passed = 0;
let failed = 0;
const check = (name, fn) => {
  try {
    fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${name}  →  ${e.message}`);
  }
};

// As the server sends them (publicAccount): Pest Control stands for
// Fumigation's category and for "utility" (Electricity and Utilities merged
// into it); Rent for its own, though Shop Costs lists "rent" too.
const raw = [
  { id: "pest", type: "expense", class: "expense", name: "Pest Control", categorySlug: "pest-control", aliasSlugs: ["fumigation", "utility"] },
  { id: "rent", type: "expense", class: "expense", name: "Rent", categorySlug: "rent", aliasSlugs: [], seed: "rent" },
  { id: "x", type: "expense", class: "expense", name: "Shop Costs", categorySlug: "shop-costs", aliasSlugs: ["rent"] },
  { id: "oth", type: "expense", class: "expense", name: "Other Expenses", systemKey: "other_expenses", system: true, categorySlug: "other", aliasSlugs: [] },
];
// The chart as the phone holds it after a sync.
const synced = () => raw.map((a) => mapAccount(JSON.parse(JSON.stringify(a)), "b1"));

console.log("\nMerged categories on the phone (release 1.1)");

check("mapAccount keeps aliasSlugs, and gives [] when a server sends none", () => {
  assert.deepStrictEqual(mapAccount(raw[0], "b1").aliasSlugs, ["fumigation", "utility"]);
  const older = { ...raw[1] };
  delete older.aliasSlugs;
  assert.deepStrictEqual(mapAccount(older, "b1").aliasSlugs, [], "an older server");
  assert.deepStrictEqual(mapAccount({ ...older, aliasSlugs: null }, "b1").aliasSlugs, [], "null");
  assert.deepStrictEqual(mapAccount({ ...older, aliasSlugs: "rent" }, "b1").aliasSlugs, [], "not a list");
  assert.deepStrictEqual(mapAccount({ ...older, aliasSlugs: ["a", 7, "", null, "b"] }, "b1").aliasSlugs, ["a", "b"], "only words");
});

check("an unchanged chart from the next sync is the same chart (useAccounts keeps one steady list)", () => {
  assert.ok(accounts.sameAccount({ id: "a", aliasSlugs: ["x", "y"] }, { id: "a", aliasSlugs: ["x", "y"] }), "equal lists");
  assert.ok(!accounts.sameAccount({ id: "a", aliasSlugs: ["x"] }, { id: "a", aliasSlugs: ["x", "y"] }), "a category merged in since");
  assert.ok(!accounts.sameAccount({ id: "a", aliasSlugs: ["x", "y"] }, { id: "a", aliasSlugs: ["x", "z"] }), "another category");
  assert.ok(!accounts.sameAccount({ id: "a", aliasSlugs: ["x"] }, { id: "a", aliasSlugs: "x" }), "a list and a word");
  const one = synced();
  const two = synced();
  assert.notStrictEqual(one[0].aliasSlugs, two[0].aliasSlugs, "two lists");
  assert.ok(accounts.sameAccount(one[0], two[0]), "Pest Control from two syncs");
  assert.ok(accounts.sameList(one, two, accounts.sameAccount), "the whole chart");
});

check("accountForCategory finds an account by a merged category, and never over another account's own", () => {
  for (const list of [synced(), synced().reverse()]) {
    const id = (slug) => (accounts.accountForCategory(list, slug) || { id: null }).id;
    assert.strictEqual(id("Fumigation"), "pest", "a merged category");
    assert.strictEqual(id("electricity"), "pest", "an older name of a merged category");
    assert.strictEqual(id("pest-control"), "pest", "its own");
    assert.strictEqual(id("rent"), "rent", "Rent's own, though Shop Costs lists it");
    assert.strictEqual(id("snacks"), null, "nothing stands for it");
  }
  assert.strictEqual(accounts.accountForCategory([null, ...synced()], "fumigation").id, "pest", "a hole in the list");
  assert.strictEqual(accounts.accountForCategory(null, "rent"), null, "no chart");
});

check("an expense in a merged category lands in the same account on the phone as in the server's books", () => {
  const phone = chart.indexChart(synced());
  const server = serverChart.indexChart(raw);
  for (const [category, want] of [["fumigation", "pest"], ["Electricity", "pest"], ["rent", "rent"], ["snacks", "oth"]]) {
    assert.strictEqual(chart.expenseAccount(phone, { category }).id, want, `${category} on the phone`);
    assert.strictEqual(serverChart.expenseAccount(server, { category }).id, want, `${category} on the server`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
