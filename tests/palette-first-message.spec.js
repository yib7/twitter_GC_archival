const { test, expect } = require("@playwright/test");
const { bootViewer, conv } = require("./_viewer-fixture.js");

// the palette's "Go to X's first message" used indexForTime(p.first),
// which returns the LAST index with t <= first — with tied timestamps it
// landed on someone else's message. The first index is now stored per person.
const T = Date.parse("2024-03-10T12:00:00Z");
const LIST = [
  { i: "m0", s: "u1", t: T, x: "u1 first" },
  { i: "m1", s: "u2", t: T, x: "u2 same second" },
  { i: "m2", s: "u2", t: T, x: "u2 again same second" },
  { i: "m3", s: "u1", t: T + 60000, x: "later" },
];
const DATA = { conversations: [conv("A", "Alpha", LIST)] };

test("'Go to X's first message' lands on X's message when timestamps tie", async ({ page }) => {
  await bootViewer(page, DATA);
  await page.keyboard.press("Control+k");
  await page.locator(".cmdk-input").fill("User 1's first message");
  await page.keyboard.press("Enter");
  await expect(page.locator('#view-timeline .msg[data-idx="0"]')).toHaveClass(/flash/);
  // jumpTo() first opens the timeline at 0, then jumps: only idx 0 may flash
  // (the bug flashed idx 2, u2's message, as the "first" of u1).
  await expect(page.locator("#view-timeline .msg.flash")).toHaveCount(1);
});
