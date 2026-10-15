const { test, expect } = require("@playwright/test");
const { bootViewer, conv } = require("./_viewer-fixture.js");

// SP5 mobile checkpoint at 390px with a touch (coarse) pointer: UX-1 touch
// actions, UX-5 / UX-34 / UX-36 no horizontal overflow, UX-18 44px targets,
// UX-19 search filters sheet + no autofocus, UX-35 capsule height.
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

const T = Date.parse("2024-03-10T12:00:00Z");
const LIST = [
  { i: "m0", s: "u1", t: T, x: "hello there, see https://example.test/a" },
  { i: "m1", s: "u2", t: T + 60000, x: "a photo", m: "sample_media/photo-1.svg", k: "img", r: [{ s: "u1", k: "funny" }] },
  { i: "m2", s: "u3", t: T + 120000, x: "third message" },
  { i: "m3", s: "u1", t: T + 86400000, x: "next day hello" },
  { i: "m4", s: "u2", t: T + 86400000 + 60000, x: "another photo", m: "sample_media/photo-2.svg", k: "img" },
  { i: "m5", s: "u3", t: T + 86400000 + 120000, x: "the last word" },
];
const DATA = { conversations: [conv("A", "Alpha", LIST)] };
const view = (page) => page.evaluate(() => document.querySelector(".nav-item[aria-current=page]").dataset.view);

test.describe("UX-1: touch users reach message actions through a ⋯ button", () => {
  test("tapping ⋯ on a search result opens its actions without navigating; an action closes them", async ({ page }) => {
    await bootViewer(page, DATA);
    const card = page.locator("#s-list .msg").first();
    const more = card.getByRole("button", { name: "Message actions" });
    await expect(more).toBeVisible();
    await expect(more).toHaveAttribute("aria-expanded", "false");
    await more.tap();
    expect(await view(page)).toBe("search");
    await expect(more).toHaveAttribute("aria-expanded", "true");
    const acts = card.locator(".msg-acts");
    await expect(acts).toBeVisible();
    await acts.getByRole("button", { name: "Bookmark" }).tap();
    await expect(page.locator(".toast")).toContainText("Bookmarked");
    await expect(acts).toBeHidden();
    await expect(more).toHaveAttribute("aria-expanded", "false");
    expect(await view(page)).toBe("search");
  });

  test("in the timeline, ⋯ opens the actions; tapping elsewhere closes them", async ({ page }) => {
    await bootViewer(page, DATA, { ls: { "gca.lastView": "timeline" } });
    const msg = page.locator("#tl-list .msg").nth(1);
    await msg.getByRole("button", { name: "Message actions" }).tap();
    await expect(msg.locator(".msg-acts")).toBeVisible();
    // every action is a 44px touch target
    const sizes = await msg.locator(".msg-acts button").evaluateAll((bs) => bs.map((b) => { const r = b.getBoundingClientRect(); return [r.width, r.height]; }));
    for (const [w, h] of sizes) { expect(w).toBeGreaterThanOrEqual(44); expect(h).toBeGreaterThanOrEqual(44); }
    // the open toolbar stays inside the 390px viewport
    const box = await msg.locator(".msg-acts").boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    await page.locator(".mobile-topbar .nm").tap();
    await expect(msg.locator(".msg-acts")).toBeHidden();
  });
});

test.describe("UX-17: the More sheet is a real dialog", () => {
  test("inert while closed; on open aria-modal with focus inside and trapped; Esc closes back to the More tab", async ({ page }) => {
    await bootViewer(page, DATA);
    const sheet = page.locator("#more-sheet");
    await expect(sheet).toHaveAttribute("aria-hidden", "true");
    expect(await sheet.evaluate((s) => s.inert)).toBe(true);
    // closed: none of its buttons is a Tab stop
    await page.locator("#tab-more").focus();
    for (let k = 0; k < 6; k++) {
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => !!document.activeElement.closest("#more-sheet"))).toBe(false);
    }
    await page.locator("#tab-more").tap();
    await expect(sheet).toHaveClass(/\bon\b/);
    await expect(sheet).toHaveAttribute("aria-modal", "true");
    expect(await sheet.evaluate((s) => s.inert || s.getAttribute("aria-hidden") === "true")).toBe(false);
    await expect(sheet.locator(".sh-item").first()).toBeFocused();
    for (let k = 0; k < 16; k++) {
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => !!document.activeElement.closest("#more-sheet")), "Tab " + k).toBe(true);
    }
    await page.keyboard.press("Escape");
    await expect(sheet).not.toHaveClass(/\bon\b/);
    expect(await sheet.evaluate((s) => s.inert)).toBe(true);
    await expect(page.locator("#tab-more")).toBeFocused();
    // choosing an item navigates and also closes it inert
    await page.locator("#tab-more").tap();
    await sheet.locator('.sh-item[data-tab="people"]').tap();
    expect(await sheet.evaluate((s) => s.inert)).toBe(true);
    expect(await view(page)).toBe("people");
  });
});
