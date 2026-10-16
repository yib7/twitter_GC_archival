const { test, expect } = require("@playwright/test");
const { bootViewer, conv, msgs } = require("./_viewer-fixture.js");

// The native parts of a few controls (the date fields' calendar icon and
// picker, the sort and Battles drop-down lists) follow the theme: they were
// forced to color-scheme: dark, so on Light the calendar icon was faint and
// the lists opened dark. Synthetic data only.
const DATA = { conversations: [conv("A", "Alpha", msgs("a", 8, { s: ["u1", "u2"] }))] };
const CONTROLS = ["#f-from", "#f-to", "#f-sort", "#battle-p1", "#battle-p2"];

for (const th of ["lightsout", "dim", "light"]) {
  for (const vp of [{ width: 1280, height: 900 }, { width: 375, height: 812 }]) {
    test(`native control parts follow the ${th} theme at ${vp.width}`, async ({ page }) => {
      await page.setViewportSize(vp);
      await bootViewer(page, DATA, { ls: { "gca.theme": th } });
      const read = (ids) => page.evaluate((list) => list.map((s) => { const e = document.querySelector(s); return e ? getComputedStyle(e).colorScheme : "missing"; }), ids);
      await expect(page.locator("#f-sort")).toBeAttached();
      const got = await read(CONTROLS.slice(0, 3));
      if (vp.width < 760) { await page.locator("#tab-more").click(); await page.locator('#more-sheet .sh-item[data-tab="battles"]').click(); }
      else await page.locator('.nav-item[data-view="battles"]').click();
      await expect(page.locator("#battle-p1")).toBeAttached();
      got.push(...await read(CONTROLS.slice(3)));
      const want = th === "light" ? "light" : "dark";
      expect(got).toEqual(CONTROLS.map(() => want));
    });
  }
}
