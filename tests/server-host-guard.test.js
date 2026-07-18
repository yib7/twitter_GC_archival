const { test, before, after } = require("node:test");
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
const PORT = 8800 + Math.floor(Math.random() * 900);
let tmpDir;
let serverProc;

function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    (function poll() {
      fetch(url).then(() => resolve()).catch((e) => {
        if (Date.now() > deadline) return reject(e);
        setTimeout(poll, 100);
      });
    })();
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
    env: Object.assign({}, process.env, { GCA_PERSONAL: tmpDir, GCA_PORT: String(PORT) }),
    stdio: "pipe",
  });
  await waitForServer("http://127.0.0.1:" + PORT + "/api/ping", 10000);
  if (serverProc.exitCode !== null) {
    throw new Error("test server exited (code " + serverProc.exitCode + ") — port " + PORT + " likely in use");
  }
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
