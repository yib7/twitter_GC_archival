require("./_real-data-guard.js");   // refuse to run outside a clean checkout
const { test, after } = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { waitForBootLine } = require("./wait-for-boot-line.js");

// Checkpoint test for the e2e real-data isolation: GCA_NO_ROOT_FALLBACK is the
// switch playwright.config.js sets on the shared webServer so a spawned test
// server can never read/serve a leftover ROOT/data.js or ROOT/names.local.js
// (readBuiltData's own fallback, and the two static routes — see server.js's
// comments around NO_ROOT_FALLBACK). Nothing before this test actually spun
// up a server against a root that HAS those two files and proved the switch
// makes a difference — every other spawn-based test runs from this real
// checkout, which the real-data guard requires to be clean, so those fake
// files never legitimately exist here to test against.
//
// server.js computes ROOT as path.resolve(__dirname, "..") — based on where
// the running server.js file physically sits, not process.cwd(). So the only
// way to give it a synthetic ROOT is to copy the script (and its two local
// requires) into a throwaway directory and spawn THAT copy — never touching
// the real checkout's ROOT.
//
// HARD RULE: everything here lives under a fresh os.tmpdir() directory,
// deleted in `after`. The real project's personal_data*/, exports/, and root
// data.js/names.local.js are never read, copied from, or written to — the
// "fake root" data.js/names.local.js below are synthetic strings this test
// writes itself, unrelated to any real export.

let synthRoot;      // copy of scripts/ (+ build-core's one dependency) plus fake root data.js/names.local.js
let personalWith;   // throwaway GCA_PERSONAL for the switched-on run
let personalWithout; // throwaway GCA_PERSONAL for the control run
let procWith;
let procWithout;

const FAKE_DATA_JS = 'window.CHAT_DATA = {"conversations":[{"id":"fake-root","title":"FAKE ROOT DATA — must never be served with GCA_NO_ROOT_FALLBACK on","count":1}]};\n';
const FAKE_NAMES_LOCAL_JS = "window.LOCAL_NAMES = { \"fake-root\": \"should never be served either\" };\n";

// Windows holds an open handle on synthRoot/scripts/server.js (the spawned
// child's own loaded module file) until the child process has actually
// exited, not merely been sent a kill signal — rmSync-ing synthRoot right
// after kill() intermittently throws EPERM here. Wait for the real exit first.
function waitForExit(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once("exit", () => resolve());
  });
}

after(async () => {
  if (procWith) procWith.kill();
  if (procWithout) procWithout.kill();
  await Promise.all([waitForExit(procWith), waitForExit(procWithout)]);
  for (const dir of [synthRoot, personalWith, personalWithout]) {
    if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("GCA_NO_ROOT_FALLBACK isolates a spawned server from a synthetic ROOT's fake data.js/names.local.js; without it, the fake root data leaks through", async () => {
  synthRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gca-root-fallback-synth-"));
  const scriptsDir = path.join(synthRoot, "scripts");
  const srcDir = path.join(synthRoot, "src");
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.mkdirSync(srcDir, { recursive: true });

  const repoRoot = path.join(__dirname, "..");
  // server.js's ROOT = path.resolve(__dirname, ".."), so it resolves to
  // synthRoot only if server.js itself physically lives at synthRoot/scripts/.
  // server-core.js, build-core.js and fs-io.js are its same-directory
  // requires; build-core.js in turn requires ../src/shared-core.js.
  for (const f of ["server.js", "server-core.js", "build-core.js", "fs-io.js"]) {
    fs.copyFileSync(path.join(repoRoot, "scripts", f), path.join(scriptsDir, f));
  }
  fs.copyFileSync(path.join(repoRoot, "src", "shared-core.js"), path.join(srcDir, "shared-core.js"));

  // The "fake root export" this test is proving stays unreachable when the
  // switch is on. Synthetic content, invented for this test — not a copy of
  // any real export.
  fs.writeFileSync(path.join(synthRoot, "data.js"), FAKE_DATA_JS);
  fs.writeFileSync(path.join(synthRoot, "names.local.js"), FAKE_NAMES_LOCAL_JS);

  personalWith = fs.mkdtempSync(path.join(os.tmpdir(), "gca-root-fallback-personal-with-"));
  personalWithout = fs.mkdtempSync(path.join(os.tmpdir(), "gca-root-fallback-personal-without-"));

  const spawnCopy = (env) => spawn(process.execPath, [path.join(scriptsDir, "server.js")], {
    cwd: synthRoot,
    env: Object.assign({}, process.env, env),
    stdio: "pipe",
  });

  procWith = spawnCopy({ GCA_PORT: "0", GCA_PERSONAL: personalWith, GCA_NO_ROOT_FALLBACK: "1" });
  procWithout = spawnCopy({ GCA_PORT: "0", GCA_PERSONAL: personalWithout, GCA_NO_ROOT_FALLBACK: "" });

  const [portWith, portWithout] = await Promise.all([
    waitForBootLine(procWith, 10000),
    waitForBootLine(procWithout, 10000),
  ]);

  // --- switched ON: the fake root files must be completely invisible ---
  const dataWith = await fetch("http://127.0.0.1:" + portWith + "/data.js");
  assert.equal(dataWith.status, 200);
  assert.equal(await dataWith.text(), "", "GCA_NO_ROOT_FALLBACK must serve /data.js as empty, ignoring the fake root file");

  const namesWith = await fetch("http://127.0.0.1:" + portWith + "/names.local.js");
  assert.equal(namesWith.status, 200);
  assert.equal(await namesWith.text(), "", "GCA_NO_ROOT_FALLBACK must serve /names.local.js as empty, ignoring the fake root file");

  const statusWith = await (await fetch("http://127.0.0.1:" + portWith + "/api/status")).json();
  assert.equal(statusWith.built, false, "readBuiltData must not fall back to the synthetic ROOT/data.js when the switch is on");

  // --- control, switch OFF: the same fake root files must actually be served ---
  const dataWithout = await fetch("http://127.0.0.1:" + portWithout + "/data.js");
  assert.equal(dataWithout.status, 200);
  assert.equal(await dataWithout.text(), FAKE_DATA_JS, "control: without the switch, the fake root data.js must be served as-is");

  const namesWithout = await fetch("http://127.0.0.1:" + portWithout + "/names.local.js");
  assert.equal(namesWithout.status, 200);
  assert.equal(await namesWithout.text(), FAKE_NAMES_LOCAL_JS, "control: without the switch, the fake root names.local.js must be served as-is");

  const statusWithout = await (await fetch("http://127.0.0.1:" + portWithout + "/api/status")).json();
  assert.equal(statusWithout.built, true, "control: readBuiltData must fall back to and successfully parse the synthetic ROOT/data.js when the switch is off");
});
