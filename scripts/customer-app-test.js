// The app's phone helpers for the customer form (src/utils/phone.js), run in
// Node through Babel like books-app-test.js: country code + number in and out,
// and one key per number whatever its format (the "already a customer" check).
//   node scripts/customer-app-test.js
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
const { splitPhone, joinPhone, isValidPhone, phoneKey, cleanPhone } = load(path.join(APP, "src/utils/phone.js"));

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
const deq = (a, b) => assert.deepStrictEqual(a, b, `${JSON.stringify(a)} !== ${JSON.stringify(b)}`);

console.log("\nPhone numbers on the customer form");
check("an international number splits into its code and the rest", () => {
  deq(splitPhone("+2348031234567"), { code: "234", number: "8031234567" });
  deq(splitPhone("+447700900123"), { code: "44", number: "7700900123" });
});
check("longest code wins (+1264 Anguilla, not +1)", () => deq(splitPhone("+12645551234").code, "1264"));
check("a local number reads as Nigerian and keeps its 0", () => deq(splitPhone("0803 123 4567"), { code: "234", number: "08031234567" }));
check("nothing typed gives the default code and no number", () => deq(splitPhone(""), { code: "234", number: "" }));
check("joining drops the local 0 and adds the code", () => {
  deq(joinPhone("234", "08031234567"), "+2348031234567");
  deq(joinPhone("44", "7700 900123"), "+447700900123");
  deq(joinPhone("234", ""), "");
  deq(joinPhone("234", "+447700900123"), "+447700900123");
});
check("split then join gives back an international number", () => {
  for (const n of ["+2348031234567", "+447700900123"]) {
    const { code, number } = splitPhone(n);
    deq(joinPhone(code, number), n);
  }
});
check("6 to 15 digits is a phone number", () => {
  deq(isValidPhone("+2348031234567"), true);
  deq(isValidPhone("12345"), false);
  deq(isValidPhone("+1234567890123456"), false);
});
check("one key per number, whatever the format", () => {
  const k = phoneKey("+2348031234567");
  deq(phoneKey("08031234567"), k);
  deq(phoneKey("0803 123 4567"), k);
  deq(phoneKey("2348031234567"), k);
  deq(phoneKey(""), "");
});
check("cleaning keeps a leading + and the digits", () => {
  deq(cleanPhone(" +234 (803) 123-4567 "), "+2348031234567");
  deq(cleanPhone("0803-123-4567"), "08031234567");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
