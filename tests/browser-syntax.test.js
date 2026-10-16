// The viewer and the setup wizard run in the user's own browser, and macOS
// users may be on Safari 15. Safari before 16.4 can't parse a regex
// lookbehind: a literal one is a SyntaxError for the WHOLE file (shared-core.js
// failing to load stops both the viewer and the wizard), and one built with
// new RegExp throws when that code runs. ESLint doesn't flag either, and the
// Playwright suite runs Chromium only, so the shipped browser files are
// scanned here.

require("./_real-data-guard.js");   // refuse to run outside a clean checkout
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src");
const files = fs.readdirSync(SRC).filter((f) => f.endsWith(".js"));

test("the browser files are found", () => {
  for (const f of ["app.js", "setup.js", "shared-core.js", "keepalive.js", "theme-boot.js"]) assert.ok(files.includes(f), f);
});

for (const f of files) {
  test(f + " has no regex lookbehind (Safari before 16.4 can't parse it)", () => {
    const lines = fs.readFileSync(path.join(SRC, f), "utf8").split("\n");
    const hits = lines.map((l, i) => (/\(\?<[=!]/.test(l) ? (i + 1) + ": " + l.trim() : null)).filter(Boolean);
    assert.deepStrictEqual(hits, []);
  });
  test(f + " has no class static block (Safari before 16.4 can't parse it)", () => {
    assert.ok(!/\bstatic\s*\{/.test(fs.readFileSync(path.join(SRC, f), "utf8")));
  });
}
