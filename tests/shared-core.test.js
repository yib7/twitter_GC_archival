// Replaces tests/shared-constants-drift.test.js. The old guard existed
// only because PALETTE / X_LINK / hashId / initials / the colorOf palette-lookup
// were hand-copied across src/app.js, src/setup.js and scripts/build-core.js — it
// compared the copies to each other so they couldn't silently drift.
//
// The extraction collapsed those copies into ONE module (src/shared-core.js), so "drift
// between copies" is no longer possible. This test instead:
//   1. pins the shared logic — hashId / initials produce exactly
//      the expected outputs over the same ID/NAME batteries the drift test used,
//      so a refactor of the single source can't quietly change avatar
//      colors/initials; and
//   2. asserts single-source — none of the three consumers still declares its
//      own PALETTE / X_LINK / hashId / initials, proving the extraction actually
//      happened and no stale copy was left behind.
//
// The expected literals below were derived from an independent reference
// implementation of the (fixed, deterministic) algorithm — not from the module
// under test — so they genuinely constrain its behavior.

require("./_real-data-guard.js");   // refuse to run outside a clean checkout
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const shared = require("../src/shared-core.js");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

/* ---- API surface --------------------------------------------------------- */

test("shared-core exports the full API", () => {
  for (const k of ["PALETTE", "X_LINK", "hashId", "initials",
    "PHOTO_RE", "PHOTO_PATH_RE", "sanitizePhoto", "sanitizeColor", "isValidTimeZone",
    "isPlainObj", "cleanMap", "idList", "cleanSaved", "validateSettings"]) {
    assert.ok(k in shared, `src/shared-core.js must export ${k}`);
  }
  assert.ok(Array.isArray(shared.PALETTE) && shared.PALETTE.length === 12, "PALETTE is the 12-color array");
  assert.ok(shared.X_LINK instanceof RegExp, "X_LINK is a RegExp");
  assert.equal(typeof shared.hashId, "function");
  assert.equal(typeof shared.initials, "function");
});

test("PALETTE is the exact 12-color avatar palette", () => {
  assert.deepStrictEqual(shared.PALETTE, [
    "#3b82f6", "#22c55e", "#f59e0b", "#ec4899", "#8b5cf6", "#06b6d4",
    "#ef4444", "#10b981", "#f97316", "#a855f7", "#14b8a6", "#eab308",
  ]);
});

test("X_LINK matches Twitter/X links (and not plain text)", () => {
  // the host follows its scheme or starts a word: linear time, "netflix.com/"
  // isn't an x.com link, and no lookbehind (Safari before 16.4 can't parse one)
  assert.equal(shared.X_LINK.source, "(?:https?:\\/\\/|^|[^\\w-])(?:t\\.co|(?:[\\w-]+\\.)?twitter\\.com|(?:[\\w-]+\\.)?x\\.com)\\/");
  assert.equal(shared.X_LINK.flags, "i");
  for (const s of ["https://t.co/abc", "check twitter.com/x out", "x.com/foo", "HTTP://X.COM/", "sub.twitter.com/y"]) {
    assert.ok(shared.X_LINK.test(s), `X_LINK should match ${s}`);
  }
  for (const s of ["hello world", "example.com/x", "just talking about x and twitter"]) {
    assert.ok(!shared.X_LINK.test(s), `X_LINK should NOT match ${s}`);
  }
});

/* ---- pinned behavior over the drift test's batteries --------------------- */

// String ids only (real sender ids are strings, e.g. "900000000000000001");
// hashId additionally String()-coerces so numeric wizard ids hash identically.
const ID_BATTERY = [
  "", "0", "1", "u1", "u2", "abc", "900000000000000001",
  "920000000000000007", "some-long-mixed-ID_42", "🙂🙂",
];
const EXPECT_HASH = [0, 48, 49, 3676, 3677, 96354, 3419089176, 1830741280, 4044068280, 1705592330];

const NAME_BATTERY = [
  "", "   ", "a", "Al", "Alice", "alice bob", "Alice Bob Carol",
  "  padded   name  ", "josé garcía", "X Æ A-12", "🙂 face", "van der Berg",
];
const EXPECT_INITIALS = ["?", "?", "A", "AL", "AL", "AB", "AC", "PN", "JG", "XA", "FA", "VB"];

test("hashId returns the expected 32-bit hash for every id in the battery", () => {
  ID_BATTERY.forEach((id, i) => {
    assert.equal(shared.hashId(id), EXPECT_HASH[i], `hashId(${JSON.stringify(id)})`);
  });
});

test("hashId String()-coerces (numeric id hashes same as its string form)", () => {
  assert.equal(shared.hashId(1), shared.hashId("1"));
  assert.equal(shared.hashId(900000000000000001n.toString()), shared.hashId("900000000000000001"));
});

test("initials returns the expected monogram for every name in the battery", () => {
  NAME_BATTERY.forEach((name, i) => {
    assert.equal(shared.initials(name), EXPECT_INITIALS[i], `initials(${JSON.stringify(name)})`);
  });
});

test("initials skips emoji and punctuation words and never splits a character", () => {
  assert.equal(shared.initials("Ana 😀"), "AN");
  assert.equal(shared.initials("🔥 Sam"), "SA");
  assert.equal(shared.initials("Jo ✨ Lee"), "JL");
  assert.equal(shared.initials("(Sam)"), "SA");
  assert.equal(shared.initials("𝓐lex 𝓑ell"), "𝓐𝓑");
  assert.equal(shared.initials("🔥🔥"), "🔥");
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  const names = ["Ana 😀", "🔥 Sam", "😀", "👨‍👩‍👧 family", "🇯🇵 Kenji", "Zoë 💜", "𠀋 Wu", "Amélie 🎉 B", "✨", "𝓐", "Sam 🔥🔥"];
  for (const n of names) assert.ok(!lone.test(shared.initials(n)), "no lone surrogate for " + JSON.stringify(n));
});

/* ---- the person hue rule ----------------------------------------- */
test("personHue / hueVars map an id to one of the 10 --p-/--f- hue pairs by its hash", () => {
  assert.deepEqual(shared.HUES, ["rose", "coral", "amber", "lime", "emerald", "teal", "sky", "indigo", "violet", "magenta"]);
  for (const id of ID_BATTERY) {
    const h = shared.HUES[shared.hashId(id) % 10];
    assert.equal(shared.personHue(id), h);
    assert.deepEqual(shared.hueVars(id), { p: "var(--p-" + h + ")", f: "var(--f-" + h + ")" });
  }
});

test("the setup wizard paints avatars with the viewer's hue rule, not the old palette", () => {
  const setup = read("src/setup.js");
  assert.ok(!/paletteColor/.test(setup), "src/setup.js no longer uses paletteColor");
  assert.match(setup, /hueVars/);
  assert.match(read("src/app.js"), /function autoColor\(id\) \{ return hueVars\(id\); \}/);
});

/* ---- single-source guard ------------------------------------------------- */
// The whole point of the extraction: no consumer may keep its own copy. If any of these
// declarations reappears in a consumer, the extraction has regressed.

const NO_LOCAL_DECL = [
  { file: "src/app.js", name: "PALETTE", re: /^\s*const\s+PALETTE\s*=/m },
  { file: "src/app.js", name: "X_LINK", re: /^\s*const\s+X_LINK\s*=/m },
  { file: "src/app.js", name: "hashId", re: /^\s*function\s+hashId\b/m },
  { file: "src/app.js", name: "initials", re: /^\s*function\s+initials\b/m },
  { file: "src/setup.js", name: "PALETTE", re: /^\s*const\s+PALETTE\s*=/m },
  { file: "src/setup.js", name: "hashId", re: /^\s*function\s+hashId\b/m },
  { file: "src/setup.js", name: "initials", re: /^\s*function\s+initials\b/m },
  { file: "scripts/build-core.js", name: "X_LINK", re: /^\s*const\s+X_LINK\s*=/m },
  { file: "src/app.js", name: "PHOTO_RE", re: /^\s*const\s+PHOTO_RE\b/m },
  { file: "src/app.js", name: "PHOTO_PATH_RE", re: /^\s*const\s+PHOTO_PATH_RE\b/m },
  { file: "src/app.js", name: "sanitizePhoto", re: /^\s*function\s+sanitizePhoto\b/m },
  { file: "src/app.js", name: "sanitizeColor", re: /^\s*function\s+sanitizeColor\b/m },
  { file: "src/app.js", name: "isValidTimeZone", re: /^\s*function\s+isValidTimeZone\b/m },
  { file: "src/app.js", name: "isPlainObj", re: /^\s*function\s+isPlainObj\b/m },
  { file: "src/app.js", name: "cleanMap", re: /^\s*function\s+cleanMap\b/m },
  { file: "src/app.js", name: "idList", re: /^\s*function\s+idList\b/m },
  { file: "src/app.js", name: "cleanSaved", re: /^\s*function\s+cleanSaved\b/m },
  // one person-hue rule for the viewer and the wizard
  { file: "src/app.js", name: "HUES", re: /^\s*const\s+HUES\s*=/m },
  { file: "src/setup.js", name: "HUES", re: /^\s*const\s+HUES\s*=/m },
];

test("no consumer redeclares a shared constant/helper (single source of truth)", () => {
  for (const { file, name, re } of NO_LOCAL_DECL) {
    assert.ok(
      !re.test(read(file)),
      `${file} still declares its own ${name} — it must consume src/shared-core.js ` +
        `instead. The extraction regressed; remove the local copy.`
    );
  }
});

test("every consumer wires up src/shared-core.js", () => {
  assert.ok(/GCAShared/.test(read("src/app.js")), "src/app.js must destructure GCAShared");
  assert.ok(/GCAShared/.test(read("src/setup.js")), "src/setup.js must destructure GCAShared");
  assert.ok(/require\(["']\.\.\/src\/shared-core\.js["']\)/.test(read("scripts/build-core.js")),
    "scripts/build-core.js must require ../src/shared-core.js");
  assert.ok(/src\/shared-core\.js/.test(read("index.html")), "index.html must load src/shared-core.js");
  assert.ok(/src\/shared-core\.js/.test(read("setup.html")), "setup.html must load src/shared-core.js");
});

/* ---- "User N" labels (viewer and wizard share one rule) ---------------- */

test("userLabels numbers senders by message count, ties by who posted first, then quiet members", () => {
  const conv = {
    participants: ["9", "1", "8"],
    msgs: [
      { s: "3", t: 1 }, { s: "1", t: 2, r: [{ s: "7", k: "like" }, { s: "8", k: "like" }] },
      { s: "2", t: 3 }, { s: "1", t: 4 }, { s: "2", t: 5 }, { s: "4", t: 6 },
    ],
    events: [{ type: "join", ids: ["6", "7"], s: "5" }],
  };
  // 1 and 2 post twice (1 first), then 3 and 4 once (3 first); quiet: roster
  // 9, 8; reactions 7; events 6, then the event's initiator 5
  assert.deepStrictEqual(shared.userLabels(conv), {
    1: "User 1", 2: "User 2", 3: "User 3", 4: "User 4", 9: "User 5", 8: "User 6", 7: "User 7", 6: "User 8", 5: "User 9",
  });
});

test("userLabels leaves ignored people out, with the reactions on their messages", () => {
  const conv = {
    participants: [],
    msgs: [{ s: "1", t: 1, r: [{ s: "5", k: "like" }] }, { s: "1", t: 2 }, { s: "2", t: 3 }, { s: "3", t: 4, r: [{ s: "6", k: "like" }] }],
    events: [{ type: "leave", ids: ["1"] }],
  };
  assert.deepStrictEqual(shared.userLabels(conv, ["1"]), { 2: "User 1", 3: "User 2", 6: "User 3" });
  assert.deepStrictEqual(shared.userLabels(conv, new Set(["1"])), { 2: "User 1", 3: "User 2", 6: "User 3" });
});

test("createUserNumbering streamed message by message gives the same labels", () => {
  const conv = { participants: ["4"], msgs: [{ s: "2" }, { s: "1" }, { s: "1", r: [{ s: "3" }] }], events: [] };
  const n = shared.createUserNumbering([]);
  for (const m of conv.msgs) n.message(m);
  n.conversation(conv);
  assert.deepStrictEqual(n.result(), shared.userLabels(conv));
  assert.deepStrictEqual(n.result(), { 1: "User 1", 2: "User 2", 4: "User 3", 3: "User 4" });
});
