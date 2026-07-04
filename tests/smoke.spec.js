const { test, expect } = require("@playwright/test");

function pickSearchTerm(text) {
  return (text || "")
    .toLowerCase()
    .match(/[a-z0-9']{4,}/g)
    ?.find((word) => !["https", "http", "this", "that"].includes(word)) || "message";
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("gca.onboarded", "1");
    localStorage.removeItem("gca.lastView");
  });
});

test("app boots and shows archive data", async ({ page }) => {
  await page.goto("/");

  await expect(page.locator("#app")).toBeVisible();
  await expect(page.locator("#s-input")).toBeVisible();
  await expect(page.locator("#s-meta")).toContainText(/Showing all|messages found/);
  await expect(page.locator(".msg").first()).toBeVisible();
});

test("search filters visible messages", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".bubble").first()).toBeVisible();

  const firstBubble = await page.locator(".bubble").first().innerText();
  const term = pickSearchTerm(firstBubble);

  await page.locator("#s-input").fill(term);
  await expect(page.locator("#s-meta")).toContainText(/message(s)? found/);
  await expect(page.locator(".bubble").first()).toContainText(new RegExp(term, "i"));
});

test("timeline renders and jumps by date", async ({ page }) => {
  await page.goto("/");

  await page.locator('[data-view="timeline"]').click();
  await expect(page.locator("#tl-scroll")).toBeVisible();
  await expect(page.locator("#tl-list .msg").first()).toBeVisible();

  // The old floating scrubber rail overlapped the scrollbar and is gone.
  await expect(page.locator("#tl-scrubber")).toHaveCount(0);

  // Jump-by-date now lives in the Ctrl/Cmd-K command palette.
  await page.keyboard.press("Control+K");
  await page.locator(".cmdk-input").fill("2020-06-01");
  await page.getByText(/Jump to 2020-06-01/).click();
  await expect(page.locator("#tl-list .msg").first()).toBeVisible();
});

test("setup page renders source step", async ({ page }) => {
  await page.goto("/setup.html");

  await expect(page.locator("#btn-build")).toBeVisible();
  await expect(page.locator("#src-group")).toBeVisible();
  await expect(page.locator("#src-headers")).toBeVisible();
  await expect(page.locator("#src-media")).toBeVisible();
});

test("server rejects bad paths and malformed api bodies", async ({ request }) => {
  // The decoded path is "/../README.md" — isServablePath's "no .. segments"
  // rule now rejects it (404) before the traversal guard beneath it would
  // otherwise get a chance to (403); either way it must never be served.
  const traversal = await request.get("/%2e%2e%2fREADME.md");
  expect(traversal.status()).toBe(404);

  const badJson = await request.post("/api/source", {
    data: "not json",
    headers: { "content-type": "application/json" },
  });
  expect(badJson.status()).toBe(400);

  const missingSource = await request.post("/api/source", { data: {} });
  expect(missingSource.status()).toBe(400);
});

test("server enforces the static-path allowlist", async ({ request }) => {
  // Real personal data / repo internals must 404 even though they live under
  // ROOT alongside the app — the allowlist runs before any fs access.
  expect((await request.get("/personal_data/config.json")).status()).toBe(404);
  expect((await request.get("/scripts/server.js")).status()).toBe(404);
  expect((await request.get("/.git/HEAD")).status()).toBe(404);
  // App assets stay reachable.
  expect((await request.get("/src/app.js")).status()).toBe(200);
  expect((await request.get("/data.sample.js")).status()).toBe(200);
});
