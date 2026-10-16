/*
 * A save that races a merge.
 *
 * Every server here is the shared harness's: GCA_PORT=0, an empty mkdtemp
 * GCA_PERSONAL, the root fallbacks off and no native pickers. The export is
 * the synthetic fixture (tests/fixtures/x-export.js).
 */
require("./_real-data-guard.js");   // refuse to run outside a clean checkout
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const X = require("./fixtures/x-export.js");
const { startServer } = require("./_spawn-server.js");

// /api/identity checked the busy flag before reading its body. A save whose
// body was still arriving could lose a race to a merge: the merge started,
// then the identity save ran mid-merge and the merge's older config copy
// overwrote it. The check now runs again once the body is in.
describe("an identity save whose body finishes during a merge waits (409)", () => {
  let S, tmp;
  before(async () => {
    S = await startServer({ GCA_TEST_COPY_DELAY_MS: "300" });
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gca-race-export-"));
  });
  after(() => { S.stop(); fs.rmSync(tmp, { recursive: true, force: true }); });

  test("headers before the merge, body after it started → 409, config untouched by the save", async () => {
    const f = X.writeExport(tmp);
    const body = JSON.stringify({ names: { 111: "Raced" }, pfps: {}, gc: {}, ignoredUsers: [], ignoredGroups: [] });
    // 1. start the identity request: headers and half the body, nothing else yet
    let resolveIdentity;
    const identityDone = new Promise((r) => { resolveIdentity = r; });
    const req = http.request({
      host: "127.0.0.1", port: S.port, method: "POST", path: "/api/identity",
      headers: { Host: "127.0.0.1:" + S.port, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolveIdentity({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", () => {});
    const half = Math.floor(body.length / 2);
    req.write(body.slice(0, half));
    await new Promise((r) => setTimeout(r, 200));   // the server has routed it and is reading the body
    // 2. start a merge and wait until it is copying media (the busy window)
    const pending = S.post("/api/source", { groupJs: f.group, headersJs: f.headers, mediaDir: f.media });
    let running = false;
    for (let i = 0; i < 100 && !running; i++) {
      const p = await (await S.get("/api/progress")).json();
      if (p.running) running = true; else await new Promise((r) => setTimeout(r, 30));
    }
    assert.ok(running, "the merge is running");
    // 3. finish the identity body mid-merge
    req.end(body.slice(half));
    const id = await identityDone;
    assert.equal(id.status, 409, id.body);
    const src = await pending;
    assert.equal(src.status, 200, JSON.stringify(await src.json()));
    const cfg = JSON.parse(fs.readFileSync(path.join(S.personal, "config.json"), "utf8"));
    assert.notEqual((cfg.names || {})["111"], "Raced", "the refused save wrote nothing");
  });
});
