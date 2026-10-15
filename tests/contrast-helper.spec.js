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
