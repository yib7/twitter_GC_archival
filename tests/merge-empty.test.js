/*
 * SP7 fix round 1 (#5): an export with no group messages can't be merged.
 * The build used to accept it (the archive's own groups satisfied its "any
 * group chats?" check), re-point config at the empty export and prune the
 * previous export's copies from personal_data/source/. Real server
 * (GCA_PORT=0, mkdtemp GCA_PERSONAL); synthetic exports only.
 */
require("./_real-data-guard.js");   // QA-2: refuse to run outside a clean checkout
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const X = require("./fixtures/x-export.js");
const { startServer } = require("./_sp6-server.js");

const tmpDirs = [];
const scratch = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "gca-merge-empty-")); tmpDirs.push(d); return d; };
let S;
before(async () => { S = await startServer(); });
after(() => { S.stop(); for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

// A group chat with a name change and nothing else, plus a 1:1 conversation.
function writeEmptyExport(root) {
  const data = path.join(root, "data");
  fs.mkdirSync(path.join(data, "direct_messages_group_media"), { recursive: true });
  const ev = { conversationNameUpdate: { initiatingUserId: "111", name: "Renamed", createdAt: X.iso(X.T0 + 90 * 86400e3) } };
  fs.writeFileSync(path.join(data, "direct-messages-group.js"), X.ytd("direct_messages_group", "part0", [X.conv("1000000001", [ev]), X.conv("111-222", [X.gmsg(8009, 111, X.T0, "1:1 only")])]));
  fs.writeFileSync(path.join(data, "direct-message-group-headers.js"), X.ytd("direct_message_group_headers", "part0", [X.conv("1000000001", [ev])]));
  return root;
}

test("a merge of an export with no group messages is refused, and nothing changes", async () => {
  const A = X.writeExport(scratch(), { manifest: true });
  assert.equal((await S.post("/api/source", { archiveRoot: A.root })).status, 200);
  const P = (...p) => path.join(S.personal, ...p);
  const cfg0 = fs.readFileSync(P("config.json"), "utf8");
  const data0 = fs.readFileSync(P("data.js"));
  const src0 = fs.readdirSync(P("source")).sort();
  const r = await S.post("/api/source", { archiveRoot: writeEmptyExport(scratch()) });
  const j = await r.json();
  assert.equal(r.status, 422, JSON.stringify(j));
  assert.match(j.error, /no group chat messages/i);
  assert.equal(fs.readFileSync(P("config.json"), "utf8"), cfg0, "config isn't re-pointed");
  assert.deepEqual(fs.readFileSync(P("data.js")), data0);
  assert.deepEqual(fs.readdirSync(P("source")).sort(), src0, "the previous export's copies aren't pruned");
});
