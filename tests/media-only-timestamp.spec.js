const { test, expect } = require("@playwright/test");
const { bootViewer, conv } = require("./_viewer-fixture.js");

// a consecutive message hides its header (name + time) and exposes the
// time as a hover tooltip on the bubble — but a media-only message has no
// bubble, so its time was shown nowhere. The media block now carries it.
const T = Date.parse("2024-03-10T12:00:00Z");
const LIST = [
  { i: "m0", s: "u1", t: T, x: "look at this" },
  { i: "m1", s: "u1", t: T + 60000, x: "", m: "sample_media/photo-1.svg", k: "img" },
];
const DATA = { conversations: [conv("A", "Alpha", LIST)] };

test("a consecutive media-only message still exposes its time", async ({ page }) => {
  await bootViewer(page, DATA, { ls: { "gca.lastView": "timeline", "gca.settings": JSON.stringify({ timezone: "UTC", tzExplicit: true }) } });
  const row = page.locator('#view-timeline .msg[data-idx="1"]');
  await expect(row).toHaveClass(/consecutive/);
  await expect(row.locator(".msg-head")).toBeHidden();
  await expect(row.locator(".media")).toHaveAttribute("title", "Mar 10, 2024, 12:01 PM");
});
