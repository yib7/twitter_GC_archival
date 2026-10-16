const { test, expect } = require("@playwright/test");
const { bootViewer, msgs, conv, settledTimeline } = require("./_viewer-fixture.js");

// Review Minor 1: a timezone change invalidated the Timeline (so its labels
// rebuild in the new zone) but that reopened it at the top, throwing away the
// reading position the round-trip test protects. The first visible message is now recorded
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

// A jump or a reopened reading position must not leave an unrendered chunk
// placeholder on screen. One would render a frame later at its real height and
// push the message the reader was put on out of place (seen on a slow CI
// machine: 21 messages off). The check runs in the same task as the jump and
// the reopen, before any IntersectionObserver callback can fill the gap. It
// also reports which message is flashed and which is first on screen, so the
// test can tell that the jump or reopen really happened in that same task.
const screenState = () => {
  const sr = document.getElementById("tl-scroll").getBoundingClientRect();
  const onScreen = (n) => { const r = n.getBoundingClientRect(); return r.bottom > sr.top && r.top < sr.bottom; };
  const blank = [...document.querySelectorAll("#tl-list .tl-chunk")]
    .filter((c) => onScreen(c) && !c.querySelector(".msg")).map((c) => c.dataset.c);
  const flash = document.querySelector("#tl-list .msg.flash");
  const first = [...document.querySelectorAll("#tl-list .msg")].find((m) => { const t = m.getBoundingClientRect().top; return t >= sr.top && t < sr.bottom; });
  return { blank, flashed: flash ? +flash.dataset.idx : null, first: first ? +first.dataset.idx : null };
};

test("a date jump and a reopened reading position leave no unrendered chunk on screen", async ({ page }) => {
  await bootViewer(page, DATA, { ls: { "gca.lastView": "timeline", "gca.settings": JSON.stringify({ timezone: "UTC", tzExplicit: true }) } });
  await expect(page.locator("#view-timeline .msg").first()).toBeVisible();
  await page.keyboard.press("Control+k");
  await page.locator(".cmdk-input").fill("2023-03-15");
  const afterJump = await page.evaluate((check) => {
    document.querySelector(".cmdk-input").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    return (0, eval)("(" + check + ")")();
  }, screenState.toString());
  expect(afterJump.flashed).toBeGreaterThan(1500);   // landed on the mid-archive date already
  expect(afterJump.blank).toEqual([]);

  const before = await settledTimeline(page);
  await page.locator('.nav-item[data-view="settings"]').click();
  await page.locator("#set-tz").selectOption("America/New_York");
  const afterReopen = await page.evaluate((check) => {
    document.querySelector('.nav-item[data-view="timeline"]').click();
    return (0, eval)("(" + check + ")")();
  }, screenState.toString());
  expect(afterReopen.first).toBe(before.first);   // reopened at the reading position already
  expect(afterReopen.blank).toEqual([]);
});
