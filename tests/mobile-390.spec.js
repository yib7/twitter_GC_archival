const { test, expect } = require("@playwright/test");
const { bootViewer, conv } = require("./_viewer-fixture.js");

// Mobile checkpoint at 390px with a touch (coarse) pointer: touch actions,
// no horizontal overflow, 44px targets, the search filters sheet + no
// autofocus, and the capsule height.
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

test.describe("touch users reach message actions through a ⋯ button", () => {
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

test.describe("running a toolbar action keeps keyboard focus on a touch screen", () => {
  test("⋯ → Enter → Tab → Enter on Bookmark leaves focus on the message's ⋯, not <body>", async ({ page }) => {
    await bootViewer(page, DATA, { ls: { "gca.lastView": "timeline" } });
    const msg = page.locator("#tl-list .msg").nth(1);
    const more = msg.getByRole("button", { name: "Message actions" });
    await more.focus();
    await page.keyboard.press("Enter");
    await expect(msg.locator(".msg-acts")).toBeVisible();
    // Tab until the Bookmark action has focus
    for (let k = 0; k < 6 && !(await page.evaluate(() => document.activeElement.classList.contains("act-pin"))); k++) await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement.classList.contains("act-pin"))).toBe(true);
    await page.keyboard.press("Enter");
    await expect(page.locator(".toast")).toContainText("Bookmarked");
    await expect(msg.locator(".msg-acts")).toBeHidden();
    expect(await page.evaluate(() => document.activeElement.tagName)).not.toBe("BODY");
    await expect(more).toBeFocused();
  });
});

test.describe("on your own messages the ⋯ doesn't cover the avatar", () => {
  test("the avatar on a right-aligned (me) message is still what a tap at its centre hits", async ({ page }) => {
    await bootViewer(page, DATA, { ls: { "gca.lastView": "timeline", "gca.settings": JSON.stringify({ me: "u1" }) } });
    const mine = page.locator("#tl-list .msg.me").first();
    await expect(mine).toBeVisible();
    const av = mine.locator(".av").first();
    await expect(av).toBeVisible();
    const b = await av.boundingBox();
    const hit = await page.evaluate(([x, y]) => { const h = document.elementFromPoint(x, y); return h && (h.closest(".av") ? "avatar" : h.className || h.tagName); }, [b.x + b.width / 2, b.y + b.height / 2]);
    expect(hit).toBe("avatar");
    // …and the ⋯ itself is still on screen and not over the bubble text
    const more = await mine.locator(".msg-more").boundingBox();
    expect(more.x).toBeGreaterThanOrEqual(0);
    const bub = await mine.locator(".bubble").first().boundingBox();
    expect(more.x + more.width <= bub.x || more.x >= bub.x + bub.width || more.y + more.height <= bub.y).toBe(true);
  });
});

test.describe("the More sheet is a real dialog", () => {
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

test.describe("nothing overflows 390px", () => {
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

test.describe("mobile search header is compact and doesn't grab the keyboard", () => {
  test("no autofocus on a touch screen; filters collapse into a Filters (n) bottom sheet", async ({ page }) => {
    await bootViewer(page, RICH_DATA);
    await expect(page.locator("#s-list .msg").first()).toBeVisible();
    await page.waitForTimeout(100);
    await expect(page.locator("#s-input")).not.toBeFocused();
    // the header no longer eats half the screen
    const tb = await page.locator("#view-search .toolbar").boundingBox();
    expect(tb.height).toBeLessThanOrEqual(170);
    const filters = page.locator("#s-filters");
    await expect(filters).toBeHidden();
    const tog = page.getByRole("button", { name: /^Filters/ });
    await expect(tog).toBeVisible();
    await expect(tog).toHaveAttribute("aria-expanded", "false");
    await tog.tap();
    await expect(filters).toBeVisible();
    await expect(filters).toHaveAttribute("role", "dialog");
    await expect(filters).toHaveAttribute("aria-modal", "true");
    await expect(tog).toHaveAttribute("aria-expanded", "true");
    expect(await page.evaluate(() => !!document.activeElement.closest("#s-filters"))).toBe(true);
    // the whole sheet is on screen, above the tab bar
    const fb = await filters.boundingBox();
    expect(fb.y).toBeGreaterThanOrEqual(0);
    expect(fb.y + fb.height).toBeLessThanOrEqual(844 + 1);
    expect(fb.x + fb.width).toBeLessThanOrEqual(390 + 1);
    // …and painted above the tab bar
    expect(await page.evaluate(() => { const r = document.getElementById("s-filters").getBoundingClientRect(); const hit = document.elementFromPoint(195, r.bottom - 12); return !!(hit && hit.closest("#s-filters")); })).toBe(true);
    // the match hint lives in the sheet now, not in the header
    await expect(filters.locator("#s-matchhint")).toBeVisible();
    // a filter applied in the sheet is counted on the toggle
    await filters.locator("#f-media").tap();
    await expect(filters.locator("#f-media")).toHaveClass(/active/);
    // the People popover opens inside the sheet, fully on screen
    await filters.locator("#f-people").tap();
    const pop = filters.locator(".popover");
    await expect(pop).toBeVisible();
    const pb = await pop.boundingBox();
    expect(pb.y).toBeGreaterThanOrEqual(0);
    expect(pb.y + pb.height).toBeLessThanOrEqual(844 + 1);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect(filters).toBeHidden();
    await expect(tog).toBeFocused();
    await expect(tog).toHaveText(/Filters\s*1/);
    // Done also closes it
    await tog.tap();
    await filters.getByRole("button", { name: "Done" }).tap();
    await expect(filters).toBeHidden();
  });
});

test.describe("the filter sheet's backdrop catches the tap", () => {
  test("a tap outside the sheet closes it and does not reach the result underneath", async ({ page }) => {
    await bootViewer(page, RICH_DATA);
    await expect(page.locator("#s-list .msg").first()).toBeVisible();
    const filters = page.locator("#s-filters");
    await page.getByRole("button", { name: /^Filters/ }).tap();
    await expect(filters).toBeVisible();
    const fb = await filters.boundingBox();
    const y = Math.round(fb.y - 60);
    // what's under the finger is the scrim, not a result bubble
    expect(await page.evaluate((y) => { const h = document.elementFromPoint(195, y); return h && h.id; }, y)).toBe("filter-scrim");
    await page.touchscreen.tap(195, y);
    await expect(filters).toBeHidden();
    expect(await view(page)).toBe("search");
    await expect(page.locator("#filter-scrim")).not.toHaveClass(/\bon\b/);
  });
});

// Interactive targets smaller than 44×44 CSS px on a coarse pointer. Inline
// links inside message text are exempt (WCAG 2.5.8 inline exception), as are
// controls inside a larger <label>/role=button target and aria-hidden parts.
async function smallTargets(page, root) {
  return page.evaluate((sel) => {
    const out = [];
    const r0 = document.querySelector(sel);
    if (!r0) return out;
    for (const e of r0.querySelectorAll("button, a[href], input:not([type=hidden]), select, textarea, summary, [role=button], [role=option], label.pill, .pop-item")) {
      if (e.closest("[aria-hidden=true], .bubble, .otd-q")) continue;
      const cs = getComputedStyle(e);
      if (cs.visibility === "hidden") continue;
      const r = e.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      // a control that sits inside a bigger tap target (a label pill, a card) is covered by it
      const host = e.parentElement && e.parentElement.closest("label, .pop-item, [role=button], [role=option]");
      if (host && host !== e) { const h = host.getBoundingClientRect(); if (h.width >= 44 && h.height >= 44) continue; }
      if (r.width < 43.5 || r.height < 43.5) out.push(e.tagName.toLowerCase() + (e.id ? "#" + e.id : "") + "." + String(e.className).trim().split(/\s+/).slice(0, 2).join(".") + " " + Math.round(r.width) + "×" + Math.round(r.height));
    }
    return out;
  }, root);
}

test.describe("44px touch targets on a coarse pointer", () => {
  test("every view, the filter sheet and the More sheet", async ({ page }) => {
    await bootViewer(page, RICH_DATA);
    const bad = [];
    const add = async (label, root) => { for (const d of await smallTargets(page, root)) bad.push(label + ": " + d); };
    await add("chrome", ".mobile-topbar");
    await add("tabbar", ".tabbar");
    await add("search", "#view-search");
    await page.locator("#f-toggle").tap();
    await add("filters", "#s-filters");
    await page.locator("#f-people").tap();
    await add("people-popover", "#s-filters .popover");
    await page.locator("#f-done").tap();
    await page.locator("#tab-more").tap();
    await add("more-sheet", "#more-sheet");
    await page.keyboard.press("Escape");
    for (const v of VIEWS.slice(1)) {
      await page.evaluate((name) => document.querySelector('.nav-item[data-view="' + name + '"]').click(), v);
      await page.waitForTimeout(v === "stats" ? 700 : 80);
      await add(v, "#view-" + v);
    }
    expect([...new Set(bad)], [...new Set(bad)].join("\n")).toEqual([]);
  });
});

test.describe("the capsule is sized by layout, not a hardcoded height", () => {
  test("no inline height; the last memory scrolls fully clear of the tab bar", async ({ page }) => {
    await page.clock.setFixedTime(new Date("2025-05-01T18:00:00Z"));
    await bootViewer(page, RICH_DATA, { ls: { "gca.lastView": "capsule" } });
    const body = page.locator("#capsule-body");
    await expect(body.locator(".msg").first()).toBeVisible();
    expect(await body.getAttribute("style")).toBeNull();
    // scroll whatever scrolls the capsule to its end
    await page.evaluate(() => {
      for (let n = document.getElementById("capsule-body"); n; n = n.parentElement) {
        if (n.scrollHeight > n.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(n).overflowY)) n.scrollTop = n.scrollHeight;
      }
    });
    await page.waitForTimeout(100);
    const last = await body.locator(".msg").last().boundingBox();
    const bar = await page.locator(".tabbar").boundingBox();
    expect(last.y + last.height).toBeLessThanOrEqual(bar.y);
    // exactly one scroll container (no nested scroller inside the page)
    expect(await page.evaluate(() => /auto|scroll/.test(getComputedStyle(document.getElementById("capsule-body")).overflowY))).toBe(false);
  });
});

// the rendered-text contrast audit (tests/_contrast.js) at 390px — the
// mobile-only chrome (top bar, tab bar, More sheet, filter sheet) and your own
// messages, in every theme.
const { contrastFailures } = require("./_contrast.js");
test.describe("Contrast of rendered text at 390px", () => {
  for (const th of ["lightsout", "dim", "light"]) {
    test(th, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await bootViewer(page, RICH_DATA, { ls: { "gca.theme": th, "gca.settings": JSON.stringify({ me: "u1" }) } });
      const bad = [];
      const check = async (where, sel) => { for (const f of await contrastFailures(page, sel)) bad.push(where + ": " + f); };
      await check("search", "#view-search");
      await check("topbar", ".mobile-topbar");
      await check("tabbar", ".tabbar");
      await page.getByRole("button", { name: /^Filters/ }).tap();
      await expect(page.locator("#s-filters")).toBeVisible();
      await check("filter sheet", "#s-filters");
      await page.getByRole("button", { name: "Done" }).tap();
      for (const v of ["timeline", "gallery", "stats"]) {
        await page.locator('.tabbar .tab[data-tab="' + v + '"]').tap();
        await page.waitForTimeout(v === "stats" ? 700 : 150);
        await check(v, "#view-" + v);
      }
      await page.locator("#tab-more").tap();
      await expect(page.locator("#more-sheet")).toBeVisible();
      await check("more sheet", "#more-sheet");
      await page.keyboard.press("Escape");
      // every Wrapped slide at 390px, not only the desktop pass
      await page.evaluate(() => document.querySelector('.nav-item[data-view="wrapped"]').click());
      const slides = await page.locator("#wr-segs .wr-seg").count();
      expect(slides).toBeGreaterThan(3);
      for (let k = 0; k < slides; k++) {
        if (k) await page.locator("#wr-next").tap();
        await page.waitForTimeout(120);
        await check("wrapped slide " + (k + 1), "#view-wrapped");
      }
      expect([...new Set(bad)], [...new Set(bad)].join("\n")).toEqual([]);
    });
  }
});
