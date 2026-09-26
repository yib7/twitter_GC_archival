const { test, expect } = require("@playwright/test");
const { bootViewer, msgs, conv, settledTimeline } = require("./_viewer-fixture.js");

// Review Minor 1: a timezone change invalidated the Timeline (so its labels
// rebuild in the new zone) but that reopened it at the top, throwing away the
// reading position VC-1 protects. The first visible message is now recorded
// when leaving the Timeline and the rebuilt Timeline reopens on it, quietly
// (no jump flash), with labels in the new zone.
const DATA = { conversations: [conv("A", "Alpha", msgs("m", 3000, { s: ["u1", "u2", "u3"], step: 3600000, t0: Date.parse("2023-01-01T00:30:00Z") }))] };

test("a timezone change keeps the Timeline reading position and relabels it", async ({ page }) => {
  await bootViewer(page, DATA, { ls: { "gca.lastView": "timeline", "gca.settings": JSON.stringify({ timezone: "UTC", tzExplicit: true }) } });
  await expect(page.locator("#view-timeline .msg").first()).toBeVisible();
  // Jump to a mid-archive date through the palette, then settle.
  await page.keyboard.press("Control+k");
  await page.locator(".cmdk-input").fill("2023-03-15");
  await page.keyboard.press("Enter");
  const start = await settledTimeline(page);
  expect(start.first).toBeGreaterThan(1500);
  const utcLabel = await page.locator('#view-timeline .msg[data-idx="' + start.first + '"] .msg-time').textContent();

  await page.locator('.nav-item[data-view="settings"]').click();
  await page.locator("#set-tz").selectOption("America/New_York");
  await page.locator('.nav-item[data-view="timeline"]').click();

  const back = await settledTimeline(page);
  expect(back.first).toBe(start.first);
  const row = page.locator('#view-timeline .msg[data-idx="' + start.first + '"]');
  await expect(row).not.toHaveClass(/flash/);
  const nyLabel = await row.locator(".msg-time").textContent();
  expect(nyLabel).not.toBe(utcLabel);   // relabelled in the new zone
});
