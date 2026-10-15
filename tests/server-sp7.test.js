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
