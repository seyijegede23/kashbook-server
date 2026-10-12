// Writes the app's copies of the shared pure modules from the server's: the
// books rule (src/utils/books.js) and, since the chart of accounts
// (2026-10-11), the chart (src/utils/chart.js). Same body, ES-module exports.
// Run after editing a server file; scripts/books-test.js fails if a copy differs.
//   node scripts/sync-books-mirror.js [--check]
const fs = require("fs");
const path = require("path");

const FILES = ["books.js", "chart.js"].map((name) => ({
  name,
  server: path.resolve(__dirname, "../src/utils", name),
  app: path.resolve(__dirname, "../../src/utils", name),
  marker: `// ── exports (everything above this line is identical in src/utils/${name}) ──`,
}));

// The books rule's paths, kept for the existing callers (books-test.js).
const SERVER = FILES[0].server;
const APP = FILES[0].app;
const MARKER = FILES[0].marker;

function bodyOf(src, marker = MARKER) {
  const i = src.indexOf(marker);
  if (i < 0) throw new Error("export marker missing");
  return src.slice(0, i).replace(/\r\n/g, "\n");
}

function exportNames(src) {
  const block = src.slice(src.indexOf("module.exports = {") + "module.exports = {".length, src.lastIndexOf("}"));
  return block.split(",").map((s) => s.trim()).filter(Boolean);
}

function buildFile(f) {
  const server = fs.readFileSync(f.server, "utf8");
  const names = exportNames(server);
  return `${bodyOf(server, f.marker)}${f.marker.replace(`src/utils/${f.name}`, `server/src/utils/${f.name}`)}\nexport {\n${names.map((n) => `  ${n},`).join("\n")}\n};\n`;
}

// The app's books.js as it should be (books-test.js compares against this).
function build() {
  return buildFile(FILES[0]);
}

if (require.main === module) {
  let stale = 0;
  for (const f of FILES) {
    const want = buildFile(f);
    if (process.argv.includes("--check")) {
      const have = fs.existsSync(f.app) ? fs.readFileSync(f.app, "utf8").replace(/\r\n/g, "\n") : "";
      if (have !== want) {
        console.error(`src/utils/${f.name} is out of date: run node scripts/sync-books-mirror.js`);
        stale++;
      }
    } else {
      fs.writeFileSync(f.app, want);
      console.log(`wrote ${f.app}`);
    }
  }
  if (process.argv.includes("--check")) {
    if (stale) process.exit(1);
    console.log("mirrors in sync");
  }
}

module.exports = { FILES, buildFile, build, bodyOf, SERVER, APP, MARKER };
