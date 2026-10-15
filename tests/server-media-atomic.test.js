/*
 * media copies never replace a good file and never
 * leave a partial one. X names group media "<messageId>-<mediaId>.<ext>", so
 * a name already in personal_data/media is the same picture — a merge keeps
 * it (an empty file counts as missing). Every copy goes to a temp name and
 * is renamed into place, so a file at its real name is always complete; a
 * crash's temp files are cleared by the next successful build.
 * Real servers (GCA_PORT=0, mkdtemp GCA_PERSONAL); synthetic exports only.
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
const scratch = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p || "gca-media-atomic-")); tmpDirs.push(d); return d; };
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });
const source = (S, f) => S.post("/api/source", { groupJs: f.group, headersJs: f.headers, mediaDir: f.media });
const TMP = /\.\d+\.[0-9a-f]{8}\.tmp$/;

describe("a merge never replaces media the archive already has", () => {
  let S;
  before(async () => { S = await startServer(); });
  after(() => S.stop());
  const M = (n) => path.join(S.personal, "media", n);

  test("a truncated same-name file in the newer export doesn't replace the good copy", async () => {
    assert.equal((await source(S, X.writeExport(scratch()))).status, 200);
    assert.equal(fs.readFileSync(M("9002-AbCdEf.png"), "utf8"), "png-1");
    // a later download of the same chats whose copy of 9002's photo was cut short
    const again = X.writeExport(scratch(), { manifest: true });
    fs.writeFileSync(path.join(again.media, "9002-AbCdEf.png"), "pn");
    fs.writeFileSync(path.join(again.media, "9003-Late.jpg"), "jpg-late");   // and one new file
    const r = await S.post("/api/source", { archiveRoot: again.root });
    assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
    assert.equal(fs.readFileSync(M("9002-AbCdEf.png"), "utf8"), "png-1");
    assert.equal(fs.readFileSync(M("9003-Late.jpg"), "utf8"), "jpg-late", "new media is still copied");
  });

  test("an empty file in media/ counts as missing and is copied again", async () => {
    fs.writeFileSync(M("9002-ZzSecond.jpg"), "");
    const j = await (await source(S, X.writeExport(scratch()))).json();
    assert.equal(fs.readFileSync(M("9002-ZzSecond.jpg"), "utf8"), "jpg-2", JSON.stringify(j));
  });
});

describe("a crash mid-copy leaves no partial file at its real name", () => {
  let personal, f;
  before(() => { personal = scratch("gca-media-crash-personal-"); f = X.writeExport(scratch()); });

  test("the copy is cut off half-way through 9101-Other.mp4", async () => {
    const S = await startServer({ GCA_TEST_COPY_CRASH: "9101-Other.mp4" }, { personal });
    try {
      const timeout = new Promise((r) => setTimeout(() => r("alive"), 15000));
      const exited = new Promise((r) => { if (S.proc.exitCode != null) r("exited"); else S.proc.once("exit", () => r("exited")); });
      source(S, f).catch(() => {});
      assert.equal(await Promise.race([exited, timeout]), "exited", "the server stopped mid-copy");
    } finally { try { S.proc.kill(); } catch (e) { /* gone */ } }
    const names = fs.readdirSync(path.join(personal, "media"));
    assert.ok(!names.includes("9101-Other.mp4"), "no partial file under the real name: " + names.join(", "));
    assert.ok(names.some((n) => n.startsWith("9101-Other.mp4.") && TMP.test(n)), "the partial copy is a temp file: " + names.join(", "));
  });

  test("the next build copies it whole and clears the temp file", async () => {
    const S = await startServer({}, { personal });
    try {
      const r = await source(S, f);
      assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
      const names = fs.readdirSync(path.join(personal, "media")).sort();
      assert.deepEqual(names, ["9002-AbCdEf.png", "9002-ZzSecond.jpg", "9101-Other.mp4"]);
      assert.equal(fs.readFileSync(path.join(personal, "media", "9101-Other.mp4"), "utf8"), "mp4");
      assert.ok(!fs.readdirSync(path.join(personal, "source")).some((n) => TMP.test(n)));
    } finally { S.stop(); }
  });
});

test("a crash's temp file is never indexed as a message's media", () => {
  const core = require("../scripts/build-core.js");
  assert.deepEqual(core.indexMediaFiles(["9002-AbCdEf.png", "9002-AbCdEf.png.4242.0a1b2c3d.tmp"], "personal_data/media"), { 9002: ["personal_data/media/9002-AbCdEf.png"] });
});
