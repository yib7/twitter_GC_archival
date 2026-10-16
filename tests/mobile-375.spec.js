const { test, expect } = require("@playwright/test");
const { bootViewer, conv } = require("./_viewer-fixture.js");

// The narrowest common phone (375px, touch). mobile-390.spec.js covers the
// views with an empty search box; this covers the box once it holds a query
// (the ✕ clear button only appears then) and the placeholder that has to fit.
test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });

const T = Date.parse("2024-03-10T12:00:00Z");
const LIST = Array.from({ length: 12 }, (_, k) => ({ i: "m" + k, s: k % 2 ? "u2" : "u1", t: T + k * 60000, x: "hello number " + k }));
const DATA = { conversations: [conv("A", "Alpha", LIST), conv("B", "Beta", LIST.map((m) => Object.assign({}, m, { i: "b" + m.i })))] };

// Width the input's placeholder needs in the input's own font.
const placeholderFits = (page) => page.locator("#s-input").evaluate((el) => {
  const cs = getComputedStyle(el);
  const ctx = document.createElement("canvas").getContext("2d");
  ctx.font = cs.fontWeight + " " + cs.fontSize + " " + cs.fontFamily;
  const need = ctx.measureText(el.placeholder).width;
  const room = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  return { need: Math.round(need), room: Math.round(room), text: el.placeholder };
});

test("with a query typed, the clear ✕ stays inside the search box and is a 44px target", async ({ page }) => {
  await bootViewer(page, DATA);
  await page.locator("#s-input").fill("hello");
  const clear = page.locator("#s-clear");
  await expect(clear).toBeVisible();
  const box = await page.locator(".search-box").boundingBox();
  const c = await clear.boundingBox();
  expect(c.x, "✕ starts inside the box").toBeGreaterThanOrEqual(box.x);
  expect(c.x + c.width, "✕ ends inside the box").toBeLessThanOrEqual(box.x + box.width + 0.5);
  expect(c.width).toBeGreaterThanOrEqual(44);
  expect(c.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await clear.tap();
  await expect(page.locator("#s-input")).toHaveValue("");
});

test("the search placeholder fits the box on a phone, in This chat and All chats", async ({ page }) => {
  await bootViewer(page, DATA);
  let r = await placeholderFits(page);
  expect(r.need, JSON.stringify(r)).toBeLessThanOrEqual(r.room);
  expect(r.text).toMatch(/Search 12 messages/);
  await page.locator('#s-scope button[data-scope="all"]').tap();
  r = await placeholderFits(page);
  expect(r.need, JSON.stringify(r)).toBeLessThanOrEqual(r.room);
  expect(r.text).toMatch(/all chats/i);
});

test("the full placeholder hint comes back on a wide screen", async ({ page }) => {
  await bootViewer(page, DATA);
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.locator("#s-input")).toHaveAttribute("placeholder", /quotes/);
});

// Just above the phone breakpoint the sidebar takes most of the width, so the
// box is narrower than on a phone: the placeholder must still fit.
for (const width of [768, 900]) {
  test(`the search placeholder fits at ${width}px, beside the sidebar`, async ({ page }) => {
    await bootViewer(page, DATA);
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(async () => { const r = await placeholderFits(page); return r.need <= r.room; }).toBe(true);
  });
}

// Beside the sidebar, typing a query (which shows the ✕) must not push the
// This chat / All chats switch past the edge of the window.
test("at 768px a typed query keeps the scope switch inside the window", async ({ page }) => {
  await bootViewer(page, DATA);
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.locator("#s-input").fill("hello number");
  await expect(page.locator("#s-clear")).toBeVisible();
  const scope = await page.locator("#s-scope").boundingBox();
  const view = await page.locator("#view-search").boundingBox();
  expect(scope.x + scope.width).toBeLessThanOrEqual(view.x + view.width + 0.5);
  const clear = await page.locator("#s-clear").boundingBox(), box = await page.locator(".search-box").boundingBox();
  expect(clear.x + clear.width).toBeLessThanOrEqual(box.x + box.width + 0.5);
});
