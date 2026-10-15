const { test, expect } = require("@playwright/test");
const { bootViewer, conv, msgs, collectErrors } = require("./_viewer-fixture.js");

// Storage that reads but refuses writes (full quota) during boot. The
// one-time "unmarked UTC -> local" timezone migration saves settings at
// startup; a failed save must not stop the viewer from opening.
// Synthetic data only.
const DATA = { conversations: [conv("A", "Alpha", msgs("a", 3))] };

test("a settings write that fails during the boot timezone migration still opens the archive", async ({ page }) => {
  const errors = collectErrors(page);
  await page.addInitScript(() => {
    localStorage.setItem("gca.settings", JSON.stringify({ timezone: "UTC" }));
    const real = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) {
      if (k === "gca.settings") throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
      return real.call(this, k, v);
    };
  });
  await bootViewer(page, DATA, { ls: { "gca.lastView": "timeline" } });
  await expect(page.locator("#view-timeline .msg").first()).toBeVisible();
  expect(errors).toEqual([]);
  // the migration still applies for this session: the zone in effect is local
  await page.locator('[data-view="settings"]').click();
  expect(await page.locator('#set-tz option[value="local"]').evaluate((o) => o.defaultSelected)).toBe(true);
});
