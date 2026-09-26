const { defineConfig } = require("@playwright/test");
const fs = require("fs");
const os = require("os");
const path = require("path");

// QA-2/SP-16: the shared webServer used to run on the user's own archive port
// (8765) with no GCA_PERSONAL and `reuseExistingServer: !process.env.CI` — run
// from the main checkout (or with a real archive server already up on 8765)
// the suite would silently load real messages into the browser, into
// test-results traces, and into error-context snapshots on failure.
//
// Fix: a dedicated, non-default port (well away from 8765 — the archive
// default — and 9000 — the port server.js itself tells users to try, see
// QA-1), a fresh throwaway GCA_PERSONAL for the whole run, and
// reuseExistingServer ALWAYS false so a stray real server on this port makes
// the run fail loudly (EADDRINUSE) instead of silently reusing it.
const TEST_PORT = 8799;
const baseURL = process.env.PLAYWRIGHT_BASE_URL || ("http://127.0.0.1:" + TEST_PORT);
const testPersonalDir = fs.mkdtempSync(path.join(os.tmpdir(), "gca-e2e-personal-"));
// globalTeardown runs in this same process (just later), so an env var is
// enough to hand it the path to clean up — no need for a file or IPC.
process.env.GCA_E2E_PERSONAL_DIR = testPersonalDir;

module.exports = defineConfig({
  testDir: "./tests",
  // Playwright owns *.spec.js; Node's runner owns *.test.js (unit tests). Keeping
  // them separate stops `playwright test` from loading node:test files.
  testMatch: "**/*.spec.js",
  timeout: 30 * 1000,
  expect: { timeout: 7 * 1000 },
  // QA-2: makes real-data isolation impossible-by-construction, not just a
  // convention — throws (existence checks only) if this checkout contains
  // personal_data*/, exports/, root data.js or root names.local.js, BEFORE the
  // webServer below is ever spawned.
  globalSetup: require.resolve("./tests/global-setup.js"),
  globalTeardown: require.resolve("./tests/global-teardown.js"),
  // QA-10: a committed `.only` must fail CI loudly instead of quietly running
  // one test and reporting green.
  forbidOnly: !!process.env.CI,
  use: {
    baseURL,
    viewport: { width: 1280, height: 900 },
    // QA-17(e): capture enough to debug an OS-only CI failure without having
    // to reproduce it locally — traces/screenshots/video only survive for a
    // FAILED test, so a green run costs nothing extra.
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: process.env.PLAYWRIGHT_BASE_URL ? undefined : {
    command: "node scripts/server.js",
    url: baseURL,
    // QA-2/SP-16: never reuse whatever else might already be listening on
    // this port — a stray real server here must fail the run, not serve it.
    reuseExistingServer: false,
    timeout: 15 * 1000,
    env: {
      GCA_PORT: String(TEST_PORT),
      // Fresh, empty, throwaway — the ~12 specs that don't stub data.js/local.js
      // (smoke, csp, localstorage, served-console-clean, the setup-*.spec.js
      // files that don't mock /api/*) get an unbuilt archive and fall back to
      // the committed data.sample.js, exactly like a clean `npm start` would.
      GCA_PERSONAL: testPersonalDir,
      // QA-2/SP-16: GCA_PERSONAL alone does not stop server.js from reading a
      // legacy ROOT/data.js or ROOT/names.local.js (readBuiltData's own
      // fallback, and the two static routes) — this switch turns that
      // fallback off entirely for the whole e2e run.
      GCA_NO_ROOT_FALLBACK: "1",
    },
  },
});
