const { test, expect } = require("@playwright/test");
const { bootViewer, conv, collectErrors, afterSearchRun } = require("./_viewer-fixture.js");

// Lightbox + modal stacking.
//  - .lightbox (z 100) painted UNDER .ctx-modal (z 230), so a photo
//    clicked in Context peek "did nothing" while the hidden lightbox stole
//    focus and the arrow keys. In Search view the list came from the search
//    results, so a peeked photo that isn't a result opened nothing or a
//    different photo.
//  - one Escape closed two layers (closeAllModals removed the ctx
//    modal first, then lbKeyHandler removed the lightbox).
//  - "file" media (pdf…) was part of the lightbox list and
//    rendered as a broken <img>; the gallery file cell opened the lightbox.
//  - the list was always all media oldest-first, so arrows ran opposite
//    to the newest-first Gallery and ignored the Hall of Fame ranking.
const B = Date.parse("2024-03-10T08:00:00Z");
const M = (k, extra) => Object.assign({ i: "m" + k, s: k % 2 ? "u1" : "u2", t: B + k * 60000, x: "text " + k }, extra || {});
const img = (n) => ({ m: "sample_media/photo-" + n + ".svg", k: "img" });
const R = (n) => Array.from({ length: n }, (_, j) => ({ s: j % 2 ? "u1" : "u2", k: "like" }));
const LIST = [
  M(0, { x: "hello there" }),
  M(1, Object.assign({ x: "first pic" }, img(1), { r: R(2) })),
  M(2, { x: "a report", m: "sample_media/report.pdf", k: "file" }),
  M(3, Object.assign({ x: "second pic" }, img(2), { r: R(1) })),
  M(4, Object.assign({ x: "third pic" }, img(3), { r: R(3) })),
  M(5, { x: "bye now" }),
];
const DATA = { conversations: [conv("A", "Alpha", LIST)] };
const lbSrc = (page) => page.locator(".lightbox img").getAttribute("src");

async function peek(page, scope, n) {
  const row = page.locator(scope + " .msg").nth(n);
  await row.hover();
  await row.getByRole("button", { name: "Context" }).click();
  await expect(page.locator(".ctx-modal")).toBeVisible();
}

test("a photo opened from Context peek shows ON TOP of the peek modal", async ({ page }) => {
  await bootViewer(page, DATA, { ls: { "gca.lastView": "timeline" } });
  await peek(page, "#view-timeline", 0);
  await page.locator('.ctx-modal .media img[src$="photo-1.svg"]').click();
  await expect(page.locator(".lightbox")).toBeVisible();
  const top = await page.evaluate(() => {
    const r = document.querySelector(".lightbox img").getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!(hit && hit.closest(".lightbox"));
  });
  expect(top).toBe(true);
  expect(await page.evaluate(() => document.querySelector(".lightbox").contains(document.activeElement))).toBe(true);
});

test("Escape closes only the top layer, and focus goes back into the layer below", async ({ page }) => {
  await bootViewer(page, DATA, { ls: { "gca.lastView": "timeline" } });
  await peek(page, "#view-timeline", 0);
  await page.locator('.ctx-modal .media img[src$="photo-1.svg"]').click();
  await expect(page.locator(".lightbox")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".lightbox")).toHaveCount(0);
  await expect(page.locator(".ctx-modal")).toBeVisible();
  expect(await page.evaluate(() => document.querySelector(".ctx-modal").contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(page.locator(".ctx-modal")).toHaveCount(0);
});

test("arrow keys do not drive a lightbox that is not the top layer", async ({ page }) => {
  await bootViewer(page, DATA, { ls: { "gca.lastView": "gallery" } });
  await page.locator("#view-gallery .gcell img").first().click();
  await expect(page.locator(".lightbox")).toBeVisible();
  const before = await lbSrc(page);
  await page.keyboard.press("?");            // keyboard help opens above the lightbox
  await expect(page.locator(".kb-modal")).toBeVisible();
  await page.keyboard.press("ArrowRight");
  expect(await lbSrc(page)).toBe(before);
  await page.keyboard.press("Escape");        // pops the help only
  await expect(page.locator(".kb-modal")).toHaveCount(0);
  await expect(page.locator(".lightbox")).toBeVisible();
});

test("in Search, a peeked photo that is not a search result opens THAT photo", async ({ page }) => {
  await bootViewer(page, DATA);
  // results: only "second pic" (photo-2) -> peek it, click photo-1 (a neighbour, not a result)
  await afterSearchRun(page, () => page.locator('#f-matchtoggle button[data-mode="exact"]').click());
  await afterSearchRun(page, () => page.locator("#s-input").fill("second pic"));
  await expect(page.locator("#s-list .msg")).toHaveCount(1);
  await peek(page, "#s-list", 0);
  await page.locator('.ctx-modal .media img[src$="photo-1.svg"]').click();
  await expect(page.locator(".lightbox")).toBeVisible();
  expect(await lbSrc(page)).toBe("sample_media/photo-1.svg");
  // and with NO media among the results at all
  await page.keyboard.press("Escape"); await page.keyboard.press("Escape");
  await afterSearchRun(page, () => page.locator("#s-input").fill("hello there"));
  await peek(page, "#s-list", 0);
  await page.locator('.ctx-modal .media img[src$="photo-1.svg"]').click();
  await expect(page.locator(".lightbox")).toBeVisible();
  expect(await lbSrc(page)).toBe("sample_media/photo-1.svg");
});

test("file media is never a lightbox slide; its gallery cell does not open the lightbox", async ({ page }) => {
  const errors = collectErrors(page);
  await bootViewer(page, DATA, { ls: { "gca.lastView": "gallery" } });
  const fileCell = page.locator("#view-gallery .gcell", { has: page.locator("a.urlchip") });
  await expect(fileCell).toHaveCount(1);
  await fileCell.evaluate((c) => c.dispatchEvent(new MouseEvent("click", { bubbles: true })));   // the cell, not the link
  await expect(page.locator(".lightbox")).toHaveCount(0);
  // walk every slide from the newest photo: never lands on the pdf
  await page.locator('#view-gallery .gcell img[src$="photo-3.svg"]').click();
  const seen = [await lbSrc(page)];
  for (let k = 0; k < 4; k++) { await page.keyboard.press("ArrowRight"); seen.push(await lbSrc(page)); }
  expect(seen.filter((s) => /\.pdf$/.test(s || ""))).toEqual([]);
  expect(await page.locator(".lightbox img").count()).toBe(1);
  expect(errors).toEqual([]);
});

test("Gallery arrows follow the newest-first grid", async ({ page }) => {
  await bootViewer(page, DATA, { ls: { "gca.lastView": "gallery" } });
  const first = page.locator("#view-gallery .gcell img").first();
  await expect(first).toHaveAttribute("src", "sample_media/photo-3.svg");
  await first.click();
  await expect(page.locator(".lightbox .lb-prev")).toHaveCount(0);
  await expect(page.locator(".lightbox .lb-next")).toHaveCount(1);
  await page.keyboard.press("ArrowRight");
  expect(await lbSrc(page)).toBe("sample_media/photo-2.svg");
  await page.keyboard.press("ArrowRight");
  expect(await lbSrc(page)).toBe("sample_media/photo-1.svg");
  await expect(page.locator(".lightbox .lb-next")).toHaveCount(0);
});

test("Hall of Fame arrows walk the ranked media set", async ({ page }) => {
  await bootViewer(page, DATA, { ls: { "gca.lastView": "hof" } });
  const cells = page.locator("#hof-media .gcell img");
  await expect(cells).toHaveCount(3);
  await cells.first().click();
  expect(await lbSrc(page)).toBe("sample_media/photo-3.svg");   // 3 reactions
  await page.keyboard.press("ArrowRight");
  expect(await lbSrc(page)).toBe("sample_media/photo-1.svg");   // 2 reactions
  await page.keyboard.press("ArrowRight");
  expect(await lbSrc(page)).toBe("sample_media/photo-2.svg");   // 1 reaction
});
