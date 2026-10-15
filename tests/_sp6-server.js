/*
 * Shared harness for the SP6 server tests: spawns its OWN scripts/server.js on
 * an OS-assigned port (GCA_PORT=0) with a fresh mkdtemp GCA_PERSONAL and the
 * root fallbacks off, so nothing here can ever read or serve real data.
 * GCA_NO_NATIVE_PICKER=1 makes the Windows file dialogs report "unsupported"
 * instead of opening, so no test can ever block on a real dialog.
 */
require("./_real-data-guard.js");   // QA-2: refuse to run outside a clean checkout
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { waitForBootLine } = require("./wait-for-boot-line.js");

async function startServer(extraEnv) {
  const personal = fs.mkdtempSync(path.join(os.tmpdir(), "gca-sp6-personal-"));
  const proc = spawn(process.execPath, [path.join(__dirname, "..", "scripts", "server.js")], {
    cwd: path.join(__dirname, ".."),
    env: Object.assign({}, process.env, { GCA_PERSONAL: personal, GCA_PORT: "0", GCA_NO_ROOT_FALLBACK: "1", GCA_NO_NATIVE_PICKER: "1" }, extraEnv || {}),
    stdio: "pipe",
  });
  // Everything the server prints, from spawn on (before the boot line), so a
  // "never prints X" assertion also covers the startup output.
  let stdout = "", stderr = "";
  proc.stdout.on("data", (c) => { stdout += c.toString("utf8"); });
  proc.stderr.on("data", (c) => { stderr += c.toString("utf8"); });
  const port = await waitForBootLine(proc, 10000);
  const base = "http://127.0.0.1:" + port;
  return {
    port, base, personal, proc,
    stdout: () => stdout,
    stderr: () => stderr,
    url: (p) => base + p,
    post: (p, body, headers) => fetch(base + p, { method: "POST", headers: Object.assign({ "Content-Type": "application/json" }, headers || {}), body: JSON.stringify(body || {}) }),
    get: (p, headers) => fetch(base + p, { headers: headers || {} }),
    stop: () => { try { proc.kill(); } catch (e) { /* gone */ } fs.rmSync(personal, { recursive: true, force: true }); },
  };
}

function readData(personal) {
  const s = fs.readFileSync(path.join(personal, "data.js"), "utf8");
  return JSON.parse(s.replace(/^window\.CHAT_DATA\s*=\s*/, "").replace(/;\s*$/, ""));
}

module.exports = { startServer, readData };
