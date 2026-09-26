const { test, expect } = require("@playwright/test");
const { bootViewer, msgs, conv, settledTimeline, frames } = require("./_viewer-fixture.js");

// VC-1: leaving the Timeline hides #view-timeline; the virtualization
// IntersectionObserver then reported every rendered chunk as not intersecting,
// unrendered it and cached `offsetHeight || 1000` — i.e. 1000px, because a
// hidden element measures 0. On return the preserved scrollTop pointed into a
// shrunken layout and the reading position jumped by dozens of messages on
// every round trip. Hidden-root entries are now ignored and a 0 height is
// never cached.
const DATA = { conversations: [conv("A", "Alpha", msgs("m", 3000, { s: ["u1", "u2", "u3", "u4"], x: (k) => "line " + k + (k % 3 ? "" : " with a little more text to vary the row height a bit") }))] };

test("VC-1: a Timeline -> other view -> Timeline round trip keeps the reading position", async ({ page }) => {
  await bootViewer(page, DATA, { ls: { "gca.lastView": "timeline" } });
  await expect(page.locator("#view-timeline .msg").first()).toBeVisible();
  // Scroll deep in steps so chunks render (and cache their real heights) on the
  // way: after each step wait until the viewport shows messages and holds still.
  for (let k = 0; k < 12; k++) {
    await page.locator("#tl-scroll").evaluate((s) => { s.scrollTop += 4000; });
    await settledTimeline(page);
  }
  const start = await settledTimeline(page);
  expect(start.first).toBeGreaterThan(200);
  for (const other of ["gallery", "stats", "gallery"]) {
    await page.locator('.nav-item[data-view="' + other + '"]').click();
    await expect(page.locator("#view-" + other)).toBeVisible();
    await expect(page.locator("#view-timeline")).toBeHidden();
    // Let the virtualization observer see the hidden timeline (the VC-1 bug).
    await frames(page);
    await page.locator('.nav-item[data-view="timeline"]').click();
    await expect(page.locator("#view-timeline")).toBeVisible();
    const now = await settledTimeline(page);
    expect(now.first, "first visible message after returning from " + other).toBe(start.first);
    // chunk 0 (unrendered, far above) must keep its measured height, not 1000px
    expect(now.heights[0]).not.toBe(1000);
  }
});
