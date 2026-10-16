require("./_real-data-guard.js");   // refuse to run outside a clean checkout
const { test, expect } = require("@playwright/test");

// A config.json the server can't read makes /api/status answer 500 with a
// plain sentence. The wizard says so when it opens, instead of looking like a
// fresh setup until the first click. All routes are mocked.
test("the wizard shows the status error when the saved settings can't be read", async ({ page }) => {
  const msg = "personal_data/config.json is damaged, so it was not changed. Use Start over to begin again.";
  await page.route("**/api/status", (route) =>
    route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: msg }) }));
  await page.goto("/setup.html");
  await expect(page.locator("#src-result")).toBeVisible();
  await expect(page.locator("#src-result")).toContainText(msg);
  await expect(page.locator("#src-result")).toHaveClass(/\berr\b/);
});
