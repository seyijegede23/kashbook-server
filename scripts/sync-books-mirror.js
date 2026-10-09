// Writes the app's copy of the books rule (../../src/utils/books.js) from the
// server's (src/utils/books.js): the same body, ES-module exports. Run after
// editing the server file; scripts/books-test.js fails if the two differ.
//   node scripts/sync-books-mirror.js [--check]
const fs = require("fs");
const path = require("path");

const SERVER = path.resolve(__dirname, "../src/utils/books.js");
const APP = path.resolve(__dirname, "../../src/utils/books.js");
const MARKER = "// ── exports (everything above this line is identical in src/utils/books.js) ──";

function bodyOf(src) {
  const i = src.indexOf(MARKER);
  if (i < 0) throw new Error("export marker missing");
  return src.slice(0, i).replace(/\r\n/g, "\n");
}

function exportNames(src) {
  const block = src.slice(src.indexOf("module.exports = {") + "module.exports = {".length, src.lastIndexOf("}"));
  return block.split(",").map((s) => s.trim()).filter(Boolean);
}

function build() {
  const server = fs.readFileSync(SERVER, "utf8");
  const names = exportNames(server);
  return `${bodyOf(server)}${MARKER.replace("src/utils/books.js", "server/src/utils/books.js")}\nexport {\n${names.map((n) => `  ${n},`).join("\n")}\n};\n`;
}

if (require.main === module) {
  const want = build();
  if (process.argv.includes("--check")) {
    const have = fs.existsSync(APP) ? fs.readFileSync(APP, "utf8").replace(/\r\n/g, "\n") : "";
    if (have !== want) {
      console.error("src/utils/books.js is out of date: run node scripts/sync-books-mirror.js");
      process.exit(1);
    }
    console.log("books mirror in sync");
  } else {
    fs.writeFileSync(APP, want);
    console.log(`wrote ${APP}`);
  }
}

module.exports = { build, bodyOf, SERVER, APP, MARKER };
