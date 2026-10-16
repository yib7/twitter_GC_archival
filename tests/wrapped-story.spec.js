const { test, expect } = require("@playwright/test");
const { bootViewer, conv, collectErrors } = require("./_viewer-fixture.js");

// Wrapped as a story — accent-derived colours in every theme,
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
// one evaluate, so a slide change that rebuilds the segments between finding
// the current one and reading it can't leave a detached node behind
const slideNo = (page) => page.evaluate(() => {
  const s = document.querySelector("#wr-segs .wr-seg.cur");
  return s ? [...s.parentNode.children].indexOf(s) + 1 : 0;
});
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

test.describe("Wrapped colours derive from the accent", () => {
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

// Ranks, names, dim copy and the big numbers toward --text
// for Light and Dim; Lights-out didn't need it and keeps the pure colours.
test.describe("the Wrapped text nudges are scoped to Light and Dim", () => {
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
  await bootViewer(page, opts.data || DATA, { ls: opts.ls || {} });
  await go(page, "wrapped");
  await expect(page.locator("#wr-slide .wr-inner")).toBeVisible();
}

test.describe("story mechanics", () => {
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

  // A finger-speed swipe takes longer than the hold delay. Moving cancels the
  // hold, and a swipe that started as a hold still navigates.
  test("a slow swipe still flips the slide, whether the finger moves at once or rests first", async ({ page }) => {
    await openWrapped(page);
    const b = await stageBox(page);
    const y = b.y + b.height * 0.5;
    // moving the whole time, 450 ms from press to release
    await page.mouse.move(b.x + b.width * 0.5, y);
    await page.mouse.down();
    for (let k = 1; k <= 9; k++) { await page.mouse.move(b.x + b.width * (0.5 - 0.035 * k), y); await page.waitForTimeout(50); }
    await page.mouse.up();
    expect(await slideNo(page)).toBe(2);
    // resting 400 ms (past the hold delay) before the drag starts
    await page.mouse.move(b.x + b.width * 0.5, y);
    await page.mouse.down();
    await page.waitForTimeout(400);
    await page.mouse.move(b.x + b.width * 0.15, y, { steps: 8 });
    await page.mouse.up();
    expect(await slideNo(page)).toBe(3);
    // the same, back the other way
    await page.mouse.move(b.x + b.width * 0.3, y);
    await page.mouse.down();
    await page.waitForTimeout(400);
    await page.mouse.move(b.x + b.width * 0.75, y, { steps: 8 });
    await page.mouse.up();
    expect(await slideNo(page)).toBe(2);
  });

  test("a still press longer than the hold delay is neither a tap nor a swipe", async ({ page }) => {
    await openWrapped(page);
    const b = await stageBox(page);
    await page.mouse.move(b.x + b.width * 0.85, b.y + b.height * 0.6);
    await page.mouse.down();
    await page.waitForTimeout(600);
    await page.mouse.up();
    expect(await slideNo(page)).toBe(1);
    // a slow tremble under the 10 px slop is still a still press
    await page.mouse.down();
    await page.waitForTimeout(200);
    await page.mouse.move(b.x + b.width * 0.85 + 4, b.y + b.height * 0.6 + 3);
    await page.waitForTimeout(300);
    await page.mouse.up();
    expect(await slideNo(page)).toBe(1);
    // and a quick tap in the same spot still advances
    await page.mouse.click(b.x + b.width * 0.85, b.y + b.height * 0.6);
    expect(await slideNo(page)).toBe(2);
  });

  test("autoplay advances on its own; hold pauses it, release resumes, and a hold is not a tap", async ({ page }) => {
    await openWrapped(page, { motion: true });
    await page.addStyleTag({ content: ".wr-stage { --wr-dur: 1200ms !important; }" });
    await page.locator("#wr-next").click();    // re-arm the segment with the short duration
    await page.locator("#wr-prev").click();
    await expect(page.locator("#wr-stage")).toHaveClass(/\bwr-auto\b/);
    // 1200 ms slides: a backed-off poll can step over one, so wait for "moved
    // on" rather than for one exact slide
    await expect.poll(() => slideNo(page), { timeout: 4000 }).toBeGreaterThanOrEqual(2);
    const announced = await live(page).textContent();
    const first = await slideNo(page);
    await expect.poll(() => slideNo(page), { timeout: 4000 }).toBeGreaterThan(first);
    // auto-advance doesn't re-announce every slide (the user isn't driving)
    expect(await live(page).textContent()).toBe(announced);

    const b = await stageBox(page);
    await page.mouse.move(b.x + b.width * 0.85, b.y + b.height * 0.6);
    await page.mouse.down();
    await expect(page.locator("#wr-stage")).toHaveClass(/\bwr-paused\b/);
    const held = await slideNo(page);
    // the press can land at any point in the 1200 ms segment; rewind the
    // paused fill so the release below always has a whole segment ahead of
    // it, instead of a few ms that a slow machine spends before the check
    await page.evaluate(() => {
      for (const a of document.querySelector("#wr-stage .wr-seg.cur i").getAnimations()) a.currentTime = 0;
    });
    await page.waitForTimeout(1800);           // longer than a slide
    expect(await slideNo(page)).toBe(held);
    await page.mouse.up();                     // in the "next" third, but it was a hold
    expect(await slideNo(page)).toBe(held);
    await expect(page.locator("#wr-stage")).not.toHaveClass(/\bwr-paused\b/);
    await expect.poll(() => slideNo(page), { timeout: 4000 }).toBeGreaterThan(held);
  });

  // Autoplay is playing (an 8 s slide, so it can't advance on its own here).
  // A press that moves past the slop at once and then rests longer than the
  // hold delay is a drag, not a hold: the story must not pause mid-drag.
  test("autoplay: a drag that moves cancels the hold, so the swipe navigates and autoplay keeps running", async ({ page }) => {
    await openWrapped(page, { motion: true });
    const stage = page.locator("#wr-stage");
    await expect(stage).toHaveClass(/\bwr-auto\b/);
    await expect(stage).not.toHaveClass(/\bwr-paused\b/);
    const b = await stageBox(page);
    const y = b.y + b.height * 0.5;
    await page.mouse.move(b.x + b.width * 0.5, y);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width * 0.4, y);   // well past the 10 px slop, at once
    await page.waitForTimeout(400);                    // then still, past the hold delay
    await expect(stage).not.toHaveClass(/\bwr-paused\b/);
    await page.mouse.move(b.x + b.width * 0.15, y, { steps: 4 });
    await page.mouse.up();
    expect(await slideNo(page)).toBe(2);
    await expect(stage).not.toHaveClass(/\bwr-paused\b/);
    await expect(page.locator("#wr-play")).toHaveAccessibleName(/Pause/);
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

  // Every dialog pauses the story, not just Share: a slide must not change
  // under an open profile, and focus must come back to its opener.
  test("autoplay waits behind a profile opened from a slide, then resumes with focus back on its opener", async ({ page }) => {
    await openWrapped(page, { motion: true });
    await page.addStyleTag({ content: ".wr-stage { --wr-dur: 1500ms !important; }" });
    const btn = page.locator("#wr-play");
    await btn.click();                          // paused while we walk to a ranking slide
    for (let k = 0; k < 6 && !(await page.locator("#wr-slide .pl-row .av").count()); k++) await page.locator("#wr-next").click();
    const at = await slideNo(page);
    await btn.click();                          // playing again, with a fresh 1.5 s segment
    await expect(btn).toHaveAccessibleName(/Pause/);
    await page.locator("#wr-slide .pl-row .av").first().click();
    await expect(page.locator(".profile-modal")).toBeVisible();
    await expect(page.locator("#wr-stage")).toHaveClass(/\bwr-paused\b/);
    await page.waitForTimeout(2200);            // longer than a slide
    expect(await slideNo(page)).toBe(at);
    // closed with the mouse: (Escape would hand keyboard focus back to the
    // story, and keyboard focus on the story is its own pause reason)
    await page.locator(".profile-card-close").click();
    await expect(page.locator(".profile-modal")).toHaveCount(0);
    // the avatar is not a focus stop: the press focused the story around it
    await expect(page.locator("#wr-stage")).toBeFocused();
    await expect(page.locator("#wr-stage")).not.toHaveClass(/\bwr-paused\b/);
    await expect.poll(() => slideNo(page), { timeout: 4000 }).toBe(at + 1);
  });

  // Escape hands focus back to the story from the keyboard, but the user
  // opened the profile with the mouse: that is not keyboard focus on the
  // story, so autoplay resumes and the button still tells the truth.
  test("a profile opened with the mouse and closed with Escape lets autoplay resume", async ({ page }) => {
    await openWrapped(page, { motion: true });
    await page.addStyleTag({ content: ".wr-stage { --wr-dur: 1500ms !important; }" });
    const btn = page.locator("#wr-play"), stage = page.locator("#wr-stage");
    await btn.click();                          // paused while we walk to a ranking slide
    for (let k = 0; k < 6 && !(await page.locator("#wr-slide .pl-row .av").count()); k++) await page.locator("#wr-next").click();
    const at = await slideNo(page);
    await btn.click();
    await expect(btn).toHaveAccessibleName(/Pause/);
    await page.locator("#wr-slide .pl-row .av").first().click();
    await expect(page.locator(".profile-modal")).toBeVisible();
    await expect(stage).toHaveClass(/\bwr-paused\b/);
    await page.keyboard.press("Escape");
    await expect(page.locator(".profile-modal")).toHaveCount(0);
    await expect(stage).toBeFocused();
    await expect(stage).not.toHaveClass(/\bwr-paused\b/);
    await expect(btn).toHaveAccessibleName(/Pause/);
    await expect.poll(() => slideNo(page), { timeout: 4000 }).toBe(at + 1);
  });

  // Keyboard focus on the story before the dialog opened is still a pause
  // reason after it closes.
  test("a dialog opened from a keyboard-focused story keeps the story paused after Escape", async ({ page }) => {
    await openWrapped(page, { motion: true });
    const stage = page.locator("#wr-stage");
    await stage.focus();
    await page.keyboard.press("Shift+Tab"); await page.keyboard.press("Tab");
    await expect(stage).toBeFocused();
    await expect(stage).toHaveClass(/\bwr-paused\b/);
    await page.keyboard.press("?");
    await expect(page.locator(".kb-modal")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".kb-modal")).toHaveCount(0);
    await expect(stage).toBeFocused();
    await expect(stage).toHaveClass(/\bwr-paused\b/);
  });

  // A dialog that replaces one of its own kind takes over the first one's
  // opener, and with it the first one's keyboard-focus pause: by then the
  // story has lost focus to the first dialog, so it can't be read again.
  test("a profile replaced by a second profile still hands the keyboard-focus pause back", async ({ page }) => {
    await openWrapped(page, { motion: true });
    const stage = page.locator("#wr-stage"), btn = page.locator("#wr-play");
    await btn.click();                          // paused while we walk to a ranking slide
    for (let k = 0; k < 6 && !(await page.locator("#wr-slide .pl-row .av-clickable").count()); k++) await page.locator("#wr-next").click();
    await btn.click();
    await expect(btn).toHaveAccessibleName(/Pause/);
    await stage.focus();
    await page.keyboard.press("Shift+Tab"); await page.keyboard.press("Tab");
    await expect(stage).toBeFocused();
    await expect(stage).toHaveClass(/\bwr-paused\b/);
    // a script click opens the profile without moving focus first
    const openAv = (n) => page.evaluate((k) => document.querySelectorAll("#wr-slide .pl-row .av-clickable")[k].click(), n);
    await openAv(0);
    await expect(page.locator(".profile-modal")).toHaveCount(1);
    const first = await page.locator(".profile-modal").getAttribute("aria-label");
    await openAv(1);                            // a second profile replaces the first
    await expect(page.locator(".profile-modal")).toHaveCount(1);
    await expect(page.locator(".profile-modal")).not.toHaveAttribute("aria-label", first);
    await page.keyboard.press("Escape");
    await expect(page.locator(".profile-modal")).toHaveCount(0);
    await expect(stage).toBeFocused();
    await expect(stage).toHaveClass(/\bwr-paused\b/);
  });

  test("a command palette reopened over itself still hands the keyboard-focus pause back", async ({ page }) => {
    await openWrapped(page, { motion: true });
    const stage = page.locator("#wr-stage");
    await stage.focus();
    await page.keyboard.press("Shift+Tab"); await page.keyboard.press("Tab");
    await expect(stage).toBeFocused();
    await expect(stage).toHaveClass(/\bwr-paused\b/);
    await page.keyboard.press("Control+k");
    await expect(page.locator(".cmdk")).toHaveCount(1);
    await page.keyboard.press("Control+k");    // replaces the open palette
    await expect(page.locator(".cmdk")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(page.locator(".cmdk")).toHaveCount(0);
    await expect(stage).toBeFocused();
    await expect(stage).toHaveClass(/\bwr-paused\b/);
  });

  // Reads the current segment fill's own clock, so nothing here depends on how
  // long the steps between dialogs take.
  test("autoplay waits behind keyboard help and the command palette", async ({ page }) => {
    await openWrapped(page, { motion: true });
    const fill = () => page.locator("#wr-segs .wr-seg.cur i").evaluate((i) => {
      const a = i.getAnimations().find((x) => x.animationName === "wrFill");
      return a ? { t: a.currentTime, state: a.playState } : null;
    });
    for (const [open, sel] of [["?", ".kb-modal"], ["Control+k", ".cmdk"]]) {
      await page.locator("#wr-next").focus();
      await page.keyboard.press(open);
      await expect(page.locator(sel)).toBeVisible();
      await expect(page.locator("#wr-stage")).toHaveClass(/\bwr-paused\b/);
      const before = await fill();
      expect(before.state).toBe("paused");
      await page.waitForTimeout(600);
      expect(await fill()).toEqual(before);     // the fill did not move while it was open
      await page.keyboard.press("Escape");
      await expect(page.locator(sel)).toHaveCount(0);
      await expect(page.locator("#wr-stage")).not.toHaveClass(/\bwr-paused\b/);
      await expect.poll(async () => (await fill()).state).toBe("running");
    }
  });

  // Pressing the button blurs the story, and that blur must not rebuild the
  // button under the pointer (a rebuilt button never receives the click).
  test("the Pause button works right after a press on the story", async ({ page }) => {
    await openWrapped(page, { motion: true });
    const btn = page.locator("#wr-play");
    const b = await stageBox(page);
    await page.mouse.click(b.x + b.width * 0.5, b.y + b.height * 0.6);   // the middle: no navigation, but the story has focus
    await expect(page.locator("#wr-stage")).toBeFocused();
    await btn.click();
    await expect(btn).toHaveAccessibleName(/Play/);
    await page.mouse.click(b.x + b.width * 0.5, b.y + b.height * 0.6);
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

// a year change re-renders the view. The live region must be the
// one already on the page (a region inserted with its text is often not
// read), and pause reasons owned by the old stage (a hold, focus) must not
// outlive it.
const T23 = Date.parse("2023-06-01T15:00:00Z");
const DATA2 = { conversations: [conv("A", "Alpha", LIST.concat(Array.from({ length: 12 }, (_, k) => ({ i: "y" + k, s: ["u1", "u2"][k % 2], t: T23 + k * 3600000, x: "older chat " + k }))).sort((a, b) => a.t - b.t))] };
test.describe("a year change", () => {
  test("is announced in the live region that was already there", async ({ page }) => {
    await openWrapped(page, { data: DATA2 });
    const before = await live(page).elementHandle();
    await page.locator(".wr-yr", { hasText: "2023" }).click();
    await expect(live(page)).toHaveText(/^Slide 1 of \d+: 2023 Wrapped$/);
    expect(await before.evaluate((n) => n.isConnected && n.id === "wr-live"), "the same, persistent live node").toBe(true);
    expect(await page.locator("#wr-live").count()).toBe(1);
  });

  test("never leaves autoplay stuck paused by a hold or focus on the old stage", async ({ page }) => {
    await openWrapped(page, { motion: true, data: DATA2 });
    const stage = page.locator("#wr-stage");
    const yr = (y) => page.evaluate((t) => [...document.querySelectorAll(".wr-yr")].find((b) => b.textContent === t).click(), y);
    // a press-and-hold, then the view re-renders under the finger
    const b = await stageBox(page);
    await page.mouse.move(b.x + b.width * 0.5, b.y + b.height * 0.6);
    await page.mouse.down();
    await expect(stage).toHaveClass(/\bwr-paused\b/);
    await yr("2023");
    await page.mouse.up();
    await expect(stage).toHaveClass(/\bwr-auto\b/);
    await expect(stage).not.toHaveClass(/\bwr-paused\b/);
    // keyboard focus on the story pauses it; the stage is replaced while focused
    await stage.focus();
    await page.keyboard.press("Shift+Tab"); await page.keyboard.press("Tab");
    await expect(stage).toHaveClass(/\bwr-paused\b/);
    await yr("2024");
    await expect(stage).not.toHaveClass(/\bwr-paused\b/);
  });
});

test.describe("story mechanics at 390px (touch)", () => {
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
