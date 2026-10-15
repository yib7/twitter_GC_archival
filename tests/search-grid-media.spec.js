const { test, expect } = require("@playwright/test");
const { bootViewer, msgs, conv, afterSearchRun } = require("./_viewer-fixture.js");

// grid mode only renders messages with media, but the count, paging
// and empty state all used the unfiltered result list — "20 messages found ·
// showing media only" over a blank page with 0 cells and no explanation.
// In grid mode the result set is now the media subset.
const LIST = msgs("m", 20, { x: (k) => "text " + k,
  extra: (k) => (k === 3 || k === 11 ? { m: "sample_media/photo-" + k + ".svg", k: "img" } : null) });
const DATA = { conversations: [conv("A", "Alpha", LIST)] };
const grid = (page) => page.locator('#f-viewtoggle button[data-mode="grid"]').click();

test("grid mode counts only media results", async ({ page }) => {
  await bootViewer(page, DATA);
  await afterSearchRun(page, () => grid(page));
  await afterSearchRun(page, () => page.locator("#s-input").fill("text"));
  await expect(page.locator("#s-list .gcell")).toHaveCount(2);
  await expect(page.locator("#s-meta")).toHaveText(/^2 media messages found/);
});

test("grid mode with no media in the results shows an empty state", async ({ page }) => {
  await bootViewer(page, DATA);
  await afterSearchRun(page, () => grid(page));
  await afterSearchRun(page, () => page.locator('#f-matchtoggle button[data-mode="exact"]').click());
  await afterSearchRun(page, () => page.locator("#s-input").fill("text 5"));   // matches only a text-only message
  await expect(page.locator("#s-list .gcell")).toHaveCount(0);
  await expect(page.locator("#s-list .empty")).toContainText("No media in these results");
  await expect(page.locator("#s-meta")).toHaveText(/^0 media messages found/);
});
