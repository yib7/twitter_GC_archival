const { test, expect } = require("@playwright/test");
const { checkAndBuild } = require("./_setup-helpers.js");

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

// One participant with a shared image, so the People step renders a media thumb.
const PARTS = [
  { id: "1111", count: 40, samples: ["hello there friend"], media: [{ m: PNG, k: "img" }] },
];

test.beforeEach(async ({ page }) => {
  await page.route("**/api/status", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ built: false, groups: [], ignoredGroups: [] }) }));
  await page.route("**/api/source", (route) =>
    route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ totalMsgs: 40, groups: [{ id: "G1", title: "Grp", count: 40 }], mediaCopied: 1 }) }));
  await page.route("**/api/parts*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ parts: PARTS }) }));
});

async function gotoPeopleStep(page) {
  await page.goto("/setup.html");
  await page.locator("#src-group").fill("group.js");
  await page.locator("#src-headers").fill("headers.js");
  await page.locator("#src-media").fill("media");
  await checkAndBuild(page, { mock: true });   // Check export → preview → Build
  await expect(page.locator('[data-pane="2"]')).toBeVisible();
  await page.locator('[data-pane="2"] [data-next]').click();
  await expect(page.locator(".su-person").first()).toBeVisible();
}

test("clicking a media thumbnail opens an enlarged, closable view", async ({ page }) => {
  await gotoPeopleStep(page);

  await page.locator(".su-thumb").first().click();

  const lb = page.locator(".su-lightbox");
  await expect(lb).toBeVisible();
  await expect(lb).toHaveAttribute("role", "dialog");
  await expect(lb.locator("img")).toHaveAttribute("src", /^data:image\/png/);

  await page.keyboard.press("Escape");
  await expect(lb).toHaveCount(0);
});

// The thumbnails were mouse-only images (alt="", not focusable). Each is a
// named button now: Enter opens the enlarged view, Escape returns focus to it.
test("a media thumbnail is a named button that works from the keyboard", async ({ page }) => {
  await gotoPeopleStep(page);
  const btn = page.getByRole("button", { name: /Enlarge shared photo/ }).first();
  await expect(btn).toBeVisible();
  await btn.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".su-lightbox")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".su-lightbox")).toHaveCount(0);
  await expect(btn).toBeFocused();
});
