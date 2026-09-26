// VC-18 (SP3): fuzzy search runs Fuse.js only on the messages that CAN match.
// GCAShared.createBigramIndex / fuzzyCandidates implement a q-gram-lemma
// prefilter: a text holding a substring within k edits of a length-m pattern
// contains at least (m-1) - 2k of the pattern's bigram positions. It must be a
// pure speed-up — Fuse over the candidates must return exactly what Fuse over
// the whole archive returns (same messages, same scores, same order).

require("./_real-data-guard.js");   // QA-2: refuse to run outside a clean checkout
const test = require("node:test");
const assert = require("node:assert");

const Fuse = require("../lib/fuse.min.js");
const { createBigramIndex, fuzzyCandidates } = require("../src/shared-core.js");
const { generateArchive } = require("./fixtures/synthetic-archive.js");

const OPTS = { threshold: 0.3, ignoreLocation: true, includeMatches: true };

// Synthetic corpus (never real data): the generator's lines plus deterministic
// letter soup so there is plenty of near-miss material, some unicode and
// punctuation, very short and very long texts.
function corpus() {
  const msgs = generateArchive({ main: 6000, side: 0, seed: 77 }).conversations[0].msgs;
  let seed = 99;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const ABC = "abcdefghijklmnopqrstuvwxyz      ééü.,!?'0123";
  const out = msgs.map((m) => m.x.toLowerCase());
  for (let k = 0; k < 3000; k++) {
    let s = "";
    const len = 1 + Math.floor(rnd() * (k % 10 === 0 ? 160 : 40));
    for (let j = 0; j < len; j++) s += ABC[Math.floor(rnd() * ABC.length)];
    out.push(s);
  }
  out.push("", "a", "lol", "ok", "movie nite", "hilarous", "the quikc brown fx jumps");
  return out;
}

const QUERIES = [
  "hilarous", "hilarious", "movie nite", "movie night", "the quick brown fox", "lol", "ok", "a", "zz",
  "thnks guys", "wekend", "absolute cinema", "vibes are imaculate", "nowaythatsactuallywild",
  // > 32 chars: Fuse splits the pattern into 32-char chunks and matches if ANY chunk does.
  "okay so the plan is meet at noon grab lunch then we figure it out",
  "remember when we stayed up until 4am arguing about random stuff",
  "i was thinking we could do a movie night this weekend",
  "éé", "don't", "10/10 would recomend",
];

const strip = (rs) => rs.map((r) => [r.refIndex, r.score, JSON.stringify(r.matches)]);

test("prefiltered Fuse returns exactly what full-archive Fuse returns", () => {
  const texts = corpus();
  const full = new Fuse(texts, OPTS);
  const idx = createBigramIndex(texts);
  let pruned = 0;
  for (const q of QUERIES) {
    const want = strip(full.search(q));
    const cand = fuzzyCandidates(idx, q, OPTS.threshold);
    let got;
    if (cand === null) got = want;           // no pruning possible for this pattern
    else {
      pruned += texts.length - cand.length;
      const sub = new Fuse(Array.from(cand, (i) => texts[i]), OPTS);
      got = strip(sub.search(q).map((r) => Object.assign({}, r, { refIndex: cand[r.refIndex] })));
    }
    assert.deepStrictEqual(got, want, "query " + JSON.stringify(q));
  }
  // …and it actually prunes (otherwise it's no speed-up at all).
  assert.ok(pruned > texts.length * QUERIES.length * 0.3, "pruned " + pruned);
});

test("candidates are ascending message indices; tiny patterns can't be pruned", () => {
  const texts = ["hello there", "general kenobi", "hello again", "nothing"];
  const idx = createBigramIndex(texts);
  const c = fuzzyCandidates(idx, "hello", 0.3);
  assert.deepStrictEqual(Array.from(c), [0, 2]);
  assert.equal(fuzzyCandidates(idx, "a", 0.3), null);
  assert.equal(fuzzyCandidates(idx, "", 0.3), null);
});

test("the index can be built incrementally (generator with a yield hook)", () => {
  const texts = corpus();
  const direct = createBigramIndex(texts);
  let yields = 0, calls = 0;
  const gen = createBigramIndex.steps(texts, () => (++calls % 3 === 0));
  let r;
  while (!(r = gen.next()).done) yields++;
  assert.ok(yields > 0, "never yielded");
  assert.deepStrictEqual(Array.from(r.value.post), Array.from(direct.post));
  assert.deepStrictEqual(Array.from(r.value.start), Array.from(direct.start));
});
