/*
 * SP7 (import upgrade) — the setup server end to end over synthetic exports
 * only (tests/fixtures/x-export.js); every server on GCA_PORT=0 with a mkdtemp
 * GCA_PERSONAL, the root fallbacks off and no native pickers (_sp6-server.js).
 */
require("./_real-data-guard.js");   // QA-2: refuse to run outside a clean checkout
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

// SP6 review #3: a server killed mid-build leaves its *.prev-* backup folders
// (the copies a new source replaced). They were only removed by Start over.
describe("SP7: a build that commits clears stale backup folders from earlier runs", () => {
  let S;
  before(async () => { S = await startServer(); });
  after(() => S.stop());

  test("leftover source.prev-* / media.prev-* folders are gone after a successful build", async () => {
    for (const d of ["source.prev-123-0a1b2c3d", "media.prev-123-0a1b2c3d"]) {
      fs.mkdirSync(path.join(S.personal, d));
      fs.writeFileSync(path.join(S.personal, d, "old-copy.js"), "a previous copy");
    }
    fs.mkdirSync(path.join(S.personal, "not-ours.prev-folder"));
    const r = await source(S, X.writeExport(scratch()));
    assert.equal(r.status, 200, JSON.stringify(await r.json()));
    assert.deepEqual(fs.readdirSync(S.personal).filter((n) => /\.prev-/.test(n)), ["not-ours.prev-folder"], "only the wizard's own backup folders are cleared");
  });
});

// SP6 review #5: un-removing restored media from the original folder with no
// message-id filter, so a camera-roll picture next to the real media (which
// the first copy had left out) was copied into the served media/ folder.
// Also: a removed person's or group's media is never copied in by a later
// copy of the export (it would sit unreferenced, but servable, in media/).
describe("SP7: media copies and restores only take this export's kept messages' media", () => {
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
