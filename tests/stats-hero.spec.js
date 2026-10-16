const { test, expect } = require("@playwright/test");
const { bootViewer, msgs, conv } = require("./_viewer-fixture.js");
const { contrastFailures } = require("./_contrast.js");

// The Stats hero leans its secondary text (the date line, the small labels and
// the sparkline caption) toward --text, because its accent-tinted surface is
// lighter / more colored than a plain card. That override used to read itself
// (--text-dim: color-mix(…, var(--text-dim))), which is a custom-property cycle:
// the value became invalid, so the "dimmed" text silently rendered at full
// --text. The theme's own value is now captured on an ancestor first, the same
// way the Wrapped stage does it, and the dimmed text must still reach contrast
// on the hero in every theme, on desktop and at 390px.
const DATA = { conversations: [conv("A", "Alpha", msgs("h", 60, { s: ["u1", "u2", "u3"], step: 9 * 3600000 }))] };

for (const vp of [{ name: "desktop", viewport: { width: 1280, height: 900 } }, { name: "390px", viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }]) {
  test.describe("Stats hero secondary text · " + vp.name, () => {
    test.use({ viewport: vp.viewport, hasTouch: !!vp.hasTouch, isMobile: !!vp.isMobile });
    for (const th of ["lightsout", "dim", "light"]) {
      test(th + ": dimmed (not full --text) and still readable", async ({ page }) => {
        await page.emulateMedia({ reducedMotion: "reduce" });
        await bootViewer(page, DATA, { ls: { "gca.theme": th, "gca.lastView": "stats" } });
        await expect(page.locator("#view-stats .hero .h-sub")).toBeVisible();
        const c = await page.evaluate(() => {
          const hero = document.querySelector("#view-stats .hero");
          const col = (sel) => getComputedStyle(hero.querySelector(sel)).color;
          return {
            text: getComputedStyle(hero).color,
            sub: col(".h-sub"), label: col(".h-inline .l"),
            dimVar: getComputedStyle(hero).getPropertyValue("--text-dim").trim(),
            faintVar: getComputedStyle(hero).getPropertyValue("--text-faint").trim(),
          };
        });
        // a cyclic custom property computes to nothing (guaranteed-invalid)
        expect(c.dimVar, "--text-dim on .hero").not.toBe("");
        expect(c.faintVar, "--text-faint on .hero").not.toBe("");
        expect(c.sub, ".h-sub must be dimmed, not full --text").not.toBe(c.text);
        expect(c.label, ".h-inline .l must be dimmed, not full --text").not.toBe(c.text);
        const bad = await contrastFailures(page, "#view-stats .hero");
        expect(bad, bad.join("\n")).toEqual([]);
      });
    }
  });
}
