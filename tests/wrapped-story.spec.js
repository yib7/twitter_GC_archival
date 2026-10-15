const { test, expect } = require("@playwright/test");
const { bootViewer, conv, collectErrors } = require("./_viewer-fixture.js");

// SP10 / UX-23: Wrapped as a story — accent-derived colours in every theme,
// tap zones, swipe, hold-to-pause, segmented progress, polite slide
// announcements and keys that never steal from a focused control. Synthetic
// data only: one 2024 chat that produces every slide kind.
const T = Date.parse("2024-05-01T15:00:00Z");
const LIST = (() => {
  const out = [];
  for (let k = 0; k < 30; k++) {
    const m = { i: "w" + k, s: ["u1", "u2", "u3"][k % 3], t: T + k * 3600000, x: "pizza night " + k + " 🎉 with friends" };
    if (k % 5 === 0) m.r = [{ s: "u2", k: "funny" }, { s: "u3", k: "like" }];
    out.push(m);
  }
  out.push({ i: "p1", s: "u1", t: T + 40 * 3600000, x: "", m: "sample_media/photo-1.svg", k: "img" });
  return out;
})();
const DATA = { conversations: [conv("A", "Alpha", LIST)] };
const go = (page, v) => page.locator('.nav-item[data-view="' + v + '"]').click();
const slideNo = (page) => page.locator("#wr-segs .wr-seg.cur").evaluate((s) => [...s.parentNode.children].indexOf(s) + 1);
const slideCount = (page) => page.locator("#wr-segs .wr-seg").count();

// Every colour stop of the slide wash and of the big year's gradient text.
async function washColours(page) {
  return page.evaluate(() => {
    const out = [];
    const grab = (s) => (s.match(/(rgba?\([^)]*\)|color\([^)]*\))/g) || []).forEach((c) => out.push(c));
    grab(getComputedStyle(document.getElementById("wr-slide")).backgroundImage);
    const yr = document.querySelector(".wr-big-year");
    if (yr) grab(getComputedStyle(yr).backgroundImage);
    return out;
  });
}
const rgb = (c) => {
  const a = c.match(/[\d.]+(e-?\d+)?/g).map(Number), k = /^color\(srgb/.test(c) ? 255 : 1;
  return { r: a[0] * k, g: a[1] * k, b: a[2] * k, a: a.length > 3 ? a[3] : 1 };
};

test.describe("UX-23: Wrapped colours derive from the accent", () => {
  test("Lights-out, a pure red accent: every wash and the year are red-only (no violet / emerald / amber / pink)", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await bootViewer(page, DATA, { ls: { "gca.theme": "lightsout", "gca.settings": JSON.stringify({ accent: "#ff0000" }) } });
    await go(page, "wrapped");
    const n = await slideCount(page);
    const bad = [];
    for (let k = 0; k < n; k++) {
      if (k) await page.locator("#wr-next").click();
      for (const c of await washColours(page)) {
        const x = rgb(c);
        if (x.a < 0.02) continue;
        // red mixed with near-greys (the page, the text) only: any colour
        // with real chroma is red-dominant with green ≈ blue
        const chroma = Math.max(x.r, x.g, x.b) - Math.min(x.r, x.g, x.b);
        if (chroma > 6 && (Math.abs(x.g - x.b) > 6 || x.r < Math.max(x.g, x.b))) bad.push("slide " + (k + 1) + ": " + c);
      }
    }
    expect(bad, bad.join("\n")).toEqual([]);
  });

  for (const th of ["light", "dim", "lightsout"]) {
    test(th + ": changing the accent recolours every slide", async ({ browser }) => {
      const read = async (accent) => {
        const page = await browser.newPage();
        await page.emulateMedia({ reducedMotion: "reduce" });
        await bootViewer(page, DATA, { ls: { "gca.theme": th, "gca.settings": JSON.stringify({ accent }) } });
        await go(page, "wrapped");
        const n = await slideCount(page), all = [];
        for (let k = 0; k < n; k++) {
          if (k) await page.locator("#wr-next").click();
          all.push((await washColours(page)).join(" "));
        }
        await page.close();
        return all;
      };
      const a = await read("#1d9bf0"), b = await read("#00ba7c");
      expect(a.length).toBe(b.length);
      a.forEach((s, k) => expect(s, "slide " + (k + 1)).not.toBe(b[k]));
    });
  }
});

// M-a: SP5 leaned ranks, names, dim copy and the big numbers toward --text
// for Light and Dim; Lights-out didn't need it and keeps the pure colours.
test.describe("SP5 M-a: the Wrapped text nudges are scoped to Light and Dim", () => {
  const people = async (page) => {
    await go(page, "wrapped");
    for (let k = 0; k < 6 && !(await page.locator(".pl-name").count()); k++) await page.locator("#wr-next").click();
    return page.evaluate(() => {
      const name = document.querySelector(".pl-name"), rank = document.querySelector(".pl-rank");
      const probe = document.createElement("span"); probe.style.color = name.style.getPropertyValue("--p"); document.body.appendChild(probe);
      const p = getComputedStyle(probe).color; probe.remove();
      const root = getComputedStyle(document.documentElement), slide = getComputedStyle(document.getElementById("wr-slide"));
      return { name: getComputedStyle(name).color, p, rank: getComputedStyle(rank).color,
        dimRoot: root.getPropertyValue("--text-dim").trim(), dimSlide: slide.getPropertyValue("--text-dim").trim() };
    });
  };
  test("Lights-out: person colour, 55% ranks; dim copy leans only 20%", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await bootViewer(page, DATA, { ls: { "gca.theme": "lightsout" } });
    const r = await people(page);
    expect(r.name).toBe(r.p);
    expect(rgb(r.rank).a).toBeCloseTo(0.55, 2);
    expect(r.dimSlide).toMatch(/ 20%/);
  });
  for (const th of ["light", "dim"]) {
    test(th + ": names, ranks and dim text lean toward --text", async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await bootViewer(page, DATA, { ls: { "gca.theme": th } });
      const r = await people(page);
      expect(r.name).not.toBe(r.p);
      expect(rgb(r.rank).a).toBeCloseTo(0.75, 2);
      expect(r.dimSlide).toMatch(/ 45%/);
    });
  }
});

module.exports = { DATA, slideNo, slideCount, collectErrors };
