/*
 * SP6 (ingestion robustness) — the setup server end to end, over synthetic
 * exports only (tests/fixtures/x-export.js), each server on its own GCA_PORT=0
 * + mkdtemp GCA_PERSONAL (see tests/_sp6-server.js).
 */
require("./_real-data-guard.js");   // QA-2: refuse to run outside a clean checkout
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

describe("SP-9: crash-safe server writes", () => {
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


describe("SP-2: multi-part exports through the wizard", () => {
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

describe("SP-8: swapped messages / headers files", () => {
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

describe("SP-7: the media folder is validated and only message media is copied", () => {
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
});

describe("SP-11: the native pickers need the setup page's token", () => {
  let S;
  before(async () => { S = await startServer(); });
  after(() => S.stop());
  const tokenFrom = (html) => (/window\.GCA_TOKEN="([0-9a-f]+)"/.exec(html) || [])[1];

  test("setup.html carries a random token; index.html does not; the server never prints it", async () => {
    const setup = await (await S.get("/setup.html")).text();
    const token = tokenFrom(setup);
    assert.match(token || "", /^[0-9a-f]{64}$/);
    assert.equal(tokenFrom(await (await S.get("/index.html")).text()), undefined);
    let out = "";
    S.proc.stdout.on("data", (c) => { out += c; });
    await S.get("/api/pick-file", { "X-GCA-Token": token });
    assert.ok(!S.stderr().includes(token) && !out.includes(token), "the token is never logged");
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

describe("SP-12: photo limits are checked before anything is written", () => {
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

describe("SP-19: group and person photos never share a file", () => {
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

describe("SP-22: the pages can't be framed", () => {
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

describe("SP-13: header-only members reach the naming step", () => {
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
