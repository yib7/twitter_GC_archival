const { test, expect } = require("@playwright/test");
const { bootViewer, conv } = require("./_viewer-fixture.js");
const { contrastFailures } = require("./_contrast.js");

// SP5 accessibility checkpoint (UX-1/VC-19, UX-12 … UX-17). Synthetic data
// only. Each describe block is one audit item; they share this fixture.
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
const THEMES = ["lightsout", "dim", "light"];

// In-page helpers: WCAG contrast of two CSS colours, and whether the focused
// element shows a focus ring (an outline, or a box-shadow in the accent / ring
// colour on the element or on the wrapper that draws it for an inner input).
async function installHelpers(page) {
  await page.evaluate(() => {
    const probe = document.createElement("span"); probe.setAttribute("aria-hidden", "true"); document.body.appendChild(probe);
    const rgb = (c) => { probe.style.color = ""; probe.style.color = c; return getComputedStyle(probe).color.match(/[\d.]+/g).slice(0, 3).map(Number); };
    const lum = (c) => { const [r, g, b] = rgb(c).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    window.__cr = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
    window.__tok = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
    window.__ring = (el) => {
      const ui = rgb(window.__tok("--accent-ui")).join(", ");
      const hosts = [el, el.closest(".search-box, .pill"), el.matches(".switch input") ? el.nextElementSibling : null].filter(Boolean);
      for (const h of hosts) {
        const cs = getComputedStyle(h);
        if (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) >= 2) return { ok: true, color: cs.outlineColor };
        if (cs.boxShadow && cs.boxShadow.indexOf(ui) >= 0) return { ok: true, color: "rgb(" + ui + ")" };
      }
      return { ok: false };
    };
    window.__desc = (el) => el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\s+/).join(".") : "");
  });
}

// Tab through `stops` focus stops and report every one without a visible ring.
// (Reduced motion + two frames let a `transition: all` control settle, so it
// reports its final ring instead of the transition's start value.)
async function tabWalk(page, stops) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const missing = [], seen = [];
  for (let k = 0; k < stops; k++) {
    await page.keyboard.press("Tab");
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const r = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      return { d: window.__desc(el), ring: window.__ring(el) };
    });
    if (!r) continue;
    seen.push(r.d);
    if (!r.ring.ok) missing.push(r.d);
  }
  return { missing, seen };
}

test.describe("UX-12: a visible focus ring on every keyboard stop", () => {
  test("search view and sidebar: every Tab stop shows a ring", async ({ page }) => {
    await bootViewer(page, DATA);
    await installHelpers(page);
    await page.locator('.nav-item[data-view="search"]').focus();
    const { missing, seen } = await tabWalk(page, 40);
    expect(seen.length).toBeGreaterThan(15);
    expect(missing, "no focus ring on: " + missing.join(", ")).toEqual([]);
  });

  test("settings view: every Tab stop shows a ring", async ({ page }) => {
    await bootViewer(page, DATA, { ls: { "gca.lastView": "settings" } });
    await installHelpers(page);
    await page.locator('.nav-item[data-view="settings"]').focus();
    const { missing, seen } = await tabWalk(page, 45);
    expect(seen.some((d) => d.indexOf("set-") >= 0 || d.indexOf("input") === 0)).toBe(true);
    expect(missing, "no focus ring on: " + missing.join(", ")).toEqual([]);
  });

  test("the ring colour reaches 3:1 against the page in every theme", async ({ page }) => {
    await bootViewer(page, DATA);
    await installHelpers(page);
    for (const t of THEMES) {
      await page.evaluate((th) => document.querySelector('#sidebar-theme button[data-set="' + th + '"]').click(), t);
      await page.locator('.nav-item[data-view="timeline"]').focus();
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
      const r = await page.evaluate(() => {
        const ring = window.__ring(document.activeElement);
        return { ok: ring.ok, cr: ring.ok ? window.__cr(ring.color, window.__tok("--bg-page")) : 0 };
      });
      expect(r.ok, t).toBe(true);
      expect(r.cr, t).toBeGreaterThanOrEqual(3);
    }
  });
});

test.describe("UX-1 / VC-19: message actions are reachable by keyboard", () => {
  test("a timeline message takes focus and Tab walks into its actions", async ({ page }) => {
    await bootViewer(page, DATA, { ls: { "gca.lastView": "timeline" } });
    await page.locator("#tl-search").focus();
    await page.keyboard.press("Tab");
    const msg = page.locator("#tl-list .msg").first();
    await expect(msg).toBeFocused();
    await expect(msg).toHaveAttribute("role", "article");
    await expect(msg).toHaveAttribute("aria-label", /User 1/);
    const acts = msg.locator(".msg-acts");
    await expect(acts).toBeVisible();
    await expect(acts).toHaveAttribute("role", "toolbar");
    await page.keyboard.press("Tab");
    const pin = acts.getByRole("button", { name: "Bookmark" });
    await expect(pin).toBeFocused();
    await expect(pin).toHaveAttribute("aria-pressed", "false");
    await page.keyboard.press("Enter");
    // a toggle keeps one name and reports its state through aria-pressed
    await expect(pin).toHaveAttribute("aria-pressed", "true");
    await expect(pin).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(acts.getByRole("button", { name: "Copy" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(acts.getByRole("button", { name: "Context" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator(".ctx-modal")).toBeVisible();
  });

  test("a search result card is not a role=button wrapping buttons, and its actions are reachable", async ({ page }) => {
    await bootViewer(page, DATA);
    const card = page.locator("#s-list .msg").first();
    await expect(card).not.toHaveAttribute("role", "button");
    expect(await card.locator("button, a").count()).toBeGreaterThan(0);
    await card.focus();
    await page.keyboard.press("Tab");
    await expect(card.locator(".msg-acts")).toBeVisible();
    await expect(card.getByRole("button", { name: "Bookmark" })).toBeFocused();
    // the "⋯" touch button is not shown to a mouse / keyboard user
    await expect(card.locator(".msg-more")).toBeHidden();
  });
});

// A richer synthetic chat for the views that need volume: a long two-person
// back-and-forth (a thread + a reply chain), reactions (Hall of Fame), media.
const RICH = (() => {
  const out = [];
  let t = Date.parse("2024-05-01T15:00:00Z");
  for (let k = 0; k < 40; k++) {
    const m = { i: "r" + k, s: k % 2 ? "u2" : "u1", t: t + k * 60000, x: "volley number " + k + " about pizza and movies tonight" };
    if (k % 7 === 0) m.r = [{ s: "u3", k: "funny" }, { s: k % 2 ? "u1" : "u2", k: "like" }];
    out.push(m);
  }
  out.push({ i: "p1", s: "u3", t: t + 50 * 60000, x: "", m: "sample_media/photo-1.svg", k: "img", r: [{ s: "u1", k: "funny" }] });
  out.push({ i: "p2", s: "u1", t: t + 51 * 60000, x: "", m: "sample_media/photo-2.svg", k: "img" });
  return out;
})();
const RICH_DATA = { conversations: [conv("A", "Alpha", RICH)] };
const go = (page, v) => page.locator('.nav-item[data-view="' + v + '"]').click();

// Every visible element that looks clickable (cursor: pointer) must be
// keyboard-operable: a native control, or a Tab stop with an Enter/Space
// handler (role=button cards, focusable message cards), or inside one. Avatars (profile shortcut, also reachable from People) and aria-hidden
// duplicates (Wrapped progress segments mirror the dot buttons) are excluded.
async function clickOnly(page, root) {
  return page.evaluate((sel) => {
    const r = document.querySelector(sel);
    const ok = "button, a[href], input, select, textarea, label, summary, [tabindex='0'], [role=option], [aria-hidden=true], .av-clickable";
    return [...r.querySelectorAll("*")].filter((e) => {
      if (getComputedStyle(e).cursor !== "pointer") return false;
      const b = e.getBoundingClientRect();
      if (!b.width || !b.height) return false;
      return !e.closest(ok);
    }).map((e) => e.tagName.toLowerCase() + "." + String(e.className).trim().split(/\s+/).join("."));
  }, root);
}

test.describe("UX-13: no click-only elements", () => {
  for (const v of ["gallery", "hof", "stats", "threads", "chains", "wrapped", "people", "settings"]) {
    test(v + ": every pointer target is keyboard-operable", async ({ page }) => {
      await bootViewer(page, RICH_DATA);
      await go(page, v);
      await page.waitForTimeout(v === "stats" ? 600 : 100);
      const bad = await clickOnly(page, "#view-" + v);
      expect(bad, "click-only: " + [...new Set(bad)].join(", ")).toEqual([]);
    });
  }

  test("search popovers: people are labelled checkboxes, saved searches are buttons", async ({ page }) => {
    await bootViewer(page, RICH_DATA, { ls: { "gca.settings": JSON.stringify({ saved: [{ name: "pizza", q: "pizza", f: {} }] }) } });
    await page.locator("#f-people").click();
    expect(await clickOnly(page, ".popover")).toEqual([]);
    const cb = page.getByRole("checkbox", { name: /User 2/ });
    await cb.focus();
    await page.keyboard.press("Space");
    await expect(cb).toBeChecked();
    await page.keyboard.press("Escape");
    await page.locator("#f-saved").click();
    expect(await clickOnly(page, ".popover")).toEqual([]);
    await page.getByRole("button", { name: "★ pizza" }).press("Enter");
    await expect(page.locator("#s-input")).toHaveValue("pizza");
  });

  test("Enter / Space activate the converted targets", async ({ page }) => {
    await bootViewer(page, RICH_DATA);
    await go(page, "gallery");
    const cell = page.locator("#view-gallery .gcell").first();
    await expect(cell).toHaveAttribute("role", "button");
    await expect(cell).toHaveAttribute("aria-label", /Photo from/);
    await cell.press("Enter");
    await expect(page.locator(".lightbox")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(cell).toBeFocused();

    await go(page, "threads");
    await page.locator("#thr-grid .thr-card").first().press("Enter");
    await expect(page.locator('.nav-item[data-view="timeline"]')).toHaveAttribute("aria-current", "page");

    await go(page, "stats");
    const word = page.locator("#words .cloud-word").first();
    await expect(word).toBeVisible();
    expect(await word.evaluate((e) => e.tagName)).toBe("BUTTON");
    await word.press("Space");
    await expect(page.locator('.nav-item[data-view="search"]')).toHaveAttribute("aria-current", "page");

    await go(page, "settings");
    const preset = page.locator("#set-accents .preset").nth(1);
    await expect(preset).toHaveAttribute("aria-pressed", "false");
    await preset.press("Enter");
    await expect(page.locator("#set-accents .preset").nth(1)).toHaveAttribute("aria-pressed", "true");

    await go(page, "wrapped");
    const dot = page.getByRole("button", { name: "Slide 3 of", exact: false });
    await dot.press("Enter");
    await expect(page.locator(".wr-ctx")).toContainText("3 / ");
  });

  test("the On-This-Day toast has a real button to open the capsule", async ({ page }) => {
    await page.clock.setFixedTime(new Date("2025-05-01T18:00:00Z"));
    await bootViewer(page, RICH_DATA);
    const cta = page.locator(".otd-toast").getByRole("button", { name: /Open Time Capsule/ });
    await expect(cta).toBeVisible();
    await cta.press("Enter");
    await expect(page.locator('.nav-item[data-view="capsule"]')).toHaveAttribute("aria-current", "page");
  });
});

// Visible controls whose accessible name carries no word — "✕", "‹", "↑", an
// icon-only svg. Name = aria-labelledby / aria-label / visible text (minus
// aria-hidden parts and glyph-only strings) / img alt / title.
async function unnamed(page, root) {
  return page.evaluate((sel) => {
    const text = (n) => {
      if (n.nodeType === 3) return n.textContent;
      if (n.nodeType !== 1 || n.getAttribute("aria-hidden") === "true") return "";
      if (n.tagName === "IMG") return n.alt || "";
      return [...n.childNodes].map(text).join(" ");
    };
    const name = (e) => {
      const lb = e.getAttribute("aria-labelledby");
      if (lb) return lb.split(/\s+/).map((id) => (document.getElementById(id) || {}).textContent || "").join(" ");
      return e.getAttribute("aria-label") || text(e) || e.title || "";
    };
    const rootEl = document.querySelector(sel);
    return [...rootEl.querySelectorAll("button, a[href], [role=button], input:not([type=hidden]), select")]
      .filter((e) => { const b = e.getBoundingClientRect(); return b.width && b.height && !e.closest("[aria-hidden=true]"); })
      .filter((e) => {
        if (/^(INPUT|SELECT)$/.test(e.tagName)) return !(e.getAttribute("aria-label") || e.labels && e.labels.length && /\p{L}/u.test(e.labels[0].textContent) || e.title);
        return !/[\p{L}\p{N}]/u.test(name(e));
      })
      .map((e) => e.tagName.toLowerCase() + (e.id ? "#" + e.id : "") + "." + String(e.className).trim().split(/\s+/).join("."));
  }, root);
}

test.describe("UX-14: every icon-only control has a name", () => {
  test("views, search clear, back-to-top and the settings list", async ({ page }) => {
    await bootViewer(page, RICH_DATA, { ls: { "gca.settings": JSON.stringify({ saved: [{ name: "pizza", q: "pizza", f: {} }] }) } });
    await page.locator("#s-input").fill("pizza");
    await expect(page.locator("#s-clear")).toBeVisible();
    await page.locator("#s-btt").evaluate((b) => { b.hidden = false; });
    const bad = [];
    bad.push(...await unnamed(page, "#app"));
    for (const v of ["timeline", "gallery", "hof", "stats", "threads", "chains", "wrapped", "capsule", "battles", "people", "settings", "pins"]) {
      await go(page, v);
      await page.waitForTimeout(v === "stats" ? 600 : 60);
      bad.push(...(await unnamed(page, "#view-" + v)).map((d) => v + ": " + d));
    }
    expect([...new Set(bad)], "unnamed: " + [...new Set(bad)].join(", ")).toEqual([]);
    // decorative icons (every view has rendered by now) are hidden from assistive tech
    const loose = await page.evaluate(() => [...document.querySelectorAll("#app svg:not([aria-hidden=true]):not([role=img])")]
      .filter((s) => !s.closest("[aria-hidden=true]")).map((s) => s.parentElement.className));
    expect(loose).toEqual([]);
  });

  test("lightbox, profile, context, keyboard-help and palette overlays", async ({ page }) => {
    await bootViewer(page, RICH_DATA);
    const bad = [];
    await go(page, "gallery");
    await page.locator("#view-gallery .gcell").first().click();
    await expect(page.locator(".lightbox")).toBeVisible();
    bad.push(...(await unnamed(page, ".lightbox")).map((d) => "lightbox: " + d));
    await page.keyboard.press("Escape");
    await go(page, "timeline");
    await page.locator("#tl-list .msg .av-clickable").first().click();
    await expect(page.locator(".profile-modal")).toBeVisible();
    bad.push(...(await unnamed(page, ".profile-modal")).map((d) => "profile: " + d));
    await page.keyboard.press("Escape");
    await page.locator("#tl-list .msg").first().hover();
    await page.locator("#tl-list .msg").first().getByRole("button", { name: "Context" }).click();
    await expect(page.locator(".ctx-modal")).toBeVisible();
    bad.push(...(await unnamed(page, ".ctx-modal")).map((d) => "context: " + d));
    await page.keyboard.press("Escape");
    await page.keyboard.press("?");
    await expect(page.locator(".kb-modal")).toBeVisible();
    bad.push(...(await unnamed(page, ".kb-modal")).map((d) => "kb: " + d));
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+k");
    await expect(page.locator(".cmdk")).toBeVisible();
    bad.push(...(await unnamed(page, ".cmdk")).map((d) => "cmdk: " + d));
    expect([...new Set(bad)], "unnamed: " + [...new Set(bad)].join(", ")).toEqual([]);
  });
});

test.describe("UX-15: toasts are announced", () => {
  test("toast text lands in one persistent polite status region, even when repeated", async ({ page }) => {
    await bootViewer(page, DATA, { ls: { "gca.lastView": "timeline" } });
    const live = page.locator("#sr-status");
    await expect(live).toHaveAttribute("role", "status");
    await expect(live).toHaveAttribute("aria-live", "polite");
    await expect(live).toHaveAttribute("aria-atomic", "true");
    // visually hidden but not display:none (which would silence it)
    const box = await live.evaluate((e) => { const r = e.getBoundingClientRect(); return { w: r.width, h: r.height, d: getComputedStyle(e).display }; });
    expect(box.d).not.toBe("none");
    expect(box.w).toBeLessThanOrEqual(1);
    const msg = page.locator("#tl-list .msg").first();
    await msg.hover();
    await msg.getByRole("button", { name: "Bookmark" }).click();
    await expect(live).toHaveText("★ Bookmarked");
    await msg.hover();
    await msg.getByRole("button", { name: "Bookmark" }).click();
    await expect(live).toHaveText("Removed bookmark");
    // the same message twice in a row is re-announced (the region is cleared first)
    const seen = await page.evaluate(async () => {
      const r = document.getElementById("sr-status"), out = [];
      const mo = new MutationObserver(() => out.push(r.textContent));
      mo.observe(r, { childList: true, characterData: true, subtree: true });
      document.querySelector("#tl-list .msg .act-pin").click();
      await new Promise((ok) => setTimeout(ok, 200));
      document.querySelector("#tl-list .msg .act-pin").click();
      document.querySelector("#tl-list .msg .act-pin").click();
      await new Promise((ok) => setTimeout(ok, 200));
      mo.disconnect();
      return out;
    });
    expect(seen.filter((t) => t === "★ Bookmarked").length).toBeGreaterThanOrEqual(2);
    expect(seen).toContain("");
  });
});

test.describe("UX-16: the command palette is a combobox", () => {
  test("combobox + listbox + options, with aria-activedescendant following the arrows", async ({ page }) => {
    await bootViewer(page, DATA);
    await page.keyboard.press("Control+k");
    const input = page.locator(".cmdk-input");
    await expect(input).toBeFocused();
    await expect(input).toHaveAttribute("role", "combobox");
    await expect(input).toHaveAttribute("aria-expanded", "true");
    await expect(input).toHaveAttribute("aria-autocomplete", "list");
    const lbId = await input.getAttribute("aria-controls");
    const lb = page.locator("#" + lbId);
    await expect(lb).toHaveAttribute("role", "listbox");
    const opts = lb.getByRole("option");
    expect(await opts.count()).toBeGreaterThan(3);
    // group headings are presentational, never announced as options
    expect(await lb.locator(".cmdk-group").evaluateAll((gs) => gs.every((g) => g.getAttribute("aria-hidden") === "true"))).toBe(true);
    const active = async () => {
      const id = await input.getAttribute("aria-activedescendant");
      return page.locator("#" + id);
    };
    await expect(await active()).toHaveAttribute("aria-selected", "true");
    expect(await (await active()).evaluate((e, first) => e === first, await opts.first().elementHandle())).toBe(true);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    const third = await (await active()).evaluate((e) => [...e.parentElement.querySelectorAll("[role=option]")].indexOf(e));
    expect(third).toBe(2);
    await expect(lb.locator('[role=option][aria-selected="true"]')).toHaveCount(1);
    await page.keyboard.type("zzzz-no-such-command");
    await expect(input).toHaveAttribute("aria-expanded", "false");
    expect(await input.getAttribute("aria-activedescendant")).toBeNull();
    await expect(page.locator("#sr-status")).toContainText("No matches");
  });
});

test.describe("UX-17: onboarding is a real dialog", () => {
  test("role=dialog + aria-modal + labelled, focus moves in, Tab is trapped, Esc closes and restores focus", async ({ page }) => {
    await bootViewer(page, DATA, { ls: { "gca.onboarded": "0" } });
    const ov = page.locator(".onboard");
    await expect(ov).toBeVisible();
    await expect(ov).toHaveAttribute("role", "dialog");
    await expect(ov).toHaveAttribute("aria-modal", "true");
    const lb = await ov.getAttribute("aria-labelledby");
    await expect(page.locator("#" + lb)).toHaveText(/Welcome/);
    expect(await page.evaluate(() => !!document.activeElement.closest(".onboard"))).toBe(true);
    for (let k = 0; k < 8; k++) {
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => !!document.activeElement.closest(".onboard")), "Tab " + k).toBe(true);
    }
    // it sits in the shared modal layer, under the toast layer
    const z = await ov.evaluate((e) => [getComputedStyle(e).zIndex, getComputedStyle(document.documentElement).getPropertyValue("--z-modal").trim()]);
    expect(z[0]).toBe(z[1]);
    await page.keyboard.press("Escape");
    await expect(ov).toHaveCount(0);
    // opened at boot (no opener): focus returns to the current view's nav item
    await expect(page.locator('.nav-item[data-view="search"]')).toBeFocused();
  });
});

test.describe("UX-5 / UX-36: desktop keeps its two-up layouts", () => {
  test("Settings rows stay side by side; Stats two-up sections keep two columns", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await bootViewer(page, RICH_DATA, { ls: { "gca.lastView": "stats" } });
    await page.waitForTimeout(700);
    const cols = await page.locator("#view-stats .stat-grid2").evaluateAll((gs) => gs.map((g) => getComputedStyle(g).gridTemplateColumns.split(" ").length));
    expect(cols.length).toBeGreaterThan(0);
    expect(cols).toContain(2);
    await go(page, "settings");
    expect(await page.locator(".set-row").first().evaluate((e) => getComputedStyle(e).flexDirection)).toBe("row");
  });
});

test.describe("UX-19: desktop search is unchanged", () => {
  test("filters stay inline, no Filters toggle, the box is autofocused", async ({ page }) => {
    await bootViewer(page, DATA);
    await expect(page.locator("#s-input")).toBeFocused();
    await expect(page.locator("#s-filters")).toBeVisible();
    await expect(page.locator("#f-toggle")).toBeHidden();
    await expect(page.locator("#s-filters #s-matchhint")).toBeVisible();
    expect(await page.locator("#s-filters").getAttribute("role")).toBeNull();
    // Tab moves on out of the filter bar (it is not a focus trap on desktop)
    await page.locator("#f-save").focus();
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => !!document.activeElement.closest("#s-filters"))).toBe(false);
  });
});

test.describe("UX-27: empty states say what to do next", () => {
  const PLAIN = { conversations: [conv("A", "Alpha", LIST.map((m) => ({ i: m.i, s: m.s, t: m.t, x: m.x || "text" })))] };
  const cta = (page, v) => page.locator("#view-" + v + " .empty").getByRole("button");
  const onView = (page, v) => expect(page.locator('.nav-item[data-view="' + v + '"]')).toHaveAttribute("aria-current", "page");

  test("Capsule with nothing on this day → Open Timeline", async ({ page }) => {
    await page.clock.setFixedTime(new Date("2025-07-04T12:00:00Z"));
    await bootViewer(page, DATA, { ls: { "gca.lastView": "capsule" } });
    await expect(page.locator("#view-capsule .empty .hint")).toContainText(/earlier years/);
    await cta(page, "capsule").click();
    await onView(page, "timeline");
  });

  test("Pinned with no bookmarks explains ☆ / ⋯ → Open Timeline", async ({ page }) => {
    await bootViewer(page, DATA, { ls: { "gca.lastView": "pins" } });
    await expect(page.locator("#view-pins .empty .hint")).toContainText("☆");
    await expect(page.locator("#view-pins .empty .hint")).toContainText("⋯");
    await cta(page, "pins").click();
    await onView(page, "timeline");
  });

  test("Gallery with no media → Search messages", async ({ page }) => {
    await bootViewer(page, PLAIN, { ls: { "gca.lastView": "gallery" } });
    await cta(page, "gallery").click();
    await onView(page, "search");
  });

  test("Hall of Fame with no reactions → Open Timeline", async ({ page }) => {
    await bootViewer(page, PLAIN, { ls: { "gca.lastView": "hof" } });
    await cta(page, "hof").click();
    await onView(page, "timeline");
  });

  test("Search with no results → Clear all filters; grid with no media → Switch to List", async ({ page }) => {
    await bootViewer(page, DATA);
    await page.locator("#s-input").fill("zzqxnothing");
    const b = page.locator("#s-list .empty").getByRole("button", { name: "Clear search & filters" });
    await expect(b).toBeVisible();
    await b.click();
    await expect(page.locator("#s-input")).toHaveValue("");
    await expect(page.locator("#s-list .msg").first()).toBeVisible();
    await page.locator("#s-input").fill("third");
    await page.locator('#f-viewtoggle button[data-mode="grid"]').click();
    await page.locator("#s-list .empty").getByRole("button", { name: "Switch to List" }).click();
    await expect(page.locator("#s-list .msg").first()).toContainText("third message");
    await expect(page.locator('#f-viewtoggle button[data-mode="list"]')).toHaveClass(/sel/);
  });
});

test.describe("UX-28: gallery basics", () => {
  const overlap = (a, b) => !(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y);

  test("standard page header with a count", async ({ page }) => {
    await bootViewer(page, RICH_DATA, { ls: { "gca.lastView": "gallery" } });
    await expect(page.locator("#view-gallery .page-head .page-title")).toHaveText("Gallery");
    await expect(page.locator("#view-gallery .page-head .page-sub")).toContainText("2 photos");
    await expect(page.locator("#view-gallery")).not.toContainText("Media Gallery —");
    await expect(page.locator("#gal-list .gcell")).toHaveCount(2);
  });

  for (const vp of [{ width: 1280, height: 860 }, { width: 390, height: 844 }]) {
    test("lightbox: n / N counter and a non-overlapping top toolbar at " + vp.width + "px", async ({ page }) => {
      await page.setViewportSize(vp);
      await bootViewer(page, RICH_DATA, { ls: { "gca.lastView": "gallery" } });
      await page.locator("#gal-list .gcell").first().click();
      const lb = page.locator(".lightbox");
      await expect(lb.locator(".lb-count")).toHaveText("1 / 2");
      await expect(lb.locator(".lb-count")).toHaveAttribute("aria-label", "Item 1 of 2");
      await page.keyboard.press("ArrowRight");
      await expect(page.locator(".lightbox .lb-count")).toHaveText("2 / 2");
      const boxes = {};
      for (const s of [".lb-count", ".lb-pin", ".lb-dl", ".lb-close"]) {
        boxes[s] = await page.locator(".lightbox " + s).boundingBox();
        expect(boxes[s].y, s).toBeGreaterThanOrEqual(0);
        expect(boxes[s].x + boxes[s].width, s).toBeLessThanOrEqual(vp.width);
      }
      const keys = Object.keys(boxes);
      for (let a = 0; a < keys.length; a++) for (let b = a + 1; b < keys.length; b++) expect(overlap(boxes[keys[a]], boxes[keys[b]]), keys[a] + " × " + keys[b]).toBe(false);
      // all four share one toolbar row in the top safe area
      expect(await page.locator(".lightbox .lb-bar").evaluate((b) => [".lb-count", ".lb-pin", ".lb-dl", ".lb-close"].every((s) => b.querySelector(s)))).toBe(true);
      if (vp.width > 760) {
        // Download no longer sits over the sidebar brand
        const brand = await page.locator(".sidebar .brand").boundingBox();
        if (brand) expect(overlap(boxes[".lb-dl"], brand)).toBe(false);
      }
    });
  }
});

test.describe("UX-29: Word Battles keeps the words you add", () => {
  test("custom words survive changing the people, de-duplicate, persist, and can be removed", async ({ page }) => {
    await bootViewer(page, RICH_DATA, { ls: { "gca.lastView": "battles" } });
    const word = page.locator("#battle-word");
    const added = page.locator("#battle-results .battle-added .battle-word");
    await word.fill("pizza"); await word.press("Enter");
    await word.fill("movies"); await page.locator("#battle-go").click();
    await word.fill("PIZZA"); await word.press("Enter");        // duplicate → still one row
    await expect(added).toHaveText(["movies", "pizza"]);   // newest first
    // a half-typed word survives a people change too
    await word.fill("tonig");
    await page.locator("#battle-p2").selectOption("u3");
    await expect(added).toHaveText(["movies", "pizza"]);
    await expect(word).toHaveValue("tonig");
    // the picker avatar follows the selection
    await expect(page.locator('.battle-picker .av[data-id="u3"]')).toHaveCount(1);
    // counts are recomputed for the new pair: u1 says "pizza" in every volley, u3 never does
    const pizzaRow = page.locator("#battle-results .battle-added", { has: page.locator(".battle-word", { hasText: /^pizza$/ }) });
    const counts = (await pizzaRow.locator(".battle-count").allTextContents()).map(Number);
    expect(counts[0]).toBeGreaterThan(0);
    expect(counts[1]).toBe(0);
    // persisted in settings
    expect(JSON.parse(await page.evaluate(() => localStorage.getItem("gca.settings"))).battleWords).toEqual(["movies", "pizza"]);
    await page.reload();
    await go(page, "battles");
    await expect(added).toHaveText(["movies", "pizza"]);
    // removable
    await page.getByRole("button", { name: "Remove “movies”" }).click();
    await expect(added).toHaveText(["pizza"]);
    expect(JSON.parse(await page.evaluate(() => localStorage.getItem("gca.settings"))).battleWords).toEqual(["pizza"]);
  });
});

test.describe("UX-32: no flash of message 0", () => {
  const watchFlash = (page) => page.evaluate(() => {
    window.__flashed = [];
    new MutationObserver((ms) => ms.forEach((m) => {
      if (m.target.classList && m.target.classList.contains("flash")) window.__flashed.push(m.target.dataset.idx);
    })).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["class"] });
  });

  test("opening the Timeline from the nav is quiet", async ({ page }) => {
    await bootViewer(page, DATA);
    await watchFlash(page);
    await go(page, "timeline");
    await expect(page.locator("#tl-list .msg").first()).toBeVisible();
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => window.__flashed)).toEqual([]);
    expect(await page.locator("#tl-scroll").evaluate((s) => s.scrollTop)).toBe(0);
  });

  test("a cold jump from Search highlights only its target", async ({ page }) => {
    await bootViewer(page, DATA);
    await watchFlash(page);
    const card = page.locator('#s-list .msg[data-idx="4"]');
    await card.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator('#tl-list .msg[data-idx="4"]')).toHaveClass(/flash/);
    expect(await page.evaluate(() => window.__flashed)).toEqual(["4"]);
  });
});

test.describe("UX-33: the sticky day pill doesn't block what's under it", () => {
  test("translucent + blurred, and clicks pass through to the media below", async ({ page }) => {
    await bootViewer(page, RICH_DATA, { ls: { "gca.lastView": "timeline" } });
    for (const th of THEMES) {
      await page.evaluate((t) => document.querySelector('#sidebar-theme button[data-set="' + t + '"]').click(), th);
      const st = await page.locator("#tl-list .daysep:not(.cont) .daypill").first().evaluate((p) => {
        const cs = getComputedStyle(p);
        const a = cs.backgroundColor.match(/[\d.]+/g).map(Number);
        return { pe: cs.pointerEvents, alpha: a.length > 3 ? a[3] : 1, blur: (cs.backdropFilter || cs.webkitBackdropFilter || "").indexOf("blur") >= 0 };
      });
      expect(st.pe, th).toBe("none");
      expect(st.alpha, th).toBeLessThan(1);
      expect(st.blur, th).toBe(true);
    }
    // stuck over a message: scroll until a message (or its media) is really
    // painted under the stuck pill's centre, then a click there must land on
    // that message — not on the pill, and not on empty space.
    const hit = await page.evaluate(async () => {
      const s = document.getElementById("tl-scroll");
      for (let top = 200; top < s.scrollHeight; top += 37) {
        s.scrollTop = top;
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const pill = [...document.querySelectorAll("#tl-list .daysep .daypill")].find((p) => { const r = p.getBoundingClientRect(); return r.height && r.top >= 0 && r.top < 120; });
        if (!pill) continue;
        const r = pill.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
        const stack = document.elementsFromPoint(x, y);
        const under = stack.find((e) => !e.closest(".daypill") && e.closest(".media, .msg"));
        if (!under) continue;
        const e = document.elementFromPoint(x, y);
        return e && e.closest(".media, .msg") ? "message" : e && e.closest(".daypill") ? "pill" : "other: " + (e && e.className);
      }
      return "never stuck over a message";
    });
    expect(hit).toBe("message");
  });
});

// Rendered-text contrast audit (tests/_contrast.js): every visible text run vs
// the composited background, every gradient stop included.
// RICH plus own-message content that only renders for `me`: a file chip and a
// link, with a highlighted search hit in the bubble.
const CONTRAST_DATA = { conversations: [conv("A", "Alpha", RICH.concat([
  { i: "c1", s: "u1", t: Date.parse("2024-05-01T16:00:00Z"), x: "the plan doc, see https://example.test/plan", m: "sample_media/report.pdf", k: "file" },
]))] };
test.describe("Contrast of rendered text, every view × theme", () => {
  for (const th of THEMES) {
    test(th, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await bootViewer(page, CONTRAST_DATA, { ls: { "gca.theme": th, "gca.settings": JSON.stringify({ me: "u1", saved: [{ name: "pizza", q: "pizza", f: {} }] }) } });
      const bad = [];
      for (const v of ["search", "timeline", "gallery", "pins", "hof", "wrapped", "capsule", "stats", "threads", "chains", "battles", "people", "settings"]) {
        await go(page, v);
        await page.waitForTimeout(v === "stats" ? 700 : 120);
        for (const f of await contrastFailures(page, "#view-" + v)) bad.push(v + ": " + f);
      }
      for (const f of await contrastFailures(page, ".sidebar")) bad.push("sidebar: " + f);
      expect([...new Set(bad)], [...new Set(bad)].join("\n")).toEqual([]);
    });
  }
});
