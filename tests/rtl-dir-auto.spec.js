const { test, expect } = require("@playwright/test");
const { bootViewer, conv } = require("./_viewer-fixture.js");

// VC-26: message text had no dir="auto", so an Arabic/Hebrew line took the
// page's LTR base direction and its trailing punctuation landed on the wrong
// side. Bubbles, bookmark cards and People samples now let the browser pick
// the direction from the text.
const T = Date.parse("2024-03-10T12:00:00Z");
const RTL = "שלום לכולם, מה שלומכם היום?";
const A = [
  { i: "a0", s: "u1", t: T, x: RTL },
  { i: "a1", s: "u2", t: T + 60000, x: "plain english line here" },
];
const B = [{ i: "b0", s: "u1", t: T, x: "مرحبا بالجميع كيف حالكم اليوم؟" }];
const DATA = { conversations: [conv("A", "Alpha", A), conv("B", "Beta", B)] };

test("VC-26: message bubbles use dir=auto and resolve RTL text to rtl", async ({ page }) => {
  await bootViewer(page, DATA);
  const bubble = page.locator("#s-list .bubble", { hasText: "שלום" });
  await expect(bubble).toHaveAttribute("dir", "auto");
  expect(await bubble.evaluate((b) => getComputedStyle(b).direction)).toBe("rtl");
  const ltr = page.locator("#s-list .bubble", { hasText: "plain english" });
  expect(await ltr.evaluate((b) => getComputedStyle(b).direction)).toBe("ltr");
});

test("VC-26: bookmark cards from another conversation and People samples use dir=auto", async ({ page }) => {
  await bootViewer(page, DATA, { ls: { "gca.settings": JSON.stringify({ pins: ["b0"] }), "gca.lastView": "pins" } });
  await expect(page.locator("#view-pins .bubble", { hasText: "مرحبا" })).toHaveAttribute("dir", "auto");
  await page.locator('.nav-item[data-view="people"]').click();
  await expect(page.locator(".sample", { hasText: "שלום" }).first()).toHaveAttribute("dir", "auto");
});

test("VC-26: a share card draws RTL text right-to-left from the right edge", async ({ page }) => {
  await bootViewer(page, DATA, { ls: { "gca.lastView": "timeline" } });
  // Record how each body line is drawn (the Share dialog's preview draws the
  // card; x is in CSS px under the DPR transform, so scale it to canvas px).
  await page.evaluate(() => {
    window.__drawn = [];
    const orig = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (t, x, y) {
      window.__drawn.push({ t: String(t), x: x * this.getTransform().a, dir: this.direction, align: this.textAlign, w: this.canvas.width });
      return orig.apply(this, arguments);
    };
  });
  const row = page.locator('#view-timeline .msg[data-idx="0"]');
  await row.hover();
  await row.locator("button", { hasText: /^Share$/ }).click();
  await expect.poll(() => page.evaluate(() => window.__drawn.some((d) => d.t.includes("שלום")))).toBe(true);
  const line = await page.evaluate(() => window.__drawn.find((d) => d.t.includes("שלום")));
  expect(line.dir).toBe("rtl");
  expect(line.align).toBe("right");
  expect(line.x).toBeGreaterThan(line.w / 2);
});
