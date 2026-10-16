/*
 * the double-click launchers explain the three ways starting can fail
 * (no Node, run from inside the ZIP, a Node outside package.json engines) instead of showing raw
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

// A stand-in `node` whose `node -e <check>` runs the launcher's REAL version
// check under the real Node with process.versions.node spoofed to `version`;
// any other call (the server start) is only recorded, never run.
function spoofedNode(version) {
  const d = scratch("gca-spoof-node-");
  const pre = path.join(d, "spoof.js");
  fs.writeFileSync(pre, "Object.defineProperty(process, 'versions', { value: Object.assign({}, process.versions, { node: " +
    JSON.stringify(version) + " }), configurable: true });\n");
  if (WIN) {
    fs.writeFileSync(path.join(d, "node.cmd"), ["@echo off",
      'if "%~1"=="-e" (',
      '  "' + process.execPath + '" -r "' + pre + '" %*',
      "  exit /b",
      ")",
      "echo FAKE-NODE %*", "exit /b 0", ""].join("\r\n"));
  } else {
    fs.writeFileSync(path.join(d, "node"), ["#!/bin/sh",
      'if [ "$1" = "-e" ]; then exec "' + process.execPath + '" -r "' + pre + '" "$@"; fi',
      'echo FAKE-NODE "$@"', "exit 0", ""].join("\n"));
    fs.chmodSync(path.join(d, "node"), 0o755);
  }
  return d;
}

// What package.json "engines" admits, evaluated directly from its text: each
// "||" part is "^X.Y.Z" (same major, at least X.Y.Z) or ">=N" (major N or later).
function enginesAdmit(range, version) {
  const [maj, min, pat] = version.split(".").map(Number);
  return range.split("||").map((p) => p.trim()).some((p) => {
    let m = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(p);
    if (m) {
      const [a, b, c] = m.slice(1).map(Number);
      return maj === a && (min > b || (min === b && pat >= c));
    }
    m = /^>=(\d+)$/.exec(p);
    if (m) return maj >= Number(m[1]);
    throw new Error("enginesAdmit: unhandled range part " + JSON.stringify(p));
  });
}
const ENGINES = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).engines.node;
// EOL and odd releases included on purpose: 18 and 20 are end-of-life and never
// tested; 23 is outside engines; 22.13.0 is CI's node-floor leg, 24 is .nvmrc.
const VERSIONS = ["12.22.0", "18.20.4", "20.19.0", "21.7.3", "22.12.0", "22.13.0", "22.20.0",
  "23.11.1", "24.0.0", "24.11.0", "25.1.0", "30.0.0"];

for (const v of VERSIONS.filter((x) => !enginesAdmit(ENGINES, x))) {
  test("with Node.js " + v + " (outside engines) the launcher refuses and names the supported versions", () => {
    const r = run(path.join(ROOT, LAUNCHER), spoofedNode(v));
    assert.notEqual(r.status, 0, r.out);
    assert.match(r.out, /22\.13 or newer/);
    assert.match(r.out, /https:\/\/nodejs\.org/);
    assert.doesNotMatch(r.out, /FAKE-NODE/, "the server must not start");
  });
}
for (const v of ["22.13.0", "24.0.0"]) {
  test("with Node.js " + v + " (the versions CI runs) the launcher's real check passes and starts the server", () => {
    const r = run(path.join(ROOT, LAUNCHER), spoofedNode(v));
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /FAKE-NODE .*server\.js.* --open/);
  });
}

// Both launchers carry the same one-line check; evaluate it for every version
// in the table (no shell needed, so the .command check is covered on Windows too).
function launcherCheck(file) {
  const m = /node -e "([^"]+)"/.exec(fs.readFileSync(path.join(ROOT, file), "utf8"));
  assert.ok(m, file + " has a node -e version check");
  return m[1];
}
test("both launchers accept exactly the Node versions package.json engines admits", () => {
  const cmd = launcherCheck("start-setup.cmd");
  assert.equal(launcherCheck("start-setup.command"), cmd, "the two launchers' checks differ");
  // cmd.exe: no %, ^, & or | in the check (call re-parses % and ^; & and | are risky).
  assert.doesNotMatch(cmd, /[%^&|]/);
  for (const v of VERSIONS) {
    let code = null;
    const fakeProcess = { versions: { node: v }, exit: (c) => { code = c; } };
    new Function("process", cmd)(fakeProcess);
    assert.equal(code === 0, enginesAdmit(ENGINES, v), "Node " + v + ": launcher " + (code === 0 ? "accepts" : "refuses") + ", engines " + ENGINES);
  }
});

test("with a usable Node.js it starts the server with --open (a stand-in node records the call)", () => {
  const ok = fakeNode("gca-fake-node-ok-", ["echo FAKE-NODE %*", "exit /b 0"], ["echo FAKE-NODE \"$@\"", "exit 0"]);
  const r = run(path.join(ROOT, LAUNCHER), ok);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /FAKE-NODE .*server\.js.* --open/);
});

// One floor everywhere: engines is what CI runs (22.13.0 in the node-floor leg,
// .nvmrc's 24 in the OS matrix). The launchers mirror it (above), and the
// README's Requirements and the launchers' messages name the same floor.
test("package.json engines is the range CI tests", () => {
  assert.equal(ENGINES, "^22.13.0 || >=24");
  assert.equal(fs.readFileSync(path.join(ROOT, ".nvmrc"), "utf8").trim(), "24");
  assert.match(fs.readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8"), /node-version: "22\.13\.0"/);
});

test("the README's Requirements and the launchers name the same Node floor, and nothing still promises Node 18", () => {
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const at = readme.search(/^## Requirements$/m);
  assert.ok(at >= 0, "README.md has a ## Requirements section");
  const rest = readme.slice(readme.indexOf("\n", at) + 1);
  const req = rest.slice(0, rest.search(/^#{1,2} /m));
  assert.match(req, /Node\.js\]\(https:\/\/nodejs\.org\) 22\.13 or newer/);
  for (const f of ["README.md", "start-setup.cmd", "start-setup.command"]) {
    const text = fs.readFileSync(path.join(ROOT, f), "utf8");
    assert.doesNotMatch(text, /Node(\.js)? 18|18 or newer|>= 18/, f);
    if (f !== "README.md") assert.match(text, /Node\.js 22\.13 or newer/, f);
  }
});

// The docs lead users to the launchers and `npm start`. The runtime messages
// (wizard errors, the "server has stopped" banner, the build script) must do
// the same instead of sending them to the bare `node scripts/server.js` route.
test("no runtime message sends the user to node scripts/server.js", () => {
  for (const f of ["src/setup.js", "src/keepalive.js", "scripts/build.js"]) {
    const text = fs.readFileSync(path.join(ROOT, f), "utf8");
    assert.doesNotMatch(text, /node scripts\/server\.js/, f);
  }
});

test("the .command launcher's header matches how it behaves", () => {
  const head = fs.readFileSync(path.join(ROOT, "start-setup.command"), "utf8").split("\n").slice(0, 10).join("\n");
  // it exits by itself when the browser closes (server.js --open), so no "Ctrl+C to stop"
  assert.doesNotMatch(head, /Ctrl\+C/);
  // it ships executable, so the header doesn't tell everyone to chmod it first
  assert.doesNotMatch(head, /chmod \+x/);
});

test("the README tells a cloner to cd into the project and warns about the first-launch prompt", () => {
  // a Windows checkout has CRLF line endings (.gitattributes text=auto)
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8").replace(/\r\n/g, "\n");
  assert.match(readme, /git clone [^\n]*\ncd twitter_GC_archival\n/);
  assert.match(readme, /Open Anyway/);
});
