/*
 * README's "Environment variables" section documents the variables a USER may
 * set. It must cover every GCA_* variable the app's scripts read, except the
 * test/harness switches, which are documented in docs/ARCHITECTURE.md's Testing
 * section instead (and must never appear in the README's table). Nothing loads
 * a .env file, so the repo ships no .env.example.
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

// The README section, up to the next heading.
function readmeSection() {
  const readme = read("README.md");
  const at = readme.search(/^### Environment variables$/m);
  assert.ok(at >= 0, "README.md has a ### Environment variables section");
  const rest = readme.slice(readme.indexOf("\n", at) + 1);   // after the heading line
  const end = rest.search(/^#{1,3} /m);
  return end >= 0 ? rest.slice(0, end) : rest;
}
const section = readmeSection();
const listed = [...section.matchAll(/^\| `(GCA_[A-Z0-9_]+)` \|/gm)].map((m) => m[1]);

test("README's Environment variables table lists every user-settable GCA_* variable the scripts read", () => {
  const userVars = varsReadByScripts().filter((n) => !TEST_ONLY.includes(n));
  assert.ok(userVars.includes("GCA_PORT") && userVars.includes("GCA_PERSONAL"), "sanity: the scan finds the server's vars");
  for (const n of userVars) assert.ok(listed.includes(n), n + " is read by scripts/ but missing from README's table");
  for (const n of listed) assert.ok(userVars.includes(n), n + " is in README's table but no script reads it");
});

test("README's Environment variables section names no test-only switch", () => {
  for (const n of TEST_ONLY) assert.doesNotMatch(section, new RegExp("\\b" + n + "\\b"), n + " belongs in ARCHITECTURE's Testing section");
  assert.doesNotMatch(section, /\bGCA_TEST_/);
  assert.doesNotMatch(section, /PLAYWRIGHT_BASE_URL/);
});

test("nothing pretends a .env file is read: the section says so and no .env.example ships", () => {
  assert.match(section, /nothing reads a `\.env` file/);
  assert.ok(!fs.existsSync(path.join(ROOT, ".env.example")), ".env.example would suggest a .env is loaded");
  for (const f of fs.readdirSync(path.join(ROOT, "scripts"))) {
    if (f.endsWith(".js")) assert.doesNotMatch(read(path.join("scripts", f)), /loadEnvFile|require\(["']dotenv["']\)/, f);
  }
});

test("every test-only switch is documented in ARCHITECTURE's Testing section", () => {
  const arch = read("docs/ARCHITECTURE.md");
  const at = arch.search(/^## Testing/m);
  assert.ok(at >= 0, "docs/ARCHITECTURE.md has a ## Testing section");
  const testing = arch.slice(at);
  for (const n of TEST_ONLY.concat(["PLAYWRIGHT_BASE_URL"])) assert.ok(testing.includes(n), n + " is documented under Testing");
});
