// P2-11 drift guard: a handful of helpers/constants are hand-duplicated across
// the file:// app (src/app.js), the setup wizard (src/setup.js), and the Node
// build (scripts/build-core.js), tied together only by "kept in sync with …"
// comments. This test extracts each copy straight out of the source text and
// asserts the pairs cannot silently drift apart:
//
//   PALETTE   src/app.js ↔ src/setup.js         (textual identity)
//   X_LINK    src/app.js ↔ scripts/build-core.js (textual identity)
//   hashId    src/app.js ↔ src/setup.js         (behavioral identity)
//   colorOf   src/app.js ↔ src/setup.js         (behavioral identity)
//   initials  src/app.js ↔ src/setup.js         (behavioral identity)
//
// hashId/colorOf/initials are compared by BEHAVIOR, not text, because the two
// copies intentionally differ in wording: setup.js coerces with String(...),
// and app.js's colorOf first honors a user-picked settings.colors override
// (asserted here with no override set, which must fall back to the shared
// palette). What must never drift is the observable result for the same input.
//
// If an anchor regex below stops matching (rename/move/reformat), the test
// FAILS LOUDLY naming both files, so a refactor cannot silently disable the
// guard — update the anchor AND keep the twin copy in sync.

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const APP = path.join(ROOT, "src", "app.js");
const SETUP = path.join(ROOT, "src", "setup.js");
const BUILD_CORE = path.join(ROOT, "scripts", "build-core.js");

const read = (f) => fs.readFileSync(f, "utf8");

// Extract one snippet by a stable anchor regex; fail loudly if it's gone.
function extract(file, twinFile, name, re) {
  const m = read(file).match(re);
  assert.ok(
    m,
    `drift-guard anchor for "${name}" no longer matches in ${file}. ` +
      `This helper is duplicated in ${twinFile} ("kept in sync" comment) — ` +
      `if it was renamed, moved, or reformatted, update BOTH copies and the ` +
      `anchor in tests/shared-constants-drift.test.js. Do NOT let this guard ` +
      `silently stop matching.`
  );
  return (m[1] !== undefined ? m[1] : m[0]).trim();
}

// Strip block comments and collapse whitespace so formatting-only diffs pass.
// (Line comments are left alone: none of the guarded snippets contain them,
// and a naive //-strip would be riskier around regex literals.)
function normalize(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\s+/g, " ").trim();
}

// Evaluate a `const X = …` / `function X(…) {…}` snippet in an isolated vm
// context (with optional extra bindings) and return the resulting value.
function loadBinding(snippet, name, scope) {
  const ctx = vm.createContext(Object.assign({}, scope));
  return vm.runInContext(snippet + "\n;" + name, ctx);
}

/* ---- textual pairs -------------------------------------------------------- */

test("PALETTE is identical in src/app.js and src/setup.js", () => {
  const re = /^const PALETTE = (\[[^;]*\]);/m;
  const a = extract(APP, SETUP, "PALETTE", re);
  const b = extract(SETUP, APP, "PALETTE", re);
  assert.equal(
    normalize(a),
    normalize(b),
    `PALETTE drifted between src/app.js and src/setup.js — the wizard and the ` +
      `viewer would assign people different avatar colors. Update both copies.`
  );
});

test("X_LINK regex is identical in src/app.js and scripts/build-core.js", () => {
  const re = /^const X_LINK = (\/[^\n]+\/i);/m;
  const a = extract(APP, BUILD_CORE, "X_LINK", re);
  const b = extract(BUILD_CORE, APP, "X_LINK", re);
  assert.equal(
    normalize(a),
    normalize(b),
    `X_LINK drifted between src/app.js and scripts/build-core.js — the app and ` +
      `the build would disagree on which messages are link-only. Update both copies.`
  );
});

/* ---- behavioral pairs ----------------------------------------------------- */

const APP_HASHID_RE = /^function hashId\(id\) \{[^\n]*\}$/m;
const SETUP_HASHID_RE = /^function hashId\(id\) \{[^\n]*\}$/m;
const APP_PALETTE_RE = /^const PALETTE = (\[[^;]*\]);/m;

function loadAppHashId() {
  return loadBinding(extract(APP, SETUP, "hashId", APP_HASHID_RE), "hashId");
}
function loadSetupHashId() {
  return loadBinding(extract(SETUP, APP, "hashId", SETUP_HASHID_RE), "hashId");
}

// String ids only: real sender ids are strings ("900000000000000001"); the
// setup copy additionally String()-coerces, which is its documented extra.
const ID_BATTERY = [
  "", "0", "1", "u1", "u2", "abc", "900000000000000001",
  "1467812909021231104", "some-long-mixed-ID_42", "🙂🙂",
];

test("hashId behaves identically in src/app.js and src/setup.js", () => {
  const appFn = loadAppHashId();
  const setupFn = loadSetupHashId();
  for (const id of ID_BATTERY) {
    assert.equal(
      appFn(id),
      setupFn(id),
      `hashId("${id}") differs between src/app.js and src/setup.js — avatar ` +
        `colors would no longer match between the viewer and the wizard. ` +
        `Update both copies.`
    );
  }
});

test("colorOf (no user override) behaves identically in src/app.js and src/setup.js", () => {
  // extract() returns just the array literal here (the regex capture group),
  // so rebuild a declaration before evaluating it.
  const appPalette = loadBinding("const PALETTE = " + extract(APP, SETUP, "PALETTE", APP_PALETTE_RE), "PALETTE");
  const setupPalette = loadBinding("const PALETTE = " + extract(SETUP, APP, "PALETTE", APP_PALETTE_RE), "PALETTE");
  // app.js colorOf consults settings.colors first; with no override it must
  // fall back to exactly the wizard's color for the same id.
  const appFn = loadBinding(
    extract(APP, SETUP, "colorOf", /^function colorOf\(id\) \{[^\n]*\}$/m),
    "colorOf",
    { settings: { colors: {} }, PALETTE: appPalette, hashId: loadAppHashId() }
  );
  const setupFn = loadBinding(
    extract(SETUP, APP, "colorOf", /^const colorOf = \(id\) =>[^\n]*;$/m),
    "colorOf",
    { PALETTE: setupPalette, hashId: loadSetupHashId() }
  );
  for (const id of ID_BATTERY) {
    if (id === "") continue; // app.js never calls colorOf with an empty id
    assert.equal(
      appFn(id),
      setupFn(id),
      `colorOf("${id}") differs between src/app.js and src/setup.js — the same ` +
        `person would get different colors in the viewer vs the wizard. ` +
        `Update both copies.`
    );
  }
});

test("initials behaves identically in src/app.js and src/setup.js", () => {
  const re = /^function initials\(name\) \{[\s\S]*?\n\}/m;
  const appFn = loadBinding(extract(APP, SETUP, "initials", re), "initials");
  const setupFn = loadBinding(extract(SETUP, APP, "initials", re), "initials");
  const NAMES = [
    "", "   ", "a", "Al", "Alice", "alice bob", "Alice Bob Carol",
    "  padded   name  ", "josé garcía", "X Æ A-12", "🙂 face", "van der Berg",
  ];
  for (const name of NAMES) {
    assert.equal(
      appFn(name),
      setupFn(name),
      `initials("${name}") differs between src/app.js and src/setup.js — ` +
        `avatar initials would no longer match between the viewer and the ` +
        `wizard. Update both copies.`
    );
  }
});
