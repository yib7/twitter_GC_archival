const { test, expect } = require("@playwright/test");
const { bootViewer, msgs, conv, collectErrors, settledTimeline, frames } = require("./_viewer-fixture.js");

// the Timeline opens at the NEWEST message (it used to open at the
// oldest — an earlier fix made that first open quiet; this supersedes where it
// lands, keeping the no-flash-of-message-0 guarantee), remembers the reading
// position per conversation (localStorage gca.tlpos, guarded), and offers a
// "Jump to latest" button plus Home / End.
const A = msgs("a", 600, { s: ["u1", "u2", "u3"], step: 3600000, t0: Date.parse("2023-01-01T00:30:00Z") });
const B = msgs("b", 300, { s: ["u1", "u2"], step: 3600000, t0: Date.parse("2023-06-01T00:30:00Z") });
const DATA = { conversations: [conv("A", "Alpha", A), conv("B", "Bravo", B)] };
const UTC = JSON.stringify({ timezone: "UTC", tzExplicit: true });

const atBottom = (page) => page.locator("#tl-scroll").evaluate((s) => s.scrollHeight - s.scrollTop - s.clientHeight < 4);
const inView = (page, idx) => expect(page.locator('#tl-list .msg[data-idx="' + idx + '"]')).toBeInViewport();
const pickConv = (page, id) => page.locator("#conv-select").selectOption(id);
async function jumpDate(page, text) {
  await page.keyboard.press("Control+K");
  await page.locator(".cmdk-input").fill(text);
  await page.keyboard.press("Enter");
  return settledTimeline(page);
}

test("opening the Timeline lands on the newest message, quietly, never painting message 0 first", async ({ page }) => {
  await bootViewer(page, DATA, { ls: { "gca.settings": UTC } });
  // Sample every frame from the click on: message 0 must never be on screen
  // and nothing may flash.
  await page.evaluate(() => {
    window.__seen0 = false; window.__flashed = [];
    new MutationObserver((ms) => ms.forEach((m) => {
      if (m.target.classList && m.target.classList.contains("flash")) window.__flashed.push(m.target.dataset.idx);
    })).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["class"] });
    const tick = () => {
      const s = document.getElementById("tl-scroll"), m0 = document.querySelector('#tl-list .msg[data-idx="0"]');
      if (s && m0 && s.offsetHeight) {
        const r = m0.getBoundingClientRect(), sr = s.getBoundingClientRect();
        if (r.bottom > sr.top && r.top < sr.bottom) window.__seen0 = true;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.locator('.nav-item[data-view="timeline"]').click();
  await inView(page, 599);
  await frames(page, 4);
  expect(await atBottom(page)).toBe(true);
  expect(await page.evaluate(() => window.__seen0)).toBe(false);
  expect(await page.evaluate(() => window.__flashed)).toEqual([]);
});

test("booting straight into the Timeline also opens at the newest message", async ({ page }) => {
  await bootViewer(page, DATA, { ls: { "gca.lastView": "timeline", "gca.settings": UTC } });
  await inView(page, 599);
  expect(await atBottom(page)).toBe(true);
});

test("the reading position is remembered per conversation, across switches and reloads", async ({ page }) => {
  const errors = collectErrors(page);
  await bootViewer(page, DATA, { ls: { "gca.lastView": "timeline", "gca.settings": UTC } });
  await inView(page, 599);
  const posA = await jumpDate(page, "2023-01-10");
  expect(posA.first).toBeGreaterThan(150);
  expect(posA.first).toBeLessThan(260);

  // B has no saved position: newest.
  await pickConv(page, "B");
  await inView(page, 299);
  const posB = await jumpDate(page, "2023-06-05");

  // Back to A: where A was being read, not the top and not the newest.
  await pickConv(page, "A");
  expect((await settledTimeline(page)).first).toBe(posA.first);
  await expect(page.locator("#tl-list .msg.flash")).toHaveCount(0);   // a restore is quiet

  // And after a reload (A is the active conversation).
  await page.reload();
  expect((await settledTimeline(page)).first).toBe(posA.first);
  await pickConv(page, "B");
  expect((await settledTimeline(page)).first).toBe(posB.first);

  // Only ids and offsets are stored — never message text.
  const raw = await page.evaluate(() => localStorage.getItem("gca.tlpos"));
  expect(raw).not.toMatch(/text/);
  expect(Object.keys(JSON.parse(raw)).sort()).toEqual(["A", "B"]);
  expect(errors).toEqual([]);
});

test("a position left at the newest message reopens at the newest message", async ({ page }) => {
  await bootViewer(page, DATA, { ls: { "gca.lastView": "timeline", "gca.settings": UTC } });
  await inView(page, 599);
  await pickConv(page, "B");
  await inView(page, 299);
  await pickConv(page, "A");
  await inView(page, 599);
  expect(await atBottom(page)).toBe(true);
});

test("Jump to latest + Home / End", async ({ page }) => {
  await bootViewer(page, DATA, { ls: { "gca.lastView": "timeline", "gca.settings": UTC } });
  const latest = page.locator("#tl-latest");
  await inView(page, 599);
  await expect(latest).toBeHidden();        // already at the newest

  await page.locator('#tl-list .msg[data-idx="599"]').focus();
  await page.keyboard.press("Home");
  await inView(page, 0);
  await expect(latest).toBeVisible();
  await expect(latest).toHaveAccessibleName("Jump to latest message");

  await latest.click();
  await inView(page, 599);
  expect(await atBottom(page)).toBe(true);
  await expect(latest).toBeHidden();
  await expect(page.locator('#tl-list .msg[data-idx="599"]')).toBeFocused();   // focus doesn't drop to <body>

  await page.keyboard.press("Home");
  await inView(page, 0);
  await page.keyboard.press("End");
  await inView(page, 599);

  // Home / End inside a text field stay the field's own.
  await page.keyboard.press("Control+K");
  await page.locator(".cmdk-input").fill("abc");
  await page.keyboard.press("Home");
  await page.keyboard.press("Escape");
  await inView(page, 599);
});

test("with storage blocked the Timeline still opens at the newest message", async ({ page }) => {
  const errors = collectErrors(page);
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", { configurable: true, get() { throw new DOMException("The operation is insecure.", "SecurityError"); } });
  });
  await bootViewer(page, DATA);
  await page.locator("#onboard-dismiss").click();   // "onboarded" can't be remembered without storage
  await page.locator('.nav-item[data-view="timeline"]').click();
  await inView(page, 599);
  await jumpDate(page, "2023-01-10");
  await pickConv(page, "B");
  await inView(page, 299);
  expect(errors).toEqual([]);
});

test("Reset customization keeps reading positions (like bookmarks) and says so", async ({ page }) => {
  await bootViewer(page, DATA, { ls: { "gca.lastView": "timeline", "gca.settings": UTC } });
  const pos = await jumpDate(page, "2023-01-10");
  let msg = null;
  page.once("dialog", (d) => { msg = d.message(); d.accept(); });
  await page.locator('.nav-item[data-view="settings"]').click();
  await page.locator("#set-reset").click();
  await expect(page.locator(".toast")).toContainText(/reset/i);
  expect(msg).toMatch(/Keeps:[^\n]*reading positions/);
  // across a reload, so it's the STORED position (not this session's memory)
  await page.reload();
  await expect(page.locator("#app")).toBeVisible();
  await page.locator('.nav-item[data-view="timeline"]').click();
  expect((await settledTimeline(page)).first).toBe(pos.first);
});

// The On-This-Day toast sits in the same bottom-right corner as
// the "Latest" pill. While it's up the pill is lifted above it; once it's
// dismissed the pill drops back.
const OTD = msgs("o", 400, { s: ["u1", "u2"], step: 3600000 * 3, t0: Date.parse("2024-04-20T00:30:00Z") });
const OTD_DATA = { conversations: [conv("O", "Otd", OTD)] };   // 2024-04-20 .. 2024-05-10
const overlap = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
for (const vp of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
  test.describe("Latest vs On This Day at " + vp.width + "px", () => {
    test.use({ viewport: vp, hasTouch: vp.width < 500, isMobile: vp.width < 500 });
    test("the toast never covers the Latest pill", async ({ page }) => {
      await page.clock.setFixedTime(new Date("2025-05-01T12:00:00Z"));
      await page.emulateMedia({ reducedMotion: "reduce" });
      await bootViewer(page, OTD_DATA, { ls: { "gca.lastView": "timeline", "gca.settings": UTC } });
      const toastEl = page.locator(".otd-toast");
      await expect(toastEl).toBeVisible();
      await page.locator("#tl-scroll").evaluate((s) => { s.scrollTop -= 3000; });
      const pill = page.locator("#tl-latest");
      await expect(pill).toBeVisible();
      const p = await pill.boundingBox(), t = await toastEl.boundingBox();
      expect(overlap(p, t), JSON.stringify({ p, t })).toBe(false);
      expect(p.y + p.height).toBeLessThanOrEqual(t.y);   // above it, not beside it
      // the pill is still clickable (not under the toast)
      await pill.click();
      await expect.poll(() => atBottom(page)).toBe(true);
      // dismissed: the pill drops back to its corner
      await page.locator("#tl-scroll").evaluate((s) => { s.scrollTop -= 3000; });
      await toastEl.getByRole("button", { name: "Dismiss" }).click();
      await expect(toastEl).toHaveCount(0);
      await expect.poll(async () => (await pill.boundingBox()).y).toBeGreaterThan(p.y + 40);
    });
  });
}
