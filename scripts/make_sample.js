/*
 * make_sample.js — generates a fully synthetic, publishable demo dataset.
 *
 * Emits, into sample/:
 *   - sample/data.sample.js   (same schema build.js produces, multi-conversation)
 *   - sample/photo-*.svg      (placeholder photos the messages point at)
 *
 * Run:  node scripts/make_sample.js              (writes the project's sample/)
 *       node scripts/make_sample.js --out <dir>  (writes <dir>/sample/ instead)
 *
 * Deterministic: a fixed seed and a fixed "generated at" instant, no wall clock
 * and no Math.random(), so running it twice gives byte-identical files and CI
 * can check `node scripts/make_sample.js && git diff --exit-code sample`.
 *
 * Everything here is invented — no real messages, names, ids, or media.
 * The repo is runnable/demoable with ZERO real data present.
 */

const fs = require("fs");
const path = require("path");

const argv = process.argv.slice(2);
const outAt = argv.indexOf("--out");
if (outAt >= 0 && !argv[outAt + 1]) { console.error("Usage: node scripts/make_sample.js [--out <dir>]"); process.exit(2); }
const here = outAt >= 0 ? path.resolve(argv[outAt + 1]) : path.join(__dirname, "..");   // project root by default
// The demo data and its photos share one folder; the photo paths in the data
// ("sample/photo-1.svg") are relative to index.html at the project root.
const SAMPLE_DIR = "sample";
const OUT_DIR = path.join(here, SAMPLE_DIR);
fs.mkdirSync(OUT_DIR, { recursive: true });

/* ---- fixed clock + deterministic pseudo-random --------------------------- */
const DAY = 86400000;
const START = Date.parse("2024-01-06T15:00:00Z");   // first message
const END = Date.parse("2025-07-04T21:00:00Z");     // last message (~18 months later)
const GENERATED_AT = "2025-07-05T12:00:00.000Z";    // fixed, so regenerating never churns the file
const at = (iso) => Date.parse(iso);

let seed = 1337;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const pick = (a) => a[Math.floor(rnd() * a.length)];
const chance = (p) => rnd() < p;
const between = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));

/* ---- placeholder media (tiny self-contained SVGs, all tagged "img") ------- */
// The sample ships no video: an SVG tagged "vid" would render as an empty
// <video> player, so every placeholder is an image and is tagged as one.
function placeholder(file, label, bg) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400" viewBox="0 0 600 400">
  <rect width="600" height="400" fill="${bg}"/>
  <rect x="20" y="20" width="560" height="360" rx="16" fill="none" stroke="#3b82f6" stroke-width="3" opacity="0.5"/>
  <text x="300" y="200" font-family="system-ui,sans-serif" font-size="34" fill="#9fb6ff" text-anchor="middle" dominant-baseline="middle">${label}</text>
  <text x="300" y="245" font-family="system-ui,sans-serif" font-size="16" fill="#5b6b9a" text-anchor="middle">sample placeholder · no real media</text>
</svg>`;
  fs.writeFileSync(path.join(OUT_DIR, file), svg);
  return SAMPLE_DIR + "/" + file;
}
const PHOTOS = [
  placeholder("photo-1.svg", "📷 Demo Photo", "#0a0e17"),
  placeholder("photo-2.svg", "🖼 Demo Image", "#0f1830"),
  placeholder("photo-3.svg", "🌄 Demo Snapshot", "#111726"),
  placeholder("photo-4.svg", "🍕 Demo Dinner", "#16112a"),
];

/* ---- content bank -------------------------------------------------------- */
const LINES = [
  "yo did everyone see that", "lmaooo no way", "ok that's actually wild",
  "anyone free this weekend?", "i'm down for whatever", "let's gooo",
  "brb getting food", "wait what happened", "send the link",
  "that's hilarious", "fr fr", "i can't with this chat", "good morning ☀️",
  "who's hyped for the game", "this is the best gc", "real talk though",
  "imagine missing that", "10/10 would recommend", "be there in 5",
  "did the homework btw", "new pfp who dis", "stop it 😭", "valid point",
  "we should do this more often", "absolute cinema", "no thoughts head empty",
  "the vibes are immaculate", "okay but hear me out", "this aged well",
  "happy friday everyone", "running late sorry", "let's plan something",
  "😂😂😂", "🔥🔥", "🙌", "same 💯", "pizza tonight? 🍕", "happy birthday!! 🎂🎉",
];
// Right-to-left and mixed-direction lines, so bubbles, search and share cards
// get exercised with bidi text (all generic greetings, no real content).
const RTL = [
  "صباح الخير يا جماعة ☀️", "شكراً على كل شيء 🙏", "ok see you there — نلتقي هناك 👋",
  "יאללה, נתראה בשמונה", "מזל טוב!! 🎉", "שבת שלום לכולם",
];
const LONGER = [
  "honestly this group chat has been carrying my whole week, you guys are the best",
  "okay so the plan is: meet at noon, grab lunch, then we figure out the rest as we go",
  "i was thinking we could do a movie night this weekend if everyone's around",
  "remember when we stayed up until 4am arguing about the most random stuff, good times",
  "just wanted to say thanks for always being down to hang, means a lot fr",
];
const REACTS = ["funny", "like", "agree", "disagree", "excited", "surprised", "emoji"];
const EMOJI_REACTS = ["🎉", "🫶", "👀"];

/* ---- message times: bursty sessions spread across the whole window ------- */
// Sessions are spaced evenly from `from` to `to` (first and last are pinned to
// the ends, so the span is exact) with a few days of jitter, start in the
// afternoon/evening (UTC), and hold 2–9 messages a few minutes apart.
function sessionTimes(n, from, to) {
  const sessions = Math.max(2, Math.ceil(n / 5.5));
  const lens = Array.from({ length: sessions }, () => between(2, 9));
  lens[sessions - 1] = 1;                               // the last message lands exactly on `to`
  let sum = lens.reduce((a, b) => a + b, 0);
  while (sum < n) { lens[Math.floor(rnd() * (sessions - 1))]++; sum++; }
  while (sum > n) { const j = Math.floor(rnd() * (sessions - 1)); if (lens[j] > 1) { lens[j]--; sum--; } }
  const step = (to - from) / (sessions - 1);
  const out = [];
  for (let j = 0; j < sessions; j++) {
    let t;
    if (j === 0) t = from;
    else if (j === sessions - 1) t = to;
    else {
      const day = Math.floor((from + j * step + (rnd() - 0.5) * Math.min(step, 4 * DAY)) / DAY) * DAY;
      t = day + between(13, 23) * 3600000 + between(0, 59) * 60000;
    }
    for (let k = 0; k < lens[j]; k++) { out.push(t); t += between(1, 14) * 60000; }
  }
  // a session near the end may run past `to`; keep the pinned last message last
  return out.map((t) => Math.min(t, to)).sort((a, b) => a - b);
}

let msgId = 100000;
const nid = () => String(++msgId);

/* ---- conversation factory ------------------------------------------------ */
// spec: { id, title, participants, n, from, to, events: [...] }. A member who
// is added by a "join" event only speaks after it; one who "leave"s only before.
function groupConvo(spec) {
  const events = spec.events.slice().sort((a, b) => a.t - b.t);
  const joinedAt = {}, leftAt = {};
  for (const e of events) {
    if (e.type === "join") e.ids.forEach((id) => { joinedAt[id] = e.t; });
    if (e.type === "leave") e.ids.forEach((id) => { leftAt[id] = e.t; });
  }
  const activeAt = (t) => spec.participants.filter((p) => (joinedAt[p] == null || t > joinedAt[p]) && (leftAt[p] == null || t < leftAt[p]));

  const msgs = sessionTimes(spec.n, spec.from, spec.to).map((t, k) => {
    const members = activeAt(t);
    const s = pick(members);
    const rec = { i: nid(), s, t, x: chance(0.14) ? pick(LONGER) : chance(0.06) ? pick(RTL) : pick(LINES) };
    if (chance(0.09)) {
      rec.m = pick(PHOTOS); rec.k = "img";
      rec.x = pick(["check this out", "look 👀", "📷", "", rec.x]);
    }
    // An export holds one reaction per person per message (a new one replaces
    // the old), so a person drawn a second time for the same message is
    // skipped. The draws themselves are unchanged, so the rest of the
    // generated stream (texts, times, media) stays the same.
    const reactors = members.filter((p) => p !== s);
    if (reactors.length && chance(0.22)) {
      const r = [];
      const howMany = 1 + Math.floor(rnd() * Math.min(3, reactors.length));
      for (let j = 0; j < howMany; j++) {
        const key = pick(REACTS);
        const one = key === "emoji" ? { k: key, s: pick(reactors), e: pick(EMOJI_REACTS) } : { k: key, s: pick(reactors) };
        if (!r.some((x) => x.s === one.s)) r.push(one);
      }
      rec.r = r;
    }
    // Guarantee at least one "funny" and one "disagree" reaction per
    // conversation (deterministic, not left to chance()) so the "Laugh Track"
    // and "The Hater" superlatives always have a winner, and one custom-emoji
    // reaction (a glyph, not a generic key) so its capture + render is on show.
    // It goes to the first member who hasn't reacted yet, or replaces the
    // first member's reaction when everyone has.
    const guarantee = (key, e) => {
      const r = rec.r || [];
      const who = reactors.find((p) => !r.some((x) => x.s === p)) || reactors[0];
      const one = e ? { k: key, s: who, e } : { k: key, s: who };
      rec.r = r.filter((x) => x.s !== who).concat([one]);
    };
    if (reactors.length) {
      if (k === 0) guarantee("funny");
      if (k === 1) guarantee("disagree");
      if (k === 2) guarantee("emoji", "🎉");
    }
    return rec;
  });
  if (spec.extras) spec.extras(msgs);
  return { id: spec.id, type: "group", title: spec.title, participants: spec.participants, count: msgs.length, msgs, events };
}

// A link in the export's shape: the text carries the short t.co url, `u` maps it
// to the expanded/display form the viewer shows.
function withLink(m, slug) {
  const short = "https://t.co/demo" + slug;
  m.x = "plan's here " + short;
  m.u = [{ s: short, e: "https://example.com/" + slug, d: "example.com/" + slug }];
}

/* ---- build the 3 demo conversations -------------------------------------- */
const A = ["1001", "1002", "1003", "1004", "1005"];   // Demo Squad
const B = ["1002", "1003", "1006"];                    // Weekend Plans
const C = ["1001", "1003", "1006", "1007"];            // Study Group

// Group chats only (the app is group-chats focused)
const conversations = [
  groupConvo({
    id: "900000000000000001", title: "Demo Squad", participants: A, n: 360, from: START, to: END,
    events: [
      { t: START - 3600000, type: "create", s: "1001" },
      { t: START - 3599000, type: "name", s: "1001", name: "the squad 🔥" },
      { t: at("2024-03-02T18:00:00Z"), type: "join", s: "1002", ids: ["1005"] },
      { t: at("2024-05-11T19:30:00Z"), type: "name", s: "1003", name: "Demo Squad" },
    ],
    extras(msgs) {
      // one message with several photos (the first in m/k, the rest in mx)
      const multi = msgs[40];
      multi.x = "photo dump from saturday 📸"; multi.m = PHOTOS[0]; multi.k = "img";
      multi.mx = [{ m: PHOTOS[1], k: "img" }, { m: PHOTOS[3], k: "img" }];
      withLink(msgs[75], "squad-trip");
    },
  }),
  groupConvo({
    id: "900000000000000002", title: "Weekend Plans", participants: B, n: 170,
    from: at("2024-02-09T17:00:00Z"), to: at("2025-06-21T20:00:00Z"),
    events: [
      { t: at("2024-02-09T16:00:00Z"), type: "create", s: "1002" },
      { t: at("2024-02-09T16:00:01Z"), type: "name", s: "1002", name: "Weekend Plans" },
    ],
    extras(msgs) { withLink(msgs[12], "weekend-plan"); },
  }),
  groupConvo({
    id: "900000000000000003", title: "Study Group", participants: C, n: 130,
    from: at("2024-01-15T16:00:00Z"), to: at("2025-05-30T19:00:00Z"),
    events: [
      { t: at("2024-01-15T15:00:00Z"), type: "create", s: "1003" },
      { t: at("2024-01-15T15:00:01Z"), type: "name", s: "1003", name: "study grp" },
      { t: at("2024-09-02T17:00:00Z"), type: "name", s: "1001", name: "Study Group" },
      { t: at("2025-03-01T12:00:00Z"), type: "leave", ids: ["1007"] },
    ],
  }),
];

// largest first (matches build.js ordering)
conversations.sort((a, b) => b.count - a.count);

const OUT = path.join(OUT_DIR, "data.sample.js");
// __sample marks this as the synthetic demo so the app can show a first-run
// onboarding prompt; any real build overrides window.CHAT_DATA without it.
fs.writeFileSync(OUT, "window.CHAT_DATA = " + JSON.stringify({ generatedAt: GENERATED_AT, __sample: true, conversations }) + ";\n");

const total = conversations.reduce((s, c) => s + c.count, 0);
console.log("Wrote", path.relative(process.cwd(), OUT) || OUT, "—", conversations.length, "group conversations,", total, "messages.");
conversations.forEach((c) => console.log("  ·", c.title, "—", c.count, "msgs"));
console.log("Wrote", PHOTOS.length, "placeholder photos to " + SAMPLE_DIR + "/.");
