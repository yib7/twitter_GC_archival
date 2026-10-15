// the pure helpers behind the one share-card renderer (src/app.js
// drawShareCard): grapheme splitting, canvas text wrapping and name
// redaction. DOM-free, so the rules are pinned here; the e2e spec
// (tests/share-card.spec.js) checks what the canvas actually draws.

require("./_real-data-guard.js");   // refuse to run outside a clean checkout
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

// probes that leaked through "Hide names". Over-redaction is the
// safe direction for a shared image, so scripts written without spaces (or
// with attached particles / prefixes) match without word boundaries.
const leaks = (people, text, names) => {
  const out = createRedactor(people).text(text);
  for (const n of names) assert.ok(!out.includes(n), JSON.stringify(n) + " leaked in " + JSON.stringify(out));
  assert.match(out, /Person A/, out);
  return out;
};

test("redaction: a Korean name with an attached particle (민수는)", () => {
  assert.strictEqual(leaks([{ id: "k", names: ["민수"] }], "민수는 갔어", ["민수"]), "Person A는 갔어");
});

test("redaction: Hebrew and Arabic names behind a one-letter prefix", () => {
  leaks([{ id: "h", names: ["דני"] }], "ולדני", ["דני"]);
  leaks([{ id: "a", names: ["محمد"] }], "ومحمد", ["محمد"]);
  // harakat on the name in the text are marks: still the same name
  leaks([{ id: "a", names: ["محمد"] }], "قال مُحَمَّد", ["مُحَمَّد", "محمد"]);
});

test("redaction: Chinese and Japanese names inside unspaced text", () => {
  leaks([{ id: "c", names: ["李小龙"] }], "李小龙说你好", ["李小龙"]);
  leaks([{ id: "j", names: ["さくら"] }], "さくらちゃん", ["さくら"]);
  leaks([{ id: "j", names: ["サクラ"] }], "サクラさん来た", ["サクラ"]);
});

test("redaction: two-letter words of a multi-word name", () => {
  assert.strictEqual(leaks([{ id: "q", names: ["Jo Quill"] }], "Jo said hi", ["Jo"]), "Person A said hi");
  leaks([{ id: "d", names: ["Don Li"] }], "ask Li tomorrow", ["Li"]);
  // still whole words only
  assert.strictEqual(createRedactor([{ id: "q", names: ["Jo Quill"] }]).text("a joke"), "a joke");
});

test("redaction: curly and straight apostrophes are the same name", () => {
  leaks([{ id: "o", names: ["O'Brien"] }], "O’Brien called", ["O’Brien", "Brien"]);
  leaks([{ id: "o", names: ["O’Brien"] }], "O'Brien called", ["O'Brien", "Brien"]);
});

test("redaction: Turkish dotted capitals and other case/mark folds", () => {
  // "İ".toLowerCase() is "i̇" (i + U+0307) and the regex `i` flag does not
  // fold İ at all, so names are compared on a locale-free fold: NFD, marks
  // dropped, then lower case (İ → I → i).
  leaks([{ id: "t", names: ["İsmail"] }], "İSMAİL geldi", ["İSMAİL", "SMA"]);
  leaks([{ id: "t", names: ["İsmail"] }], "ismail geldi", ["ismail"]);
  leaks([{ id: "t", names: ["Ismail"] }], "İsmail geldi", ["İsmail", "smail"]);
  leaks([{ id: "g", names: ["Νίκος"] }], "ΝΙΚΟΣ ήρθε", ["ΝΙΚΟΣ"]);   // final sigma
  leaks([{ id: "s", names: ["Strauß"] }], "STRAUSS hier", ["STRAUSS"]);
  // a decomposed accent in the text goes with the name it sits on
  assert.strictEqual(createRedactor([{ id: "x", names: ["José"] }]).text("Jose\u0301!"), "Person A!");
});

test("redaction: a stopword word of a name is redacted only when written like a name", () => {
  const r = createRedactor([{ id: "w", names: ["Will Day"] }]);
  assert.strictEqual(r.text("will he?"), "will he?");
  assert.strictEqual(r.text("Will said hi"), "Person A said hi");
  assert.strictEqual(r.text("WILL DAY"), "Person A");
  assert.strictEqual(r.text("a long day"), "a long Person A");   // over-redaction is the safe side
});

test("redaction: an @mention with non-ASCII letters is replaced whole", () => {
  const r = createRedactor([{ id: "j", names: ["José"] }, { id: "k", names: ["민수"] }]);
  const cases = [
    ["@José hi", "@someone hi", ["Jos", "é"]],
    ["@Jürgen", "@someone", ["J", "ürgen", "ü"]],
    ["@민수", "@someone", ["민", "수"]],
    ["@Zoë_99", "@someone", ["Zo", "ë", "_99"]],
    ["@Zoë ok", "@someone ok", ["Zo", "̈"]],          // a decomposed ë: the mark goes too
  ];
  for (const [input, want, pieces] of cases) {
    const out = r.text(input);
    assert.strictEqual(out, want, input);
    assert.ok([...out].every((c) => c.charCodeAt(0) < 128), "non-ASCII leftover in " + JSON.stringify(out));
    for (const p of pieces) assert.ok(!out.includes(p) || want.includes(p), JSON.stringify(p) + " left in " + JSON.stringify(out));
  }
  // an email is not a mention and stays; a name glued after a word's "@"
  // (not a mention) is still caught by the name pass
  assert.strictEqual(r.text("mail a@b.com today"), "mail a@b.com today");
  assert.strictEqual(r.text("x@José"), "x@Person A");
});

test("wrapText stops measuring once it is past maxLines (a 100k-char unbroken word)", () => {
  let calls = 0;
  const measure = (s) => { calls++; return mono(s); };
  const t0 = Date.now();
  const r = wrapText("x".repeat(100000) + " tail", 100, measure, { maxLines: 3 });
  const ms = Date.now() - t0;
  assert.strictEqual(r.lines.length, 3);
  assert.strictEqual(r.truncated, true);
  assert.ok(r.lines[2].endsWith("…"), r.lines[2]);
  assert.ok(calls < 200, "measure calls: " + calls);
  assert.ok(ms < 1000, "took " + ms + " ms");
  // many short paragraphs stop early too
  calls = 0;
  assert.strictEqual(wrapText("a\n".repeat(50000), 100, measure, { maxLines: 2 }).lines.length, 2);
  assert.ok(calls < 50, "measure calls: " + calls);
});
