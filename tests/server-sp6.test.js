/*
 * SP6 (ingestion robustness) — the setup server end to end, over synthetic
 * exports only (tests/fixtures/x-export.js), each server on its own GCA_PORT=0
 * + mkdtemp GCA_PERSONAL (see tests/_sp6-server.js).
 */
require("./_real-data-guard.js");   // QA-2: refuse to run outside a clean checkout
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { startServer } = require("./_sp6-server.js");

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

