// SP4 (AN-1 / AN-2 / AN-8 / AN-9 / AN-10 / AN-11 / AN-20): the pure
// text-analysis helpers every analytics view shares — grapheme-aware emoji
// extraction, the Unicode word tokenizer + apostrophe-insensitive stopwords,
// the keyword patterns behind the superlatives, hostname-based platform
// matching and the plural() copy helper. All live in src/shared-core.js so
// Stats, Wrapped, Word Battles and the keyword trend can never disagree.

require("./_real-data-guard.js");   // QA-2: refuse to run outside a clean checkout
const test = require("node:test");
const assert = require("node:assert");

const S = require("../src/shared-core.js");

/* ---- AN-1: emoji ---------------------------------------------------------- */
const EMOJI_CASES = [
  ["thanks 👍🏽", ["👍🏽"]],
  ["family 👨‍👩‍👧 and 👍🏽 and 🇺🇸", ["👨‍👩‍👧", "👍🏽", "🇺🇸"]],
  ["love ❤️ it", ["❤️"]],
  ["sunny ☀️ day", ["☀️"]],
  ["💀💀💀", ["💀", "💀", "💀"]],
  ["lol 😂😂", ["😂", "😂"]],
  ["© 2024 ® ™ plain text", []],
  ["no emoji here, just 123 # and *", []],
  ["keycap 1️⃣ ok", ["1️⃣"]],
  ["scotland 🏴󠁧󠁢󠁳󠁣󠁴󠁿!", ["🏴󠁧󠁢󠁳󠁣󠁴󠁿"]],
  ["", []],
];

test("extractEmojis keeps whole emoji sequences (skin tone, ZWJ, flags, VS16)", () => {
  for (const [text, want] of EMOJI_CASES) assert.deepStrictEqual(S.extractEmojis(text), want, JSON.stringify(text));
});

// extractEmojis uses a fast `u`-flag sequence grammar (no `v` flag needed, so
// it works in every browser the app supports); \p{RGI_Emoji} (v flag) is the
// reference it must agree with on real text, including a mixed stress line.
test("extractEmojis agrees with the \\p{RGI_Emoji} reference", (t) => {
  if (S.extractEmojisRGI("x") === null) { t.skip("engine lacks the regex v flag"); return; }
  const stress = "hi 👋🏿 🧑🏽‍💻 🏳️‍🌈 🇯🇵🇫🇷 ✌️✌ ☺️☺ ‼️ #️⃣ 5️⃣ 🫠 👁️‍🗨️ ❤️‍🔥 🐈‍⬛ ™️ © ®";
  for (const [text] of EMOJI_CASES.concat([[stress]])) assert.deepStrictEqual(S.extractEmojis(text), S.extractEmojisRGI(text), JSON.stringify(text));
});

test("a skin-tone modifier can never outrank the emoji it is attached to", () => {
  const counts = {};
  for (const t of ["thanks 👍🏽", "praying 🙏🏽", "gym 💪🏽", "lol 😂😂"]) {
    for (const e of S.extractEmojis(t)) counts[e] = (counts[e] || 0) + 1;
  }
  assert.equal(counts["🏽"], undefined);
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  assert.deepStrictEqual(top, ["😂", 2]);
});

/* ---- AN-2 / AN-11: tokenizer --------------------------------------------- */
test("tokenize: curly and straight apostrophes stay inside one token", () => {
  assert.deepStrictEqual(S.tokenize("I’m sure you don’t know, I didn’t either"), ["i'm", "sure", "you", "don't", "know", "i", "didn't", "either"]);
  assert.deepStrictEqual(S.tokenize("I'm tired, don't care"), ["i'm", "tired", "don't", "care"]);
});

test("tokenize: punctuation and quotes never split or glue a word", () => {
  assert.deepStrictEqual(S.tokenize("lol! lol. LOL, lol?"), ["lol", "lol", "lol", "lol"]);
  assert.deepStrictEqual(S.tokenize("'hello' said \"bob\""), ["hello", "said", "bob"]);
});

test("tokenize: URLs are dropped", () => {
  assert.deepStrictEqual(S.tokenize("look https://example.com/a?b=c and www.foo.org now"), ["look", "and", "now"]);
});

test("tokenize: @mentions and bare domains are dropped too (review fix 2)", () => {
  assert.deepStrictEqual(S.tokenize("hey @john_doe look"), ["hey", "look"]);
  assert.deepStrictEqual(S.tokenize("see youtube.com/watch?v=abc now"), ["see", "now"]);
  assert.deepStrictEqual(S.tokenize("youtu.be/xyz"), []);
  assert.deepStrictEqual(S.tokenize("Check reddit.com."), ["check"]);
  assert.deepStrictEqual(S.tokenize("mail me@gmail.com"), ["mail", "me"]);
  // A missing space after a full stop is not a domain.
  assert.deepStrictEqual(S.tokenize("ok.so what"), ["ok", "so", "what"]);
  assert.deepStrictEqual(S.tokenize("done.to be fair"), ["done", "to", "be", "fair"]);
  // Keyword checks read the same link-free text.
  assert.equal(S.countMatches(S.KEYWORDS.gratitude, S.plainText("@thanks bro")), 0);
  assert.equal(S.plainText("hi @bob"), "hi  ");
});

test("tokenize: non-Latin scripts and accents survive", () => {
  assert.deepStrictEqual(S.tokenize("привет как дела"), ["привет", "как", "дела"]);
  assert.deepStrictEqual(S.tokenize("café naïve"), ["café", "naïve"]);
  assert.deepStrictEqual(S.tokenize("مرحبا بك"), ["مرحبا", "بك"]);
  assert.deepStrictEqual(S.tokenize("नमस्ते दोस्त"), ["नमस्ते", "दोस्त"]);
  assert.deepStrictEqual(S.tokenize("שלום עולם"), ["שלום", "עולם"]);
});

test("tokenize: CJK runs are split into words (Intl.Segmenter when available)", () => {
  const toks = S.tokenize("我喜欢猫");
  assert.ok(toks.length > 1, JSON.stringify(toks));
  assert.equal(toks.join(""), "我喜欢猫");
  const ja = S.tokenize("今日はいい天気です");
  assert.ok(ja.length > 1, JSON.stringify(ja));
});

test("tokenize: the no-Segmenter fallback splits CJK into characters", () => {
  assert.deepStrictEqual(S.tokenizeNoSegmenter("我喜欢猫 ok"), ["我", "喜", "欢", "猫", "ok"]);
});

test("tokenize: the no-Segmenter fallback keeps combining marks on their base (review fix 3)", () => {
  // กินข้าว = ก + ิ (vowel sign), น, ข + ้ (tone mark), า, ว — no standalone mark.
  const toks = S.tokenizeNoSegmenter("กินข้าว");
  assert.deepStrictEqual(toks, ["กิ", "น", "ข้", "า", "ว"]);
  for (const t of toks) assert.ok(!/^\p{M}/u.test(t), JSON.stringify(t));
  assert.equal(toks.join(""), "กินข้าว");
});

test("stopwords are apostrophe-insensitive", () => {
  for (const w of ["i'm", "don't", "can't", "that's", "it's", "everyone's", "didn't", "dont", "im"]) {
    assert.ok(S.isStopword(w), w);
  }
  for (const w of ["pizza", "movie", "привет"]) assert.ok(!S.isStopword(w), w);
});

test("isCloudWord drops stopwords, fragments and numbers but keeps real words in any script", () => {
  for (const w of ["don", "didn"]) assert.ok(!S.tokenize("don’t didn’t").includes(w), w);   // no fragments to begin with
  for (const w of ["i'm", "the", "ok", "2024", "123456"]) assert.ok(!S.isCloudWord(w), w);
  for (const w of ["pizza", "привет", "café", "喜欢", "사랑"]) assert.ok(S.isCloudWord(w), w);
});

test("wordKey folds apostrophes so don't / dont / don’t are one word", () => {
  assert.equal(S.wordKey("don't"), "dont");
  assert.equal(S.wordKey(S.tokenize("DON’T")[0]), "dont");
});

test("countWord counts whole-token occurrences (phrases too), never substrings", () => {
  assert.equal(S.countWord("man, so many humans! MAN", "man"), 2);
  assert.equal(S.countWord("lol! lol. lol", "lol"), 3);
  assert.equal(S.countWord("capital cap", "cap"), 1);
  assert.equal(S.countWord("no cap fr, no cap", "no cap"), 2);
  assert.equal(S.countWord("I don’t know", "dont"), 1);
  assert.equal(S.countWord("I don’t know", "don't"), 1);
  assert.equal(S.countWord("anything", ""), 0);
});

test("countKeys / mayContainKey: the pre-folded loop form of countWord", () => {
  const keys = S.wordKeys("Don’t");
  assert.deepStrictEqual(keys, ["dont"]);
  assert.equal(S.countKeys("i don't, i DON’T", keys), 2);
  // The prefilter may say yes too often, never no when countKeys would count.
  for (const t of ["i don’t know", "i don't know", "dont", "DONʼT stop"]) {
    assert.ok(S.mayContainKey(t.toLowerCase(), "dont"), t);
    assert.ok(S.countKeys(t, keys) > 0, t);
  }
  assert.ok(!S.mayContainKey("nothing here", "dont"));
  assert.ok(!S.mayContainKey("", "dont"));
});

/* ---- AN-8: keyword patterns ---------------------------------------------- */
test("countLaughs counts plain and stretched laughs and laughing emoji", () => {
  assert.equal(S.countLaughs("💀"), 1);
  assert.equal(S.countLaughs("im dead 💀💀💀"), 3);
  assert.equal(S.countLaughs("lmaooo"), 1);
  assert.equal(S.countLaughs("lolol that's funny lmfaooo"), 2);
  assert.equal(S.countLaughs("hahaha 😂 😭 🤣"), 4);
  assert.equal(S.countLaughs("lollipop hello"), 0);
});

test("isLaughOnly: a whole message of laughter, never whitespace alone", () => {
  for (const t of ["lol", "lmaooo", "hahaha", "😂", "💀 💀", "LOL!!", "lol lmao"]) assert.ok(S.isLaughOnly(t), t);
  for (const t of ["", "   ", "lol that was great", "ok"]) assert.ok(!S.isLaughOnly(t), JSON.stringify(t));
});

test("isProfane matches the common stems", () => {
  for (const t of ["fucking hell", "that's shitty", "bullshit", "damnit", "what the fuck", "BITCHES"]) assert.ok(S.isProfane(t), t);
  for (const t of ["hello there", "cocktail hour", "dickens novel", "shiitake"]) assert.ok(!S.isProfane(t), t);
});

test("isKeysmash needs a vowel-free run with 3+ distinct letters", () => {
  for (const t of ["sdfghjkl", "asdfasdf", "hjkl", "qwrtpsdf"]) assert.ok(S.isKeysmash(t), t);
  for (const t of ["hmmmmm", "shhhhh", "brrrrr", "zzzzzz", "hello world"]) assert.ok(!S.isKeysmash(t), t);
});

test("keyword / keysmash checks never read inside a link (review fix 1)", () => {
  assert.equal(S.isKeysmash("https://t.co/xkcdbzqwrt"), false);
  assert.equal(S.isKeysmash("look https://t.co/xkcdbzqwrt lol"), false);
  assert.equal(S.isKeysmash("sdfghjkl https://t.co/abc"), true);
  const p = S.plainText("why? https://example.com/a?q=1 www.x.com/shit ok");
  assert.ok(p.indexOf("?q=") === -1 && p.indexOf("shit") === -1, p);
  assert.ok(p.indexOf("why?") !== -1 && p.indexOf("ok") !== -1, p);
  assert.equal(S.plainText("no links here"), "no links here");
  assert.equal(S.plainText(""), "");
});

test("slang / gamer / finance patterns skip everyday words", () => {
  assert.equal(S.countMatches(S.KEYWORDS.zoomer, "I bet the cap is on the bottle"), 0);
  assert.equal(S.countMatches(S.KEYWORDS.zoomer, "no cap fr fr"), 3);
  assert.equal(S.countMatches(S.KEYWORDS.gamer, "the bot replied"), 0);
  assert.equal(S.countMatches(S.KEYWORDS.finance, "a bear under the full moon"), 0);
  assert.equal(S.countMatches(S.KEYWORDS.finance, "btc to the moon"), 2);
});

/* ---- AN-9: hostname matching ----------------------------------------------- */
test("linkPlatform matches on the hostname, not a substring of the URL", () => {
  const cases = [
    ["https://www.netflix.com/title/123", null],
    ["https://dropbox.com/s/x", null], ["https://fedex.com", null], ["https://xbox.com", null],
    ["https://x.com/user/status/1", "twitter"], ["https://mobile.twitter.com/a", "twitter"], ["twitter.com/a", "twitter"],
    ["https://www.youtube.com/watch?v=1", "youtube"], ["https://youtu.be/abc", "youtube"],
    ["https://vm.tiktok.com/xyz", "tiktok"], ["https://www.instagram.com/p/1", "instagram"],
    ["https://notyoutube.com/", null], ["not a url", null], ["", null],
  ];
  for (const [url, want] of cases) assert.equal(S.linkPlatform(url), want, url);
});

/* ---- AN-20: plural --------------------------------------------------------- */
test("plural picks the singular only for exactly one and formats the count", () => {
  assert.equal(S.plural(1, "thread"), "1 thread");
  assert.equal(S.plural(0, "thread"), "0 threads");
  assert.equal(S.plural(2, "day"), "2 days");
  assert.equal(S.plural(1234, "message"), "1,234 messages");
  assert.equal(S.plural(2, "reply", "replies"), "2 replies");
  assert.equal(S.plural(1, "URL"), "1 URL");
});
