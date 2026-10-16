/*
 * Re-picking a file that already lives in personal_data/source, typed with
 * different letter case. On a case-insensitive filesystem (Windows, default
 * macOS) that is the same file, so the wizard must see "already in place" and
 * not try to copy the file over itself.
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
function scratch(prefix) { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix || "gca-repick-")); tmpDirs.push(d); return d; }
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

describe("re-picking a file already in personal_data/source", () => {
  let S, f;
  before(async () => {
    S = await startServer();
    f = X.writeExport(scratch());
    const first = await S.post("/api/source", { groupJs: f.group, headersJs: f.headers, mediaDir: f.media });
    assert.equal(first.status, 200, JSON.stringify(await first.json()));
  });
  after(() => S.stop());

  const inSource = (name) => path.join(S.personal, "source", name);
  const repick = (groupAbs, headersAbs) => S.post("/api/source", { groupJs: groupAbs, headersJs: headersAbs, mediaDir: f.media });

  test("the same path, same case, is taken as already in place", async () => {
    const r = await repick(inSource(path.basename(f.group)), inSource(path.basename(f.headers)));
    assert.equal(r.status, 200, JSON.stringify(await r.json()));
  });

  test("the same path in a different letter case is taken as already in place too (case-insensitive filesystems)", async (t) => {
    const lower = inSource(path.basename(f.group));
    const shouted = lower.toUpperCase();
    if (!fs.existsSync(shouted)) return t.skip("this filesystem is case-sensitive: different case is a different file");
    const r = await repick(shouted, inSource(path.basename(f.headers)).toUpperCase());
    const j = await r.json();
    assert.equal(r.status, 200, JSON.stringify(j));
    assert.ok(fs.existsSync(lower), "the file is still where it was");
  });
});
