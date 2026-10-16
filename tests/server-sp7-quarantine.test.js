/*
 * removed MESSAGES are quarantined like
 * removed media. A merge re-points config at the newer export and prunes the
 * older copies, so un-removing used to rebuild from the newer export only —
 * a removed person's messages that only the older export had (9004) were
 * gone for good. Every build now keeps the messages it filters out (removed
 * people / group chats) in personal_data/.removed/messages.js, and un-removing
 * folds them back in. Real server (GCA_PORT=0, mkdtemp GCA_PERSONAL, no root
 * fallback, no native pickers) and synthetic exports only.
 */
require("./_real-data-guard.js");   // refuse to run outside a clean checkout
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

describe("remove → merge → un-remove keeps messages only the older export had", () => {
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

describe("a still-removed group or person stays in quarantine", () => {
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
describe("a build cut off part-way keeps data.js, data.js.bak and the quarantine consistent", () => {
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

// an archive whose removals were made before the
// quarantine existed has no .removed/messages.js. Its first merge used to be
// the first build to fill it — after config was already re-pointed at the
// newer export, so the older export's removed messages (9004) were lost. The
// merge now rebuilds once with the archive's own (unchanged) config first.
describe("a legacy archive (removals but no quarantine) keeps older-only removed messages through a merge", () => {
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

// a merge whose build fails puts the quarantine back
// as it was, like config.json, source/ and media/ — not the superset the
// failed build wrote before it stopped.
describe("a failed merge build leaves the quarantine as it was", () => {
  let personal;
  before(() => { personal = fs.mkdtempSync(path.join(os.tmpdir(), "gca-sp7-quar-undo-")); tmpDirs.push(personal); });

  test("the build stops after writing the quarantine: the merge fails and the quarantine is unchanged", async () => {
    const S1 = await startServer({}, { personal });
    try {
      assert.equal((await source(S1, X.writeExport(scratch()))).status, 200);
      assert.equal((await identity(S1, ["333"])).status, 200);
    } finally { S1.proc.kill(); }
    const before0 = fs.readFileSync(path.join(personal, ".removed", "messages.js"));
    const S2 = await startServer({ GCA_TEST_BUILD_CRASH: "after-quarantine" }, { personal });
    try {
      const r = await S2.post("/api/source", { archiveRoot: X.writeExportB(scratch()).root });
      assert.equal(r.status, 422, JSON.stringify(await r.clone().json()));
      assert.deepEqual(fs.readFileSync(path.join(personal, ".removed", "messages.js")), before0);
      assert.ok(!fs.readdirSync(personal).some((n) => /\.prev-/.test(n)), "no snapshot left behind: " + fs.readdirSync(personal).join(", "));
    } finally { S2.proc.kill(); }
  });
});

// A legacy archive (removals, no quarantine) whose export copies are also
// gone can't set its removed messages aside any more. The merge still runs,
// but the user is told, in the preview and in the reply, that un-removing
// later only brings back what the newer export has.
describe("a legacy archive whose export copies are gone says its removed messages weren't kept", () => {
  let S;
  before(async () => { S = await startServer(); });
  after(() => S.stop());

  test("the preview warns and the merge reply carries a plain note", async () => {
    assert.equal((await source(S, X.writeExport(scratch()))).status, 200);
    assert.equal((await identity(S, ["333"])).status, 200);
    fs.rmSync(Q(S), { force: true });   // built before the quarantine existed
    fs.rmSync(path.join(S.personal, "source"), { recursive: true, force: true });   // and its copies are gone
    const B = X.writeExportB(scratch());
    const p = await S.post("/api/preflight", { archiveRoot: B.root });
    const pj = await p.json();
    assert.equal(p.status, 200, JSON.stringify(pj));
    const w = pj.warnings.find((x) => x.code === "legacy-removed-lost");
    assert.ok(w && /un-remov/i.test(w.text), JSON.stringify(pj.warnings));
    const m = await S.post("/api/source", { archiveRoot: B.root });
    const j = await m.json();
    assert.equal(m.status, 200, JSON.stringify(j));
    const n = (j.notes || []).find((x) => x.code === "legacy-removed-lost");
    assert.ok(n && typeof n.text === "string" && n.text.length > 20, JSON.stringify(j.notes));
    assert.deepEqual(quarIds(S), ["9008"], "only B's removed message could be kept aside");
  });
});

// Once data.js is in place, the archive holds the new messages and points at
// their media. A step that fails after that (narrowing the quarantine, say)
// must not roll media/, source/ and config.json back under it: the merge or
// save is kept, and the reply says a last step failed. That holds for a build
// killed outright (no exit code 3) too: the server sees data.js has changed.
for (const [how, crash] of [["fails", "after-archive"], ["is killed", "kill-after-archive"]]) describe("a build that " + how + " after data.js is written keeps what it wrote", () => {
  let personal, S;
  before(async () => {
    personal = fs.mkdtempSync(path.join(os.tmpdir(), "gca-sp7-post-archive-")); tmpDirs.push(personal);
    const S1 = await startServer({}, { personal });
    try {
      assert.equal((await source(S1, X.writeExport(scratch()))).status, 200);
      assert.equal((await identity(S1, ["333"])).status, 200);
    } finally { S1.proc.kill(); }
    S = await startServer({ GCA_TEST_BUILD_CRASH: crash }, { personal });
  });
  after(() => S.proc.kill());
  const note = (j) => (j.notes || []).find((n) => n.code === "post-archive-step-failed");

  test("a merge: 200 with a note, config, media and data.js all on the new export", async () => {
    const B = X.writeExportB(scratch());
    const r = await S.post("/api/source", { archiveRoot: B.root });
    const j = await r.json();
    assert.equal(r.status, 200, JSON.stringify(j));
    assert.ok(note(j) && note(j).text.length > 20, JSON.stringify(j.notes));
    const cfg = JSON.parse(fs.readFileSync(path.join(personal, "config.json"), "utf8"));
    assert.equal(path.resolve(cfg.mediaSourceDir), path.resolve(B.media), "config points at B");
    assert.ok(fs.existsSync(path.join(personal, "media", "9007-NewPic.jpg")), "B's media stays");
    assert.ok(fs.existsSync(path.join(personal, "media", "9201-Group3.png")));
    assert.ok(allIds(readData(personal)).includes("9007"), "data.js has B's messages");
    assert.ok(!fs.readdirSync(personal).some((n) => /\.prev-/.test(n)), "no backups left: " + fs.readdirSync(personal).join(", "));
    const ok = spawnSync(process.execPath, [path.join(__dirname, "..", "scripts", "build.js")], {
      cwd: path.join(__dirname, ".."), encoding: "utf8",
      env: Object.assign({}, process.env, { GCA_PERSONAL: personal, GCA_NO_ROOT_FALLBACK: "1", GCA_TEST_BUILD_CRASH: "" }),
    });
    assert.equal(ok.status, 0, ok.stderr);
    assert.deepEqual(quarIds({ personal }), ["9004", "9008"]);
  });

  test("a removal save: rebuilt, with a note, and the removed group's media set aside", async () => {
    const r = await identity(S, ["333"], ["1000000002"]);
    const j = await r.json();
    assert.equal(r.status, 200, JSON.stringify(j));
    assert.equal(j.rebuilt, true);
    assert.ok(note(j), JSON.stringify(j));
    assert.ok(!fs.existsSync(path.join(personal, "media", "9101-Other.mp4")), "no longer servable");
    assert.ok(fs.existsSync(path.join(personal, ".removed", "group", "1000000002", "9101-Other.mp4")), "kept aside");
  });
});
