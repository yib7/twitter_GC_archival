require("./_real-data-guard.js");   // QA-2: refuse to run outside a clean checkout
const { test, after } = require("node:test");
const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

// QA-2/SP-16 checkpoint test (review-fix item 3a): playwright.config.js's own
// isolation properties (dedicated port, throwaway GCA_PERSONAL, no legacy
// root fallback, never reuse a stray server) are exactly what stand between
// this suite and a real personal_data/ archive. Nothing before this test
// actually asserted them — a future edit could quietly restore the old
// 8765/9000/no-GCA_PERSONAL/reuseExistingServer:true shape and every other
// test file would keep passing (they don't inspect the config; the shared
// webServer just silently runs against real data again). This locks the
// config's own values down directly.
//
// require()ing playwright.config.js here runs the exact same top-level guard
// require + mkdtempSync that a real `playwright test` invocation runs (see
// the comments in that file) — this test's own process is effectively one
// more "worker" re-evaluating the config, so the `||=` guard on
// GCA_E2E_PERSONAL_DIR (the MINOR leak fix) applies here too and must be
// cleaned up the same way globalTeardown would.
const cfg = require("../playwright.config.js");

after(() => {
  const dir = process.env.GCA_E2E_PERSONAL_DIR;
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

test("playwright.config.js never reuses a stray already-running server", () => {
  assert.equal(cfg.webServer.reuseExistingServer, false);
});

test("playwright.config.js's webServer port is neither the real archive default (8765) nor server.js's own suggested alternate (9000)", () => {
  const port = Number(cfg.webServer.env.GCA_PORT);
  assert.equal(Number.isInteger(port), true);
  assert.notEqual(port, 8765);
  assert.notEqual(port, 9000);
});

test("playwright.config.js's GCA_PERSONAL is a throwaway directory under the OS temp dir, not anything inside the repo", () => {
  const personal = cfg.webServer.env.GCA_PERSONAL;
  assert.equal(typeof personal, "string");
  assert.ok(personal.length > 0);
  const rel = path.relative(os.tmpdir(), personal);
  assert.ok(rel && !rel.startsWith("..") && !path.isAbsolute(rel), "GCA_PERSONAL must resolve under os.tmpdir(): got " + personal);
});

test("playwright.config.js turns off the legacy ROOT/data.js + ROOT/names.local.js fallback for the whole e2e run", () => {
  assert.ok(cfg.webServer.env.GCA_NO_ROOT_FALLBACK, "GCA_NO_ROOT_FALLBACK must be set (truthy) on the shared webServer");
});
