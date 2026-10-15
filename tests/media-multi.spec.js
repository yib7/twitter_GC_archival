const { test, expect } = require("@playwright/test");
const { bootViewer, conv } = require("./_viewer-fixture.js");

// SP-20: X can export more than one media file for one DM; the build keeps
// the first as m/k and the rest in `mx`. The timeline must show all of them.
const T = Date.parse("2024-03-10T12:00:00Z");
const LIST = [
  { i: "m0", s: "u1", t: T, x: "two photos and a clip", m: "sample_media/photo-1.svg", k: "img",
    mx: [{ m: "sample_media/photo-2.svg", k: "img" }, { m: "sample_media/clip-1.svg", k: "file" }] },
  { i: "m1", s: "u2", t: T + 60000, x: "just one", m: "sample_media/photo-2.svg", k: "img" },
];
const DATA = { conversations: [conv("A", "Alpha", LIST)] };

test("SP-20: every media file of a message is rendered in the timeline", async ({ page }) => {
  await bootViewer(page, DATA, { ls: { "gca.lastView": "timeline" } });
  const multi = page.locator('#view-timeline .msg[data-idx="0"]');
  await expect(multi.locator(".media img")).toHaveCount(2);
  await expect(multi.locator(".media img").nth(1)).toHaveAttribute("src", "sample_media/photo-2.svg");
  await expect(multi.locator(".media a[href='sample_media/clip-1.svg']")).toHaveCount(1);
  // the extra photo is reachable by keyboard and named for screen readers
  const extra = multi.locator(".media-more a").first();
  await expect(extra).toHaveAttribute("aria-label", /Open photo 2 of 3 from /);
  const single = page.locator('#view-timeline .msg[data-idx="1"]');
  await expect(single.locator(".media img")).toHaveCount(1);
  await expect(single.locator(".media-more")).toHaveCount(0);
});
