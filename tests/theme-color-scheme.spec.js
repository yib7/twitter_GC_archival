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

// ...and so does every other native control, not only the ones that forced a
// scheme: the group-chat drop-down (sidebar and phone), the Settings time zone
// list, font slider, custom accent picker and filter box, the Search fields.
// The root carries it too, which gives the scrollbars the theme's lightness.
const TWO = { conversations: [conv("A", "Alpha", msgs("a", 8, { s: ["u1", "u2"] })), conv("B", "Beta", msgs("b", 8, { s: ["u1", "u2"] }))] };
const SETTINGS_ONLY = ["#conv-select", "#mobile-conv", "#set-tz", "#set-font", "#set-accent-custom", "#set-tz-filter"];
for (const th of ["lightsout", "dim", "light"]) {
  for (const vp of [{ width: 1280, height: 900 }, { width: 375, height: 812 }]) {
    test(`every native control follows the ${th} theme at ${vp.width}`, async ({ page }) => {
      await page.setViewportSize(vp);
      await bootViewer(page, TWO, { ls: { "gca.theme": th } });
      const want = th === "light" ? "light" : "dark";
      const scheme = (sel) => page.evaluate((s) => { const e = document.querySelector(s); return e ? getComputedStyle(e).colorScheme : "missing"; }, sel);
      const allFields = () => page.evaluate(() => [...document.querySelectorAll("#app select, #app input, #app textarea")]
        .map((e) => (e.id || e.tagName.toLowerCase() + "." + e.className) + "=" + getComputedStyle(e).colorScheme));
      expect(await scheme("html"), "root").toBe(want);
      const wrong = [];
      const check = async (label) => { for (const f of await allFields()) if (!f.endsWith("=" + want)) wrong.push(label + ": " + f); };
      await expect(page.locator("#f-sort")).toBeAttached();
      await check("search");
      if (vp.width < 760) { await page.locator("#tab-more").click(); await page.locator('#more-sheet .sh-item[data-tab="settings"]').click(); }
      else await page.locator('.nav-item[data-view="settings"]').click();
      await expect(page.locator("#set-tz")).toBeAttached();
      await check("settings");
      for (const id of SETTINGS_ONLY) expect(await scheme(id), id).toBe(want);
      expect(wrong, wrong.join("\n")).toEqual([]);
    });
  }
  test(`the setup wizard's fields follow the ${th} theme`, async ({ page }) => {
    await page.addInitScript((t) => { try { localStorage.setItem("gca.theme", t); } catch (e) { /* blocked */ } }, th);
    await page.route("**/api/status", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ built: false, groups: [], ignoredGroups: [] }) }));
    await page.goto("/setup.html");
    await expect(page.locator("#src-root")).toBeAttached();
    const want = th === "light" ? "light" : "dark";
    const got = await page.evaluate(() => ["html", "#src-root", "#gc-group", "#reset-confirm"].map((s) => { const e = document.querySelector(s); return e ? getComputedStyle(e).colorScheme : "missing"; }));
    expect(got).toEqual([want, want, want, want]);
  });
}
