require("./_real-data-guard.js");   // refuse to run outside a clean checkout
const test = require("node:test");
const assert = require("node:assert");
const { collectParticipants } = require("../scripts/build-core.js");

const DATA = {
  conversations: [
    { id: "G1", type: "group", title: "Alpha", participants: ["u1", "u2"], count: 3,
      msgs: [
        { i: "a1", s: "u1", t: 1, x: "hello world this is alpha" },
        { i: "a2", s: "u2", t: 2, x: "second alpha message here" },
        { i: "a3", s: "u1", t: 3, x: "third alpha message here", m: "media/a3.jpg", k: "img" },
      ], events: [] },
    { id: "G2", type: "group", title: "Beta", participants: ["u3"], count: 2,
      msgs: [
        { i: "b1", s: "u3", t: 1, x: "beta first message content" },
        { i: "b2", s: "u3", t: 2, x: "beta second message content" },
      ], events: [] },
  ],
};

test("collectParticipants scoped to a group returns only that group's people", () => {
  const parts = collectParticipants(DATA, "G1");
  const ids = parts.map((p) => p.id).sort();
  assert.deepStrictEqual(ids, ["u1", "u2"]);
  assert.ok(!parts.find((p) => p.id === "u3"), "u3 from G2 must not appear");
});

test("collectParticipants without a group merges everyone", () => {
  const ids = collectParticipants(DATA).map((p) => p.id).sort();
  assert.deepStrictEqual(ids, ["u1", "u2", "u3"]);
});

test("a participant's count + media are scoped to the selected group", () => {
  const u1 = collectParticipants(DATA, "G1").find((p) => p.id === "u1");
  assert.strictEqual(u1.count, 2);
  assert.strictEqual(u1.media.length, 1);
});

// people known only from the headers file (lurkers, people who joined
// or left) are in c.participants and the join/leave events but sent nothing.
// They still need a card in the wizard, or they stay "User 1234" forever.
const QUIET = {
  conversations: [
    { id: "G1", type: "group", participants: ["u1", "u9", "u8"], count: 1,
      msgs: [{ i: "a1", s: "u1", t: 5000, x: "the only message in here" }],
      events: [
        { t: 1000, type: "join", s: "u1", ids: ["u9", "u8"] },
        { t: 9000, type: "leave", ids: ["u9"] },
        { t: 9500, type: "name", s: "u1", name: "Quiet Crew" },
      ] },
    { id: "G2", type: "group", participants: ["u7"], count: 0, msgs: [], events: [] },
  ],
};

test("header-only participants get an entry with count 0, after everyone who posted", () => {
  const parts = collectParticipants(QUIET, "G1");
  assert.deepStrictEqual(parts.map((p) => p.id), ["u1", "u8", "u9"]);
  const u9 = parts.find((p) => p.id === "u9");
  assert.strictEqual(u9.count, 0);
  assert.deepStrictEqual(u9.samples, []);
  assert.deepStrictEqual(u9.media, []);
});

test("joined / left dates come from the group's events (a memory jog for naming)", () => {
  const parts = collectParticipants(QUIET, "G1");
  const u9 = parts.find((p) => p.id === "u9"), u8 = parts.find((p) => p.id === "u8");
  assert.strictEqual(u9.joined, 1000);
  assert.strictEqual(u9.left, 9000);
  assert.strictEqual(u8.joined, 1000);
  assert.strictEqual(u8.left, undefined);
});

test("the unscoped roster includes quiet members of every group", () => {
  assert.deepStrictEqual(collectParticipants(QUIET).map((p) => p.id).sort(), ["u1", "u7", "u8", "u9"]);
});
