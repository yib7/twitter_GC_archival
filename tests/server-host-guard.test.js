require("./_real-data-guard.js");   // QA-2: refuse to run outside a clean checkout
const { test, before, after, describe } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
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
let PORT;
let tmpDir;
let serverProc;

function waitForBootLine(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error("server did not print its bound port within " + timeoutMs + "ms; stdout so far:\n" + out)), timeoutMs);
    const onData = (chunk) => {
      out += chunk.toString("utf8");
      const m = /Group Chat Archive running at\s+http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
      if (m) { clearTimeout(timer); child.stdout.off("data", onData); resolve(Number(m[1])); }
    };
    child.stdout.on("data", onData);
    child.on("exit", (code) => { clearTimeout(timer); reject(new Error("server exited early with code " + code + "; stdout:\n" + out)); });
  });
}

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

  test("a __proto__ key in POST /api/identity's gc/names is dropped, never pollutes Object.prototype or lands in config.json", async () => {
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
        // POST body (parsed server-side the same way) would contain.
        gc: JSON.parse('{"__proto__": {"name": "pwned", "photo": ""}}'),
        names: JSON.parse('{"__proto__": {"polluted": true}, "1111": "Alice"}'),
        pfps: {}, ignoredUsers: [], ignoredGroups: [],
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);

    // The classic tell for a successful pollution: a plain object would now
    // report a "polluted"/"name" property it never had via its OWN chain.
    assert.equal({}.polluted, undefined, "Object.prototype must not be polluted");
    assert.equal({}.name, undefined, "Object.prototype must not be polluted");

    const cfgText = fs.readFileSync(path.join(qTmp, "config.json"), "utf8");
    assert.ok(!cfgText.includes("__proto__"), "config.json must never contain a literal __proto__ entry");
    const cfg = JSON.parse(cfgText);
    assert.equal(Object.prototype.hasOwnProperty.call(cfg, "__proto__"), false);
    assert.equal(cfg.names["1111"], "Alice", "a legitimate sibling key in the same payload must still save");
  });
});
