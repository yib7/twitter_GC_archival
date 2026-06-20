const { test } = require("node:test");
const assert = require("node:assert");
const { assembleConversations } = require("../scripts/build-core.js");

// Two synthetic group conversations, each with one message + one media file.
function fixtures() {
  const exportDatas = [[
    { dmConversation: { conversationId: "G1", messages: [
      { messageCreate: { id: "m1", senderId: "u1", createdAt: "2020-01-01T00:00:00.000Z", text: "hello from group one" } },
    ] } },
    { dmConversation: { conversationId: "G2", messages: [
      { messageCreate: { id: "m2", senderId: "u2", createdAt: "2020-01-02T00:00:00.000Z", text: "hello from group two" } },
    ] } },
  ]];
  const mediaIndex = { m1: "personal_data/media/m1-a.png", m2: "personal_data/media/m2-b.png" };
  return { exportDatas, mediaIndex };
}

test("without ignoredGroups, both groups are assembled", () => {
  const { exportDatas, mediaIndex } = fixtures();
  const out = assembleConversations({ exportDatas, mediaIndex });
  assert.deepEqual(out.conversations.map((c) => c.id).sort(), ["G1", "G2"]);
});

test("ignoredGroups drops the whole conversation (messages + media)", () => {
  const { exportDatas, mediaIndex } = fixtures();
  const out = assembleConversations({ exportDatas, mediaIndex, ignoredGroups: ["G2"] });
  assert.deepEqual(out.conversations.map((c) => c.id), ["G1"]);
  // none of G2's message ids survive anywhere
  const ids = out.conversations.flatMap((c) => c.msgs.map((m) => m.i));
  assert.ok(!ids.includes("m2"), "G2 message excluded");
  // G2's media path is never referenced in the output
  assert.ok(!JSON.stringify(out).includes("m2-b.png"), "G2 media not referenced");
  // G1 is intact, with its media resolved
  assert.equal(out.conversations[0].count, 1);
  assert.equal(out.conversations[0].msgs[0].m, "personal_data/media/m1-a.png");
});
