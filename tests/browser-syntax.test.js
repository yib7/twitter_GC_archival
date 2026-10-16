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

// An invisible character (U+FE0F, the keycap mark, ZWJ / ZWNJ, zero-width
// space, word joiner, BOM) typed literally into a regex or string can't be
// seen in review and an editor may strip it, so the code writes them as \u
// escapes. One inside a visible emoji (a comment's or a label's) is fine.
const { extractEmojis } = require("../src/shared-core.js");
for (const f of files) {
  test(f + " writes invisible characters as escapes", () => {
    const hits = [];
    fs.readFileSync(path.join(SRC, f), "utf8").split("\n").forEach((l, i) => {
      let rest = l;
      for (const e of extractEmojis(l)) rest = rest.split(e).join("");
      if (/[\uFE0F\u20E3\u200B-\u200D\u2060\uFEFF]/.test(rest)) hits.push((i + 1) + ": " + JSON.stringify(l.trim()));
    });
    assert.deepStrictEqual(hits, []);
  });
}
