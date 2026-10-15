// GCAShared.parseSearchQuery(input, { clock }) is the ONE
// parser behind Search, the command palette's message hits and the operator
// chips. Pure and DOM-free. It splits the box into search text (words and
// "quoted phrases"), -exclusions and operators (from:/sender:, before:/after:,
// has:, is:), with each token's [start, end) offsets so a chip can be removed
// from the query text it came from.
//
// resolvePeople(value, people, { open }) matches a from: value against
// participants' names (display name + aliases); removeSearchToken /
// replaceSearchToken edit the query text for the chips and the autocomplete.

require("./_real-data-guard.js");   // refuse to run outside a clean checkout
const test = require("node:test");
const assert = require("node:assert");

const { parseSearchQuery, resolvePeople, rankPeople, removeSearchToken, replaceSearchToken, quoteOpValue, createZoneClock } = require("../src/shared-core.js");

const UTC = createZoneClock("UTC");
const P = (s) => parseSearchQuery(s, { clock: UTC });
const ops = (s) => P(s).ops.map((o) => [o.key, o.value, !!o.open, !!o.pending]);

test("plain words and quoted phrases become lowercased needles, phrases first", () => {
  const q = P('Movie "Late Night" pizza');
  assert.deepStrictEqual(q.phrases, ["late night"]);
  assert.deepStrictEqual(q.words, ["movie", "pizza"]);
  assert.deepStrictEqual(q.needles, ["late night", "movie", "pizza"]);
  assert.deepStrictEqual(q.ops, []);
  assert.deepStrictEqual(P("   ").needles, []);
  assert.deepStrictEqual(P('""').needles, []);
});

test("an unclosed quote is a phrase to the end of the box (still typing)", () => {
  const q = P('pizza "movie ni');
  assert.deepStrictEqual(q.phrases, ["movie ni"]);
  assert.deepStrictEqual(q.words, ["pizza"]);
  assert.ok(!q.needles.some((n) => n.indexOf('"') >= 0));
});

test("from: applies at the END of the input — no trailing space needed", () => {
  assert.deepStrictEqual(ops("from:bob"), [["from", "bob", true, false]]);
  assert.deepStrictEqual(ops("from:bob "), [["from", "bob", false, false]]);
  assert.deepStrictEqual(ops("hi from:bob there"), [["from", "bob", false, false]]);
  assert.deepStrictEqual(P("hi from:bob there").words, ["hi", "there"]);
  assert.deepStrictEqual(ops("sender:bob"), [["from", "bob", true, false]]);
  assert.deepStrictEqual(ops("FROM:Bob"), [["from", "Bob", true, false]]);
});

test("Unicode and punctuated names are whole values", () => {
  assert.deepStrictEqual(ops("from:josé"), [["from", "josé", true, false]]);
  assert.deepStrictEqual(ops("from:mary-jane hi"), [["from", "mary-jane", false, false]]);
  assert.deepStrictEqual(ops("from:Дмитрий"), [["from", "Дмитрий", true, false]]);
  assert.deepStrictEqual(ops("from:o'brien"), [["from", "o'brien", true, false]]);
  assert.deepStrictEqual(ops("from:bob, hi"), [["from", "bob", false, false]]);
});

test("quoted names may hold spaces; an unclosed quote at the end stays open", () => {
  assert.deepStrictEqual(ops('from:"Ana María" pizza'), [["from", "Ana María", false, false]]);
  assert.deepStrictEqual(P('from:"Ana María" pizza').words, ["pizza"]);
  assert.deepStrictEqual(ops('from:"Ana María"'), [["from", "Ana María", false, false]]);
  assert.deepStrictEqual(ops('from:"Ana Ma'), [["from", "Ana Ma", true, false]]);
});

test("an empty operator value at the end is pending; a bounded one is plain text", () => {
  assert.deepStrictEqual(ops("from:"), [["from", "", true, true]]);
  assert.deepStrictEqual(P("from:").needles, []);
  assert.deepStrictEqual(ops("pizza has:"), [["has", "", true, true]]);
  // bounded (something follows): the word is literal text, never swallowed
  assert.deepStrictEqual(ops("pizza has: x"), []);
  assert.deepStrictEqual(P("pizza has: x").needles, ["pizza", "has:", "x"]);
  assert.deepStrictEqual(P("before: lunch").words, ["before:", "lunch"]);
  assert.deepStrictEqual(P("before: lunch").ops, []);
  assert.deepStrictEqual(P("from: ann").words, ["from:", "ann"]);
  assert.deepStrictEqual(P("Note from: Bob").words, ["note", "from:", "bob"]);
  assert.deepStrictEqual(P("Note from: Bob").ops, []);
  assert.deepStrictEqual(P("is: pinned").words, ["is:", "pinned"]);
  assert.deepStrictEqual(P("from:, then").words, ["from:,", "then"]);   // only punctuation: empty too
  assert.deepStrictEqual(P('from:"" x').ops, []);
});

test("-exclusions are Unicode-aware, quoted ones may hold spaces", () => {
  const q = P('pizza -café -"movie night" -mary-jane');
  assert.deepStrictEqual(q.excludes, ["café", "movie night", "mary-jane"]);
  assert.deepStrictEqual(q.needles, ["pizza"]);
  assert.deepStrictEqual(q.ops.map((o) => [o.key, o.value]), [["not", "café"], ["not", "movie night"], ["not", "mary-jane"]]);
  // a lone dash or punctuation after it is just text
  assert.deepStrictEqual(P("a - b").excludes, []);
  assert.deepStrictEqual(P("a - b").words, ["a", "-", "b"]);
  assert.deepStrictEqual(P("wait -)").excludes, []);
});

test("unknown operators and unknown values stay search text", () => {
  assert.deepStrictEqual(P("foo:bar").words, ["foo:bar"]);
  assert.deepStrictEqual(P("foo:bar").ops, []);
  assert.deepStrictEqual(P("https://example.com/x").words, ["https://example.com/x"]);
  assert.deepStrictEqual(P("has:cats ").words, ["has:cats"]);
  assert.deepStrictEqual(P("is:fun ").words, ["is:fun"]);
  assert.deepStrictEqual(P("before:soon ").words, ["before:soon"]);
});

test("has: photo | video | link | file (+ the older media / links / reacts) and is:pinned", () => {
  const map = { "has:photo": "photo", "has:photos": "photo", "has:image": "photo", "has:video": "video", "has:videos": "video",
    "has:link": "link", "has:links": "link", "has:file": "file", "has:files": "file", "has:media": "media",
    "has:reacts": "reacts", "has:reactions": "reacts", "HAS:Photo": "photo" };
  for (const [s, v] of Object.entries(map)) assert.deepStrictEqual(ops(s + " "), [["has", v, false, false]], s);
  assert.deepStrictEqual(ops("is:pinned"), [["is", "pinned", true, false]]);
  assert.deepStrictEqual(ops("is:bookmarked "), [["is", "pinned", false, false]]);
});

test("a half-typed has:/is: value at the end is pending, not a search for 'has:ph'", () => {
  assert.deepStrictEqual(ops("has:ph"), [["has", "ph", true, true]]);
  assert.deepStrictEqual(P("has:ph").needles, []);
  assert.deepStrictEqual(ops("is:pin"), [["is", "pin", true, true]]);
  // …but bounded, an unknown value is text again
  assert.deepStrictEqual(P("has:ph ").words, ["has:ph"]);
});

test("before:/after: go through parseJumpDate (inclusive bounds in the clock's zone)", () => {
  const [a] = P("after:2024-01-07").ops;
  assert.strictEqual(a.key, "after");
  assert.strictEqual(a.date.start, Date.parse("2024-01-07T00:00:00Z"));
  const [b] = P('before:"March 2024" x').ops;
  assert.strictEqual(b.key, "before");
  assert.strictEqual(b.date.end, Date.parse("2024-04-01T00:00:00Z"));
  assert.strictEqual(b.date.label, "March 2024");
  const NY = createZoneClock("America/New_York");
  assert.strictEqual(parseSearchQuery("after:2024-01-01", { clock: NY }).ops[0].date.start, Date.parse("2024-01-01T05:00:00Z"));
  // dates that don't exist are dropped with a reason, not rolled over
  const [bad] = P("before:2024-01-32 x").ops;
  assert.strictEqual(bad.error, "invalid");
  assert.strictEqual(P("after:13/01/2024 ").ops[0].error, "order");
  assert.deepStrictEqual(P("before:2024-01-32 ").needles, []);
  // a half-typed date at the end is pending; bounded non-dates stay text
  assert.deepStrictEqual(ops("after:2021-"), [["after", "2021-", true, true]]);
  assert.deepStrictEqual(P("after:2021-").needles, []);
  assert.deepStrictEqual(P("after:hello ").words, ["after:hello"]);
});

test("a date still being typed never flashes an error; a finished bad one does", () => {
  // open + starts with a digit: pending, no error (2023-0 -> 2023-06 next keystroke)
  for (const q of ["before:2023-0", "after:2024-13", "after:13/01/2024", "before:2024-01-32"]) {
    const [o] = P(q).ops;
    assert.strictEqual(o.pending, true, q);
    assert.strictEqual(o.error, undefined, q);
    assert.deepStrictEqual(P(q).needles, [], q);
  }
  // bounded: the error stands (the UI notes it)
  assert.strictEqual(P("before:2023-0 ").ops[0].error, "invalid");
  assert.strictEqual(P("after:13/01/2024 pizza").ops[0].error, "order");
  // an open quoted date that is wrong is still being typed too
  assert.strictEqual(P('before:"2023-0').ops[0].pending, true);
  // open but not digit-led: a word-form date that parses is applied, nonsense stays text
  assert.strictEqual(P("after:June").ops.length + P("after:June").words.length, 1);
});

test("every token carries [start, end) offsets into the input", () => {
  const s = 'hi from:"Ana María" -nope has:photo';
  const q = P(s);
  for (const o of q.ops) assert.strictEqual(s.slice(o.start, o.end), o.raw);
  assert.deepStrictEqual(q.ops.map((o) => o.raw), ['from:"Ana María"', "-nope", "has:photo"]);
});

const PEOPLE = [
  { id: "u1", names: ["Bob", "User 1"] },
  { id: "u2", names: ["Bella", "User 2"] },
  { id: "u3", names: ["José Álvarez", "User 3"] },
  { id: "u4", names: ["Mary-Jane", "User 4"] },
  { id: "u5", names: ["Ana María", "User 5"] },
];

// rankPeople is the ONE matcher behind resolvePeople (from:) and the from:
// autocomplete: rank 0 exact, 1 a name starts with it, 2 a later word does,
// 3 a name contains it — and the substring tier only when nothing starts with it.
test("rankPeople: one ranked matcher, tiered, people passed through", () => {
  const r = (v, list) => rankPeople(v, list || PEOPLE).map((x) => [x.person.id, x.rank]);
  assert.deepStrictEqual(r("bob"), [["u1", 0]]);
  assert.deepStrictEqual(r("b"), [["u1", 1], ["u2", 1]]);
  assert.deepStrictEqual(r("alv"), [["u3", 2]]);                       // a later word
  assert.deepStrictEqual(r("ALVAREZ"), [["u3", 2]]);                   // case + accents folded
  assert.deepStrictEqual(r("ar"), [["u3", 3], ["u4", 3], ["u5", 3]]);  // only substrings: that tier
  assert.deepStrictEqual(r("user 2"), [["u2", 0]]);                    // an alias, exactly
  assert.deepStrictEqual(r("zzz"), []);
  assert.deepStrictEqual(r(""), PEOPLE.map((p) => [p.id, 1]));         // nothing typed: everyone
  // exact and prefix matches share the first tier (the caller orders by rank)
  const withB = PEOPLE.concat([{ id: "u6", names: ["B"] }]);
  assert.deepStrictEqual(r("b", withB), [["u1", 1], ["u2", 1], ["u6", 0]]);
  // the objects passed in come back as-is (extra fields kept for the caller)
  const tagged = [{ id: "x", names: ["Zed"], count: 7 }];
  assert.strictEqual(rankPeople("z", tagged)[0].person, tagged[0]);
});

test("resolvePeople: exact name, then name / word prefix, then substring", () => {
  assert.deepStrictEqual(resolvePeople("bob", PEOPLE).ids, ["u1"]);
  assert.deepStrictEqual(resolvePeople("bob", PEOPLE).how, "exact");
  assert.deepStrictEqual(resolvePeople("b", PEOPLE).ids, ["u1", "u2"]);
  assert.deepStrictEqual(resolvePeople("alv", PEOPLE).ids, ["u3"]);          // a later word
  assert.deepStrictEqual(resolvePeople("jose", PEOPLE).ids, ["u3"]);         // accents folded
  assert.deepStrictEqual(resolvePeople("MARY-JANE", PEOPLE).ids, ["u4"]);
  assert.deepStrictEqual(resolvePeople("user 3", PEOPLE).ids, ["u3"]);       // the "User N" alias
  assert.deepStrictEqual(resolvePeople("ari", PEOPLE).ids, ["u5"]);          // substring fallback
  assert.deepStrictEqual(resolvePeople("zzz", PEOPLE), { ids: [], how: "none", pending: false });
});

test("resolvePeople at the end of the input waits while the value is ambiguous", () => {
  assert.strictEqual(resolvePeople("b", PEOPLE, { open: true }).pending, true);
  assert.deepStrictEqual(resolvePeople("bo", PEOPLE, { open: true }), { ids: ["u1"], how: "prefix", pending: false });
  assert.strictEqual(resolvePeople("bob", PEOPLE, { open: true }).pending, false);
  assert.strictEqual(resolvePeople("zzz", PEOPLE, { open: true }).pending, false);   // nobody: applied (0 results)
  assert.strictEqual(resolvePeople("user", PEOPLE, { open: true }).pending, true);
  assert.strictEqual(resolvePeople("b", PEOPLE).pending, false);                     // bounded: everyone it names
});

test("removeSearchToken drops one token and keeps the rest bounded", () => {
  const s = "pizza from:bob has:photo";
  const q = P(s);
  assert.strictEqual(removeSearchToken(s, q.ops[0]), "pizza has:photo");
  assert.strictEqual(removeSearchToken(s, q.ops[1]), "pizza from:bob ");
  assert.strictEqual(removeSearchToken("from:bob", P("from:bob").ops[0]), "");
  const t = 'a  -"x y"  b';
  assert.strictEqual(removeSearchToken(t, P(t).ops[0]), "a b");
});

test("replaceSearchToken / quoteOpValue complete a from: value", () => {
  const s = "pizza from:an";
  const tok = P(s).ops[0];
  assert.strictEqual(replaceSearchToken(s, tok, "from:" + quoteOpValue("Ana María")), 'pizza from:"Ana María" ');
  assert.strictEqual(quoteOpValue("Bob"), "Bob");
  assert.strictEqual(quoteOpValue("José"), "José");
  assert.strictEqual(quoteOpValue('Say "hi"'), '"Say hi"');
  const m = "from:b pizza";
  assert.strictEqual(replaceSearchToken(m, P(m).ops[0], "from:Bob"), "from:Bob pizza");
});

test("a from: pick for a name with quote marks finds that person", () => {
  for (const n of ['Robert "Bobby" Smith', '"Ace"', 'Dee "D"']) {
    const people = [{ id: "1", names: [n] }, { id: "2", names: ["Robert Smith"] }];
    const q = "from:" + quoteOpValue(n) + " ";
    assert.deepStrictEqual(resolvePeople(P(q).ops[0].value, people).ids, ["1"], n);
    assert.deepStrictEqual(resolvePeople(P(q).ops[0].value, people).how, "exact", n);
  }
});
