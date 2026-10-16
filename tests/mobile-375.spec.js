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

// A touch tablet just above the phone breakpoint: the sidebar leaves Settings
// a phone-sized column, and the 44px accent swatches ran off the card while
// the label was crushed to one word per line.
test("at 768px (touch) the Settings accent row fits its card", async ({ page }) => {
  await bootViewer(page, DATA, { ls: { "gca.lastView": "settings" } });
  await page.setViewportSize({ width: 768, height: 1024 });
  const group = await page.locator(".set-group").first().boundingBox();
  const right = group.x + group.width;
  const boxes = await page.locator("#set-accents .preset, #set-accent-custom, #set-shuffle").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().right));
  for (const r of boxes) expect(r).toBeLessThanOrEqual(right + 0.5);
  const label = await page.locator(".set-row").first().locator(".set-label").boundingBox();
  expect(label.width).toBeGreaterThan(100);
});

// Same squeeze in People: the 44px colour swatches took a side column and
// left each person's sample messages a sliver of a few characters.
test("at 768px (touch) a People card gives its messages the card's width", async ({ page }) => {
  await bootViewer(page, DATA, { ls: { "gca.lastView": "people" } });
  await page.setViewportSize({ width: 768, height: 1024 });
  const card = await page.locator("#view-people .person").first().boundingBox();
  const main = await page.locator("#view-people .person .person-main").first().boundingBox();
  expect(main.width).toBeGreaterThan(card.width * 0.6);
  const sw = await page.locator("#view-people .person").first().locator(".swatch").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().right));
  for (const r of sw) expect(r).toBeLessThanOrEqual(card.x + card.width + 0.5);
});

// Under the messages, the swatches use the card's width: they were held to a
// 150px block (3 across, 5 rows of 44px touch targets, one left over).
for (const vp of [{ width: 768, height: 1024, rows: 2 }, { width: 375, height: 812, rows: 3 }]) {
  test(`at ${vp.width}px (touch) the People colour swatches wrap in at most ${vp.rows} rows`, async ({ page }) => {
    await bootViewer(page, DATA, { ls: { "gca.lastView": "people" } });
    await page.setViewportSize({ width: vp.width, height: vp.height });
    const card = await page.locator("#view-people .person").first().boundingBox();
    const sw = await page.locator("#view-people .person").first().locator(".swatch").evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return { top: Math.round(r.top), right: r.right }; }));
    expect(sw.length).toBeGreaterThan(5);
    expect(new Set(sw.map((r) => r.top)).size).toBeLessThanOrEqual(vp.rows);
    for (const r of sw) expect(r.right).toBeLessThanOrEqual(card.x + card.width + 0.5);
  });
}

// Beside the sidebar on a tablet, the Timeline toolbar's "Jump to date" broke
// onto two lines inside its pill. Both buttons stay one line and on screen.
test("at 768px the Timeline toolbar buttons stay on one line", async ({ page }) => {
  await bootViewer(page, DATA, { ls: { "gca.lastView": "timeline" } });
  await page.setViewportSize({ width: 768, height: 1024 });
  const view = await page.locator("#view-timeline").boundingBox();
  for (const id of ["#tl-jumpdate", "#tl-search"]) {
    const lines = await page.locator(id).evaluate((b) => {
      const tops = new Set(), w = document.createTreeWalker(b, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        if (!n.textContent.trim() || n.parentElement.closest(".kbd")) continue;
        const r = document.createRange(); r.selectNodeContents(n);
        for (const x of r.getClientRects()) if (x.width > 1) tops.add(Math.round(x.top));
      }
      return tops.size;
    });
    expect(lines, id).toBe(1);
    const box = await page.locator(id).boundingBox();
    expect(box.x + box.width, id).toBeLessThanOrEqual(view.x + view.width);
  }
});
