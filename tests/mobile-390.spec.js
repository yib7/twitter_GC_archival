const { test, expect } = require("@playwright/test");
const { bootViewer, conv } = require("./_viewer-fixture.js");

// SP5 mobile checkpoint at 390px with a touch (coarse) pointer: UX-1 touch
// actions, UX-5 / UX-34 / UX-36 no horizontal overflow, UX-18 44px targets,
// UX-19 search filters sheet + no autofocus, UX-35 capsule height.
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

const T = Date.parse("2024-03-10T12:00:00Z");
const LIST = [
  { i: "m0", s: "u1", t: T, x: "hello there, see https://example.test/a" },
  { i: "m1", s: "u2", t: T + 60000, x: "a photo", m: "sample_media/photo-1.svg", k: "img", r: [{ s: "u1", k: "funny" }] },
  { i: "m2", s: "u3", t: T + 120000, x: "third message" },
  { i: "m3", s: "u1", t: T + 86400000, x: "next day hello" },
  { i: "m4", s: "u2", t: T + 86400000 + 60000, x: "another photo", m: "sample_media/photo-2.svg", k: "img" },
  { i: "m5", s: "u3", t: T + 86400000 + 120000, x: "the last word" },
];
const DATA = { conversations: [conv("A", "Alpha", LIST)] };
const view = (page) => page.evaluate(() => document.querySelector(".nav-item[aria-current=page]").dataset.view);

test.describe("UX-1: touch users reach message actions through a ⋯ button", () => {
  test("tapping ⋯ on a search result opens its actions without navigating; an action closes them", async ({ page }) => {
    await bootViewer(page, DATA);
    const card = page.locator("#s-list .msg").first();
    const more = card.getByRole("button", { name: "Message actions" });
    await expect(more).toBeVisible();
    await expect(more).toHaveAttribute("aria-expanded", "false");
    await more.tap();
    expect(await view(page)).toBe("search");
    await expect(more).toHaveAttribute("aria-expanded", "true");
    const acts = card.locator(".msg-acts");
    await expect(acts).toBeVisible();
    await acts.getByRole("button", { name: "Bookmark" }).tap();
    await expect(page.locator(".toast")).toContainText("Bookmarked");
    await expect(acts).toBeHidden();
    await expect(more).toHaveAttribute("aria-expanded", "false");
    expect(await view(page)).toBe("search");
  });

  test("in the timeline, ⋯ opens the actions; tapping elsewhere closes them", async ({ page }) => {
    await bootViewer(page, DATA, { ls: { "gca.lastView": "timeline" } });
    const msg = page.locator("#tl-list .msg").nth(1);
    await msg.getByRole("button", { name: "Message actions" }).tap();
    await expect(msg.locator(".msg-acts")).toBeVisible();
    // every action is a 44px touch target
    const sizes = await msg.locator(".msg-acts button").evaluateAll((bs) => bs.map((b) => { const r = b.getBoundingClientRect(); return [r.width, r.height]; }));
    for (const [w, h] of sizes) { expect(w).toBeGreaterThanOrEqual(44); expect(h).toBeGreaterThanOrEqual(44); }
    // the open toolbar stays inside the 390px viewport
    const box = await msg.locator(".msg-acts").boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    await page.locator(".mobile-topbar .nm").tap();
    await expect(msg.locator(".msg-acts")).toBeHidden();
  });
});

test.describe("UX-17: the More sheet is a real dialog", () => {
  test("inert while closed; on open aria-modal with focus inside and trapped; Esc closes back to the More tab", async ({ page }) => {
    await bootViewer(page, DATA);
    const sheet = page.locator("#more-sheet");
    await expect(sheet).toHaveAttribute("aria-hidden", "true");
    expect(await sheet.evaluate((s) => s.inert)).toBe(true);
    // closed: none of its buttons is a Tab stop
    await page.locator("#tab-more").focus();
    for (let k = 0; k < 6; k++) {
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => !!document.activeElement.closest("#more-sheet"))).toBe(false);
    }
    await page.locator("#tab-more").tap();
    await expect(sheet).toHaveClass(/\bon\b/);
    await expect(sheet).toHaveAttribute("aria-modal", "true");
    expect(await sheet.evaluate((s) => s.inert || s.getAttribute("aria-hidden") === "true")).toBe(false);
    await expect(sheet.locator(".sh-item").first()).toBeFocused();
    for (let k = 0; k < 16; k++) {
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => !!document.activeElement.closest("#more-sheet")), "Tab " + k).toBe(true);
    }
    await page.keyboard.press("Escape");
    await expect(sheet).not.toHaveClass(/\bon\b/);
    expect(await sheet.evaluate((s) => s.inert)).toBe(true);
    await expect(page.locator("#tab-more")).toBeFocused();
    // choosing an item navigates and also closes it inert
    await page.locator("#tab-more").tap();
    await sheet.locator('.sh-item[data-tab="people"]').tap();
    expect(await sheet.evaluate((s) => s.inert)).toBe(true);
    expect(await view(page)).toBe("people");
  });
});

// A richer synthetic chat so Stats / Threads / Chains / HOF / Wrapped render real content.
const RICH = (() => {
  const out = [];
  const t = Date.parse("2024-05-01T15:00:00Z");
  for (let k = 0; k < 40; k++) {
    const m = { i: "r" + k, s: ["u1", "u2", "u3"][k % 3], t: t + k * 60000 + (k > 20 ? 40 * 86400000 : 0), x: "volley number " + k + " about pizza and movies tonight https://example.test/" + k };
    if (k % 7 === 0) m.r = [{ s: "u3", k: "funny" }, { s: "u1", k: "like" }];
    out.push(m);
  }
  out.push({ i: "p1", s: "u3", t: t + 50 * 60000, x: "", m: "sample_media/photo-1.svg", k: "img", r: [{ s: "u1", k: "funny" }] });
  out.push({ i: "p2", s: "u1", t: t + 51 * 60000, x: "a pic", m: "sample_media/photo-2.svg", k: "img" });
  return out;
})();
const RICH_DATA = { conversations: [conv("A", "Alpha", RICH)] };
const VIEWS = ["search", "timeline", "gallery", "pins", "hof", "wrapped", "capsule", "stats", "threads", "chains", "battles", "people", "settings"];

// Elements whose box sticks out past the 390px viewport or past the scroll
// container that holds them (content cut off = unreachable). Text inside an
// element that truncates with an ellipsis is fine; so are the few strips that
// scroll sideways on purpose (STRIPS).
const STRIPS = ".chart-container, .wr-stage, .tl-scroll-x, .hscroll";
async function overflowers(page) {
  return page.evaluate((strips) => {
    const W = document.documentElement.clientWidth, out = [];
    const clipper = (e) => {
      for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) {
        if (getComputedStyle(p).overflowX !== "visible") return p;
      }
      return null;
    };
    for (const e of document.querySelectorAll("#app *")) {
      const r = e.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const cs = getComputedStyle(e);
      if (cs.position === "fixed" || cs.visibility === "hidden") continue;
      if (e.closest(strips) || e.closest("[aria-hidden=true]")) continue;
      const c = clipper(e);
      const right = Math.min(W, c ? c.getBoundingClientRect().right : W);
      const left = Math.max(0, c ? c.getBoundingClientRect().left : 0);
      if (c && getComputedStyle(c).textOverflow === "ellipsis") continue;
      if (r.right > right + 1 || r.left < left - 1) {
        out.push(e.tagName.toLowerCase() + (e.id ? "#" + e.id : "") + "." + String(e.className).trim().split(/\s+/).join(".") + " → " + Math.round(r.right));
      }
    }
    return { doc: document.documentElement.scrollWidth, W, out: out.slice(0, 8) };
  }, STRIPS);
}

test.describe("UX-5 / UX-34 / UX-36: nothing overflows 390px", () => {
  for (const theme of ["lightsout", "dim", "light"]) {
    test("every view, " + theme, async ({ page }) => {
      await bootViewer(page, RICH_DATA, { ls: { "gca.theme": theme } });
      const bad = [];
      for (const v of VIEWS) {
        await page.evaluate((name) => { const b = document.querySelector('.nav-item[data-view="' + name + '"]'); b.click(); }, v);
        await page.waitForTimeout(v === "stats" ? 700 : 80);
        const r = await overflowers(page);
        if (r.doc > r.W || r.out.length) bad.push(v + " (scrollWidth " + r.doc + "): " + r.out.join(" | "));
      }
      expect(bad, bad.join("\n")).toEqual([]);
    });
  }

  test("Settings: every accent control is on screen; rows stack", async ({ page }) => {
    await bootViewer(page, RICH_DATA, { ls: { "gca.lastView": "settings" } });
    for (const sel of ["#set-accents .preset", "#set-accent-custom", "#set-shuffle"]) {
      const boxes = await page.locator(sel).evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return [r.left, r.right]; }));
      expect(boxes.length).toBeGreaterThan(0);
      for (const [l, r] of boxes) { expect(l, sel).toBeGreaterThanOrEqual(0); expect(r, sel).toBeLessThanOrEqual(390); }
    }
    const row = page.locator("#set-accents").locator("xpath=ancestor::div[contains(@class,'set-row')]");
    expect(await row.evaluate((e) => getComputedStyle(e).flexDirection)).toBe("column");
  });

  test("Stats: two-up sections collapse to one column (no inline grid templates)", async ({ page }) => {
    await bootViewer(page, RICH_DATA, { ls: { "gca.lastView": "stats" } });
    await page.waitForTimeout(700);
    const inline = await page.locator("#view-stats [style*='1fr 1fr']").count();
    expect(inline).toBe(0);
    const grids = page.locator("#view-stats .stat-grid2");
    expect(await grids.count()).toBeGreaterThan(0);
    const cols = await grids.evaluateAll((gs) => gs.map((g) => getComputedStyle(g).gridTemplateColumns.split(" ").length));
    for (const c of cols) expect(c).toBe(1);
  });
});
