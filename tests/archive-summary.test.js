/*
 * the setup server used to parse the whole
 * built archive (every message body) into its default heap for /api/status,
 * /api/parts, /api/removal-preview and the identity save. These tests pin the
 * streaming readers that replace it: a summary reader that keeps no message
 * at all, and a fold that hands each message to small collectors and drops
 * it, giving exactly what the old whole-archive functions gave.
 */
require("./_real-data-guard.js");   // refuse to run outside a clean checkout
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const core = require("../scripts/build-core.js");
const fsio = require("../scripts/fs-io.js");
const sc = require("../scripts/server-core.js");

const tmpDirs = [];
function scratch() { const d = fs.mkdtempSync(path.join(os.tmpdir(), "gca-summary-")); tmpDirs.push(d); return d; }
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

const META = { generatedAt: "2026-01-01T00:00:00.000Z", ignoredUsers: [], ignoredGroups: [] };
const CONVS = [
  { id: "G1", type: "group", title: "Crew", participants: ["a", "b", "c"], count: 4,
    msgs: [
      { i: "1", s: "a", t: 1, x: "a long enough sample message one" },
      { i: "2", s: "b", t: 2, x: "", m: "personal_data/media/2-a.png", k: "img", mx: [{ m: "personal_data/media/2-b.mp4", k: "vid" }] },
      { i: "3", s: "a", t: 3, x: "https://t.co/xyz is a link only" },
      { i: "4", s: "c", t: 4, x: "another long enough sample here", m: "personal_data/media/4-c.jpg", k: "img" },
    ],
    events: [{ t: 0, type: "join", ids: ["d"] }, { t: 5, type: "leave", ids: ["c"] }] },
  { id: "G2", type: "group", title: "Other", participants: ["a", "e"], count: 2,
    msgs: [{ i: "5", s: "e", t: 1, x: "message in the second group chat", m: "personal_data/media/5-e.gif", k: "img" }, { i: "6", s: "a", t: 2, x: "short" }],
    events: [] },
];
function writeArchive(convs) {
  const f = path.join(scratch(), "data.js");
  fs.writeFileSync(f, [...core.archiveChunks(META, convs || CONVS, 2)].join(""));
  return f;
}
const DATA = { conversations: CONVS };

test("archive scanner with onMessage streams each message and keeps none on the conversation", () => {
  const text = [...core.archiveChunks(META, CONVS, 2)].join("");
  const seen = [], convs = [];
  for (const size of [1, 7, 64, text.length]) {
    seen.length = 0; convs.length = 0;
    const s = core.createArchiveScanner({ onMessage: (c, m) => seen.push(c.id + ":" + m.i), onConversation: (c) => convs.push(c) });
    for (let i = 0; i < text.length; i += size) s.push(text.slice(i, i + size));
    s.end();
    assert.deepEqual(seen, ["G1:1", "G1:2", "G1:3", "G1:4", "G2:5", "G2:6"], "chunk size " + size);
    assert.deepEqual(convs.map((c) => c.id), ["G1", "G2"]);
    for (const c of convs) assert.ok(!("msgs" in c), "no message list is kept");
    assert.deepEqual(convs[0].participants, ["a", "b", "c"]);
    assert.equal(convs[0].events.length, 2);
  }
});

test("readArchiveSummary gives ids, titles, counts and participants without any message", () => {
  const f = writeArchive();
  const sum = fsio.readArchiveSummary(f, { chunkSize: 5 });
  assert.deepEqual(sum.meta, META);
  assert.deepEqual(sum.conversations, [
    { id: "G1", type: "group", title: "Crew", participants: ["a", "b", "c"], count: 4 },
    { id: "G2", type: "group", title: "Other", participants: ["a", "e"], count: 2 },
  ]);
});

test("foldArchive: the streaming collectors give exactly what the whole-archive functions give", () => {
  const f = writeArchive();
  for (const chunkSize of [3, 1 << 20]) {
    const removal = sc.createRemovalCounter(["G2"], ["c"]);
    const owners = sc.createOwnersCollector(["G2"], ["c"]);
    const refs = sc.createReferencedNames();
    const partsG1 = core.createParticipantCollector("G1");
    const partsAll = core.createParticipantCollector("");
    fsio.foldArchive(f, [removal, owners, refs, partsG1, partsAll], { chunkSize });
    assert.deepEqual(removal.result(), sc.removalPreview(DATA, ["G2"], ["c"]));
    assert.deepEqual([...owners.result()], [...sc.removedMediaOwners(DATA, ["G2"], ["c"])]);
    assert.deepEqual([...refs.result()].sort(), [...sc.referencedMediaNames(DATA)].sort());
    assert.deepEqual(partsG1.result(), core.collectParticipants(DATA, "G1"));
    assert.deepEqual(partsAll.result(), core.collectParticipants(DATA));
  }
});

test("the old whole-archive functions still work on an in-memory archive (they now fold the same collectors)", () => {
  assert.deepEqual(sc.removalPreview(DATA, ["G2"], []), { messages: 2, media: 1, groups: 1, people: 0 });
  assert.deepEqual([...sc.referencedMediaNames(DATA)].sort(), ["2-a.png", "2-b.mp4", "4-c.jpg", "5-e.gif"]);
  assert.equal(core.collectParticipants(DATA, "G1").find((p) => p.id === "d").count, 0, "a joiner with no messages keeps a card");
});

// the wizard's People step labels an unnamed person with the viewer's
// "User N" for that chat (shared-core userLabels), streamed or in memory.
test("participants carry the chat's User N label, ignored people none", () => {
  const f = writeArchive();
  const label = (parts) => Object.fromEntries(parts.map((p) => [p.id, p.label]));
  for (const chunkSize of [3, 1 << 20]) {
    const plain = core.createParticipantCollector("G1");
    const ign = core.createParticipantCollector("G1", { ignoredUsers: ["c"] });
    fsio.foldArchive(f, [plain, ign], { chunkSize });
    assert.deepEqual(label(plain.result()), { a: "User 1", b: "User 2", c: "User 3", d: "User 4" });
    assert.deepEqual(label(ign.result()), { a: "User 1", b: "User 2", c: undefined, d: "User 3" });
  }
  const shared = require("../src/shared-core.js");
  assert.deepEqual(label(core.collectParticipants(DATA, "G1")), shared.userLabels(CONVS[0]));
});
