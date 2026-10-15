/*
 * the double-click launchers explain the three ways starting can fail
 * (no Node, run from inside the ZIP, Node too old) instead of showing raw
 * "'node' is not recognized" / "Cannot find module" output. Runs the launcher
 * for this platform (start-setup.cmd on Windows, start-setup.command elsewhere)
 * with a doctored PATH and stand-in `node` scripts; it never starts a server.
 */
require("./_real-data-guard.js");   // refuse to run outside a clean checkout
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const WIN = process.platform === "win32";
const LAUNCHER = WIN ? "start-setup.cmd" : "start-setup.command";
const tmpDirs = [];
const scratch = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); tmpDirs.push(d); return d; };
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

// The system folders the launcher itself needs (where / cmd, or sh + coreutils),
// without any folder that has node in it.
function basePath() {
  if (WIN) return path.join(process.env.SystemRoot || "C:\\Windows", "System32");
  return ["/usr/bin", "/bin"].filter((d) => fs.existsSync(d) && !fs.existsSync(path.join(d, "node"))).join(":");
}
function run(launcherPath, extraPathDir) {
  const PATH = (extraPathDir ? extraPathDir + path.delimiter : "") + basePath();
  const env = Object.assign({}, process.env, { PATH, Path: PATH });
  const r = WIN
    ? spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/c", launcherPath], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 20000, windowsHide: true })
    : spawnSync("/bin/sh", [launcherPath], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 20000 });
  return { status: r.status, out: (r.stdout || "") + (r.stderr || "") };
}
// A stand-in `node` in its own folder: `body` is what it does.
function fakeNode(prefix, winBody, shBody) {
  const d = scratch(prefix);
  if (WIN) fs.writeFileSync(path.join(d, "node.cmd"), "@echo off\r\n" + winBody.join("\r\n") + "\r\n");
  else { fs.writeFileSync(path.join(d, "node"), "#!/bin/sh\n" + shBody.join("\n") + "\n"); fs.chmodSync(path.join(d, "node"), 0o755); }
  return d;
}

test("with no Node.js installed the launcher points to nodejs.org", () => {
  const r = run(path.join(ROOT, LAUNCHER));
  assert.notEqual(r.status, 0);
  assert.match(r.out, /Node\.js/);
  assert.match(r.out, /https:\/\/nodejs\.org/);
  assert.doesNotMatch(r.out, /is not recognized|command not found|Cannot find module/);
});

test("started from inside the ZIP (launcher alone, no scripts folder) it says to extract first", () => {
  const lone = scratch("gca-zip-view-");
  fs.copyFileSync(path.join(ROOT, LAUNCHER), path.join(lone, LAUNCHER));
  const r = run(path.join(lone, LAUNCHER), path.dirname(process.execPath));
  assert.notEqual(r.status, 0);
  assert.match(r.out, /extract/i);
  assert.doesNotMatch(r.out, /Cannot find module/);
});

test("with a Node.js older than 18 it asks for a newer one", () => {
  const old = fakeNode("gca-fake-node-old-", ["echo v12.22.0", "exit /b 1"], ["echo v12.22.0", "exit 1"]);
  const r = run(path.join(ROOT, LAUNCHER), old);
  assert.notEqual(r.status, 0);
  assert.match(r.out, /18 or newer/);
  assert.match(r.out, /https:\/\/nodejs\.org/);
});

test("with a usable Node.js it starts the server with --open (a stand-in node records the call)", () => {
  const ok = fakeNode("gca-fake-node-ok-", ["echo FAKE-NODE %*", "exit /b 0"], ["echo FAKE-NODE \"$@\"", "exit 0"]);
  const r = run(path.join(ROOT, LAUNCHER), ok);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /FAKE-NODE .*server\.js.* --open/);
});

test("package.json declares the Node versions it supports", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.equal(pkg.engines && pkg.engines.node, ">=18");
});
