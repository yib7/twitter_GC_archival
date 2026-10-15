require("./_real-data-guard.js");   // refuse to run outside a clean checkout — required first, consistently
const { test, after } = require("node:test");
const assert = require("node:assert");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { waitForBootLine } = require("./wait-for-boot-line.js");   // dedup — see that file

// the host-guard/prefill test harness used to pick a RANDOM port from a
// range that includes ports a real user (or Playwright's own webServer) might
// already be listening on — 8765 (the default archive port) and 9000 (the
// port server.js itself tells users to try). Polling /api/ping and treating
// serverProc.exitCode !== null as "the port was free" has a race: if someone
// else already owns the port, the poll succeeds in a few ms, before our own
// child (which lost the EADDRINUSE race) has actually exited — so the guard
// passes and the test proceeds to fire real, destructive requests (including
// POST /api/reset) at a FOREIGN server. Reproduced in
// scratchpad/race.js: "exitCode right after waitForServer resolves: null",
// then the impostor received the POST /api/reset.
//
// Fix: never guess a port. Spawn with GCA_PORT=0 (the OS hands back a truly
// free ephemeral port — no collision is possible) and have server.js report
// the port it actually bound on stdout; parse that line instead of guessing.
// This test locks in that contract: it fails today because (a) the port-0
// startup line still prints the literal "0" the env var was set to, and (b)
// every request the test would then send gets rejected 403 by the Host guard,
// which compares the incoming Host header's port against that same wrong "0".
let tmpDir;
let serverProc;

after(() => {
  if (serverProc) serverProc.kill();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("GCA_PORT=0 makes the server bind an OS-assigned free port, print it, and accept requests on it", async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gca-port0-"));
  serverProc = spawn(process.execPath, [path.join(__dirname, "..", "scripts", "server.js")], {
    cwd: path.join(__dirname, ".."),
    env: Object.assign({}, process.env, { GCA_PERSONAL: tmpDir, GCA_PORT: "0" }),
    stdio: "pipe",
  });
  const port = await waitForBootLine(serverProc, 10000);
  assert.notEqual(port, 0, "the printed port must be the REAL bound port, not the literal 0 GCA_PORT was set to");

  const res = await fetch("http://127.0.0.1:" + port + "/api/ping");
  assert.equal(res.status, 200, "the server's own Host-allowlist must accept requests on the port it actually bound, not port 0");
  const body = await res.json();
  assert.equal(body.ok, true);
});

// An invalid GCA_PORT is a setting the user typed (.env.example invites it):
// it gets one plain line and exit code 1, never a Node stack trace.
for (const bad of ["abc", "70000", "-1", "80.5"]) {
  test("GCA_PORT=" + bad + " stops the server with one plain line and no stack trace", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gca-badport-"));
    try {
      const r = spawnSync(process.execPath, [path.join(__dirname, "..", "scripts", "server.js")], {
        cwd: path.join(__dirname, ".."), encoding: "utf8", timeout: 10000,
        env: Object.assign({}, process.env, { GCA_PERSONAL: dir, GCA_PORT: bad, GCA_NO_ROOT_FALLBACK: "1" }),
      });
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.match(r.stderr, /GCA_PORT/);
      assert.ok(r.stderr.includes(JSON.stringify(bad)), "the line quotes the value: " + r.stderr);
      assert.doesNotMatch(r.stderr, /^\s+at /m, "no stack frames");
      assert.doesNotMatch(r.stdout, /running at/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
}
