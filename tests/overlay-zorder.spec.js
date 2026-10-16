const { test, expect } = require("@playwright/test");
const { bootViewer, conv } = require("./_viewer-fixture.js");

// Review Critical (d3a5060): the overlays were switched to
// z-index: var(--z-modal) / toasts to var(--z-toast), but those tokens were
// never defined, so every overlay computed z-index:auto and painted UNDER the
// mobile top bar (z30), tab bar (z40), More sheet, On-this-day toast and the
// (since removed) floating theme switch. Hit-tests prove what the user
// can actually click/see, not just DOM presence. The theme toggle now lives in
// the sidebar footer (desktop) and the More sheet (mobile).
const T = Date.parse("2024-03-10T12:00:00Z");
const LIST = [
  { i: "m0", s: "u1", t: T, x: "hello" },
  { i: "m1", s: "u2", t: T + 60000, x: "a pic", m: "sample/photo-1.svg", k: "img" },
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

test.describe("at 390px: More sheet theme toggle", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the sheet toggle is reachable above the tab bar, and nothing floats over the tab bar or lightbox", async ({ page }) => {
    await bootViewer(page, DATA);
    // closed sheet: every tab wins its own hit-test (no floating control over it)
    for (const t of ["search", "timeline", "gallery", "stats"]) expect(await wins(page, '.tabbar .tab[data-tab="' + t + '"]')).toBe(true);
    expect(await wins(page, "#tab-more")).toBe(true);
    await page.locator("#tab-more").click();
    // after the slide-in transition settles
    for (const v of ["light", "dim", "lightsout"]) await expect.poll(() => wins(page, '#more-sheet .theme-toggle button[data-set="' + v + '"]')).toBe(true);
    await page.keyboard.press("Escape");
    await expect(page.locator("#more-sheet")).not.toHaveClass(/\bon\b/);
    // open the lightbox: its controls are on top everywhere, incl. over the tab bar's band
    await page.locator("#s-list .media img").first().click();
    for (const s of [".lightbox .lb-close", ".lightbox .lb-pin"]) expect(await wins(page, s)).toBe(true);
    const cover = await page.evaluate(() => {
      const r = document.querySelector(".tabbar").getBoundingClientRect();
      const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !!(h && h.closest(".lightbox"));
    });
    expect(cover).toBe(true);
  });
});

test("desktop: an open modal covers the sidebar-footer theme toggle", async ({ page }) => {
  await bootViewer(page, DATA);
  const tg = page.locator("#sidebar-theme .theme-toggle");
  await expect(tg).toBeVisible();
  expect(await wins(page, "#sidebar-theme .theme-toggle")).toBe(true);
  await page.evaluate(() => document.activeElement && document.activeElement.blur());   // "?" is ignored while typing in the search box
  await page.keyboard.press("?");
  await expect(page.locator(".kb-modal")).toBeVisible();
  const hit = await page.evaluate(() => {
    const r = document.querySelector("#sidebar-theme .theme-toggle").getBoundingClientRect();
    const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!(h && h.closest(".kb-modal"));
  });
  expect(hit).toBe(true);
});
