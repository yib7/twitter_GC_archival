const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { THEME_BGS } = require("../src/shared-core.js");

// The viewer (app.js) and the wizard (setup.js) derive accent and person
// colors against each theme's surfaces. Both read one table,
// GCAShared.THEME_BGS, and it must match the html[data-theme] blocks in
// styles.css, so a theme color change can't silently drift either page.
const SRC = path.join(__dirname, "..", "src");
const css = fs.readFileSync(path.join(SRC, "styles.css"), "utf8");

test("THEME_BGS matches --bg-page, --bg-card and --bg-inset of every theme block", () => {
  assert.ok(THEME_BGS, "GCAShared.THEME_BGS is exported");
  for (const t of ["lightsout", "dim", "light"]) {
    const block = new RegExp('html\\[data-theme="' + t + '"\\]\\{([^}]*--bg-page[^}]*)\\}').exec(css);
    assert.ok(block, t + " block found");
    const tok = (n) => (new RegExp("--" + n + ":(#[0-9a-f]{6})", "i").exec(block[1]) || [])[1];
    assert.deepStrictEqual(THEME_BGS[t], [tok("bg-page"), tok("bg-card"), tok("bg-inset")], t);
  }
});

test("app.js and setup.js keep no copy of their own", () => {
  for (const f of ["app.js", "setup.js"]) {
    assert.ok(!/const THEME_BGS\s*=\s*\{/.test(fs.readFileSync(path.join(SRC, f), "utf8")), f);
  }
});
