const { test, expect } = require("@playwright/test");
const { bootViewer, conv, msgs } = require("./_viewer-fixture.js");
const { contrastFailures } = require("./_contrast.js");

// The red "✕ Clear all" pills (Pinned with a bookmark; the Search filter bar
// once a query is typed) drew raw --danger as text: 3.4:1 on Light and 3.7:1
// on Dim. Each one is checked in every theme, at a desktop width and on a
// phone (where the filter bar is a bottom sheet). Synthetic data only.
const THEMES = ["lightsout", "dim", "light"];
const DATA = { conversations: [conv("A", "Alpha", msgs("a", 12, { s: ["u1", "u2"], x: (k) => "volley " + k }))] };
const SIZES = [
  { name: "1280", use: { viewport: { width: 1280, height: 900 } } },
  { name: "375", use: { viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true } },
];

for (const sz of SIZES) {
  test.describe("danger text at " + sz.name, () => {
    test.use(sz.use);
    for (const th of THEMES) {
      test(th, async ({ page }) => {
        await page.emulateMedia({ reducedMotion: "reduce" });
        await bootViewer(page, DATA, { ls: { "gca.theme": th, "gca.lastView": "pins", "gca.settings": JSON.stringify({ pins: ["a3"] }) } });
        const bad = [];
        const clearPins = page.locator("#pins-clear");
        await expect(clearPins).toBeVisible();
        for (const f of await contrastFailures(page, "#view-pins .pins-actions")) bad.push("pins: " + f);
        // Search, with a query typed so the filter bar's Clear all shows
        if (sz.name === "375") {
          await page.locator('.tabbar .tab[data-tab="search"]').tap();
        } else {
          await page.locator('.nav-item[data-view="search"]').click();
        }
        await page.locator("#s-input").fill("volley");
        if (sz.name === "375") await page.getByRole("button", { name: /^Filters/ }).tap();
        await expect(page.locator("#f-clear-all")).toBeVisible();
        for (const f of await contrastFailures(page, "#s-filters")) bad.push("search filters: " + f);
        // the hover state keeps it readable too
        if (sz.name === "1280") {
          await page.locator("#f-clear-all").hover();
          for (const f of await contrastFailures(page, "#s-filters")) bad.push("search filters (hover): " + f);
        }
        expect(bad, bad.join("\n")).toEqual([]);
      });
    }
  });
}
