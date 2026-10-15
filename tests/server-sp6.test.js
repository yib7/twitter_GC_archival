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
