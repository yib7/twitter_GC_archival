const { test, expect } = require("@playwright/test");

// Deterministic two-message conversation (one with media) injected via the data
// scripts, so accessibility assertions don't depend on any real personal_data/.
const DATA = {
  __sample: true,
  conversations: [{
    id: "G1", type: "group", title: "A11y Group", participants: ["u1", "u2"], count: 2,
    msgs: [
      { i: "m1", s: "u1", t: Date.parse("2020-05-01T10:00:00Z"), x: "hello there" },
      { i: "m2", s: "u2", t: Date.parse("2020-05-01T11:00:00Z"), x: "a photo", m: "sample_media/photo-1.svg", k: "img" },
    ],
    events: [],
  }],
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("gca.onboarded", "1");
    localStorage.removeItem("gca.lastView");
  });
  await page.route("**/data.sample.js", (route) =>
    route.fulfill({ contentType: "text/javascript", body: "window.CHAT_DATA = " + JSON.stringify(DATA) + ";" }));
  await page.route("**/data.js", (route) => route.fulfill({ contentType: "text/javascript", body: "" }));
  await page.route("**/local.js", (route) => route.fulfill({ contentType: "text/javascript", body: "" }));
});

test("landmarks exist and the active view is exposed via aria-current", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('nav#nav[aria-label="Views"]')).toBeVisible();
  await expect(page.locator("aside.sidebar[aria-label]")).toBeVisible();

  await expect(page.locator('.nav-item[data-view="search"]')).toHaveAttribute("aria-current", "page");
  await page.locator('.nav-item[data-view="timeline"]').click();
  await expect(page.locator('.nav-item[data-view="timeline"]')).toHaveAttribute("aria-current", "page");
  await expect(page.locator('.nav-item[data-view="search"]')).not.toHaveAttribute("aria-current", "page");
});

test("message images carry descriptive alt text", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".bubble").first()).toBeVisible();
  await expect(page.locator(".media img").first()).toHaveAttribute("alt", /Photo from/);
});

test("the lightbox is a focus-managed dialog", async ({ page }) => {
  await page.goto("/");
  await page.locator(".media img").first().click();
  const lb = page.locator(".lightbox");
  await expect(lb).toHaveAttribute("role", "dialog");
  await expect(lb).toHaveAttribute("aria-modal", "true");
  // focus has moved into the dialog
  expect(await page.evaluate(() => document.querySelector(".lightbox").contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(lb).toHaveCount(0);
});

test("the lightbox traps Tab focus within the dialog", async ({ page }) => {
  await page.goto("/");
  await page.locator(".media img").first().click();
  const lb = page.locator(".lightbox");
  await expect(lb).toHaveAttribute("aria-modal", "true");

  // Every focusable in the dialog, in DOM order. trapTab() should keep focus
  // cycling among these and never let it escape to the page behind the modal.
  const focusables = await page.evaluate(() => {
    const box = document.querySelector(".lightbox");
    const sel = 'a[href], button:not([disabled]), input, [tabindex]:not([tabindex="-1"])';
    return [...box.querySelectorAll(sel)].map((n) => n.className);
  });
  expect(focusables.length).toBeGreaterThan(1);

  const inDialog = () => page.evaluate(() => document.querySelector(".lightbox").contains(document.activeElement));

  // Tabbing forward through and past the last element wraps back inside.
  for (let i = 0; i < focusables.length + 2; i++) {
    await page.keyboard.press("Tab");
    expect(await inDialog()).toBe(true);
  }
  // Shift+Tab from the first element wraps to the last, still inside.
  for (let i = 0; i < focusables.length + 2; i++) {
    await page.keyboard.press("Shift+Tab");
    expect(await inDialog()).toBe(true);
  }

  await page.keyboard.press("Escape");
  await expect(lb).toHaveCount(0);
});

test("the command palette traps focus and restores it on close", async ({ page }) => {
  await page.goto("/");
  await page.locator('.nav-item[data-view="timeline"]').focus();
  await page.keyboard.press("Control+K");

  const cmdk = page.locator(".cmdk");
  await expect(cmdk).toHaveAttribute("role", "dialog");
  await expect(page.locator(".cmdk-input")).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(cmdk).toHaveCount(0);
  // focus returns to whatever opened it
  await expect(page.locator('.nav-item[data-view="timeline"]')).toBeFocused();
});

test("honors prefers-reduced-motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.locator(".bubble").first()).toBeVisible();
  const dur = await page.evaluate(() => getComputedStyle(document.querySelector(".nav-item")).transitionDuration);
  expect(parseFloat(dur)).toBeLessThan(0.01);
});
