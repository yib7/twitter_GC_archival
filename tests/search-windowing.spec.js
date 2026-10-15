const { test, expect } = require("@playwright/test");
const { archiveScript } = require("./fixtures/synthetic-archive.js");

// the Search results list is windowed. Results still stream in
// 60-row pages as you scroll (infinite scroll), but pages far outside the
// viewport are swapped for a fixed-height spacer and re-rendered when they come
// back, so the DOM stays bounded however far you scroll a huge result set.

async function boot(page) {
  await page.addInitScript(() => {
    localStorage.setItem("gca.onboarded", "1");
    localStorage.removeItem("gca.lastView");
  });
  await page.route("**/data.sample.js", (r) => r.fulfill({ contentType: "text/javascript", body: archiveScript({ main: 3000, side: 0 }) }));
  await page.route("**/data.js", (r) => r.fulfill({ contentType: "text/javascript", body: "" }));
  await page.route("**/local.js", (r) => r.fulfill({ contentType: "text/javascript", body: "" }));
  await page.goto("/");
  await expect(page.locator(".msg").first()).toBeVisible();
  expect(await page.evaluate(() => window.CHAT_DATA.__sample === true)).toBe(true);
  await page.locator('.nav-item[data-view="search"]').click();
  await expect(page.locator("#s-meta")).toContainText("Showing all 3,000");
}

// Scroll the results to the very end, one viewport-ish jump at a time, and
// report the largest number of rendered rows seen along the way.
function scrollToEnd(page) {
  return page.evaluate(async () => {
    const s = document.getElementById("s-scroll"), list = document.getElementById("s-list");
    const frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 20)));
    let maxRows = 0, steps = 0;
    const lastIdx = () => {
      const rows = list.querySelectorAll(".msg");
      return rows.length ? +rows[rows.length - 1].dataset.idx : -1;
    };
    while (steps++ < 600) {
      s.scrollTop += 1500;
      await frame();
      maxRows = Math.max(maxRows, list.querySelectorAll(".msg").length);
      if (lastIdx() === 0 && s.scrollTop + s.clientHeight >= s.scrollHeight - 2) break;
    }
    return { maxRows, lastIdx: lastIdx(), steps };
  });
}

test("scrolling 3,000 results keeps the rendered rows bounded and reaches the end", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e));
  await boot(page);
  const r = await scrollToEnd(page);
  // The oldest message (index 0, newest-first list) is reached: infinite scroll still works.
  expect(r.lastIdx).toBe(0);
  // …without ever holding more than a handful of 60-row pages in the DOM.
  expect(r.maxRows).toBeLessThanOrEqual(480);
  // Scrolling back up re-renders the first page (newest message on top).
  await page.evaluate(() => { document.getElementById("s-scroll").scrollTop = 0; });
  const newest = await page.evaluate(() => String(window.CHAT_DATA.conversations[0].msgs.length - 1));
  await expect(page.locator("#s-list .msg").first()).toHaveAttribute("data-idx", newest);
  await expect(page.locator("#s-list .msg").first()).toBeInViewport();
  expect(errors).toEqual([]);
});

test("a hidden Search view does not unrender its pages", async ({ page }) => {
  await boot(page);
  await page.evaluate(() => { document.getElementById("s-scroll").scrollTop = 4000; });
  await expect.poll(() => page.locator("#s-list .msg").count()).toBeGreaterThan(60);
  const before = await page.evaluate(() => document.getElementById("s-scroll").scrollTop);
  await page.locator('.nav-item[data-view="timeline"]').click();
  await page.locator('.nav-item[data-view="search"]').click();
  // Same reading position, and the rows under it are still rendered.
  expect(await page.evaluate(() => document.getElementById("s-scroll").scrollTop)).toBe(before);
  await expect.poll(() => page.evaluate(() => {
    const s = document.getElementById("s-scroll"), top = s.getBoundingClientRect().top;
    return [...document.querySelectorAll("#s-list .msg")].some((m) => {
      const b = m.getBoundingClientRect();
      return b.bottom > top && b.top < top + s.clientHeight;
    });
  })).toBe(true);
});
