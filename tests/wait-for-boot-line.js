require("./_real-data-guard.js");   // refuse to run outside a clean checkout

// Shared by every test file that spawns its own scripts/server.js with
// GCA_PORT=0: the OS hands back a genuinely free ephemeral port, so
// server.js prints the port it actually bound on stdout instead of the
// caller guessing/polling one — parse that line rather than assuming.
//
// Review fix (dedup): this used to be copy-pasted verbatim into
// server-host-guard.test.js, server-port-zero.test.js, and
// setup-prefill.spec.js — three copies to keep in sync by hand. One shared
// module now backs all three.
const BOOT_LINE_RE = /Group Chat Archive running at\s+http:\/\/127\.0\.0\.1:(\d+)/;

function waitForBootLine(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error("server did not print its bound port within " + timeoutMs + "ms; stdout so far:\n" + out)), timeoutMs);
    const onData = (chunk) => {
      out += chunk.toString("utf8");
      const m = BOOT_LINE_RE.exec(out);
      if (m) { clearTimeout(timer); child.stdout.off("data", onData); resolve(Number(m[1])); }
    };
    child.stdout.on("data", onData);
    child.on("exit", (code) => { clearTimeout(timer); reject(new Error("server exited early with code " + code + "; stdout:\n" + out)); });
  });
}

module.exports = { waitForBootLine };
