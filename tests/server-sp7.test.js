/*
 * Import upgrade — the setup server end to end over synthetic exports
 * only (tests/fixtures/x-export.js); every server on GCA_PORT=0 with a mkdtemp
 * GCA_PERSONAL, the root fallbacks off and no native pickers (_sp6-server.js).
 */
require("./_real-data-guard.js");   // refuse to run outside a clean checkout
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const X = require("./fixtures/x-export.js");
const { startServer } = require("./_sp6-server.js");

const tmpDirs = [];
function scratch(prefix) { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix || "gca-sp7-export-")); tmpDirs.push(d); return d; }
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });
const source = (S, f) => S.post("/api/source", { groupJs: f.group, headersJs: f.headers, mediaDir: f.media });

// A server killed mid-build leaves its *.prev-* backup folders
// (the copies a new source replaced). They were only removed by Start over.
describe("a build that commits clears stale backup folders from earlier runs", () => {
  let S;
  before(async () => { S = await startServer(); });
  after(() => S.stop());

  test("leftover source.prev-* / media.prev-* folders are gone after a successful build", async () => {
    for (const d of ["source.prev-123-0a1b2c3d", "media.prev-123-0a1b2c3d", "removed.prev-123-0a1b2c3d"]) {
      fs.mkdirSync(path.join(S.personal, d));
      fs.writeFileSync(path.join(S.personal, d, "old-copy.js"), "a previous copy");
    }
    fs.mkdirSync(path.join(S.personal, "not-ours.prev-folder"));
    const r = await source(S, X.writeExport(scratch()));
    assert.equal(r.status, 200, JSON.stringify(await r.json()));
    assert.deepEqual(fs.readdirSync(S.personal).filter((n) => /\.prev-/.test(n)), ["not-ours.prev-folder"], "only the wizard's own backup folders are cleared");
  });
});

// Un-removing restored media from the original folder with no
// message-id filter, so a camera-roll picture next to the real media (which
// the first copy had left out) was copied into the served media/ folder.
// Also: a removed person's or group's media is never copied in by a later
// copy of the export (it would sit unreferenced, but servable, in media/).
describe("media copies and restores only take this export's kept messages' media", () => {
  let S, f;
  const media = () => fs.readdirSync(path.join(S.personal, "media")).sort();
  const identity = (extra) => S.post("/api/identity", Object.assign({ names: {}, pfps: {}, gc: {} }, extra));
  before(async () => {
    S = await startServer();
    f = X.writeExport(scratch());
    fs.writeFileSync(path.join(f.media, "20230301-IMG_0001.jpg"), "a camera-roll picture");
    assert.equal((await source(S, f)).status, 200);
  });
  after(() => S.stop());

  test("the first copy leaves the stray picture out", () => {
    assert.ok(!media().includes("20230301-IMG_0001.jpg"));
  });

  test("un-removing a group restores its media but not the stray picture", async () => {
    assert.equal((await identity({ ignoredGroups: ["1000000002"], ignoredUsers: [] })).status, 200);
    fs.rmSync(path.join(S.personal, ".removed"), { recursive: true, force: true });   // force the restore to use the export folder
    const r = await identity({ ignoredGroups: [], ignoredUsers: [] });
    assert.equal(r.status, 200);
    assert.deepEqual(media(), ["9002-AbCdEf.png", "9002-ZzSecond.jpg", "9101-Other.mp4"]);
    // The stray must never be copied into personal_data/ at all (it used to
    // be copied, then swept into the quarantine as unreferenced).
    assert.ok(!fs.existsSync(path.join(S.personal, ".removed", "other")), "the stray picture was never copied in");
  });

  test("copying the export again doesn't bring back a removed person's media", async () => {
    const r1 = await identity({ ignoredGroups: [], ignoredUsers: ["222"] });
    assert.equal(r1.status, 200);
    assert.deepEqual(media(), ["9101-Other.mp4"], "222's media was set aside");
    const r2 = await source(S, f);
    assert.equal(r2.status, 200, JSON.stringify(await r2.json()));
    assert.deepEqual(media(), ["9101-Other.mp4"], "222 is still removed, so their media stays out of media/");
  });

  test("un-removing the person brings their media back", async () => {
    const r = await identity({ ignoredGroups: [], ignoredUsers: [] });
    assert.equal(r.status, 200);
    assert.deepEqual(media(), ["9002-AbCdEf.png", "9002-ZzSecond.jpg", "9101-Other.mp4"]);
  });
});

// pick the archive folder; data/manifest.js says where the group files,
// every part, the headers and the media are (a file-name scan is the fallback).
describe("building from the archive folder", () => {
  let S;
  const cfg = () => JSON.parse(fs.readFileSync(path.join(S.personal, "config.json"), "utf8"));
  before(async () => { S = await startServer(); });
  after(() => S.stop());

  test("a folder with no group chat files is refused and nothing is written", async () => {
    const empty = scratch();
    fs.writeFileSync(path.join(empty, "notes.txt"), "x");
    const r = await S.post("/api/source", { archiveRoot: empty });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /No group chat files were found/);
    assert.deepEqual(fs.readdirSync(S.personal), [], "personal_data is untouched");
  });

  test("the archive root is resolved through data/manifest.js: every part, the headers and the media", async () => {
    const f = X.writeExport(scratch(), { manifest: true });
    // a name the file-name scan would never pick up: only the manifest knows it
    fs.renameSync(f.part1, path.join(f.data, "group-chats-extra.js"));
    X.writeManifest(f.root, { messages: ["data/direct-messages-group.js", "data/group-chats-extra.js"], headers: ["data/direct-message-group-headers.js"], mediaDirectory: "data/direct_messages_group_media" });
    const r = await S.post("/api/source", { archiveRoot: f.root });
    const j = await r.json();
    assert.equal(r.status, 200, JSON.stringify(j));
    assert.equal(j.via, "manifest");
    assert.equal(j.partFiles, 2);
    assert.equal(j.headerPartFiles, 1);
    assert.equal(j.totalMsgs, 7);
    assert.equal(j.mediaCopied, 3);
    assert.ok(j.notes.some((n) => n.code === "dm-file"), "the 1:1 DMs are noticed (and left out)");
    assert.deepEqual(cfg().sourceJs.map((p) => path.basename(p)), ["direct-messages-group.js", "group-chats-extra.js"]);
    assert.ok(!fs.readdirSync(path.join(S.personal, "source")).includes("direct-messages.js"), "the 1:1 DM file is never copied");
  });

  test("a manifest that lists the files the wrong way round is checked against what they say they are", async () => {
    const f = X.writeExport(scratch(), { manifest: true });
    X.writeManifest(f.root, { messages: ["data/direct-message-group-headers.js"], headers: ["data/direct-messages-group.js", "data/direct-messages-group-part1.js"], mediaDirectory: "data/direct_messages_group_media" });
    const r = await S.post("/api/source", { archiveRoot: f.root });
    const j = await r.json();
    assert.equal(r.status, 200, JSON.stringify(j));
    assert.equal(j.swapped, true);
    assert.equal(j.partFiles, 2);
    assert.equal(j.totalMsgs, 7);
  });

  test("no manifest and no media folder: the scan finds the files and the build goes ahead without media", async () => {
    const f = X.writeExport(scratch());
    fs.rmSync(f.media, { recursive: true });
    const r = await S.post("/api/source", { archiveRoot: f.data });
    const j = await r.json();
    assert.equal(r.status, 200, JSON.stringify(j));
    assert.equal(j.via, "scan");
    assert.equal(j.partFiles, 2);
    assert.ok(j.notes.some((n) => n.code === "no-media"));
  });
});

// the media copy reported progress nowhere — a big media
// folder looked frozen. It now runs without blocking the server, and
// GET /api/progress says how far it is; while it runs, a second build, a
// save or Start over is refused (409) instead of racing it.
describe("media copy progress and the busy guard", () => {
  let S;
  before(async () => { S = await startServer({ GCA_TEST_COPY_DELAY_MS: "300" }); });
  after(() => S.stop());

  test("progress counts files and bytes while the copy runs, and other changes wait", async () => {
    const f = X.writeExport(scratch());
    const idle = await (await S.get("/api/progress")).json();
    assert.deepEqual(idle, { running: false });
    const pending = source(S, f);
    let seen = null;
    for (let i = 0; i < 100 && !seen; i++) {
      const p = await (await S.get("/api/progress")).json();
      if (p.running && p.phase === "copy" && p.files >= 1) seen = p;
      else await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(seen, "progress was reported mid-copy");
    assert.equal(seen.totalFiles, 3);
    assert.equal(seen.totalBytes, 13);
    assert.ok(seen.files < 3 && seen.bytes > 0 && seen.bytes < 13, JSON.stringify(seen));
    // the server stays responsive and refuses to start anything else
    assert.equal((await S.get("/api/ping?c=t")).status, 200);
    assert.equal((await source(S, f)).status, 409);
    assert.equal((await S.post("/api/identity", { names: {}, pfps: {}, gc: {} })).status, 409);
    assert.equal((await S.post("/api/reset", {})).status, 409);
    assert.equal((await S.post("/api/preflight", { groupJs: f.group, headersJs: f.headers, mediaDir: f.media })).status, 409);
    const r = await pending;
    const j = await r.json();
    assert.equal(r.status, 200, JSON.stringify(j));
    assert.equal(j.mediaCopied, 3);
    assert.deepEqual(await (await S.get("/api/progress")).json(), { running: false });
  });

  test("building the same export again doesn't copy media it already has", async () => {
    const f = X.writeExport(scratch());
    const r = await source(S, f);
    const j = await r.json();
    assert.equal(r.status, 200, JSON.stringify(j));
    assert.equal(j.mediaCopied, 0);
    assert.equal(j.mediaSame, 3);
  });
});

// "Add a newer export" is a true merge, and the wizard can see
// (and so keep) the group names and photos saved earlier.
describe("adding a newer export merges into the archive", () => {
  let S;
  const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
  before(async () => { S = await startServer(); });
  after(() => S.stop());

  test("/api/status returns the saved group names and photos", async () => {
    const a = X.writeExport(scratch());
    assert.equal((await source(S, a)).status, 200);
    const r = await S.post("/api/identity", { names: { 111: "Ann" }, pfps: {}, me: "111", gc: { 1000000001: { name: "Crew", photo: PNG } }, ignoredUsers: ["333"], ignoredGroups: [] });
    assert.equal(r.status, 200, JSON.stringify(await r.json()));
    const st = await (await S.get("/api/status")).json();
    assert.equal(st.gc["1000000001"].name, "Crew");
    assert.match(st.gc["1000000001"].photo, /^personal_data\/pfps\/group_crew_pfp\.png$/);
    assert.deepEqual(st.ignoredUsers, ["333"]);
  });

  test("a save that sends a group entry without a name keeps the saved name", async () => {
    const r = await S.post("/api/identity", { names: {}, pfps: {}, gc: { 1000000001: { photo: null } }, ignoredUsers: ["333"], ignoredGroups: [] });
    assert.equal(r.status, 200);
    const st = await (await S.get("/api/status")).json();
    assert.equal(st.gc["1000000001"].name, "Crew");
    assert.ok(st.gc["1000000001"].photo);
  });

  test("building a newer, overlapping export unions the messages and says what it added", async () => {
    const dataBefore = fs.readFileSync(path.join(S.personal, "data.js"));
    const b = X.writeExportB(scratch());
    const r = await S.post("/api/source", { archiveRoot: b.root });
    const j = await r.json();
    assert.equal(r.status, 200, JSON.stringify(j));
    assert.equal(j.merged, true);
    assert.equal(j.previousMsgs, 6, "A without 333's 9004");
    assert.equal(j.added, 4, "9006, 9007, 9201, 9202 (333's 9008 stays out)");
    assert.equal(j.totalMsgs, 10);
    assert.deepEqual(fs.readFileSync(path.join(S.personal, "data.js.bak")), dataBefore, "data.js.bak is the archive as it was before the merge");
    const { readData } = require("./_sp6-server.js");
    const data = readData(S.personal);
    const ids = (cid) => data.conversations.find((c) => String(c.id) === cid).msgs.map((m) => String(m.i)).sort();
    assert.deepEqual(ids("1000000001"), ["9001", "9002", "9003", "9005", "9006", "9007"]);
    assert.deepEqual(ids("1000000002"), ["9101", "9102"], "a group only the older export had is kept");
    assert.deepEqual(ids("1000000003"), ["9201", "9202"]);
    const cfg = JSON.parse(fs.readFileSync(path.join(S.personal, "config.json"), "utf8"));
    assert.equal(cfg.me, "111");
    assert.equal(cfg.names["111"], "Ann");
    assert.equal(cfg.gc["1000000001"].name, "Crew");
    assert.deepEqual(cfg.ignoredUsers, ["333"]);
    // only the newer export's files are left in source/ (A's part1 copy is gone)
    assert.deepEqual(fs.readdirSync(path.join(S.personal, "source")).sort(), ["direct-message-group-headers.js", "direct-messages-group.js"]);
    assert.ok(!fs.existsSync(path.join(S.personal, "media", "9008-Removed.png")), "a removed person's media isn't copied in");
    assert.ok(fs.existsSync(path.join(S.personal, "media", "9201-Group3.png")));
  });
});
