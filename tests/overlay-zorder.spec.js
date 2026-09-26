const { test, expect } = require("@playwright/test");
const { bootViewer, conv } = require("./_viewer-fixture.js");

// Review Critical (d3a5060): the overlays were switched to
// z-index: var(--z-modal) / toasts to var(--z-toast), but those tokens were
// never defined, so every overlay computed z-index:auto and painted UNDER the
// mobile top bar (z30), tab bar (z40), More sheet, On-this-day toast and the
// floating theme switch (z200). Hit-tests prove what the user can actually
// click/see, not just DOM presence.
const T = Date.parse("2024-03-10T12:00:00Z");
const LIST = [
  { i: "m0", s: "u1", t: T, x: "hello" },
  { i: "m1", s: "u2", t: T + 60000, x: "a pic", m: "sample_media/photo-1.svg", k: "img" },
];
const DATA = { conversations: [conv("A", "Alpha", LIST)] };
// Is the element matching `sel` the top-most thing at its own centre?
const wins = (page, sel) => page.evaluate((s) => {
  const n = document.querySelector(s); if (!n) return "missing " + s;
  const r = n.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return hit && n.contains(hit) ? true : (hit ? (hit.className || hit.tagName) : "nothing");
}, sel);

test.describe("at 390px (mobile chrome)", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the lightbox close button and a toast paint above the top bar and tab bar", async ({ page }) => {
    await bootViewer(page, DATA);
    await expect(page.locator(".tabbar")).toBeVisible();
    await expect(page.locator(".mobile-topbar")).toBeVisible();
    await page.locator("#s-list .media img").first().click();
    await expect(page.locator(".lightbox .lb-close")).toBeVisible();
    expect(await wins(page, ".lightbox .lb-close")).toBe(true);
    // a toast raised while the lightbox is open sits above it
    await page.locator(".lightbox .lb-pin").click();
    await expect(page.locator(".toast")).toBeVisible();
    expect(await wins(page, ".toast")).toBe(true);
    // and above the tab bar once the lightbox is gone
    await page.keyboard.press("Escape");
    await expect(page.locator(".lightbox")).toHaveCount(0);
    expect(await wins(page, ".toast")).toBe(true);
  });
});

test("desktop: an open modal covers the floating theme switch", async ({ page }) => {
  await bootViewer(page, DATA);
  const sw = page.locator(".theme-switch");
  test.skip(!(await sw.isVisible()), "no floating theme switch in this build");
  await page.evaluate(() => document.activeElement && document.activeElement.blur());   // "?" is ignored while typing in the search box
  await page.keyboard.press("?");
  await expect(page.locator(".kb-modal")).toBeVisible();
  const hit = await page.evaluate(() => {
    const r = document.querySelector(".theme-switch").getBoundingClientRect();
    const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!(h && h.closest(".kb-modal"));
  });
  expect(hit).toBe(true);
});
