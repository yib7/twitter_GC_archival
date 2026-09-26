require("./_real-data-guard.js");   // QA-2: refuse to run outside a clean checkout
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
