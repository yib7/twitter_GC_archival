/*
 * SP7 fix round 1 (#2): merging an OLDER export into a newer archive. The
 * export's copy of a message used to replace the archive's unconditionally
 * (losing edits and reactions the newer archive had), the preview didn't say
 * the export was older, and the media source folder was re-pointed at the
 * older export's folder. Synthetic exports only; real server on GCA_PORT=0
 * with a mkdtemp GCA_PERSONAL (tests/_sp6-server.js).
 */
require("./_real-data-guard.js");   // QA-2: refuse to run outside a clean checkout
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const core = require("../scripts/build-core.js");
const { preflightWarnings } = require("../scripts/server-core.js");
const X = require("./fixtures/x-export.js");
const { startServer, readData } = require("./_sp6-server.js");

const tmpDirs = [];
const scratch = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "gca-older-")); tmpDirs.push(d); return d; };
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

/* ---- the accumulator: who wins when both copies exist -------------------- */
const T = X.T0;
const prevRec = (id, s, t, x, r) => Object.assign({ i: String(id), s: String(s), t, x }, r ? { r } : {});
const exportMsg = (id, s, t, x, reactions) => X.gmsg(id, s, t, x, reactions ? { reactions } : null);
function build(prevMsgs, exportMsgs) {
  const acc = core.createAccumulator({});
  acc.addPrev({ conversations: [{ id: "1000000001", type: "group", msgs: prevMsgs, events: [] }] });
  for (const m of exportMsgs) acc.addMessage("1000000001", m);
  const out = acc.finish({});
  return new Map(out.conversations[0].msgs.map((m) => [m.i, m]));
}
const keys = (m) => (m.r || []).map((r) => r.k + ":" + r.s).sort();

describe("SP7 fix 2: merging copies of the same message", () => {
  test("an OLDER export keeps the archive's text (an edit) and unions the reactions", () => {
    const got = build(
      [prevRec(1, 111, T, "edited text", [{ k: "like", s: "222" }]), prevRec(2, 111, T + 100e3, "newest in the archive")],
      [exportMsg(1, 111, T, "original text", [{ reactionKey: "funny", senderId: "333" }, { reactionKey: "like", senderId: "222" }])]);
    assert.equal(got.get("1").x, "edited text");
    assert.deepEqual(keys(got.get("1")), ["funny:333", "like:222"]);
  });

  test("a NEWER export's text wins, and the reactions are still a union", () => {
    const got = build(
      [prevRec(1, 111, T, "old text", [{ k: "like", s: "222" }])],
      [exportMsg(1, 111, T, "edited in the newer export", [{ reactionKey: "funny", senderId: "333" }]), exportMsg(2, 111, T + 100e3, "newer")]);
    assert.equal(got.get("1").x, "edited in the newer export");
    assert.deepEqual(keys(got.get("1")), ["funny:333", "like:222"]);
  });

  test("the archive's media path survives an export copy without one", () => {
    const got = build([prevRec(1, 111, T, "pic", null)].map((m) => Object.assign(m, { m: "personal_data/media/1-a.png", k: "img" })), [exportMsg(1, 111, T, "pic")]);
    assert.equal(got.get("1").m, "personal_data/media/1-a.png");
  });
});

/* ---- the warning ---------------------------------------------------------- */
const survey = { totals: { messages: 3, groups: 1 }, dm: { conversations: 0 }, removedMsgs: 0, badTime: 0 };
describe("SP7 fix 2: the preview says when the export is older than the archive", () => {
  test("its newest message is older than the archive's newest", () => {
    const w = preflightWarnings({ survey, merge: { overlap: 2, added: 1, exportNewest: Date.parse("2021-06-01T12:00:00Z"), archiveNewest: Date.parse("2021-07-01T12:00:00Z") } });
    const o = w.find((x) => x.code === "older-export");
    assert.ok(o, JSON.stringify(w));
    assert.match(o.text, /older than your archive/);
    assert.match(o.text, /2021-06-01/);
    assert.match(o.text, /2021-07-01/);
  });
  test("nothing new, only overlap", () => {
    const w = preflightWarnings({ survey, merge: { overlap: 3, added: 0, exportNewest: 5, archiveNewest: 5 } });
    assert.ok(w.some((x) => x.code === "older-export"), JSON.stringify(w));
  });
  test("a newer export gets no such warning", () => {
    const w = preflightWarnings({ survey, merge: { overlap: 2, added: 2, exportNewest: 9, archiveNewest: 5 } });
    assert.ok(!w.some((x) => x.code === "older-export"));
  });
});

/* ---- end to end over the server ------------------------------------------ */
describe("SP7 fix 2: merging export A into an archive built from the newer B", () => {
  let S, A, B;
  before(async () => {
    S = await startServer();
    B = X.writeExportB(scratch());
    A = X.writeExport(scratch(), { manifest: true });
    const r = await S.post("/api/source", { archiveRoot: B.root });
    assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
  });
  after(() => S.stop());
  const cfg = () => JSON.parse(fs.readFileSync(path.join(S.personal, "config.json"), "utf8"));

  test("the preview warns that A is older, with both newest dates", async () => {
    const r = await S.post("/api/preflight", { archiveRoot: A.root });
    const j = await r.json();
    assert.equal(r.status, 200, JSON.stringify(j));
    assert.ok(j.merge.archiveNewest > j.merge.exportNewest, JSON.stringify(j.merge));
    assert.ok(j.warnings.some((w) => w.code === "older-export"), JSON.stringify(j.warnings));
  });

  test("the merge adds A's missing messages, says it was older, and keeps B's media folder as the source", async () => {
    const before = cfg().mediaSourceDir;
    assert.equal(path.resolve(before), path.resolve(B.media));
    const r = await S.post("/api/source", { archiveRoot: A.root });
    const j = await r.json();
    assert.equal(r.status, 200, JSON.stringify(j));
    assert.equal(j.older, true);
    assert.equal(path.resolve(cfg().mediaSourceDir), path.resolve(B.media), "not re-pointed at the older export's folder");
    const ids = readData(S.personal).conversations.find((c) => String(c.id) === "1000000001").msgs.map((m) => String(m.i)).sort();
    assert.deepEqual(ids, ["9001", "9002", "9003", "9004", "9005", "9006", "9007", "9008"]);
  });
});

// SP7 fix round 2 (#4): after an older export is merged, config's message
// files are the older export's, but the media source folder is still the
// newer one's. Un-removing restored media from that folder only for message
// ids in the older export's files, so the newer export's removed media
// (9008, only in B) never came back. The ids come from the archive and the
// quarantine now.
describe("SP7 fix round 2: un-removing after an older merge restores the newer export's media", () => {
  let S, B;
  before(async () => { S = await startServer(); B = X.writeExportB(scratch()); });
  after(() => S.stop());
  const identity = (ignoredUsers) => S.post("/api/identity", { names: {}, pfps: {}, gc: {}, ignoredUsers, ignoredGroups: [] });
  const M = (n) => path.join(S.personal, "media", n);

  test("333 removed before B is built: B's 9008 media is never copied", async () => {
    assert.equal((await identity(["333"])).status, 200);
    const r = await S.post("/api/source", { archiveRoot: B.root });
    assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
    assert.ok(!fs.existsSync(M("9008-Removed.png")));
  });

  test("merge the older A, then un-remove 333: 9008's media comes back from B's folder", async () => {
    const r = await S.post("/api/source", { archiveRoot: X.writeExport(scratch(), { manifest: true }).root });
    const j = await r.json();
    assert.equal(r.status, 200, JSON.stringify(j));
    assert.equal(j.older, true);
    const u = await identity([]);
    assert.equal(u.status, 200, JSON.stringify(await u.clone().json()));
    assert.ok(readData(S.personal).conversations.some((c) => c.msgs.some((m) => String(m.i) === "9008")), "9008 is back in the archive");
    assert.equal(fs.existsSync(M("9008-Removed.png")) && fs.readFileSync(M("9008-Removed.png"), "utf8"), "png-removed");
  });
});
