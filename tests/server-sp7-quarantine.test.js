/*
 * SP7 fix round 1 (#1, critical): removed MESSAGES are quarantined like
 * removed media. A merge re-points config at the newer export and prunes the
 * older copies, so un-removing used to rebuild from the newer export only —
 * a removed person's messages that only the older export had (9004) were
 * gone for good. Every build now keeps the messages it filters out (removed
 * people / group chats) in personal_data/.removed/messages.js, and un-removing
 * folds them back in. Real server (GCA_PORT=0, mkdtemp GCA_PERSONAL, no root
 * fallback, no native pickers) and synthetic exports only.
 */
require("./_real-data-guard.js");   // QA-2: refuse to run outside a clean checkout
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const X = require("./fixtures/x-export.js");
const { startServer, readData } = require("./_sp6-server.js");

const tmpDirs = [];
const scratch = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "gca-sp7-quar-")); tmpDirs.push(d); return d; };
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

const source = (S, f) => S.post("/api/source", { groupJs: f.group, headersJs: f.headers, mediaDir: f.media });
const identity = (S, ignoredUsers, ignoredGroups) => S.post("/api/identity", { names: {}, pfps: {}, gc: {}, ignoredUsers, ignoredGroups: ignoredGroups || [] });
const parseArchive = (file) => JSON.parse(fs.readFileSync(file, "utf8").replace(/^window\.CHAT_DATA\s*=\s*/, "").replace(/;\s*$/, ""));
const idsIn = (data, cid) => { const c = data.conversations.find((x) => String(x.id) === cid); return c ? c.msgs.map((m) => String(m.i)).sort() : []; };
const allIds = (data) => data.conversations.flatMap((c) => c.msgs.map((m) => String(m.i))).sort();
const Q = (S) => path.join(S.personal, ".removed", "messages.js");
const quarIds = (S) => (fs.existsSync(Q(S)) ? allIds(parseArchive(Q(S))) : []);

describe("SP7 fix 1: remove → merge → un-remove keeps messages only the older export had", () => {
  let S;
  before(async () => { S = await startServer(); });
  after(() => S.stop());

  test("removing 333 quarantines 9004", async () => {
    assert.equal((await source(S, X.writeExport(scratch()))).status, 200);
    const r = await identity(S, ["333"]);
    assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
    assert.ok(!allIds(readData(S.personal)).includes("9004"));
    assert.deepEqual(quarIds(S), ["9004"]);
  });

  test("merging B keeps 9004 quarantined and adds B's 9008", async () => {
    const r = await S.post("/api/source", { archiveRoot: X.writeExportB(scratch()).root });
    assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
    assert.deepEqual(quarIds(S), ["9004", "9008"]);
    const d = readData(S.personal);
    assert.ok(!allIds(d).includes("9004") && !allIds(d).includes("9008"), "removed stays removed");
  });

  test("un-removing 333 brings back 9004 (older export only) and 9008", async () => {
    const r = await identity(S, []);
    const j = await r.json();
    assert.equal(r.status, 200, JSON.stringify(j));
    assert.equal(j.rebuilt, true);
    assert.deepEqual(idsIn(readData(S.personal), "1000000001"), ["9001", "9002", "9003", "9004", "9005", "9006", "9007", "9008"]);
    assert.deepEqual(quarIds(S), [], "nothing is left in quarantine");
  });

  test("the quarantine is never served", async () => {
    assert.equal((await identity(S, ["333"])).status, 200);
    assert.ok(fs.existsSync(Q(S)));
    assert.equal((await S.get("/personal_data/.removed/messages.js")).status, 404);
  });
});

describe("SP7 fix 1: a still-removed group or person stays in quarantine", () => {
  let S;
  before(async () => { S = await startServer(); });
  after(() => S.stop());

  test("un-removing a group restores it; a removed person stays out", async () => {
    assert.equal((await source(S, X.writeExport(scratch()))).status, 200);
    assert.equal((await identity(S, ["333"], ["1000000002"])).status, 200);
    assert.deepEqual(quarIds(S), ["9004", "9101", "9102"]);
    const r = await S.post("/api/source", { archiveRoot: X.writeExportB(scratch()).root });
    assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
    assert.ok(!readData(S.personal).conversations.some((c) => String(c.id) === "1000000002"), "group 2 stays out after the merge");
    assert.equal((await identity(S, ["333"], [])).status, 200);
    const d = readData(S.personal);
    assert.deepEqual(idsIn(d, "1000000002"), ["9101", "9102"], "the group only A had comes back");
    assert.ok(!allIds(d).some((id) => id === "9004" || id === "9008"), "333 is still removed");
    assert.deepEqual(quarIds(S), ["9004", "9008"]);
  });

  test("Start over erases the quarantine", async () => {
    assert.ok(fs.existsSync(Q(S)));
    assert.equal((await S.post("/api/reset", {})).status, 200);
    assert.ok(!fs.existsSync(Q(S)));
  });
});

// The quarantine and data.js are written one after the other. A build cut
// off between the two writes must not lose anything: the quarantine is first
// written as a superset (old + newly removed), data.js next, and only then is
// it narrowed to what is still removed. data.js / data.js.bak stay as they
// were when the build stops before data.js is written.
describe("SP7 fix 1: a build cut off part-way keeps data.js, data.js.bak and the quarantine consistent", () => {
  let S;
  before(async () => { S = await startServer(); });
  after(() => S.stop());
  const build = (env) => spawnSync(process.execPath, [path.join(__dirname, "..", "scripts", "build.js")], {
    cwd: path.join(__dirname, ".."), encoding: "utf8",
    env: Object.assign({}, process.env, { GCA_PERSONAL: S.personal, GCA_NO_ROOT_FALLBACK: "1" }, env || {}),
  });
  const setIgnored = (users, groups) => {
    const f = path.join(S.personal, "config.json");
    const cfg = JSON.parse(fs.readFileSync(f, "utf8"));
    cfg.ignoredUsers = users; cfg.ignoredGroups = groups;
    fs.writeFileSync(f, JSON.stringify(cfg));
  };

  test("cut off after the quarantine write: data.js and .bak unchanged, quarantine a superset; the next build finishes the job", async () => {
    assert.equal((await source(S, X.writeExport(scratch()))).status, 200);
    assert.equal((await identity(S, ["333"])).status, 200);
    const data0 = fs.readFileSync(path.join(S.personal, "data.js"));
    const bak0 = fs.readFileSync(path.join(S.personal, "data.js.bak"));
    setIgnored([], ["1000000002"]);   // un-remove 333, remove group 2, in one build
    const r = build({ GCA_TEST_BUILD_CRASH: "after-quarantine" });
    assert.notEqual(r.status, 0, "the simulated crash stops the build");
    assert.deepEqual(fs.readFileSync(path.join(S.personal, "data.js")), data0);
    assert.deepEqual(fs.readFileSync(path.join(S.personal, "data.js.bak")), bak0);
    assert.deepEqual(quarIds(S), ["9004", "9101", "9102"], "old + newly removed, nothing dropped yet");
    const ok = build();
    assert.equal(ok.status, 0, ok.stderr);
    const d = readData(S.personal);
    assert.ok(allIds(d).includes("9004"));
    assert.ok(!d.conversations.some((c) => String(c.id) === "1000000002"));
    assert.deepEqual(quarIds(S), ["9101", "9102"]);
  });

  test("cut off after data.js: the quarantine still holds everything, and the next build narrows it", () => {
    setIgnored(["333"], []);
    const r = build({ GCA_TEST_BUILD_CRASH: "after-archive" });
    assert.notEqual(r.status, 0);
    const d = readData(S.personal);
    assert.ok(!allIds(d).includes("9004"));
    assert.deepEqual(idsIn(d, "1000000002"), ["9101", "9102"]);
    assert.deepEqual(quarIds(S), ["9004", "9101", "9102"], "a superset: nothing restored is lost, nothing removed leaks");
    const ok = build();
    assert.equal(ok.status, 0, ok.stderr);
    assert.deepEqual(quarIds(S), ["9004"]);
    assert.deepEqual(idsIn(readData(S.personal), "1000000002"), ["9101", "9102"]);
  });
});

// SP7 fix round 2 (#1): an archive whose removals were made before the
// quarantine existed has no .removed/messages.js. Its first merge used to be
// the first build to fill it — after config was already re-pointed at the
// newer export, so the older export's removed messages (9004) were lost. The
// merge now rebuilds once with the archive's own (unchanged) config first.
describe("SP7 fix round 2: a legacy archive (removals but no quarantine) keeps older-only removed messages through a merge", () => {
  let S;
  before(async () => { S = await startServer(); });
  after(() => S.stop());

  test("build A, remove 333, (legacy: no quarantine), merge B, un-remove 333 → 9004 is back", async () => {
    assert.equal((await source(S, X.writeExport(scratch()))).status, 200);
    assert.equal((await identity(S, ["333"])).status, 200);
    fs.rmSync(Q(S), { force: true });   // as an archive built before the quarantine existed
    const m = await S.post("/api/source", { archiveRoot: X.writeExportB(scratch()).root });
    assert.equal(m.status, 200, JSON.stringify(await m.clone().json()));
    assert.deepEqual(quarIds(S), ["9004", "9008"], "the merge kept A's removed message aside");
    assert.equal((await identity(S, [])).status, 200);
    assert.deepEqual(idsIn(readData(S.personal), "1000000001"), ["9001", "9002", "9003", "9004", "9005", "9006", "9007", "9008"]);
  });

  test("a removal that took nothing out leaves an (empty) quarantine, so the next merge doesn't rebuild first again", async () => {
    assert.equal((await identity(S, ["999"])).status, 200);   // nobody's messages
    assert.ok(fs.existsSync(Q(S)), "the quarantine marks the archive as already set aside");
    assert.deepEqual(quarIds(S), []);
  });
});
