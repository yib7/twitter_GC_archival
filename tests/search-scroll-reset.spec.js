const { test, expect } = require("@playwright/test");
const { bootViewer, msgs, conv, afterSearchRun } = require("./_viewer-fixture.js");

// VC-2: runSearch() cleared and refilled the results list but never reset the
// scroller, so after scrolling the "show all" list a new query kept the old
// offset: the best results were off-screen above and the infinite-scroll
// sentinel had already pulled in page 2.
const DATA = { conversations: [conv("A", "Alpha", msgs("m", 600, { x: (k) => (k % 5 ? "hello " + k : "pizza night " + k) }))] };

test("VC-2: a new search starts at the top of the results", async ({ page }) => {
  await bootViewer(page, DATA);
  await expect(page.locator("#s-list .msg").first()).toBeVisible();
  // Scroll to the bottom until the infinite-scroll sentinel has pulled in more
  // than the first page and the scroller sits well below the top.
  await expect.poll(() => page.locator("#s-scroll").evaluate((s) => {
    s.scrollTop = s.scrollHeight;
    return s.scrollTop > 2000 && document.querySelectorAll("#s-list .msg").length > 60;
  }), { intervals: [50, 100, 100, 150, 200], timeout: 10000 }).toBe(true);
  await afterSearchRun(page, () => page.locator("#s-input").fill("pizza"));
  expect(await page.locator("#s-scroll").evaluate((s) => s.scrollTop)).toBe(0);
  const firstTop = await page.locator("#s-list .msg").first().evaluate((m) => m.getBoundingClientRect().top - document.getElementById("s-scroll").getBoundingClientRect().top);
  expect(firstTop).toBeLessThan(200);
});
