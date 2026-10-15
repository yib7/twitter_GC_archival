/*
 * Unit tests for the pure archive-assembly core (scripts/build-core.js).
 *
 * These exercise the most complex, most breakable logic in the project —
 * dedupe, chronological sort, merge-accumulation, headers-only roster folding,
 * media resolution, 1:1-DM exclusion, ignoredUsers, and title derivation —
 * WITHOUT any filesystem I/O, so they never touch the real personal_data/.
 *
 * Run: npm run test:unit   (node --test)
 */
require("./_real-data-guard.js");   // refuse to run outside a clean checkout
const { test } = require("node:test");
const assert = require("node:assert/strict");

const { assembleConversations, isGroupId, kindOf, rawToRec } = require("../scripts/build-core.js");

// ---- helpers to build tiny synthetic export payloads ----------------------
const iso = (s) => new Date(s).toISOString();
function msg(id, senderId, createdAt, text, extra) {
  return { messageCreate: Object.assign({ id, senderId, createdAt: iso(createdAt), text }, extra || {}) };
}
function nameEvent(createdAt, initiatingUserId, name) {
  return { conversationNameUpdate: { createdAt: iso(createdAt), initiatingUserId, name } };
}
function joinEvent(createdAt, initiatingUserId, userIds) {
  return { participantsJoin: { createdAt: iso(createdAt), initiatingUserId, userIds } };
}
function conv(conversationId, messages) {
  return { dmConversation: { conversationId, messages } };
}
// assembleConversations with sensible defaults
function assemble(opts) {
  return assembleConversations(Object.assign(
    { prev: null, exportDatas: [], headerDatas: [], mediaIndex: {}, ignoredUsers: [] },
    opts
  ));
}
const onlyGroup = (res, id) => res.conversations.find((c) => c.id === id);

// ---- pure helpers ----------------------------------------------------------
test("isGroupId: numeric id is a group, {a}-{b} is a 1:1 DM", () => {
  assert.equal(isGroupId("123456"), true);
  assert.equal(isGroupId("100-200"), false);
});

test("kindOf maps extension to img/vid/file", () => {
  assert.equal(kindOf("a.jpg"), "img");
  assert.equal(kindOf("a.MP4"), "vid");
  assert.equal(kindOf("a.txt"), "file");
});

// ---- dedupe ----------------------------------------------------------------
test("dedupes messages by id across multiple exports (last write wins)", () => {
  const res = assemble({
    exportDatas: [
      [conv("G1", [msg("m1", "u1", "2020-05-01T10:00:00Z", "first")])],
      [conv("G1", [msg("m1", "u1", "2020-05-01T10:00:00Z", "edited")])],
    ],
  });
  const g = onlyGroup(res, "G1");
  assert.equal(g.count, 1);
  assert.equal(g.msgs.length, 1);
  assert.equal(g.msgs[0].x, "edited");
});

// ---- chronological sort ----------------------------------------------------
test("sorts messages chronologically by time", () => {
  const res = assemble({
    exportDatas: [[conv("G1", [
      msg("m2", "u1", "2020-05-01T12:00:00Z", "later"),
      msg("m1", "u2", "2020-05-01T10:00:00Z", "earlier"),
      msg("m3", "u1", "2020-05-01T14:00:00Z", "latest"),
    ])]],
  });
  const g = onlyGroup(res, "G1");
  assert.deepEqual(g.msgs.map((m) => m.i), ["m1", "m2", "m3"]);
});

// ---- merge accumulation ----------------------------------------------------
test("accumulates history from the previous build baseline", () => {
  const prev = {
    conversations: [
      { id: "G1", type: "group", title: "G", participants: ["u1"], count: 1,
        msgs: [{ i: "m1", s: "u1", t: Date.parse("2020-05-01T10:00:00Z"), x: "old" }], events: [] },
    ],
  };
  const res = assemble({
    prev,
    exportDatas: [[conv("G1", [msg("m2", "u2", "2020-05-02T10:00:00Z", "new")])]],
  });
  const g = onlyGroup(res, "G1");
  assert.equal(g.count, 2);
  assert.deepEqual(g.msgs.map((m) => m.i), ["m1", "m2"]);
  assert.equal(res.prevCount, 1);
});

// ---- headers-only roster folding -------------------------------------------
test("headers fold in roster participants + events without adding messages", () => {
  const res = assemble({
    exportDatas: [[conv("G1", [msg("m1", "u1", "2020-05-01T10:00:00Z", "hi")])]],
    headerDatas: [[conv("G1", [
      joinEvent("2020-04-30T10:00:00Z", "u1", ["u2", "u3"]),
      msg("h1", "u4", "2020-05-01T09:00:00Z", ""), // header messageCreate → roster only
    ])]],
  });
  const g = onlyGroup(res, "G1");
  assert.equal(g.count, 1, "headers must not add messages");
  for (const id of ["u1", "u2", "u3", "u4"]) {
    assert.ok(g.participants.includes(id), `roster should include ${id}`);
  }
});

// ---- media resolution ------------------------------------------------------
test("resolves local media by {messageId} filename prefix", () => {
  const res = assemble({
    exportDatas: [[conv("G1", [
      msg("m1", "u1", "2020-05-01T10:00:00Z", "pic"),
      msg("m2", "u1", "2020-05-01T11:00:00Z", "no media"),
    ])]],
    mediaIndex: { m1: "personal_data/media/m1-abc.jpg" },
  });
  const g = onlyGroup(res, "G1");
  const m1 = g.msgs.find((m) => m.i === "m1");
  const m2 = g.msgs.find((m) => m.i === "m2");
  assert.equal(m1.m, "personal_data/media/m1-abc.jpg");
  assert.equal(m1.k, "img");
  assert.equal(m2.m, undefined);
  assert.equal(res.totalMedia, 1);
});

// ---- 1:1 DM exclusion ------------------------------------------------------
test("skips 1:1 DM conversations, keeps groups", () => {
  const res = assemble({
    exportDatas: [[
      conv("100-200", [msg("d1", "100", "2020-05-01T10:00:00Z", "dm")]),
      conv("G1", [msg("m1", "u1", "2020-05-01T10:00:00Z", "group")]),
    ]],
  });
  assert.equal(res.conversations.length, 1);
  assert.equal(res.conversations[0].id, "G1");
});

// ---- ignoredUsers ----------------------------------------------------------
test("drops messages + roster entries from ignoredUsers", () => {
  const res = assemble({
    exportDatas: [[conv("G1", [
      msg("m1", "u1", "2020-05-01T10:00:00Z", "keep"),
      msg("m2", "bot", "2020-05-01T11:00:00Z", "drop me"),
    ])]],
    ignoredUsers: ["bot"],
  });
  const g = onlyGroup(res, "G1");
  assert.equal(g.count, 1);
  assert.deepEqual(g.msgs.map((m) => m.s), ["u1"]);
  assert.ok(!g.participants.includes("bot"));
});

// ---- custom-emoji reaction capture ----------------------------------
// X represents an arbitrary-emoji DM reaction with reactionKey:"emoji" and the
// real glyph in a separate field (assumed `emojiReaction` per X's documented
// export schema — NOT verified against a real reaction object; flagged for
// human verification). rawToRec must capture it into rec.r[i].e so the UI can
// render the actual glyph instead of collapsing every custom emoji into one
// generic placeholder.
test("rawToRec captures the custom-emoji glyph (r.emojiReaction) only when reactionKey is 'emoji'", () => {
  const rec = rawToRec({
    id: "m1", senderId: "u1", createdAt: iso("2020-05-01T10:00:00Z"), text: "hi",
    reactions: [
      { reactionKey: "emoji", emojiReaction: "🎉", senderId: "u2" },
      { reactionKey: "funny", senderId: "u3" },
    ],
  });
  assert.deepEqual(rec.r[0], { k: "emoji", s: "u2", e: "🎉" });
  assert.deepEqual(rec.r[1], { k: "funny", s: "u3" });
  assert.equal("e" in rec.r[1], false, "non-emoji reactions must not gain an `e` field");
});

test("rawToRec falls back to r.emoji when r.emojiReaction is absent (defensive)", () => {
  const rec = rawToRec({
    id: "m2", senderId: "u1", createdAt: iso("2020-05-01T10:00:00Z"), text: "hi",
    reactions: [{ reactionKey: "emoji", emoji: "🥳", senderId: "u2" }],
  });
  assert.equal(rec.r[0].e, "🥳");
});

test("rawToRec: an 'emoji' reaction with no glyph field at all gets no `e`", () => {
  const rec = rawToRec({
    id: "m3", senderId: "u1", createdAt: iso("2020-05-01T10:00:00Z"), text: "hi",
    reactions: [{ reactionKey: "emoji", senderId: "u2" }],
  });
  assert.equal("e" in rec.r[0], false);
});

// ---- title derivation ------------------------------------------------------
test("title is the most recent name event, else 'Group <last4>'", () => {
  const named = assemble({
    exportDatas: [[conv("G1", [
      msg("m1", "u1", "2020-05-01T10:00:00Z", "hi"),
      nameEvent("2020-05-02T10:00:00Z", "u1", "First Name"),
      nameEvent("2020-05-03T10:00:00Z", "u1", "Latest Name"),
    ])]],
  });
  assert.equal(onlyGroup(named, "G1").title, "Latest Name");

  const unnamed = assemble({
    exportDatas: [[conv("987654", [msg("m1", "u1", "2020-05-01T10:00:00Z", "hi")])]],
  });
  assert.equal(onlyGroup(unnamed, "987654").title, "Group 7654");
});

// ---- merges keep silent participants; bad timestamps are skipped -----
test("a merge keeps header-only participants from the previous build", () => {
  const prev = {
    conversations: [
      { id: "G1", type: "group", title: "G", participants: ["u1", "lurker"], count: 1,
        msgs: [{ i: "m1", s: "u1", t: Date.parse("2020-05-01T10:00:00Z"), x: "old" }], events: [] },
    ],
  };
  // a newer export that comes WITHOUT a headers file
  const res = assemble({ prev, exportDatas: [[conv("G1", [msg("m2", "u2", "2020-05-02T10:00:00Z", "new")])]] });
  const g = onlyGroup(res, "G1");
  assert.ok(g.participants.includes("lurker"), "the lurker known only from the earlier headers must survive the merge");
  assert.ok(g.participants.includes("u2"));
});

test("a removed (ignored) user is not resurrected from the previous roster", () => {
  const prev = { conversations: [{ id: "G1", type: "group", participants: ["u1", "gone"], msgs: [{ i: "m1", s: "u1", t: 1, x: "a" }], events: [] }] };
  const res = assemble({ prev, ignoredUsers: ["gone"] });
  assert.deepEqual(onlyGroup(res, "G1").participants, ["u1"]);
});

test("a message or event with an unparseable createdAt is skipped and counted, never stored as NaN/null", () => {
  const res = assemble({
    exportDatas: [[conv("G1", [
      msg("m1", "u1", "2020-05-01T10:00:00Z", "fine"),
      { messageCreate: { id: "m2", senderId: "u1", createdAt: "not a date", text: "bad time" } },
      { messageCreate: { id: "m3", senderId: "u1", text: "no time at all" } },
      { conversationNameUpdate: { createdAt: "garbage", initiatingUserId: "u1", name: "Nope" } },
    ])]],
  });
  const g = onlyGroup(res, "G1");
  assert.deepEqual(g.msgs.map((m) => m.i), ["m1"]);
  assert.ok(g.msgs.every((m) => Number.isFinite(m.t)));
  assert.equal(g.events.length, 0);
  assert.equal(res.warnings.badTime, 3);
});

test("a message with no senderId is skipped and counted; no null joins the roster", () => {
  const res = assemble({
    exportDatas: [[conv("G1", [
      msg("m1", "5", "2020-05-01T10:00:00Z", "fine"),
      { messageCreate: { id: "m2", createdAt: iso("2020-05-01T10:01:00Z"), text: "who sent this" } },
      { messageCreate: { id: "m3", senderId: null, createdAt: iso("2020-05-01T10:02:00Z"), text: "nobody" } },
      { messageCreate: { id: "m4", senderId: "", createdAt: iso("2020-05-01T10:03:00Z"), text: "blank" } },
    ])]],
  });
  const g = onlyGroup(res, "G1");
  assert.deepEqual(g.msgs.map((m) => m.i), ["m1"]);
  assert.deepEqual(g.participants, ["5"]);
  assert.equal(res.warnings.noSender, 3);
});

// ---- every media file of a message is kept --------------------------
test("indexMediaFiles groups ALL files per message id, sorted, ignoring non-matching names", () => {
  const { indexMediaFiles } = require("../scripts/build-core.js");
  const idx = indexMediaFiles(["9002-b.jpg", "9002-a.png", "notes.txt", "9101-c.mp4", "-bad.png"], "personal_data/media");
  assert.deepEqual(idx, {
    9002: ["personal_data/media/9002-a.png", "personal_data/media/9002-b.jpg"],
    9101: ["personal_data/media/9101-c.mp4"],
  });
});

test("a message with several media files keeps the first as m/k and the rest in mx", () => {
  const res = assemble({
    exportDatas: [[conv("G1", [msg("m1", "u1", "2020-05-01T10:00:00Z", "two pics"), msg("m2", "u1", "2020-05-01T11:00:00Z", "one")])]],
    mediaIndex: { m1: ["personal_data/media/m1-a.png", "personal_data/media/m1-b.mp4", "personal_data/media/m1-c.pdf"], m2: ["personal_data/media/m2-x.jpg"] },
  });
  const [m1, m2] = onlyGroup(res, "G1").msgs;
  assert.equal(m1.m, "personal_data/media/m1-a.png");
  assert.equal(m1.k, "img");
  assert.deepEqual(m1.mx, [{ m: "personal_data/media/m1-b.mp4", k: "vid" }, { m: "personal_data/media/m1-c.pdf", k: "file" }]);
  assert.equal(m2.m, "personal_data/media/m2-x.jpg");
  assert.equal("mx" in m2, false, "a single file adds no mx");
  assert.equal(res.totalMedia, 2, "media counts messages with media");
});

// ---- multi-part exports ---------------------------------------------
test("exportPartFiles finds every -partN sibling of the chosen file, in part order", () => {
  const { exportPartFiles } = require("../scripts/build-core.js");
  const dir = ["account.js", "direct-messages-group-part2.js", "direct-messages-group.js", "direct-messages-group-part1.js",
    "direct-message-group-headers.js", "direct-message-group-headers-part1.js", "direct-messages.js", "direct-messages-part1.js"];
  assert.deepEqual(exportPartFiles(dir, "direct-messages-group.js"),
    ["direct-messages-group.js", "direct-messages-group-part1.js", "direct-messages-group-part2.js"]);
  // picking any part finds the whole family
  assert.deepEqual(exportPartFiles(dir, "direct-messages-group-part2.js"),
    ["direct-messages-group.js", "direct-messages-group-part1.js", "direct-messages-group-part2.js"]);
  assert.deepEqual(exportPartFiles(dir, "direct-message-group-headers.js"),
    ["direct-message-group-headers.js", "direct-message-group-headers-part1.js"]);
  // other plausible spellings: _partN, .partN, zero-padded, upper case
  assert.deepEqual(exportPartFiles(["direct-messages-group.js", "direct-messages-group_part01.js", "Direct-Messages-Group.part2.js"], "direct-messages-group.js"),
    ["direct-messages-group.js", "direct-messages-group_part01.js", "Direct-Messages-Group.part2.js"]);
  // a renamed file has no family: just itself
  assert.deepEqual(exportPartFiles(dir, "my-export.js"), ["my-export.js"]);
});

test("headers that list message ids with no body are counted (missing part files?)", () => {
  const res = assemble({
    exportDatas: [[conv("G1", [msg("m1", "u1", "2020-05-01T10:00:00Z", "a")])]],
    headerDatas: [[conv("G1", [msg("m1", "u1", "2020-05-01T10:00:00Z", ""), msg("m2", "u2", "2020-05-01T11:00:00Z", ""), msg("m3", "u2", "2020-05-01T12:00:00Z", "")])]],
  });
  assert.equal(res.warnings.missingBodies, 2);
});
