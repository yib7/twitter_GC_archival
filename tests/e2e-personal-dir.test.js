require("./_real-data-guard.js");   // refuse to run outside a clean checkout
const { test } = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// playwright.config.js reused ANY inherited
// GCA_E2E_PERSONAL_DIR as the shared webServer's GCA_PERSONAL, and
// globalTeardown rmSync'd it recursively. A stray/typo'd env var pointing at a
// real folder (worst case: a real personal_data/) would have been served to the
// e2e run AND then deleted. Both must only ever touch a directory that looks
// exactly like one the config itself created: a direct child of os.tmpdir()
// whose name starts with "gca-e2e-personal-".
const ROOT = path.join(__dirname, "..");

function loadConfigWith(envDir) {
  const env = Object.assign({}, process.env);
  if (envDir === undefined) delete env.GCA_E2E_PERSONAL_DIR; else env.GCA_E2E_PERSONAL_DIR = envDir;
  const r = spawnSync(process.execPath, ["-e", "process.stdout.write(require('./playwright.config.js').webServer.env.GCA_PERSONAL)"], { cwd: ROOT, env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}
function cleanup(dir) {
  if (dir && path.basename(dir).startsWith("gca-e2e-personal-") && path.dirname(path.resolve(dir)) === path.resolve(os.tmpdir())) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("an inherited GCA_E2E_PERSONAL_DIR outside os.tmpdir() is never used as the e2e GCA_PERSONAL", () => {
  const foreign = path.join(ROOT, "personal_data");   // path only — never created, read or listed
  const got = loadConfigWith(foreign);
  try {
    assert.notEqual(path.resolve(got), path.resolve(foreign));
    assert.equal(path.dirname(path.resolve(got)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(got).startsWith("gca-e2e-personal-"), got);
  } finally { cleanup(got); }
});

test("an inherited temp dir that isn't named gca-e2e-personal-* is not reused either", () => {
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "someone-elses-"));
  try {
    const got = loadConfigWith(other);
    try { assert.notEqual(path.resolve(got), path.resolve(other)); }
    finally { cleanup(got); }
  } finally { fs.rmSync(other, { recursive: true, force: true }); }
});

test("a genuine gca-e2e-personal-* temp dir IS reused (workers must share the runner's dir)", () => {
  const own = fs.mkdtempSync(path.join(os.tmpdir(), "gca-e2e-personal-"));
  try {
    assert.equal(path.resolve(loadConfigWith(own)), path.resolve(own));
  } finally { fs.rmSync(own, { recursive: true, force: true }); }
});

test("globalTeardown refuses to delete a GCA_E2E_PERSONAL_DIR that isn't a gca-e2e-personal-* temp dir", async () => {
  const teardown = require("./global-teardown.js");
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "someone-elses-"));
  fs.writeFileSync(path.join(other, "keep.txt"), "x");
  const saved = process.env.GCA_E2E_PERSONAL_DIR;
  try {
    process.env.GCA_E2E_PERSONAL_DIR = other;
    await teardown();
    assert.ok(fs.existsSync(path.join(other, "keep.txt")), "teardown deleted a directory it did not create");
  } finally {
    if (saved === undefined) delete process.env.GCA_E2E_PERSONAL_DIR; else process.env.GCA_E2E_PERSONAL_DIR = saved;
    fs.rmSync(other, { recursive: true, force: true });
  }
});

test("globalTeardown still removes its own gca-e2e-personal-* temp dir", async () => {
  const teardown = require("./global-teardown.js");
  const own = fs.mkdtempSync(path.join(os.tmpdir(), "gca-e2e-personal-"));
  const saved = process.env.GCA_E2E_PERSONAL_DIR;
  try {
    process.env.GCA_E2E_PERSONAL_DIR = own;
    await teardown();
    assert.equal(fs.existsSync(own), false);
  } finally {
    if (saved === undefined) delete process.env.GCA_E2E_PERSONAL_DIR; else process.env.GCA_E2E_PERSONAL_DIR = saved;
    fs.rmSync(own, { recursive: true, force: true });
  }
});
