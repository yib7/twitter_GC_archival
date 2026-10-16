/*
 * The setup server's request boundary: what it refuses before any route runs,
 * what shape a request body must have, and the headers every reply carries.
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
const { startServer } = require("./_spawn-server.js");

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
const listing = (dir) => fs.readdirSync(dir).sort();

// The read-only GETs were reachable from any web page as a no-cors request:
// the browser withholds the reply, but the server still ran the request, and
// /api/status and /api/parts stream the whole archive to answer it. A page
// on another site could keep the server busy (and keep a launcher-started
// server from ever shutting down via /api/ping).
describe("every /api/ route refuses a request the browser says another site sent", () => {
  let S;
  before(async () => {
    S = await startServer();
    fs.writeFileSync(path.join(S.personal, "data.js"), 'window.CHAT_DATA = {"conversations":[]};\n');
  });
  after(() => S.stop());

  for (const p of ["/api/status", "/api/parts", "/api/parts?group=1", "/api/progress", "/api/ping?c=abc"]) {
    for (const site of ["cross-site", "same-site"]) {
      test("GET " + p + " with Sec-Fetch-Site: " + site + " → 403", async () => {
        const r = await raw(S.port, p, { headers: { "Sec-Fetch-Site": site, "Sec-Fetch-Mode": "no-cors" } });
        assert.equal(r.status, 403, r.body);
      });
    }
  }

  test("the same GETs from this origin, a typed-in address, or curl still answer", async () => {
    for (const site of ["same-origin", "none", null]) {
      const headers = site ? { "Sec-Fetch-Site": site } : {};
      assert.equal((await raw(S.port, "/api/status", { headers })).status, 200, String(site));
      assert.equal((await raw(S.port, "/api/progress", { headers })).status, 200, String(site));
      assert.equal((await raw(S.port, "/api/ping?c=abc", { headers })).status, 200, String(site));
      // /api/parts ran (no group asked for), rather than being refused
      const parts = await raw(S.port, "/api/parts", { headers });
      assert.notEqual(parts.status, 403, String(site));
      assert.doesNotMatch(parts.body, /forbidden/, String(site));
    }
  });
});

// A browser without Fetch Metadata (Safari before 16.4) sends no
// Sec-Fetch-Site, but an <img> or fetch from another site still carries
// that site's Referer, and a sandboxed or file:// page sends Origin: null.
// Those are refused too; this server's own pages send their own address
// (Referrer-Policy: same-origin keeps it on every same-origin request), and
// curl or a typed-in address sends neither.
describe("every /api/ route refuses a foreign Origin or Referer when Sec-Fetch-Site is missing", () => {
  let S;
  before(async () => {
    S = await startServer();
    fs.writeFileSync(path.join(S.personal, "data.js"), 'window.CHAT_DATA = {"conversations":[]};\n');
  });
  after(() => S.stop());

  const foreign = {
    "a Referer from another site": { Referer: "https://evil.example/page" },
    "Origin: null": { Origin: "null" },
    "an Origin from another site": { Origin: "https://evil.example" },
    "a Referer from another localhost port": () => ({ Referer: "http://127.0.0.1:" + (S.port + 1) + "/" }),
    "an https Referer on this port": () => ({ Referer: "https://127.0.0.1:" + S.port + "/" }),
  };
  for (const p of ["/api/status", "/api/parts", "/api/parts?group=1", "/api/progress", "/api/ping?c=abc"]) {
    for (const [what, h] of Object.entries(foreign)) {
      test("GET " + p + " with " + what + " → 403", async () => {
        const r = await raw(S.port, p, { headers: typeof h === "function" ? h() : h });
        assert.equal(r.status, 403, r.body);
        assert.match(r.body, /forbidden origin/);
      });
    }
  }

  test("this server's own pages, on 127.0.0.1 or localhost, and no header at all still answer", async () => {
    const own = [
      {},
      { Referer: "http://127.0.0.1:" + S.port + "/setup.html" },
      { Referer: "http://localhost:" + S.port + "/index.html#search" },
      { Origin: "http://127.0.0.1:" + S.port },
      { Origin: "http://localhost:" + S.port, Referer: "http://localhost:" + S.port + "/" },
    ];
    for (const headers of own) {
      for (const p of ["/api/status", "/api/progress", "/api/ping?c=abc"]) {
        assert.equal((await raw(S.port, p, { headers })).status, 200, p + " " + JSON.stringify(headers));
      }
    }
  });

  test("the goodbye beacon from this origin still answers, from another site it doesn't", async () => {
    const own = await raw(S.port, "/api/bye?c=abc", { method: "POST", headers: { Origin: "http://127.0.0.1:" + S.port } });
    assert.equal(own.status, 204);
    const evil = await raw(S.port, "/api/bye?c=abc", { method: "POST", headers: { Referer: "https://evil.example/" } });
    assert.equal(evil.status, 403);
  });
});

// A body that parses but isn't a JSON object used to reach the route as-is:
// `null` crashed into a 500 carrying a TypeError's text, and `[]` / `"x"` / 42
// ran a whole identity save (config.json and local.js rewritten).
describe("a request body must be a JSON object", () => {
  let S;
  before(async () => {
    S = await startServer();
    fs.writeFileSync(path.join(S.personal, "config.json"), '{"names":{"1":"Kept"}}\n');
  });
  after(() => S.stop());

  for (const p of ["/api/identity", "/api/source", "/api/preflight", "/api/removal-preview"]) {
    for (const body of ["null", "[]", '"x"', "42", "true"]) {
      test("POST " + p + " with body " + body + " → 400, nothing written", async () => {
        const before_ = listing(S.personal);
        const r = await raw(S.port, p, { method: "POST", headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" }, body });
        assert.equal(r.status, 400, r.body);
        assert.match(JSON.parse(r.body).error, /JSON object/);
        assert.doesNotMatch(r.body, /Cannot read|TypeError|properties of/);
        assert.deepEqual(listing(S.personal), before_);
        assert.equal(fs.readFileSync(path.join(S.personal, "config.json"), "utf8"), '{"names":{"1":"Kept"}}\n');
      });
    }
  }

  // A field that is an object (one whose toString isn't callable makes
  // String() throw) reached String() in these routes: a 500 carrying the
  // TypeError's text. Each is a plain 400 now, before any work runs.
  const shapes = [
    ["/api/removal-preview", { ignoredUsers: [{ toString: 1 }] }, /removed people and group chats/],
    ["/api/removal-preview", { ignoredGroups: [{ toString: 1 }] }, /removed people and group chats/],
    ["/api/removal-preview", { ignoredGroups: "100" }, /removed people and group chats/],
    ["/api/source", { archiveRoot: { toString: 1 } }, /path/i],
    ["/api/source", { groupJs: { toString: 1 }, headersJs: "h.js", mediaDir: "m" }, /path/i],
    ["/api/preflight", { groupJs: { toString: 1 } }, /path/i],
    ["/api/preflight", { archiveRoot: ["C:\\x"] }, /path/i],
    ["/api/preflight", { groupJs: "g.js", headersJs: "h.js", mediaDir: { toString: 1 } }, /path/i],
  ];
  for (const [p, body, msg] of shapes) {
    test("POST " + p + " with " + JSON.stringify(body) + " → 400 in a plain sentence", async () => {
      const before_ = listing(S.personal);
      const r = await S.post(p, body);
      const text = await r.text();
      assert.equal(r.status, 400, text);
      const err = JSON.parse(text).error;
      assert.match(err, msg);
      assert.match(err, /\.$/);
      assert.doesNotMatch(text, /Cannot convert|TypeError|primitive|Something went wrong/);
      assert.deepEqual(listing(S.personal), before_);
    });
  }
  test("the shapes the wizard sends still pass the check", async () => {
    const ok = await S.post("/api/removal-preview", { ignoredUsers: ["1", 2], ignoredGroups: [] });
    assert.equal(ok.status, 200, await ok.text());
    // a path that doesn't exist is the usual "not found", not a shape error
    const r = await S.post("/api/preflight", { archiveRoot: path.join(S.personal, "no-such-folder") });
    assert.notEqual(r.status, 500);
    assert.doesNotMatch((await r.json()).error, /sent as text/);
  });

  test("an empty body still counts as {} (a bodiless POST)", async () => {
    const r = await raw(S.port, "/api/removal-preview", { method: "POST", headers: { "Sec-Fetch-Site": "same-origin", "Content-Length": "0" } });
    assert.equal(r.status, 200, r.body);
  });
});

// The wizard only ever sends text names, a string/null "this is you", photo
// data URLs, and id lists. Anything else is refused before config.json or
// local.js is written, so a bad value can't reach the viewer.
describe("POST /api/identity checks each field's type", () => {
  let S;
  const CFG = '{"names":{"1":"Kept"}}\n';
  before(async () => { S = await startServer(); });
  after(() => S.stop());

  const bad = {
    "names that aren't an object": { names: ["Ann"] },
    "a name that isn't text": { names: { 1: { first: "Ann" } } },
    "a numeric name": { names: { 1: 5 } },
    "pfps that aren't an object": { pfps: "data:image/png;base64,AAAA" },
    "a photo that isn't text": { pfps: { 1: 7 } },
    "a photo that isn't an image": { pfps: { 1: "data:text/html;base64,PHNjcmlwdD4=" } },
    "a group photo that isn't an image": { gc: { 100: { name: "Crew", photo: "data:text/html;base64,PHNjcmlwdD4=" } } },
    "gc that isn't an object": { gc: [1] },
    "a gc entry that isn't an object": { gc: { 100: "Crew" } },
    "a gc name that isn't text": { gc: { 100: { name: { a: 1 } } } },
    "a gc photo outside personal_data/pfps": { gc: { 100: { name: "Crew", photo: "https://tracker.example/x.png" } } },
    "a gc photo path that climbs out": { gc: { 100: { name: "Crew", photo: "personal_data/pfps/../config.json" } } },
    "a gc photo that breaks out of url('')": { gc: { 100: { name: "Crew", photo: "personal_data/pfps/a.png');x:url('y" } } },
    "a me that is an object": { me: { id: 1 } },
    "ignoredUsers that aren't a list": { ignoredUsers: "111" },
    "ignoredUsers holding an object": { ignoredUsers: [{ id: 1 }] },
    "ignoredGroups holding null": { ignoredGroups: [null] },
  };
  for (const [what, body] of Object.entries(bad)) {
    test(what + " → 400, config.json and local.js untouched", async () => {
      fs.writeFileSync(path.join(S.personal, "config.json"), CFG);
      fs.rmSync(path.join(S.personal, "local.js"), { force: true });
      const r = await S.post("/api/identity", body);
      assert.equal(r.status, 400, what);
      assert.ok((await r.json()).error);
      assert.equal(fs.readFileSync(path.join(S.personal, "config.json"), "utf8"), CFG);
      assert.ok(!fs.existsSync(path.join(S.personal, "local.js")));
    });
  }

  test("what the wizard sends is still accepted", async () => {
    fs.writeFileSync(path.join(S.personal, "config.json"), CFG);
    const ok = [
      { me: null, gc: { 100: { photo: null } }, names: { 1: "Ann", 2: "" }, pfps: {}, ignoredUsers: [], ignoredGroups: [] },
      { me: "", gc: { 100: { name: "Crew", photo: null } }, names: {}, pfps: {}, ignoredUsers: ["3", 4], ignoredGroups: ["100"] },
      { me: "1", gc: { 100: { name: "Crew", photo: "" } } },
      { gc: { 100: { name: "Crew", photo: "personal_data/pfps/group_crew_pfp.png" } } },
      {},
    ];
    for (const body of ok) assert.equal((await S.post("/api/identity", body)).status, 200, JSON.stringify(body));
  });
});

// A "__proto__" key in pfps (an own key once JSON.parse has run) skipped the
// photo check, then went through the object's prototype setter: the save
// read the prototype back as a photo and wrote pfps/object_object_pfp.img.
describe("a __proto__ key in the photos is skipped", () => {
  let S;
  before(async () => { S = await startServer(); });
  after(() => S.stop());

  for (const value of ['"data:text/html;base64,PHNjcmlwdD4="', '"data:image/png;base64,iVBORw0KGgo="', '{"buf":1}']) {
    test("pfps: { __proto__: " + value + " } writes no photo", async () => {
      fs.rmSync(path.join(S.personal, "pfps"), { recursive: true, force: true });
      fs.writeFileSync(path.join(S.personal, "config.json"), '{"names":{"1":"Kept"}}\n');
      const body = '{"names":{"1":"Kept"},"pfps":{"__proto__":' + value + "}}";
      const r = await raw(S.port, "/api/identity", { method: "POST", headers: { "Content-Type": "application/json" }, body });
      assert.ok(r.status === 200 || r.status === 400, r.status + " " + r.body);
      const pfps = path.join(S.personal, "pfps");
      assert.deepEqual(fs.existsSync(pfps) ? fs.readdirSync(pfps) : [], []);
      const cfg = JSON.parse(fs.readFileSync(path.join(S.personal, "config.json"), "utf8"));
      assert.deepEqual(Object.keys(cfg.pfps || {}), []);
    });
  }
});

// A config.json edited by hand, or written by an older build, may hold a name
// that isn't text. /api/status handed it to the wizard, the wizard sent it
// back with every save, and the save was refused ("Names must be text."), with
// no way out but Start over. Such a name is ignored: left out of the status
// reply and dropped from config.json at the next save.
describe("a saved name that isn't text doesn't block saving", () => {
  let S;
  before(async () => { S = await startServer(); });
  after(() => S.stop());

  test("status leaves it out, and the wizard's next save goes through", async () => {
    fs.writeFileSync(path.join(S.personal, "config.json"), JSON.stringify({ names: { 1: null, 2: { first: "x" }, 3: "Ann", 4: 7 } }));
    const st = await (await S.get("/api/status")).json();
    assert.deepEqual(st.names, { 3: "Ann" });
    // what setup.js sends: the status names plus what was typed
    const r = await S.post("/api/identity", { me: null, gc: {}, names: Object.assign({}, st.names, { 5: "Bo" }), pfps: {}, ignoredUsers: [], ignoredGroups: [] });
    assert.equal(r.status, 200, await r.text());
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(S.personal, "config.json"), "utf8")).names, { 3: "Ann", 5: "Bo" });
  });

  test("a save that sends no names drops them too", async () => {
    fs.writeFileSync(path.join(S.personal, "config.json"), JSON.stringify({ names: { 1: null, 3: "Ann" } }));
    assert.equal((await S.post("/api/identity", {})).status, 200);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(S.personal, "config.json"), "utf8")).names, { 3: "Ann" });
  });
});

// Every reply, JSON included, says not to sniff it, and the pages never send
// their address to another site when a link in a message is clicked.
describe("headers on every reply", () => {
  let S;
  before(async () => { S = await startServer(); });
  after(() => S.stop());

  test("nosniff and Referrer-Policy: same-origin on pages, assets, JSON, 403 and 404", async () => {
    for (const [p, opts] of [["/", {}], ["/setup.html", {}], ["/src/app.js", {}], ["/api/status", {}], ["/api/progress", {}],
      ["/nope.txt", {}], ["/api/reset", { method: "POST", headers: { Origin: "https://evil.example" } }]]) {
      const r = await raw(S.port, p, opts);
      assert.equal(r.headers["x-content-type-options"], "nosniff", p);
      assert.equal(r.headers["referrer-policy"], "same-origin", p);
    }
  });
});
