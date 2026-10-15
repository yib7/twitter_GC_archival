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
// (a script click: the sidebar is hidden at 390px)
const go = (page, v) => page.evaluate((name) => document.querySelector('.nav-item[data-view="' + name + '"]').click(), v);
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

/* ---- Story mechanics ------------------------------------------------------ */
const stageBox = (page) => page.locator("#wr-stage").boundingBox();
const live = (page) => page.locator("#wr-live");
// Open Wrapped with autoplay off (reduced motion) unless `motion` is set.
async function openWrapped(page, opts = {}) {
  if (!opts.motion) await page.emulateMedia({ reducedMotion: "reduce" });
  await bootViewer(page, DATA, { ls: opts.ls || {} });
  await go(page, "wrapped");
  await expect(page.locator("#wr-slide .wr-inner")).toBeVisible();
}

test.describe("UX-23: story mechanics", () => {
  test("segmented progress replaces the dots: one segment per slide, none of them a control", async ({ page }) => {
    await openWrapped(page);
    await expect(page.locator(".wr-dot, #wr-dots")).toHaveCount(0);
    const n = await slideCount(page);
    expect(n).toBe(9);
    await expect(page.locator("#wr-segs")).toHaveAttribute("aria-hidden", "true");
    expect(await page.locator("#wr-segs button, #wr-segs [tabindex]").count()).toBe(0);
    await page.locator("#wr-next").click();
    await expect(page.locator("#wr-segs .wr-seg.done")).toHaveCount(1);
    expect(await slideNo(page)).toBe(2);
  });

  test("tap the right third for next, the left third for back; the middle does nothing", async ({ page }) => {
    const errors = collectErrors(page);
    await openWrapped(page);
    const b = await stageBox(page);
    const y = b.y + b.height * 0.6;
    await page.mouse.click(b.x + b.width * 0.85, y);
    expect(await slideNo(page)).toBe(2);
    await page.mouse.click(b.x + b.width * 0.85, y);
    expect(await slideNo(page)).toBe(3);
    await page.mouse.click(b.x + b.width * 0.5, y);
    expect(await slideNo(page)).toBe(3);
    await page.mouse.click(b.x + b.width * 0.1, y);
    expect(await slideNo(page)).toBe(2);
    expect(errors).toEqual([]);
  });

  test("a click on something inside the slide (an avatar) is not a tap", async ({ page }) => {
    await openWrapped(page);
    for (let k = 0; k < 6 && !(await page.locator("#wr-slide .pl-row .av").count()); k++) await page.locator("#wr-next").click();
    const at = await slideNo(page);
    const av = page.locator("#wr-slide .pl-row .av").first();
    const r = await av.boundingBox();
    const b = await stageBox(page);
    expect(r.x).toBeLessThan(b.x + b.width / 3);      // in the "back" third
    await av.click();
    await expect(page.locator(".profile-modal")).toBeVisible();
    await page.keyboard.press("Escape");
    expect(await slideNo(page)).toBe(at);
  });

  test("swipe left for next, right for back (mouse drag and touch alike)", async ({ page }) => {
    await openWrapped(page);
    const b = await stageBox(page);
    const y = b.y + b.height * 0.5;
    const drag = async (x0, x1) => { await page.mouse.move(x0, y); await page.mouse.down(); await page.mouse.move((x0 + x1) / 2, y, { steps: 4 }); await page.mouse.move(x1, y, { steps: 4 }); await page.mouse.up(); };
    await drag(b.x + b.width * 0.5, b.x + b.width * 0.15);
    expect(await slideNo(page)).toBe(2);
    await drag(b.x + b.width * 0.5, b.x + b.width * 0.15);
    expect(await slideNo(page)).toBe(3);
    await drag(b.x + b.width * 0.3, b.x + b.width * 0.75);
    expect(await slideNo(page)).toBe(2);
  });

  test("autoplay advances on its own; hold pauses it, release resumes, and a hold is not a tap", async ({ page }) => {
    await openWrapped(page, { motion: true });
    await page.addStyleTag({ content: ".wr-stage { --wr-dur: 1200ms !important; }" });
    await page.locator("#wr-next").click();    // re-arm the segment with the short duration
    await page.locator("#wr-prev").click();
    await expect(page.locator("#wr-stage")).toHaveClass(/\bwr-auto\b/);
    await expect.poll(() => slideNo(page), { timeout: 4000 }).toBe(2);
    const announced = await live(page).textContent();
    await expect.poll(() => slideNo(page), { timeout: 4000 }).toBe(3);
    // auto-advance doesn't re-announce every slide (the user isn't driving)
    expect(await live(page).textContent()).toBe(announced);

    const b = await stageBox(page);
    await page.mouse.move(b.x + b.width * 0.85, b.y + b.height * 0.6);
    await page.mouse.down();
    await expect(page.locator("#wr-stage")).toHaveClass(/\bwr-paused\b/);
    const held = await slideNo(page);
    await page.waitForTimeout(1800);           // longer than a slide
    expect(await slideNo(page)).toBe(held);
    await page.mouse.up();                     // in the "next" third, but it was a hold
    expect(await slideNo(page)).toBe(held);
    await expect(page.locator("#wr-stage")).not.toHaveClass(/\bwr-paused\b/);
    await expect.poll(() => slideNo(page), { timeout: 4000 }).toBe(held + 1);
  });

  test("the Pause button stops autoplay and says so; Play resumes", async ({ page }) => {
    await openWrapped(page, { motion: true });
    await page.addStyleTag({ content: ".wr-stage { --wr-dur: 800ms !important; }" });
    const btn = page.locator("#wr-play");
    await expect(btn).toHaveAccessibleName(/Pause/);
    await btn.click();
    await expect(btn).toHaveAccessibleName(/Play/);
    await expect(page.locator("#wr-stage")).toHaveClass(/\bwr-paused\b/);
    const at = await slideNo(page);
    await page.waitForTimeout(1500);
    expect(await slideNo(page)).toBe(at);
    await btn.click();
    await expect(btn).toHaveAccessibleName(/Pause/);
  });

  test("reduced motion: no autoplay and no Pause button, manual advance still works", async ({ page }) => {
    await openWrapped(page);
    await page.addStyleTag({ content: ".wr-stage { --wr-dur: 300ms !important; }" });
    await expect(page.locator("#wr-stage")).not.toHaveClass(/\bwr-auto\b/);
    await expect(page.locator("#wr-play")).toBeHidden();
    await page.waitForTimeout(900);
    expect(await slideNo(page)).toBe(1);
    await page.locator("#wr-next").click();
    expect(await slideNo(page)).toBe(2);
  });

  test("a manual change is announced politely: “Slide 2 of 9: …”", async ({ page }) => {
    await openWrapped(page);
    await expect(live(page)).toHaveAttribute("aria-live", "polite");
    await page.locator("#wr-next").click();
    await expect(live(page)).toHaveText(/^Slide 2 of 9: .*messages sent in 2024/);
    await page.locator("#wr-stage").focus();
    await page.keyboard.press("ArrowRight");
    await expect(live(page)).toHaveText(/^Slide 3 of 9: /);
  });

  test("keys: ← → and Space move the story, but never while a control in Wrapped has focus", async ({ page }) => {
    await openWrapped(page);
    // right after opening from the sidebar (its nav button has focus)
    await page.keyboard.press("ArrowRight");
    expect(await slideNo(page)).toBe(2);
    // a focused year chip keeps its arrows (and Space is the chip's own)
    await page.locator(".wr-yr").first().focus();
    await page.keyboard.press("ArrowRight");
    expect(await slideNo(page)).toBe(2);
    // so does a focused Back / Next button (Space activates it, once)
    await page.locator("#wr-next").focus();
    await page.keyboard.press("ArrowLeft");
    expect(await slideNo(page)).toBe(2);
    await page.keyboard.press("Space");
    expect(await slideNo(page)).toBe(3);
    // the story itself is a focus stop that takes all three keys
    const stage = page.locator("#wr-stage");
    await stage.focus();
    await page.keyboard.press("ArrowRight");
    expect(await slideNo(page)).toBe(4);
    await page.keyboard.press("Space");
    expect(await slideNo(page)).toBe(5);
    await page.keyboard.press("ArrowLeft");
    expect(await slideNo(page)).toBe(4);
  });
});

test.describe("UX-23: story mechanics at 390px (touch)", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test("the progress fits on one line inside the stage; taps move the story", async ({ page }) => {
    await openWrapped(page);
    const segs = await page.locator("#wr-segs .wr-seg").evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return [r.left, r.right, r.top, r.width]; }));
    const b = await stageBox(page);
    expect(segs.length).toBe(9);
    for (const [l, r, t, w] of segs) {
      expect(l).toBeGreaterThanOrEqual(b.x);
      expect(r).toBeLessThanOrEqual(b.x + b.width);
      expect(Math.abs(t - segs[0][2])).toBeLessThan(1);
      expect(w).toBeGreaterThan(8);
    }
    await page.touchscreen.tap(b.x + b.width * 0.9, b.y + b.height * 0.6);
    expect(await slideNo(page)).toBe(2);
    await page.touchscreen.tap(b.x + b.width * 0.1, b.y + b.height * 0.6);
    expect(await slideNo(page)).toBe(1);
  });
});
