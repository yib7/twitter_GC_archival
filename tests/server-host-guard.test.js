require("./_real-data-guard.js");   // QA-2: refuse to run outside a clean checkout
const { test, before, after, describe } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const net = require("node:net");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Integration regression for SP3 (Host/Origin CSRF + DNS-rebind guard): a
// REAL spawned server, hit with a raw HTTP request carrying a forged Host or
// Origin header, must 403 BEFORE any route handler (apiReset in particular)
// ever runs. The isAllowedHost/isAllowedOrigin unit tests in
// server-core.test.js prove the helpers are correct in isolation; this proves
// they're actually wired into server.js's request handler.
//
// A browser's fetch()/XHR can never set a Host header (it's a forbidden
// header name per the Fetch spec) or a spoofed Origin, so this uses Node's
// raw http.request — the only way to send the exact bytes an attacker's own
// tooling (or a misconfigured proxy / DNS-rebind) could produce.
//
// HARD RULE: GCA_PERSONAL points at a throwaway temp dir for this whole file.
// The real project's personal_data/ is never read, written, or referenced.
//
// QA-1: this used to pick a random port from a range that includes 8765 (the
// default archive port) and 9000 (the port server.js itself tells users to
// try), then poll /api/ping and treat serverProc.exitCode !== null as proof
// the port was free — a race: if someone else already owned the port, the
// poll would succeed before our own losing child had actually exited, so the
// guard passed and every request in this file (including a real POST
// /api/reset) went to a FOREIGN server. GCA_PORT=0 removes the race instead of
// narrowing it: the OS hands back a genuinely free ephemeral port, so no two
// runs can ever collide. server.js prints the port it actually bound; parse
// that line rather than guessing one up front. See server-port-zero.test.js
// for the focused regression on the print-and-parse contract itself.
const { waitForBootLine } = require("./wait-for-boot-line.js");   // dedup — see that file

let PORT;
let tmpDir;
let serverProc;

// Raw socket-level request so the Host/Origin headers are exactly what we ask
// for, unlike a browser fetch() which would refuse to send a forged Host at
// all (proving nothing about the server) and always sets its own real Origin.
function rawRequest(path_, { method, host, origin } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { Host: host || ("127.0.0.1:" + PORT), "Content-Length": "0" };
    if (origin) headers.Origin = origin;
    const req = http.request(
      { host: "127.0.0.1", port: PORT, method: method || "GET", path: path_, headers },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gca-hostguard-"));   // empty scratch dir — never real personal_data/
  serverProc = spawn(process.execPath, [path.join(__dirname, "..", "scripts", "server.js")], {
    cwd: path.join(__dirname, ".."),
    env: Object.assign({}, process.env, { GCA_PERSONAL: tmpDir, GCA_PORT: "0" }),
    stdio: "pipe",
  });
  PORT = await waitForBootLine(serverProc, 10000);
});

after(() => {
  if (serverProc) serverProc.kill();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("a foreign Host header on POST /api/reset gets 403 and never touches the scratch personal_data dir", async () => {
  const listBefore = fs.readdirSync(tmpDir);
  const res = await rawRequest("/api/reset", { method: "POST", host: "evil.com:" + PORT });
  assert.equal(res.status, 403);
  assert.match(res.body, /forbidden host/);
  assert.deepEqual(fs.readdirSync(tmpDir), listBefore, "apiReset must never run — scratch dir must be unchanged");
});

// DNS-rebinding: an attacker domain that resolves to 127.0.0.1 still sends its
// OWN name (not "127.0.0.1") in the Host header — this is exactly that shape.
test("a loopback-resolving attacker domain in Host gets 403 on the reset route", async () => {
  const listBefore = fs.readdirSync(tmpDir);
  const res = await rawRequest("/api/reset", { method: "POST", host: "rebind.attacker.com:" + PORT });
  assert.equal(res.status, 403);
  assert.deepEqual(fs.readdirSync(tmpDir), listBefore);
});

// Anti-bypass regression: a malformed bracketed Host ("[::1" with no closing
// bracket) used to normalize to a loopback name and be ALLOWED (verified live:
// returned 200). It must now 403 at the server just like the unit test asserts.
test("a malformed bracketed Host ([::1 with no closing bracket) gets 403 on the reset route", async () => {
  const listBefore = fs.readdirSync(tmpDir);
  const res = await rawRequest("/api/reset", { method: "POST", host: "[::1" });
  assert.equal(res.status, 403);
  assert.match(res.body, /forbidden host/);
  assert.deepEqual(fs.readdirSync(tmpDir), listBefore);
});

test("the exact CSRF scenario — legit Host, foreign Origin, POST /api/reset — gets 403 and never runs", async () => {
  const listBefore = fs.readdirSync(tmpDir);
  const res = await rawRequest("/api/reset", { method: "POST", origin: "http://evil.com" });
  assert.equal(res.status, 403);
  assert.match(res.body, /forbidden origin/);
  assert.deepEqual(fs.readdirSync(tmpDir), listBefore, "a cross-origin CSRF POST must never reach apiReset");
});

// The picker GETs spawn a blocking native dialog — never let a foreign-origin
// request anywhere near nativePick(), which this only confirms by asserting
// the rejection happens (a real automated test must never trigger the actual
// dialog, which would hang waiting for a human).
test("a foreign Origin on GET /api/pick-file gets 403 without ever reaching the native picker", async () => {
  const res = await rawRequest("/api/pick-file", { origin: "http://evil.com" });
  assert.equal(res.status, 403);
  assert.match(res.body, /forbidden origin/);
});

test("a legit loopback Host + no Origin is allowed through (the new guard does not break normal traffic)", async () => {
  const res = await rawRequest("/api/status");
  assert.equal(res.status, 200);
  const parsed = JSON.parse(res.body);
  assert.equal(typeof parsed.built, "boolean");
});

// Runs last in this file (node:test runs same-file tests sequentially in
// declaration order) so no later assertion depends on the scratch dir's
// pre-reset contents. /api/reset is guarded and safe to actually invoke here:
// PERSONAL is the empty scratch tmpDir, so a real reset just re-confirms it's
// empty — it never touches anything outside tmpDir.
test("a legit loopback Host + own-origin Origin is allowed through a guarded route", async () => {
  const res = await rawRequest("/api/reset", { method: "POST", origin: "http://127.0.0.1:" + PORT });
  assert.equal(res.status, 200);
  const parsed = JSON.parse(res.body);
  assert.equal(parsed.ok, true);
});

// QA-13: the most destructive and most security-sensitive server paths (reset
// on populated data, HTTP Range serving, the two size caps, and the
// __proto__ guard) had no integration test — apiReset was only ever exercised
// against an EMPTY temp dir (the tests above), so nothing proved it deletes
// exactly its six named targets and nothing else, and Range/413/prototype
// pollution had no coverage at all. Each spawns its own server on its own
// GCA_PORT=0 temp dir so it can freely populate/mutate without interfering
// with the host-guard tests above.
describe("QA-13: destructive & security-sensitive route coverage", () => {
  let qPort, qTmp, qProc;

  before(async () => {
    qTmp = fs.mkdtempSync(path.join(os.tmpdir(), "gca-qa13-"));
    qProc = spawn(process.execPath, [path.join(__dirname, "..", "scripts", "server.js")], {
      cwd: path.join(__dirname, ".."),
      env: Object.assign({}, process.env, { GCA_PERSONAL: qTmp, GCA_PORT: "0" }),
      stdio: "pipe",
    });
    qPort = await waitForBootLine(qProc, 10000);
  });

  after(() => {
    if (qProc) qProc.kill();
    if (qTmp) fs.rmSync(qTmp, { recursive: true, force: true });
  });

  test("POST /api/reset on a POPULATED scratch dir removes exactly its six named targets and leaves anything else alone", async () => {
    const targets = ["config.json", "data.js", "local.js", "source", "media", "pfps"];
    for (const name of targets) {
      const p = path.join(qTmp, name);
      if (name.endsWith(".json") || name.endsWith(".js")) fs.writeFileSync(p, "seed");
      else { fs.mkdirSync(p); fs.writeFileSync(path.join(p, "seed.txt"), "seed"); }
    }
    // Represents a sibling/unlisted item apiReset must never touch — the same
    // isInsidePersonal()-gated allowlist that keeps a real personal_data.REAL/
    // backup safe also keeps this untracked file safe.
    fs.writeFileSync(path.join(qTmp, "keep-me.txt"), "do not delete");

    const res = await fetch("http://127.0.0.1:" + qPort + "/api/reset", { method: "POST" });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.deepEqual(body.removed.sort(), targets.sort());

    const survivors = fs.readdirSync(qTmp);
    assert.deepEqual(survivors, ["keep-me.txt"], "only the untracked file should survive a reset");
    assert.equal(fs.readFileSync(path.join(qTmp, "keep-me.txt"), "utf8"), "do not delete");
  });

  test("Range requests against a served media file: full 206, suffix 206, and out-of-range 416", async () => {
    const svgPath = path.join(__dirname, "..", "sample_media", "clip-1.svg");
    const full = fs.readFileSync(svgPath);
    const base = "http://127.0.0.1:" + qPort;

    const partial = await fetch(base + "/sample_media/clip-1.svg", { headers: { Range: "bytes=0-9" } });
    assert.equal(partial.status, 206);
    assert.equal(partial.headers.get("content-range"), `bytes 0-9/${full.length}`);
    const partialBody = Buffer.from(await partial.arrayBuffer());
    assert.deepEqual(partialBody, full.subarray(0, 10));

    const suffixLen = 5;
    const suffix = await fetch(base + "/sample_media/clip-1.svg", { headers: { Range: `bytes=-${suffixLen}` } });
    assert.equal(suffix.status, 206);
    assert.equal(suffix.headers.get("content-range"), `bytes ${full.length - suffixLen}-${full.length - 1}/${full.length}`);
    const suffixBody = Buffer.from(await suffix.arrayBuffer());
    assert.deepEqual(suffixBody, full.subarray(full.length - suffixLen));

    const outOfRange = await fetch(base + "/sample_media/clip-1.svg", { headers: { Range: `bytes=${full.length + 100}-` } });
    assert.equal(outOfRange.status, 416);
  });

  test("a JSON body over the 64 MB cap is rejected 413 before it is ever parsed", async () => {
    const oversized = Buffer.alloc(64 * 1024 * 1024 + 1, 0x61);
    const res = await fetch("http://127.0.0.1:" + qPort + "/api/source", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: oversized,
    });
    assert.equal(res.status, 413);
  });

  test("an uploaded pfp image over the 10 MB cap is rejected 413", async () => {
    const oversizedPng = Buffer.alloc(10 * 1024 * 1024 + 1024, 1);
    const dataUrl = "data:image/png;base64," + oversizedPng.toString("base64");
    const res = await fetch("http://127.0.0.1:" + qPort + "/api/identity", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ me: null, gc: {}, names: {}, pfps: { u1: dataUrl }, ignoredUsers: [], ignoredGroups: [] }),
    });
    assert.equal(res.status, 413);
  });

  // Review fix: readBody used to drain an oversized body's remaining bytes
  // FOREVER once it rejected with 413 — fine for a normal client (which
  // finishes sending and the socket naturally reaches 'end'), but a client
  // that never finishes sending (stalled upload, or deliberately, a
  // slowloris-style attacker) kept the connection — and its socket — open
  // indefinitely even though the 413 had long since been flushed. The fix
  // closes the connection once the 413 response's "finish" event fires. This
  // uses a raw net socket (not fetch, which doesn't let us hold the request
  // open past the point the server responds) so it can watch that the SERVER
  // actively ends its side of the connection while this test is still mid-way
  // through sending an oversized body it deliberately never finishes.
  test("a 413 over a still-open connection gets the connection closed by the server instead of draining forever", async () => {
    // Declare a Content-Length far bigger than we ever actually send — this is
    // the slowloris shape: the server must 413 as soon as the CAP (64 MB) is
    // exceeded, without waiting for (or fully draining) the declared length.
    const declaredLen = 200 * 1024 * 1024;
    const sentLen = 65 * 1024 * 1024;   // past the 64 MB cap, but far short of declaredLen — the rest is never sent
    await new Promise((resolve, reject) => {
      const socket = net.connect(qPort, "127.0.0.1", () => {
        socket.write(
          "POST /api/source HTTP/1.1\r\n" +
          "Host: 127.0.0.1:" + qPort + "\r\n" +
          "Content-Type: application/json\r\n" +
          "Content-Length: " + declaredLen + "\r\n" +
          "Connection: keep-alive\r\n\r\n",
        );
        // Send just past the cap, then deliberately stop — the declared
        // Content-Length is never fulfilled, simulating a stalled/slowloris
        // client that keeps the request "open" from the server's point of view.
        socket.write(Buffer.alloc(sentLen, 0x61));
      });
      let sawStatus413 = false;
      let settled = false;
      // Deliberately well under Node's own default server.keepAliveTimeout
      // (5000ms) — that default WILL eventually reap an idle keep-alive
      // connection on its own, so a generous timeout here would pass even
      // without the fix (it did, at ~6s, when this was sabotaged for RED
      // verification). The fix closes the connection as soon as the 413's
      // res "finish" event fires — well under a second — so 2000ms cleanly
      // separates "closed because of the fix" from "closed because Node
      // eventually gave up anyway".
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("server never closed the connection after the 413 — still draining a body declared as " + declaredLen + " bytes"));
      }, 2000);
      socket.on("data", (chunk) => {
        if (chunk.toString("utf8").includes(" 413 ")) sawStatus413 = true;
      });
      socket.on("close", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!sawStatus413) return reject(new Error("connection closed before the 413 response was ever seen"));
        resolve();
      });
      // Actively closing a still-open connection (req.destroy(), the fix under
      // test) tears down BOTH directions at once, which can surface here as an
      // abrupt ECONNRESET/EPIPE — this test is still mid-write of its 65 MB
      // body when that happens — rather than a graceful end. Either shape
      // proves the same thing (the server didn't just sit there draining
      // forever), as long as it happened after the 413 was actually seen.
      socket.on("error", (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (sawStatus413 && (e.code === "ECONNRESET" || e.code === "EPIPE")) return resolve();
        reject(e);
      });
    });
  });

  // QA-13 review fix: the original version of this test asserted
  // `{}.polluted === undefined` in THIS (the test runner's) process, but the
  // code under test runs in `qProc` — a separate spawned child process. A
  // child polluting or not polluting its own Object.prototype has zero effect
  // on this process's Object.prototype, so that assertion passed unconditionally
  // regardless of whether server.js's "__proto__" guards existed at all
  // (confirmed live — see the RED/GREEN evidence in sp-1-report.md). It also
  // built `gc`/`names` via JSON.parse (correct — see the comment below) but
  // never actually exercised the one place apiIdentity's gc-loop turns a
  // photo into a WRITE: `entry.photo` was empty, so pfpFileName/writeFileSync
  // were never reached either way.
  //
  // Fixed to assert something that actually crosses the process boundary: a
  // real PNG data URL on gc.__proto__.photo. Server code that skips
  // "__proto__" leaves pfps/ empty and cfg.gc with no keys; unguarded code
  // resolves gcIn["__proto__"] to the {name:"pwned", photo:...} object (a
  // genuine OWN data property — see below), decodes the photo, and writes
  // pfps/pwned_pfp.png via pfpFileName(name="pwned", ...) — a filesystem
  // side effect visible from this process via the shared qTmp directory.
  const TINY_PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

  test("a __proto__ key in POST /api/identity's gc/names is dropped — never pollutes Object.prototype, never writes a pfp file, never lands in config.json", async () => {
    const pfpsDir = path.join(qTmp, "pfps");
    const pfpsBefore = fs.existsSync(pfpsDir) ? fs.readdirSync(pfpsDir) : [];

    const res = await fetch("http://127.0.0.1:" + qPort + "/api/identity", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        me: null,
        // Built via JSON.parse, not an object literal: `{ __proto__: ... }` as
        // a LITERAL sets the object's prototype (special-cased syntax) and
        // JSON.stringify would then silently drop it entirely, testing
        // nothing. JSON.parse uses ordinary [[DefineOwnProperty]], producing a
        // real OWN "__proto__" data property — exactly what an attacker's raw
        // POST body (parsed server-side the same way) would contain. The
        // unguarded apiIdentity gc-loop would resolve gcIn["__proto__"] to
        // this object, decode `photo`, and write pfps/pwned_pfp.png.
        gc: JSON.parse('{"__proto__": {"name": "pwned", "photo": "' + TINY_PNG_DATA_URL + '"}}'),
        names: JSON.parse('{"__proto__": {"polluted": true}, "1111": "Alice"}'),
        pfps: {}, ignoredUsers: [], ignoredGroups: [],
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);

    // The filesystem side effect: unguarded code writes exactly this file
    // (pfpFileName("pwned", "gc-__proto__", "png", taken) === "pwned_pfp.png").
    // This IS visible cross-process — qTmp is a real directory on disk shared
    // by this test process and qProc, unlike Object.prototype (in-memory,
    // per-process, never shared between them).
    assert.ok(!fs.existsSync(path.join(pfpsDir, "pwned_pfp.png")), "the __proto__ guard must stop pfps/pwned_pfp.png from ever being written");
    assert.deepEqual(fs.existsSync(pfpsDir) ? fs.readdirSync(pfpsDir) : [], pfpsBefore, "pfps/ must be unchanged");

    const cfgText = fs.readFileSync(path.join(qTmp, "config.json"), "utf8");
    assert.ok(!cfgText.includes("__proto__"), "config.json must never contain a literal __proto__ entry");
    const cfg = JSON.parse(cfgText);
    assert.equal(Object.prototype.hasOwnProperty.call(cfg, "__proto__"), false);
    assert.deepEqual(Object.keys(cfg.gc || {}), [], "cfg.gc must gain no entry from the __proto__ key");
    assert.equal(cfg.names["1111"], "Alice", "a legitimate sibling key in the same payload must still save");
  });
});
