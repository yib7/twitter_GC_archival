const { test, expect } = require("@playwright/test");
const { bootViewer, msgs, conv } = require("./_viewer-fixture.js");

// VC-1: leaving the Timeline hides #view-timeline; the virtualization
// IntersectionObserver then reported every rendered chunk as not intersecting,
// unrendered it and cached `offsetHeight || 1000` — i.e. 1000px, because a
// hidden element measures 0. On return the preserved scrollTop pointed into a
// shrunken layout and the reading position jumped by dozens of messages on
// every round trip. Hidden-root entries are now ignored and a 0 height is
// never cached.
const DATA = { conversations: [conv("A", "Alpha", msgs("m", 3000, { s: ["u1", "u2", "u3", "u4"], x: (k) => "line " + k + (k % 3 ? "" : " with a little more text to vary the row height a bit") }))] };

const snap = (page) => page.evaluate(() => {
  const s = document.getElementById("tl-scroll"); const sr = s.getBoundingClientRect();
  const vis = [...document.querySelectorAll("#view-timeline .msg")].filter((m) => { const r = m.getBoundingClientRect(); return r.top >= sr.top && r.top < sr.bottom; });
  return { scrollTop: Math.round(s.scrollTop), first: vis.length ? +vis[0].dataset.idx : null,
    heights: [...document.querySelectorAll("#tl-list .tl-chunk")].slice(0, 3).map((c) => c.getBoundingClientRect().height) };
});

test("VC-1: a Timeline -> other view -> Timeline round trip keeps the reading position", async ({ page }) => {
  await bootViewer(page, DATA, { ls: { "gca.lastView": "timeline" } });
  await expect(page.locator("#view-timeline .msg").first()).toBeVisible();
  // Scroll deep in steps so chunks render (and cache their real heights) on the way.
  for (let k = 0; k < 12; k++) {
    await page.locator("#tl-scroll").evaluate((s) => { s.scrollTop += 4000; });
    await page.waitForTimeout(60);
  }
  await page.waitForTimeout(300);
  const start = await snap(page);
  expect(start.first).toBeGreaterThan(200);
  for (const other of ["gallery", "stats", "gallery"]) {
    await page.locator('.nav-item[data-view="' + other + '"]').click();
    await page.waitForTimeout(250);
    await page.locator('.nav-item[data-view="timeline"]').click();
    await page.waitForTimeout(400);
    const now = await snap(page);
    expect(now.first, "first visible message after returning from " + other).toBe(start.first);
    // chunk 0 (unrendered, far above) must keep its measured height, not 1000px
    expect(now.heights[0]).not.toBe(1000);
  }
});
