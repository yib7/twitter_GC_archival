// SP10: the pure helpers behind the one share-card renderer (src/app.js
// drawShareCard): grapheme splitting, canvas text wrapping and name
// redaction. DOM-free, so the rules are pinned here; the e2e spec
// (tests/share-card.spec.js) checks what the canvas actually draws.

require("./_real-data-guard.js");   // QA-2: refuse to run outside a clean checkout
const test = require("node:test");
const assert = require("node:assert");

const { graphemes, graphemesNoSegmenter, wrapText, createRedactor } = require("../src/shared-core.js");

// A fake monospace measure: every grapheme is 10 units wide.
const mono = (s) => graphemes(s).length * 10;

test("graphemes keeps emoji sequences, flags and combining marks whole", () => {
  assert.deepStrictEqual(graphemes("a👨‍👩‍👧b"), ["a", "👨‍👩‍👧", "b"]);
  assert.deepStrictEqual(graphemes("🇺🇸👍🏽"), ["🇺🇸", "👍🏽"]);
  assert.deepStrictEqual(graphemes("éx"), ["é", "x"]);
  assert.deepStrictEqual(graphemes(""), []);
  // the no-Intl.Segmenter fallback agrees
  for (const s of ["a👨‍👩‍👧b", "🇺🇸👍🏽", "éx", "1️⃣ ok"]) assert.deepStrictEqual(graphemesNoSegmenter(s), graphemes(s), s);
});

test("wrapText breaks at spaces and keeps every word whole when it fits", () => {
  const r = wrapText("the quick brown fox jumps", 100, mono);
  assert.deepStrictEqual(r.lines, ["the quick", "brown fox", "jumps"]);
  assert.strictEqual(r.truncated, false);
});

test("wrapText keeps the message's own line breaks", () => {
  assert.deepStrictEqual(wrapText("one\ntwo three", 200, mono).lines, ["one", "two three"]);
  assert.deepStrictEqual(wrapText("a\r\n\r\nb", 200, mono).lines, ["a", "", "b"]);
});

test("wrapText splits an over-long word between graphemes, never inside an emoji", () => {
  const r = wrapText("👨‍👩‍👧👨‍👩‍👧👨‍👩‍👧👨‍👩‍👧👨‍👩‍👧", 30, mono);
  assert.deepStrictEqual(r.lines, ["👨‍👩‍👧👨‍👩‍👧👨‍👩‍👧", "👨‍👩‍👧👨‍👩‍👧"]);
  for (const ln of r.lines) for (const g of graphemes(ln)) assert.strictEqual(g, "👨‍👩‍👧");
});

test("wrapText ends with an ellipsis when it runs past maxLines", () => {
  const r = wrapText("aaaa bbbb cccc dddd", 40, mono, { maxLines: 2 });
  assert.strictEqual(r.truncated, true);
  assert.strictEqual(r.lines.length, 2);
  assert.strictEqual(r.lines[0], "aaaa");
  assert.ok(r.lines[1].endsWith("…"), r.lines[1]);
  assert.ok(mono(r.lines[1]) <= 40);
});

const PEOPLE = [
  { id: "u1", names: ["Alex Rivera", "Al", "User 1"] },
  { id: "u2", names: ["José", "User 2"] },
  { id: "u3", names: ["Sam", "User 3"] },
];

test("createRedactor labels people Person A, B, C in order of first appearance", () => {
  const r = createRedactor(PEOPLE);
  assert.strictEqual(r.label("u3"), "Person A");
  assert.strictEqual(r.label("u1"), "Person B");
  assert.strictEqual(r.label("u3"), "Person A");
  assert.strictEqual(r.label("u2"), "Person C");
});

test("createRedactor removes every name, alias and word of a name from text", () => {
  const r = createRedactor(PEOPLE);
  r.label("u1");
  const out = r.text("ask alex rivera, or Alex, or AL — José and jose and Sam's dog; User 3 too");
  for (const n of ["alex", "rivera", "josé", "jose", "sam", "user 3"]) assert.ok(!out.toLowerCase().includes(n), n + " in " + out);
  assert.ok(!/\bal\b/i.test(out), out);
  assert.match(out, /Person A/);   // u1, labelled first
  assert.match(out, /Person B/);   // José, first met in the text
  assert.match(out, /Person C's dog/);
});

test("createRedactor never touches a name inside another word", () => {
  const r = createRedactor(PEOPLE);
  assert.strictEqual(r.text("Salami and also a samovar"), "Salami and also a samovar");
});

test("createRedactor replaces every @handle mention, known or not", () => {
  const r = createRedactor(PEOPLE);
  const out = r.text("cc @alex_r and @someone_else, mail me@example.test");
  assert.ok(!/@alex_r|@someone_else/.test(out), out);
  assert.match(out, /me@example\.test/);   // an email is not a mention
});

test("createRedactor: generic 'User N' labels only redact as a whole, not the word 'user'", () => {
  const r = createRedactor(PEOPLE);
  const out = r.text("the user said User 2 was right");
  assert.match(out, /^the user said Person A was right$/);
});
