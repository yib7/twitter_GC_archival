/*
 * Cross-site reads and writes against the local server.
 *
 * data.js is a script (`window.CHAT_DATA = {…}`), so any web page the user
 * visits while the server runs could include
 *   <script src="http://127.0.0.1:<port>/personal_data/data.js">
 * and read every message. Two defences close that:
 *   - every served file carries `Cross-Origin-Resource-Policy: same-origin`,
 *     which stops browsers handing a cross-origin page the response;
 *   - the private files are refused (403) when the browser says, through
 *     Sec-Fetch-Site, that another site asked for them.
 * The state-changing routes get the same Sec-Fetch-Site check.
 *
 * Every server here is the shared harness's: GCA_PORT=0, an empty mkdtemp
 * GCA_PERSONAL holding only fake files written below, the root fallbacks off
 * and no native pickers.
 */
require("./_real-data-guard.js");   // refuse to run outside a clean checkout
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { startServer } = require("./_sp6-server.js");

const FAKE_DATA = 'window.CHAT_DATA = {"__fake":true,"conversations":[]};\n';
const FAKE_LOCAL = 'window.LOCAL_NAMES = {"1":"Fake"}; window.LOCAL_ME = "1";\n';
const FAKE_VIDEO = Buffer.from("0123456789abcdefghij");   // not a real mp4; only bytes are served

// Raw request so the Sec-Fetch-* headers are exactly what a browser would send
// (Node's fetch adds its own Sec-Fetch-Mode and may add others).
function raw(port, p, { method, headers, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1", port, method: method || "GET", path: p,
      headers: Object.assign({ Host: "127.0.0.1:" + port }, headers || {}),
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(body);
  });
}
const crossSite = (extra) => Object.assign({ "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "no-cors", "Sec-Fetch-Dest": "script", Referer: "https://evil.example/" }, extra || {});

describe("private files and media are only for this origin", () => {
  let S;
  before(async () => {
    S = await startServer();
    fs.writeFileSync(path.join(S.personal, "data.js"), FAKE_DATA);
    fs.writeFileSync(path.join(S.personal, "local.js"), FAKE_LOCAL);
    fs.mkdirSync(path.join(S.personal, "media"));
    fs.writeFileSync(path.join(S.personal, "media", "9101-Clip.mp4"), FAKE_VIDEO);
    fs.mkdirSync(path.join(S.personal, "pfps"));
    fs.writeFileSync(path.join(S.personal, "pfps", "ann_pfp.png"), "png bytes");
  });
  after(() => S.stop());

  test("data.js carries Cross-Origin-Resource-Policy: same-origin and still loads same-origin", async () => {
    const r = await raw(S.port, "/personal_data/data.js", { headers: { "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Dest": "script" } });
    assert.equal(r.status, 200);
    assert.equal(r.headers["cross-origin-resource-policy"], "same-origin");
    assert.equal(r.body, FAKE_DATA);
  });

  test("a no-Sec-Fetch request (curl, an older browser) still gets data.js, with CORP", async () => {
    const r = await raw(S.port, "/personal_data/data.js");
    assert.equal(r.status, 200);
    assert.equal(r.headers["cross-origin-resource-policy"], "same-origin");
  });

  test("a typed-in address (Sec-Fetch-Site: none) still opens data.js", async () => {
    const r = await raw(S.port, "/personal_data/data.js", { headers: { "Sec-Fetch-Site": "none", "Sec-Fetch-Dest": "document" } });
    assert.equal(r.status, 200);
  });

  for (const p of ["/personal_data/data.js", "/personal_data/local.js", "/data.js", "/names.local.js", "/personal_data/media/9101-Clip.mp4", "/personal_data/pfps/ann_pfp.png"]) {
    test("a cross-site request for " + p + " is refused with 403 and no archive bytes", async () => {
      const r = await raw(S.port, p, { headers: crossSite() });
      assert.equal(r.status, 403);
      assert.ok(!r.body.includes("__fake") && !r.body.includes("Fake") && !r.body.includes("0123"), "no private bytes in the refusal: " + r.body);
      assert.equal(r.headers["cross-origin-resource-policy"], "same-origin");
    });
  }

  test("a same-site (another localhost port) request for data.js is refused too", async () => {
    const r = await raw(S.port, "/personal_data/data.js", { headers: crossSite({ "Sec-Fetch-Site": "same-site", Referer: "http://localhost:3000/" }) });
    assert.equal(r.status, 403);
  });

  test("media carries CORP on the full reply and on a Range (206) reply, and plays same-origin", async () => {
    const full = await raw(S.port, "/personal_data/media/9101-Clip.mp4", { headers: { "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Dest": "video" } });
    assert.equal(full.status, 200);
    assert.equal(full.headers["cross-origin-resource-policy"], "same-origin");
    assert.equal(full.body, FAKE_VIDEO.toString("utf8"));
    const part = await raw(S.port, "/personal_data/media/9101-Clip.mp4", { headers: { "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Dest": "video", Range: "bytes=10-" } });
    assert.equal(part.status, 206);
    assert.equal(part.headers["cross-origin-resource-policy"], "same-origin");
    assert.equal(part.headers["content-range"], "bytes 10-19/20");
    assert.equal(part.body, "abcdefghij");
  });

  test("the HTML pages, app assets, missing-override replies and 404s carry CORP too", async () => {
    for (const p of ["/", "/index.html", "/setup.html", "/src/app.js", "/sample/photo-1.svg", "/nope.txt"]) {
      const r = await raw(S.port, p);
      assert.equal(r.headers["cross-origin-resource-policy"], "same-origin", p);
    }
  });

  test("public app files are not refused cross-site (only the private ones are)", async () => {
    const r = await raw(S.port, "/src/app.js", { headers: crossSite() });
    assert.equal(r.status, 200);
    assert.equal(r.headers["cross-origin-resource-policy"], "same-origin");
  });
});

describe("state-changing routes refuse a cross-site Sec-Fetch-Site", () => {
  let S;
  before(async () => {
    S = await startServer();
    fs.writeFileSync(path.join(S.personal, "data.js"), FAKE_DATA);
    fs.writeFileSync(path.join(S.personal, "config.json"), "{}");
  });
  after(() => S.stop());

  test("a no-Origin POST /api/reset with Sec-Fetch-Site: cross-site gets 403 and the folder is untouched", async () => {
    const before_ = fs.readdirSync(S.personal).sort();
    const r = await raw(S.port, "/api/reset", { method: "POST", headers: { "Sec-Fetch-Site": "cross-site", "Content-Length": "0" } });
    assert.equal(r.status, 403);
    assert.deepEqual(fs.readdirSync(S.personal).sort(), before_);
    assert.equal(fs.readFileSync(path.join(S.personal, "data.js"), "utf8"), FAKE_DATA);
  });

  test("same-site POSTs to /api/identity and /api/source are refused too", async () => {
    for (const p of ["/api/identity", "/api/source", "/api/preflight", "/api/removal-preview"]) {
      const r = await raw(S.port, p, { method: "POST", headers: { "Sec-Fetch-Site": "same-site", "Content-Type": "application/json" }, body: "{}" });
      assert.equal(r.status, 403, p);
    }
    assert.equal(fs.readFileSync(path.join(S.personal, "config.json"), "utf8"), "{}");
  });

  test("a same-origin POST /api/reset still works", async () => {
    const r = await raw(S.port, "/api/reset", { method: "POST", headers: { "Sec-Fetch-Site": "same-origin", Origin: "http://127.0.0.1:" + S.port, "Content-Length": "0" } });
    assert.equal(r.status, 200);
    assert.ok(!fs.existsSync(path.join(S.personal, "data.js")));
  });
});
