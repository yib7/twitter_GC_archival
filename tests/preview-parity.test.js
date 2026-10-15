/*
 * the preview's numbers are the build's numbers. The
 * survey counted a message id twice when two part files both carried it,
 * counted a group whose every message is removed as a group to import, and
 * the build's own media check didn't know the media the archive already has
 * (so it refused a folder the preview had accepted). Synthetic exports only;
 * real servers on GCA_PORT=0 with a mkdtemp GCA_PERSONAL.
 */
require("./_real-data-guard.js");   // refuse to run outside a clean checkout
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const core = require("../scripts/build-core.js");
const X = require("./fixtures/x-export.js");
const { startServer } = require("./_sp6-server.js");

const tmpDirs = [];
const scratch = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "gca-parity-")); tmpDirs.push(d); return d; };
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

describe("the survey counts what the build keeps", () => {
  const feed = (sv, convs) => {
    // the same calls the streaming scanner makes, one message at a time
    const s = sv.sink("messages");
    let ci = 0;
    for (const c of convs) {
      s.handlers.onConversationId(ci, c.dmConversation.conversationId);
      for (const m of c.dmConversation.messages) s.handlers.onMessage(ci, m);
      ci++;
    }
    s.finish();
    return sv.result();
  };

  test("a message id in two part files is one message", () => {
    const sv = core.createExportSurvey({});
    const r = feed(sv, [
      X.conv("1000000001", [X.gmsg(1, 111, X.T0, "a"), X.gmsg(2, 111, X.T0 + 1000, "b")]),
      X.conv("1000000001", [X.gmsg(2, 111, X.T0 + 1000, "b"), X.gmsg(3, 222, X.T0 + 2000, "c")]),
    ]);
    assert.equal(r.groups[0].count, 3);
    assert.equal(r.totals.messages, 3);
  });

  test("a group whose every message is from a removed person isn't a group to import", () => {
    const sv = core.createExportSurvey({ ignoredUsers: ["333"] });
    const r = feed(sv, [
      X.conv("1000000001", [X.gmsg(1, 111, X.T0, "a")]),
      X.conv("1000000002", [X.gmsg(2, 333, X.T0, "only the removed person")]),
    ]);
    assert.equal(r.totals.groups, 1);
    assert.equal(r.totals.messages, 1);
  });
});

describe("preview numbers equal the built archive's", () => {
  let S;
  before(async () => { S = await startServer(); });
  after(() => S.stop());
  const preview = async (body) => { const r = await S.post("/api/preflight", body); const j = await r.json(); assert.equal(r.status, 200, JSON.stringify(j)); return j; };
  const build = async (body) => { const r = await S.post("/api/source", body); const j = await r.json(); assert.equal(r.status, 200, JSON.stringify(j)); return j; };

  test("export A: messages, groups and each group's count", async () => {
    const A = X.writeExport(scratch(), { manifest: true });
    const p = await preview({ archiveRoot: A.root });
    const b = await build({ archiveRoot: A.root });
    assert.equal(p.totals.messages, b.totalMsgs);
    assert.equal(p.totals.groups, b.groups.length);
    for (const g of b.groups) assert.equal(p.groups.find((x) => x.id === String(g.id)).count, g.count, g.id);
  });

  test("A + B: what the archive has plus what B adds is the merged archive", async () => {
    const B = X.writeExportB(scratch());
    const p = await preview({ archiveRoot: B.root });
    const b = await build({ archiveRoot: B.root });
    assert.equal(p.merge.existingMsgs + p.merge.added, b.totalMsgs);
    assert.equal(p.merge.existingGroups + p.merge.newGroups, b.groups.length);
    assert.equal(b.added, p.merge.added);
  });

  test("a media folder holding only media the archive already has: accepted by the preview AND the build", async () => {
    const root = scratch();
    const data = path.join(root, "data"), media = path.join(data, "direct_messages_group_media");
    fs.mkdirSync(media, { recursive: true });
    const t = X.T0 + 90 * 86400e3;
    fs.writeFileSync(path.join(data, "direct-messages-group.js"), X.ytd("direct_messages_group", "part0", [X.conv("1000000001", [X.gmsg(9401, 111, t, "newest")])]));
    fs.writeFileSync(path.join(data, "direct-message-group-headers.js"), X.ytd("direct_message_group_headers", "part0", [X.conv("1000000001", [X.hmsg(9401, 111, t)])]));
    fs.writeFileSync(path.join(media, "9002-AbCdEf.png"), "png-1");   // a message only the archive has
    const p = await preview({ archiveRoot: root });
    assert.equal(p.media.known, 1);
    const b = await build({ archiveRoot: root });
    assert.equal(b.added, 1);
  });
});
