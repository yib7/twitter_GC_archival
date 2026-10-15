const { test, expect } = require("@playwright/test");
const { bootViewer, msgs, conv } = require("./_viewer-fixture.js");

// UX-11 / UX-22: contrast across Light / Dim / Lights-out.
//  - --text / --text-dim / --text-faint reach 4.5:1 on the page and card
//    surfaces (faint was ~3:1 in every theme);
//  - every person-palette name colour reaches 4.5:1 (the bright dark-theme
//    hues were reused on white: 1.8–3.0:1), and so does a user-picked
//    override colour, adjusted per theme through personColor();
//  - text on a filled accent uses --on-accent, derived from the accent's
//    luminance (white on X blue was 3.0:1), for every preset accent;
//  - accent-coloured text uses --accent-text (4.5:1 on the theme);
//  - the Stats chart tooltips take the same --on-accent / fill (chartTheme).
const THEMES = ["lightsout", "dim", "light"];
const HUES = ["rose", "coral", "amber", "lime", "emerald", "teal", "sky", "indigo", "violet", "magenta"];
const ACCENTS = ["#1d9bf0", "#3b82f6", "#2563eb", "#1d4ed8", "#0ea5e9", "#38bdf8", "#06b6d4", "#0891b2", "#6366f1", "#818cf8", "#60a5fa"];
const SURFACES = { light: ["#ffffff", "#f7f9f9"], dim: ["#15202b", "#1e2732"], lightsout: ["#000000", "#16181c"] };
const DATA = { conversations: [conv("A", "Alpha", msgs("a", 12, { s: ["u1", "u2", "u3"] }))] };

// WCAG contrast of two CSS colours, resolved by the browser (hex, rgb(), var()).
async function installContrast(page) {
  await page.evaluate(() => {
    const probe = document.createElement("span"); document.body.appendChild(probe);
    const rgb = (c) => { probe.style.color = ""; probe.style.color = c; return getComputedStyle(probe).color.match(/[\d.]+/g).slice(0, 3).map(Number); };
    const lum = (c) => { const [r, g, b] = rgb(c).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    window.__cr = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
    window.__tok = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  });
}
const setTheme = (page, t) => page.evaluate((th) => document.querySelector('#sidebar-theme button[data-set="' + th + '"]').click(), t);

test("text tokens reach 4.5:1 on the page and card surfaces in every theme", async ({ page }) => {
  await bootViewer(page, DATA);
  await installContrast(page);
  for (const t of THEMES) {
    await setTheme(page, t);
    const r = await page.evaluate(() => {
      const out = {};
      for (const fg of ["--text", "--text-dim", "--text-faint"]) for (const bg of ["--bg-page", "--bg-card", "--bg-panel", "--bg-hover"]) out[fg + " on " + bg] = +window.__cr(window.__tok(fg), window.__tok(bg)).toFixed(2);
      return out;
    });
    for (const k in r) expect(r[k], t + ": " + k).toBeGreaterThanOrEqual(4.5);
    // app.js mirrors [--bg-page, --bg-card] in THEME_BGS for its contrast maths
    expect(await page.evaluate(() => [window.__tok("--bg-page"), window.__tok("--bg-card")]), t).toEqual(SURFACES[t]);
  }
});

test("person-palette names and a user-picked colour reach 4.5:1 in every theme", async ({ page }) => {
  // u1 overrides to a bright yellow (fails on white), u2 to a deep navy (fails on black)
  await bootViewer(page, DATA, { ls: { "gca.settings": JSON.stringify({ colors: { u1: "#eab308", u2: "#1e3a8a" } }), "gca.lastView": "timeline" } });
  await installContrast(page);
  await expect(page.locator("#tl-list .msg").first()).toBeVisible();
  for (const t of THEMES) {
    await setTheme(page, t);
    const r = await page.evaluate((hues) => {
      const out = {};
      for (const h of hues) for (const bg of ["--bg-page", "--bg-card"]) out["--p-" + h + " on " + bg] = +window.__cr(window.__tok("--p-" + h), window.__tok(bg)).toFixed(2);
      // the rendered names (auto hue + both overrides), measured on the live DOM
      document.querySelectorAll("#tl-list .msg-name").forEach((n) => {
        const c = getComputedStyle(n).color;
        for (const bg of ["--bg-page", "--bg-card"]) out[n.textContent + " name on " + bg] = +window.__cr(c, window.__tok(bg)).toFixed(2);
      });
      return out;
    }, HUES);
    expect(Object.keys(r).some((k) => k.startsWith("User 1 name"))).toBe(true);
    for (const k in r) expect(r[k], t + ": " + k).toBeGreaterThanOrEqual(4.5);
  }
});

test("text on a filled accent and accent-coloured text pass for every preset accent and theme", async ({ page }) => {
  await bootViewer(page, DATA);
  await installContrast(page);
  await page.locator('.nav-item[data-view="settings"]').click();
  const custom = page.locator("#set-accent-custom");
  for (const t of THEMES) {
    await setTheme(page, t);
    for (const a of ACCENTS) {
      await custom.fill(a);
      const r = await page.evaluate(() => {
        const on = window.__tok("--on-accent"), fill = window.__tok("--accent-fill");
        const sel = document.querySelector("#set-theme button.sel"), cs = getComputedStyle(sel);
        return {
          on, fill,
          "on vs fill": window.__cr(on, fill),
          "on vs gradient end": window.__cr(on, window.__tok("--accent-grad-end")),
          "seg.sel text": window.__cr(cs.color, cs.backgroundColor),
          "accent text on page": window.__cr(window.__tok("--accent-text"), window.__tok("--bg-page")),
          "accent text on card": window.__cr(window.__tok("--accent-text"), window.__tok("--bg-card")),
        };
      });
      expect(r.on, a).toMatch(/^#(ffffff|0f1419)$/);
      for (const k of ["on vs fill", "on vs gradient end", "seg.sel text", "accent text on page", "accent text on card"]) {
        expect(r[k], t + " " + a + ": " + k).toBeGreaterThanOrEqual(4.5);
      }
    }
  }
});

test("Stats chart tooltips wear --on-accent on the accent fill (chartTheme)", async ({ page }) => {
  await bootViewer(page, DATA, { ls: { "gca.settings": JSON.stringify({ accent: "#38bdf8" }) } });
  await page.locator('.nav-item[data-view="stats"]').click();
  await expect(page.locator("#view-stats")).toHaveAttribute("data-ready", "1");
  const read = () => page.evaluate(() => {
    const c = window.Chart.getChart(document.getElementById("chart-months"));
    const tok = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
    const tt = c.options.plugins.tooltip;
    return { title: tt.titleColor, body: tt.bodyColor, bg: tt.backgroundColor, on: tok("--on-accent"), fill: tok("--accent-fill") };
  });
  let r = await read();
  expect(r.on).toBe("#0f1419");
  expect([r.title, r.body, r.bg]).toEqual([r.on, r.on, r.fill]);
  // a deep accent flips it to white text, live
  await page.locator('.nav-item[data-view="settings"]').click();
  await page.locator("#set-accent-custom").fill("#1d4ed8");
  await page.locator('.nav-item[data-view="stats"]').click();
  r = await read();
  expect(r.on).toBe("#ffffff");
  expect([r.title, r.body, r.bg]).toEqual([r.on, r.on, r.fill]);
});

// I-4: a link/file chip inside your own message sits on an accent-tinted fill;
// its domain and its dim label line both need 4.5:1 there, for every preset
// accent in every theme (the label was a fixed white 80%: ~2.8:1 on X blue).
test("link chip text in your own messages passes on every preset accent and theme", async ({ page }) => {
  const T0 = Date.parse("2024-03-10T12:00:00Z");
  const CHIP = { conversations: [conv("A", "Alpha", [
    { i: "c0", s: "u1", t: T0, x: "the doc", m: "sample_media/report.pdf", k: "file" },
    { i: "c1", s: "u2", t: T0 + 60000, x: "thanks" },
  ])] };
  await bootViewer(page, CHIP, { ls: { "gca.settings": JSON.stringify({ me: "u1" }) } });
  const custom = page.locator("#set-accent-custom");
  const bad = [];
  for (const t of THEMES) {
    await setTheme(page, t);
    for (const a of ACCENTS) {
      await page.locator('.nav-item[data-view="settings"]').click();
      await custom.fill(a);
      await page.locator('.nav-item[data-view="timeline"]').click();
      const chip = page.locator("#tl-list .msg.me a.urlchip").first();
      await expect(chip).toBeVisible();
      const r = await chip.evaluate((c) => {
        const parse = (s) => { const m = s.match(/[\d.]+(e-?\d+)?/g).map(Number), k = /^color\(srgb/.test(s) ? 255 : 1; return { r: m[0] * k, g: m[1] * k, b: m[2] * k, a: m.length > 3 ? m[3] : 1 }; };
        const over = (t, u) => ({ r: t.r * t.a + u.r * (1 - t.a), g: t.g * t.a + u.g * (1 - t.a), b: t.b * t.a + u.b * (1 - t.a), a: 1 });
        const lum = (c) => [c.r, c.g, c.b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }).reduce((s, v, k) => s + v * [0.2126, 0.7152, 0.0722][k], 0);
        const cr = (x, y) => { const p = lum(x), q = lum(y); return (Math.max(p, q) + 0.05) / (Math.min(p, q) + 0.05); };
        const bg = parse(getComputedStyle(c).backgroundColor);
        const out = {};
        for (const s of [".dom", ".lbl"]) out[s] = +cr(over(parse(getComputedStyle(c.querySelector(s)).color), bg), bg).toFixed(2);
        return out;
      });
      for (const k in r) if (r[k] < 4.5) bad.push(t + " " + a + " " + k + " " + r[k]);
    }
  }
  expect(bad, bad.join("\n")).toEqual([]);
});
