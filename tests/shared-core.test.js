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
  assert.ok(/src\/shared-core\.js/.test(read("src/setup.html")), "src/setup.html must load src/shared-core.js");
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

/* ---- Word Battles keys and text counts ------------------------------------ */

// A variation selector (U+FE0F, the invisible tail of ❤️ ☺️ ✔️) is not a
// word: it used to come out of tokenize as a token of its own, so every red
// heart in a chat was counted as one shared invisible "word".
test("tokenize never yields a token made only of combining marks", () => {
  assert.deepStrictEqual(shared.tokenize("I \u2764\uFE0F you"), ["i", "you"]);
  assert.deepStrictEqual(shared.tokenize("\u263A\uFE0F ok"), ["ok"]);
  assert.deepStrictEqual(shared.tokenize("caf\u0065\u0301 na\u00EFve"), ["caf\u0065\u0301", "na\u00EFve"]);
});

// Words are keyed by their whole-word tokens; anything with an emoji in it, or
// with no letters or digits at all, is keyed by its text (lowercased, U+FE0F
// dropped) so ❤️ and ❤ are one word and ❤️ and ☺️ are two.
test("battleKey keys words by tokens and emoji or symbols by their text", () => {
  const k = shared.battleKey;
  assert.equal(k("LOL!"), "lol");
  assert.equal(k("so  Literally"), "so literally");
  assert.equal(k("\u2764\uFE0F"), k("\u2764"));
  assert.notEqual(k("\u2764\uFE0F"), k("\u263A\uFE0F"));
  assert.equal(k("LOL \u{1F602}"), "lol \u{1F602}");
  assert.equal(k(" ?! "), "?!");
  assert.deepStrictEqual(shared.cleanBattleWords(["\u2764\uFE0F", "\u2764", "\u263A\uFE0F", "Lol \u{1F602}", "lol \u{1F602}"]),
    ["\u2764\uFE0F", "\u263A\uFE0F", "Lol \u{1F602}"]);
});

test("countTextKey counts a text-keyed word where it appears, outside links", () => {
  const c = (text, word) => shared.countTextKey(text, shared.battleKey(word));
  assert.equal(c("I \u2764\uFE0F you \u2764", "\u2764\uFE0F"), 2);
  assert.equal(c("\u263A\uFE0F", "\u2764\uFE0F"), 0);
  assert.equal(c("LOL \u{1F602} and lol \u{1F602}", "lol \u{1F602}"), 2);
  assert.equal(c("lol", "lol \u{1F602}"), 0);
  assert.equal(c("see https://x.com/s?a=1 ok?", "?"), 1);
  assert.equal(c("", "?"), 0);
});

// A keycap (1, U+FE0F, U+20E3) is the digit it shows: it used to be a "word"
// of its own (1 + the two invisible characters) that counted toward words per
// message, distinct words and the word cloud, and an added 1-keycap and the
// same keycap typed without U+FE0F were two Battles words.
test("a keycap or a variation selector after a letter is not part of the word", () => {
  const KC1 = "1\uFE0F\u20E3", KC1_BARE = "1\u20E3", HASH = "#\uFE0F\u20E3";
  for (const tok of [shared.tokenize, shared.tokenizeNoSegmenter]) {
    assert.deepStrictEqual(tok(KC1 + " go"), ["1", "go"]);
    assert.deepStrictEqual(tok("\u2139\uFE0F info"), ["\u2139", "info"]);
    assert.deepStrictEqual(tok(HASH + " ok"), ["ok"]);
  }
  assert.equal(shared.isCloudWord(shared.tokenize(KC1)[0]), false);
  assert.equal(shared.battleKey(KC1), shared.battleKey(KC1_BARE));
  assert.equal(shared.battleKey(HASH), shared.battleKey("#\u20E3"));
  assert.deepStrictEqual(shared.cleanBattleWords([KC1, KC1_BARE]), [KC1]);
  // the prefilter still lets through a text whose word only forms once the
  // invisible characters are gone
  const two = KC1 + "2\uFE0F\u20E3";
  assert.equal(shared.countWord(two, "12"), 1);
  assert.equal(shared.mayContainKey(two.toLowerCase(), "12"), true);
});

// An added keycap is that keycap, with or without U+FE0F: it used to be keyed
// as its bare digit or symbol, so the keycap # counted every # and hashtag,
// and the keycap 1 every standalone 1.
test("an added keycap counts keycaps only", () => {
  const c = (text, word) => shared.countQuery(text, shared.wordQuery(word));
  const HASH = "#️⃣", ONE = "1️⃣", TWO = "2️⃣", STAR = "*️⃣";
  assert.equal(c("# #tbt " + HASH + " #⃣", HASH), 2);
  assert.equal(c("1 sec, 1st " + ONE + " 1⃣", ONE), 2);
  assert.equal(c(STAR + " *fixed", STAR), 1);
  assert.equal(c(ONE + TWO, TWO), 1);
  assert.equal(shared.wordQuery(ONE).byText, true);
  assert.equal(shared.battleKey(ONE), shared.battleKey("1⃣"));
  assert.notEqual(shared.battleKey(ONE), shared.battleKey("1"));
  assert.deepStrictEqual(shared.cleanBattleWords([ONE, "1⃣", "1"]), [ONE, "1"]);
});

// A text-keyed word that starts or ends with a letter or digit counts only
// as whole words there: "ok <thumbs up>" is not inside "book <thumbs up>",
// as "man" is never inside "many".
test("countTextKey keeps word boundaries at a letter or digit end", () => {
  const c = (text, word) => shared.countTextKey(text, shared.battleKey(word));
  const UP = "\u{1F44D}", JOY = "\u{1F602}";
  assert.equal(c("book " + UP + " tiktok " + UP, "ok " + UP), 0);
  assert.equal(c("ok " + UP + " and OK " + UP, "ok " + UP), 2);
  assert.equal(c("trollol " + JOY, "lol " + JOY), 0);
  assert.equal(c(JOY + " lollipop", JOY + " lol"), 0);
  assert.equal(c(JOY + " lol!", JOY + " lol"), 1);
  assert.equal(c(JOY + " e\u0301", JOY + " e"), 0);   // a combining mark continues the word
  assert.equal(c("2" + JOY + "2", JOY), 1);   // an emoji end needs no word boundary
});

// A flag is two regional-indicator letters; the US flag must not be found
// across Australia + Sweden (A U | S E), and an emoji counts only whole: a
// thumbs up is not inside a skin-toned thumbs up, nor a heart inside the
// heart on fire.
test("countTextKey matches whole emoji, never across or inside one", () => {
  const c = (text, word) => shared.countTextKey(text, shared.battleKey(word));
  const ri = (a, b) => String.fromCodePoint(0x1F1E6 + a.charCodeAt(0) - 65, 0x1F1E6 + b.charCodeAt(0) - 65);
  const US = ri("U", "S"), AU = ri("A", "U"), SE = ri("S", "E");
  assert.equal(c(AU + SE, US), 0);
  assert.equal(c(US + US + " " + AU + US, US), 3);
  const UP = "\u{1F44D}", TONE = "\u{1F3FD}", HEART = "\u2764\uFE0F", FIRE = "\u2764\uFE0F\u200D\u{1F525}";
  assert.equal(c(UP + TONE + " " + UP, UP), 1);
  assert.equal(c(UP + TONE + " " + UP, UP + TONE), 1);
  assert.equal(c(FIRE + " " + HEART, HEART), 1);
  assert.equal(c(FIRE + " \u2764\u200D\u{1F525}", FIRE), 2);
});

// An emoticon is its text, not the letter or digit in it: "<3" used to be the
// word "3" (every "3" counted, and "<3" and "3" were one word), ":D" the word
// "d". A symbol before the first word or between words makes the whole thing
// text; punctuation after the last word does not ("lol!" is still lol).
test("battleKey keeps an emoticon or a word led by a symbol as its text", () => {
  const k = shared.battleKey;
  assert.equal(k("<3"), "<3");
  assert.equal(k(":D"), ":d");
  assert.equal(k("\u00BFQu\u00E9"), "\u00BFqu\u00E9");
  assert.equal(k("so, literally"), "so, literally");
  assert.equal(k("USA \u{1F1FA}\u{1F1F8}"), "usa \u{1F1FA}\u{1F1F8}");   // a flag is an emoji too
  for (const [w, key] of [["lol!", "lol"], ["wtf?!", "wtf"], ["don't", "dont"], ["Don\u2019t", "dont"], ["so  Literally", "so literally"]]) assert.equal(k(w), key, w);
  assert.deepStrictEqual(shared.cleanBattleWords(["<3", "3", ":D", "d"]), ["<3", "3", ":D", "d"]);
  const c = (text, word) => shared.countTextKey(text, k(word));
  assert.equal(c("i <3 u, 3 cats, <33", "<3"), 1);
  assert.equal(c("xD :D :Dd", ":D"), 1);
});

// The Battles loop skips a message whose lowercased text cannot hold the word
// before counting it. For a word counted by its text the probe used to be its
// first character, so "lol" plus an emoji probed for "l" and let nearly every
// message through. It is now the first emoji, or else the longest run without
// a space, and it never skips a message that would count.
test("wordQuery probes with the emoji or the longest run, and never skips a match", () => {
  const JOY = "\u{1F602}", KC = (d) => d + "\uFE0F\u20E3";
  const q = shared.wordQuery;
  assert.equal(q("lol " + JOY).probe, JOY);
  assert.equal(q(JOY + " lol").probe, JOY);
  assert.equal(q(":D").probe, ":d");
  assert.equal(q("so, literally").probe, "literally");
  assert.deepStrictEqual([q("Lol!").byText, q("Lol!").probe, q("<3").byText], [false, "lol", true]);
  // the information-source emoji is a letter too: counted by text with or without U+FE0F
  assert.deepStrictEqual([q("\u2139").byText, q("\u2139").key], [true, q("\u2139\uFE0F").key]);
  assert.equal(shared.queryMayMatch("lol only", q("lol " + JOY)), false);
  const words = ["lol " + JOY, JOY, ":D", "<3", "#x", "12", "so, literally", "\u2764\uFE0F", "ok " + JOY, "?!"];
  const texts = ["LOL " + JOY + " ok", "trollol " + JOY, "xD :D", "i <3 u", "#\uFE0F\u20E3x", KC("1") + KC("2"),
    "so, literally", "I \u2764 u", "OK " + JOY, "wait?!", "see https://x.com/?! ok?!"];
  for (const w of words) for (const t of texts) {
    const wq = q(w);
    if (shared.countQuery(t, wq) > 0) assert.ok(shared.queryMayMatch(t.toLowerCase(), wq), JSON.stringify([w, t]));
  }
  assert.equal(shared.countQuery("#\uFE0F\u20E3x #x", q("#x")), 1);   // a keycap # is not a #
  assert.equal(shared.countQuery(KC("1") + KC("2"), q("12")), 1);
});

// countTextKey only segments a message into graphemes when the characters
// beside a hit do not settle it; it must agree with always segmenting.
test("countTextKey agrees with a full grapheme split on mixed text", () => {
  const POOL = ["a", "b", "1", " ", "!", "<", "3", ":", "d", "\u0301", "\u093F", "\u0915", "\u094D", "\u200D", "\u200C",
    "\u{1F602}", "\u{1F44D}", "\u{1F3FD}", "\u2764", "\uFE0F", "\u{1F525}", "\u{1F1FA}", "\u{1F1F8}", "\u{1F1E6}",
    "\u1100", "\u1161", "\uAC00", "\u0600", "\u0E33", "\u0E01", "\uFF76", "\uFF9E", "\u{E0067}", "\u20E3", "#"];
  const KEYS = ["\u{1F602}", "a \u{1F602}", "\u{1F602} a", "\u{1F44D}", "\u{1F44D}\u{1F3FD}", "\u{1F1FA}\u{1F1F8}", "<3", ":d",
    "\u2764", "\u2764\u200D\u{1F525}", "!", "\u0915", "\u0600", "\u0301", "\u200D", "\uAC00", "\u1161", "#"];
  const ref = (text, key) => {
    const s = shared.plainText(text).replace(/[\uFE0E\uFE0F]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
    const b = new Set([0]); let p = 0;
    for (const g of shared.graphemes(s)) b.add(p += g.length);
    const L = /^[\p{L}\p{N}]/u.test(key), R = /[\p{L}\p{N}]$/u.test(key), W = /(?!\u20E3)[\p{L}\p{N}\p{M}\u200C\u200D]/u;
    let n = 0;
    for (let at = s.indexOf(key); at !== -1;) {
      const end = at + key.length;
      const ok = b.has(at) && b.has(end) && !(L && at > 0 && W.test(String.fromCodePoint(s.codePointAt(at - 1 - (/[\uDC00-\uDFFF]/.test(s[at - 1]) ? 1 : 0)))))
        && !(R && end < s.length && W.test(String.fromCodePoint(s.codePointAt(end))));
      if (ok) n++;
      at = s.indexOf(key, ok ? end : at + 1);
    }
    return n;
  };
  let seed = 7;
  const rnd = (n) => (seed = (seed * 48271) % 2147483647) % n;
  for (let i = 0; i < 4000; i++) {
    let t = "";
    for (let k = 0, len = 1 + rnd(12); k < len; k++) t += POOL[rnd(POOL.length)];
    for (const key of KEYS) assert.equal(shared.countTextKey(t, key), ref(t, key), JSON.stringify([t, key]));
  }
});

// A word of only invisible characters has nothing to count: a lone ZWJ used to
// be kept and counted inside every ZWJ emoji, a lone U+FE0F dropped silently.
test("a word of only invisible characters has an empty key and is dropped", () => {
  for (const w of ["\u200D", "\u200C", "\uFE0F", "\u20E3", "\u200B\u2060\uFEFF", " \u200D\uFE0F "]) {
    assert.equal(shared.battleKey(w), "", JSON.stringify(w));
    assert.equal(shared.wordQuery(w).key, "", JSON.stringify(w));
  }
  assert.deepStrictEqual(shared.cleanBattleWords(["\u200D", "\uFE0F", "\u200B\u2060", "ok", "\u2764\u200D\u{1F525}"]), ["ok", "\u2764\u200D\u{1F525}"]);
});

// U+FE0E asks for the text style of an emoji (a plain heart): it is the same
// heart, and as invisible as U+FE0F. A text-style heart did not count toward
// an added heart, a lone U+FE0E was a word, and "ok" + U+FE0E was not "ok".
test("the text-style selector U+FE0E is dropped like U+FE0F", () => {
  const c = (text, word) => shared.countQuery(text, shared.wordQuery(word));
  assert.equal(c("I \u2764\uFE0E you \u2764\uFE0F \u2764", "\u2764\uFE0F"), 3);
  assert.equal(c("\u263A\uFE0E", "\u263A\uFE0F"), 1);
  assert.equal(shared.battleKey("\u2764\uFE0E"), shared.battleKey("\u2764\uFE0F"));
  assert.equal(shared.battleKey("\uFE0E"), "");
  for (const tok of [shared.tokenize, shared.tokenizeNoSegmenter]) assert.deepStrictEqual(tok("ok\uFE0E go"), ["ok", "go"]);
  assert.equal(shared.countWord("ok\uFE0E", "ok"), 1);
  const smile = shared.wordQuery(":D");
  assert.equal(shared.countQuery(":\uFE0ED", smile), 1);
  assert.equal(shared.queryMayMatch(":\uFE0Ed", smile), true);
});
