/*
 * scripts/make-sample.js — the synthetic demo generator. Run as a child process
 * into scratch directories (never the repo root), then checked for:
 *   - determinism: two runs produce byte-identical files (so CI can run
 *     `node scripts/make-sample.js && git diff --exit-code sample`);
 *   - a span long enough (~18 months) for Stats / Wrapped to have something to show;
 *   - honest media kinds: nothing tagged "vid" points at an image/SVG, and nothing
 *     tagged "img" points at a video file;
 *   - the shapes the viewer exercises (three demo titles, events, reactions, RTL text).
 */
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const GEN = path.join(__dirname, "..", "scripts", "make-sample.js");
const tmpDirs = [];
function scratch() { const d = fs.mkdtempSync(path.join(os.tmpdir(), "gca-sample-")); tmpDirs.push(d); return d; }
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

function generate() {
  const dir = scratch();
  const r = spawnSync(process.execPath, [GEN, "--out", dir], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return dir;
}
function listFiles(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? listFiles(p, base) : [path.relative(base, p).split(path.sep).join("/")];
  }).sort();
}
function readSample(dir) {
  const s = fs.readFileSync(path.join(dir, "sample", "data.sample.js"), "utf8");
  return JSON.parse(s.replace(/^window\.CHAT_DATA\s*=\s*/, "").replace(/;\s*$/, ""));
}

const first = generate();
const data = readSample(first);
const allMsgs = data.conversations.flatMap((c) => c.msgs);
const media = allMsgs.flatMap((m) => (m.m ? [{ m: m.m, k: m.k }] : []).concat(m.mx || []));

test("--out writes only into the given directory, and two runs are byte-identical", () => {
  const second = generate();
  const a = listFiles(first), b = listFiles(second);
  assert.ok(a.includes("sample/data.sample.js"), "sample/data.sample.js is written");
  assert.ok(a.some((f) => /^sample\/photo-\d+\.svg$/.test(f)), "sample photos are written");
  assert.ok(a.every((f) => f.startsWith("sample/")), "everything lands in sample/: " + a.join(", "));
  assert.deepEqual(a, b);
  for (const f of a) assert.ok(fs.readFileSync(path.join(first, f)).equals(fs.readFileSync(path.join(second, f))), f + " differs between runs");
});

test("generatedAt is a fixed timestamp, not the wall clock", () => {
  assert.match(data.generatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/);
  const lastMsg = Math.max(...allMsgs.map((m) => m.t));
  assert.ok(Date.parse(data.generatedAt) >= lastMsg, "generatedAt is not before the newest message");
  assert.ok(Math.abs(Date.parse(data.generatedAt) - Date.now()) > 7 * 86400000, "generatedAt must not track the current time");
});

test("the sample spans roughly 18 months", () => {
  const ts = allMsgs.map((m) => m.t);
  const months = (Math.max(...ts) - Math.min(...ts)) / (30.44 * 86400000);
  assert.ok(months >= 16 && months <= 20, "span is " + months.toFixed(1) + " months");
  for (const c of data.conversations) {
    const ct = c.msgs.map((m) => m.t);
    const cm = (Math.max(...ct) - Math.min(...ct)) / (30.44 * 86400000);
    assert.ok(cm >= 12, c.title + " spans only " + cm.toFixed(1) + " months");
  }
});

test("media kinds match the file type: no image tagged as video, no video tagged as image", () => {
  assert.ok(media.length > 0, "the sample has media");
  const IMG = /\.(svg|png|jpe?g|gif|webp)$/i, VID = /\.(mp4|webm|mov|m4v)$/i;
  for (const it of media) {
    if (it.k === "vid") assert.match(it.m, VID, it.m + " is tagged vid");
    if (it.k === "img") assert.match(it.m, IMG, it.m + " is tagged img");
    if (IMG.test(it.m)) assert.equal(it.k, "img", it.m + " is an image");
    if (VID.test(it.m)) assert.equal(it.k, "vid", it.m + " is a video");
  }
});

test("every referenced media file is generated", () => {
  const files = new Set(listFiles(first));
  for (const it of media) assert.ok(files.has(it.m), it.m + " is referenced but not generated");
});

test("keeps the demo markers and exercises the viewer's shapes", () => {
  assert.equal(data.__sample, true);
  assert.deepEqual(data.conversations.map((c) => c.title).sort(), ["Demo Squad", "Study Group", "Weekend Plans"]);
  for (const c of data.conversations) {
    assert.equal(c.count, c.msgs.length);
    for (let i = 1; i < c.msgs.length; i++) assert.ok(c.msgs[i].t >= c.msgs[i - 1].t, c.title + " messages are sorted");
    const types = new Set(c.events.map((e) => e.type));
    assert.ok(types.has("create") && types.has("name"), c.title + " has create + name events");
    const names = c.events.filter((e) => e.type === "name");
    assert.equal(names[names.length - 1].name, c.title, c.title + ": the newest name event matches the title");
  }
  const evTypes = new Set(data.conversations.flatMap((c) => c.events.map((e) => e.type)));
  assert.ok(evTypes.has("join") && evTypes.has("leave"), "join + leave events appear");
  const reacts = allMsgs.flatMap((m) => m.r || []);
  assert.ok(reacts.some((r) => r.k === "emoji" && r.e), "a custom-emoji reaction appears");
  assert.ok(allMsgs.some((m) => /[֐-ࣿ]/.test(m.x)), "some right-to-left text appears");
  assert.ok(allMsgs.some((m) => /\p{Extended_Pictographic}/u.test(m.x)), "some emoji text appears");
  assert.ok(allMsgs.some((m) => m.u && m.u.length), "a message carries an expanded link");
  assert.ok(allMsgs.some((m) => m.mx && m.mx.length), "a message carries several media items");
});

test("a member's messages fall inside their membership (after join, before leave)", () => {
  for (const c of data.conversations) {
    for (const e of c.events) {
      if (e.type === "join") for (const id of e.ids) {
        const before = c.msgs.filter((m) => m.s === id && m.t < e.t);
        assert.equal(before.length, 0, c.title + ": " + id + " speaks before being added");
      }
      if (e.type === "leave") for (const id of e.ids) {
        const later = c.msgs.filter((m) => m.s === id && m.t > e.t);
        assert.equal(later.length, 0, c.title + ": " + id + " speaks after leaving");
      }
    }
  }
});

// An export records one reaction per person per message (a new one replaces
// the old), so the demo must not show anyone reacting twice to a message.
test("no message has two reactions from the same person, and every conversation keeps its funny, disagree and custom-emoji reactions", () => {
  for (const m of allMsgs) {
    const who = (m.r || []).map((r) => r.s);
    assert.equal(new Set(who).size, who.length, "message " + m.i + " has two reactions from one person: " + JSON.stringify(m.r));
    for (const r of m.r || []) assert.notEqual(r.s, m.s, "message " + m.i + ": its sender reacts to it");
  }
  for (const c of data.conversations) {
    const rs = c.msgs.flatMap((m) => m.r || []);
    assert.ok(rs.some((r) => r.k === "funny"), c.title + " has a funny reaction");
    assert.ok(rs.some((r) => r.k === "disagree"), c.title + " has a disagree reaction");
    assert.ok(rs.some((r) => r.k === "emoji" && r.e), c.title + " has a custom-emoji reaction");
  }
});
