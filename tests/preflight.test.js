/*
 * Pre-flight preview: what an export holds and what to warn about, before
 * anything is written. The survey streams the export one message at a time;
 * the server endpoint is read-only (personal_data/ is byte-for-byte the same
 * afterwards). Synthetic exports only (tests/fixtures/x-export.js); every
 * server on GCA_PORT=0 with a mkdtemp GCA_PERSONAL (tests/_sp6-server.js).
 */
require("./_real-data-guard.js");   // refuse to run outside a clean checkout
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const core = require("../scripts/build-core.js");
const { preflightWarnings } = require("../scripts/server-core.js");
const { scanExportFile } = require("../scripts/fs-io.js");
const X = require("./fixtures/x-export.js");
const { startServer } = require("./_sp6-server.js");

const tmpDirs = [];
function scratch(prefix) { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix || "gca-preflight-")); tmpDirs.push(d); return d; }
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });
const codes = (j) => j.warnings.map((w) => w.code);
const files3 = (f) => ({ groupJs: f.group, headersJs: f.headers, mediaDir: f.media });
// every file under a folder: relative path → sha256 (and folders as "dir")
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name), rel = path.relative(dir, p);
      if (e.isDirectory()) { out[rel] = "dir"; walk(p); }
      else out[rel] = crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
    }
  };
  walk(dir);
  return out;
}

/* ---- the survey (pure) --------------------------------------------------- */
function survey(f, opts) {
  const sv = core.createExportSurvey(opts);
  for (const file of [f.group, f.part1]) { const s = sv.sink("messages"); scanExportFile(file, s.handlers); s.finish(); }
  const h = sv.sink("headers"); scanExportFile(f.headers, h.handlers); h.finish();
  return sv;
}
test("the survey counts each group's messages, dates and people (the headers' lurkers too) and leaves 1:1 DMs out", () => {
  const sv = survey(X.writeExport(scratch()));
  const r = sv.result();
  const g1 = r.groups.find((g) => g.id === "1000000001"), g2 = r.groups.find((g) => g.id === "1000000002");
  assert.equal(g1.count, 5);
  assert.equal(g1.title, "Synthetic Crew");
  assert.equal(g1.participants, 4, "111, 222, 333 and the lurker 444");
  assert.equal(g1.first, X.T0);
  assert.equal(g1.last, X.T0 + 240e3);
  assert.equal(g2.count, 2);
  assert.deepEqual(r.totals, { groups: 2, messages: 7, participants: 5, first: X.T0, last: X.T0 + 240e3 });
  assert.deepEqual(r.dm, { conversations: 1, messages: 1 });
  assert.equal(sv.allIds.size, 7);
  assert.ok(!sv.allIds.has("8001"), "a 1:1 message id is never collected");
});

test("the survey leaves removed people's and groups' messages out of the counts", () => {
  const sv = survey(X.writeExport(scratch()), { ignoredUsers: ["222"], ignoredGroups: ["1000000002"] });
  const res = sv.result();
  assert.equal(res.totals.messages, 3, "9001, 9003, 9004");
  assert.equal(res.totals.groups, 1);
  assert.equal(res.removedMsgs, 4);
  assert.equal(sv.keepIds.size, 3);
  assert.equal(sv.allIds.size, 7);
});

test("a group's people count leaves removed people out, like the totals", () => {
  const r = survey(X.writeExport(scratch()), { ignoredUsers: ["333"] }).result();
  const g1 = r.groups.find((g) => g.id === "1000000001");
  assert.equal(g1.participants, 3, "111, 222 and the lurker 444; 333 is removed");
  assert.equal(r.totals.participants, 4);
});

test("preflightWarnings words each finding once, in reading order", () => {
  const sv = { totals: { messages: 0 }, removedMsgs: 2, badTime: 1, dm: { conversations: 1, messages: 3 } };
  const w = preflightWarnings({ swapped: true, notes: [{ code: "dm-file" }, { code: "no-media" }], missingParts: ["direct-messages-group-part1.js"], survey: sv, media: { unmatched: 4 }, merge: { overlap: 5 } });
  assert.deepEqual(w.map((x) => x.code), ["zero-messages", "swapped", "missing-parts", "no-media", "dm-ignored", "unmatched-media", "overlap", "removed", "bad-time"]);
  assert.ok(w.every((x) => typeof x.text === "string" && x.text.length > 10));
  assert.match(w.find((x) => x.code === "missing-parts").text, /direct-messages-group-part1\.js/);
  assert.match(w.find((x) => x.code === "overlap").text, /5 messages are already in your archive/);
  assert.match(w.find((x) => x.code === "dm-ignored").text, /1 1:1 conversation \(3 messages\)/);
});

/* ---- the endpoint -------------------------------------------------------- */
describe("POST /api/preflight", () => {
  let S;
  before(async () => { S = await startServer(); });
  after(() => S.stop());

  test("a fresh setup: groups, counts, dates, people and media, and personal_data stays empty", async () => {
    const f = X.writeExport(scratch());
    const r = await S.post("/api/preflight", files3(f));
    const j = await r.json();
    assert.equal(r.status, 200, JSON.stringify(j));
    assert.equal(j.totals.messages, 7);
    assert.equal(j.totals.groups, 2);
    assert.equal(j.totals.participants, 5);
    assert.equal(j.totals.first, X.T0);
    assert.deepEqual(j.groups.map((g) => [g.id, g.count]), [["1000000001", 5], ["1000000002", 2]]);
    assert.deepEqual(j.media, { files: 3, bytes: 5 + 5 + 3, unmatched: 0, removed: 0, known: 0 });
    assert.equal(j.merge, null);
    assert.deepEqual(j.files.messages, ["direct-messages-group.js", "direct-messages-group-part1.js"]);
    assert.deepEqual(codes(j), ["dm-ignored"]);
    assert.deepEqual(fs.readdirSync(S.personal), [], "nothing was written");
  });

  test("the archive folder, a missing part, a stray file in the media folder and a bad date are all called out", async () => {
    const f = X.writeExport(scratch(), { manifest: true });
    fs.rmSync(f.part1);
    fs.writeFileSync(path.join(f.media, "123-NotAMessage.jpg"), "x");
    const g = JSON.parse(fs.readFileSync(f.group, "utf8").replace(/^window\.YTD\.direct_messages_group\.part0 = /, ""));
    const odd = X.gmsg(9009, 111, X.T0, "no date");
    odd.messageCreate.createdAt = "not a date";
    g[0].dmConversation.messages.push(odd);
    fs.writeFileSync(f.group, X.ytd("direct_messages_group", "part0", g));
    const r = await S.post("/api/preflight", { archiveRoot: f.root });
    const j = await r.json();
    assert.equal(r.status, 200, JSON.stringify(j));
    assert.equal(j.via, "manifest");
    assert.deepEqual(codes(j), ["missing-parts", "dm-ignored", "unmatched-media", "bad-time"]);
    assert.match(j.warnings[0].text, /direct-messages-group-part1\.js/);
    assert.equal(j.totals.messages, 5);
  });

  test("a gap in the part files picked one by one is noticed", async () => {
    const f = X.writeExport(scratch());
    fs.rmSync(f.part1);
    fs.writeFileSync(path.join(f.data, "direct-messages-group-part2.js"), X.ytd("direct_messages_group", "part2", X.defaultExport().part1));
    const j = await (await S.post("/api/preflight", files3(f))).json();
    const w = j.warnings.find((x) => x.code === "missing-parts");
    assert.ok(w, JSON.stringify(j.warnings));
    assert.deepEqual(w.files, ["direct-messages-group-part1.js"]);
  });

  test("files picked the wrong way round, and an export with no group messages", async () => {
    const f = X.writeExport(scratch());
    const j = await (await S.post("/api/preflight", { groupJs: f.headers, headersJs: f.group, mediaDir: f.media })).json();
    assert.equal(j.swapped, true);
    assert.ok(codes(j).includes("swapped"));
    const e = X.writeExport(scratch(), { parts: false });
    fs.writeFileSync(e.group, X.ytd("direct_messages_group", "part0", [X.conv("111-222", [X.gmsg(8001, 111, X.T0, "only a 1:1")])]));
    fs.rmSync(e.media, { recursive: true }); fs.mkdirSync(e.media);
    const z = await (await S.post("/api/preflight", files3(e))).json();
    assert.equal(z.totals.messages, 0);
    assert.equal(codes(z)[0], "zero-messages");
  });

  test("a damaged file is refused with one plain sentence", async () => {
    const f = X.writeExport(scratch());
    const s = fs.readFileSync(f.group, "utf8");
    fs.writeFileSync(f.group, s.slice(0, Math.floor(s.length / 2)));
    const r = await S.post("/api/preflight", files3(f));
    assert.equal(r.status, 422);
    assert.match((await r.json()).error, /direct-messages-group\.js.*truncated/);
  });

  test("the guard applies: a cross-site request is refused", async () => {
    const f = X.writeExport(scratch());
    const r = await S.post("/api/preflight", files3(f), { Origin: "https://evil.example" });
    assert.equal(r.status, 403);
  });
});

describe("POST /api/preflight against a built archive (a newer export)", () => {
  let S;
  before(async () => {
    S = await startServer();
    const a = X.writeExport(scratch());
    assert.equal((await S.post("/api/source", files3(a))).status, 200);
    assert.equal((await S.post("/api/identity", { names: {}, pfps: {}, gc: {}, ignoredUsers: ["333"], ignoredGroups: [] })).status, 200);
  });
  after(() => S.stop());

  test("shows what is already there, what is new and what stays out, and writes nothing", async () => {
    const before = snapshot(S.personal);
    const b = X.writeExportB(scratch());
    const r = await S.post("/api/preflight", { archiveRoot: b.root });
    const j = await r.json();
    assert.equal(r.status, 200, JSON.stringify(j));
    // A kept 9001-9003, 9005 + 9101-9102 (333's 9004 was removed)
    assert.equal(j.merge.existingMsgs, 6);
    assert.equal(j.merge.overlap, 2, "9003 and 9005");
    assert.equal(j.merge.added, 4, "9006, 9007, 9201, 9202 (9008 is 333's)");
    assert.equal(j.merge.newGroups, 1, "1000000003");
    assert.equal(j.merge.keptGroups, 1, "1000000002 is not in B but stays");
    assert.deepEqual(codes(j), ["dm-ignored", "overlap", "removed"]);
    assert.equal(j.media.files, 2, "9007, 9201");
    assert.equal(j.media.known, 1, "9002's photo is already in the archive: not a stray file");
    assert.equal(j.media.unmatched, 0);
    assert.equal(j.media.removed, 1, "9008 is 333's");
    assert.deepEqual(snapshot(S.personal), before, "personal_data is byte-for-byte unchanged");
  });
});

// the survey (and the server's export id scan) held
// every message id twice — in `allIds` and again in `keepIds`. Each id is
// now held once: kept ids and removed ids are two disjoint sets, and
// `allIds` is a view over both.
test("the survey holds each message id once", () => {
  const sv = core.createExportSurvey({ ignoredUsers: ["333"] });
  const s = sv.sink("messages");
  s.handlers.onConversationId(0, "1000000001");
  for (const m of [X.gmsg(1, 111, X.T0, "a"), X.gmsg(2, 333, X.T0 + 1, "b"), X.gmsg(3, 222, X.T0 + 2, "c")]) s.handlers.onMessage(0, m);
  s.finish();
  assert.ok(!(sv.allIds instanceof Set), "allIds is a view, not a second copy of every id");
  assert.deepEqual([...sv.keepIds].sort(), ["1", "3"]);
  assert.deepEqual([...sv.removedIds], ["2"]);
  assert.equal(sv.allIds.size, 3);
  assert.ok(sv.allIds.has("1") && sv.allIds.has("2") && !sv.allIds.has("4"));
});
