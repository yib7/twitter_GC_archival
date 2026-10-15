require("./_real-data-guard.js");   // QA-2: refuse to run outside a clean checkout
const { test, expect } = require("@playwright/test");
const { mockPreflight } = require("./_setup-helpers.js");

// SP-23: wizard polish. Server routes are mocked; nothing real is touched.

test.beforeEach(async ({ page }) => {
  await page.route("**/api/status", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ built: false, groups: [], ignoredGroups: [] }) }));
});

test("Build can't be started twice: the button is disabled while a build runs", async ({ page }) => {
  let calls = 0, release;
  const gate = new Promise((r) => { release = r; });
  await page.route("**/api/source", async (route) => {
    calls++;
    await gate;
    route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ totalMsgs: 5, groups: [{ id: "G1", title: "Grp", count: 5 }], mediaCopied: 0 }) });
  });
  await mockPreflight(page);
  await page.goto("/setup.html");
  await page.locator("#src-group").fill("group.js");
  await page.locator("#src-headers").fill("headers.js");
  await page.locator("#src-media").fill("media");
  // SP7: Check export shows the preview first; the build starts from its button
  await page.locator("#btn-build").click();
  await page.locator("#btn-confirm").click();
  await expect(page.locator("#btn-confirm")).toBeDisabled();
  await expect(page.locator("#btn-build")).toBeDisabled();
  await page.locator("#btn-confirm").dispatchEvent("click");   // a second click while it runs
  release();
  await expect(page.locator('[data-pane="2"]')).toBeVisible();
  expect(calls).toBe(1);
});

test("a failed build re-enables the Build button", async ({ page }) => {
  await page.route("**/api/source", (route) =>
    route.fulfill({ status: 422, contentType: "application/json", body: JSON.stringify({ error: "The file is empty.", log: "BUILD ERROR: The file is empty." }) }));
  await mockPreflight(page);
  await page.goto("/setup.html");
  await page.locator("#src-group").fill("group.js");
  await page.locator("#src-headers").fill("headers.js");
  await page.locator("#src-media").fill("media");
  await page.locator("#btn-build").click();
  await page.locator("#btn-confirm").click();
  await expect(page.locator("#src-result")).toContainText(/empty/);
  await expect(page.locator("#btn-build")).toBeEnabled();
  await expect(page.locator("#btn-confirm")).toBeEnabled();
});

test("a file browser that failed to open says so, instead of 'only available on Windows'", async ({ page }) => {
  await page.route("**/api/pick-file*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ supported: true, path: "", error: "The Windows file browser couldn't be opened." }) }));
  await page.goto("/setup.html");
  await page.locator("#group-browse").click();
  const out = page.locator("#src-result");
  await expect(out).toContainText(/couldn't be opened/);
  await expect(out).toContainText(/paste the full path/i);
  await expect(out).not.toContainText(/only available on Windows/);
});

test("a picker refused by the server (an old page after a restart) asks for a reload", async ({ page }) => {
  await page.route("**/api/pick-folder*", (route) =>
    route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "forbidden" }) }));
  await page.goto("/setup.html");
  await page.locator("#media-browse").click();
  await expect(page.locator("#src-result")).toContainText(/reload this page/i);
});

test("off Windows the picker still explains to paste the path", async ({ page }) => {
  await page.route("**/api/pick-file*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ supported: false, path: "" }) }));
  await page.goto("/setup.html");
  await page.locator("#headers-browse").click();
  await expect(page.locator("#src-result")).toContainText(/only available on Windows/);
});
