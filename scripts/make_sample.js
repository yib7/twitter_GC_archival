/*
 * make_sample.js — generates a fully synthetic, publishable demo dataset.
 *
 * Emits:
 *   - data.sample.js          (same schema build.js produces, multi-conversation)
 *   - sample_media/*.svg      (a couple of placeholder media + generic avatars)
 *
 * Run:  node make_sample.js
 *
 * Everything here is invented — no real messages, names, ids, or media.
 * The repo is runnable/demoable with ZERO real data present.
 */

const fs = require("fs");
const path = require("path");

const here = path.join(__dirname, "..");   // project root (this script lives in scripts/)
const MEDIA = path.join(here, "sample_media");
fs.mkdirSync(MEDIA, { recursive: true });

/* ---- deterministic pseudo-random so rebuilds are stable ------------------ */
let seed = 1337;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const pick = (a) => a[Math.floor(rnd() * a.length)];
const chance = (p) => rnd() < p;

/* ---- placeholder media (tiny self-contained SVGs) ------------------------ */
function placeholder(file, label, bg) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400" viewBox="0 0 600 400">
  <rect width="600" height="400" fill="${bg}"/>
  <rect x="20" y="20" width="560" height="360" rx="16" fill="none" stroke="#3b82f6" stroke-width="3" opacity="0.5"/>
  <text x="300" y="200" font-family="system-ui,sans-serif" font-size="34" fill="#9fb6ff" text-anchor="middle" dominant-baseline="middle">${label}</text>
  <text x="300" y="245" font-family="system-ui,sans-serif" font-size="16" fill="#5b6b9a" text-anchor="middle">sample placeholder · no real media</text>
</svg>`;
  fs.writeFileSync(path.join(MEDIA, file), svg);
  return "sample_media/" + file;
}
const IMG1 = placeholder("photo-1.svg", "📷 Demo Photo", "#0a0e17");
const IMG2 = placeholder("photo-2.svg", "🖼 Demo Image", "#0f1830");
const VID1 = placeholder("clip-1.svg", "▶ Demo Clip", "#111726");
// a couple of generic avatar swatches (not wired by default — proves the schema)
["#3b82f6", "#22c55e", "#f59e0b"].forEach((c, i) =>
  fs.writeFileSync(path.join(MEDIA, `avatar-${i + 1}.svg`),
    `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" rx="60" fill="${c}"/><text x="60" y="72" font-family="system-ui" font-size="44" fill="#000" text-anchor="middle">U${i + 1}</text></svg>`));

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
];
const LONGER = [
  "honestly this group chat has been carrying my whole week, you guys are the best",
  "okay so the plan is: meet at noon, grab lunch, then we figure out the rest as we go",
  "i was thinking we could do a movie night this weekend if everyone's around",
  "remember when we stayed up until 4am arguing about the most random stuff, good times",
  "just wanted to say thanks for always being down to hang, means a lot fr",
];
const REACTS = ["funny", "like", "agree", "excited", "surprised", "emoji"];

/* ---- conversation factory ------------------------------------------------ */
let clock = Date.parse("2024-01-06T15:00:00Z");
function nextTime() { clock += (3 + Math.floor(rnd() * 90)) * 60 * 1000; return clock; }
let msgId = 100000;
const nid = () => String(++msgId);

function makeMessages(participants, n, opts) {
  const msgs = [];
  for (let k = 0; k < n; k++) {
    const s = pick(participants);
    const rec = { i: nid(), s, t: nextTime(), x: chance(0.18) ? pick(LONGER) : pick(LINES) };
    if (opts.media && chance(0.12)) {
      const m = pick([IMG1, IMG2, VID1]); rec.m = m; rec.k = m.endsWith(".svg") && m.includes("clip") ? "vid" : "img";
      if (!rec.x || chance(0.5)) rec.x = pick(["check this out", "look 👀", "📷", ""]);
    }
    if (chance(0.22)) {
      const reactors = participants.filter((p) => p !== s);
      const r = [];
      const howMany = 1 + Math.floor(rnd() * Math.min(3, reactors.length));
      for (let j = 0; j < howMany; j++) r.push({ k: pick(REACTS), s: pick(reactors) });
      if (r.length) rec.r = r;
    }
    msgs.push(rec);
  }
  return msgs;
}

function groupConvo(id, title, participants, n) {
  const created = (clock = Date.parse("2024-01-06T15:00:00Z"));
  const events = [
    { t: created, type: "create", s: participants[0] },
    { t: created + 1000, type: "name", s: participants[0], name: title },
  ];
  const msgs = makeMessages(participants, n, { media: true });
  return { id, type: "group", title, participants, count: msgs.length, msgs, events };
}

/* ---- build the 3 demo conversations -------------------------------------- */
const A = ["1001", "1002", "1003", "1004", "1005"];   // Demo Squad
const B = ["1002", "1003", "1006"];                    // Weekend Plans
const C = ["1001", "1003", "1006", "1007"];            // Study Group

// Group chats only (the app is group-chats focused)
const conversations = [
  groupConvo("900000000000000001", "Demo Squad", A, 64),
  groupConvo("900000000000000002", "Weekend Plans", B, 38),
  groupConvo("900000000000000003", "Study Group", C, 30),
];

// largest first (matches build.js ordering)
conversations.sort((a, b) => b.count - a.count);

const OUT = path.join(here, "data.sample.js");
fs.writeFileSync(OUT, "window.CHAT_DATA = " + JSON.stringify({ generatedAt: new Date().toISOString(), conversations }) + ";\n");

const total = conversations.reduce((s, c) => s + c.count, 0);
console.log("Wrote data.sample.js —", conversations.length, "group conversations,", total, "messages.");
conversations.forEach((c) => console.log("  ·", c.title, "—", c.count, "msgs"));
console.log("Wrote", fs.readdirSync(MEDIA).length, "placeholder files to sample_media/.");
