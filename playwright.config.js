// globalSetup does NOT run before the
// webServer in @playwright/test 1.62.1 — plugin setup (which is what spawns
// webServer) runs at node_modules/playwright/lib/runner/index.js:6003-6009,
// BEFORE globalSetups are run; the webServer plugin itself is pushed onto that
// plugin list around line 6649. A guard placed only in globalSetup (as this
// file originally had it) would therefore run AFTER a real-data webServer had
// already been spawned — too late. Requiring the guard here, at the very top
// of this file, runs it at config-EVALUATION time (synchronously, before
// `defineConfig()` is even called, let alone before Playwright's runner gets
// to plugin setup), which really is before anything else, webServer included.
require("./tests/_real-data-guard.js");

const { defineConfig } = require("@playwright/test");
const { ensureE2EPersonalDir } = require("./tests/_e2e-personal-dir.js");

// the shared webServer used to run on the user's own archive port
// (8765) with no GCA_PERSONAL and `reuseExistingServer: !process.env.CI` — run
// from the main checkout (or with a real archive server already up on 8765)
// the suite would silently load real messages into the browser, into
// test-results traces, and into error-context snapshots on failure.
//
// Fix: a dedicated, non-default port (well away from 8765 — the archive
// default — and 9000 — the port server.js itself tells users to try, see
// what server.js itself suggests when its port is taken), a fresh throwaway GCA_PERSONAL for the whole run, and
// reuseExistingServer ALWAYS false so a stray real server on this port makes
// the run fail loudly (EADDRINUSE) instead of silently reusing it.
const TEST_PORT = 8799;
const baseURL = process.env.PLAYWRIGHT_BASE_URL || ("http://127.0.0.1:" + TEST_PORT);
// Workers re-evaluate this config file (each worker process requires it
// independently), so a plain mkdtempSync() here created a fresh, never-cleaned
// throwaway dir PER WORKER, not one per run — only the last one assigned to
// GCA_E2E_PERSONAL_DIR ever got cleaned up by globalTeardown, leaking the rest
// into the OS temp dir. `||=` makes only the FIRST evaluation (the test
// runner's own process, which sets env vars workers inherit) create the dir;
// every worker's re-evaluation sees GCA_E2E_PERSONAL_DIR already set and reuses it.
// an inherited value is only reused when it is a direct child
// of os.tmpdir() named gca-e2e-personal-* (see tests/_e2e-personal-dir.js) —
// a stray GCA_E2E_PERSONAL_DIR pointing anywhere else is never served.
const testPersonalDir = ensureE2EPersonalDir();

module.exports = defineConfig({
  testDir: "./tests",
  // Playwright owns *.spec.js; Node's runner owns *.test.js (unit tests). Keeping
  // them separate stops `playwright test` from loading node:test files.
  testMatch: "**/*.spec.js",
  timeout: 30 * 1000,
  expect: { timeout: 7 * 1000 },
  // Kept as belt-and-suspenders defense-in-depth, NOT the actual enforcement
  // point: in this Playwright version globalSetup runs AFTER the webServer
  // plugin has already been set up (see the note above the top-of-file
  // require, which is what actually gates the webServer). This just re-checks
  // the same guard a second time, in case a future refactor of this file ever
  // separates config-evaluation from webServer spawning.
  globalSetup: require.resolve("./tests/global-setup.js"),
  globalTeardown: require.resolve("./tests/global-teardown.js"),
  // a committed `.only` must fail CI loudly instead of quietly running
  // one test and reporting green.
  forbidOnly: !!process.env.CI,
  use: {
    baseURL,
    viewport: { width: 1280, height: 900 },
    // capture enough to debug an OS-only CI failure without having
    // to reproduce it locally — traces/screenshots/video only survive for a
    // FAILED test, so a green run costs nothing extra.
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  // The 100k-message performance budgets are wall-clock measurements, so they
  // must not share the machine with the rest of the suite: under a full
  // parallel run they sometimes missed budget although they pass alone. The
  // perf spec gets its own project that waits for every other test to finish
  // (dependencies) and then runs on a single worker. `npx playwright test`
  // still runs everything in one command. Budgets and GCA_PERF_MULT are
  // unchanged. If an earlier test fails, Playwright skips the perf project
  // (its dependency failed); fix that failure first, or run
  // `npx playwright test --project=perf --no-deps` on its own.
  projects: [
    { name: "main", testIgnore: "**/perf-100k*.spec.js" },
    { name: "perf", testMatch: "**/perf-100k*.spec.js", dependencies: ["main"], fullyParallel: false, workers: 1 },
  ],
  webServer: process.env.PLAYWRIGHT_BASE_URL ? undefined : {
    command: "node scripts/server.js",
    url: baseURL,
    // never reuse whatever else might already be listening on
    // this port — a stray real server here must fail the run, not serve it.
    reuseExistingServer: false,
    timeout: 15 * 1000,
    env: {
      GCA_PORT: String(TEST_PORT),
      // Fresh, empty, throwaway — the ~12 specs that don't stub data.js/local.js
      // (smoke, csp, localstorage, served-console-clean, the setup-*.spec.js
      // files that don't mock /api/*) get an unbuilt archive and fall back to
      // the committed sample/data.sample.js, exactly like a clean `npm start` would.
      GCA_PERSONAL: testPersonalDir,
      // GCA_PERSONAL alone does not stop server.js from reading a
      // legacy ROOT/data.js or ROOT/names.local.js (readBuiltData's own
      // fallback, and the two static routes) — this switch turns that
      // fallback off entirely for the whole e2e run.
      GCA_NO_ROOT_FALLBACK: "1",
    },
  },
});
