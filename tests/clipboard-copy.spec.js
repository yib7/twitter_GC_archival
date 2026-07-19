const { test, expect } = require("@playwright/test");

// P2-3: the timeline "Copy" action fired navigator.clipboard.writeText(...)
// without awaiting or handling its promise, so it always toasted "Copied
// text" even when the write rejected (no permission, unfocused document, or
// navigator.clipboard missing entirely) — and left an unhandled rejection.
// The fix must toast "Copied text" only on a resolved write and "Copy
// failed" on a rejected one or a missing navigator.clipboard, with no
// unhandled rejection reaching the console either way.

const DATA = {
  __sample: true,
  conversations: [
    { id: "A", type: "group", title: "Alpha", participants: ["u1"], count: 1,
      msgs: [
        { i: "a1", s: "u1", t: Date.parse("2024-01-01T10:00:00Z"), x: "copy me please" },
      ], events: [] },
  ],
};

async function boot(page, { clipboardOutcome } = {}) {
  await page.addInitScript((outcome) => {
    localStorage.setItem("gca.onboarded", "1");
    localStorage.removeItem("gca.lastView");

    if (outcome === "resolve" || outcome === "reject") {
      const fn = outcome === "resolve"
        ? () => Promise.resolve()
        : () => Promise.reject(new Error("denied"));
      if (navigator.clipboard) {
        navigator.clipboard.writeText = fn;
      } else {
        Object.defineProperty(navigator, "clipboard", { value: { writeText: fn }, configurable: true });
      }
    } else if (outcome === "absent") {
      Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    }
  }, clipboardOutcome);
  await page.route("**/data.sample.js", (route) =>
    route.fulfill({ contentType: "text/javascript", body: "window.CHAT_DATA = " + JSON.stringify(DATA) + ";" }));
  await page.route("**/data.js", (route) => route.fulfill({ contentType: "text/javascript", body: "" }));
  await page.route("**/local.js", (route) => route.fulfill({ contentType: "text/javascript", body: "" }));
  await page.goto("/");
  await expect(page.locator(".msg").first()).toBeVisible();
}

async function clickCopy(page) {
  await page.locator('.nav-item[data-view="timeline"]').click();
  const msg = page.locator("#view-timeline .msg", { hasText: "copy me please" }).first();
  await msg.hover();
  await msg.getByRole("button", { name: "Copy" }).click();
}

test("Copy toasts 'Copied text' when the clipboard write resolves", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e));

  await boot(page, { clipboardOutcome: "resolve" });
  await clickCopy(page);

  await expect(page.locator(".toast")).toHaveText("Copied text");
  expect(errors).toEqual([]);
});

test("Copy toasts 'Copy failed' (not 'Copied text') when the clipboard write rejects", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e));

  await boot(page, { clipboardOutcome: "reject" });
  await clickCopy(page);

  await expect(page.locator(".toast")).toHaveText("Copy failed");
  // The rejection must be handled, not surfaced as an uncaught/unhandled error.
  expect(errors).toEqual([]);
});

test("Copy toasts 'Copy failed' when navigator.clipboard is absent", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e));

  await boot(page, { clipboardOutcome: "absent" });
  await clickCopy(page);

  await expect(page.locator(".toast")).toHaveText("Copy failed");
  expect(errors).toEqual([]);
});
