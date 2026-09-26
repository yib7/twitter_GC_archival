const { test, expect } = require("@playwright/test");
const { bootViewer, msgs, conv } = require("./_viewer-fixture.js");

// UX-6 / VC-27: the floating bottom-left theme switch overlapped content on
// every view (and sat over the mobile tab bar area). It is replaced by a
// compact toggle in the sidebar footer (desktop) and in the More sheet
// (mobile); both stay in sync with Settings, and <meta name="theme-color">
// follows the active theme (including on a fresh load, before app.js runs).
const DATA = { conversations: [conv("A", "Alpha", msgs("a", 6))] };
const meta = (page) => page.locator('meta[name="theme-color"]').getAttribute("content");
const bgPage = (page) => page.evaluate(() => {
  const v = getComputedStyle(document.documentElement).getPropertyValue("--bg-page").trim();
  return v.toLowerCase();
});

test("desktop: the floating switch is gone; the sidebar-footer (#sidebar-theme) toggle sets and reflects the theme", async ({ page }) => {
  await bootViewer(page, DATA);
  await expect(page.locator(".theme-switch")).toHaveCount(0);
  const tg = page.locator("#sidebar-theme .theme-toggle");
  await expect(tg).toBeVisible();
  // reachable without scrolling the (overflowing) sidebar nav, even on a short window
  await expect(tg).toBeInViewport({ ratio: 1 });
  await page.setViewportSize({ width: 1280, height: 600 });
  await expect(tg).toBeInViewport({ ratio: 1 });
  expect(await page.evaluate(() => { const r = document.querySelector("#sidebar-theme button").getBoundingClientRect(); const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!(h && h.closest("#sidebar-theme")); })).toBe(true);
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(tg).toHaveAttribute("role", "group");
  await expect(tg).toHaveAttribute("aria-label", /theme/i);
  for (const [v, name] of [["light", "Light"], ["dim", "Dim"], ["lightsout", "Lights out"]]) {
    await expect(tg.getByRole("button", { name, exact: true })).toHaveAttribute("data-set", v);
  }
  // default = lights out
  await expect(tg.getByRole("button", { name: "Lights out" })).toHaveAttribute("aria-pressed", "true");
  expect(await meta(page)).toBe(await bgPage(page));

  await tg.getByRole("button", { name: "Light", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(tg.getByRole("button", { name: "Light", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(tg.getByRole("button", { name: "Lights out" })).toHaveAttribute("aria-pressed", "false");
  expect(await meta(page)).toBe("#ffffff");
  expect(await meta(page)).toBe(await bgPage(page));

  // Settings mirrors it, and Settings drives the footer toggle back
  await page.locator('.nav-item[data-view="settings"]').click();
  await expect(page.locator('#set-theme button[data-v="light"]')).toHaveClass(/sel/);
  await page.locator('#set-theme button[data-v="dim"]').click();
  await expect(tg.getByRole("button", { name: "Dim" })).toHaveAttribute("aria-pressed", "true");
  expect(await meta(page)).toBe("#15202b");

  // fresh load: theme-boot.js sets the meta before paint
  await page.reload();
  await expect(page.locator("#app")).toBeVisible();
  expect(await meta(page)).toBe("#15202b");
});

test("theme-boot sets theme-color before app.js runs", async ({ page }) => {
  await page.route("**/src/app.js", (r) => r.fulfill({ contentType: "text/javascript", body: "" }));
  await bootViewer(page, DATA, { ls: { "gca.theme": "light" }, goto: false });
  await page.goto("/");
  expect(await meta(page)).toBe("#ffffff");
});

test.describe("at 390px", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the More sheet carries the theme toggle", async ({ page }) => {
    await bootViewer(page, DATA);
    await expect(page.locator(".theme-switch")).toHaveCount(0);
    await page.locator("#tab-more").click();
    const tg = page.locator("#more-sheet .theme-toggle");
    await expect(tg).toBeVisible();
    await tg.getByRole("button", { name: "Light", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await expect(tg.getByRole("button", { name: "Light", exact: true })).toHaveAttribute("aria-pressed", "true");
    expect(await meta(page)).toBe("#ffffff");
    // the sheet stays open so the user can see the change
    await expect(page.locator("#more-sheet")).toHaveClass(/\bon\b/);
  });
});
