const { test, expect } = require("@playwright/test");
const { contrastFailures } = require("./_contrast.js");

// the rendered-text contrast audit (tests/_contrast.js) has to see
// a ::before / ::after layer painted between an element's own background and
// the text above it — the Wrapped slides' vignette is one. Synthetic markup,
// no app data.
const PAGE = (overlay) => `<!doctype html><html><body style="margin:0;background:#fff">
  <style>
    .box { position: relative; background: #ffffff; width: 600px; height: 400px; padding: 20px; }
    .box::after { content: ""; position: absolute; inset: 0; pointer-events: none; background: ${overlay}; }
    .box span { position: relative; z-index: 1; color: #333333; font-size: 14px; }
    .box .edge { position: absolute; left: 4px; top: 4px; }
    .box .mid { position: absolute; left: 280px; top: 190px; }
  </style>
  <div class="box" id="r"><span class="edge">edge text</span><span class="mid">mid text</span></div></body></html>`;

test("a pseudo-element overlay under the text is part of its background", async ({ page }) => {
  await page.setContent(PAGE("rgba(0, 0, 0, 0.85)"));
  const bad = await contrastFailures(page, "#r");
  // #333 on white is 12.6:1, but on white under 85% black it is ~1.3:1
  expect(bad.some((f) => f.includes("edge text")), bad.join("\n")).toBe(true);
  expect(bad.some((f) => f.includes("mid text")), bad.join("\n")).toBe(true);
});

test("a %-sized radial vignette only darkens the text near its edge", async ({ page }) => {
  await page.setContent(PAGE("radial-gradient(100% 100% at 50% 50%, transparent 40%, rgba(0, 0, 0, 0.95))"));
  const bad = await contrastFailures(page, "#r");
  expect(bad.some((f) => f.includes("edge text")), bad.join("\n")).toBe(true);
  expect(bad.some((f) => f.includes("mid text")), bad.join("\n")).toBe(false);
});

// Generated text (a ::before / ::after with string, counter() or attr()
// content) is text too: a numbered step dot, a "↵" hint. It is checked with
// its own colour on its own background, laid over its element's.
const GEN = `<!doctype html><html><body style="margin:0;background:#000">
  <style>
    ol { counter-reset: s; list-style: none; }
    li { counter-increment: s; color: #fff; }
    li::before { content: counter(s); display: inline-grid; width: 30px; height: 30px; place-items: center; font-size: 13px; color: #fff; }
    li.bad::before { background: linear-gradient(145deg, #4db2f5, #1a8cd8); }
    li.ok::before { background: linear-gradient(145deg, #1d4ed8, #1e3a8a); }
    li.tint::after { content: "↵"; color: rgba(255, 255, 255, 0.3); }
    li.empty::before { content: ""; background: #4db2f5; }
    li.gone::before { content: "9"; color: #4db2f5; display: none; }
  </style>
  <ol id="r"><li class="bad">one</li><li class="ok">two</li><li class="tint">three</li><li class="empty">four</li><li class="gone">five</li></ol></body></html>`;

test("generated ::before / ::after text is audited on its own background", async ({ page }) => {
  await page.setContent(GEN);
  const bad = await contrastFailures(page, "#r");
  expect(bad.some((f) => /li\.bad::before “counter\(s\)”/.test(f)), bad.join("\n")).toBe(true);
  expect(bad.some((f) => /li\.ok::before/.test(f)), bad.join("\n")).toBe(false);
  expect(bad.some((f) => /li\.tint::after “↵”/.test(f)), bad.join("\n")).toBe(true);
  expect(bad.some((f) => /li\.(empty|gone)::/.test(f)), bad.join("\n")).toBe(false);
  expect(bad.filter((f) => !/::/.test(f)), "the li text itself (white on black) passes").toEqual([]);
});
