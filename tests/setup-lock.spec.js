const { test, expect } = require("@playwright/test");

test("source step is locked when an archive is already built", async ({ page }) => {
  await page.route("**/api/status", (route) =>
    route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ built: true, groups: [{ id: "G1", title: "Alpha", count: 10 }], ignoredGroups: [] }) }));

  await page.goto("/setup.html");

  await expect(page.locator("#src-locked")).toBeVisible();
  await expect(page.locator("#src-group")).toBeDisabled();
  await expect(page.locator("#src-headers")).toBeDisabled();
  await expect(page.locator("#src-media")).toBeDisabled();
  await expect(page.locator("#btn-build")).toBeDisabled();
});

test("source step is editable on a fresh setup (nothing built yet)", async ({ page }) => {
  await page.route("**/api/status", (route) =>
    route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ built: false, groups: [], ignoredGroups: [] }) }));

  await page.goto("/setup.html");

  await expect(page.locator("#src-locked")).toBeHidden();
  await expect(page.locator("#src-group")).toBeEnabled();
  await expect(page.locator("#btn-build")).toBeEnabled();
});
