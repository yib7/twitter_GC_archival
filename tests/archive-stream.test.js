/*
 * Fix round 1 (review #2): the previous data.js is the accumulated history,
 * and it can be bigger than V8's ~512 MB string limit. build.js used to read
 * it with one readFileSync + JSON.parse, which can't, and it called every
 * failure "damaged" (even a file locked by antivirus) and suggested deleting
 * it. Now it is streamed one message at a time through the same scanner
 * engine as the exports, and each kind of failure gets its own message.
 */
require("./_real-data-guard.js");   // QA-2: refuse to run outside a clean checkout
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const core = require("../scripts/build-core.js");
const fsio = require("../scripts/fs-io.js");

const tmpDirs = [];
function scratch(prefix) { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); tmpDirs.push(d); return d; }
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

const META = { generatedAt: "2026-01-01T00:00:00.000Z", ignoredUsers: ["7"], ignoredGroups: ["G9"] };
const CONVS = [
  { id: "G1", type: "group", title: "T \"q\" {[", participants: ["a", "b"], count: 3,
    msgs: [{ i: "1", s: "a", t: 1, x: "é🎉 } ] \\ \"" }, { i: "2", s: "b", t: 2, x: "", m: "media/2-a.png", k: "image", mx: [{ m: "media/2-b.mp4", k: "video" }] }, { i: "3", s: "a", t: 3, x: "\n", r: [{ e: "👍", s: "b" }] }],
    events: [{ t: 1, type: "name", name: "n", s: "a" }] },
  { id: "G2", type: "group", title: null, participants: [], count: 0, msgs: [], events: [] },
];
const archiveText = (meta, convs) => [...core.archiveChunks(meta || META, convs || CONVS, 2)].join("");

function scanText(text, size) {
  const convs = [];
  const sc = core.createArchiveScanner({ onConversation: (c) => convs.push(c) });
  for (let i = 0; i < text.length; i += size) sc.push(text.slice(i, i + size));
  const res = sc.end();
  return { convs, meta: res.meta, conversations: res.conversations };
}

test("archive scanner: every conversation and message, identical to a whole-file parse, at any chunk size", () => {
  const text = archiveText();
  const whole = JSON.parse(text.replace(/^window\.CHAT_DATA = /, "").replace(/;\n$/, ""));
  for (const size of [1, 2, 3, 7, 64, text.length]) {
    const r = scanText(text, size);
    assert.deepEqual(r.convs, whole.conversations, "chunk size " + size);
    assert.deepEqual(r.meta, META, "chunk size " + size);
    assert.equal(r.conversations, 2);
  }
});

test("archive scanner: a BOM and an older single-conversation archive are accepted", () => {
  const r = scanText("\uFEFF" + archiveText(), 5);
  assert.equal(r.convs.length, 2);
  const legacy = "window.CHAT_DATA = " + JSON.stringify({ conversationId: "G5", msgs: [{ i: "1", s: "a", t: 1, x: "hi" }], events: [] }) + ";\n";
  const l = scanText(legacy, 3);
  assert.equal(l.convs.length, 0);
  assert.equal(l.meta.conversationId, "G5");
  assert.deepEqual(l.meta.msgs, [{ i: "1", s: "a", t: 1, x: "hi" }]);
});

test("archive scanner: truncated, broken or non-archive text throws an ExportScanError", () => {
  const text = archiveText();
  for (const bad of [text.slice(0, text.length >> 1), text.replace("\"msgs\":[", "\"msgs\":[,"), "hello", "", "window.CHAT_DATA = {\"conversations\":[1,2]};"]) {
    assert.throws(() => scanText(bad, 4), (e) => e instanceof core.ExportScanError, JSON.stringify(bad.slice(0, 40)));
  }
});

test("scanArchiveFile reads data.js in tiny byte chunks with identical results (streaming path)", () => {
  const dir = scratch("gca-archive-");
  const file = path.join(dir, "data.js");
  fsio.writeChunksAtomic(file, core.archiveChunks(META, CONVS, 1));
  const whole = JSON.parse(fs.readFileSync(file, "utf8").replace(/^window\.CHAT_DATA = /, "").replace(/;\n$/, ""));
  for (const chunkSize of [1, 3, 17, 1 << 20]) {
    const convs = [];
    let reads = 0;
    const res = fsio.scanArchiveFile(file, { onConversation: (c) => convs.push(c) }, { chunkSize, onChunk: () => { reads++; } });
    assert.deepEqual(convs, whole.conversations);
    assert.deepEqual(res.meta, META);
    if (chunkSize < 10) assert.ok(reads > 50, "really read piecewise (" + reads + " reads)");
  }
});

test("readArchiveMeta reads ignoredUsers / ignoredGroups from the head of data.js only", () => {
  const dir = scratch("gca-archive-meta-");
  const file = path.join(dir, "data.js");
  fsio.writeChunksAtomic(file, core.archiveChunks(META, CONVS, 1));
  assert.deepEqual(fsio.readArchiveMeta(file), META);
  assert.equal(fsio.readArchiveMeta(path.join(dir, "missing.js")), null);
  fs.writeFileSync(path.join(dir, "junk.js"), "not an archive");
  assert.equal(fsio.readArchiveMeta(path.join(dir, "junk.js")), null);
});

// ---- what the user is told for each way reading data.js can fail ----------
const errno = (code, msg) => Object.assign(new Error(msg || code), { code });
test("prevArchiveProblem: only real damage is called damaged, and deleting is never advised without a backup first", () => {
  const damaged = core.prevArchiveProblem(new core.ExportScanError("The file ends early", 10));
  assert.match(damaged, /data\.js/);
  assert.match(damaged, /damaged/);
  assert.match(damaged, /backup copy/i);
  assert.ok(damaged.search(/backup copy/i) < damaged.search(/delete/i), "backup comes before delete: " + damaged);

  for (const code of ["EBUSY", "EPERM", "EACCES"]) {
    const m = core.prevArchiveProblem(errno(code));
    assert.match(m, /data\.js/, code);
    assert.doesNotMatch(m, /damaged|delete/i, code);
    assert.match(m, /another program|permission|access/i, code);
  }
  const big = core.prevArchiveProblem(errno("ERR_STRING_TOO_LONG", "Cannot create a string longer than 0x1fffffe8 characters"));
  assert.match(big, /too large/i);
  assert.doesNotMatch(big, /damaged|delete/i);
  const oom = core.prevArchiveProblem(new RangeError("Array buffer allocation failed"));
  assert.match(oom, /memory/i);
  assert.doesNotMatch(oom, /damaged|delete/i);
  assert.equal(core.prevArchiveProblem(new TypeError("a bug")), null, "anything else is not ours to explain");
});
