/*
 * Ingestion robustness — the setup server end to end, over synthetic
 * exports only (tests/fixtures/x-export.js), each server on its own GCA_PORT=0
 * + mkdtemp GCA_PERSONAL (see tests/_sp6-server.js).
 */
require("./_real-data-guard.js");   // refuse to run outside a clean checkout
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const X = require("./fixtures/x-export.js");

const { startServer, readData } = require("./_sp6-server.js");

const tmpDirs = [];
function scratch(prefix) { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix || "gca-sp6-export-")); tmpDirs.push(d); return d; }
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });
// POST /api/source with the three wizard fields
const source = (S, groupJs, headersJs, mediaDir) => S.post("/api/source", { groupJs, headersJs, mediaDir });

const tmpLeftovers = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"));

describe("crash-safe server writes", () => {
  let S;
  before(async () => { S = await startServer(); });
  after(() => S.stop());

  test("an identity save writes config.json and local.js completely, with no temp files left", async () => {
    const r = await S.post("/api/identity", { names: { "111": "Ann" }, gc: {}, pfps: {}, ignoredUsers: [], ignoredGroups: [] });
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(fs.readFileSync(path.join(S.personal, "config.json"), "utf8")).names["111"], "Ann");
    assert.match(fs.readFileSync(path.join(S.personal, "local.js"), "utf8"), /"111": "Ann"/);
    assert.deepEqual(tmpLeftovers(S.personal), []);
  });

  test("Start over also removes temp files a crashed write left behind", async () => {
    const stray = ["data.js.123.0a1b2c3d.tmp", "config.json.9.deadbeef.tmp", "local.js.77.00ff00ff.tmp"];
    for (const f of stray) fs.writeFileSync(path.join(S.personal, f), "partial");
    fs.writeFileSync(path.join(S.personal, "keep-me.txt"), "not ours");
    const r = await S.post("/api/reset", {});
    assert.equal(r.status, 200);
    assert.deepEqual(tmpLeftovers(S.personal), []);
    assert.ok(fs.existsSync(path.join(S.personal, "keep-me.txt")), "only the wizard's own files are removed");
  });
});


describe("multi-part exports through the wizard", () => {
  let S;
  before(async () => { S = await startServer(); });
  after(() => S.stop());

  test("picking direct-messages-group.js also ingests its -part1 sibling (all 5 messages, ordered)", async () => {
    const f = X.writeExport(scratch());
    const r = await source(S, f.group, f.headers, f.media);
    const j = await r.json();
    assert.equal(r.status, 200, JSON.stringify(j));
    assert.equal(j.partFiles, 2, "both message part files are reported");
    const cfg = JSON.parse(fs.readFileSync(path.join(S.personal, "config.json"), "utf8"));
    assert.deepEqual(cfg.sourceJs.map((p) => path.basename(p)), ["direct-messages-group.js", "direct-messages-group-part1.js"]);
    const g = readData(S.personal).conversations.find((c) => c.id === "1000000001");
    assert.deepEqual(g.msgs.map((m) => m.i), ["9001", "9002", "9003", "9004", "9005"]);
    assert.ok(g.participants.includes("333"), "the part1-only sender is a real participant");
  });
});

describe("swapped messages / headers files", () => {
  let S;
  before(async () => { S = await startServer(); });
  after(() => S.stop());

  test("messages and headers files picked the other way round are swapped back, and the build has real text", async () => {
    const f = X.writeExport(scratch());
    const r = await source(S, f.headers, f.group, f.media);
    const j = await r.json();
    assert.equal(r.status, 200, JSON.stringify(j));
    assert.equal(j.swapped, true, "the response says the files were swapped back");
    const cfg = JSON.parse(fs.readFileSync(path.join(S.personal, "config.json"), "utf8"));
    assert.equal(path.basename(cfg.sourceJs[0]), "direct-messages-group.js");
    const g = readData(S.personal).conversations.find((c) => c.id === "1000000001");
    assert.ok(g.msgs.some((m) => m.x), "messages carry their text, not blanks");
  });

  test("the same file picked for both gets a plain error and builds nothing", async () => {
    await S.post("/api/reset", {});
    const f = X.writeExport(scratch());
    const r = await source(S, f.headers, f.headers, f.media);
    const j = await r.json();
    assert.equal(r.status, 400);
    assert.match(j.error, /headers file/);
    assert.ok(!fs.existsSync(path.join(S.personal, "data.js")));
  });
});

describe("the media folder is validated and only message media is copied", () => {
  let S;
  before(async () => { S = await startServer(); });
  after(() => S.stop());
  const mediaNames = () => fs.readdirSync(path.join(S.personal, "media")).sort();

  test("picking the archive's data/ folder uses its direct_messages_group_media child, never 1:1 DMs or account.js", async () => {
    await S.post("/api/reset", {});
    const f = X.writeExport(scratch());
    const r = await source(S, f.group, f.headers, f.data);
    const j = await r.json();
    assert.equal(r.status, 200, JSON.stringify(j));
    assert.equal(j.mediaCopied, 3);
    assert.deepEqual(mediaNames(), ["9002-AbCdEf.png", "9002-ZzSecond.jpg", "9101-Other.mp4"]);
  });

  test("a folder of .js export files with no group media inside is refused, nothing copied", async () => {
    await S.post("/api/reset", {});
    const f = X.writeExport(scratch());
    fs.renameSync(f.media, f.media + "-moved");   // data/ without direct_messages_group_media
    const r = await source(S, f.group, f.headers, f.data);
    const j = await r.json();
    assert.equal(r.status, 400, JSON.stringify(j));
    assert.match(j.error, /direct_messages_group_media/);
    assert.ok(!fs.existsSync(path.join(S.personal, "media")) || mediaNames().length === 0);
  });

  test("the 1:1 direct_messages_media folder is refused", async () => {
    await S.post("/api/reset", {});
    const f = X.writeExport(scratch());
    const r = await source(S, f.group, f.headers, path.join(f.data, "direct_messages_media"));
    const j = await r.json();
    assert.equal(r.status, 400, JSON.stringify(j));
    assert.match(j.error, /1:1/);
  });

  test("only top-level message media files are copied; the rest are counted, not copied", async () => {
    await S.post("/api/reset", {});
    const f = X.writeExport(scratch());
    fs.writeFileSync(path.join(f.media, "notes.txt"), "x");
    fs.writeFileSync(path.join(f.media, "desktop.ini"), "x");
    fs.mkdirSync(path.join(f.media, "sub"));
    fs.writeFileSync(path.join(f.media, "sub", "9003-Nested.jpg"), "x");
    const r = await source(S, f.group, f.headers, f.media);
    const j = await r.json();
    assert.equal(r.status, 200, JSON.stringify(j));
    assert.equal(j.mediaCopied, 3);
    assert.equal(j.mediaUnmatched, 3, "notes.txt, desktop.ini and the sub/ folder are left out and reported");
    assert.deepEqual(mediaNames(), ["9002-AbCdEf.png", "9002-ZzSecond.jpg", "9101-Other.mp4"]);
  });
  // Camera-roll names like 20230301-IMG.jpg match
  // the "<digits>-<name>.<ext>" shape too, so a Pictures folder would be copied
  // into personal_data/media/. Only files whose number is a message id in this
  // export are copied; a folder where none match is refused.
  test("a folder of camera-roll pictures (none of them this export's media) is refused, nothing copied", async () => {
    await S.post("/api/reset", {});
    const f = X.writeExport(scratch());
    const pics = scratch("gca-pictures-");
    for (const n of ["20230301-IMG_0001.jpg", "20230302-VID_0002.mp4", "20230303-Screenshot.png"]) fs.writeFileSync(path.join(pics, n), "x");
    const r = await source(S, f.group, f.headers, pics);
    const j = await r.json();
    assert.equal(r.status, 400, JSON.stringify(j));
    assert.match(j.error, /none of the .*files .*belong to/i);
    assert.match(j.error, /direct_messages_group_media/);
    assert.ok(!fs.existsSync(path.join(S.personal, "media")), "no media copied");
    assert.ok(!fs.existsSync(path.join(S.personal, "source")), "no export copied");
  });

  test("a stray camera-roll file next to the real media is left out and counted", async () => {
    await S.post("/api/reset", {});
    const f = X.writeExport(scratch());
    fs.writeFileSync(path.join(f.media, "20230301-IMG_0001.jpg"), "x");
    const r = await source(S, f.group, f.headers, f.media);
    const j = await r.json();
    assert.equal(r.status, 200, JSON.stringify(j));
    assert.equal(j.mediaCopied, 3);
    assert.equal(j.mediaUnmatched, 1);
    assert.deepEqual(mediaNames(), ["9002-AbCdEf.png", "9002-ZzSecond.jpg", "9101-Other.mp4"]);
  });
});

describe("the native pickers need the setup page's token", () => {
  let S;
  before(async () => { S = await startServer(); });
  after(() => S.stop());
  const tokenFrom = (html) => (/window\.GCA_TOKEN="([0-9a-f]+)"/.exec(html) || [])[1];

  test("setup.html carries a random token; index.html does not; the server never prints it", async () => {
    const setup = await (await S.get("/setup.html")).text();
    const token = tokenFrom(setup);
    assert.match(token || "", /^[0-9a-f]{64}$/);
    assert.equal(tokenFrom(await (await S.get("/index.html")).text()), undefined);
    await S.get("/api/pick-file", { "X-GCA-Token": token });
    await new Promise((r) => setTimeout(r, 200));   // let any output reach us
    // The harness records stdout/stderr from spawn on,
    // so the startup banner is checked too, not just what came after boot
    assert.match(S.stdout(), /Group Chat Archive running at/, "the capture starts at spawn");
    assert.ok(!S.stderr().includes(token) && !S.stdout().includes(token), "the token is never logged");
  });

  test("no token (the no-referrer <img> attack) or a wrong one is refused; the right one reaches the picker", async () => {
    const token = tokenFrom(await (await S.get("/setup.html")).text());
    for (const p of ["/api/pick-file", "/api/pick-file?for=headers", "/api/pick-folder"]) {
      assert.equal((await S.get(p)).status, 403, p + " without a token");
      assert.equal((await S.get(p, { "X-GCA-Token": "0".repeat(64) })).status, 403, p + " with a wrong token");
      assert.equal((await S.get(p, { "X-GCA-Token": token, Origin: "http://localhost:9999" })).status, 403, p + " from another origin");
      const r = await S.get(p, { "X-GCA-Token": token });
      assert.equal(r.status, 200, p + " with the token");
      assert.deepEqual(await r.json(), { path: "", supported: false }, "GCA_NO_NATIVE_PICKER keeps tests from opening a dialog");
    }
  });

  test("each server start gets a new token", async () => {
    const S2 = await startServer();
    try {
      const a = tokenFrom(await (await S.get("/setup.html")).text());
      const b = tokenFrom(await (await S2.get("/setup.html")).text());
      assert.notEqual(a, b);
      assert.equal((await S2.get("/api/pick-folder", { "X-GCA-Token": a })).status, 403);
    } finally { S2.stop(); }
  });
});

const PNG1 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const pngOf = (bytes) => "data:image/png;base64," + Buffer.alloc(bytes, 7).toString("base64");

describe("photo limits are checked before anything is written", () => {
  let S;
  before(async () => { S = await startServer(); });
  after(() => S.stop());

  test("one over-size photo is refused by name and nothing from that save is written", async () => {
    await S.post("/api/reset", {});
    const r = await S.post("/api/identity", { names: { "111": "Ann", "222": "Bob" }, pfps: { "111": PNG1, "222": pngOf(11 * 1024 * 1024) }, gc: {} });
    const j = await r.json();
    assert.equal(r.status, 413);
    assert.match(j.error, /Bob/, "says whose photo it was");
    assert.match(j.error, /10 MB/);
    const pfps = path.join(S.personal, "pfps");
    assert.deepEqual(fs.existsSync(pfps) ? fs.readdirSync(pfps) : [], [], "Ann's photo is not orphaned on disk");
    assert.ok(!fs.existsSync(path.join(S.personal, "config.json")), "no half-applied save");
  });

  test("an over-size group photo is named as the group's photo", async () => {
    await S.post("/api/reset", {});
    const r = await S.post("/api/identity", { gc: { "1000000001": { name: "Crew", photo: pngOf(11 * 1024 * 1024) } } });
    assert.equal(r.status, 413);
    assert.match((await r.json()).error, /group photo.*Crew|Crew.*group photo/i);
  });
});

describe("group and person photos never share a file", () => {
  let S;
  before(async () => { S = await startServer(); });
  after(() => S.stop());

  test("a group and a person with the same name keep separate photo files", async () => {
    await S.post("/api/reset", {});
    const groupPng = pngOf(64), personPng = pngOf(96);
    assert.equal((await S.post("/api/identity", { gc: { "1000000001": { name: "Crew", photo: groupPng } } })).status, 200);
    assert.equal((await S.post("/api/identity", { names: { "111": "Crew" }, pfps: { "111": personPng } })).status, 200);
    const cfg = JSON.parse(fs.readFileSync(path.join(S.personal, "config.json"), "utf8"));
    const g = cfg.gc["1000000001"].photo, p = cfg.pfps["111"];
    assert.notEqual(g, p);
    const read = (rel) => fs.readFileSync(path.join(S.personal, rel.replace(/^personal_data\//, "")));
    assert.equal(read(g).length, 64, "the group photo still holds the group's bytes");
    assert.equal(read(p).length, 96);
  });

  test("a later group photo doesn't overwrite an earlier person photo of the same name either", async () => {
    await S.post("/api/reset", {});
    assert.equal((await S.post("/api/identity", { names: { "111": "Crew" }, pfps: { "111": pngOf(96) } })).status, 200);
    assert.equal((await S.post("/api/identity", { gc: { "1000000001": { name: "Crew", photo: pngOf(64) } } })).status, 200);
    const cfg = JSON.parse(fs.readFileSync(path.join(S.personal, "config.json"), "utf8"));
    const read = (rel) => fs.readFileSync(path.join(S.personal, rel.replace(/^personal_data\//, "")));
    assert.equal(read(cfg.pfps["111"]).length, 96);
    assert.equal(read(cfg.gc["1000000001"].photo).length, 64);
  });
});

describe("the pages can't be framed", () => {
  let S;
  before(async () => { S = await startServer(); });
  after(() => S.stop());

  for (const p of ["/setup.html", "/index.html", "/"]) {
    test(p + " is sent with X-Frame-Options: DENY and CSP frame-ancestors 'none'", async () => {
      const r = await S.get(p);
      assert.equal(r.status, 200);
      assert.equal(r.headers.get("x-frame-options"), "DENY");
      assert.match(r.headers.get("content-security-policy") || "", /frame-ancestors 'none'/);
    });
  }
  test("a Range request for a page carries the same headers", async () => {
    const r = await S.get("/index.html", { Range: "bytes=0-9" });
    assert.equal(r.status, 206);
    assert.equal(r.headers.get("x-frame-options"), "DENY");
    assert.match(r.headers.get("content-security-policy") || "", /frame-ancestors 'none'/);
  });
});

describe("header-only members reach the naming step", () => {
  let S;
  before(async () => { S = await startServer(); });
  after(() => S.stop());

  test("a member known only from the headers file is in /api/parts with 0 messages and a join date", async () => {
    const f = X.writeExport(scratch());
    assert.equal((await source(S, f.group, f.headers, f.media)).status, 200);
    const j = await (await S.get("/api/parts?group=1000000001")).json();
    const lurker = j.parts.find((p) => p.id === "444");
    assert.ok(lurker, "444 has a card");
    assert.equal(lurker.count, 0);
    assert.equal(lurker.joined, X.T0 + 5000);
  });
});

// The People step labels an unnamed person with the viewer's "User N" for the
// chat (shared-core userLabels over the built chat), and a removed person is
// left out of the numbering as the viewer leaves them out.
describe("/api/parts labels people as the viewer numbers them", () => {
  let S;
  before(async () => { S = await startServer(); });
  after(() => S.stop());

  test("each part's label is the chat's User N; a removed person shifts the rest", async () => {
    const { userLabels } = require("../src/shared-core.js");
    const f = X.writeExport(scratch());
    assert.equal((await source(S, f.group, f.headers, f.media)).status, 200);
    const labelsOf = async () => {
      const j = await (await S.get("/api/parts?group=1000000001")).json();
      return Object.fromEntries(j.parts.filter((p) => p.label).map((p) => [p.id, p.label]));
    };
    const conv = () => readData(S.personal).conversations.find((c) => String(c.id) === "1000000001");
    const before = await labelsOf();
    assert.ok(Object.keys(before).length >= 3, JSON.stringify(before));
    assert.deepEqual(before, userLabels(conv()));
    const first = Object.keys(before).find((id) => before[id] === "User 1");
    const r = await S.post("/api/identity", { names: {}, pfps: {}, gc: {}, ignoredUsers: [first], ignoredGroups: [] });
    assert.equal(r.status, 200, await r.text());
    const after = await labelsOf();
    assert.equal(after[first], undefined);
    assert.deepEqual(after, userLabels(conv(), [first]));
  });
});

describe("paths are accepted the way people paste them", () => {
  let S, home;
  before(async () => {
    home = scratch("gca-sp6-home-");
    S = await startServer({ HOME: home, USERPROFILE: home });   // os.homedir() for this server only
  });
  after(() => S.stop());

  test("Explorer's quoted \"Copy as path\" works for all three fields", async () => {
    await S.post("/api/reset", {});
    const f = X.writeExport(scratch());
    const q = (p) => '"' + p + '"';
    const r = await source(S, q(f.group), q(f.headers), "  " + q(f.media) + "  ");
    assert.equal(r.status, 200, JSON.stringify(await r.json()));
  });

  test("~/ paths resolve against the home folder", async () => {
    await S.post("/api/reset", {});
    const f = X.writeExport(path.join(home, "Downloads", "twitter-export"));
    const rel = (p) => "~/" + path.relative(home, p).split(path.sep).join("/");
    const r = await source(S, rel(f.group), rel(f.headers), rel(f.media));
    assert.equal(r.status, 200, JSON.stringify(await r.json()));
  });

  test("a path that isn't there says to paste the full path, with an example", async () => {
    const f = X.writeExport(scratch());
    const r = await source(S, "direct-messages-group.js", f.headers, f.media);
    const j = await r.json();
    assert.equal(r.status, 400);
    assert.match(j.error, /not found: direct-messages-group\.js\. Paste the full path, e\.g\. /);
  });
});

describe("'This is YOU' and names can be cleared", () => {
  let S;
  before(async () => { S = await startServer(); });
  after(() => S.stop());
  const cfg = () => JSON.parse(fs.readFileSync(path.join(S.personal, "config.json"), "utf8"));
  const local = () => fs.readFileSync(path.join(S.personal, "local.js"), "utf8");

  test("me: \"\" clears a saved 'this is you'; leaving me out keeps it", async () => {
    await S.post("/api/reset", {});
    await S.post("/api/identity", { me: "111", names: {} });
    assert.equal(cfg().me, "111");
    await S.post("/api/identity", { names: {} });
    assert.equal(cfg().me, "111", "not sent = unchanged");
    await S.post("/api/identity", { me: "", names: {} });
    assert.equal(cfg().me, null);
    assert.match(local(), /window\.LOCAL_ME = null;/);
  });

  test("a name posted as \"\" is removed from config and local.js", async () => {
    await S.post("/api/reset", {});
    await S.post("/api/identity", { names: { "111": "Ann", "222": "Bob" } });
    await S.post("/api/identity", { names: { "111": "" } });
    assert.deepEqual(cfg().names, { "222": "Bob" });
    assert.doesNotMatch(local(), /Ann/);
  });
});

describe("removing a group or person deletes their messages and media", () => {
  let S, f;
  before(async () => {
    S = await startServer();
    f = X.writeExport(scratch());
    assert.equal((await source(S, f.group, f.headers, f.media)).status, 200);
  });
  after(() => S.stop());
  const media = () => fs.readdirSync(path.join(S.personal, "media")).sort();
  const dataText = () => fs.readFileSync(path.join(S.personal, "data.js"), "utf8");
  const identity = (extra) => S.post("/api/identity", Object.assign({ names: {}, pfps: {}, gc: {} }, extra));

  test("saving names without changing what's removed does not rebuild", async () => {
    const before = fs.statSync(path.join(S.personal, "data.js")).mtimeMs;
    const r = await identity({ names: { "111": "Ann" }, ignoredGroups: [], ignoredUsers: [] });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).rebuilt, false);
    assert.equal(fs.statSync(path.join(S.personal, "data.js")).mtimeMs, before);
  });

  test("a removed group chat is gone from data.js and its media from media/", async () => {
    const r = await identity({ ignoredGroups: ["1000000002"], ignoredUsers: [] });
    const j = await r.json();
    assert.equal(r.status, 200, JSON.stringify(j));
    assert.equal(j.rebuilt, true);
    assert.equal(j.mediaRemoved, 1);
    const d = readData(S.personal);
    assert.deepEqual(d.conversations.map((c) => c.id), ["1000000001"]);
    assert.doesNotMatch(dataText(), /other group message/);
    assert.deepEqual(media(), ["9002-AbCdEf.png", "9002-ZzSecond.jpg"]);
  });

  test("a removed person's messages and media are gone too", async () => {
    const r = await identity({ ignoredGroups: ["1000000002"], ignoredUsers: ["222"] });
    assert.equal(r.status, 200);
    const g = readData(S.personal).conversations[0];
    assert.ok(!g.msgs.some((m) => m.s === "222"), "no message from 222 is left");
    assert.ok(!g.participants.includes("222"));
    assert.deepEqual(media(), [], "9002's two files were 222's");
  });

  test("un-removing brings the group, the person and their media back from the export", async () => {
    const r = await identity({ ignoredGroups: [], ignoredUsers: [] });
    assert.equal(r.status, 200);
    const d = readData(S.personal);
    assert.deepEqual(d.conversations.map((c) => c.id).sort(), ["1000000001", "1000000002"]);
    assert.ok(d.conversations.find((c) => c.id === "1000000001").msgs.some((m) => m.s === "222"));
    assert.deepEqual(media(), ["9002-AbCdEf.png", "9002-ZzSecond.jpg", "9101-Other.mp4"]);
  });
});

// Removing deletes data, so it is previewed (the
// wizard asks first, with real counts), removed media goes to a quarantine
// folder instead of being deleted (un-removing brings it back even when the
// original export folder is gone), and the previous data.js is kept as
// data.js.bak. None of it is ever served; Start over erases all of it.
describe("removal is previewed, quarantined and backed up", () => {
  let S, f;
  before(async () => {
    S = await startServer();
    f = X.writeExport(scratch());
    assert.equal((await source(S, f.group, f.headers, f.media)).status, 200);
  });
  after(() => S.stop());
  const P = (...a) => path.join(S.personal, ...a);
  const media = () => fs.readdirSync(P("media")).sort();
  const identity = (extra) => S.post("/api/identity", Object.assign({ names: {}, pfps: {}, gc: {} }, extra));

  test("the removal preview counts what would go, without changing anything", async () => {
    const before = fs.readFileSync(P("data.js"), "utf8");
    const r = await S.post("/api/removal-preview", { ignoredGroups: ["1000000002"], ignoredUsers: ["222"] });
    const j = await r.json();
    assert.equal(r.status, 200, JSON.stringify(j));
    // group 1000000002: 9101 + 9102 (1 file); person 222: 9002 + 9005 (2 files of 9002)
    assert.deepEqual(j, { messages: 4, media: 3, groups: 1, people: 1 });
    const g = await (await S.post("/api/removal-preview", { ignoredGroups: ["1000000002"], ignoredUsers: [] })).json();
    assert.deepEqual(g, { messages: 2, media: 1, groups: 1, people: 0 });
    assert.equal(fs.readFileSync(P("data.js"), "utf8"), before);
  });

  test("a removed group's media is moved to .removed/group/<id>/, and data.js.bak is the previous archive", async () => {
    const prev = fs.readFileSync(P("data.js"), "utf8");
    const j = await (await identity({ ignoredGroups: ["1000000002"], ignoredUsers: [] })).json();
    assert.equal(j.rebuilt, true, JSON.stringify(j));
    assert.equal(j.mediaRemoved, 1);
    assert.deepEqual(media(), ["9002-AbCdEf.png", "9002-ZzSecond.jpg"]);
    assert.equal(fs.readFileSync(P(".removed", "group", "1000000002", "9101-Other.mp4"), "utf8"), "mp4");
    assert.equal(fs.readFileSync(P("data.js.bak"), "utf8"), prev, "data.js.bak holds the archive before this build");
  });

  test("a removed person's media is moved to .removed/person/<id>/", async () => {
    const j = await (await identity({ ignoredGroups: ["1000000002"], ignoredUsers: ["222"] })).json();
    assert.equal(j.rebuilt, true);
    assert.deepEqual(media(), []);
    assert.deepEqual(fs.readdirSync(P(".removed", "person", "222")).sort(), ["9002-AbCdEf.png", "9002-ZzSecond.jpg"]);
  });

  test("quarantined media, the backup and config are never served", async () => {
    assert.ok(fs.existsSync(P(".removed", "messages.js")), "the removed messages are quarantined too");
    for (const p of ["/personal_data/.removed/person/222/9002-AbCdEf.png", "/personal_data/.removed/group/1000000002/9101-Other.mp4", "/personal_data/.removed/messages.js", "/personal_data/data.js.bak"]) {
      assert.equal((await S.get(p)).status, 404, p);
    }
  });

  test("un-removing restores media from quarantine even after the original media folder is gone", async () => {
    fs.rmSync(f.media, { recursive: true, force: true });
    const j = await (await identity({ ignoredGroups: [], ignoredUsers: [] })).json();
    assert.equal(j.rebuilt, true);
    assert.deepEqual(media(), ["9002-AbCdEf.png", "9002-ZzSecond.jpg", "9101-Other.mp4"]);
    assert.equal(fs.readFileSync(P("media", "9101-Other.mp4"), "utf8"), "mp4");
    assert.ok(!fs.existsSync(P(".removed", "person", "222", "9002-AbCdEf.png")));
  });

  test("Start over erases the quarantine and data.js.bak", async () => {
    assert.equal((await identity({ ignoredGroups: ["1000000002"], ignoredUsers: [] })).status, 200);
    assert.ok(fs.existsSync(P(".removed")) && fs.existsSync(P("data.js.bak")));
    assert.equal((await S.post("/api/reset", {})).status, 200);
    assert.ok(!fs.existsSync(P(".removed")), ".removed/ erased");
    assert.ok(!fs.existsSync(P("data.js.bak")), "data.js.bak erased");
  });
});

// "did the removed set change?" was answered from
// config.json, which is saved BEFORE the rebuild runs — so after a failed
// rebuild the next save saw "no change" and never retried. It is now answered
// from what data.js itself was built without (its ignoredUsers/ignoredGroups).
describe("a failed removal rebuild is retried by the next save", () => {
  let S, f;
  before(async () => {
    S = await startServer();
    f = X.writeExport(scratch());
    assert.equal((await source(S, f.group, f.headers, f.media)).status, 200);
  });
  after(() => S.stop());
  const identity = (extra) => S.post("/api/identity", Object.assign({ names: {}, pfps: {}, gc: {} }, extra));

  test("the rebuild fails once, then the same save rebuilds", async () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(S.personal, "config.json"), "utf8"));
    const src = cfg.sourceJs[0], aside = src + ".away";
    fs.renameSync(src, aside);                       // make the build fail
    const r1 = await identity({ ignoredGroups: ["1000000002"], ignoredUsers: [] });
    assert.equal(r1.status, 422);
    assert.ok(readData(S.personal).conversations.some((c) => c.id === "1000000002"), "still in data.js after the failed rebuild");
    fs.renameSync(aside, src);                       // fixed
    const r2 = await identity({ ignoredGroups: ["1000000002"], ignoredUsers: [] });
    const j2 = await r2.json();
    assert.equal(r2.status, 200, JSON.stringify(j2));
    assert.equal(j2.rebuilt, true, "the save retries the rebuild");
    assert.deepEqual(readData(S.personal).conversations.map((c) => c.id), ["1000000001"]);
    const j3 = await (await identity({ ignoredGroups: ["1000000002"], ignoredUsers: [] })).json();
    assert.equal(j3.rebuilt, false, "once data.js matches, saving again doesn't rebuild");
  });
});

describe("not enough disk space is caught before copying", () => {
  let S;
  before(async () => { S = await startServer({ GCA_TEST_FREE_BYTES: "1024" }); });   // pretend the disk is full
  after(() => S.stop());

  test("the build is refused with a plain message and nothing is copied", async () => {
    const f = X.writeExport(scratch());
    const r = await source(S, f.group, f.headers, f.media);
    const j = await r.json();
    assert.equal(r.status, 507, JSON.stringify(j));
    assert.match(j.error, /Not enough free disk space/);
    assert.ok(!fs.existsSync(path.join(S.personal, "media")), "no media copied");
    assert.ok(!fs.existsSync(path.join(S.personal, "source")), "no export copied");
  });
});

// When the build after a new /api/source failed,
// config.json was put back but source/ and media/ had already been
// overwritten with the new (failing) export. They are now restored too.
describe("a failed source build leaves the previous copies as they were", () => {
  let S, f;
  before(async () => {
    S = await startServer();
    f = X.writeExport(scratch());
    assert.equal((await source(S, f.group, f.headers, f.media)).status, 200);
  });
  after(() => S.stop());
  const snapshot = () => {
    const out = {};
    for (const d of ["source", "media"]) {
      for (const n of fs.readdirSync(path.join(S.personal, d))) out[d + "/" + n] = fs.readFileSync(path.join(S.personal, d, n), "utf8");
    }
    for (const n of ["config.json", "data.js"]) out[n] = fs.readFileSync(path.join(S.personal, n), "utf8");
    return out;
  };

  test("an export whose build fails changes nothing in personal_data/", async () => {
    const before = snapshot();
    // Same file names as the first export, but the messages file is cut off
    // part-way (a damaged download), so the build refuses it.
    const bad = scratch(), data = path.join(bad, "data"), media = path.join(data, "direct_messages_group_media");
    fs.mkdirSync(media, { recursive: true });
    fs.writeFileSync(path.join(data, "direct-messages-group.js"), X.ytd("direct_messages_group", "part0", [X.conv("1000000001", [X.gmsg(9002, 111, X.T0, "cut off")])]).slice(0, -40));
    fs.writeFileSync(path.join(data, "direct-message-group-headers.js"), X.ytd("direct_message_group_headers", "part0", []));
    fs.writeFileSync(path.join(media, "9002-AbCdEf.png"), "a different picture");   // same name as one already copied
    fs.writeFileSync(path.join(media, "9002-Brandnew.jpg"), "new");
    const r = await source(S, path.join(data, "direct-messages-group.js"), path.join(data, "direct-message-group-headers.js"), media);
    const j = await r.json();
    assert.equal(r.status, 422, JSON.stringify(j));
    assert.deepEqual(snapshot(), before, "source/, media/, config.json and data.js are exactly as before");
    assert.deepEqual(fs.readdirSync(S.personal).filter((n) => /\.prev-/.test(n)), [], "no backup folders left behind");
  });

  test("Start over also removes backup folders an interrupted source change left behind", async () => {
    fs.mkdirSync(path.join(S.personal, "source.prev-123-0a1b2c3d"));
    fs.mkdirSync(path.join(S.personal, "media.prev-123-0a1b2c3d"));
    assert.equal((await S.post("/api/reset", {})).status, 200);
    assert.deepEqual(fs.readdirSync(S.personal), []);
  });
});

// A hand-made /api/parts URL with a broken % escape is bad input, not a
// server fault: a plain 400, and no stack trace in the launcher window.
describe("a malformed group id in /api/parts", () => {
  let S;
  before(async () => { S = await startServer(); });
  after(() => S.stop());

  test("answers 400 with a plain sentence and logs no stack", async () => {
    const r = await S.get("/api/parts?group=%E0%A4%A");
    const j = await r.json();
    assert.equal(r.status, 400, JSON.stringify(j));
    assert.equal(j.error, "Bad group id.");
    assert.doesNotMatch(S.stderr(), /URIError|^\s+at /m);
  });
});

// config.json is the only record of where the export copies are and who is
// removed. A BOM (Notepad) is read like build.js reads it; a file that can't
// be parsed is reported, never taken as empty and saved over.
describe("config.json that isn't plain JSON", () => {
  let S;
  before(async () => { S = await startServer(); });
  after(() => S.stop());
  const cfgFile = () => path.join(S.personal, "config.json");

  test("a config.json saved with a BOM is still read", async () => {
    fs.writeFileSync(cfgFile(), "\uFEFF" + JSON.stringify({ names: { "111": "Ann" }, ignoredUsers: ["333"] }));
    const j = await (await S.get("/api/status")).json();
    assert.deepEqual(j.names, { "111": "Ann" });
    assert.deepEqual(j.ignoredUsers, ["333"]);
  });

  test("a damaged config.json makes a save fail plainly and is left exactly as it was", async () => {
    const damaged = "{\"sourceJs\":[\"C:/x/direct-messages-group.js\"],\"names\":{\"111\":";
    fs.writeFileSync(cfgFile(), damaged);
    const r = await S.post("/api/identity", { names: { "222": "Bo" }, pfps: {}, gc: {}, ignoredUsers: [], ignoredGroups: [] });
    const j = await r.json();
    assert.ok(r.status >= 400, JSON.stringify(j));
    assert.match(j.error, /config\.json/);
    assert.equal(fs.readFileSync(cfgFile(), "utf8"), damaged);
    assert.ok(!fs.existsSync(path.join(S.personal, "local.js")), "nothing else was written either");
  });
});

// The free-space check counts only what the merge will copy: media the
// archive already has is kept, not copied again, so it needs no new space.
describe("adding a newer export whose media the archive mostly has", () => {
  let personal;
  before(() => { personal = scratch("gca-sp6-space-"); });

  test("is not refused for space the copy won't use", async () => {
    const big = Buffer.alloc(8 * 1048576, 7);   // a big video both exports have
    const A = X.writeExport(scratch());
    fs.writeFileSync(path.join(A.media, "9002-AbCdEf.png"), big);
    const S1 = await startServer({}, { personal });
    try { assert.equal((await source(S1, A.group, A.headers, A.media)).status, 200); }
    finally { S1.proc.kill(); }
    assert.equal(fs.statSync(path.join(personal, "media", "9002-AbCdEf.png")).size, big.length);

    const B = X.writeExportB(scratch());
    fs.writeFileSync(path.join(B.media, "9002-AbCdEf.png"), big);
    // room for the 64 MB margin, twice B's small .js files and its few new
    // pictures, but not for copying the big file again
    const S2 = await startServer({ GCA_TEST_FREE_BYTES: String(65 * 1048576) }, { personal });
    try {
      const r = await S2.post("/api/source", { archiveRoot: B.root });
      const j = await r.json();
      assert.equal(r.status, 200, JSON.stringify(j));
      assert.ok(fs.existsSync(path.join(personal, "media", "9007-NewPic.jpg")), "B's new picture is copied");
    } finally { S2.proc.kill(); }
  });
});

// Putting things back after a failed build must not stop at the first step
// that fails. A backup folder Explorer keeps open can't be removed, but every
// file is still put back (it is just left for a later build to tidy), and a
// successful build isn't reported as failed because of it. A file that really
// couldn't be put back is named in the reply, not only in the console.
describe("putting files back when a backup folder or file is held by another program", () => {
  const PRELOAD = path.join(__dirname, "fixtures", "fs-busy-preload.js");
  const snapshot = (personal) => {
    const out = {};
    for (const d of ["source", "media"]) {
      for (const n of fs.readdirSync(path.join(personal, d))) out[d + "/" + n] = fs.readFileSync(path.join(personal, d, n), "utf8");
    }
    for (const n of ["config.json", "data.js"]) out[n] = fs.readFileSync(path.join(personal, n), "utf8");
    return out;
  };
  // the same names as X.writeExport's files, but the messages file is cut off
  // (the build refuses it) and one picture differs, so media/ is changed too
  const badExport = () => {
    const bad = scratch(), data = path.join(bad, "data"), media = path.join(data, "direct_messages_group_media");
    fs.mkdirSync(media, { recursive: true });
    fs.writeFileSync(path.join(data, "direct-messages-group.js"), X.ytd("direct_messages_group", "part0", [X.conv("1000000001", [X.gmsg(9002, 111, X.T0, "cut off")])]).slice(0, -40));
    fs.writeFileSync(path.join(data, "direct-message-group-headers.js"), X.ytd("direct_message_group_headers", "part0", []));
    fs.writeFileSync(path.join(media, "9002-Brandnew.jpg"), "new");
    return { group: path.join(data, "direct-messages-group.js"), headers: path.join(data, "direct-message-group-headers.js"), media };
  };

  describe("the source backup folder can't be removed", () => {
    let S, f;
    before(async () => {
      S = await startServer({ GCA_TEST_BUSY_RM: String.raw`source\.prev-\d+-[0-9a-f]+$` }, { nodeArgs: ["--require", PRELOAD] });
      f = X.writeExport(scratch());
      assert.equal((await source(S, f.group, f.headers, f.media)).status, 200);
    });
    after(() => S.stop());

    test("a failed build still puts everything else back and reports the build's own error", async () => {
      const before0 = snapshot(S.personal);
      const b = badExport();
      const r = await source(S, b.group, b.headers, b.media);
      const j = await r.json();
      assert.equal(r.status, 422, JSON.stringify(j));
      assert.doesNotMatch(j.error, /in use|EBUSY/, "the build's error, not the backup folder's");
      assert.deepEqual(snapshot(S.personal), before0);
    });

    test("a build that succeeds is reported as a success", async () => {
      const r = await source(S, f.group, f.headers, f.media);
      const j = await r.json();
      assert.equal(r.status, 200, JSON.stringify(j));
    });
  });

  describe("a previous media file can't be moved back", () => {
    let personal, S;
    before(async () => {
      personal = scratch("gca-sp6-busy-");
      const f = X.writeExport(scratch());
      const S1 = await startServer({}, { personal });
      try { assert.equal((await source(S1, f.group, f.headers, f.media)).status, 200); }
      finally { S1.proc.kill(); }
      // an empty file counts as missing, so the next copy backs it up and replaces it
      fs.writeFileSync(path.join(personal, "media", "9002-AbCdEf.png"), "");
      S = await startServer({ GCA_TEST_BUSY_RENAME: String.raw`media\.prev-`, GCA_TEST_BUILD_CRASH: "after-quarantine" }, { personal, nodeArgs: ["--require", PRELOAD] });
    });
    after(() => S.proc.kill());

    test("the reply says some previous files are kept aside, and source/ and config.json are still put back", async () => {
      const before0 = snapshot(personal);
      const f = X.writeExport(scratch());
      const r = await source(S, f.group, f.headers, f.media);
      const j = await r.json();
      assert.equal(r.status, 422, JSON.stringify(j));
      assert.match(j.error, /\.prev-/, "says where the previous copies are");
      const after0 = snapshot(personal);
      assert.equal(after0["config.json"], before0["config.json"]);
      for (const k of Object.keys(before0).filter((k) => k.startsWith("source/"))) assert.equal(after0[k], before0[k], k);
      assert.ok(fs.readdirSync(personal).some((n) => /^media\.prev-/.test(n)), "the previous picture is kept in its backup folder");
    });
  });
});

// A media copy that fails part-way puts the previous files back too; one that
// can't be put back is named in that reply as well, not only in the console.
describe("a media copy fails and a previous file can't be moved back", () => {
  const PRELOAD = path.join(__dirname, "fixtures", "fs-busy-preload.js");
  let personal, S;
  before(async () => {
    personal = scratch("gca-sp6-copyfail-");
    const f = X.writeExport(scratch());
    const S1 = await startServer({}, { personal });
    try { assert.equal((await source(S1, f.group, f.headers, f.media)).status, 200); }
    finally { S1.proc.kill(); }
    // an empty file counts as missing: the copy backs it up, then fails
    fs.writeFileSync(path.join(personal, "media", "9002-AbCdEf.png"), "");
    S = await startServer({ GCA_TEST_BUSY_RENAME: String.raw`media\.prev-`, GCA_TEST_BUSY_COPY: String.raw`direct_messages_group_media[\\/]9002-AbCdEf` },
      { personal, nodeArgs: ["--require", PRELOAD] });
  });
  after(() => S.proc.kill());

  test("the reply gives the copy's error and says where the previous file is kept", async () => {
    const f = X.writeExport(scratch());
    const r = await source(S, f.group, f.headers, f.media);
    const j = await r.json();
    assert.ok(r.status >= 400, JSON.stringify(j));
    assert.match(j.error, /in use by another program/, "the copy's own error");
    assert.match(j.error, /\.prev-/, "says where the previous copies are");
    assert.ok(fs.readdirSync(personal).some((n) => /^media\.prev-/.test(n)), "the previous picture is kept in its backup folder");
  });
});

// Media is streamed from disk. A file that stat sees but can't be read must
// not take the server down, and a video request the browser abandons (a seek,
// a lazy image scrolled away) must not keep its file open for good.
describe("streaming media files", () => {
  const PRELOAD = path.join(__dirname, "fixtures", "stream-watch-preload.js");
  const http = require("node:http");
  let S;
  before(async () => {
    S = await startServer({ GCA_TEST_UNREADABLE: "unreadable" }, { nodeArgs: ["--require", PRELOAD] });
    const media = path.join(S.personal, "media");
    fs.mkdirSync(media, { recursive: true });
    fs.writeFileSync(path.join(media, "9001-Big.mp4"), Buffer.alloc(8 * 1048576, 1));
    fs.writeFileSync(path.join(media, "9002-unreadable.jpg"), "a picture");
  });
  after(() => S.stop());
  const openStreams = async () => (await (await S.get("/__test/open-streams")).json()).open;
  // read the first chunk of the reply, then hang up
  const abandon = (p, headers) => new Promise((resolve, reject) => {
    const req = http.get(S.url(p), { headers }, (res) => { res.once("data", () => { req.destroy(); resolve(res.statusCode); }); });
    req.on("error", (e) => (e.code === "ECONNRESET" ? resolve(0) : reject(e)));
  });

  // The file is opened before the reply starts, so the browser gets a real
  // 500 (not a cut connection) and the server keeps running.
  test("a file that can't be opened answers 500; the server keeps running", async () => {
    for (const range of [null, "bytes=0-"]) {
      const r = await S.get("/personal_data/media/9002-unreadable.jpg", range ? { Range: range } : {});
      await r.arrayBuffer();
      assert.equal(r.status, 500, "the request fails with 500 (" + (range || "full") + ")");
    }
    assert.equal((await S.get("/api/ping")).status, 200, "still running: " + S.stderr());
  });

  test("abandoned video requests don't leave their files open", async () => {
    for (let i = 0; i < 20; i++) await abandon("/personal_data/media/9001-Big.mp4", i % 2 ? { Range: "bytes=0-" } : {});
    let n = -1;
    for (let t = 0; t < 40 && n !== 0; t++) { n = await openStreams(); if (n) await new Promise((r) => setTimeout(r, 50)); }
    assert.equal(n, 0, "every file stream is closed");
  });
});
