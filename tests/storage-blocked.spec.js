const { test, expect } = require("@playwright/test");
const { bootViewer, msgs, conv, collectErrors } = require("./_viewer-fixture.js");

// init() read gca.lastView with a bare localStorage.getItem — the only
// unguarded storage access in the viewer. When site data is blocked the
// localStorage getter itself throws SecurityError, init() died before
// setView() ran, and the user got an empty main area (no search box, no
// messages).
const DATA = { conversations: [conv("A", "Alpha", msgs("m", 12))] };

test("the viewer still boots into Search when localStorage access throws", async ({ page }) => {
  const errors = collectErrors(page);
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() { throw new DOMException("The operation is insecure.", "SecurityError"); },
    });
  });
  await bootViewer(page, DATA);
  await expect(page.locator("#s-input")).toBeVisible();
  await expect(page.locator("#s-list .msg").first()).toBeVisible();
  expect(errors).toEqual([]);
});
