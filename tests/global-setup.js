// QA-2/SP-16 (correction after review): this is belt-and-suspenders
// defense-in-depth, NOT the primary enforcement point. In @playwright/test
// 1.62.1, plugin setup — which is what spawns the webServer — runs BEFORE
// globalSetups (node_modules/playwright/lib/runner/index.js:6003-6009 runs
// plugin setup; the webServer plugin is pushed onto that list around line
// 6649). A guard that only lived here would run AFTER a real-data webServer
// had already been spawned — too late to stop it. The actual gate is the
// `require("./tests/_real-data-guard.js")` at the very top of
// playwright.config.js, which runs at config-evaluation time, before
// Playwright's runner does anything else. This file just re-checks the same
// guard a second time (require() is cached, so this is cheap) in case a
// future refactor ever changes that ordering.
require("./_real-data-guard.js");

module.exports = async function globalSetup() {
  // Nothing else to do: reaching this line means _real-data-guard.js's
  // top-level check already passed (here, and earlier at the top of
  // playwright.config.js — see the comment above).
};
