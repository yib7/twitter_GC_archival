const { test, expect } = require("@playwright/test");
const { bootViewer, msgs, conv } = require("./_viewer-fixture.js");

// VC-21: "/" is documented as "Focus search" but was guarded by
// curView !== "search": on the Search view itself (focus anywhere but the
// input) it did nothing, and from other views it only switched view.
const DATA = { conversations: [conv("A", "Alpha", msgs("m", 8))] };

test("VC-21: '/' focuses the search box on the Search view", async ({ page }) => {
  await bootViewer(page, DATA);
  await page.locator("#s-list .msg").first().focus();   // focus somewhere that is not the input
  await expect(page.locator("#s-input")).not.toBeFocused();
  await page.keyboard.press("/");
  await expect(page.locator("#s-input")).toBeFocused();
  await expect(page.locator("#s-input")).toHaveValue("");   // the "/" itself is not typed
});

test("VC-21: '/' from another view opens Search with the box focused", async ({ page }) => {
  await bootViewer(page, DATA, { ls: { "gca.lastView": "timeline" } });
  await expect(page.locator("#view-timeline .msg").first()).toBeVisible();
  await page.keyboard.press("/");
  await expect(page.locator("#s-input")).toBeFocused();
  await expect(page.locator("#s-input")).toHaveValue("");
});
