/*
 * .env.example documents the environment variables a USER may set. It must
 * cover every GCA_* variable the app's scripts read, except the test/harness
 * switches, which are documented in docs/ARCHITECTURE.md's Testing section
 * instead (and must never appear in .env.example).
 */
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

// Switches only the test suite / harness uses.
const TEST_ONLY = [
  "GCA_AUTO_EXIT", "GCA_BIG", "GCA_E2E_PERSONAL_DIR", "GCA_NO_NATIVE_PICKER", "GCA_NO_ROOT_FALLBACK",
  "GCA_PERF_CPU_THROTTLE", "GCA_PERF_MULT", "GCA_SCAN_CHUNK", "GCA_TEST_BUILD_CRASH", "GCA_TEST_COPY_CRASH",
  "GCA_TEST_COPY_DELAY_MS", "GCA_TEST_FREE_BYTES",
];

// Every GCA_* name read through process.env in scripts/.
function varsReadByScripts() {
  const names = new Set();
  for (const f of fs.readdirSync(path.join(ROOT, "scripts"))) {
    if (!f.endsWith(".js")) continue;
    for (const m of read(path.join("scripts", f)).matchAll(/process\.env\.(GCA_[A-Z0-9_]+)/g)) names.add(m[1]);
  }
  return [...names].sort();
}

const example = read(".env.example");
const listed = [...example.matchAll(/^#?\s*(GCA_[A-Z0-9_]+)=/gm)].map((m) => m[1]);

test(".env.example lists every user-settable GCA_* variable the scripts read", () => {
  const userVars = varsReadByScripts().filter((n) => !TEST_ONLY.includes(n));
  assert.ok(userVars.includes("GCA_PORT") && userVars.includes("GCA_PERSONAL"), "sanity: the scan finds the server's vars");
  for (const n of userVars) assert.ok(listed.includes(n), n + " is read by scripts/ but missing from .env.example");
});

test(".env.example lists no test-only switch", () => {
  for (const n of TEST_ONLY) assert.doesNotMatch(example, new RegExp("\\b" + n + "\\b"), n + " belongs in ARCHITECTURE's Testing section");
  assert.doesNotMatch(example, /\bGCA_TEST_/);
  assert.doesNotMatch(example, /PLAYWRIGHT_BASE_URL/);
});

test(".env.example has a one-line comment above each variable and no live values", () => {
  const lines = example.split(/\r?\n/);
  for (const n of listed) {
    const at = lines.findIndex((l) => new RegExp("^#?\\s*" + n + "=").test(l));
    assert.match(lines[at - 1] || "", /^#\s*\S/, n + " needs a comment line right above it");
    assert.match(lines[at], /^#/, n + " ships commented out, so copying the file changes nothing");
  }
  assert.doesNotMatch(example, /(SECRET|TOKEN|PASSWORD|API_KEY)\s*=/i);
});

test("every test-only switch is documented in ARCHITECTURE's Testing section", () => {
  const arch = read("docs/ARCHITECTURE.md");
  const at = arch.search(/^## Testing/m);
  assert.ok(at >= 0, "docs/ARCHITECTURE.md has a ## Testing section");
  const testing = arch.slice(at);
  for (const n of TEST_ONLY.concat(["PLAYWRIGHT_BASE_URL"])) assert.ok(testing.includes(n), n + " is documented under Testing");
});
