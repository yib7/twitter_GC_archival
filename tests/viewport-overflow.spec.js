const { test, expect } = require("@playwright/test");
const { bootViewer, conv, viewReady } = require("./_viewer-fixture.js");

// mobile-390.spec.js sweeps every view for horizontal overflow at 390 only.
// The same sweep at a 375×812 phone and a 768 touch tablet (just above the
// 760px phone breakpoint, so the sidebar layout with a narrow column), plus
// the overlays (palette, calendar, lightbox, context peek, share dialog, and
// on the phone the filter sheet and the More sheet), plus a hit test of each
// bottom tab-bar button at 375. Synthetic data only.
const RICH = (() => {
  const out = [];
  const t = Date.parse("2024-05-01T15:00:00Z");
  for (let k = 0; k < 40; k++) {
    const m = { i: "r" + k, s: ["u1", "u2", "u3"][k % 3], t: t + k * 60000 + (k > 20 ? 40 * 86400000 : 0), x: "volley number " + k + " about pizza and movies tonight https://example.test/" + k };
    if (k % 7 === 0) m.r = [{ s: "u3", k: "funny" }, { s: "u1", k: "like" }];
    out.push(m);
  }
  out.push({ i: "p1", s: "u3", t: t + 50 * 60000, x: "", m: "sample/photo-1.svg", k: "img", r: [{ s: "u1", k: "funny" }] });
  out.push({ i: "p2", s: "u1", t: t + 51 * 60000, x: "a pic", m: "sample/photo-2.svg", k: "img" });
  return out;
})();
const DATA = { conversations: [conv("A", "Alpha", RICH)] };
const VIEWS = ["search", "timeline", "gallery", "pins", "hof", "wrapped", "capsule", "stats", "threads", "chains", "battles", "people", "settings"];
const SIZES = [
  { name: "375", phone: true, use: { viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true } },
  { name: "768", phone: false, use: { viewport: { width: 768, height: 1024 }, hasTouch: true, isMobile: true } },
];

// Elements (under `root`) whose box sticks out past the viewport or past the
// scroll container that holds them (content cut off = unreachable). Text in
// an element that truncates with an ellipsis is fine, and so are the strips
// that scroll sideways on purpose (STRIPS), as in mobile-390.spec.js.
const STRIPS = ".chart-container, .wr-stage, .tl-scroll-x, .hscroll";
async function overflowers(page, root) {
  return page.evaluate(([strips, sel]) => {
    const W = document.documentElement.clientWidth, out = [];
    const r0 = document.querySelector(sel);
    const clipper = (e) => {
      for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) {
        if (getComputedStyle(p).overflowX !== "visible") return p;
      }
      return null;
    };
    for (const e of [r0].concat([...r0.querySelectorAll("*")])) {
      const r = e.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const cs = getComputedStyle(e);
      if (cs.visibility === "hidden") continue;
      if (sel === "#app" && cs.position === "fixed") continue;   // overlays are swept on their own
      if (e.closest(strips) || e.closest("[aria-hidden=true]")) continue;
      const c = e === r0 ? null : clipper(e);
      const right = Math.min(W, c ? c.getBoundingClientRect().right : W);
      const left = Math.max(0, c ? c.getBoundingClientRect().left : 0);
      if (c && getComputedStyle(c).textOverflow === "ellipsis") continue;
      if (r.right > right + 1 || r.left < left - 1) {
        out.push(e.tagName.toLowerCase() + (e.id ? "#" + e.id : "") + "." + String(e.className).trim().split(/\s+/).join(".") + " → " + Math.round(r.left) + ".." + Math.round(r.right));
      }
    }
    return { doc: document.documentElement.scrollWidth, W, out: out.slice(0, 8) };
  }, [STRIPS, root]);
}
const go = (page, v) => page.evaluate((name) => document.querySelector('.nav-item[data-view="' + name + '"]').click(), v);

for (const sz of SIZES) {
  test.describe("nothing overflows " + sz.name + "px", () => {
    test.use(sz.use);

    for (const theme of ["lightsout", "dim", "light"]) {
      test("every view, " + theme, async ({ page }) => {
        await bootViewer(page, DATA, { ls: { "gca.theme": theme } });
        const bad = [];
        for (const v of VIEWS) {
          await go(page, v);
          await viewReady(page, v);
          const r = await overflowers(page, "#app");
          if (r.doc > r.W || r.out.length) bad.push(v + " (scrollWidth " + r.doc + "): " + r.out.join(" | "));
        }
        expect(bad, bad.join("\n")).toEqual([]);
      });
    }

    test("the overlays", async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await bootViewer(page, DATA);
      const bad = [];
      const check = async (name, sel) => {
        await expect(page.locator(sel).first(), name).toBeVisible();
        const r = await overflowers(page, sel);
        if (r.doc > r.W || r.out.length) bad.push(name + " (scrollWidth " + r.doc + "): " + r.out.join(" | "));
      };
      const close = async (sel) => { await page.keyboard.press("Escape"); await expect(page.locator(sel)).toHaveCount(0); };
      // command palette, then the calendar from it
      await page.keyboard.press("Control+k");
      await page.locator(".cmdk-input").fill("volley");
      await check("palette", ".cmdk");
      await page.locator(".cmdk-input").fill("calendar");
      await page.locator(".cmdk-row", { hasText: "calendar" }).first().click();
      await check("calendar", ".cal-modal");
      await close(".cal-modal");
      // context peek and share dialog, through a timeline message's ⋯ actions
      await go(page, "timeline");
      await viewReady(page, "timeline");
      const msg = page.locator("#tl-list .msg", { hasText: "volley number 3 " }).first();
      await msg.getByRole("button", { name: "Message actions" }).tap();
      await msg.getByRole("button", { name: "Context" }).tap();
      await check("context peek", ".ctx-modal");
      await close(".ctx-modal");
      await msg.getByRole("button", { name: "Message actions" }).tap();
      await msg.getByRole("button", { name: "Share" }).tap();
      await expect(page.locator(".share-modal canvas")).toBeVisible();
      await check("share dialog", ".share-modal");
      await close(".share-modal");
      // lightbox
      await go(page, "gallery");
      await viewReady(page, "gallery");
      await page.locator("#gal-list > *").first().click();
      await check("lightbox", ".lightbox");
      await close(".lightbox");
      if (sz.phone) {
        await go(page, "search");
        await viewReady(page, "search");
        await page.getByRole("button", { name: /^Filters/ }).tap();
        await check("filter sheet", "#s-filters");
        await page.keyboard.press("Escape");
        await expect(page.locator("#s-filters")).toBeHidden();
        await page.locator("#tab-more").tap();
        await check("More sheet", "#more-sheet");
      }
      expect(bad, bad.join("\n")).toEqual([]);
    });

    if (sz.phone) {
      test("each bottom tab-bar button receives a tap at its centre", async ({ page }) => {
        await bootViewer(page, DATA);
        const tabs = page.locator(".tabbar button");
        expect(await tabs.count()).toBeGreaterThanOrEqual(5);
        for (const v of ["search", "timeline", "gallery", "stats"]) {
          await go(page, v);
          await viewReady(page, v);
          const r = await tabs.evaluateAll((bs) => bs.map((b) => {
            const x = b.getBoundingClientRect(), hit = document.elementFromPoint(x.left + x.width / 2, x.top + x.height / 2);
            return { tab: b.id || b.dataset.tab, ok: !!hit && hit.closest("button") === b, inView: x.left >= 0 && x.right <= innerWidth && x.bottom <= innerHeight };
          }));
          for (const t of r) {
            expect(t.ok, v + ": " + t.tab + " is what a tap at its centre hits").toBe(true);
            expect(t.inView, v + ": " + t.tab + " on screen").toBe(true);
          }
        }
        // and a real tap on each one does its job
        await page.locator('.tabbar .tab[data-tab="timeline"]').tap();
        await viewReady(page, "timeline");
        await page.locator("#tab-more").tap();
        await expect(page.locator("#more-sheet")).toBeVisible();
      });
    }
  });
}

// The sweeps above skip anything inside [aria-hidden=true], and the sparklines'
// SVGs are decorative, so a dot half cut by its own SVG's edge went unseen.
// Every circle in every SVG on screen, aria-hidden ones included, lies inside
// its SVG (stroke included): the sidebar sparkline and the Stats hero's.
for (const w of [1280, 768, 375]) {
  test("no dot is cut by its SVG's edge at " + w + "px", async ({ page }) => {
    await page.setViewportSize({ width: w, height: w > 760 ? 900 : 812 });
    await bootViewer(page, DATA);
    await go(page, "stats");
    await viewReady(page, "stats");
    const r = await page.evaluate(() => {
      const out = [], seen = [];
      for (const svg of document.querySelectorAll("#app svg")) {
        const b = svg.getBoundingClientRect();
        if (!b.width || !b.height) continue;
        for (const c of svg.querySelectorAll("circle, ellipse")) {
          const x = c.getBoundingClientRect(), half = (parseFloat(getComputedStyle(c).strokeWidth) || 0) / 2;
          const name = (svg.parentElement.className || "svg") + " " + (c.getAttribute("cx") || "");
          seen.push(name);
          const cut = Math.max(b.left - (x.left - half), (x.right + half) - b.right, b.top - (x.top - half), (x.bottom + half) - b.bottom);
          if (cut > 0.5) out.push(name + " sticks out by " + cut.toFixed(1) + "px");
        }
      }
      return { out, seen };
    });
    expect(r.seen.length, "the sparkline dots were found: " + r.seen.join(", ")).toBeGreaterThanOrEqual(w > 760 ? 2 : 1);
    expect(r.out, r.out.join("\n")).toEqual([]);
  });
}
